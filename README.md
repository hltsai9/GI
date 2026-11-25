# GI — Cleanroom Garment Inventory

Web app with phone and laptop layouts (chosen by device type) that replaces manual garment counting in the two cleanrooms, **P1** and **P2**. Floor staff enter only the deliveries; garment issues are imported from the issuing system's Oracle database (or uploaded as CSV exports until GI can reach it); stock on hand is calculated. The lead sees deliveries per period, issues per day and current stock. Data is stored in MariaDB.

How issues are counted:
- Each Oracle row with `STATE = 'EMPLOYEE GOWN ISSUE'` is one garment issued. A scan is identified by `SUIT_BARCODE` + `INSERT_TIME` (the scan time, **Phoenix time**) and is counted once; `RECTIME` is not used.
- The **barcode master** (each barcode's type, color and size; the row with the latest `RECTIME` wins) decides scans that arrive as several rows with other values, and fills empty values.
- Oracle values are mapped to GI's garment types, colors, sizes and locations in **Settings › Oracle values**. Stock counts issues from each location's **starting count** on.
- Barcodes not registered in the barcode master come through as GOWN / OTHER / OTHER and go to the location's **unregistered** line.

- [User Requirements Document](docs/URD.md)
- [Build plan](docs/BUILD_PLAN.md)
- [How GI processes scan data](docs/SCAN_STATES.md) — state diagrams of the import
- [Phone UX review and plan](docs/UX_PLAN.md)
- [To-do: open questions](docs/TODO.md)
- [Deployment SOP (Docker)](docs/DEPLOYMENT_SOP.md) — setting up a test environment
- [Kubernetes with Azure DevOps](docs/KUBERNETES_DEPLOYMENT.md) — deploying to the company cluster
- [Release notes](docs/RELEASE_NOTES.md) — what changed each day (Phoenix time)
- [UI mockups](design/mockups/) — open the `.dc.html` files in a browser

**Live demo:** https://hltsai9.github.io/GI/ — the frontend with recorded mock data, read-only (see [Demo on GitHub Pages](#demo-on-github-pages)).

## Repository layout

```
backend/    Python API (FastAPI), MariaDB, Oracle issue import
  gi/         API, stock ledger, import (look-back by INSERT_TIME, barcode master, classify, daily sweep,
              CSV uploads), mock Oracle data
  db/         SQL migrations (001 schema, 002 reference data; later changes get their own file) and the development seed
  tests/      pytest tests (run against a separate gi_test database)
frontend/   the web page: plain HTML, CSS and JavaScript modules, no build step;
            phone layout or laptop layout by device type
requirements.txt      Python packages for the image (requirements-dev.txt adds the test tools)
Dockerfile            one image: Python base image + requirements.txt + backend + web page
docs/       URD, build plan, to-do list, deployment SOPs, release notes
deploy/     docker-compose.yml, .env.example, backup.sh (Docker); k8s/ manifests and azure-pipelines.yml (Kubernetes)
design/     original UI mockups and the Broadsheet design system
```

## Running it locally

Needs Python 3.10+ and MariaDB 10.11+ (11.4 LTS in production). No Node.js.

```bash
# 1. Databases (once)
mariadb -uroot -e "CREATE DATABASE gi; CREATE DATABASE gi_test;
  CREATE USER 'gi'@'localhost' IDENTIFIED BY 'gi';
  GRANT ALL ON gi.* TO 'gi'@'localhost'; GRANT ALL ON gi_test.* TO 'gi'@'localhost';"

# 2. Python packages (once)
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt

# 3. Run
cd backend
cp .env.example .env              # defaults use the mock Oracle data
python -m gi.cli.demo             # resets the dev DB, imports, starting counts, daily deliveries
python -m gi.server               # web page and API on http://localhost:8000, import every 5 min
```

The backend serves the web page from `frontend/`, so there is nothing else to start. Edit a file in `frontend/` and reload the page.

In development there is no SSO yet: choose the user (floor staff, lead, admin, viewer) in **Settings › This device**; Admin needs the passcode set in `ADMIN_PASSCODE`. The layout switch there overrides the device detection on that device.

What each role can do in Settings: Sizes & colors, Correct stock and Full count — floor staff, lead, admin; Data quality — lead and admin; Oracle values and Import (CSV uploads, barcode master, alerts) — admin only. Viewers only read.

### Where issues come from (`ISSUE_SOURCE`)

| Setting | Issues | Barcode master |
|---|---|---|
| `mock` (default) | generated test data, imported every 5 minutes | generated with it |
| `oracle` | read from `ORACLE_ISSUE_TABLE` every 5 minutes (from the newest scan minus 24 hours), plus a daily 3-day sweep | read daily from `ORACLE_BARCODE_MASTER_TABLE`, and asked directly when a scan needs it |
| `csv` | uploaded by the admin in **Settings › Import** | uploaded there too |

### Mock Oracle data

With `ISSUE_SOURCE=mock` the backend generates rows that behave like the real issue table: `INSERT_TIME` (scan time) in Phoenix time, records reaching the database in batches up to ~15 hours after the scan (and now and then ~30 hours, beyond the import's look-back, for the daily sweep to find), about 3 % unregistered barcodes reported as GOWN / OTHER / OTHER, about 2 % re-labelled barcodes (two barcode master rows, so each scan arrives twice with different sizes), a few empty colors, an unmapped size code (`5XL`), an ignored `TEST` location, and other `STATE`s. Its location codes are mapped to P1 and P2 by the mock value mapping. Rows scanned "in the future" become visible as time passes, so a running server keeps importing new issues. The rows for a given day are always the same, so several servers import identical data.

The rows are generated in memory (45 days back, 2 ahead, regenerated each day). To look at them, write them to files: `python -m gi.mock_oracle --out mock-oracle-data` (`issues.ndjson` and `barcode_master.ndjson`; the server then reads `MOCK_ORACLE_DIR` instead).

To read the real Oracle database instead, set `ISSUE_SOURCE=oracle` and the `ORACLE_*` settings in `backend/.env` (`ORACLE_INSERT_TIME_ZONE` is `America/Phoenix`). All settings are listed in the [Deployment SOP](docs/DEPLOYMENT_SOP.md) §15.1.

### Checks

```bash
cd backend && python -m pytest                    # unit + integration tests (needs gi_test)
node --test frontend/tests/*.test.mjs            # optional, if Node.js happens to be installed
```

A new file in `frontend/js` must also be added to the `modulepreload` list in `frontend/index.html` (a test checks it).

Other commands: `python -m gi.cli.import_once [--master] [--backfill] [--sweep]` runs one import (`--master` reads the barcode master first); `python -m gi.cli.reset_dev` resets the dev database; `python -m gi.migrate` applies the migrations.

## Demo on GitHub Pages

GitHub Pages cannot run the backend or MariaDB, so the published page is the web page in **demo mode**: it reads API responses recorded from the demo database (`frontend/demo-data`) and refuses every change. The workflow `.github/workflows/pages.yml` copies `frontend/` as it is (switching `config.js` to demo mode) on every push that touches `frontend/`.

To refresh the recorded data: `cd backend && python -m gi.cli.demo && python -m gi.cli.export_demo`, then commit `frontend/demo-data`.

One-time setup: in the repository's **Settings › Pages**, set **Source** to **GitHub Actions**.
