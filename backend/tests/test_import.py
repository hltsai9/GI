from datetime import datetime, timezone

from conftest import on_hand, ref_ids, row, user_id
import pytest

from gi.config import config
from gi.db import connect, one, rows
from gi.importing.importer import poll, sweep
from gi.importing.mock_source import MockIssueSource
from gi.ledger import invariant_violations
from gi.services.counts import CountLine, StartingCountInput, save_starting_count
from gi.services.settings import MappingInput, set_mapping

pytestmark = pytest.mark.usefixtures("fresh_db")


def utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


NOW = utc("2026-11-20T19:00:00Z")  # 20 Nov 2026 12:00 Phoenix


def src(data, now=NOW):
    return MockIssueSource(data, lambda: now)


def status(barcode: str) -> dict:
    with connect() as c:
        return one(c, "SELECT status, quality, issued_day FROM issue_import WHERE suit_barcode = ?", [barcode])  # type: ignore[return-value]


def exists(barcode: str) -> bool:
    with connect() as c:
        return one(c, "SELECT 1 AS x FROM issue_import WHERE suit_barcode = ?", [barcode]) is not None


def start_count(location: str, as_of: str) -> dict:
    ids = ref_ids()
    return save_starting_count(StartingCountInput(locationId=ids["loc"][location], asOf=as_of, counts=[
        CountLine(garmentTypeId=ids["type"]["GOWN"], colorId=ids["color"]["White"], sizeId=ids["size"]["LG"], qty=100)]), user_id(), NOW)


def violations():
    with connect() as c:
        return invariant_violations(c)


def test_imports_each_row_once():
    data = [row("2026-11-20 08:00:00", SUIT_BARCODE="G-1")]
    assert poll(src(data), NOW)["new"] == 1
    assert poll(src(data), NOW)["new"] == 0
    assert sweep(src(data), NOW)["new"] == 0
    with connect() as c:
        assert one(c, "SELECT COUNT(*) AS n FROM issue_import")["n"] == 1  # type: ignore[index]


def test_starting_count_reclassifies_issues_scanned_after_it():
    # Count finished 06:00 Phoenix (13:00 UTC); issues scanned at 05:00 and 07:00 Phoenix.
    data = [row("2026-11-20 05:00:00", SUIT_BARCODE="G-early"), row("2026-11-20 07:00:00", SUIT_BARCODE="G-late")]
    poll(src(data), NOW)
    assert status("G-early")["status"] == "before_start"
    assert status("G-late")["status"] == "before_start"
    assert start_count("P1", "2026-11-20T13:00:00Z")["issuesApplied"] == 1
    assert status("G-early")["status"] == "before_start"
    assert status("G-late")["status"] == "applied"
    assert on_hand("GOWN", "White", "LG", "P1") == 99
    assert violations() == []


def test_finds_records_entered_late_within_the_look_back():
    start_count("P1", "2026-11-19T00:00:00Z")
    on_time = row("2026-11-20 09:00:00", SUIT_BARCODE="G-on-time")
    late = row("2026-11-20 08:00:00", SUIT_BARCODE="G-late", VISIBLE_AT="2026-11-20 20:00:00")  # entered 12 h after the scan
    poll(src([on_time, late], utc("2026-11-20T17:00:00Z")), NOW)        # 10:00 Phoenix: the late one is not there yet
    assert exists("G-on-time") and not exists("G-late")
    poll(src([on_time, late], utc("2026-11-21T04:00:00Z")), NOW)        # 21:00 Phoenix
    assert status("G-late")["status"] == "applied"
    assert str(status("G-late")["issued_day"]) == "2026-11-20"           # counted on the day of the scan


def test_pages_through_rows_sharing_an_insert_time():
    start_count("P1", "2026-11-19T00:00:00Z")
    config.ORACLE_MAX_ROWS = 2
    data = [row("2026-11-20 10:00:00", SUIT_BARCODE=f"G-{b}") for b in "ABCDE"]
    assert poll(src(data), NOW)["new"] == 5


def test_counts_on_the_phoenix_day_of_insert_time():
    start_count("P1", "2026-11-18T00:00:00Z")
    poll(src([row("2026-11-19 23:50:00", SUIT_BARCODE="G-night")]), NOW)
    assert str(status("G-night")["issued_day"]) == "2026-11-19"


