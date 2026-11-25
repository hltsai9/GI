"""Issue import (BUILD_PLAN §3): reads Oracle rows by INSERT_TIME (the scan time, Phoenix local time), each run
from ORACLE_LOOKBACK_HOURS before the newest scan already imported, so records entered into Oracle late are still
found; rows already imported are skipped (ORA-02). A daily catch-up sweep re-reads the last ORACLE_SWEEP_DAYS.
Also: the future-scan check (ORA-13), held/ignored rows and re-classification. RECTIME is not used."""
from __future__ import annotations

import json
import logging
import threading
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable

from sqlalchemy.engine import Connection

from ..config import config
from ..db import connect, execute, marks, one, rows, with_tx
from ..ledger import Movement, apply_movements
from ..timeutil import from_db, iso, issue_time, naive_str, now_utc, shift_naive, to_db, utc_to_local
from .classify import ClassifyContext, classify_issue, note_values_seen
from .master import Attrs, Version, attrs_for, choose, latest_versions, missing_of, read_all, store
from .source import InsertKey, IssueSource, MasterRow, MasterSource, OracleIssueRow

log = logging.getLogger("gi.import")


@dataclass
class _Counters:
    read: int = 0
    new: int = 0
    by_status: dict[str, int] = field(default_factory=dict)
    incomplete: int = 0
    conflicts: int = 0  # rows of a scan with other values than the version kept (first time they are seen)
    missing: int = 0  # new scans with an empty value in Oracle
    resolved: int = 0  # scans decided (several versions) or filled (empty values) by the barcode master
    time_check_failed: int = 0
    min_day: str | None = None
    max_day: str | None = None
    time_alerts: list[dict] = field(default_factory=list)


def _key_of(r: OracleIssueRow) -> InsertKey:
    return {"insert_time": r["INSERT_TIME"], "barcode": r["SUIT_BARCODE"]}


