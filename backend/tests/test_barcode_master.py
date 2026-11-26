"""Barcode master: repeated scans with other values are decided by it, empty values are filled from it."""
from datetime import datetime, timezone

import pytest
from conftest import admin_headers, on_hand, ref_ids, row, user_id
from fastapi.testclient import TestClient

from gi.db import connect, one, rows
from gi.importing.csv_upload import import_csv
from gi.importing.importer import poll, sync_master, upload_master
from gi.importing.master import parse_csv as parse_master
from gi.importing.mock_source import MockIssueSource
from gi.ledger import invariant_violations
from gi.services import settings
from gi.services.counts import CountLine, StartingCountInput, save_starting_count

pytestmark = pytest.mark.usefixtures("fresh_db")
NOW = datetime(2026, 11, 20, 23, 0, tzinfo=timezone.utc)  # 16:00 on 20 Nov in Phoenix
ISSUES = "SUIT_BARCODE,SUIT_TYPE,SUIT_COLOR,SUIT_SIZE,SUIT_LEVEL,STATE,INSERT_TIME\n"
MASTER = "SUIT_BARCODE,SUIT_CATEGORY,SUIT_TYPE,SUIT_COLOR,SUIT_SIZE,REC_USER,RECTIME\n"


def issue(barcode, t, size="L", color="WHITE", level="FAB1"):
    return f"{barcode},GOWN,{color},{size},{level},EMPLOYEE GOWN ISSUE,{t}\n"


def version(barcode, size, rectime, color="WHITE"):
    return f"{barcode},CLEANROOM,GOWN,{color},{size},U1,{rectime}\n"


def start():
    ids = ref_ids()
    save_starting_count(StartingCountInput(locationId=ids["loc"]["P1"], asOf="2026-11-19T00:00:00Z", counts=[
        CountLine(garmentTypeId=ids["type"]["GOWN"], colorId=ids["color"]["White"], sizeId=s, qty=50)
        for s in (ids["size"]["LG"], ids["size"]["MED"])]), user_id())


def scan(barcode):
    with connect() as c:
        return one(c, """SELECT suit_size, suit_color, status, conflict, missing_values FROM issue_import WHERE suit_barcode = ?""", [barcode])


def master_upload(text):
    return upload_master(parse_master((MASTER + text).encode()), "master.csv")


def test_latest_rectime_wins_and_older_uploads_do_not_undo_it():
    r = master_upload(version("G-1", "M", "2026-08-01 10:00:00") + version("G-1", "L", "2026-10-14 15:30:00")
                      + version("G-2", "M", "2026-09-01 09:00:00"))
    assert (r["rows"], r["barcodes"], r["changed"]) == (3, 2, 2)
    master_upload(version("G-1", "M", "2026-08-01 10:00:00"))           # an older export again
    with connect() as c:
        m = {x["suit_barcode"]: x for x in rows(c, "SELECT suit_barcode, suit_size, versions, tied FROM barcode_master")}
    assert (m["G-1"]["suit_size"], m["G-1"]["versions"], m["G-2"]["suit_size"]) == ("L", 2, "M")
    # Two rows with the same latest RECTIME but other values: GI cannot tell, so it does not use the barcode.
    master_upload(version("G-3", "M", "2026-10-01 08:00:00") + version("G-3", "L", "2026-10-01 08:00:00"))
    with connect() as c:
        assert one(c, "SELECT tied FROM barcode_master WHERE suit_barcode = 'G-3'")["tied"] == 1  # type: ignore[index]


