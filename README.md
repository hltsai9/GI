# GI — Cleanroom Garment Inventory

Web app with phone and laptop layouts (chosen by device type) that replaces manual garment counting in the Fab1 and Fab2 cleanrooms. Floor staff enter only the deliveries; garment issues are imported from the issuing system's Oracle database; stock on hand is calculated. The lead sees deliveries per period, issues per day and current stock. Data is stored in MariaDB.

- [User Requirements Document](docs/URD.md)
- [Build plan](docs/BUILD_PLAN.md)
- [To-do: open questions](docs/TODO.md)
- [Deployment SOP (Docker)](docs/DEPLOYMENT_SOP.md) — setting up a test environment
- [Kubernetes with Azure DevOps](docs/KUBERNETES_DEPLOYMENT.md) — deploying to the company cluster
- [Release notes](docs/RELEASE_NOTES.md) — what changed each day (Phoenix time)
- [UI mockups](design/mockups/) — open the `.dc.html` files in a browser

**Live demo:** https://hltsai9.github.io/GI/ — the frontend with recorded mock data, read-only (see [Demo on GitHub Pages](#demo-on-github-pages)).

## Repository layout

```
backend/    Python API (FastAPI), MariaDB, Oracle issue import
  gi/         API, stock ledger, import (classify, per-location watermarks, sweep), mock Oracle data
  db/         SQL migrations and the development seed
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

In development there is no SSO yet: choose the user (floor staff, lead, admin, viewer) in **Settings › This device**. The layout switch there overrides the device detection on that device.

### Mock Oracle data

With `ISSUE_SOURCE=mock` the backend generates rows that behave like the real issue table: `INSERT_TIME` in Taipei time and `RECTIME` in Phoenix time, records entered in batches up to ~15 hours after the scan, `RECTIME` ordered only within a location, about 3 % unregistered barcodes reported as GOWN / OTHER / OTHER, an unmapped size code (`5XL`), an ignored `TEST` location, other `STATE`s, and now and then a row with a bad clock. Rows scanned "in the future" become visible as time passes, so a running server keeps importing new issues. The rows for a given day are always the same, so several servers import identical data.

The rows are generated in memory (45 days back, 2 ahead, regenerated each day). To look at them, write them to files: `python -m gi.mock_oracle --out mock-oracle-data` (the server then reads `MOCK_ORACLE_DIR/issues.ndjson` instead).

To read the real Oracle database instead, set `ISSUE_SOURCE=oracle` and the `ORACLE_*` settings in `backend/.env`.

### Checks

```bash
cd backend && python -m pytest                    # unit + integration tests (needs gi_test)
node --test frontend/tests/device.test.mjs        # optional, if Node.js happens to be installed
```

Other commands: `python -m gi.cli.import_once [--backfill] [--sweep]` runs one import; `python -m gi.cli.reset_dev` resets the dev database; `python -m gi.migrate` applies the migrations.

## Demo on GitHub Pages

GitHub Pages cannot run the backend or MariaDB, so the published page is the web page in **demo mode**: it reads API responses recorded from the demo database (`frontend/demo-data`) and refuses every change. The workflow `.github/workflows/pages.yml` copies `frontend/` as it is (switching `config.js` to demo mode) on every push that touches `frontend/`.

To refresh the recorded data: `cd backend && python -m gi.cli.demo && python -m gi.cli.export_demo`, then commit `frontend/demo-data`.

One-time setup: in the repository's **Settings › Pages**, set **Source** to **GitHub Actions**.
