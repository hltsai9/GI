"""HTTP API (same paths and JSON as before) plus the web page, served from one process."""
from __future__ import annotations

import json
import logging
from urllib.parse import unquote
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import HttpError, User, current_user, require_role
from .config import config
from .db import connect, db_reachable, execute, rows, with_named_lock
from .importing import get_issue_source
from .importing.csv_upload import CsvError, import_csv
from .importing.importer import poll, sweep, sync_status
from .ledger import invariant_violations
from .services import counts, deliveries, settings, stock, trends
from .timeutil import iso, now_utc, to_db

log = logging.getLogger("gi")

# The web page: frontend/ next to backend/ in the repository and in the image.
DEFAULT_STATIC = Path(__file__).resolve().parents[2] / "frontend"

Days = Query(14, ge=1, le=366)


class Startup:
    """Set by the server while it is still setting up the database (see server.py). Until then the
    readiness check fails with the reason, so Kubernetes sends no traffic to this instance."""
    ready = True
    error: str | None = None


class MinInput(BaseModel):
    min: int | None = Field(..., ge=1)


class ValueInput(BaseModel):
    value: str


class OrderInput(BaseModel):
    ids: list[int]


MAX_UPLOAD_BYTES = 50_000_000


def _automatic_source() -> None:
    if config.ISSUE_SOURCE == "csv":
        raise HttpError(409, "There is no automatic import (ISSUE_SOURCE=csv). Upload a CSV file instead.")


def _locked(fn):
    ran, result = with_named_lock("import", fn)
    if not ran:
        raise HttpError(409, "an import is running right now; try again in a minute")
    return result


