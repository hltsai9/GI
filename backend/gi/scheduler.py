"""Regular import, daily catch-up sweep after 03:00 and stale check (ORA-03/03a/07).
Safe with several replicas: each run takes the "import" lock in MariaDB, so only one instance imports
at a time; if it dies, the lock is freed and another takes over."""
from __future__ import annotations

import logging
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

from .config import config
from .db import connect, one, with_named_lock
from .importing import get_issue_source
from .importing.importer import alert, poll, sweep, sync_status
from .ledger import invariant_violations
from .timeutil import from_db, now_utc, site_day

log = logging.getLogger("gi.scheduler")


def _sweep_due(now: datetime | None = None) -> bool:
    """The sweep runs once per site day, after 03:00; recorded in sync_run, so any instance knows."""
    now = now or now_utc()
    if now.astimezone(ZoneInfo(config.SITE_TIMEZONE)).hour < 3:
        return False
    with connect() as c:
        last = one(c, "SELECT MAX(started_at) AS at FROM sync_run WHERE kind = 'sweep' AND status = 'ok'")
    return not last or not last["at"] or site_day(from_db(last["at"])) != site_day(now)


def _stale_alert() -> None:
    """One "import is stale" alert until someone marks it checked."""
    s = sync_status()
    if not s["stale"]:
        return
    with connect() as c:
        is_open = one(c, "SELECT 1 AS x FROM admin_alert WHERE kind = 'import_stale' AND acknowledged_at IS NULL LIMIT 1")
    if not is_open:
        alert("import_stale", f"No successful issue import for more than {2 * config.ORACLE_POLL_SECONDS // 60} minutes", s)


def tick() -> None:
    if config.ISSUE_SOURCE == "csv":
        return  # no automatic import: issues arrive by CSV upload

    def work() -> None:
        source = get_issue_source()
        run = poll(source)
        if run["new"]:
            log.info("import: %s new rows %s", run["new"], run["byStatus"])
        if _sweep_due():
            sweep(source)
            with connect() as c:
                bad = invariant_violations(c)
            if bad:
                alert("import_failed", f"Ledger check: {len(bad)} stock items disagree with their ledger", bad[:20])

    try:
        with_named_lock("import", work)  # skipped when another instance is importing
    except Exception as e:  # noqa: BLE001
        log.error("import failed: %s", e)
        try:
            _stale_alert()
        except Exception:  # noqa: BLE001
            pass


class Scheduler:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="gi-import", daemon=True)

    def start(self) -> "Scheduler":
        self._thread.start()
        return self

    def _loop(self) -> None:
        while not self._stop.is_set():
            tick()
            self._stop.wait(config.ORACLE_POLL_SECONDS)

    def stop(self, timeout: float = 20) -> None:
        self._stop.set()
        self._thread.join(timeout)
