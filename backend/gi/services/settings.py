from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel
from sqlalchemy.engine import Connection

from ..auth import HttpError
from ..db import execute, one, rows, with_tx
from ..importing.importer import reclassify
from ..timeutil import iso, now_utc, to_db


def count_unregistered(conn: Connection) -> bool:
    """Whether issues of unregistered barcodes (GOWN / OTHER / OTHER) count in the issued numbers."""
    r = one(conn, "SELECT value FROM app_setting WHERE name = 'count_unregistered_issues'")
    return not r or r["value"] != "false"


def set_count_unregistered(value: bool, user_id: int) -> dict:
    def work(conn: Connection) -> dict:
        execute(conn, """INSERT INTO app_setting (name, value, updated_by, updated_at) VALUES ('count_unregistered_issues', ?, ?, ?)
                 ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)""",
                ["true" if value else "false", user_id, to_db(now_utc())])
        _audit(conn, user_id, "app_setting", None, "update", None, {"count_unregistered_issues": value})
        return {"countUnregistered": value}

    return with_tx(work)


def meta(conn: Connection) -> dict:
    return {
        "countUnregistered": count_unregistered(conn),
        "types": rows(conn, "SELECT id, code, name, plural, icon FROM garment_type WHERE active AND NOT is_system ORDER BY sort"),
        "colors": rows(conn, "SELECT id, name, active FROM color WHERE NOT is_system ORDER BY sort"),
        "sizes": rows(conn, "SELECT id, code, active FROM size WHERE NOT is_system ORDER BY sort"),
        "locations": rows(conn, "SELECT id, code, name FROM location ORDER BY id"),
    }


Kind = Literal["color", "size"]
_TABLE = {"color": ("color", "name"), "size": ("size", "code")}


def _audit(conn: Connection, user_id: int | None, entity: str, entity_id: int | None, action: str, before, after) -> None:
    execute(conn, "INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json) VALUES (?,?,?,?,?,?)",
            [user_id, entity, None if entity_id is None else str(entity_id), action,
             None if before is None else json.dumps(before), None if after is None else json.dumps(after)])


def add_value(kind: Kind, value: str, user_id: int) -> dict:
    """SET-01: add a size or color at the end of the list (or restore it if it exists hidden)."""
    v = value.strip()
    if not v or len(v) > 32:
        raise HttpError(400, "value must be 1–32 characters")
    t, col = _TABLE[kind]

    def work(conn: Connection) -> dict:
        existing = one(conn, f"SELECT id, active, is_system FROM {t} WHERE {col} = ?", [v])
        if existing and existing["is_system"]:
            raise HttpError(400, "that name is reserved")
        if existing and existing["active"]:
            raise HttpError(409, f'{kind} "{v}" already exists')
        if existing:
            execute(conn, f"UPDATE {t} SET active = TRUE WHERE id = ?", [existing["id"]])
            _audit(conn, user_id, t, existing["id"], "restore", None, {col: v})
            return {"id": existing["id"], "restored": True}
        mx = one(conn, f"SELECT COALESCE(MAX(sort), 0) AS m FROM {t} WHERE NOT is_system")
        r = execute(conn, f"INSERT INTO {t} ({col}, sort) VALUES (?, ?)", [v, int(mx["m"]) + 1])  # type: ignore[index]
        _audit(conn, user_id, t, r.lastrowid, "create", None, {col: v})
        return {"id": r.lastrowid, "restored": False}

    return with_tx(work)


def set_active(kind: Kind, item_id: int, active: bool, user_id: int) -> dict:
    """SET-03: removing only hides the value; stock and history are kept."""
    t, _ = _TABLE[kind]

    def work(conn: Connection) -> dict:
        r = execute(conn, f"UPDATE {t} SET active = ? WHERE id = ? AND NOT is_system", [active, item_id])
        if not r.rowcount:
            raise HttpError(404, f"{kind} not found")
        _audit(conn, user_id, t, item_id, "restore" if active else "deactivate", None, None)
        return {"id": item_id, "active": active}

    return with_tx(work)


def reorder_sizes(ids: list[int], user_id: int) -> dict:
    """SET-04: new display order for sizes."""
    def work(conn: Connection) -> dict:
        for i, size_id in enumerate(ids):
            execute(conn, "UPDATE size SET sort = ? WHERE id = ? AND NOT is_system", [i + 1, size_id])
        _audit(conn, user_id, "size", None, "update", None, {"order": ids})
        return {"ok": True}

    return with_tx(work)


