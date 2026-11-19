# Release notes

What changed on each working day, newest first. Dates are UTC (the commit dates).
Requirement IDs (e.g. `ORA-03`) refer to the [URD](./URD.md); open questions are in [TODO.md](./TODO.md).

---

## 2026-11-19

### App
- **Navigation icons**: Receive, Stock, Trends and Settings now use Phosphor Icons (Regular): truck, stack, chart-line-up, gear-six.
- **Phone tabs**: icon above the label, the four tabs share the width, so all fit even on a 320 px phone.
- **Demo on GitHub Pages is live**: https://hltsai9.github.io/GI/. It is the real frontend reading recorded mock data, and it is read-only (saving shows a "demo" message).

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

## 2026-11-18

- **Data model review applied**:
  - `app_user` / `is_ignored` names;
  - `DATETIME(6)`;
  - real foreign keys instead of "type + id" pairs;
  - `delivery_correction` table;
  - `issue_import.issued_at` / `location_id` plus indexes;
  - `audit_log`;
  - stock correction reasons as an `ENUM`;
  - snapshot stock empty before go-live.
- **Import interval** can be set from 5 minutes to 12 hours. Issues always count on the day they happened; a longer interval only delays them.

## 2026-10-22

- **Data model walkthrough** (review only, no file changes): how the current balance (`stock_item`) and the history (`ledger_entry`) work together, how trends are calculated, and a list of 10 schema fixes, applied on 2026-11-18.

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

## 2026-10-19

- **Project started** from the UI mockups: User Requirements Document (URD v0.1), build plan and the mockups added to the repository.
