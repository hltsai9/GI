from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel
from sqlalchemy.engine import Connection

from ..auth import HttpError
from ..db import execute, marks, one, rows, with_tx
from ..importing.importer import reclassify
from ..timeutil import iso, now_utc, to_db


class ExcludeInput(BaseModel):
    barcode: str
    excluded: bool
    note: str | None = None


def set_barcode_excluded(inp: ExcludeInput, user_id: int) -> dict:
    """Leaves one unregistered barcode out of the issued numbers (or counts it again). Its issues are
    re-classified: left out they become 'ignored' and their stock movements are reversed."""
    def work(conn: Connection) -> dict:
        if not one(conn, "SELECT 1 AS x FROM issue_import WHERE suit_barcode = ? AND quality = 'incomplete' LIMIT 1", [inp.barcode]):
            raise HttpError(404, "no unregistered issues with that barcode")
        if inp.excluded:
            execute(conn, """INSERT INTO excluded_barcode (suit_barcode, note, excluded_by, excluded_at) VALUES (?,?,?,?)
                             ON DUPLICATE KEY UPDATE note = VALUES(note)""", [inp.barcode, (inp.note or None), user_id, to_db(now_utc())])
        else:
            execute(conn, "DELETE FROM excluded_barcode WHERE suit_barcode = ?", [inp.barcode])
        _audit(conn, user_id, "excluded_barcode", None, "update", None, {"barcode": inp.barcode, "excluded": inp.excluded, "note": inp.note})
        tally: dict[str, int] = {}
        changed = reclassify(conn, "suit_barcode = ? AND quality = 'incomplete'", [inp.barcode], user_id,
                             f"barcode {'left out' if inp.excluded else 'counted again'}", tally)
        return {"barcode": inp.barcode, "excluded": inp.excluded, "changed": changed, "byStatus": tally}

    return with_tx(work)