def test_repeated_scan_waits_then_the_master_decides():
    start()
    lg = on_hand("GOWN", "White", "LG", "P1")
    # The issue table repeats the scan once per barcode master row: sizes M and L.
    r = import_csv((ISSUES + issue("G-1", "2026-11-20 09:00:00", "M") + issue("G-1", "2026-11-20 09:00:00", "L")).encode())
    assert (r["new"], r["conflicts"], r["waiting"]) == (1, 1, 1)
    assert scan("G-1")["status"] == "held_conflict"
    assert on_hand("GOWN", "White", "LG", "P1") == lg                    # not counted while undecided
    with connect() as c:
        dq = settings.data_quality(c, 7)
    assert dq["waitingTotal"] == 1 and dq["waiting"][0]["problem"] == "conflict"
    assert sorted(v["size"] for v in dq["waiting"][0]["versions"]) == ["L", "M"]

    d = master_upload(version("G-1", "M", "2026-08-01 10:00:00") + version("G-1", "L", "2026-10-14 15:30:00"))
    assert (d["resolved"], d["applied"]) == (1, 1)
    assert scan("G-1") == {"suit_size": "L", "suit_color": "WHITE", "status": "applied", "conflict": "resolved", "missing_values": None}
    assert on_hand("GOWN", "White", "LG", "P1") == lg - 1
    with connect() as c:
        assert [a["suit_size"] for a in rows(c, "SELECT suit_size FROM issue_import_conflict")] == ["M"]
        assert settings.data_quality(c, 7)["decidedByMaster"] == 1
        assert invariant_violations(c) == []


def test_master_known_before_the_upload_decides_at_once():
    start()
    master_upload(version("G-1", "M", "2026-08-01 10:00:00") + version("G-1", "L", "2026-10-14 15:30:00"))
    r = import_csv((ISSUES + issue("G-1", "2026-11-20 09:00:00", "L") + issue("G-1", "2026-11-20 09:00:00", "M")).encode())
    assert (r["new"], r["resolved"], r["waiting"]) == (1, 1, 0)
    assert scan("G-1")["suit_size"] == "L" and scan("G-1")["status"] == "applied"


def test_no_matching_version_keeps_waiting():
    start()
    master_upload(version("G-1", "XL", "2026-10-14 15:30:00"))
    import_csv((ISSUES + issue("G-1", "2026-11-20 09:00:00", "M") + issue("G-1", "2026-11-20 09:00:00", "L")).encode())
    assert scan("G-1")["status"] == "held_conflict"


def test_empty_values_are_recorded_and_filled_from_the_master():
    start()
    r = import_csv((ISSUES + issue("G-1", "2026-11-20 09:00:00", size="", color="")
                    + issue("G-2", "2026-11-20 09:00:00", level="")).encode())
    assert (r["new"], r["missing"], r["waiting"]) == (2, 2, 2)
    assert scan("G-1")["status"] == "held_missing" and scan("G-1")["missing_values"] == "SUIT_COLOR,SUIT_SIZE"
    d = master_upload(version("G-1", "L", "2026-10-14 15:30:00") + version("G-2", "L", "2026-10-14 15:30:00"))
    assert d["applied"] == 1
    assert scan("G-1") == {"suit_size": "L", "suit_color": "WHITE", "status": "applied", "conflict": None,
                           "missing_values": "SUIT_COLOR,SUIT_SIZE"}       # still recorded as empty in Oracle
    # The location is not in the barcode master: that scan keeps waiting.
    assert scan("G-2")["status"] == "held_missing" and scan("G-2")["missing_values"] == "SUIT_LEVEL"
    with connect() as c:
        dq = settings.data_quality(c, 7)
    assert (dq["emptyValueScans"], dq["filledFromMaster"], dq["waitingTotal"]) == (2, 1, 1)


