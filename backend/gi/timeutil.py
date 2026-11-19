"""Time zones. Oracle DATE columns have no zone: INSERT_TIME is Taipei time, RECTIME is Phoenix time
(ORA-12). GI converts them explicitly and stores UTC."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import config

ORACLE_FMT = "%Y-%m-%d %H:%M:%S"
UTC = timezone.utc


def now_utc() -> datetime:
    return datetime.now(UTC)


def local_to_utc(naive: str, zone: str) -> datetime:
    """Parses a naive 'YYYY-MM-DD HH:MM:SS' in the given zone; returns an aware UTC datetime."""
    try:
        dt = datetime.strptime(naive, ORACLE_FMT)
    except ValueError as e:
        raise ValueError(f'invalid Oracle date "{naive}"') from e
    return dt.replace(tzinfo=ZoneInfo(zone)).astimezone(UTC)


def utc_to_local(d: datetime, zone: str) -> str:
    """Formats an instant as a naive local time in the given zone (for Oracle bind values)."""
    return d.astimezone(ZoneInfo(zone)).strftime(ORACLE_FMT)


def site_day(d: datetime, zone: str | None = None) -> str:
    """Site-time calendar day (YYYY-MM-DD) of an instant."""
    return d.astimezone(ZoneInfo(zone or config.SITE_TIMEZONE)).date().isoformat()


def from_db(v: datetime) -> datetime:
    """DATETIME values are stored in UTC and read back naive."""
    return v.replace(tzinfo=UTC) if v.tzinfo is None else v


def to_db(d: datetime) -> datetime:
    """Naive UTC datetime for writing to MariaDB."""
    return d.astimezone(UTC).replace(tzinfo=None) if d.tzinfo else d


def iso(d: datetime | None) -> str | None:
    """'2026-11-19T18:54:50.861Z', like JavaScript's toISOString()."""
    if d is None:
        return None
    return from_db(d).astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(s: str) -> datetime:
    """Accepts '...Z' and '+hh:mm' forms; returns aware UTC."""
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        raise ValueError("timestamp needs a time zone (e.g. ...Z)")
    return d.astimezone(UTC)


def issue_times(insert_time: str, rectime: str) -> tuple[datetime, datetime, str]:
    issued_at = local_to_utc(insert_time, config.ORACLE_INSERT_TIME_ZONE)
    recorded_at = local_to_utc(rectime, config.ORACLE_RECTIME_ZONE)
    return issued_at, recorded_at, site_day(issued_at)


def shift_naive(naive: str, minutes: int) -> str:
    """Shifts a naive Oracle timestamp by minutes, keeping the naive format."""
    return (datetime.strptime(naive, ORACLE_FMT) + timedelta(minutes=minutes)).strftime(ORACLE_FMT)


def naive_str(v: datetime | str) -> str:
    """A DATETIME read from MariaDB (raw Oracle copy) as 'YYYY-MM-DD HH:MM:SS'."""
    return v if isinstance(v, str) else v.strftime(ORACLE_FMT)


def day_str(v: date | str) -> str:
    return v if isinstance(v, str) else v.isoformat()
