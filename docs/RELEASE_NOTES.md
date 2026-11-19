# Release notes

What changed on each working day, newest first. Dates are **Phoenix time (UTC−7)**.
Requirement IDs (e.g. `ORA-03`) refer to the [URD](./URD.md); open questions are in [TODO.md](./TODO.md).

---

## 2026-11-19

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