def test_live_master_decides_during_the_import_and_a_later_version_moves_the_issue():
    start()
    master = [{"SUIT_BARCODE": "G-1", "SUIT_CATEGORY": "C", "SUIT_TYPE": "GOWN", "SUIT_COLOR": "WHITE", "SUIT_SIZE": "M",
               "RECTIME": "2026-08-01 10:00:00"}]
    lg, md = on_hand("GOWN", "White", "LG", "P1"), on_hand("GOWN", "White", "MED", "P1")
    src = MockIssueSource([row("2026-11-20 09:00:00", SUIT_BARCODE="G-1", SUIT_SIZE="M")], lambda: NOW, master)
    assert poll(src, NOW)["new"] == 1
    assert scan("G-1")["status"] == "applied" and on_hand("GOWN", "White", "MED", "P1") == md - 1
    # The barcode is corrected (a newer master row, size L) and the issue table now repeats the scan for it.
    master.append({**master[0], "SUIT_SIZE": "L", "RECTIME": "2026-11-20 10:00:00"})
    src.data.append(row("2026-11-20 09:00:00", SUIT_BARCODE="G-1", SUIT_SIZE="L"))
    r = poll(src, NOW)
    assert (r["new"], r["conflicts"], r["resolved"]) == (0, 1, 1)
    assert scan("G-1")["suit_size"] == "L" and scan("G-1")["conflict"] == "resolved"
    assert (on_hand("GOWN", "White", "MED", "P1"), on_hand("GOWN", "White", "LG", "P1")) == (md, lg - 1)
    assert poll(src, NOW)["conflicts"] == 0                                # re-reading reports nothing new
    with connect() as c:
        assert invariant_violations(c) == []


def test_daily_sync_reads_the_whole_table_page_by_page():
    from gi.config import config
    config.ORACLE_MAX_ROWS = 3   # small pages; a barcode's rows are never split across pages
    master = [{"SUIT_BARCODE": f"G-{i}", "SUIT_CATEGORY": "C", "SUIT_TYPE": "GOWN", "SUIT_COLOR": "WHITE", "SUIT_SIZE": s,
               "RECTIME": t} for i in range(1, 5) for s, t in (("M", "2026-08-01 10:00:00"), ("L", "2026-10-01 10:00:00"))]
    r = sync_master(MockIssueSource([], lambda: NOW, master))
    assert (r["rows"], r["barcodes"]) == (8, 4)
    with connect() as c:
        assert {x["suit_size"] for x in rows(c, "SELECT suit_size FROM barcode_master")} == {"L"}


def wait_run(c, run_id):
    import time
    for _ in range(300):
        r = c.get(f"/api/sync/runs/{run_id}", headers={"x-dev-user": "dev-lead"}).json()
        if r["status"] != "running":
            return r
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def test_large_upload_is_saved_in_batches_in_the_background():
    from gi.app import build_app
    c = TestClient(build_app())
    body = (MASTER + "".join(version(f"G-{i:06d}", "L", "2026-10-14 15:30:00") for i in range(9000))).encode()
    r = c.post("/api/barcode-master/upload", content=body, headers=admin_headers())
    assert r.status_code == 202 and r.json()["total"] == 9000
    run = wait_run(c, r.json()["runId"])
    assert (run["status"], run["done"], run["total"], run["changed"]) == ("ok", 9000, 9000, 9000)
    with connect() as conn:
        assert one(conn, "SELECT COUNT(*) AS n FROM barcode_master")["n"] == 9000  # type: ignore[index]


def test_daily_read_takes_only_rows_since_the_newest_rectime():
    from gi.config import config
    config.BARCODE_MASTER_LOOKBACK_HOURS = 24
    row_ = lambda b, size, t: {"SUIT_BARCODE": b, "SUIT_CATEGORY": "C", "SUIT_TYPE": "GOWN", "SUIT_COLOR": "WHITE",  # noqa: E731
                               "SUIT_SIZE": size, "RECTIME": t}
    master = [row_("G-1", "M", "2026-10-01 10:00:00"), row_("G-2", "M", "2026-11-20 10:00:00")]
    src = MockIssueSource([], lambda: NOW, master)
    assert sync_master(src)["rows"] == 2                                   # first read: the whole table
    master += [row_("G-1", "L", "2026-11-22 09:00:00"), row_("G-3", "S", "2026-11-19 12:00:00")]
    r = sync_master(src)                                                    # since 2026-11-19 10:00 (newest minus 24 h)
    assert (r["rows"], r["changed"]) == (3, 2)                              # G-2 again (no change), G-1 newer, G-3 new
    with connect() as conn:
        assert {x["suit_barcode"]: x["suit_size"] for x in rows(conn, "SELECT suit_barcode, suit_size FROM barcode_master")} == \
            {"G-1": "L", "G-2": "M", "G-3": "S"}
    master.append(row_("G-4", "S", "2026-11-01 08:00:00"))                 # an old row added late: only a full read finds it
    assert sync_master(src)["rows"] == 1 and sync_master(src, full=True)["rows"] == 5


