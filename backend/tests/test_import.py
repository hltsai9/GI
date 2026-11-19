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
    data = [row("2026-11-20 08:00:00", "2026-11-19 18:00:00", SUIT_BARCODE="G-1")]
    assert poll(src(data), NOW)["new"] == 1
    assert poll(src(data), NOW)["new"] == 0
    assert sweep(src(data), NOW)["new"] == 0
    with connect() as c:
        assert one(c, "SELECT COUNT(*) AS n FROM issue_import")["n"] == 1  # type: ignore[index]


def test_starting_count_reclassifies_issues_scanned_after_it():
    data = [row("2026-11-20 20:00:00", "2026-11-20 05:30:00", SUIT_BARCODE="G-early"),  # 05:00 PHX
            row("2026-11-20 22:00:00", "2026-11-20 07:30:00", SUIT_BARCODE="G-late")]  # 07:00 PHX
    poll(src(data), NOW)
    assert status("G-early")["status"] == "before_start"
    assert status("G-late")["status"] == "before_start"
    assert start_count("Fab1", "2026-11-20T13:00:00Z")["issuesApplied"] == 1
    assert status("G-early")["status"] == "before_start"
    assert status("G-late")["status"] == "applied"
    assert on_hand("GOWN", "White", "LG", "Fab1") == 99
    assert violations() == []


def test_watermark_per_location():
    start_count("Fab1", "2026-11-19T00:00:00Z")
    start_count("Fab2", "2026-11-19T00:00:00Z")
    data = [row("2026-11-21 00:00:00", "2026-11-20 10:30:00", SUIT_BARCODE="G-f1"),
            row("2026-11-20 23:00:00", "2026-11-20 10:05:00", SUIT_BARCODE="G-f2", SUIT_LEVEL="FAB2", VISIBLE_AT="2026-11-20 10:50:00"),
            row("2026-11-20 20:00:00", "2026-11-20 06:00:00", SUIT_BARCODE="G-f2old", SUIT_LEVEL="FAB2")]
    poll(src(data, utc("2026-11-20T17:40:00Z")), NOW)  # 10:40 PHX: f2 not visible yet
    assert not exists("G-f2")
    poll(src(data, utc("2026-11-20T18:00:00Z")), NOW)
    assert status("G-f2")["status"] == "applied"


def test_pages_through_rows_sharing_a_rectime():
    start_count("Fab1", "2026-11-19T00:00:00Z")
    config.ORACLE_MAX_ROWS = 2
    data = [row("2026-11-21 00:00:00", "2026-11-20 10:00:00", SUIT_BARCODE=f"G-{b}") for b in "ABCDE"]
    assert poll(src(data), NOW)["new"] == 5


def test_late_record_counts_on_the_scan_day():
    start_count("Fab1", "2026-11-18T00:00:00Z")
    # Scan 23:50 on 19 Nov Phoenix (= 14:50 on 20 Nov Taipei), entered 14:40 on 20 Nov Phoenix
    t = utc("2026-11-20T21:41:00Z")
    poll(src([row("2026-11-20 14:50:00", "2026-11-20 14:40:00", SUIT_BARCODE="G-late")], t), t)
    assert str(status("G-late")["issued_day"]) == "2026-11-19"


def test_holds_unmapped_values_until_mapped():
    start_count("Fab1", "2026-11-19T00:00:00Z")
    poll(src([row("2026-11-21 00:00:00", "2026-11-20 09:30:00", SUIT_BARCODE="G-5xl", SUIT_SIZE="5XL")]), NOW)
    assert status("G-5xl")["status"] == "held_unmapped"
    with connect() as c:
        m = one(c, "SELECT id FROM oracle_value_map WHERE oracle_column = 'SUIT_SIZE' AND oracle_value = '5XL'")
    r = set_mapping(m["id"], MappingInput(targetId=ref_ids()["size"]["Other"]), user_id())  # type: ignore[index]
    assert r["reclassified"] == 1
    assert status("G-5xl")["status"] == "applied"
    assert on_hand("GOWN", "White", "Other", "Fab1") == -1


def test_ignores_ignored_location_and_other_states():
    poll(src([row("2026-11-21 00:00:00", "2026-11-20 09:30:00", SUIT_BARCODE="G-test", SUIT_LEVEL="TEST"),
              row("2026-11-21 00:00:00", "2026-11-20 09:30:00", SUIT_BARCODE="G-ret", STATE="EMPLOYEE GOWN RETURN")]), NOW)
    assert status("G-test")["status"] == "ignored"
    assert not exists("G-ret")


def test_unregistered_bucket():
    start_count("Fab2", "2026-11-19T00:00:00Z")
    poll(src([row("2026-11-21 00:00:00", "2026-11-20 09:30:00", SUIT_BARCODE="X-1", SUIT_LEVEL="FAB2",
                  SUIT_COLOR="OTHER", SUIT_SIZE="OTHER")]), NOW)
    s = status("X-1")
    assert (s["status"], s["quality"]) == ("applied", "incomplete")
    assert on_hand("UNREGISTERED", "Unregistered", "Unregistered", "Fab2") == -1
    assert on_hand("GOWN", "Other", "Other", "Fab2") == 0


def test_bad_clock_alerts_and_sweep_finds_it():
    start_count("Fab1", "2026-11-15T00:00:00Z")
    normal = row("2026-11-21 00:00:00", "2026-11-20 09:30:00", SUIT_BARCODE="G-n")
    poll(src([normal]), NOW)
    # RECTIME 140 h before the scan, far behind the FAB1 watermark
    bad = row("2026-11-21 01:00:00", "2026-11-14 15:00:00", SUIT_BARCODE="G-bad", VISIBLE_AT="2026-11-20 10:00:00")
    assert poll(src([normal, bad]), NOW)["new"] == 0
    s = sweep(src([normal, bad]), NOW)
    assert s["new"] == 1
    assert s["timeCheckFailed"] == 1
    with connect() as c:
        assert [a["kind"] for a in rows(c, "SELECT kind FROM admin_alert ORDER BY id")] == ["time_check", "sweep_found_rows"]
    assert status("G-bad")["status"] == "applied"


def test_end_to_end_ledger_intact():
    data = [row(f"2026-11-20 {i % 24:02d}:00:00", f"2026-11-20 {i % 24:02d}:10:00", SUIT_BARCODE=f"G-{i}",
                SUIT_LEVEL="FAB1" if i % 3 else "FAB2", SUIT_SIZE=["S", "M", "L", "XL"][i % 4]) for i in range(300)]
    start_count("Fab1", "2026-11-19T00:00:00Z")
    assert poll(src(data, utc("2026-11-21T12:00:00Z")), NOW)["new"] == 300
    assert violations() == []


def test_generated_mock_source_is_the_same_on_every_replica():
    from gi.mock_oracle import generate
    a, _ = generate(days=3, ahead=1, now=NOW)
    b, _ = generate(days=3, ahead=1, now=NOW)
    assert a == b and len(a) > 500
