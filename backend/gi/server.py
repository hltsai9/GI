"""Starts GI: the web server at once, then in the background the database migrations (under a lock, so
replicas can start together), test-install seeds and the import scheduler. If the database cannot be
reached, GI keeps running and retries; /api/health reports why. Uvicorn finishes requests in flight on SIGTERM."""
from __future__ import annotations

import logging
import os
import threading
from contextlib import asynccontextmanager

import uvicorn

from .app import Startup, build_app
from .config import config
from .db import dispose
from .migrate import apply_startup_seeds, migrate
from .scheduler import Scheduler

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("gi")


class _NoHealthChecks(logging.Filter):
    """Kubernetes probes call the health checks every few seconds; keep them out of the access log."""
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return "/api/health" not in msg and "/healthz" not in msg


logging.getLogger("uvicorn.access").addFilter(_NoHealthChecks())


def _short(e: BaseException) -> str:
    """One line for logs and the health check, e.g. (2003, "Can't connect to MySQL server on 'db' (timed out)")."""
    orig = getattr(e, "orig", None) or e
    return f"{type(orig).__name__}: {orig}".splitlines()[0][:300]


def _set_up_database(stop: threading.Event) -> bool:
    """Migrations and test-install seeds, retried until the database answers. The web server is already
    running meanwhile: liveness is OK, readiness says why it is not ready yet."""
    delay = 5
    while not stop.is_set():
        try:
            applied = migrate()  # under a database lock, so replicas can start together
            if applied:
                log.info("migrations applied: %s", applied)
            # Test installs: users for dev sign-in, and the mapping for the mock data's codes (both idempotent).
            apply_startup_seeds(dev_users=config.DEV_AUTH, mock_mapping=config.ISSUE_SOURCE == "mock")
            Startup.error = None
            Startup.ready = True
            log.info("database ready")
            return True
        except Exception as e:  # noqa: BLE001
            Startup.error = f"database not reachable or not set up ({_short(e)})"
            log.warning("%s; retrying in %d s", Startup.error, delay)
            stop.wait(delay)
            delay = min(delay * 2, 60)
    return False


def create_app():
    app = build_app()
    Startup.ready = False

    @asynccontextmanager
    async def lifespan(_app):
        stop = threading.Event()
        state: dict = {}

        def start() -> None:
            if _set_up_database(stop) and os.environ.get("NO_SCHEDULER") != "true" and not stop.is_set():
                state["sched"] = Scheduler().start()

        starter = threading.Thread(target=start, name="gi-startup", daemon=True)
        starter.start()
        yield
        log.info("shutting down")
        stop.set()
        starter.join(5)
        if state.get("sched"):
            state["sched"].stop()
        dispose()

    app.router.lifespan_context = lifespan
    return app


def main() -> None:
    uvicorn.run(create_app(), host="0.0.0.0", port=config.PORT, proxy_headers=True, forwarded_allow_ips="*",
                timeout_graceful_shutdown=20, log_config=None)


if __name__ == "__main__":
    main()
