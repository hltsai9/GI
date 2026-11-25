"""Read-only access to the issuing system's issue rows (only STATE = ISSUE_STATE)."""
from __future__ import annotations

from typing import Protocol, TypedDict

ISSUE_STATE = "EMPLOYEE GOWN ISSUE"


class OracleIssueRow(TypedDict):
    """One Oracle issue-table row as GI reads it. INSERT_TIME is naive 'YYYY-MM-DD HH:MM:SS'. The four values
    can be empty (None); GI records that and fills type, color and size from the barcode master."""
    SUIT_BARCODE: str
    SUIT_TYPE: str | None
    SUIT_COLOR: str | None
    SUIT_SIZE: str | None
    SUIT_LEVEL: str | None
    INSERT_TIME: str  # Phoenix local time: when the barcode was scanned (= issued). RECTIME is not used.


class InsertKey(TypedDict):
    """Keyset position: rows with INSERT_TIME > insert_time, or equal INSERT_TIME and SUIT_BARCODE > barcode."""
    insert_time: str
    barcode: str


class MasterRow(TypedDict):
    """One row of the Oracle barcode master table. A barcode can have several rows; the latest RECTIME is current.
    RECTIME is naive 'YYYY-MM-DD HH:MM:SS' and only compared with other RECTIMEs of the same table."""
    SUIT_BARCODE: str
    SUIT_CATEGORY: str | None
    SUIT_TYPE: str | None
    SUIT_COLOR: str | None
    SUIT_SIZE: str | None
    RECTIME: str | None  # empty in some rows: such a row counts as the oldest version


class MasterSource(Protocol):
    def master_page(self, after: str | None, limit: int, since: str | None = None) -> list[MasterRow]:
        """Rows with SUIT_BARCODE > after, ordered by SUIT_BARCODE (each barcode's latest rows, or all of them);
        with `since`, only rows with RECTIME at or after it."""

    def master_for(self, barcodes: list[str]) -> list[MasterRow]:
        """Every row of these barcodes."""


class IssueSource(Protocol):
    def by_insert_time(self, start: str, after: InsertKey | None, limit: int) -> list[OracleIssueRow]:
        """Rows with INSERT_TIME >= start (no upper limit), ordered and keyset-paged by (INSERT_TIME, SUIT_BARCODE)."""

    def close(self) -> None: ...


def clean_value(value: object) -> str | None:
    """Empty or blank means NULL (Oracle has no empty strings); other values are kept exactly as they are."""
    if value is None or not str(value).strip():
        return None
    return str(value)


def clean_barcode(value: str) -> str:
    """Trailing spaces are padding, not part of the barcode: an Oracle CHAR column, or an export that lines up
    its columns, pads every barcode to the column width. Leading and inner spaces are kept as they are.
    Both the CSV upload and the live Oracle import use this, so they store the same value."""
    return value.rstrip(" ")
