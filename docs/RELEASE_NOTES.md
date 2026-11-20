# Release notes

What changed on each working day, newest first. Dates are **Phoenix time (UTC−7)**.
Requirement IDs (e.g. `ORA-03`) refer to the [URD](./URD.md); open questions are in [TODO.md](./TODO.md).

---

## 2026-11-20

### Import issues from a CSV export of Oracle
- **New: Settings › Import › Upload an Oracle export** (admin). The test site cannot reach Oracle yet, so issue rows can be exported from Oracle to a CSV file and uploaded.
- **Nothing is counted twice:** rows already in GI (same `SUIT_BARCODE` and `INSERT_TIME`, the rule from ORA-02) are skipped. Uploading the same file again, or files with overlapping dates, only adds the new rows. A later switch to the live Oracle connection also skips the rows already uploaded.
- **The file is checked first:** if any row can't be read (missing column, a date without time or seconds), nothing is imported and the problem lines are listed. Only `STATE = 'EMPLOYEE GOWN ISSUE'` rows are used.
- **Times must include seconds**, because the duplicate check compares `INSERT_TIME` to the second. The recommended export query writes `YYYY-MM-DD HH24:MI:SS`; Oracle's default style (`20-NOV-26 09.15.30 AM`) also works. Don't open and save the file in Excel, which drops the seconds.
- **New setting `ISSUE_SOURCE=csv`:** no automatic import and no "import stale" warning; issues come only from uploads. Uploaded rows are classified like imported ones: map the values in Settings › Oracle values, and enter the starting counts.
- Steps and the export query: [KUBERNETES_DEPLOYMENT.md §7](./KUBERNETES_DEPLOYMENT.md) and [DEPLOYMENT_SOP.md §8.4](./DEPLOYMENT_SOP.md).
- **Database change** (migration `003`, applied automatically): the import history records uploads and their file names.
- Tested here:
  - 18 new tests (44 in total pass): date formats, a bad row rejecting the whole file, re-uploads and overlapping files;
  - in the browser, on an empty database with `ISSUE_SOURCE=csv`: two overlapping exports in different date formats, then the first one again. 2,471 distinct issues were stored, with nothing counted twice.

### Port 8000 and user 1000 (company Kubernetes)
- **First deployment problem found:** with Istio in the cluster, both health checks returned 500. The company deployment checks port **8000**, but GI listened on 3000, so nothing answered and the Istio sidecar reported 500.
- **GI now listens on port 8000 by default** (image, `PORT` setting, `deploy/k8s/deployment.yaml`, Compose, docs). `PORT` can still change it.
- **The image runs as user 1000** (was 10001), as the company setup expects; `runAsUser`/`runAsGroup` in `deployment.yaml` match.
- Explained (no change): `backend/.env` is only read when running the app locally; `deploy/.env` is only for Docker Compose; neither is in the image. Without Compose, the database settings (`MARIADB_HOST`, `MARIADB_USER`, `MARIADB_PASSWORD`, `MARIADB_DATABASE`) are passed as environment variables: `docker run --env-file`, or in Kubernetes the ConfigMap plus the Secret `gi-secrets`.
- Tested here: the image on port 8000 as user 1000 with a read-only filesystem (healthy), and the 25 backend tests.

### Starts even when MariaDB cannot be reached
- **Before:** GI set up the database before starting the web server. If MariaDB could not be reached, the app exited and the pod restarted over and over, with no clear message.
- **Now:** the web server starts at once and the database setup retries in the background (after 5 s, then up to every 60 s):
  - liveness (`/healthz`) stays OK, so the pod is not restarted;
  - readiness (`/api/health`) returns 503 with the reason, e.g. "database not reachable or not set up (… Can't connect to MySQL server …)", which is also logged;
  - once MariaDB answers, GI creates its tables, starts the issue import and becomes ready by itself.
- Users still cannot use the site while MariaDB is unreachable: GI has nothing to show without its data. What changed is that the cause is clear and recovery needs no restart.
- Tested here: a container started with MariaDB stopped stayed up and reported the reason; it became ready about 10 s after MariaDB was started. 26 backend tests pass (1 new).