def _version(r: OracleIssueRow) -> Version:
    return (r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"], r["SUIT_LEVEL"])


def _stored(e: dict) -> Version:
    return (e["suit_type"], e["suit_color"], e["suit_size"], e["suit_level"])


def _alt(v: Version) -> list[str]:
    return [x or "" for x in v]  # issue_import_conflict stores '' for an empty Oracle value


def live_master(source: object) -> MasterSource | None:
    """The barcode master to ask during an import from `source`: the source itself when it has one (Oracle with
    ORACLE_BARCODE_MASTER_TABLE set, or the mock)."""
    if config.ISSUE_SOURCE == "oracle" and not config.ORACLE_BARCODE_MASTER_TABLE:
        return None
    return source if hasattr(source, "master_for") else None  # type: ignore[return-value]


def _master_attrs(conn: Connection, barcodes: set[str], src: MasterSource | None) -> dict[str, Attrs]:
    """The barcode master's attributes for these barcodes. With a live barcode master (Oracle or mock), they are
    read from it first, so a version added today is already known; if that fails, GI's copy is used."""
    if not barcodes:
        return {}
    if src is not None:
        try:
            got: list = []
            bs = sorted(barcodes)
            for i in range(0, len(bs), 900):  # Oracle allows up to 1000 values in an IN list
                got += src.master_for(bs[i:i + 900])
            store(conn, latest_versions(got))
        except Exception as e:  # noqa: BLE001
            log.warning("barcode master lookup failed, using GI's copy: %s", e)
    return attrs_for(conn, barcodes)


def _alternatives(conn: Connection, ids: list[int]) -> dict[int, list[tuple[int, Version]]]:
    out: dict[int, list[tuple[int, Version]]] = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for a in rows(conn, f"""SELECT id, issue_import_id, suit_type, suit_color, suit_size, suit_level FROM issue_import_conflict
                                 WHERE issue_import_id IN ({marks(len(chunk))}) ORDER BY id""", chunk):
            out.setdefault(a["issue_import_id"], []).append((a["id"], tuple(x or None for x in _stored(a))))  # type: ignore[misc]
    return out


def _rechoose(conn: Connection, issues: list[dict], master: dict[str, Attrs]) -> tuple[list[int], int]:
    """Decides stored scans again with the barcode master (several versions, or empty values). The version kept
    moves into issue_import; the one it replaces becomes an alternative. Returns (ids whose values or conflict
    state changed, how many of them the barcode master decided or filled)."""
    alts = _alternatives(conn, [e["id"] for e in issues])
    changed: list[int] = []
    resolved = 0
    for e in issues:
        mine = alts.get(e["id"], [])
        versions = [_stored(e)] + [v for _, v in mine]
        idx, filled, conflict = choose(versions, master.get(e["suit_barcode"]))
        if idx == 0 and filled == _stored(e) and conflict == e["conflict"]:
            continue
        missing = e["missing_values"]
        if idx:
            alt_id, raw = mine[idx - 1]
            execute(conn, "DELETE FROM issue_import_conflict WHERE id = ?", [alt_id])
            execute(conn, """INSERT IGNORE INTO issue_import_conflict (issue_import_id, suit_type, suit_color, suit_size, suit_level)
                             VALUES (?,?,?,?,?)""", [e["id"], *_alt(_stored(e))])
            missing = missing_of(raw)
        execute(conn, """UPDATE issue_import SET suit_type = ?, suit_color = ?, suit_size = ?, suit_level = ?, missing_values = ?, conflict = ?
                          WHERE id = ?""", [*filled, missing, conflict, e["id"]])
        changed.append(e["id"])
        if conflict == "resolved" or (None not in filled and None in _stored(e)):
            resolved += 1
    return changed, resolved


def _import_batch(batch: list[OracleIssueRow], run_id: int, c: _Counters, now: datetime, master_src: MasterSource | None = None) -> None:
    """Imports a batch of Oracle rows in one transaction. Rows of the same scan (SUIT_BARCODE + INSERT_TIME) are
    one issue (ORA-02); if they differ, or a value is empty, the barcode master decides (see master.py)."""
    if not batch:
        return

    def work(conn: Connection) -> None:
        ctx = ClassifyContext.load(conn)
        seen: dict[tuple[str, str], int] = {}
        movements: list[Movement] = []
        tol = timedelta(minutes=config.ORACLE_TIME_TOLERANCE_MINUTES)
        # Rows already imported for this batch's time span, looked up once (ORA-02: each scan exactly once).
        times = [r["INSERT_TIME"] for r in batch]
        kept = {(e["suit_barcode"], naive_str(e["insert_time"])): e for e in rows(conn,
                """SELECT id, suit_barcode, insert_time, suit_type, suit_color, suit_size, suit_level, missing_values, conflict, status
                     FROM issue_import WHERE insert_time BETWEEN ? AND ?""", [min(times), max(times)])}
        groups: dict[tuple[str, str], list[Version]] = {}
        for r in batch:
            c.read += 1
            for col in ("SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "SUIT_LEVEL"):
                if r[col] is not None:  # type: ignore[literal-required]
                    seen[(col, r[col])] = seen.get((col, r[col]), 0) + 1  # type: ignore[literal-required]
            g = groups.setdefault((r["SUIT_BARCODE"], r["INSERT_TIME"]), [])
            if _version(r) not in g:
                g.append(_version(r))

        # Scans already stored that came back with other values: record the new versions (once).
        # Scans still waiting for the barcode master are decided again too (a live master may know them now).
        again = [kept[k] for k, vs in groups.items() if k in kept and (
            any(v != _stored(kept[k]) for v in vs) or kept[k]["conflict"] == "pending" or kept[k]["status"] == "held_missing")]
        known = _alternatives(conn, [e["id"] for e in again])
        revisit: list[dict] = []
        for e in again:
            have = {_stored(e)} | {v for _, v in known.get(e["id"], [])}
            fresh = [v for v in groups[(e["suit_barcode"], naive_str(e["insert_time"]))] if v not in have]
            for v in fresh:
                execute(conn, """INSERT IGNORE INTO issue_import_conflict (issue_import_id, suit_type, suit_color, suit_size, suit_level, sync_run_id)
                                 VALUES (?,?,?,?,?,?)""", [e["id"], *_alt(v), run_id])
            c.conflicts += len(fresh)
            if fresh or e["conflict"] == "pending" or e["status"] == "held_missing":
                revisit.append(e)

        # New scans that need the barcode master: several versions, or an empty type / color / size.
        new = {k: vs for k, vs in groups.items() if k not in kept}
        need = {b for (b, _), vs in new.items() if len(vs) > 1 or any(x is None for v in vs for x in v[:3])}
        need |= {e["suit_barcode"] for e in revisit}
        master = _master_attrs(conn, need, master_src)

        for (barcode, insert_time), vs in new.items():
            idx, (t, col, size, level), conflict = choose(vs, master.get(barcode))
            missing = missing_of(vs[idx])
            issued_at, issued_day = issue_time(insert_time)
            cls = classify_issue(conn, ctx, t, col, size, level, issued_at, barcode, conflict)
            res = execute(conn, """INSERT INTO issue_import (suit_barcode, insert_time, suit_type, suit_color, suit_size, suit_level,
                     missing_values, conflict, issued_at, issued_day, location_id, stock_item_id, quality, status, sync_run_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          [barcode, insert_time, t, col, size, level, missing, conflict,
                           to_db(issued_at), issued_day, cls.location_id, cls.stock_item_id, cls.quality, cls.status, run_id])
            for i, v in enumerate(vs):
                if i != idx:
                    execute(conn, """INSERT IGNORE INTO issue_import_conflict (issue_import_id, suit_type, suit_color, suit_size, suit_level, sync_run_id)
                                     VALUES (?,?,?,?,?,?)""", [res.lastrowid, *_alt(v), run_id])
            c.conflicts += len(vs) - 1
            c.new += 1
            if missing:
                c.missing += 1
            if conflict == "resolved" or (missing and cls.status != "held_missing" and None in vs[idx][:3]):
                c.resolved += 1
            c.by_status[cls.status] = c.by_status.get(cls.status, 0) + 1
            if cls.quality == "incomplete":
                c.incomplete += 1
            c.min_day = issued_day if c.min_day is None or issued_day < c.min_day else c.min_day
            c.max_day = issued_day if c.max_day is None or issued_day > c.max_day else c.max_day
            if cls.status == "applied":
                movements.append(Movement(cls.stock_item_id, -1, issued_at, "issue", issue_import_id=res.lastrowid))  # type: ignore[arg-type]
            # ORA-13: a scan time in the future means a wrong clock on the scanner or in Oracle.
            if issued_at > now + tol:
                c.time_check_failed += 1
                c.time_alerts.append({"barcode": barcode, "level": level, "insertTime": insert_time,
                                      "hoursAhead": round((issued_at - now).total_seconds() / 3600, 2)})
        note_values_seen(conn, seen, now)
        apply_movements(conn, movements)
        if revisit:
            ids, resolved = _rechoose(conn, revisit, master)
            c.resolved += resolved
            if ids:
                reclassify(conn, f"id IN ({marks(len(ids))})", ids, None, "same scan read again with other values")

    with_tx(work)


def resolve_waiting(conn: Connection, barcodes: list[str] | None = None) -> dict:
    """After the barcode master changed: decides held scans again (several versions, or empty values) and books
    those it can. `barcodes`: only these (default: every waiting scan). Returns counts."""
    where = "(conflict = 'pending' OR status = 'held_missing')"
    params: list = []
    if barcodes is not None:
        if not barcodes:
            return {"resolved": 0, "applied": 0}
        where += f" AND suit_barcode IN ({marks(len(barcodes))})"
        params = list(barcodes)
    waiting = rows(conn, f"""SELECT id, suit_barcode, suit_type, suit_color, suit_size, suit_level, missing_values, conflict, status
                               FROM issue_import WHERE {where}""", params)
    if not waiting:
        return {"resolved": 0, "applied": 0}
    master = attrs_for(conn, {e["suit_barcode"] for e in waiting})
    ids, resolved = _rechoose(conn, waiting, master)
    tally: dict[str, int] = {}
    if ids:
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            reclassify(conn, f"id IN ({marks(len(chunk))})", chunk, None, "decided by the barcode master", tally)
    return {"resolved": resolved, "applied": tally.get("applied", 0), "byStatus": tally}


def _start_run(kind: str, note: str | None = None) -> int:
    with connect() as conn:
        return execute(conn, "INSERT INTO sync_run (kind, note, started_at) VALUES (?, ?, ?)", [kind, note, to_db(now_utc())]).lastrowid


def alert(kind: str, message: str, details: object) -> None:
    with connect() as conn:
        execute(conn, "INSERT INTO admin_alert (kind, message, details) VALUES (?,?,?)", [kind, message[:500], json.dumps(details)])


def _finish_run(run_id: int, kind: str, c: _Counters, error: BaseException | None = None) -> dict:
    s = c.by_status
    with connect() as conn:
        execute(conn, """UPDATE sync_run SET finished_at = ?, rows_read = ?, rows_new = ?, rows_conflicts = ?, rows_missing = ?, rows_resolved = ?,
                 rows_applied = ?, rows_held = ?, rows_waiting = ?, rows_ignored = ?,
                 rows_before_start = ?, rows_incomplete = ?, rows_time_check_failed = ?, first_issued_day = ?, last_issued_day = ?,
                 status = ?, error = ? WHERE id = ?""",
                [to_db(now_utc()), c.read, c.new, c.conflicts, c.missing, c.resolved, s.get("applied", 0), s.get("held_unmapped", 0),
                 s.get("held_conflict", 0) + s.get("held_missing", 0), s.get("ignored", 0),
                 s.get("before_start", 0), c.incomplete, c.time_check_failed, c.min_day, c.max_day,
                 "failed" if error else "ok", "".join(traceback.format_exception(error)) if error else None, run_id])
    if error:
        alert("import_failed", f"Issue import ({kind}) failed: {error}", {"runId": run_id})
    elif c.time_alerts:
        # One alert per run listing every row (ORA-13); the history load only summarises.
        if kind in ("backfill", "upload"):
            alert("time_check", f"{'History load' if kind == 'backfill' else 'CSV upload'}: {len(c.time_alerts)} rows have a scan time (INSERT_TIME) in the future",
                  {"runId": run_id, "count": len(c.time_alerts), "examples": c.time_alerts[:20]})
        else:
            alert("time_check", f"{len(c.time_alerts)} issue rows have a scan time (INSERT_TIME) in the future",
                  {"runId": run_id, "rows": c.time_alerts})
    waiting = c.by_status.get("held_conflict", 0) + c.by_status.get("held_missing", 0)
    if c.conflicts or c.missing:
        parts = []
        if c.conflicts:
            parts.append(f"{c.conflicts} {'row' if c.conflicts == 1 else 'rows'} repeated a scan (same barcode and INSERT_TIME) "
                         "with another type, color, size or level")
        if c.missing:
            parts.append(f"{c.missing} new {'scan' if c.missing == 1 else 'scans'} had an empty value")
        alert("data_conflict", "; ".join(parts) + f". The barcode master decided {c.resolved}; {waiting} new scans wait for it "
              "(see Settings › Data quality).", {"runId": run_id, "conflicts": c.conflicts, "missing": c.missing,
                                                 "resolved": c.resolved, "waiting": waiting})
    return {"runId": run_id, "kind": kind, "read": c.read, "new": c.new, "conflicts": c.conflicts, "missing": c.missing,
            "resolved": c.resolved, "waiting": waiting, "byStatus": c.by_status, "incomplete": c.incomplete,
            "timeCheckFailed": c.time_check_failed, "issueDays": [c.min_day, c.max_day] if c.min_day else None}


_running = threading.Lock()


def _exclusive(fn):
    """Guards against overlapping runs in this process (replicas are coordinated by a MariaDB lock)."""
    if not _running.acquire(blocking=False):
        raise RuntimeError("an import is already running")
    try:
        return fn()
    finally:
        _running.release()


def _read_from(source: IssueSource, start: str, run_id: int, c: _Counters, now: datetime) -> None:
    """Reads every row with INSERT_TIME >= start, a page at a time, keyset-paged on (INSERT_TIME, SUIT_BARCODE):
    many rows share a second, and paging on the time alone would skip the rest of such a group."""
    after: InsertKey | None = None
    while True:
        batch = source.by_insert_time(start, after, config.ORACLE_MAX_ROWS)
        full = len(batch) >= config.ORACLE_MAX_ROWS
        if full:
            # Keep every row of a scan in one batch: drop the last scan's rows, the next page starts with them.
            last = _key_of(batch[-1])
            batch = [r for r in batch if _key_of(r) != last] or batch
        _import_batch(batch, run_id, c, now, live_master(source))
        if not full:
            break
        after = _key_of(batch[-1])


def poll(source: IssueSource, now: datetime | None = None, kind: str = "poll") -> dict:
    """Regular import (ORA-03): reads from ORACLE_LOOKBACK_HOURS before the newest scan already imported (or from
    ORACLE_BACKFILL_FROM on a new database). Records entered into Oracle up to that many hours after the scan are
    still found; rows already imported are skipped."""
    now = now or now_utc()

    def run() -> dict:
        run_id = _start_run(kind)
        c = _Counters()
        try:
            with connect() as conn:
                newest = one(conn, "SELECT MAX(insert_time) AS t FROM issue_import")
            start = (shift_naive(naive_str(newest["t"]), -60 * config.ORACLE_LOOKBACK_HOURS) if newest and newest["t"]
                     else config.ORACLE_BACKFILL_FROM)
            _read_from(source, start, run_id, c, now)
            return _finish_run(run_id, kind, c)
        except Exception as e:  # noqa: BLE001
            _finish_run(run_id, kind, c, e)
            raise

    return _exclusive(run)


def sweep(source: IssueSource, now: datetime | None = None) -> dict:
    """Daily catch-up sweep (ORA-03a): re-reads every row scanned in the last ORACLE_SWEEP_DAYS, with no upper
    limit, and imports any the polls missed (e.g. entered into Oracle more than ORACLE_LOOKBACK_HOURS late).
    Alerts if it found any."""
    now = now or now_utc()

    def run() -> dict:
        run_id = _start_run("sweep")
        c = _Counters()
        try:
            start = utc_to_local(now - timedelta(days=config.ORACLE_SWEEP_DAYS), config.ORACLE_INSERT_TIME_ZONE)
            _read_from(source, start, run_id, c, now)
            summary = _finish_run(run_id, "sweep", c)
            if c.new:
                with connect() as conn:
                    found = rows(conn, """SELECT suit_barcode AS barcode, suit_level AS level, insert_time AS insertTime
                                            FROM issue_import WHERE sync_run_id = ? LIMIT 50""", [run_id])
                alert("sweep_found_rows", f"Catch-up sweep found {c.new} issue rows the regular import missed",
                      {"runId": run_id, "rows": [{**f, "insertTime": naive_str(f["insertTime"])} for f in found]})
            return summary
        except Exception as e:  # noqa: BLE001
            _finish_run(run_id, "sweep", c, e)
            raise

    return _exclusive(run)


def _master_run(kind: str, note: str | None, read: Callable[[], list | dict]) -> dict:
    """A barcode master run: stores the latest versions, then decides the scans waiting for them."""
    def run() -> dict:
        run_id = _start_run(kind, note)
        try:
            got = read()
            latest = got if isinstance(got, dict) else latest_versions(got)
            n_rows = sum(v["versions"] for v in latest.values()) if isinstance(got, dict) else len(got)
            changed = with_tx(lambda conn: store(conn, latest))
            done = with_tx(lambda conn: resolve_waiting(conn))
            with connect() as conn:
                execute(conn, """UPDATE sync_run SET finished_at = ?, rows_read = ?, rows_new = ?, rows_resolved = ?, rows_applied = ?,
                                  status = 'ok' WHERE id = ?""", [to_db(now_utc()), n_rows, changed, done["resolved"], done["applied"], run_id])
            return {"runId": run_id, "rows": n_rows, "barcodes": len(latest), "changed": changed,
                    "tied": sum(1 for v in latest.values() if v["tied"]), **done}
        except Exception as e:  # noqa: BLE001
            with connect() as conn:
                execute(conn, "UPDATE sync_run SET finished_at = ?, status = 'failed', error = ? WHERE id = ?",
                        [to_db(now_utc()), "".join(traceback.format_exception(e)), run_id])
            alert("import_failed", f"Barcode master {'upload' if kind == 'master_upload' else 'sync'} failed: {e}", {"runId": run_id})
            raise

    return _exclusive(run)


def sync_master(source: MasterSource) -> dict:
    """Daily full read of the Oracle barcode master table (all versions; GI keeps the latest RECTIME)."""
    return _master_run("master", None, lambda: read_all(source, config.ORACLE_MAX_ROWS))


def upload_master(master_rows: list[MasterRow], file_name: str = "") -> dict:
    """A CSV export of the barcode master table (Settings › Import). Older versions never replace newer ones."""
    return _master_run("master_upload", (file_name or "")[:255] or None, lambda: master_rows)


def reclassify(conn: Connection, where: str, params: list, user_id: int | None, reason: str, tally: dict[str, int] | None = None) -> int:
    """Re-classifies rows whose answer may have changed (BUILD_PLAN §3.3); applies new −1 entries.
    Returns how many rows changed status; `tally` (if given) counts them by their new status."""
    ctx = ClassifyContext.load(conn)
    candidates = rows(conn, f"""SELECT id, suit_barcode, suit_type, suit_color, suit_size, suit_level, conflict, issued_at, status, stock_item_id
                                  FROM issue_import WHERE {where} FOR UPDATE""", params)
    movements: list[Movement] = []
    changed = 0
    for r in candidates:
        issued_at = from_db(r["issued_at"])
        cls = classify_issue(conn, ctx, r["suit_type"], r["suit_color"], r["suit_size"], r["suit_level"], issued_at, r["suit_barcode"],
                             r["conflict"])
        if cls.status == r["status"] and (cls.status != "applied" or cls.stock_item_id == r["stock_item_id"]):
            continue  # applied rows also move when their item changed (the barcode master chose another version)
        if r["status"] == "applied":
            # It no longer counts (e.g. its barcode was left out): give the garment back, dated like the issue.
            movements.append(Movement(r["stock_item_id"], +1, issued_at, "issue_correction", issue_import_id=r["id"]))
        execute(conn, "UPDATE issue_import SET status = ?, quality = ?, location_id = ?, stock_item_id = ? WHERE id = ?",
                [cls.status, cls.quality, cls.location_id, cls.stock_item_id, r["id"]])
        if cls.status == "applied":
            movements.append(Movement(cls.stock_item_id, -1, issued_at, "issue", issue_import_id=r["id"]))  # type: ignore[arg-type]
        if tally is not None:
            tally[cls.status] = tally.get(cls.status, 0) + 1
        changed += 1
    apply_movements(conn, movements)
    if changed:
        execute(conn, "INSERT INTO audit_log (user_id, entity, action, after_json) VALUES (?,?,?,?)",
                [user_id, "issue_import", "reclassify", json.dumps({"reason": reason, "rows": changed})])
    return changed


def sync_status(now: datetime | None = None) -> dict:
    """Sync status for the "Issues up to HH:MM" stamp and the stale warning (ORA-07)."""
    now = now or now_utc()
    with connect() as conn:
        last = one(conn, "SELECT finished_at FROM sync_run WHERE status = 'ok' AND kind <> 'sweep' ORDER BY finished_at DESC LIMIT 1")
        latest = one(conn, "SELECT MAX(issued_at) AS at FROM issue_import")
    last_ok = from_db(last["finished_at"]) if last else None
    stale_after = timedelta(seconds=2 * config.ORACLE_POLL_SECONDS)
    return {
        "lastSuccessfulImport": iso(last_ok),
        "issuesUpTo": iso(latest["at"]) if latest and latest["at"] else None,
        # With ISSUE_SOURCE=csv nothing imports automatically, so "stale" does not apply.
        "stale": config.ISSUE_SOURCE != "csv" and (last_ok is None or now - last_ok > stale_after),
        "source": config.ISSUE_SOURCE,
        "pollSeconds": config.ORACLE_POLL_SECONDS,
        "nowPhoenix": utc_to_local(now, config.SITE_TIMEZONE),
    }
