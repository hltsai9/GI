from datetime import datetime, timezone

import pytest
from conftest import admin_headers, ref_ids, user_id
from fastapi.testclient import TestClient

from gi.db import connect, rows
from gi.ledger import invariant_violations
from gi.importing.csv_upload import import_csv
from gi.services import settings, stock, trends
from gi.services.counts import StartingCountInput, save_starting_count

pytestmark = pytest.mark.usefixtures("fresh_db")
NOW = datetime(2026, 11, 20, 23, 0, tzinfo=timezone.utc)  # 16:00 on 20 Nov in Phoenix
HEADER = "SUIT_BARCODE,SUIT_TYPE,SUIT_COLOR,SUIT_SIZE,SUIT_LEVEL,STATE,INSERT_TIME,RECTIME\n"


def csv_line(barcode, t, color="WHITE", size="L"):
    return f'"{barcode}",GOWN,{color},{size},FAB1,EMPLOYEE GOWN ISSUE,{t},2026-11-19 20:00:00\n'


def setup_rows():
    ids = ref_ids()
    with connect() as c:
        for col, val, fk, target in [("SUIT_TYPE", "GOWN", "garment_type_id", ids["type"]["GOWN"]), ("SUIT_COLOR", "WHITE", "color_id", ids["color"]["White"]),
                                     ("SUIT_SIZE", "L", "size_id", ids["size"]["LG"]), ("SUIT_LEVEL", "FAB1", "location_id", ids["loc"]["P1"])]:
            c.exec_driver_sql(f"INSERT INTO oracle_value_map (oracle_column, oracle_value, {fk}) VALUES (%s, %s, %s) ON DUPLICATE KEY UPDATE {fk} = VALUES({fk})",
                              (col, val, target))
    save_starting_count(StartingCountInput(locationId=ids["loc"]["P1"], asOf="2026-11-19T00:00:00Z", counts=[]), user_id())
    # Two registered gowns and three unregistered rows (GOWN / OTHER / OTHER), scanned 20 Nov in Taipei = 19 Nov in Phoenix.
    data = (HEADER + csv_line("G-1", "2026-11-20 09:00:00") + csv_line("G-2", "2026-11-20 09:01:00")
            + csv_line("X  12", "2026-11-20 09:02:00", "OTHER", "OTHER") + csv_line("x  12", "2026-11-20 09:03:00", "OTHER", "OTHER")
            + csv_line(" X  12 ", "2026-11-20 09:04:00", "OTHER", "OTHER"))
    r = import_csv(data.encode())
    assert r["new"] == 5


def test_new_sizes_and_color_in_order():
    with connect() as c:
        sizes = [r["code"] for r in rows(c, "SELECT code FROM size WHERE NOT is_system ORDER BY sort")]
        colors = [r["name"] for r in rows(c, "SELECT name FROM color WHERE NOT is_system ORDER BY sort")]
    assert sizes == ["XSM", "SM", "MED", "LG", "XLG", "2XLG", "3XLG", "4XLG", "5XLG", "6XLG", "7XLG", "UNI", "Other"]
    assert colors == ["White", "Blue", "Black", "Grey", "Other"]


def test_barcodes_are_kept_exactly():
    setup_rows()
    with connect() as c:
        dq = settings.unregistered_barcodes(c)
    # Case, leading and inner spaces are kept, so these are three different barcodes (trailing padding is removed).
    assert sorted(b["barcode"] for b in dq) == [" X  12", "X  12", "x  12"]
    b = next(b for b in dq if b["barcode"] == "X  12")
    assert b["last_insert_time"] == "2026-11-20 09:02:00"   # as in Oracle (Taipei)
    assert b["last_seen"] == "2026-11-20T01:02:00.000Z"    # the same moment in UTC (18:02 on 19 Nov in Phoenix)