## 2026-11-19

### Python backend and a web page without a build step
- **Decision: no Node.js anywhere.** The company CI builds images from the company's Python base image, so:
  - the backend was rewritten in Python (FastAPI);
  - the web page is now plain HTML, CSS and JavaScript, with no React and no build step.
  The API paths and JSON did not change, and the pages look and behave the same (checked screen by screen against the previous version).
- **New `Dockerfile`**: a Python base image (build argument `PYTHON_IMAGE`; any Python 3.10+), then `pip install -r requirements.txt`, then the app.
  - The package layer is rebuilt only when `requirements.txt` changes.
  - Optional: a PyPI mirror (`PIP_INDEX_URL`), a proxy, and the company root certificate.
  - The image is about 270 MB (was 350 MB). Tested on Python 3.10 and 3.12.
- **Azure DevOps pipeline**: `Docker@2` ignores build arguments with `buildAndPush`, so the pipeline now builds and pushes in two steps and passes the company base image from the variable `pythonImage`.
- **Mock Oracle data is generated in memory** by the server (the same rows on every replica for a given day). The mock-data volume and the start-up script are gone.
- **Kubernetes**: the image runs as user 10001 (was 1000).
- **Small fixes found along the way**:
  - garment icons now show in the GitHub demo (a relative icon path was resolved against the stylesheet);
  - posting a delivery also works on plain-HTTP sites (the random key needed HTTPS);
  - health-check requests are no longer written to the access log.
- **Tested here**:
  - the 23 earlier tests ported to pytest, plus 2 new ones (25 pass);
  - the device-detection tests;
  - browser checks of every screen, laptop and phone: posting and correcting a delivery, stock grid and minimum, chart read-outs, settings, switching user and layout;
  - Docker Compose;
  - two read-only, non-root containers: migrations ran once, one imported, and the other took over after a clean stop.
