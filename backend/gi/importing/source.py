"""Read-only access to the issuing system's issue rows (only STATE = ISSUE_STATE)."""
from __future__ import annotations

from typing import Protocol, TypedDict

ISSUE_STATE = "EMPLOYEE GOWN ISSUE"


class OracleIssueRow(TypedDict):
    """One Oracle issue-table row as GI reads it. INSERT_TIME is naive 'YYYY-MM-DD HH:MM:SS'."""
    SUIT_BARCODE: str
    SUIT_TYPE: str
    SUIT_COLOR: str
    SUIT_SIZE: str
    SUIT_LEVEL: str
    INSERT_TIME: str  # Phoenix local time: when the barcode was scanned (= issued). RECTIME is not used.


class InsertKey(TypedDict):
    """Keyset position: rows with INSERT_TIME > insert_time, or equal INSERT_TIME and SUIT_BARCODE > barcode."""
    insert_time: str
    barcode: str


class IssueSource(Protocol):
    def by_insert_time(self, start: str, after: InsertKey | None, limit: int) -> list[OracleIssueRow]:
        """Rows with INSERT_TIME >= start (no upper limit), ordered and keyset-paged by (INSERT_TIME, SUIT_BARCODE)."""

    def close(self) -> None: ...


def clean_barcode(value: str) -> str:
    """Trailing spaces are padding, not part of the barcode: an Oracle CHAR column, or an export that lines up
    its columns, pads every barcode to the column width. Leading and inner spaces are kept as they are.
    Both the CSV upload and the live Oracle import use this, so they store the same value."""
    return value.rstrip(" ")