def test_upload_endpoint_is_admin_only_and_reports_problems():
    c = TestClient(__import__("gi.app", fromlist=["build_app"]).build_app())
    body = (MASTER + version("G-1", "L", "2026-10-14 15:30:00")).encode()
    assert c.post("/api/barcode-master/upload", content=body, headers={"x-dev-user": "dev-lead"}).status_code == 403
    ok = c.post("/api/barcode-master/upload", content=body, headers=admin_headers())
    assert ok.status_code == 202 and ok.json()["total"] == 1
    assert wait_run(c, ok.json()["runId"])["status"] == "ok"
    bad = c.post("/api/barcode-master/upload", content=b"SUIT_BARCODE,SUIT_SIZE\nG-1,L\n", headers=admin_headers())
    assert bad.status_code == 400 and "RECTIME" in bad.json()["error"]
    s = c.get("/api/barcode-master", headers={"x-dev-user": "dev-lead"}).json()
    assert s["barcodes"] == 1 and s["last"]["kind"] == "master_upload"


def test_rows_without_rectime_count_as_the_oldest():
    # A dated row wins over an undated one, whatever the order in the file.
    r = master_upload(version("G-1", "M", "") + version("G-1", "L", "2026-10-14 15:30:00") + version("G-2", "M", ""))
    assert (r["barcodes"], r["tied"]) == (2, 0)
    with connect() as c:
        m = {x["suit_barcode"]: x for x in rows(c, "SELECT suit_barcode, suit_size, rectime FROM barcode_master")}
    assert (m["G-1"]["suit_size"], m["G-2"]["suit_size"], m["G-2"]["rectime"]) == ("L", "M", None)
    # An undated row never replaces a dated one; a later dated row replaces an undated one.
    master_upload(version("G-1", "XL", "") + version("G-2", "L", "2026-11-01 08:00:00"))
    with connect() as c:
        m = {x["suit_barcode"]: x["suit_size"] for x in rows(c, "SELECT suit_barcode, suit_size FROM barcode_master")}
    assert m == {"G-1": "L", "G-2": "L"}
    # Two undated rows with other values: GI cannot tell which is current.
    master_upload(version("G-3", "M", "") + version("G-3", "L", ""))
    with connect() as c:
        assert one(c, "SELECT tied FROM barcode_master WHERE suit_barcode = 'G-3'")["tied"] == 1  # type: ignore[index]
    # The data quality page shows a waiting scan whose master row has no RECTIME.
    import_csv((ISSUES + issue("G-2", "2026-11-20 09:00:00", "S") + issue("G-2", "2026-11-20 09:00:00", "XL")).encode())
    master_upload(version("G-4", "M", ""))
    with connect() as c:
        assert settings.waiting_scans(c)[0]["master"]["size"] == "L"