def test_holds_unmapped_values_until_mapped():
    start_count("P1", "2026-11-19T00:00:00Z")
    poll(src([row("2026-11-20 09:30:00", SUIT_BARCODE="G-5xl", SUIT_SIZE="5XL")]), NOW)
    assert status("G-5xl")["status"] == "held_unmapped"
    with connect() as c:
        m = one(c, "SELECT id FROM oracle_value_map WHERE oracle_column = 'SUIT_SIZE' AND oracle_value = '5XL'")
    r = set_mapping(m["id"], MappingInput(targetId=ref_ids()["size"]["Other"]), user_id())  # type: ignore[index]
    assert (r["reclassified"], r["byStatus"], r["stillHeld"]) == (1, {"applied": 1}, 0)
    assert status("G-5xl")["status"] == "applied"
    assert on_hand("GOWN", "White", "Other", "P1") == -1


def test_ignores_ignored_location_and_other_states():
    poll(src([row("2026-11-20 09:30:00", SUIT_BARCODE="G-test", SUIT_LEVEL="TEST"),
              row("2026-11-20 09:30:00", SUIT_BARCODE="G-ret", STATE="EMPLOYEE GOWN RETURN")]), NOW)
    assert status("G-test")["status"] == "ignored"
    assert not exists("G-ret")


def test_unregistered_bucket():
    start_count("P2", "2026-11-19T00:00:00Z")
    poll(src([row("2026-11-20 09:30:00", SUIT_BARCODE="X-1", SUIT_LEVEL="FAB2", SUIT_COLOR="OTHER", SUIT_SIZE="OTHER")]), NOW)
    s = status("X-1")
    assert (s["status"], s["quality"]) == ("applied", "incomplete")
    assert on_hand("UNREGISTERED", "Unregistered", "Unregistered", "P2") == -1
    assert on_hand("GOWN", "Other", "Other", "P2") == 0


def test_sweep_finds_very_late_records_and_future_scans_alert():
    start_count("P1", "2026-11-15T00:00:00Z")
    newest = row("2026-11-20 10:00:00", SUIT_BARCODE="G-n")
    poll(src([newest]), NOW)
    # Scanned 18 Nov, entered only now: older than the look-back (24 h before the newest scan), so the poll misses it.
    very_late = row("2026-11-18 09:00:00", SUIT_BARCODE="G-very-late", VISIBLE_AT="2026-11-20 11:00:00")
    future = row("2026-11-21 09:00:00", SUIT_BARCODE="G-future", VISIBLE_AT="2026-11-20 11:00:00")  # wrong clock
    data = [newest, very_late, future]
    assert poll(src(data), NOW)["new"] == 1                               # only the future scan is in the window
    s = sweep(src(data), NOW)
    assert s["new"] == 1
    with connect() as c:
        assert [a["kind"] for a in rows(c, "SELECT kind FROM admin_alert ORDER BY id")] == ["time_check", "sweep_found_rows"]
    assert status("G-very-late")["status"] == "applied"


def test_end_to_end_ledger_intact():
    data = [row(f"2026-11-20 {i % 24:02d}:00:00", SUIT_BARCODE=f"G-{i}", SUIT_LEVEL="FAB1" if i % 3 else "FAB2",
                SUIT_SIZE=["S", "M", "L", "XL"][i % 4]) for i in range(300)]
    start_count("P1", "2026-11-19T00:00:00Z")
    assert poll(src(data, utc("2026-11-21T12:00:00Z")), NOW)["new"] == 300
    assert violations() == []


def test_generated_mock_source_is_the_same_on_every_replica():
    from gi.mock_oracle import generate
    a, _ = generate(days=3, ahead=1, now=NOW)
    b, _ = generate(days=3, ahead=1, now=NOW)
    assert a == b and len(a) > 500


def test_mapping_one_value_reports_rows_still_waiting_for_others():
    # Two unmapped values on the same rows: the first mapping releases nothing, the second releases both rows.
    poll(src([row("2026-11-20 09:30:00", SUIT_BARCODE=f"G-{i}", SUIT_SIZE="5XL", SUIT_COLOR="GREY") for i in range(2)]), NOW)
    ids = ref_ids()
    with connect() as c:
        size = one(c, "SELECT id FROM oracle_value_map WHERE oracle_column = 'SUIT_SIZE' AND oracle_value = '5XL'")["id"]  # type: ignore[index]
        color = one(c, "SELECT id FROM oracle_value_map WHERE oracle_column = 'SUIT_COLOR' AND oracle_value = 'GREY'")["id"]  # type: ignore[index]
    r = set_mapping(size, MappingInput(targetId=ids["size"]["Other"]), user_id())
    assert (r["reclassified"], r["stillHeld"]) == (0, 2)
    r = set_mapping(color, MappingInput(targetId=ids["color"]["Other"]), user_id())
    assert (r["reclassified"], r["byStatus"], r["stillHeld"]) == (2, {"before_start": 2}, 0)  # no starting count yet
