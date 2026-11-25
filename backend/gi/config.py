"""Settings from environment variables (a .env file is read in development). Blank values mean "use the default"."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

# Oracle identifiers cannot be bind variables, so table names are validated (ORA-11).
_ORACLE_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z][A-Za-z0-9_$#]*)?$")


def _load_dotenv(path: Path) -> None:
    """Minimal .env reader for development; real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return default if v is None or v == "" else v


def _int(name: str, default: int, lo: int | None = None, hi: int | None = None) -> int:
    v = int(_env(name, str(default)))  # type: ignore[arg-type]
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise ValueError(f"{name}={v} is out of range")
    return v


@dataclass
class Config:
    MARIADB_URL: str = "mysql://gi:gi@localhost:3306/gi"
    # Alternative to MARIADB_URL (used when MARIADB_HOST is set): only the password is secret.
    MARIADB_HOST: str | None = None
    MARIADB_PORT: int = 3306
    MARIADB_USER: str = "gi"
    MARIADB_PASSWORD: str | None = None
    MARIADB_DATABASE: str = "gi"
    ISSUE_SOURCE: str = "mock"  # "mock", "oracle", or "csv" (no automatic import; CSV uploads only)
    MOCK_ORACLE_DIR: str = "./mock-oracle-data"
    ORACLE_CONNECT_STRING: str | None = None
    ORACLE_USER: str | None = None
    ORACLE_PASSWORD: str | None = None
    ORACLE_ISSUE_TABLE: str | None = None
    # Barcode master: the attributes (type, color, size) of each barcode; several rows per barcode, latest RECTIME wins.
    ORACLE_BARCODE_MASTER_TABLE: str | None = None
    BARCODE_MASTER_SYNC_HOUR: int = 2  # daily read of the barcode master, after this hour (site time)
    BARCODE_MASTER_LOOKBACK_HOURS: int = 24  # the daily read starts this far before the newest RECTIME GI has
    ORACLE_POLL_SECONDS: int = 300
    ORACLE_LOOKBACK_HOURS: int = 24  # each import re-reads this far back from the newest scan (late entries)
    ORACLE_MAX_ROWS: int = 5000
    ORACLE_SWEEP_DAYS: int = 3
    ORACLE_TIME_TOLERANCE_MINUTES: int = 10
    ORACLE_BACKFILL_FROM: str = "2026-10-01 00:00:00"
    SITE_TIMEZONE: str = "America/Phoenix"
    ORACLE_INSERT_TIME_ZONE: str = "America/Phoenix"  # INSERT_TIME is Phoenix local time
    PORT: int = 8000
    STATIC_DIR: str | None = None  # the web page to serve; default: ../frontend next to this package
    DEV_AUTH: bool = False
    # Dev sign-in: switching to the admin user needs this passcode (a secret). Empty = admin cannot be chosen.
    ADMIN_PASSCODE: str | None = None
    ADMIN_TOKEN_HOURS: int = 12


def load_config() -> Config:
    _load_dotenv(Path.cwd() / ".env")
    c = Config(
        MARIADB_URL=_env("MARIADB_URL", Config.MARIADB_URL),  # type: ignore[arg-type]
        MARIADB_HOST=_env("MARIADB_HOST"),
        MARIADB_PORT=_int("MARIADB_PORT", 3306),
        MARIADB_USER=_env("MARIADB_USER", "gi"),  # type: ignore[arg-type]
        MARIADB_PASSWORD=_env("MARIADB_PASSWORD"),
        MARIADB_DATABASE=_env("MARIADB_DATABASE", "gi"),  # type: ignore[arg-type]
        ISSUE_SOURCE=_env("ISSUE_SOURCE", "mock"),  # type: ignore[arg-type]
        MOCK_ORACLE_DIR=_env("MOCK_ORACLE_DIR", "./mock-oracle-data"),  # type: ignore[arg-type]
        ORACLE_CONNECT_STRING=_env("ORACLE_CONNECT_STRING"),
        ORACLE_USER=_env("ORACLE_USER"),
        ORACLE_PASSWORD=_env("ORACLE_PASSWORD"),
        ORACLE_ISSUE_TABLE=_env("ORACLE_ISSUE_TABLE"),
        ORACLE_BARCODE_MASTER_TABLE=_env("ORACLE_BARCODE_MASTER_TABLE"),
        BARCODE_MASTER_SYNC_HOUR=_int("BARCODE_MASTER_SYNC_HOUR", 2, 0, 23),
        BARCODE_MASTER_LOOKBACK_HOURS=_int("BARCODE_MASTER_LOOKBACK_HOURS", 24, 0, 24 * 60),
        ORACLE_POLL_SECONDS=_int("ORACLE_POLL_SECONDS", 300, 60, 43_200),
        ORACLE_LOOKBACK_HOURS=_int("ORACLE_LOOKBACK_HOURS", 24, 1, 24 * 14),
        ORACLE_MAX_ROWS=_int("ORACLE_MAX_ROWS", 5000, 1),
        ORACLE_SWEEP_DAYS=_int("ORACLE_SWEEP_DAYS", 3, 1),
        ORACLE_TIME_TOLERANCE_MINUTES=_int("ORACLE_TIME_TOLERANCE_MINUTES", 10, 0),
        ORACLE_BACKFILL_FROM=_env("ORACLE_BACKFILL_FROM", "2026-10-01 00:00:00"),  # type: ignore[arg-type]
        SITE_TIMEZONE=_env("SITE_TIMEZONE", "America/Phoenix"),  # type: ignore[arg-type]
        ORACLE_INSERT_TIME_ZONE=_env("ORACLE_INSERT_TIME_ZONE", "America/Phoenix"),  # type: ignore[arg-type]
        PORT=_int("PORT", 8000),
        STATIC_DIR=_env("STATIC_DIR"),
        DEV_AUTH=(_env("DEV_AUTH", "false") or "false").lower() == "true",
        ADMIN_PASSCODE=_env("ADMIN_PASSCODE"),
        ADMIN_TOKEN_HOURS=_int("ADMIN_TOKEN_HOURS", 12, 1, 24 * 30),
    )
    if c.ISSUE_SOURCE not in ("mock", "oracle", "csv"):
        raise ValueError("ISSUE_SOURCE must be mock, oracle or csv")
    if c.ISSUE_SOURCE == "oracle":
        for key in ("ORACLE_CONNECT_STRING", "ORACLE_USER", "ORACLE_PASSWORD", "ORACLE_ISSUE_TABLE"):
            if not getattr(c, key):
                raise ValueError(f"{key} is required when ISSUE_SOURCE=oracle")
        for key in ("ORACLE_ISSUE_TABLE", "ORACLE_BARCODE_MASTER_TABLE"):
            v = getattr(c, key)
            if v and not _ORACLE_IDENTIFIER.match(v):
                raise ValueError(f"{key} must be TABLE or SCHEMA.TABLE")
    if _env("ORACLE_SUIT_TABLE"):
        raise ValueError("ORACLE_SUIT_TABLE was renamed to ORACLE_BARCODE_MASTER_TABLE (2026-11-24); rename the setting")
    return c


config = load_config()
