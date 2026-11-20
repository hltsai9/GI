from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.engine import Connection

from ..auth import HttpError
from ..config import config
from ..db import execute, marks, one, rows
from ..timeutil import iso, now_utc, site_day

CLOSE_TO_MIN_FACTOR = 1.5  # TODO: confirm with the lead


def stock_status(on_hand: int, min_qty: int | None) -> str:
    if on_hand < 0:
        return "negative"
    if not min_qty:
        return "not_stocked"
    if on_hand < min_qty:
        return "below_min"
    if on_hand < min_qty * CLOSE_TO_MIN_FACTOR:
        return "close_to_min"
    return "plenty"


def _weekday_issue_rate(conn: Connection, now: datetime) -> dict[int, float]:
    """Average issues per weekday over the last 5 weekdays, per garment type (days of cover)."""
    today = now.astimezone(ZoneInfo(config.SITE_TIMEZONE)).date()
    days: list[str] = []
    i = 1
    while len(days) < 5 and i <= 14:
        d = today - timedelta(days=i)
        if d.isoweekday() <= 5:
            days.append(d.isoformat())
        i += 1
    rs = rows(conn, f"""SELECT si.garment_type_id AS type_id, COUNT(*) AS n FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id
                         WHERE ii.status IN ('applied','before_start') AND ii.issued_day IN ({marks(len(days))})
                         GROUP BY si.garment_type_id""", days)
    return {r["type_id"]: r["n"] / len(days) for r in rs}


def stock_summary(conn: Connection, now: datetime | None = None) -> dict:
    now = now or now_utc()
    day = site_day(now)
    types = rows(conn, "SELECT id, name, plural, icon FROM garment_type WHERE NOT is_system AND active ORDER BY sort")
    by_type_loc = rows(conn, """SELECT si.garment_type_id AS type_id, l.code AS location, SUM(si.on_hand) AS on_hand
                                  FROM stock_item si JOIN location l ON l.id = si.location_id GROUP BY si.garment_type_id, l.code""")
    locations = rows(conn, "SELECT id, code FROM location ORDER BY id")
    rate = _weekday_issue_rate(conn, now)
    delivered = {r["type_id"]: r["n"] for r in rows(conn, """SELECT si.garment_type_id AS type_id, SUM(dl.qty_current) AS n FROM delivery d
        JOIN delivery_line dl ON dl.delivery_id = d.id JOIN stock_item si ON si.id = dl.stock_item_id
        WHERE d.received_day = ? GROUP BY si.garment_type_id""", [day])}
    issued = {r["type_id"]: r["n"] for r in rows(conn, """SELECT si.garment_type_id AS type_id, COUNT(*) AS n FROM issue_import ii
        JOIN stock_item si ON si.id = ii.stock_item_id WHERE ii.issued_day = ? AND ii.status IN ('applied','before_start')
        GROUP BY si.garment_type_id""", [day])}
    totals = []
    for t in types:
        per_loc = {l["code"]: next((r["on_hand"] for r in by_type_loc if r["type_id"] == t["id"] and r["location"] == l["code"]), 0) or 0
                   for l in locations}
        total = sum(per_loc.values())
        r = rate.get(t["id"], 0)
        totals.append({"garmentTypeId": t["id"], "name": t["name"], "plural": t["plural"], "icon": t["icon"], "onHand": total,
                       "byLocation": per_loc, "daysOfCover": round(total / r, 1) if r > 0 else None,
                       "deliveredToday": delivered.get(t["id"], 0), "issuedToday": issued.get(t["id"], 0)})
    unregistered = rows(conn, """SELECT l.code AS location, si.on_hand FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id
                                   JOIN location l ON l.id = si.location_id WHERE g.is_system ORDER BY l.id""")
    unreg_today = one(conn, """SELECT COUNT(*) AS n FROM issue_import WHERE issued_day = ? AND quality = 'incomplete'
                                 AND status IN ('applied','before_start')""", [day])
    reorder = rows(conn, """SELECT si.id, g.name AS garment, g.icon, c.name AS color, s.code AS size, l.code AS location, si.on_hand, si.min_qty
                              FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
                              JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
                             WHERE NOT g.is_system AND si.min_qty IS NOT NULL AND si.on_hand < si.min_qty
                             ORDER BY si.on_hand / si.min_qty, si.id LIMIT 5""")
    negative = one(conn, "SELECT COUNT(*) AS n FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id WHERE si.on_hand < 0 AND NOT g.is_system")
    below = one(conn, """SELECT COUNT(*) AS n FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id
                          WHERE NOT g.is_system AND si.min_qty IS NOT NULL AND si.on_hand < si.min_qty""")
    return {
        "asOf": iso(now), "day": day, "totals": totals,
        "unregistered": [{"location": u["location"], "onHand": u["on_hand"], "sinceLastCheck": max(0, -u["on_hand"])} for u in unregistered],
        "unregisteredToday": unreg_today["n"] if unreg_today else 0,  # type: ignore[index]
        "reorder": [{**r, "status": stock_status(r["on_hand"], r["min_qty"])} for r in reorder],
        "belowMinCount": below["n"] if below else 0,  # type: ignore[index]
        "negativeCount": negative["n"] if negative else 0,  # type: ignore[index]
    }