# ---- Oracle value mapping (MAP-*)
_TARGET = {"SUIT_TYPE": ("garment_type_id", "garment_type"), "SUIT_COLOR": ("color_id", "color"),
           "SUIT_SIZE": ("size_id", "size"), "SUIT_LEVEL": ("location_id", "location")}
_ISSUE_COLUMN = {"SUIT_TYPE": "suit_type", "SUIT_COLOR": "suit_color", "SUIT_SIZE": "suit_size", "SUIT_LEVEL": "suit_level"}


def oracle_values(conn: Connection) -> list[dict]:
    rs = rows(conn, """SELECT m.id, m.oracle_column, m.oracle_value, m.is_ignored, m.row_count, m.first_seen, m.last_seen,
                              COALESCE(g.name, c.name, s.code, l.code) AS gi_value,
                              COALESCE(m.garment_type_id, m.color_id, m.size_id, m.location_id) AS gi_id
                         FROM oracle_value_map m LEFT JOIN garment_type g ON g.id = m.garment_type_id LEFT JOIN color c ON c.id = m.color_id
                         LEFT JOIN size s ON s.id = m.size_id LEFT JOIN location l ON l.id = m.location_id
                        ORDER BY (COALESCE(m.garment_type_id, m.color_id, m.size_id, m.location_id) IS NULL AND NOT m.is_ignored) DESC,
                                 m.oracle_column, m.oracle_value""")
    held = rows(conn, """SELECT 'SUIT_TYPE' c, suit_type v, COUNT(*) n FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_type
                         UNION ALL SELECT 'SUIT_COLOR', suit_color, COUNT(*) FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_color
                         UNION ALL SELECT 'SUIT_SIZE', suit_size, COUNT(*) FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_size
                         UNION ALL SELECT 'SUIT_LEVEL', suit_level, COUNT(*) FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_level""")
    held_by = {(h["c"], h["v"]): h["n"] for h in held}
    return [{**r, "first_seen": iso(r["first_seen"]), "last_seen": iso(r["last_seen"]),
             "mapped": r["gi_id"] is not None or bool(r["is_ignored"]),
             "heldRows": held_by.get((r["oracle_column"], r["oracle_value"]), 0)} for r in rs]


class MappingInput(BaseModel):
    targetId: int | None = None
    ignore: bool = False


def set_mapping(map_id: int, inp: MappingInput, user_id: int) -> dict:
    """Maps (or ignores) one Oracle value, then re-classifies held rows that use it (MAP-03).
    Already applied rows are not re-booked: changing an existing mapping affects new rows only."""
    def work(conn: Connection) -> dict:
        m = one(conn, "SELECT oracle_column, oracle_value FROM oracle_value_map WHERE id = ? FOR UPDATE", [map_id])
        if not m:
            raise HttpError(404, "value not found")
        fk, table = _TARGET[m["oracle_column"]]
        target_id = None if inp.ignore else inp.targetId
        if not inp.ignore and target_id is None:
            raise HttpError(400, "choose a GI value or Ignore")
        if target_id is not None and not one(conn, f"SELECT 1 FROM {table} WHERE id = ?", [target_id]):
            raise HttpError(400, "unknown GI value")
        execute(conn, f"""UPDATE oracle_value_map SET garment_type_id = NULL, color_id = NULL, size_id = NULL, location_id = NULL,
                            {fk} = ?, is_ignored = ?, updated_by = ?, updated_at = ? WHERE id = ?""",
                [target_id, inp.ignore, user_id, to_db(now_utc()), map_id])
        _audit(conn, user_id, "oracle_value_map", map_id, "update", None,
               {"column": m["oracle_column"], "value": m["oracle_value"], "targetId": target_id, "ignore": inp.ignore})
        col = _ISSUE_COLUMN[m["oracle_column"]]
        tally: dict[str, int] = {}
        released = reclassify(conn, f"status = 'held_unmapped' AND {col} = ?", [m["oracle_value"]],
                              user_id, f"mapped {m['oracle_column']} {m['oracle_value']}", tally)
        # A row is released only when all four of its values are mapped (or one is ignored); rows that use
        # this value but wait for another one stay held.
        still = one(conn, f"SELECT COUNT(*) AS n FROM issue_import WHERE status = 'held_unmapped' AND {col} = ?", [m["oracle_value"]])
        return {"id": map_id, "reclassified": released, "byStatus": tally, "stillHeld": still["n"] if still else 0}

    return with_tx(work)


