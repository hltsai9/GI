"""Issue import (BUILD_PLAN §3): reads Oracle rows by INSERT_TIME (the scan time, Phoenix local time), each run
from ORACLE_LOOKBACK_HOURS before the newest scan already imported, so records entered into Oracle late are still
found; rows already imported are skipped (ORA-02). A daily catch-up sweep re-reads the last ORACLE_SWEEP_DAYS.
Also: the future-scan check (ORA-13), held/ignored rows and re-classification. RECTIME is not used."""
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
from ..timeutil import from_db, iso, issue_time, naive_str, now_utc, shift_naive, to_db, utc_to_local
from .classify import ClassifyContext, classify_issue, note_values_seen
from .source import InsertKey, IssueSource, OracleIssueRow


@dataclass
class _Counters:
    read: int = 0
    new: int = 0
    by_status: dict[str, int] = field(default_factory=dict)
    incomplete: int = 0
    conflicts: int = 0  # same barcode and INSERT_TIME as a stored issue, but other values
    time_check_failed: int = 0
    min_day: str | None = None
    max_day: str | None = None
    time_alerts: list[dict] = field(default_factory=list)


def _key_of(r: OracleIssueRow) -> InsertKey:
    return {"insert_time": r["INSERT_TIME"], "barcode": r["SUIT_BARCODE"]}


def _import_batch(batch: list[OracleIssueRow], run_id: int, c: _Counters, now: datetime) -> None:
    """Imports a batch of Oracle rows in one transaction."""
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
                """SELECT id, suit_barcode, insert_time, suit_type, suit_color, suit_size, suit_level FROM issue_import
                    WHERE insert_time BETWEEN ? AND ?""", [min(times), max(times)])}
        for r in batch:
            c.read += 1
            for col in ("SUIT_TYPE", "SUIT_COLOR", "SUIT_SIZE", "SUIT_LEVEL"):
                seen[(col, r[col])] = seen.get((col, r[col]), 0) + 1  # type: ignore[literal-required]
            k = kept.get((r["SUIT_BARCODE"], r["INSERT_TIME"]))
            if k:
                if (k["suit_type"], k["suit_color"], k["suit_size"], k["suit_level"]) != \
                        (r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"], r["SUIT_LEVEL"]):
                    # The same scan with other values: not counted again, but recorded for the data quality report.
                    c.conflicts += 1
                    execute(conn, """INSERT INTO issue_import_conflict (issue_import_id, suit_type, suit_color, suit_size, suit_level, sync_run_id)
                                      VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE times = times + 1""",
                            [k["id"], r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"], r["SUIT_LEVEL"], run_id])
                continue
            issued_at, issued_day = issue_time(r["INSERT_TIME"])
            cls = classify_issue(conn, ctx, r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"], r["SUIT_LEVEL"], issued_at, r["SUIT_BARCODE"])
            res = execute(conn, """INSERT INTO issue_import (suit_barcode, insert_time, suit_type, suit_color, suit_size, suit_level,
                     issued_at, issued_day, location_id, stock_item_id, quality, status, sync_run_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          [r["SUIT_BARCODE"], r["INSERT_TIME"], r["SUIT_TYPE"], r["SUIT_COLOR"], r["SUIT_SIZE"], r["SUIT_LEVEL"],
                           to_db(issued_at), issued_day, cls.location_id, cls.stock_item_id, cls.quality, cls.status, run_id])
            kept[(r["SUIT_BARCODE"], r["INSERT_TIME"])] = {"id": res.lastrowid, "suit_type": r["SUIT_TYPE"], "suit_color": r["SUIT_COLOR"],
                                                         "suit_size": r["SUIT_SIZE"], "suit_level": r["SUIT_LEVEL"]}
            c.new += 1
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
                c.time_alerts.append({"barcode": r["SUIT_BARCODE"], "level": r["SUIT_LEVEL"], "insertTime": r["INSERT_TIME"],
                                      "hoursAhead": round((issued_at - now).total_seconds() / 3600, 2)})
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
        execute(conn, """UPDATE sync_run SET finished_at = ?, rows_read = ?, rows_new = ?, rows_conflicts = ?, rows_applied = ?, rows_held = ?, rows_ignored = ?,
                 rows_before_start = ?, rows_incomplete = ?, rows_time_check_failed = ?, first_issued_day = ?, last_issued_day = ?,
                 status = ?, error = ? WHERE id = ?""",
                [to_db(now_utc()), c.read, c.new, c.conflicts, s.get("applied", 0), s.get("held_unmapped", 0), s.get("ignored", 0),
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
    if c.conflicts:
        alert("data_conflict", f"{c.conflicts} rows had the same barcode and INSERT_TIME as an issue already imported but another "
              "type, color, size or level; they were not counted again (see Settings › Data quality)", {"runId": run_id, "count": c.conflicts})
    return {"runId": run_id, "kind": kind, "read": c.read, "new": c.new, "conflicts": c.conflicts, "byStatus": c.by_status, "incomplete": c.incomplete,
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
        _import_batch(batch, run_id, c, now)
        if len(batch) < config.ORACLE_MAX_ROWS:
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


def reclassify(conn: Connection, where: str, params: list, user_id: int | None, reason: str, tally: dict[str, int] | None = None) -> int:
    """Re-classifies rows whose answer may have changed (BUILD_PLAN §3.3); applies new −1 entries.
    Returns how many rows changed status; `tally` (if given) counts them by their new status."""
    ctx = ClassifyContext.load(conn)
    candidates = rows(conn, f"""SELECT id, suit_barcode, suit_type, suit_color, suit_size, suit_level, issued_at, status, stock_item_id
                                  FROM issue_import WHERE {where} FOR UPDATE""", params)
    movements: list[Movement] = []
    changed = 0
    for r in candidates:
        issued_at = from_db(r["issued_at"])
        cls = classify_issue(conn, ctx, r["suit_type"], r["suit_color"], r["suit_size"], r["suit_level"], issued_at, r["suit_barcode"])
        if cls.status == r["status"]:
            continue
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
