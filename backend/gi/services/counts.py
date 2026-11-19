from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy.engine import Connection

from ..auth import HttpError
from ..db import execute, marks, one, rows, with_tx
from ..importing.importer import reclassify
from ..ledger import Movement, apply_movements
from ..stock_items import stock_item_id, unregistered_bucket
from ..timeutil import iso, now_utc, parse_iso, to_db


class CountLine(BaseModel):
    garmentTypeId: int
    colorId: int
    sizeId: int
    qty: int = Field(ge=0)


class StartingCountInput(BaseModel):
    locationId: int
    asOf: str
    counts: list[CountLine]


def _balance_at(conn: Connection, item_id: int, at: datetime) -> int:
    """Balance of an item as of a moment: current on_hand minus movements dated at or after it."""
    r = one(conn, """SELECT s.on_hand, COALESCE((SELECT SUM(delta) FROM ledger_entry WHERE stock_item_id = s.id AND at >= ?), 0) AS later
                       FROM stock_item s WHERE s.id = ?""", [to_db(at), item_id])
    return r["on_hand"] - int(r["later"])  # type: ignore[index]


def save_starting_count(inp: StartingCountInput, user_id: int, now: datetime | None = None) -> dict:
    """Starting count for a location (ADJ-05, rule 7.8). Sets every item's balance as of `asOf` to the counted
    quantity (uncounted items to 0), keeps movements dated after `asOf`, then re-classifies that location's
    issues scanned after `asOf` so they reduce stock."""
    now = now or now_utc()
    as_of = parse_iso(inp.asOf)
    if as_of > now:
        raise HttpError(400, "the as-of time is in the future")

    def work(conn: Connection) -> dict:
        if one(conn, "SELECT 1 FROM starting_count WHERE location_id = ? FOR UPDATE", [inp.locationId]):
            raise HttpError(409, "this location already has a starting count; use a stock correction instead")
        counted: dict[int, int] = {}
        for c in inp.counts:
            i = stock_item_id(conn, c.garmentTypeId, c.colorId, c.sizeId, inp.locationId)
            counted[i] = counted.get(i, 0) + c.qty
        bucket = unregistered_bucket(conn, inp.locationId)
        for o in rows(conn, "SELECT id FROM stock_item WHERE location_id = ?", [inp.locationId]):
            counted.setdefault(o["id"], 0)
        counted[bucket] = 0
        movements = []
        for item_id, qty in counted.items():
            before = _balance_at(conn, item_id, as_of)
            if qty == 0 and before == 0:
                continue
            sc = execute(conn, "INSERT INTO stock_correction (stock_item_id, counted, system_qty, reason, user_id, at) VALUES (?,?,?,'starting_count',?,?)",
                         [item_id, qty, before, user_id, to_db(as_of)])
            if qty != before:
                movements.append(Movement(item_id, qty - before, as_of, "starting_count", user_id=user_id, stock_correction_id=sc.lastrowid))
        apply_movements(conn, movements)
        execute(conn, "INSERT INTO starting_count (location_id, as_of, entered_by) VALUES (?,?,?)", [inp.locationId, to_db(as_of), user_id])
        applied = reclassify(conn, "status = 'before_start' AND location_id = ? AND issued_at >= ?", [inp.locationId, to_db(as_of)],
                             user_id, "starting count saved")
        return {"items": len(movements), "issuesApplied": applied}

    return with_tx(work)


class CorrectionInput(BaseModel):
    reason: Literal["spot_check", "damaged", "found", "miscount_at_delivery", "other"]
    note: str | None = Field(default=None, max_length=255)
    locationId: int
    items: list[CountLine]
    clearUnregistered: bool = False  # spot check of everything at the location: also clears the unregistered bucket (DQ-06)


def save_correction(inp: CorrectionInput, user_id: int, now: datetime | None = None) -> dict:
    """Stock correction (ADJ-02..04): sets each item's current on_hand to the counted value."""
    now = now or now_utc()
    if inp.reason == "other" and not inp.note:
        raise HttpError(400, 'a note is required for reason "other"')
    if inp.clearUnregistered and inp.reason != "spot_check":
        raise HttpError(400, "clearing the unregistered bucket needs a spot check")

    def work(conn: Connection) -> dict:
        targets: dict[int, int] = {}
        for c in inp.items:
            targets[stock_item_id(conn, c.garmentTypeId, c.colorId, c.sizeId, inp.locationId)] = c.qty
        if inp.clearUnregistered:
            targets[unregistered_bucket(conn, inp.locationId)] = 0
        ids = sorted(targets)
        if not ids:
            raise HttpError(400, "nothing to correct")
        movements, log = [], []
        for r in rows(conn, f"SELECT id, on_hand FROM stock_item WHERE id IN ({marks(len(ids))}) ORDER BY id FOR UPDATE", ids):
            to = targets[r["id"]]
            if to == r["on_hand"]:
                continue
            sc = execute(conn, "INSERT INTO stock_correction (stock_item_id, counted, system_qty, reason, note, user_id, at) VALUES (?,?,?,?,?,?,?)",
                         [r["id"], to, r["on_hand"], inp.reason, inp.note, user_id, to_db(now)])
            movements.append(Movement(r["id"], to - r["on_hand"], now, "stock_correction", user_id=user_id, stock_correction_id=sc.lastrowid))
            log.append({"stockItemId": r["id"], "from": r["on_hand"], "to": to})
        apply_movements(conn, movements)
        return {"changed": log}

    return with_tx(work)


def list_corrections(conn: Connection, limit: int = 20) -> list[dict]:
    rs = rows(conn, """SELECT sc.id, sc.at, sc.reason, sc.note, sc.counted, sc.system_qty, u.name AS user_name,
                              g.name AS garment, g.is_system, c.name AS color, s.code AS size, l.code AS location
                         FROM stock_correction sc JOIN app_user u ON u.id = sc.user_id JOIN stock_item si ON si.id = sc.stock_item_id
                         JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
                         JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
                        ORDER BY sc.at DESC, sc.id DESC LIMIT ?""", [limit])
    return [{**r, "at": iso(r["at"])} for r in rs]


def starting_counts(conn: Connection) -> list[dict]:
    rs = rows(conn, """SELECT l.id AS location_id, l.code, sc.as_of, u.name AS entered_by
                         FROM location l LEFT JOIN starting_count sc ON sc.location_id = l.id LEFT JOIN app_user u ON u.id = sc.entered_by
                        ORDER BY l.id""")
    return [{"locationId": r["location_id"], "location": r["code"], "asOf": iso(r["as_of"]), "enteredBy": r["entered_by"]} for r in rs]