# ---- data quality (DQ-05)
def unregistered_barcodes(conn: Connection) -> list[dict]:
    """One line per unregistered barcode. first_seen / last_seen are scan times (INSERT_TIME converted to UTC; the
    page shows them in Phoenix time); last_insert_time is the latest INSERT_TIME exactly as in Oracle (Taipei
    time), to search for in an Oracle export."""
    rs = rows(conn, """SELECT ii.suit_barcode AS barcode, COUNT(*) AS times, MIN(ii.issued_at) AS first_seen, MAX(ii.issued_at) AS last_seen,
                              MAX(ii.insert_time) AS last_insert_time,
                              GROUP_CONCAT(DISTINCT ii.suit_level ORDER BY ii.suit_level) AS locations
                         FROM issue_import ii WHERE ii.quality = 'incomplete' GROUP BY ii.suit_barcode ORDER BY times DESC, barcode""")
    return [{**r, "first_seen": iso(r["first_seen"]), "last_seen": iso(r["last_seen"]),
             "last_insert_time": r["last_insert_time"].strftime("%Y-%m-%d %H:%M:%S") if r["last_insert_time"] else None} for r in rs]


def conflicting_barcodes(conn: Connection) -> list[dict]:
    """Barcodes issued with more than one SUIT_TYPE / SUIT_COLOR / SUIT_SIZE combination. A barcode means
    one garment, so these show suit master problems (a barcode re-used or re-labelled). Unregistered rows
    (GOWN / OTHER / OTHER) are included: a barcode that is sometimes unregistered and sometimes not
    shows a registration that came later. Values are compared exactly (case and spaces)."""
    rs = rows(conn, """SELECT ii.suit_barcode AS barcode, ii.suit_type, ii.suit_color, ii.suit_size, ii.quality,
                              COUNT(*) AS times, MIN(ii.insert_time) AS first_insert_time, MAX(ii.insert_time) AS last_insert_time,
                              MIN(ii.issued_at) AS first_seen, MAX(ii.issued_at) AS last_seen,
                              GROUP_CONCAT(DISTINCT ii.suit_level ORDER BY ii.suit_level) AS locations
                         FROM issue_import ii
                         JOIN (SELECT suit_barcode FROM issue_import GROUP BY suit_barcode
                                HAVING COUNT(DISTINCT BINARY suit_type, BINARY suit_color, BINARY suit_size) > 1) x
                           ON x.suit_barcode = ii.suit_barcode
                        GROUP BY ii.suit_barcode, BINARY ii.suit_type, BINARY ii.suit_color, BINARY ii.suit_size
                        ORDER BY ii.suit_barcode, last_insert_time""")
    out: dict[str, dict] = {}
    for r in rs:
        b = out.setdefault(r["barcode"], {"barcode": r["barcode"], "times": 0, "combinations": []})
        b["times"] += r["times"]
        b["combinations"].append({
            "type": r["suit_type"], "color": r["suit_color"], "size": r["suit_size"], "unregistered": r["quality"] == "incomplete",
            "times": r["times"], "first_seen": iso(r["first_seen"]), "last_seen": iso(r["last_seen"]),
            "first_insert_time": r["first_insert_time"].strftime("%Y-%m-%d %H:%M:%S"),
            "last_insert_time": r["last_insert_time"].strftime("%Y-%m-%d %H:%M:%S"), "locations": r["locations"]})
    return sorted(out.values(), key=lambda b: (-b["times"], b["barcode"]))


def data_quality(conn: Connection, days: int) -> dict:
    per_day = rows(conn, """SELECT issued_day AS day, l.code AS location, SUM(quality = 'incomplete') AS incomplete, COUNT(*) AS total
                              FROM issue_import ii LEFT JOIN location l ON l.id = ii.location_id
                             WHERE issued_day >= CURDATE() - INTERVAL ? DAY AND status <> 'ignored'
                             GROUP BY issued_day, l.code ORDER BY issued_day""", [days])
    return {"perDay": [{**r, "day": r["day"].isoformat()} for r in per_day], "unregisteredBarcodes": unregistered_barcodes(conn),
            "conflictingBarcodes": conflicting_barcodes(conn),
            "patterns": rows(conn, "SELECT id, suit_type, suit_color, suit_size, active FROM dq_pattern ORDER BY id")}
