import pytest

from gi.timeutil import issue_time, local_to_utc, site_day


def test_insert_time_is_phoenix_time():
    issued_at, day = issue_time("2026-11-20 09:00:00")
    assert issued_at.isoformat() == "2026-11-20T16:00:00+00:00"   # Phoenix is UTC−7
    assert day == "2026-11-20"


def test_counts_an_issue_on_the_day_of_the_scan():
    assert issue_time("2026-11-19 23:59:59")[1] == "2026-11-19"
    assert issue_time("2026-11-20 00:00:00")[1] == "2026-11-20"


def test_handles_both_midnights():
    assert site_day(local_to_utc("2026-11-19 23:59:59", "America/Phoenix")) == "2026-11-19"
    assert site_day(local_to_utc("2026-11-20 00:00:00", "America/Phoenix")) == "2026-11-20"


def test_no_daylight_saving_jump():
    before = local_to_utc("2026-03-07 12:00:00", "America/Phoenix")
    after = local_to_utc("2026-03-09 12:00:00", "America/Phoenix")
    assert (after - before).total_seconds() == 2 * 86400


def test_rejects_malformed_dates():
    with pytest.raises(ValueError):
        local_to_utc("20/11/2026", "America/Phoenix")
