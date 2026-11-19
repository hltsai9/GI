"""Read-only access to the issuing system's issue rows (only STATE = ISSUE_STATE)."""
from __future__ import annotations

from typing import Protocol, TypedDict

ISSUE_STATE = "EMPLOYEE GOWN ISSUE"


class OracleIssueRow(TypedDict):
    """One Oracle issue-table row as GI reads it. Dates are naive 'YYYY-MM-DD HH:MM:SS'."""
    SUIT_BARCODE: str
    SUIT_TYPE: str
    SUIT_COLOR: str
    SUIT_SIZE: str
    SUIT_LEVEL: str
    INSERT_TIME: str  # Taipei time: when the barcode was scanned (= issued)
    RECTIME: str  # Phoenix time: when the record was entered into the database


class RectimeKey(TypedDict):
    """Keyset position: rows with RECTIME > rectime, or equal RECTIME and SUIT_BARCODE > barcode."""
    rectime: str
    barcode: str


class InsertKey(TypedDict):
    insert_time: str
    barcode: str


class IssueSource(Protocol):
    def by_level(self, level: str, after: RectimeKey, limit: int) -> list[OracleIssueRow]:
        """Rows of one SUIT_LEVEL after a (RECTIME, SUIT_BARCODE) position, ordered by both. Paging on the
        pair, not RECTIME alone: many rows share a second, and a page ending inside such a group would skip the rest."""

    def other_levels(self, known: list[str], after: RectimeKey, limit: int) -> list[OracleIssueRow]:
        """Same, for levels not in `known` (discovery of new locations)."""

    def by_insert_time(self, start: str, after: InsertKey | None, limit: int) -> list[OracleIssueRow]:
        """Rows with INSERT_TIME >= start (no upper limit), keyset-paged by (INSERT_TIME, SUIT_BARCODE)."""

    def close(self) -> None: ...
