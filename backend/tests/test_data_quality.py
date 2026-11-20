from datetime import datetime, timezone

import pytest
from conftest import ref_ids, user_id
from fastapi.testclient import TestClient

from gi.db import connect, rows
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
                                     ("SUIT_SIZE", "L", "size_id", ids["size"]["LG"]), ("SUIT_LEVEL", "FAB1", "location_id", ids["loc"]["Fab1"])]:
            c.exec_driver_sql(f"INSERT INTO oracle_value_map (oracle_column, oracle_value, {fk}) VALUES (%s, %s, %s) ON DUPLICATE KEY UPDATE {fk} = VALUES({fk})",
                              (col, val, target))
    save_starting_count(StartingCountInput(locationId=ids["loc"]["Fab1"], asOf="2026-11-19T00:00:00Z", counts=[]), user_id())
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


def test_unregistered_can_be_left_out_of_issued_numbers():
    setup_rows()
    with connect() as c:
        day = next(p for p in trends.issued(c, 7, NOW)["points"] if p["day"] == "2026-11-19")
        assert (day["values"]["Unregistered"], day["total"]) == (3, 5)
        assert sum(x["n"] for x in trends.breakdown(c, 7, "issued", NOW)["byLocation"]) == 5
        assert stock.stock_summary(c, NOW)["countUnregistered"] is True
    assert settings.set_count_unregistered(False, user_id()) == {"countUnregistered": False}
    with connect() as c:
        iss = trends.issued(c, 7, NOW)
        day = next(p for p in iss["points"] if p["day"] == "2026-11-19")
        assert "Unregistered" not in iss["series"] and day["total"] == 2
        assert sum(x["n"] for x in trends.breakdown(c, 7, "issued", NOW)["byLocation"]) == 2
        assert next(f for f in trends.stock_over_time(c, 7, NOW)["flows"] if f["day"] == "2026-11-19")["issued"] == 2
        assert stock.stock_summary(c, NOW)["countUnregistered"] is False
        assert settings.meta(c)["countUnregistered"] is False
        # Still imported and listed for the vendor.
        assert len(settings.unregistered_barcodes(c)) == 3


def test_switch_endpoint_needs_the_lead():
    from gi.app import build_app
    c = TestClient(build_app())
    assert c.put("/api/settings/count-unregistered", json={"value": False}, headers={"x-dev-user": "dev-floor"}).status_code == 403
    assert c.put("/api/settings/count-unregistered", json={"value": False}, headers={"x-dev-user": "dev-lead"}).json() == {"countUnregistered": False}
    assert c.get("/api/meta", headers={"x-dev-user": "dev-viewer"}).json()["countUnregistered"] is False


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
    assert text.count("\n") == 1 + 6 and '"G-1","GOWN","BLUE","L","1"' in text