def build_app(static_dir: str | Path | None = None) -> FastAPI:
    app = FastAPI(title="GI", docs_url=None, redoc_url=None, openapi_url=None)
    lead = Depends(require_role("lead"))
    floor_or_lead = Depends(require_role("floor", "lead"))
    admin = Depends(require_role("admin"))
    user = Depends(current_user)

    @app.exception_handler(HttpError)
    async def _http_error(_req: Request, e: HttpError):
        return JSONResponse({"error": e.message}, status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_req: Request, e: RequestValidationError):
        return JSONResponse({"error": "invalid request", "issues": jsonable_issues(e)}, status_code=400)

    @app.exception_handler(Exception)
    async def _crash(_req: Request, e: Exception):
        log.exception("unhandled error", exc_info=e)
        return JSONResponse({"error": "internal error"}, status_code=500)

    # Readiness: only send traffic to an instance that can reach the database.
    @app.get("/api/health")
    def health():
        if not Startup.ready:
            return JSONResponse({"ok": False, "error": f"starting: {Startup.error or 'setting up the database'}"}, status_code=503)
        return {"ok": True} if db_reachable() else JSONResponse({"ok": False, "error": "database unreachable"}, status_code=503)

    # Liveness: the process is up (a database blip restarts nothing).
    @app.get("/healthz", response_class=PlainTextResponse)
    def healthz():
        return "ok\n"

    @app.get("/api/me")
    def me(u: User = user):
        return {"id": u.id, "name": u.name, "role": u.role}

    @app.get("/api/meta", dependencies=[user])
    def get_meta():
        with connect() as c:
            return settings.meta(c)

    # ---- Receive
    @app.post("/api/deliveries")
    def post_delivery(body: deliveries.DeliveryInput, u: User = floor_or_lead,
                      idempotency_key: str | None = Header(None)):
        if not idempotency_key:
            raise HttpError(400, "Idempotency-Key header is required")
        r = deliveries.post_delivery(body, idempotency_key, u.id)
        return JSONResponse(r, status_code=200 if r.get("duplicate") else 201)

    @app.get("/api/deliveries", dependencies=[user])
    def get_deliveries(limit: int = Query(20, ge=1, le=100)):
        with connect() as c:
            return deliveries.list_deliveries(c, limit)

    @app.post("/api/deliveries/{delivery_id}/correction")
    def correct_delivery(delivery_id: int, body: deliveries.CorrectionInput, u: User = floor_or_lead):
        return deliveries.correct_delivery(delivery_id, body, u.id)

    # ---- Stock
    @app.get("/api/stock/summary", dependencies=[user])
    def summary():
        with connect() as c:
            s = stock.stock_summary(c)
        return {**s, "sync": sync_status()}

    @app.get("/api/stock/grid", dependencies=[user])
    def grid(garmentTypeId: int = Query(..., ge=1), locationId: int = Query(..., ge=1)):  # noqa: N803
        with connect() as c:
            return stock.stock_grid(c, garmentTypeId, locationId)

    @app.get("/api/stock/items/{item_id}", dependencies=[user])
    def item(item_id: int):
        with connect() as c:
            return stock.stock_item_detail(c, item_id)

    @app.patch("/api/stock/items/{item_id}/min")
    def set_min(item_id: int, body: MinInput, u: User = lead):
        with connect() as c:
            return stock.set_minimum(c, item_id, body.min, u.id)

    # ---- Counts and corrections
    @app.get("/api/starting-counts", dependencies=[user])
    def get_starting_counts():
        with connect() as c:
            return counts.starting_counts(c)

    @app.post("/api/starting-counts", status_code=201)
    def post_starting_count(body: counts.StartingCountInput, u: User = lead):
        return counts.save_starting_count(body, u.id)

    @app.get("/api/corrections", dependencies=[user])
    def get_corrections():
        with connect() as c:
            return counts.list_corrections(c)

    @app.post("/api/corrections", status_code=201)
    def post_correction(body: counts.CorrectionInput, u: User = lead):
        return counts.save_correction(body, u.id)

    # ---- Trends
    @app.get("/api/trends/delivered", dependencies=[user])
    def t_delivered(days: int = Days, per: Literal["day", "week", "month"] = "day"):
        with connect() as c:
            return trends.delivered(c, days, per)

    @app.get("/api/trends/issued", dependencies=[user])
    def t_issued(days: int = Days):
        with connect() as c:
            return trends.issued(c, days)

    @app.get("/api/trends/stock", dependencies=[user])
    def t_stock(days: int = Days):
        with connect() as c:
            return trends.stock_over_time(c, days)

    @app.get("/api/trends/breakdown", dependencies=[user])
    def t_breakdown(days: int = Days, metric: Literal["issued", "delivered"] = "issued"):
        with connect() as c:
            return trends.breakdown(c, days, metric)

    # ---- Settings
    for kind in ("color", "size"):
        def add(body: ValueInput, u: User = lead, kind=kind):
            return JSONResponse(settings.add_value(kind, body.value, u.id), status_code=201)

        def hide(item_id: int, u: User = lead, kind=kind):
            return settings.set_active(kind, item_id, False, u.id)

        def restore(item_id: int, u: User = lead, kind=kind):
            return settings.set_active(kind, item_id, True, u.id)

        app.post(f"/api/{kind}s")(add)
        app.post(f"/api/{kind}s/{{item_id}}/hide")(hide)
        app.post(f"/api/{kind}s/{{item_id}}/restore")(restore)

    @app.put("/api/sizes/order")
    def order(body: OrderInput, u: User = lead):
        return settings.reorder_sizes(body.ids, u.id)

    @app.get("/api/oracle-values", dependencies=[user])
    def oracle_values():
        with connect() as c:
            return settings.oracle_values(c)

    @app.put("/api/oracle-values/{map_id}")
    def set_mapping(map_id: int, body: settings.MappingInput, u: User = lead):
        return settings.set_mapping(map_id, body, u.id)

    @app.get("/api/data-quality", dependencies=[user])
    def data_quality(days: int = Days):
        with connect() as c:
            return settings.data_quality(c, days)

    @app.get("/api/data-quality/unregistered.csv", dependencies=[user])
    def unregistered_csv():
        with connect() as c:
            lst = settings.unregistered_barcodes(c)
        csv = "\n".join(["barcode,times_issued,first_seen,last_seen,locations",
                         *(f'{b["barcode"]},{b["times"]},{b["first_seen"]},{b["last_seen"]},"{b["locations"]}"' for b in lst)])
        return Response(csv, media_type="text/csv",
                        headers={"content-disposition": 'attachment; filename="unregistered-barcodes.csv"'})

    # ---- Import status and admin
    @app.get("/api/sync/status", dependencies=[user])
    def status():
        return sync_status()

    @app.get("/api/sync/runs", dependencies=[user])
    def runs():
        with connect() as c:
            rs = rows(c, "SELECT * FROM sync_run ORDER BY id DESC LIMIT 20")
        return [{**r, "started_at": iso(r["started_at"]), "finished_at": iso(r["finished_at"])} for r in rs]

    @app.post("/api/sync/run", dependencies=[admin])
    def run_now():
        _automatic_source()
        return _locked(lambda: poll(get_issue_source()))

    @app.post("/api/sync/sweep", dependencies=[admin])
    def sweep_now():
        _automatic_source()
        return _locked(lambda: sweep(get_issue_source()))

    @app.post("/api/sync/upload", dependencies=[admin])
    async def upload(request: Request, x_file_name: str | None = Header(None)):
        """CSV export of the Oracle issue table, sent as the request body. Rows already in GI are skipped."""
        data = await request.body()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HttpError(413, f"The file is larger than {MAX_UPLOAD_BYTES // 1_000_000} MB; split it into smaller files.")
        try:
            return await run_in_threadpool(_locked, lambda: import_csv(data, unquote(x_file_name or "")))
        except CsvError as e:
            return JSONResponse({"error": str(e), "problems": e.problems}, status_code=400)

    @app.get("/api/alerts", dependencies=[user])
    def alerts():
        with connect() as c:
            rs = rows(c, "SELECT id, at, kind, message, details, acknowledged_at FROM admin_alert ORDER BY id DESC LIMIT 50")
        return [{**r, "at": iso(r["at"]), "acknowledged_at": iso(r["acknowledged_at"]),
                 "details": json.loads(r["details"]) if isinstance(r["details"], str) else r["details"]} for r in rs]

    @app.post("/api/alerts/{alert_id}/ack")
    def ack(alert_id: int, u: User = admin):
        with connect() as c:
            execute(c, "UPDATE admin_alert SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?", [u.id, to_db(now_utc()), alert_id])
        return {"ok": True}

    @app.get("/api/admin/ledger-check", dependencies=[admin])
    def ledger_check():
        with connect() as c:
            return {"violations": invariant_violations(c)}

    # ---- The web page (single-page app: unknown non-API paths get index.html)
    root = Path(static_dir or config.STATIC_DIR or DEFAULT_STATIC).resolve()
    has_page = (root / "index.html").is_file()

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def static(path: str):
        if path.startswith("api/") or path == "api" or not has_page:
            raise HttpError(404, "not found")
        f = (root / path).resolve()
        if path and f.is_file() and f.is_relative_to(root) and f.name != "config.local.js":
            # No build step and no hashed file names: let browsers revalidate everything (cheap 304s).
            return FileResponse(f, headers={"Cache-Control": "no-cache"})
        if "." in path.rsplit("/", 1)[-1]:
            raise HttpError(404, "not found")  # a missing file, not a page
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})

    @app.exception_handler(StarletteHTTPException)
    async def _not_found(_req: Request, e: StarletteHTTPException):
        return JSONResponse({"error": "not found" if e.status_code == 404 else str(e.detail)}, status_code=e.status_code)

    return app


def jsonable_issues(e: RequestValidationError) -> list[dict]:
    return [{"path": list(err.get("loc", [])), "message": err.get("msg")} for err in e.errors()]
