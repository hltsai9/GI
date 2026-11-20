from __future__ import annotations

from datetime import datetime, timedelta

from pydantic import BaseModel, Field
from sqlalchemy.engine import Connection

from ..auth import HttpError
from ..db import connect, execute, marks, one, rows, with_tx
from ..ledger import Movement, apply_movements
from ..stock_items import stock_item_id
from ..timeutil import from_db, iso, now_utc, parse_iso, site_day, to_db

DEFAULT_MIN = 2  # RCV-06 (TODO: confirm with the lead)


class DeliveryLine(BaseModel):
    garmentTypeId: int
    colorId: int
    sizeId: int
    locationId: int
    qty: int = Field(gt=0)


class DeliveryInput(BaseModel):
    receivedAt: str | None = None
    note: str | None = Field(default=None, max_length=255)
    lines: list[DeliveryLine] = Field(min_length=1)


def _assert_real_values(conn: Connection, lines: list[DeliveryLine]) -> None:
    for l in lines:
        ok = one(conn, """SELECT 1 FROM garment_type g, color c, size s, location l
                          WHERE g.id = ? AND c.id = ? AND s.id = ? AND l.id = ? AND NOT g.is_system AND NOT c.is_system AND NOT s.is_system
                            AND g.active AND c.active AND s.active""", [l.garmentTypeId, l.colorId, l.sizeId, l.locationId])
        if not ok:
            raise HttpError(400, "unknown or inactive garment type, color, size or location")


def post_delivery(inp: DeliveryInput, idempotency_key: str, user_id: int, now: datetime | None = None) -> dict:
    """Posts a delivery (RCV-05). The Idempotency-Key makes a retried post return the first result."""
    now = now or now_utc()
    with connect() as conn:
        existing = one(conn, "SELECT id FROM delivery WHERE idempotency_key = ?", [idempotency_key])
    if existing:
        return {"id": existing["id"], "duplicate": True}
    received_at = parse_iso(inp.receivedAt) if inp.receivedAt else now
    if received_at > now + timedelta(minutes=5):
        raise HttpError(400, "delivery time is in the future")
    if now - received_at > timedelta(days=2):
        raise HttpError(400, "a delivery can be back-dated by at most one day (RCV-08)")

    merged: dict[tuple, DeliveryLine] = {}  # RCV-02: merge lines for the same item
    for l in inp.lines:
        k = (l.garmentTypeId, l.colorId, l.sizeId, l.locationId)
        merged[k] = merged[k].model_copy(update={"qty": merged[k].qty + l.qty}) if k in merged else l

    def work(conn: Connection) -> dict:
        _assert_real_values(conn, list(merged.values()))
        d = execute(conn, "INSERT INTO delivery (received_at, received_day, created_by, note, idempotency_key) VALUES (?,?,?,?,?)",
                    [to_db(received_at), site_day(received_at), user_id, inp.note, idempotency_key])
        movements, total = [], 0
        for l in merged.values():
            item = stock_item_id(conn, l.garmentTypeId, l.colorId, l.sizeId, l.locationId, DEFAULT_MIN)
            line = execute(conn, "INSERT INTO delivery_line (delivery_id, stock_item_id, qty_original, qty_current) VALUES (?,?,?,?)",
                           [d.lastrowid, item, l.qty, l.qty])
            movements.append(Movement(item, l.qty, received_at, "delivery", user_id=user_id, delivery_line_id=line.lastrowid))
            total += l.qty
        apply_movements(conn, movements)
        return {"id": d.lastrowid, "duplicate": False, "total": total, "lines": len(merged)}

    return with_tx(work)