def test_unregistered_barcodes_can_be_left_out_one_by_one():
    setup_rows()
    def issued_19() -> int:
        with connect() as c:
            return next(p for p in trends.issued(c, 7, NOW)["points"] if p["day"] == "2026-11-19")["total"]
    def bucket() -> int:
        with connect() as c:
            return stock.stock_summary(c, NOW)["unregistered"][0]["onHand"]
    assert (issued_19(), bucket()) == (5, -3)
    r = settings.set_barcode_excluded(settings.ExcludeInput(barcode="X  12", excluded=True, note="test tag"), user_id())
    assert (r["changed"], r["byStatus"]) == (1, {"ignored": 1})
    assert (issued_19(), bucket()) == (4, -2)          # only that barcode is left out; the others still count
    with connect() as c:
        listed = {b["barcode"]: b for b in settings.unregistered_barcodes(c)}
        assert listed["X  12"]["excluded"] and listed["X  12"]["excluded_note"] == "test tag" and not listed["x  12"]["excluded"]
        assert invariant_violations(c) == []
    # A new issue of the same barcode is left out too.
    import_csv((HEADER + csv_line("X  12", "2026-11-21 09:00:00", "OTHER", "OTHER")).encode())
    with connect() as c:
        assert rows(c, "SELECT status FROM issue_import WHERE suit_barcode = 'X  12' ORDER BY id") == [{"status": "ignored"}] * 2
    # Counting it again restores both issues.
    r = settings.set_barcode_excluded(settings.ExcludeInput(barcode="X  12", excluded=False), user_id())
    assert (r["changed"], r["byStatus"]) == (2, {"applied": 2})
    assert bucket() == -4
    with connect() as c:
        assert invariant_violations(c) == []


def test_exclusion_endpoint_needs_lead_or_admin():
    setup_rows()
    from gi.app import build_app
    c = TestClient(build_app())
    body = {"barcode": "X  12", "excluded": True}
    assert c.put("/api/data-quality/excluded", json=body, headers={"x-dev-user": "dev-floor"}).status_code == 403
    assert c.put("/api/data-quality/excluded", json=body, headers={"x-dev-user": "dev-lead"}).json()["changed"] == 1
    assert c.put("/api/data-quality/excluded", json={**body, "barcode": "nope"}, headers=admin_headers()).status_code == 404


def test_admin_needs_the_passcode():
    from gi.app import build_app
    c = TestClient(build_app())
    assert c.get("/api/me", headers={"x-dev-user": "dev-admin"}).status_code == 401
    assert c.post("/api/dev/admin-unlock", json={"passcode": "wrong"}).status_code == 403
    token = c.post("/api/dev/admin-unlock", json={"passcode": "test-passcode"}).json()["token"]
    assert c.get("/api/me", headers={"x-dev-user": "dev-admin", "x-admin-token": token}).json()["role"] == "admin"
    tampered = token[:-1] + ("1" if token[-1] == "0" else "0")  # always a different last character
    assert c.get("/api/me", headers={"x-dev-user": "dev-admin", "x-admin-token": tampered}).status_code == 401
    # Oracle values: changes are admin only.
    with connect() as cn:
        mid = rows(cn, "SELECT id FROM oracle_value_map LIMIT 1")
    if mid:
        assert c.put(f"/api/oracle-values/{mid[0]['id']}", json={"ignore": True}, headers={"x-dev-user": "dev-lead"}).status_code == 403


def test_unregistered_csv_download_quotes_barcodes():
    setup_rows()
    from gi.app import build_app
    text = TestClient(build_app()).get("/api/data-quality/unregistered.csv", headers={"x-dev-user": "dev-lead"}).text
    assert '" X  12"' in text and text.splitlines()[0].startswith('"barcode","times_issued"')


