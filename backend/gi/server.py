"""Starts GI: database migrations (under a lock, so replicas can start together), test-install seeds,
the import scheduler and the web server. Uvicorn finishes requests in flight on SIGTERM."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import uvicorn

from .app import build_app
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


def create_app():
    applied = migrate()
    if applied:
        log.info("migrations applied: %s", applied)
    # Test installs: users for dev sign-in, and the mapping for the mock data's codes (both idempotent).
    apply_startup_seeds(dev_users=config.DEV_AUTH, mock_mapping=config.ISSUE_SOURCE == "mock")
    app = build_app()

    @asynccontextmanager
    async def lifespan(_app):
        sched = Scheduler().start() if os.environ.get("NO_SCHEDULER") != "true" else None
        yield
        log.info("shutting down")
        if sched:
            sched.stop()
        dispose()

    app.router.lifespan_context = lifespan
    return app


def main() -> None:
    uvicorn.run(create_app(), host="0.0.0.0", port=config.PORT, proxy_headers=True, forwarded_allow_ips="*",
                timeout_graceful_shutdown=20, log_config=None)


if __name__ == "__main__":
    main()
