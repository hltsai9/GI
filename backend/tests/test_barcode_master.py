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


def test_upload_endpoint_is_admin_only_and_reports_problems():
    c = TestClient(__import__("gi.app", fromlist=["build_app"]).build_app())
    body = (MASTER + version("G-1", "L", "2026-10-14 15:30:00")).encode()
    assert c.post("/api/barcode-master/upload", content=body, headers={"x-dev-user": "dev-lead"}).status_code == 403
    ok = c.post("/api/barcode-master/upload", content=body, headers=admin_headers())
    assert ok.status_code == 200 and ok.json()["barcodes"] == 1
    bad = c.post("/api/barcode-master/upload", content=b"SUIT_BARCODE,SUIT_SIZE\nG-1,L\n", headers=admin_headers())
    assert bad.status_code == 400 and "RECTIME" in bad.json()["error"]
    s = c.get("/api/barcode-master", headers={"x-dev-user": "dev-lead"}).json()
    assert s["barcodes"] == 1 and s["last"]["kind"] == "master_upload"
