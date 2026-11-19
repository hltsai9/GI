# GI — Cleanroom Garment Inventory

Web app with phone and laptop layouts (chosen by device type) that replaces manual garment counting in the Fab1 and Fab2 cleanrooms. Floor staff enter only the deliveries; garment issues are imported from the issuing system's Oracle database; stock on hand is calculated. The lead sees deliveries per period, issues per day and current stock. Data is stored in MariaDB.

- [User Requirements Document](docs/URD.md)
- [Build plan](docs/BUILD_PLAN.md)
- [To-do: open questions](docs/TODO.md)
- [UI mockups](design/mockups/) — open the `.dc.html` files in a browser

**Live demo:** https://hltsai9.github.io/GI/ — the frontend with recorded mock data, read-only (see [Demo on GitHub Pages](#demo-on-github-pages)).

## Repository layout

```
backend/    Node.js + TypeScript API (Fastify), MariaDB, Oracle issue import
  db/         SQL migrations and the development seed
  src/        API, stock ledger, import (classify, per-location watermarks, sweep)
  mock-oracle/  generator for mock Oracle issue data
  test/       Vitest tests (run against a separate gi_test database)
frontend/   React + TypeScript (Vite); phone layout or laptop layout by device type
docs/       URD, build plan, to-do list
design/     original UI mockups and the Broadsheet design system
```

## Running it locally

Needs Node.js 20+ and MariaDB 10.11+ (11.4 LTS in production).

```bash
# 1. Databases (once)
mariadb -uroot -e "CREATE DATABASE gi; CREATE DATABASE gi_test;
  CREATE USER 'gi'@'localhost' IDENTIFIED BY 'gi';
  GRANT ALL ON gi.* TO 'gi'@'localhost'; GRANT ALL ON gi_test.* TO 'gi'@'localhost';"

# 2. Backend
cd backend
npm install
cp .env.example .env            # defaults use the mock Oracle data
npm run mock:generate           # writes mock-oracle/data/*.ndjson (45 days + 2 ahead)
npm run demo                    # resets the dev DB, imports, starting counts, daily deliveries
npm run dev                     # API on http://localhost:3000, import every 5 min

# 3. Frontend (another terminal)
cd frontend
npm install
npm run dev                     # http://localhost:5173 (proxies /api to the backend)
```

In development there is no SSO yet: pick the user (floor staff, lead, admin, viewer) at the bottom of the menu. "Switch to phone / laptop view" overrides the device detection on that device.

### Mock Oracle data

`npm run mock:generate` creates rows that behave like the real issue table: `INSERT_TIME` in Taipei time and `RECTIME` in Phoenix time, records entered in batches up to ~15 hours after the scan, `RECTIME` ordered only within a location, about 3 % unregistered barcodes reported as GOWN / OTHER / OTHER, an unmapped size code (`5XL`), an ignored `TEST` location, other `STATE`s, and one row with a bad clock. Rows scanned "in the future" become visible as time passes, so a running server keeps importing new issues.

To read the real Oracle database instead, set `ISSUE_SOURCE=oracle` and the `ORACLE_*` settings in `backend/.env`.

### Checks

```bash
cd backend && npm run typecheck && npm test     # unit + integration tests (needs gi_test)
cd frontend && npm run build && npm test
```

## Demo on GitHub Pages

GitHub Pages cannot run the backend or MariaDB, so the published page is the frontend in **demo mode**: it reads API responses recorded from the demo database (`frontend/public/demo-data`) and refuses every change. The workflow `.github/workflows/pages.yml` builds and publishes it on every push that touches `frontend/`.

To refresh the recorded data: `cd backend && npm run mock:generate && npm run demo && npm run export:demo`, then commit `frontend/public/demo-data`.

One-time setup: in the repository's **Settings › Pages**, set **Source** to **GitHub Actions**.
