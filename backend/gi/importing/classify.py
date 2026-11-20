"""Decides status, quality and stock item for one issue row (BUILD_PLAN §3.2)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.engine import Connection

from ..db import execute, rows
from ..stock_items import stock_item_id, unregistered_bucket
from ..timeutil import from_db, to_db

_FK = {"SUIT_TYPE": "garment_type_id", "SUIT_COLOR": "color_id", "SUIT_SIZE": "size_id", "SUIT_LEVEL": "location_id"}


@dataclass
class Classification:
    status: str  # applied | held_unmapped | before_start | ignored
    quality: str  # complete | incomplete | recovered
    location_id: int | None
    stock_item_id: int | None


@dataclass
class ClassifyContext:
    """Everything classify_issue needs, loaded once per import batch or re-classification."""
    mapping: dict[tuple[str, str], dict]
    patterns: set[tuple[str, str, str]]
    starting_counts: dict[int, datetime]
    excluded: set[str] = field(default_factory=set)  # unregistered barcodes left out (excluded_barcode)
    items: dict[tuple, int] = field(default_factory=dict)  # stock item ids already resolved

    @classmethod
    def load(cls, conn: Connection) -> "ClassifyContext":
        mapping = {(r["oracle_column"], r["oracle_value"]): r for r in rows(conn, "SELECT * FROM oracle_value_map")}
        patterns = {(r["suit_type"], r["suit_color"], r["suit_size"])
                    for r in rows(conn, "SELECT suit_type, suit_color, suit_size FROM dq_pattern WHERE active")}
        starts = {r["location_id"]: from_db(r["as_of"]) for r in rows(conn, "SELECT location_id, as_of FROM starting_count")}
        excluded = {r["suit_barcode"] for r in rows(conn, "SELECT suit_barcode FROM excluded_barcode")}
        return cls(mapping, patterns, starts, excluded)

    def lookup(self, column: str, value: str) -> dict | None:
        return self.mapping.get((column, value))


def _mapped_id(m: dict | None, column: str) -> int | None:
    return m[_FK[column]] if m and not m["is_ignored"] else None


def _is_mapped(m: dict | None) -> bool:
    return bool(m) and not m["is_ignored"] and any(m[k] is not None for k in _FK.values())  # type: ignore[index]


def classify_issue(conn: Connection, ctx: ClassifyContext, suit_type: str, suit_color: str, suit_size: str,
                   suit_level: str, issued_at: datetime, barcode: str | None = None) -> Classification:
    """Checks run in a fixed order and the first match wins:
     a) any value mapped to Ignore, or an unregistered barcode left out (Settings › Data quality) → ignored
     b) incomplete (known-bad pattern)  → unregistered bucket of the location (only SUIT_LEVEL must be mapped)
        complete                        → all four values must be mapped, else held_unmapped
     c) no starting count yet / before it → before_start
     d) otherwise                       → applied
    Creates the stock item if it does not exist yet; never touches the ledger."""
    incomplete = (suit_type, suit_color, suit_size) in ctx.patterns
    cols = [("SUIT_LEVEL", suit_level)] if incomplete else [
        ("SUIT_TYPE", suit_type), ("SUIT_COLOR", suit_color), ("SUIT_SIZE", suit_size), ("SUIT_LEVEL", suit_level)]
    quality = "incomplete" if incomplete else "complete"

    if any((ctx.lookup(c, v) or {}).get("is_ignored") for c, v in cols) or (incomplete and barcode in ctx.excluded):
        return Classification("ignored", quality, None, None)
    location_id = _mapped_id(ctx.lookup("SUIT_LEVEL", suit_level), "SUIT_LEVEL")
    if not all(_is_mapped(ctx.lookup(c, v)) for c, v in cols):
        return Classification("held_unmapped", quality, location_id, None)

    key = ("U", location_id) if incomplete else (suit_type, suit_color, suit_size, location_id)
    item_id = ctx.items.get(key)
    if item_id is None:
        item_id = unregistered_bucket(conn, location_id) if incomplete else stock_item_id(  # type: ignore[arg-type]
            conn,
            _mapped_id(ctx.lookup("SUIT_TYPE", suit_type), "SUIT_TYPE"),  # type: ignore[arg-type]
            _mapped_id(ctx.lookup("SUIT_COLOR", suit_color), "SUIT_COLOR"),  # type: ignore[arg-type]
            _mapped_id(ctx.lookup("SUIT_SIZE", suit_size), "SUIT_SIZE"),  # type: ignore[arg-type]
            location_id)  # type: ignore[arg-type]
        ctx.items[key] = item_id

    start = ctx.starting_counts.get(location_id)  # type: ignore[arg-type]
    if start is None or issued_at < start:
        return Classification("before_start", quality, location_id, item_id)
    return Classification("applied", quality, location_id, item_id)


def note_values_seen(conn: Connection, counts: dict[tuple[str, str], int], at: datetime) -> None:
    """Records Oracle values seen in a run so unmapped ones appear in Settings › Oracle values (ORA-05)."""
    for (column, value), n in counts.items():
        execute(conn, """INSERT INTO oracle_value_map (oracle_column, oracle_value, row_count, first_seen, last_seen) VALUES (?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE row_count = row_count + VALUES(row_count), first_seen = COALESCE(first_seen, VALUES(first_seen)),
                 last_seen = VALUES(last_seen)""", [column, value, n, to_db(at), to_db(at)])