def test_barcodes_with_conflicting_values():
    data = (HEADER + csv_line("G-1", "2026-11-20 09:00:00") + csv_line("G-1", "2026-11-20 10:00:00")
            + csv_line("G-1", "2026-11-21 09:00:00", "BLUE")              # same barcode, other color
            + csv_line("G-2", "2026-11-20 09:00:00") + csv_line("G-2", "2026-11-21 09:00:00")   # consistent
            + csv_line("G-3", "2026-11-20 09:00:00", "OTHER", "OTHER") + csv_line("G-3", "2026-11-21 09:00:00", size="XL")
            + csv_line("G-4", "2026-11-20 09:00:00", "white") + csv_line("G-4", "2026-11-21 09:00:00"))   # case differs
    import_csv(data.encode())
    with connect() as c:
        got = {b["barcode"]: b for b in settings.conflicting_barcodes(c)}
    assert sorted(got) == ["G-1", "G-3", "G-4"]
    g1 = got["G-1"]
    assert g1["times"] == 3 and [(k["color"], k["times"]) for k in g1["combinations"]] == [("WHITE", 2), ("BLUE", 1)]
    assert g1["combinations"][0]["last_insert_time"] == "2026-11-20 10:00:00"
    assert [k["unregistered"] for k in got["G-3"]["combinations"]] == [True, False]   # registered later
    from gi.app import build_app
    text = TestClient(build_app()).get("/api/data-quality/conflicts.csv", headers={"x-dev-user": "dev-lead"}).text
    assert text.count("\n") == 1 + 6 and '"G-1","GOWN","BLUE","L","1","yes"' in text



def test_same_scan_with_other_values_is_recorded_not_lost():
    # Back-to-back rows: same barcode and INSERT_TIME (the same scan), different color.
    same = (HEADER + csv_line("2399600002641084", "2026-11-20 09:00:00") + csv_line("2399600002641084", "2026-11-20 09:00:00", "BLUE")
            + csv_line("G-9", "2026-11-20 09:00:00") + csv_line("G-9", "2026-11-20 09:00:00"))   # a true duplicate
    r = import_csv(same.encode())
    assert (r["new"], r["conflicts"], r["alreadyImported"]) == (2, 1, 1)
    with connect() as c:
        got = {b["barcode"]: b for b in settings.conflicting_barcodes(c)}
        alerts = rows(c, "SELECT kind FROM admin_alert")
    assert list(got) == ["2399600002641084"]
    assert [(k["color"], k["notCounted"]) for k in got["2399600002641084"]["combinations"]] == [("WHITE", False), ("BLUE", True)]
    assert {"kind": "data_conflict"} in alerts
    # Uploading the same file again records nothing new twice.
    r = import_csv(same.encode())
    assert (r["new"], r["conflicts"]) == (0, 1)
    with connect() as c:
        assert rows(c, "SELECT times FROM issue_import_conflict") == [{"times": 2}]


def test_trends_split_by_location():
    setup_rows()
    with connect() as c:
        iss = trends.issued(c, 7, NOW)
        day = next(p for p in iss["points"] if p["day"] == "2026-11-19")
        assert iss["locations"] == ["P1", "P2"] and day["byLocation"] == {"P1": 5, "P2": 0}
        assert day["byLocationValues"]["P1"]["Unregistered"] == 3
        st = trends.stock_over_time(c, 7, NOW)
        p = next(p for p in st["points"] if p["day"] == "2026-11-19")
        assert p["byLocation"]["P2"]["Gown"] is None            # no starting count at P2
        assert p["byLocation"]["P1"]["Gown"] == p["values"]["Gown"]
        f = next(f for f in st["flows"] if f["day"] == "2026-11-19")
        assert f["byLocation"]["P1"]["issued"] == 5 and f["issued"] == 5
        b = trends.breakdown(c, 7, "issued", NOW)
        assert sum(x["byLocation"]["P1"] for x in b["bySize"]) == 5


def test_find_unregistered_barcodes_and_timing_header():
    setup_rows()
    from gi.app import build_app
    c = TestClient(build_app())
    h = {"x-dev-user": "dev-lead"}
    r = c.get("/api/data-quality/unregistered?find=X  1", headers=h)
    assert [b["barcode"] for b in r.json()] == [" X  12", "X  12"]          # case and spaces as stored
    assert c.get("/api/data-quality/unregistered?find=%25", headers=h).json() == []   # % is searched literally
    assert r.headers["server-timing"].startswith("app;dur=")
    dq = c.get("/api/data-quality?days=30", headers=h).json()
    assert dq["unregisteredTotal"] == 3 and dq["conflictingTotal"] == 0