def meta(conn: Connection) -> dict:
    return {
        "types": rows(conn, "SELECT id, code, name, plural, unit, icon FROM garment_type WHERE active AND NOT is_system ORDER BY sort"),
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
def unregistered_barcodes(conn: Connection, limit: int | None = None, find: str | None = None) -> list[dict]:
    """One line per unregistered barcode, most issued first (`limit`: only the first ones; `find`: barcodes
    containing that text). first_seen / last_seen are scan times in UTC; last_insert_time is the latest INSERT_TIME
    exactly as in Oracle (Phoenix local time), to search for in an Oracle export."""
    where, params = "ii.quality = 'incomplete'", []
    if find:
        where += " AND ii.suit_barcode LIKE ?"
        params.append("%" + find.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    rs = rows(conn, f"""SELECT ii.suit_barcode AS barcode, COUNT(*) AS times, MIN(ii.issued_at) AS first_seen, MAX(ii.issued_at) AS last_seen,
                               MAX(ii.insert_time) AS last_insert_time,
                               GROUP_CONCAT(DISTINCT ii.suit_level ORDER BY ii.suit_level) AS locations,
                               MAX(e.suit_barcode IS NOT NULL) AS excluded, MAX(e.note) AS excluded_note
                          FROM issue_import ii LEFT JOIN excluded_barcode e ON e.suit_barcode = ii.suit_barcode
                         WHERE {where} GROUP BY ii.suit_barcode ORDER BY times DESC, barcode {'LIMIT ' + str(int(limit)) if limit else ''}""", params)
    return [{**r, "excluded": bool(r["excluded"]), "first_seen": iso(r["first_seen"]), "last_seen": iso(r["last_seen"]),
             "last_insert_time": r["last_insert_time"].strftime("%Y-%m-%d %H:%M:%S") if r["last_insert_time"] else None} for r in rs]


def _conflict_candidates(conn: Connection) -> list[str]:
    """Barcodes seen with more than one type / color / size: from the issues themselves (read from the
    ix_issue_barcode_values index only) and from rows of the same scan that were recorded as conflicts."""
    found = {r["b"] for r in rows(conn, """SELECT suit_barcode AS b FROM issue_import GROUP BY suit_barcode
                                            HAVING COUNT(DISTINCT BINARY suit_type, BINARY suit_color, BINARY suit_size) > 1""")}
    found |= {r["b"] for r in rows(conn, """SELECT DISTINCT ii.suit_barcode AS b FROM issue_import_conflict k JOIN issue_import ii ON ii.id = k.issue_import_id
                                             WHERE BINARY k.suit_type <> BINARY ii.suit_type OR BINARY k.suit_color <> BINARY ii.suit_color
                                                OR BINARY k.suit_size <> BINARY ii.suit_size""")}
    return sorted(found)


def conflicting_barcodes(conn: Connection, limit: int | None = None) -> list[dict]:
    """Barcodes seen with more than one SUIT_TYPE / SUIT_COLOR / SUIT_SIZE combination. A barcode means one
    garment, so these show suit master problems (a barcode re-used or re-labelled). Includes rows that were not
    counted because the same barcode and INSERT_TIME was already imported with other values (same scan,
    issue_import_conflict; "notCounted"). Unregistered rows (GOWN / OTHER / OTHER) are included: a barcode
    that is sometimes unregistered and sometimes not shows a registration that came later. Values are compared
    exactly (case and spaces). The details are read only for the candidate barcodes, so the cost stays small
    however many issues there are. `limit`: only the barcodes with the most issues."""
    out: dict[str, dict] = {}
    cands = _conflict_candidates(conn)
    for i in range(0, len(cands), 500):
        chunk = cands[i:i + 500]
        ph = marks(len(chunk))
        seen = f"""SELECT ii.suit_barcode, ii.suit_type, ii.suit_color, ii.suit_size, ii.suit_level, ii.quality, ii.insert_time,
                          ii.issued_at, 1 AS times, 0 AS not_counted FROM issue_import ii WHERE ii.suit_barcode IN ({ph})
                   UNION ALL
                   SELECT ii.suit_barcode, k.suit_type, k.suit_color, k.suit_size, k.suit_level,
                          IF((k.suit_type, k.suit_color, k.suit_size) IN (SELECT suit_type, suit_color, suit_size FROM dq_pattern), 'incomplete', 'complete'),
                          ii.insert_time, ii.issued_at, k.times, 1
                     FROM issue_import_conflict k JOIN issue_import ii ON ii.id = k.issue_import_id WHERE ii.suit_barcode IN ({ph})"""
        rs = rows(conn, f"""SELECT s.suit_barcode AS barcode, s.suit_type, s.suit_color, s.suit_size, MAX(s.quality) AS quality,
                                   SUM(s.times) AS times, MAX(s.not_counted) AS not_counted, MIN(s.not_counted) AS all_not_counted,
                                   MIN(s.insert_time) AS first_insert_time, MAX(s.insert_time) AS last_insert_time,
                                   MIN(s.issued_at) AS first_seen, MAX(s.issued_at) AS last_seen,
                                   GROUP_CONCAT(DISTINCT s.suit_level ORDER BY s.suit_level) AS locations
                              FROM ({seen}) s
                             GROUP BY s.suit_barcode, BINARY s.suit_type, BINARY s.suit_color, BINARY s.suit_size
                             ORDER BY s.suit_barcode, last_insert_time, not_counted""", chunk + chunk)
        for r in rs:
            b = out.setdefault(r["barcode"], {"barcode": r["barcode"], "times": 0, "combinations": []})
            b["times"] += int(r["times"])
            b["combinations"].append({
                "type": r["suit_type"], "color": r["suit_color"], "size": r["suit_size"], "unregistered": r["quality"] == "incomplete",
                # True when every row of this version had the same barcode and INSERT_TIME as another version (not counted).
                "notCounted": bool(r["all_not_counted"]),
                "times": int(r["times"]), "first_seen": iso(r["first_seen"]), "last_seen": iso(r["last_seen"]),
                "first_insert_time": r["first_insert_time"].strftime("%Y-%m-%d %H:%M:%S"),
                "last_insert_time": r["last_insert_time"].strftime("%Y-%m-%d %H:%M:%S"), "locations": r["locations"]})
    # A barcode found only through a level difference has a single type/color/size: not a conflict here.
    result = sorted((b for b in out.values() if len(b["combinations"]) > 1), key=lambda b: (-b["times"], b["barcode"]))
    return result[:limit] if limit else result


def waiting_scans(conn: Connection, limit: int | None = 100) -> list[dict]:
    """Scans held until the barcode master can decide: several rows with other values (held_conflict), or an
    empty value it could not fill (held_missing). Each with the versions read from Oracle ('' = empty)."""
    rs = rows(conn, f"""SELECT id, suit_barcode AS barcode, insert_time, suit_type, suit_color, suit_size, suit_level, missing_values, status
                          FROM issue_import WHERE status IN ('held_conflict', 'held_missing')
                         ORDER BY insert_time DESC, suit_barcode {'LIMIT ' + str(int(limit)) if limit else ''}""")
    alts: dict[int, list[dict]] = {}
    ids = [r["id"] for r in rs]
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for a in rows(conn, f"""SELECT issue_import_id, suit_type, suit_color, suit_size, suit_level FROM issue_import_conflict
                                 WHERE issue_import_id IN ({marks(len(chunk))}) ORDER BY id""", chunk):
            alts.setdefault(a["issue_import_id"], []).append(a)
    master = {m["suit_barcode"]: m for m in rows(conn, f"""SELECT suit_barcode, suit_type, suit_color, suit_size, rectime, tied
                                                           FROM barcode_master WHERE suit_barcode IN ({marks(len(rs)) if rs else "''"})""",
                                                 [r["barcode"] for r in rs])}
    v = lambda x: {"type": x["suit_type"] or "", "color": x["suit_color"] or "", "size": x["suit_size"] or "", "level": x["suit_level"] or ""}  # noqa: E731
    out = []
    for r in rs:
        m = master.get(r["barcode"])
        out.append({"barcode": r["barcode"], "insert_time": r["insert_time"].strftime("%Y-%m-%d %H:%M:%S"),
                    "problem": "conflict" if r["status"] == "held_conflict" else "missing",
                    "missing": (r["missing_values"] or "").split(",") if r["missing_values"] else [],
                    "versions": [v(r)] + [v(a) for a in alts.get(r["id"], [])],
                    "master": None if not m else {"type": m["suit_type"] or "", "color": m["suit_color"] or "", "size": m["suit_size"] or "",
                                                  "rectime": m["rectime"].strftime("%Y-%m-%d %H:%M:%S"), "tied": bool(m["tied"])}})
    return out


UNREGISTERED_SHOWN = 200
CONFLICTS_SHOWN = 100
WAITING_SHOWN = 100


def _master_counts(conn: Connection) -> dict:
    r = one(conn, """SELECT COALESCE(SUM(status IN ('held_conflict', 'held_missing')), 0) AS waiting,
                            COALESCE(SUM(conflict = 'resolved'), 0) AS decided,
                            COALESCE(SUM(missing_values IS NOT NULL AND status <> 'held_missing'), 0) AS filled,
                            COALESCE(SUM(missing_values IS NOT NULL), 0) AS empty
                       FROM issue_import WHERE conflict IS NOT NULL OR missing_values IS NOT NULL""") or {}
    return {"waitingTotal": int(r.get("waiting") or 0), "decidedByMaster": int(r.get("decided") or 0),
            "filledFromMaster": int(r.get("filled") or 0), "emptyValueScans": int(r.get("empty") or 0)}


def data_quality(conn: Connection, days: int) -> dict:
    """The data quality page. The barcode lists hold the most frequent ones only (the page shows 50 and finds
    others with /api/data-quality/unregistered?find=); the CSV downloads have all of them."""
    per_day = rows(conn, """SELECT issued_day AS day, l.code AS location, SUM(quality = 'incomplete') AS incomplete, COUNT(*) AS total
                              FROM issue_import ii LEFT JOIN location l ON l.id = ii.location_id
                             WHERE issued_day >= CURDATE() - INTERVAL ? DAY AND status <> 'ignored'
                             GROUP BY issued_day, l.code ORDER BY issued_day""", [days])
    totals = one(conn, """SELECT COUNT(DISTINCT ii.suit_barcode) AS n, COUNT(DISTINCT e.suit_barcode) AS excluded
                            FROM issue_import ii LEFT JOIN excluded_barcode e ON e.suit_barcode = ii.suit_barcode
                           WHERE ii.quality = 'incomplete'""") or {"n": 0, "excluded": 0}
    conflicts = conflicting_barcodes(conn)
    return {"perDay": [{**r, "day": r["day"].isoformat()} for r in per_day],
            "unregisteredBarcodes": unregistered_barcodes(conn, UNREGISTERED_SHOWN),
            "unregisteredTotal": totals["n"], "unregisteredExcluded": totals["excluded"],
            "conflictingBarcodes": conflicts[:CONFLICTS_SHOWN], "conflictingTotal": len(conflicts),
            "waiting": waiting_scans(conn, WAITING_SHOWN), **_master_counts(conn),
            "patterns": rows(conn, "SELECT id, suit_type, suit_color, suit_size, active FROM dq_pattern ORDER BY id")}