- **Merged into `main`** as [hltsai9/GI#2](https://github.com/hltsai9/GI/pull/2).
- Docs updated: README, [DEPLOYMENT_SOP.md](./DEPLOYMENT_SOP.md), [KUBERNETES_DEPLOYMENT.md](./KUBERNETES_DEPLOYMENT.md) §6, [BUILD_PLAN.md](./BUILD_PLAN.md) §1. The GitHub demo data was refreshed.

### Kubernetes with Azure DevOps
- **Deployment target decided**: the company Kubernetes cluster, built and deployed by Azure DevOps, with the company's on-premise MariaDB. New guide: [KUBERNETES_DEPLOYMENT.md](./KUBERNETES_DEPLOYMENT.md); files in `deploy/k8s/` and `deploy/azure-pipelines.yml`.
- **Passwords**: stored as a secret variable in Azure DevOps (optionally Azure Key Vault). The pipeline copies them into the Kubernetes Secret `gi-secrets`, which the pod reads as `MARIADB_PASSWORD`. They are never in git or the image.
- **New database settings** `MARIADB_HOST`, `MARIADB_USER`, `MARIADB_PASSWORD`, `MARIADB_DATABASE`, so only the password is secret and it needs no URL-encoding. `MARIADB_URL` still works.
- **Several replicas for a stable site** (2 by default, rolling updates without downtime):
  - only the replica holding a MariaDB lock runs the import, and another takes over if it dies;
  - migrations run under a lock too;
  - readiness depends on the database, liveness does not;
  - pods shut down cleanly.
- **Mock data is now the same for a given day on every replica.** Mock barcodes are unique per garment (Blue and Black garments used to share them), and the GitHub demo data was refreshed.
- **Tested here**:
  - two instances starting together: migrations ran once, one imported, and the other took over after a clean stop;
  - the image running read-only and non-root with no extra privileges;
  - readiness 503 / liveness 200 while the database was down;
  - the documented demo-load command;
  - 23 backend tests.

### One image for the whole app
- **Decision: frontend and backend ship as one Docker image (`gi`)**, built from the `Dockerfile` at the repository root. The backend now also serves the web page, so there is no separate nginx container. Deployment is two containers: `app` and the official MariaDB image, which can be replaced by an existing MariaDB server.
- **First deployment without Oracle**: `ISSUE_SOURCE=mock` (the default) generates realistic issue data inside the container. Switching to Oracle later needs no rebuild, only settings (SOP §8.3).
- **Tested here**:
  - a fresh install;
  - the web page, its files and the API served from the one container, with correct caching;
  - loading the demo history and posting a delivery;
  - running the image alone without Compose;
  - all 21 backend tests.
- **[DEPLOYMENT_SOP.md](./DEPLOYMENT_SOP.md) rewritten for the one-image setup.** The separate frontend/backend Dockerfiles, nginx and the frontend-only demo image from earlier today were removed.

### Web page on its own (demo mode)
- **The frontend image can be built as a self-contained demo** (`--build-arg VITE_DEMO=true`). It includes the recorded mock data, so the site can be checked on the company network before the backend and database are set up. Steps: [DEPLOYMENT_SOP.md §5A](./DEPLOYMENT_SOP.md).
- **nginx now starts even when there is no backend**: it looks up the backend's address per request instead of at startup. Normal images do not include the demo data.

### Ready for Docker (company test environment)
- **Three containers**, started together with `deploy/docker-compose.yml`:
  - `frontend` (nginx serving the web page and forwarding `/api`);
  - `backend` (API plus the import scheduler);
  - `mariadb` (optional, if an existing MariaDB server is used instead).
- **Settings** go in `deploy/.env` (template: `deploy/.env.example`). The database is set up automatically on start.
- **Company networks**: proxy, `127.0.0.1` proxies (`BUILD_NETWORK=host`), a company root certificate, an internal npm mirror and mirrored base images are all supported. Building and running were tested end to end here, including the backup and restore.
- **Test installs work out of the box**:
  - the four test users are created when `DEV_AUTH=true`;
  - with mock data, its codes are mapped automatically;
  - the demo history can be loaded inside the containers.
- **The Source Serif font is now part of the app**, so pages look right on networks without Google Fonts.
- **New SOP**: [DEPLOYMENT_SOP.md](./DEPLOYMENT_SOP.md) covers prerequisites, configuration, building (including company proxies and offline hosts), first-time setup with mock or real Oracle data, updates and rollback, backups (`deploy/backup.sh`), security and troubleshooting.

### Trends charts
- **Instant hover read-out**: hovering (or tapping on a phone) shows the date and that day's numbers right away. The hovered bar stays solid while the others dim, and the stock lines get a guide line with dots. This replaces the browser's slow, tiny tooltip.

### Look and feel
- **Restyled to match the mockups** (`design/mockups`):
  - the app now uses the Broadsheet design system stylesheet unchanged, with the mockup's layout;
  - small blue kicker above a large page title;
  - full-width segmented controls with the selected option in blue;
  - dropdowns with the label inside the box;
  - blue garment icons and 44 px −/+ steppers;
  - the "Post delivery" bar pinned at the bottom;
  - the mockup's stock grid colors and chart styles (cyan / magenta / ink lines, in-and-out bars).
- **Settings**: on phones the section is chosen from a dropdown (seven sections do not fit in one row). The layout switch and the dev user picker moved to **Settings › This device**, so the sidebar footer matches the mockup.

### Navigation and demo
- **Navigation icons**: Receive, Stock, Trends and Settings now use Phosphor Icons (Regular): truck, stack, chart-line-up, gear-six.
- **Phone tabs**: icon above the label, the four tabs share the width, so all fit even on a 320 px phone.
- **Demo on GitHub Pages is live**: https://hltsai9.github.io/GI/. It is the real frontend reading recorded mock data, and it is read-only (saving shows a "demo" message).

### Notes
- Release notes now use Phoenix time, and `CLAUDE.md` asks every session to add what was done that day.

## 2026-11-18

### First build (backend + frontend)
- **Backend** (`backend/`, Node.js + TypeScript, Fastify, MariaDB):
  - SQL migrations for the reviewed schema, reference data and a dev seed.
  - Stock ledger as the only way stock changes, with a nightly check that stock equals the sum of its ledger.
  - Deliveries: post (a retry never double-posts), correct (difference only), void.
  - Starting count with an as-of cut-off: keeps later deliveries, applies issues scanned after it.
  - Stock corrections; a full spot check also clears the unregistered count.
  - Oracle import:
    - per-location `RECTIME` bookmarks, paging on `RECTIME` + barcode, daily 3-day catch-up sweep;
    - Taipei/Phoenix time conversion;
    - an alert whenever `RECTIME` is before the scan;
    - rows with unmapped values held until mapped;
    - the unregistered bucket for GOWN / OTHER / OTHER rows.
  - Mock Oracle data generator that behaves like the real table. A real Oracle source is ready (`ISSUE_SOURCE=oracle`).
  - 21 automated tests.
- **Frontend** (`frontend/`, React + Vite):
  - phone or laptop layout by device type;
  - Receive, Stock, Trends and Settings screens;
  - Broadsheet design tokens.
- **Bug found and fixed while testing**: the regular import skipped rows when a page of results ended in the middle of rows sharing the same `RECTIME` second. The daily sweep caught it on the first run.
- **GitHub**: `main` branch created from the first commit; pull request [hltsai9/GI#1](https://github.com/hltsai9/GI/pull/1) opened; Pages workflow added.

### Decisions recorded (URD v0.6 → v0.10)
- **Unregistered garments**: a barcode missing from the suit master is reported as GOWN / OTHER / OTHER whatever it really is. Its type, color and size are all unknown, so it goes to a per-fab "unregistered" bucket (not to Gowns). The data quality report lists these barcodes for the vendor.
- **Oracle times**: `INSERT_TIME` = scan time = issue time, in Taipei time. `RECTIME` = when the record was entered, in Phoenix time, usually within ~15 h.
  - Issues are counted on the Phoenix day of the scan.
  - The import follows `RECTIME`, with a separate bookmark per location, because `RECTIME` is only in order within a location.
- **Both fabs are in Phoenix**: days and times are shown in Phoenix time.
- **Columns are Oracle `DATE`.**
- **Simplifications**:
  - no cancellations, so reversal handling was removed;
  - tablets use the laptop layout;
  - gowns, hoods and boots only for v1.
- **Status rules** for imported issues defined: one `classifyIssue` function, plus re-checks when a value is mapped or a starting count is saved.

### Data model review applied
-
  - `app_user` / `is_ignored` names;
  - `DATETIME(6)`;
  - real foreign keys instead of "type + id" pairs;
  - `delivery_correction` table;
  - `issue_import.issued_at` / `location_id` plus indexes;
  - `audit_log`;
  - stock correction reasons as an `ENUM`;
  - snapshot stock empty before go-live.
- **Import interval** can be set from 5 minutes to 12 hours. Issues always count on the day they happened; a longer interval only delays them.

## 2026-10-21

- **No handheld scanners; MariaDB** instead of PostgreSQL (URD v0.2).
- **Background corrected** (URD v0.3):
  - floor staff stop counting and only enter deliveries;
  - issues come from the issuing system's Oracle database;
  - stock = starting count + deliveries − issues;
  - the lead wants deliveries per period, issues per day and stock now.
- **Oracle issue table**: rows with `STATE = 'EMPLOYEE GOWN ISSUE'`, one row per garment, `SUIT_LEVEL` = location; GOWN / OTHER / OTHER rows are known to be wrong (URD v0.4).
- **Layout by device type** (phone / laptop) instead of by window width.
- **Open questions** moved to the `docs/TODO.md` checklist (URD v0.5).
- **Data model walkthrough** (evening, review only, no file changes): how the current balance (`stock_item`) and the history (`ledger_entry`) work together, how trends are calculated, and a list of 10 schema fixes, applied on 2026-11-18.

## 2026-10-19

- **Project started** from the UI mockups: User Requirements Document (URD v0.1), build plan and the mockups added to the repository.