def list_deliveries(conn: Connection, limit: int = 20) -> list[dict]:
    ds = rows(conn, """SELECT d.id, d.received_at, d.status, d.note, u.name AS created_by_name
                         FROM delivery d JOIN app_user u ON u.id = d.created_by ORDER BY d.received_at DESC, d.id DESC LIMIT ?""", [limit])
    if not ds:
        return []
    ids = [d["id"] for d in ds]
    lines = rows(conn, f"""SELECT dl.id, dl.delivery_id, dl.stock_item_id, dl.qty_original, dl.qty_current,
                                  g.name AS garment, g.unit, g.icon, c.name AS color, s.code AS size, l.code AS location
                             FROM delivery_line dl JOIN stock_item si ON si.id = dl.stock_item_id
                             JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
                             JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
                            WHERE dl.delivery_id IN ({marks(len(ids))}) ORDER BY dl.id""", ids)
    corrections = rows(conn, f"""SELECT dc.delivery_id, dc.at, dc.is_void, dc.total_delta, u.name AS user_name, dc.note
                                   FROM delivery_correction dc JOIN app_user u ON u.id = dc.user_id
                                  WHERE dc.delivery_id IN ({marks(len(ids))}) ORDER BY dc.at""", ids)
    return [{
        "id": d["id"], "receivedAt": iso(d["received_at"]), "status": d["status"], "note": d["note"], "createdBy": d["created_by_name"],
        "lines": [l for l in lines if l["delivery_id"] == d["id"]],
        "corrections": [{"at": iso(c["at"]), "isVoid": bool(c["is_void"]), "totalDelta": c["total_delta"], "by": c["user_name"], "note": c["note"]}
                        for c in corrections if c["delivery_id"] == d["id"]],
    } for d in ds]


class CorrectionLine(BaseModel):
    lineId: int
    qty: int = Field(ge=0)


class CorrectionInput(BaseModel):
    void: bool = False
    note: str | None = Field(default=None, max_length=255)
    lines: list[CorrectionLine] = []


def correct_delivery(delivery_id: int, inp: CorrectionInput, user_id: int, now: datetime | None = None) -> dict:
    """Corrects or voids a delivery (HIS-04/05): applies only the difference."""
    now = now or now_utc()

    def work(conn: Connection) -> dict:
        d = one(conn, "SELECT id, received_at, status FROM delivery WHERE id = ? FOR UPDATE", [delivery_id])
        if not d:
            raise HttpError(404, "delivery not found")
        if d["status"] == "voided":
            raise HttpError(409, "delivery is already voided")
        received_at = from_db(d["received_at"])
        lines = rows(conn, """SELECT dl.id, dl.stock_item_id, dl.qty_current, si.location_id FROM delivery_line dl
                                JOIN stock_item si ON si.id = dl.stock_item_id WHERE dl.delivery_id = ? FOR UPDATE""", [delivery_id])
        # A delivery before a location's starting count is already part of that count (rule 7.8).
        for l in lines:
            sc = one(conn, "SELECT as_of FROM starting_count WHERE location_id = ?", [l["location_id"]])
            if sc and received_at < from_db(sc["as_of"]):
                raise HttpError(409, "this delivery was received before the starting count and is already included in it")
        target = {l["id"]: (0 if inp.void else l["qty_current"]) for l in lines}
        for c in inp.lines:
            if c.lineId not in target:
                raise HttpError(400, f"line {c.lineId} is not part of delivery {delivery_id}")
            if not inp.void:
                target[c.lineId] = c.qty
        changes = [{**l, "delta": target[l["id"]] - l["qty_current"]} for l in lines if target[l["id"]] != l["qty_current"]]
        if not changes:
            raise HttpError(400, "nothing to change")
        total = sum(l["delta"] for l in changes)
        voided = all(target[l["id"]] == 0 for l in lines)
        dc = execute(conn, "INSERT INTO delivery_correction (delivery_id, user_id, at, is_void, total_delta, note) VALUES (?,?,?,?,?,?)",
                     [delivery_id, user_id, to_db(now), voided, total, inp.note])
        for l in changes:
            execute(conn, "UPDATE delivery_line SET qty_current = ? WHERE id = ?", [target[l["id"]], l["id"]])
        execute(conn, "UPDATE delivery SET status = ? WHERE id = ?", ["voided" if voided else "corrected", delivery_id])
        # The correction fixes what arrived, so it is dated with the delivery.
        apply_movements(conn, [Movement(l["stock_item_id"], l["delta"], received_at, "delivery_correction", user_id=user_id,
                                        delivery_line_id=l["id"], delivery_correction_id=dc.lastrowid) for l in changes])
        return {"id": dc.lastrowid, "totalDelta": total, "voided": voided}

    return with_tx(work)
