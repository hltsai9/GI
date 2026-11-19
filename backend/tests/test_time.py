import pytest

from gi.timeutil import issue_times, local_to_utc, site_day


def test_reads_insert_time_as_taipei_and_rectime_as_phoenix():
    issued_at, recorded_at, _ = issue_times("2026-11-20 09:00:00", "2026-11-19 18:30:00")
    assert issued_at.isoformat() == "2026-11-20T01:00:00+00:00"
    assert recorded_at.isoformat() == "2026-11-20T01:30:00+00:00"


def test_counts_an_issue_on_the_phoenix_day_of_the_scan():
    assert issue_times("2026-11-20 09:00:00", "2026-11-20 03:00:00")[2] == "2026-11-19"  # 18:00 on 19 Nov Phoenix
    assert issue_times("2026-11-20 15:30:00", "2026-11-20 03:00:00")[2] == "2026-11-20"  # 00:30 on 20 Nov Phoenix


def test_handles_both_midnights():
    assert site_day(local_to_utc("2026-11-19 23:59:59", "America/Phoenix")) == "2026-11-19"
    assert site_day(local_to_utc("2026-11-20 00:00:00", "America/Phoenix")) == "2026-11-20"
    assert issue_times("2026-11-20 14:59:59", "2026-11-20 00:00:00")[2] == "2026-11-19"
    assert issue_times("2026-11-20 15:00:00", "2026-11-20 00:00:00")[2] == "2026-11-20"


def test_no_daylight_saving_jump():
    before = local_to_utc("2026-03-07 12:00:00", "America/Phoenix")
    after = local_to_utc("2026-03-09 12:00:00", "America/Phoenix")
    assert (after - before).total_seconds() == 2 * 86400


def test_rejects_malformed_dates():
    with pytest.raises(ValueError):
        local_to_utc("20/11/2026", "Asia/Taipei")
