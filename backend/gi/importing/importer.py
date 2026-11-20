"""Issue import: per-location RECTIME watermarks, discovery of new locations, daily catch-up sweep,
time check (ORA-13), held/ignored rows and re-classification (BUILD_PLAN §3)."""
from __future__ import annotations

import json
import threading
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy.engine import Connection

from ..config import config
from ..db import connect, execute, one, rows, with_tx
from ..ledger import Movement, apply_movements
from ..timeutil import from_db, iso, issue_times, naive_str, now_utc, shift_naive, to_db, utc_to_local
from .classify import ClassifyContext, classify_issue, note_values_seen
from .source import InsertKey, IssueSource, OracleIssueRow, RectimeKey


@dataclass
class _Counters:
    read: int = 0
    new: int = 0
    by_status: dict[str, int] = field(default_factory=dict)
    incomplete: int = 0
    time_check_failed: int = 0
    min_day: str | None = None
    max_day: str | None = None
    time_alerts: list[dict] = field(default_factory=list)


def _key_of(r: OracleIssueRow) -> RectimeKey:
    return {"rectime": r["RECTIME"], "barcode": r["SUIT_BARCODE"]}


def _import_batch(batch: list[OracleIssueRow], run_id: int, c: _Counters, now: datetime) -> None:
    """Imports a batch of Oracle rows in one transaction."""
    if not batch:
        return

    def work(conn: Connection) -> None:
        ctx = ClassifyContext.load(conn)
        seen: dict[tuple[str, str], int] = {}
        movements: list[Movement] = []
        tol = timedelta(minutes=config.ORACLE_TIME_TOLERANCE_MINUTES)
        for r in batch:
            c.read += 1
            for col in ("SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "SUIT_LEVEL"):
                seen[(col, r[col])] = seen.get((col, r[col]), 0) + 1  # type: ignore[literal-required]
            if one(conn, "SELECT id FROM issue_import WHERE suit_barcode = ? AND insert_time = ?", [r["SUIT_BARCODE"], r["INSERT_TIME"]]):
                continue  # ORA-02: each row exactly once
            issued_at, recorded_at, issued_day = issue_times(r["INSERT_TIME"], r["RECTIME"])
            cls = classify_issue(conn, ctx, r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"], r["SUIT_LEVEL"], issued_at)
            res = execute(conn, """INSERT INTO issue_import (suit_barcode, insert_time, rectime, suit_type, suit_color, suit_size, suit_level,
                     issued_at, recorded_at, issued_day, location_id, stock_item_id, quality, status, sync_run_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          [r["SUIT_BARCODE"], r["INSERT_TIME"], r["RECTIME"], r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"], r["SUIT_LEVEL"],
                           to_db(issued_at), to_db(recorded_at), issued_day, cls.location_id, cls.stock_item_id, cls.quality, cls.status, run_id])
            c.new += 1
            c.by_status[cls.status] = c.by_status.get(cls.status, 0) + 1
            if cls.quality == "incomplete":
                c.incomplete += 1
            c.min_day = issued_day if c.min_day is None or issued_day < c.min_day else c.min_day
            c.max_day = issued_day if c.max_day is None or issued_day > c.max_day else c.max_day
            if cls.status == "applied":
                movements.append(Movement(cls.stock_item_id, -1, issued_at, "issue", issue_import_id=res.lastrowid))  # type: ignore[arg-type]
            # ORA-13: RECTIME before the scan (beyond tolerance) or a scan in the future
            gap = recorded_at - issued_at
            future = issued_at > now + tol
            if gap < -tol or future:
                c.time_check_failed += 1
                c.time_alerts.append({"barcode": r["SUIT_BARCODE"], "level": r["SUIT_LEVEL"], "insertTime": r["INSERT_TIME"],
                                      "rectime": r["RECTIME"], "gapHours": round(gap.total_seconds() / 3600, 2), "futureScan": future})
        note_values_seen(conn, seen, now)
        apply_movements(conn, movements)

    with_tx(work)


def _start_run(kind: str, note: str | None = None) -> int:
    with connect() as conn:
        return execute(conn, "INSERT INTO sync_run (kind, note, started_at) VALUES (?, ?, ?)", [kind, note, to_db(now_utc())]).lastrowid


def alert(kind: str, message: str, details: object) -> None:
    with connect() as conn:
        execute(conn, "INSERT INTO admin_alert (kind, message, details) VALUES (?,?,?)", [kind, message[:500], json.dumps(details)])


def _finish_run(run_id: int, kind: str, c: _Counters, error: BaseException | None = None) -> dict:
    s = c.by_status
    with connect() as conn:
        execute(conn, """UPDATE sync_run SET finished_at = ?, rows_read = ?, rows_new = ?, rows_applied = ?, rows_held = ?, rows_ignored = ?,
                 rows_before_start = ?, rows_incomplete = ?, rows_time_check_failed = ?, first_issued_day = ?, last_issued_day = ?,
                 status = ?, error = ? WHERE id = ?""",
                [to_db(now_utc()), c.read, c.new, s.get("applied", 0), s.get("held_unmapped", 0), s.get("ignored", 0),
                 s.get("before_start", 0), c.incomplete, c.time_check_failed, c.min_day, c.max_day,
                 "failed" if error else "ok", "".join(traceback.format_exception(error)) if error else None, run_id])
    if error:
        alert("import_failed", f"Issue import ({kind}) failed: {error}", {"runId": run_id})
    elif c.time_alerts:
        # One alert per run listing every row (ORA-13); the history load only summarises.
        if kind in ("backfill", "upload"):
            alert("time_check", f"{'History load' if kind == 'backfill' else 'CSV upload'}: {len(c.time_alerts)} rows have RECTIME before the scan or a scan in the future",
                  {"runId": run_id, "count": len(c.time_alerts), "examples": c.time_alerts[:20]})
        else:
            alert("time_check", f"{len(c.time_alerts)} issue rows have RECTIME before the scan or a scan in the future",
                  {"runId": run_id, "rows": c.time_alerts})
    return {"runId": run_id, "kind": kind, "read": c.read, "new": c.new, "byStatus": c.by_status, "incomplete": c.incomplete,
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


def _set_watermark(level: str, rectime: str) -> None:
    with connect() as conn:
        execute(conn, """INSERT INTO sync_watermark (suit_level, last_rectime) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE last_rectime = GREATEST(last_rectime, VALUES(last_rectime))""", [level, rectime])


def poll(source: IssueSource, now: datetime | None = None, kind: str = "poll") -> dict:
    """Regular import (ORA-03): one query per known SUIT_LEVEL from its own RECTIME watermark, plus
    discovery of levels without a watermark. Watermarks move only after each batch commits."""
    now = now or now_utc()

    def run() -> dict:
        run_id = _start_run(kind)
        c = _Counters()
        try:
            overlap = -config.ORACLE_OVERLAP_MINUTES
            mx = config.ORACLE_MAX_ROWS
            with connect() as conn:
                marks = [{"level": r["suit_level"], "rectime": naive_str(r["last_rectime"])}
                         for r in rows(conn, "SELECT suit_level, last_rectime FROM sync_watermark")]
            for m in marks:
                after: RectimeKey = {"rectime": shift_naive(m["rectime"], overlap), "barcode": ""}
                while True:
                    batch = source.by_level(m["level"], after, mx)
                    _import_batch(batch, run_id, c, now)
                    if batch:
                        _set_watermark(m["level"], batch[-1]["RECTIME"])
                    if len(batch) < mx:
                        break
                    after = _key_of(batch[-1])
            # Discovery: levels GI has never seen, read from the oldest watermark (or the backfill start).
            known = [m["level"] for m in marks]
            after = {"rectime": shift_naive(min(m["rectime"] for m in marks), overlap) if marks else config.ORACLE_BACKFILL_FROM, "barcode": ""}
            while True:
                batch = source.other_levels(known, after, mx)
                _import_batch(batch, run_id, c, now)
                last: dict[str, str] = {}
                for r in batch:
                    if r["SUIT_LEVEL"] not in last or r["RECTIME"] > last[r["SUIT_LEVEL"]]:
                        last[r["SUIT_LEVEL"]] = r["RECTIME"]
                for lvl, rect in last.items():
                    _set_watermark(lvl, rect)
                if len(batch) < mx:
                    break
                after = _key_of(batch[-1])
            return _finish_run(run_id, kind, c)
        except Exception as e:  # noqa: BLE001
            _finish_run(run_id, kind, c, e)
            raise

    return _exclusive(run)


def sweep(source: IssueSource, now: datetime | None = None) -> dict:
    """Daily catch-up sweep (ORA-03a): re-reads every row scanned in the last ORACLE_SWEEP_DAYS, with no
    upper limit, and imports any the polls missed. Alerts if it found any."""
    now = now or now_utc()

    def run() -> dict:
        run_id = _start_run("sweep")
        c = _Counters()
        try:
            start = utc_to_local(now - timedelta(days=config.ORACLE_SWEEP_DAYS), config.ORACLE_INSERT_TIME_ZONE)
            after: InsertKey | None = None
            while True:
                batch = source.by_insert_time(start, after, config.ORACLE_MAX_ROWS)
                _import_batch(batch, run_id, c, now)
                if len(batch) < config.ORACLE_MAX_ROWS:
                    break
                after = {"insert_time": batch[-1]["INSERT_TIME"], "barcode": batch[-1]["SUIT_BARCODE"]}
            summary = _finish_run(run_id, "sweep", c)
            if c.new:
                with connect() as conn:
                    found = rows(conn, """SELECT suit_barcode AS barcode, suit_level AS level, insert_time AS insertTime, rectime
                                            FROM issue_import WHERE sync_run_id = ? LIMIT 50""", [run_id])
                alert("sweep_found_rows", f"Catch-up sweep found {c.new} issue rows the regular import missed",
                      {"runId": run_id, "rows": [{**f, "insertTime": naive_str(f["insertTime"]), "rectime": naive_str(f["rectime"])} for f in found]})
            return summary
        except Exception as e:  # noqa: BLE001
            _finish_run(run_id, "sweep", c, e)
            raise

    return _exclusive(run)


def reclassify(conn: Connection, where: str, params: list, user_id: int | None, reason: str, tally: dict[str, int] | None = None) -> int:
    """Re-classifies rows whose answer may have changed (BUILD_PLAN §3.3); applies new −1 entries.
    Returns how many rows changed status; `tally` (if given) counts them by their new status."""
    ctx = ClassifyContext.load(conn)
    candidates = rows(conn, f"""SELECT id, suit_type, suit_color, suit_size, suit_level, issued_at, status
                                  FROM issue_import WHERE {where} FOR UPDATE""", params)
    movements: list[Movement] = []
    changed = 0
    for r in candidates:
        issued_at = from_db(r["issued_at"])
        cls = classify_issue(conn, ctx, r["suit_type"], r["suit_color"], r["suit_size"], r["suit_level"], issued_at)
        if cls.status == r["status"]:
            continue
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
        "nowPhoenix": utc_to_local(now, config.ORACLE_RECTIME_ZONE),
    }
