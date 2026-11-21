"""HTTP API (same paths and JSON as before) plus the web page, served from one process."""
from __future__ import annotations

import csv
import io
import json
import logging
import threading
from urllib.parse import unquote
from datetime import date
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import HttpError, User, current_user, require_role, unlock_admin
from .config import config
from .db import connect, db_reachable, execute, one, rows, with_named_lock
from .importing import get_issue_source
from .importing.csv_upload import CsvError, import_rows, run_progress
from .importing.csv_upload import parse as parse_csv
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


class PasscodeInput(BaseModel):
    passcode: str


class OrderInput(BaseModel):
    ids: list[int]


MAX_UPLOAD_BYTES = 50_000_000


def _automatic_source() -> None:
    if config.ISSUE_SOURCE == "csv":
        raise HttpError(409, "There is no automatic import (ISSUE_SOURCE=csv). Upload a CSV file instead.")


def _start_upload(rows_: list, other: int, file_name: str) -> dict:
    """Starts the import in a background thread holding the "import" lock; returns once the run has
    started ({"run_id"}) or could not start ({"busy": reason})."""
    started = threading.Event()
    box: dict = {}

    def job() -> None:
        try:
            ran, _ = with_named_lock("import", lambda: import_rows(rows_, other, file_name,
                                                                    on_started=lambda rid: (box.update(run_id=rid), started.set())))
            if not ran:
                box["busy"] = "an import is running right now; try again in a minute"
        except RuntimeError as e:  # this instance is already importing
            box.setdefault("busy", str(e))
        except Exception:  # noqa: BLE001 - recorded in sync_run and as an alert by the importer
            log.exception("CSV upload failed")
        finally:
            started.set()

    threading.Thread(target=job, name="gi-upload", daemon=True).start()
    started.wait(60)
    return box


def _locked(fn):
    ran, result = with_named_lock("import", fn)
    if not ran:
        raise HttpError(409, "an import is running right now; try again in a minute")
    return result