def test_same_rows_count_once_and_different_ones_are_listed():
    # Identical rows at the latest RECTIME (also across split files that overlap) are one version.
    same = version("G-1", "L", "2026-10-14 15:30:00") + version("G-1", "L", "2026-10-14 15:30:00")
    master_upload(same)
    master_upload(same)
    # Different rows at the latest RECTIME: every version is kept and listed; one in each of two files counts too.
    master_upload(version("G-2", "M", "2026-10-14 15:30:00") + version("G-2", "L", "2026-10-14 15:30:00"))
    master_upload(version("G-3", "M", "2026-10-14 15:30:00"))
    master_upload(version("G-3", "XL", "2026-10-14 15:30:00") + version("G-3", "M", "2026-10-14 15:30:00"))
    with connect() as c:
        tied = {r["suit_barcode"]: r["tied"] for r in rows(c, "SELECT suit_barcode, tied FROM barcode_master")}
        dq = settings.data_quality(c, 7)
    assert tied == {"G-1": 0, "G-2": 1, "G-3": 1}
    assert dq["masterTiesTotal"] == 2
    got = {t["barcode"]: sorted(v["size"] for v in t["versions"]) for t in dq["masterTies"]}
    assert got == {"G-2": ["L", "M"], "G-3": ["M", "XL"]}
    # A newer row settles it.
    master_upload(version("G-2", "L", "2026-11-01 08:00:00"))
    with connect() as c:
        assert settings.data_quality(c, 7)["masterTiesTotal"] == 1
    from gi.app import build_app
    csv_ = TestClient(build_app()).get("/api/data-quality/master-ties.csv", headers={"x-dev-user": "dev-lead"}).text
    assert csv_.splitlines() == ['"barcode","rectime","suit_type","suit_color","suit_size"',
                                 '"G-3","2026-10-14 15:30:00","GOWN","WHITE","M"', '"G-3","2026-10-14 15:30:00","GOWN","WHITE","XL"']


def test_values_are_the_same_whatever_their_capitals():
    start()
    lg = on_hand("GOWN", "White", "LG", "P1")
    # Barcode master: White and WHITE at the same latest RECTIME are one version, not a tie.
    master_upload(version("G-1", "L", "2026-10-14 15:30:00", color="White") + version("G-1", "L", "2026-10-14 15:30:00", color="WHITE"))
    # A scan repeated with only other capitals is one version; a mapped value counts in any spelling.
    r = import_csv((ISSUES + issue("G-1", "2026-11-20 09:00:00", color="White") + issue("G-1", "2026-11-20 09:00:00", color="white ")
                    + issue("G-2", "2026-11-20 09:01:00", color="White", size="l")).encode())
    assert (r["new"], r["conflicts"], r["waiting"]) == (2, 0, 0)
    assert scan("G-1")["status"] == "applied" and scan("G-2")["status"] == "applied"
    assert on_hand("GOWN", "White", "LG", "P1") == lg - 2
    with connect() as c:
        assert one(c, "SELECT tied FROM barcode_master WHERE suit_barcode = 'G-1'")["tied"] == 0  # type: ignore[index]


def test_recheck_cleans_up_data_from_before():
    from gi.importing.importer import recheck_values
    start()
    with connect() as c:  # as stored by the earlier version: a tie that only differs in capitals, and a held row
        c.exec_driver_sql("""INSERT INTO barcode_master (suit_barcode, suit_type, suit_color, suit_size, rectime, tied, tie_values)
                             VALUES ('G-1', 'GOWN', 'White', 'L', '2026-10-14 15:30:00', TRUE, '[["GOWN","White","L"],["GOWN","WHITE","L"]]')""")
    import_csv((ISSUES + issue("G-2", "2026-11-20 09:01:00", color="White")).encode())
    with connect() as c:
        c.exec_driver_sql("UPDATE issue_import SET status = 'held_unmapped', stock_item_id = NULL WHERE suit_barcode = 'G-2'")
        c.exec_driver_sql("DELETE FROM ledger_entry WHERE issue_import_id = (SELECT id FROM issue_import WHERE suit_barcode = 'G-2')")
        c.exec_driver_sql("UPDATE stock_item si SET on_hand = (SELECT COALESCE(SUM(delta), 0) FROM ledger_entry WHERE stock_item_id = si.id)")
    from gi.db import with_tx
    r = with_tx(recheck_values)
    assert (r["untied"], r["released"]) == (1, 1)
    assert scan("G-2")["status"] == "applied"
    with connect() as c:
        assert invariant_violations(c) == []
