from __future__ import annotations

from sqlalchemy.engine import Connection

from .db import execute, one


def stock_item_id(conn: Connection, garment_type_id: int, color_id: int, size_id: int, location_id: int,
                  default_min: int | None = None) -> int:
    """Finds or lazily creates the stock item for a combination (BUILD_PLAN §2)."""
    execute(conn, """INSERT INTO stock_item (garment_type_id, color_id, size_id, location_id, min_qty) VALUES (?,?,?,?,?)
                     ON DUPLICATE KEY UPDATE min_qty = COALESCE(min_qty, VALUES(min_qty))""",
            [garment_type_id, color_id, size_id, location_id, default_min])
    r = one(conn, "SELECT id FROM stock_item WHERE garment_type_id = ? AND color_id = ? AND size_id = ? AND location_id = ?",
            [garment_type_id, color_id, size_id, location_id])
    return r["id"]  # type: ignore[index]


_system_ids: dict[str, int] | None = None


def unregistered_ids(conn: Connection) -> dict[str, int]:
    """Ids of the hidden "Unregistered" type, color and size (DQ-03)."""
    global _system_ids
    if _system_ids is None:
        _system_ids = {
            "type": one(conn, "SELECT id FROM garment_type WHERE is_system LIMIT 1")["id"],  # type: ignore[index]
            "color": one(conn, "SELECT id FROM color WHERE is_system LIMIT 1")["id"],  # type: ignore[index]
            "size": one(conn, "SELECT id FROM size WHERE is_system LIMIT 1")["id"],  # type: ignore[index]
        }
    return _system_ids


def unregistered_bucket(conn: Connection, location_id: int) -> int:
    """The unregistered bucket for a location (one stock item per location)."""
    u = unregistered_ids(conn)
    return stock_item_id(conn, u["type"], u["color"], u["size"], location_id)


def reset_caches() -> None:
    global _system_ids
    _system_ids = None