def build_app(static_dir: str | Path | None = None) -> FastAPI:
    app = FastAPI(title="GI", docs_url=None, redoc_url=None, openapi_url=None)
    lead = Depends(require_role("lead"))
    floor_or_lead = Depends(require_role("floor", "lead"))  # floor staff, lead (and admin)
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

    @app.post("/api/dev/admin-unlock")
    def admin_unlock(body: PasscodeInput):
        """Test sign-in only: switching to the dev admin needs the passcode (ADMIN_PASSCODE). Returns a token the page
        sends as X-Admin-Token; it expires after ADMIN_TOKEN_HOURS."""
        return unlock_admin(body.passcode)

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
    def grid(garmentTypeId: int = Query(..., ge=1), locationId: int = Query(..., ge=1), days: int | None = Query(None, ge=1, le=366),  # noqa: N803
             day: date | None = None):
        with connect() as c:
            return stock.stock_grid(c, garmentTypeId, locationId, days, day=day.isoformat() if day else None)

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
    def post_starting_count(body: counts.StartingCountInput, u: User = floor_or_lead):
        return counts.save_starting_count(body, u.id)

    @app.get("/api/corrections", dependencies=[user])
    def get_corrections():
        with connect() as c:
            return counts.list_corrections(c)

    @app.post("/api/corrections", status_code=201)
    def post_correction(body: counts.CorrectionInput, u: User = floor_or_lead):
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
        def add(body: ValueInput, u: User = floor_or_lead, kind=kind):
            return JSONResponse(settings.add_value(kind, body.value, u.id), status_code=201)

        def hide(item_id: int, u: User = floor_or_lead, kind=kind):
            return settings.set_active(kind, item_id, False, u.id)

        def restore(item_id: int, u: User = floor_or_lead, kind=kind):
            return settings.set_active(kind, item_id, True, u.id)

        app.post(f"/api/{kind}s")(add)
        app.post(f"/api/{kind}s/{{item_id}}/hide")(hide)
        app.post(f"/api/{kind}s/{{item_id}}/restore")(restore)

    @app.put("/api/sizes/order")
    def order(body: OrderInput, u: User = floor_or_lead):
        return settings.reorder_sizes(body.ids, u.id)

    @app.put("/api/data-quality/excluded")
    def put_excluded(body: settings.ExcludeInput, u: User = lead):
        """Leaves one unregistered barcode out of the issued numbers, or counts it again (lead or admin)."""
        return settings.set_barcode_excluded(body, u.id)

    @app.get("/api/oracle-values", dependencies=[user])
    def oracle_values():
        with connect() as c:
            return settings.oracle_values(c)

    @app.put("/api/oracle-values/{map_id}")
    def set_mapping(map_id: int, body: settings.MappingInput, u: User = admin):
        return settings.set_mapping(map_id, body, u.id)

    @app.get("/api/data-quality", dependencies=[user])
    def data_quality(days: int = Days):
        with connect() as c:
            return settings.data_quality(c, days)

    @app.get("/api/data-quality/unregistered.csv", dependencies=[user])
    def unregistered_csv():
        with connect() as c:
            lst = settings.unregistered_barcodes(c)
        out = io.StringIO()
        w = csv.writer(out, lineterminator="\n", quoting=csv.QUOTE_ALL)  # keeps commas, quotes and spaces in barcodes
        w.writerow(["barcode", "times_issued", "first_seen_utc", "last_seen_utc", "last_insert_time_oracle", "locations"])
        for b in lst:
            w.writerow([b["barcode"], b["times"], b["first_seen"], b["last_seen"], b["last_insert_time"], b["locations"]])
        return Response(out.getvalue(), media_type="text/csv",
                        headers={"content-disposition": 'attachment; filename="unregistered-barcodes.csv"'})

    @app.get("/api/data-quality/conflicts.csv", dependencies=[user])
    def conflicts_csv():
        with connect() as c:
            lst = settings.conflicting_barcodes(c)
        out = io.StringIO()
        w = csv.writer(out, lineterminator="\n", quoting=csv.QUOTE_ALL)
        w.writerow(["barcode", "suit_type", "suit_color", "suit_size", "times_seen", "counted", "first_insert_time_oracle",
                    "last_insert_time_oracle", "locations"])
        for b in lst:
            for k in b["combinations"]:
                w.writerow([b["barcode"], k["type"], k["color"], k["size"], k["times"], "no (same scan as another row)" if k["notCounted"] else "yes",
                            k["first_insert_time"], k["last_insert_time"], k["locations"]])
        return Response(out.getvalue(), media_type="text/csv",
                        headers={"content-disposition": 'attachment; filename="barcodes-with-conflicting-values.csv"'})

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
        """CSV export of the Oracle issue table, sent as the request body. The file is checked at once (400 with
        the problem lines); the import then runs in the background and GET /api/sync/runs/{runId} reports its
        progress. Rows already in GI are skipped."""
        data = await request.body()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HttpError(413, f"The file is larger than {MAX_UPLOAD_BYTES // 1_000_000} MB; split it into smaller files.")
        try:
            rows_, other = await run_in_threadpool(parse_csv, data)
        except CsvError as e:
            return JSONResponse({"error": str(e), "problems": e.problems}, status_code=400)
        box = await run_in_threadpool(_start_upload, rows_, other, unquote(x_file_name or ""))
        if "run_id" not in box:
            raise HttpError(409, box.get("busy") or "an import is running right now; try again in a minute")
        return JSONResponse({"runId": box["run_id"], "total": len(rows_), "otherState": other}, status_code=202)

    @app.get("/api/sync/runs/{run_id}", dependencies=[user])
    def run_detail(run_id: int):
        with connect() as c:
            r = one(c, "SELECT * FROM sync_run WHERE id = ?", [run_id])
        if not r:
            raise HttpError(404, "run not found")
        return run_progress(r)

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
