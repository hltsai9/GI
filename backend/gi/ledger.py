"""The only way stock changes (BUILD_PLAN §2)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.engine import Connection

from .db import execute, marks, rows
from .timeutil import site_day, to_db


@dataclass
class Movement:
    stock_item_id: int
    delta: int
    at: datetime  # when it happened (aware)
    kind: str  # starting_count | delivery | delivery_correction | issue | issue_correction | stock_correction
    user_id: int | None = None  # set for user actions; None for the Oracle import
    delivery_line_id: int | None = None
    delivery_correction_id: int | None = None
    issue_import_id: int | None = None
    stock_correction_id: int | None = None


def apply_movements(conn: Connection, movements: list[Movement]) -> dict[int, int]:
    """Locks the affected stock items in id order, appends one ledger entry per movement and updates
    on_hand, inside the caller's transaction. Returns the new on_hand per stock item."""
    balances: dict[int, int] = {}
    if not movements:
        return balances
    ids = sorted({m.stock_item_id for m in movements})
    for r in rows(conn, f"SELECT id, on_hand FROM stock_item WHERE id IN ({marks(len(ids))}) ORDER BY id FOR UPDATE", ids):
        balances[r["id"]] = r["on_hand"]
    for m in movements:
        if m.stock_item_id not in balances:
            raise ValueError(f"stock item {m.stock_item_id} not found")
        before = balances[m.stock_item_id]
        after = before + m.delta
        execute(conn, """INSERT INTO ledger_entry (stock_item_id, at, day, kind, delta, qty_before, qty_after, source, user_id,
                 delivery_line_id, delivery_correction_id, issue_import_id, stock_correction_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [m.stock_item_id, to_db(m.at), site_day(m.at), m.kind, m.delta, before, after,
                 "user" if m.user_id else "oracle_import", m.user_id,
                 m.delivery_line_id, m.delivery_correction_id, m.issue_import_id, m.stock_correction_id])
        balances[m.stock_item_id] = after
    for item_id, on_hand in balances.items():
        execute(conn, "UPDATE stock_item SET on_hand = ? WHERE id = ?", [on_hand, item_id])
    return balances


def invariant_violations(conn: Connection) -> list[dict]:
    """Items whose on_hand differs from the sum of their ledger entries (should always be empty)."""
    return rows(conn, """SELECT s.id, s.on_hand, COALESCE(SUM(l.delta), 0) AS ledger_sum
                           FROM stock_item s LEFT JOIN ledger_entry l ON l.stock_item_id = s.id
                          GROUP BY s.id, s.on_hand
                         HAVING s.on_hand <> COALESCE(SUM(l.delta), 0)""")