def stock_grid(conn: Connection, garment_type_id: int, location_id: int) -> dict:
    sizes = rows(conn, "SELECT id, code FROM size WHERE active AND NOT is_system ORDER BY sort")
    colors = rows(conn, "SELECT id, name FROM color WHERE active AND NOT is_system ORDER BY sort")
    items = rows(conn, "SELECT id, color_id, size_id, on_hand, min_qty FROM stock_item WHERE garment_type_id = ? AND location_id = ?",
                 [garment_type_id, location_id])
    by_key = {(i["color_id"], i["size_id"]): i for i in items}
    out_rows = []
    for s in sizes:
        cells = []
        for c in colors:
            it = by_key.get((c["id"], s["id"]))
            cells.append({"stockItemId": it["id"], "colorId": c["id"], "onHand": it["on_hand"], "min": it["min_qty"],
                          "status": stock_status(it["on_hand"], it["min_qty"])} if it else
                         {"stockItemId": None, "colorId": c["id"], "onHand": 0, "min": None, "status": "not_stocked"})
        out_rows.append({"sizeId": s["id"], "size": s["code"], "cells": cells})
    return {"sizes": sizes, "colors": colors, "rows": out_rows}


def stock_item_detail(conn: Connection, item_id: int, now: datetime | None = None) -> dict:
    now = now or now_utc()
    it = one(conn, """SELECT si.id, si.on_hand, si.min_qty, g.name AS garment, c.name AS color, s.code AS size, l.code AS location
                        FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
                        JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id WHERE si.id = ?""", [item_id])
    if not it:
        raise HttpError(404, "stock item not found")
    issued_today = one(conn, """SELECT COUNT(*) AS n FROM issue_import WHERE stock_item_id = ? AND issued_day = ?
                                  AND status IN ('applied','before_start')""", [item_id, site_day(now)])
    last = one(conn, """SELECT d.received_at, dl.qty_current AS qty FROM delivery_line dl JOIN delivery d ON d.id = dl.delivery_id
                         WHERE dl.stock_item_id = ? AND dl.qty_current > 0 ORDER BY d.received_at DESC LIMIT 1""", [item_id])
    return {**it, "status": stock_status(it["on_hand"], it["min_qty"]), "issuedToday": issued_today["n"] if issued_today else 0,  # type: ignore[index]
            "lastDelivery": {"at": iso(last["received_at"]), "qty": last["qty"]} if last else None}


def set_minimum(conn: Connection, item_id: int, min_qty: int | None, user_id: int) -> dict:
    import json

    before = one(conn, "SELECT min_qty FROM stock_item WHERE id = ?", [item_id])
    if not before:
        raise HttpError(404, "stock item not found")
    execute(conn, "UPDATE stock_item SET min_qty = ? WHERE id = ?", [min_qty, item_id])
    execute(conn, "INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json) VALUES (?, 'stock_item.min_qty', ?, 'update', ?, ?)",
            [user_id, str(item_id), json.dumps({"min": before["min_qty"]}), json.dumps({"min": min_qty})])
    return {"id": item_id, "min": min_qty}
