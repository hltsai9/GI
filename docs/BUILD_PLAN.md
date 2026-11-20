# Build Plan — Cleanroom Garment Inventory (GI)

Companion to the [URD](./URD.md). Requirement IDs (e.g. `RCV-01`, `ORA-02`) refer to that document.

## 1. Architecture

```
 Phone / laptop browser
        │  HTTPS (intranet: garments.fab.local)
        ▼
 ┌──────────────────────────────┐
 │ Web app (single page)        │  plain HTML, CSS, JavaScript modules
 │  (no build step)             │
 │  - layout by device type:    │
 │    phone → top tabs,         │
 │    laptop → left sidebar     │
 │  - delivery draft kept in browser storage
 │  - Broadsheet design tokens
 └──────────────┬───────────────┘
                │ JSON REST (OpenAPI)
 ┌──────────────▼───────────────┐            ┌───────────────────────────┐
 │ API service                  │            │ Oracle DB (issuing system)│
 │  Python (FastAPI), pydantic  │            │  read-only account        │
 │  - auth (OIDC / SSO), RBAC   │            │  rows with STATE =        │
 │  - stock ledger service      │            │  'EMPLOYEE GOWN ISSUE'    │
 │                              │            │  (1 row = 1 garment)      │
 │                              │            └────────────▲──────────────┘
 │  - scheduler:                │                         │ SELECT only,
 │     · Oracle issue import ───┼─────────────────────────┘ every 5 min–12 h
 │     · daily snapshot, alerts │
 └──────────────┬───────────────┘
                ▼
   MariaDB 11.4 LTS, InnoDB, utf8mb4  (SQLAlchemy Core over PyMySQL; plain SQL migrations)
```

**Why**: the company CI builds images from its own Python base image, layered with `requirements.txt`, so the backend is Python and the web page needs no build step (no Node.js anywhere; decided 2026-11-19). One web app serves phones and laptops with nothing to install, choosing its layout by device type (§1.2); MariaDB InnoDB transactions with row locks keep deliveries and imported issues consistent (NFR-06/07). Oracle is read with `python-oracledb` in **thin mode** (pure Python — no Oracle Instant Client to install on the server). MariaDB is fixed; the web/API layers can be swapped for an IT-standard stack without changing the data model or phases.

### 1.1 Repository layout

```
backend/gi/       FastAPI app + scheduler (Oracle import, sweep, alerts), mock Oracle data generator
backend/db/       migrations (plain SQL) and the development seed
frontend/         web page: index.html, css/, js/ (ES modules, no build); phone and laptop layouts
requirements.txt  Python packages for the image
design/mockups/   source mockups (reference only)
docs/             URD, build plan, to-do list
```

### 1.2 Layout by device type

- At start-up the web app classifies the device once:
  1. a saved manual choice ("Switch to phone / laptop view", stored per device in `localStorage`), else
  2. `navigator.userAgentData.mobile` (User-Agent Client Hints), else
  3. the user-agent string (`iPhone`, `Android … Mobile`, `Mobile`).
  Phone → **phone layout**; anything else → **laptop layout**. **Tablets get the laptop layout** (decided) — they already report as non-mobile (iPadOS Safari identifies as a Mac; Android tablets omit `Mobile`), so no special case is needed; touch-size targets apply when `(pointer: coarse)`.
- The result is kept in the app state and set as `data-device="phone|laptop"` on `<html>`. The pages share their data and logic; the layout differs through CSS and a few `device` checks (e.g. Settings: segmented control on laptop, dropdown on phone).
- Resizing or rotating never swaps layouts. Inside each layout, CSS still flexes (phone 320–480 px, both orientations; laptop ≥ 1024 px).
- Device detection lives in one small module with unit tests over a table of real user-agent strings.

### 1.3 Configuration

All environment-specific values are set at installation in a `.env` file (or the host's secret store) — never committed. The repository ships `.env.example` with placeholders only.

| Key | Purpose |
|---|---|
| `ORACLE_CONNECT_STRING` | Oracle host / service (Easy Connect) |
| `ORACLE_USER`, `ORACLE_PASSWORD` | Read-only account (password as a secret) |
| `ORACLE_ISSUE_TABLE` | Issue table or view, `SCHEMA.TABLE` |
| `ORACLE_SUIT_TABLE` | Optional suit master table, only for late registration (DQ-08); empty = not used |
| `ORACLE_SWEEP_DAYS` | Days of `INSERT_TIME` re-checked by the daily catch-up sweep (default 3) |
| `ORACLE_TIME_TOLERANCE_MINUTES` | How far `RECTIME` may be before `INSERT_TIME` before it is alerted (default 10) |
| `ORACLE_POLL_SECONDS`, `ORACLE_OVERLAP_MINUTES`, `ORACLE_MAX_ROWS` | Import interval (300 s to 43,200 s = 12 h; default 300), overlap and batch size (defaults 10 / 5000). A run keeps reading batches until it has caught up. |
| `MARIADB_URL` | GI database |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | SSO |
| `SITE_TIMEZONE` | Time zone for calendar days and display (default `America/Phoenix` — both fabs are in Phoenix) |
| `ORACLE_INSERT_TIME_ZONE`, `ORACLE_RECTIME_ZONE` | Zones of the Oracle columns (defaults `Asia/Taipei`, `America/Phoenix`) |

Table names cannot be bind variables, so the API validates them at start-up against `^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z][A-Za-z0-9_$#]*)?$` and refuses to start otherwise (ORA-11). An admin "Test connection" checks access and that the expected columns exist.

### 1.4 Where the first build differs from this plan

- Deployment: one Docker image (`Dockerfile` at the root: a Python base image + `requirements.txt` + the app) in which the backend also serves the web page, plus MariaDB, with `deploy/docker-compose.yml`; steps in [DEPLOYMENT_SOP.md](./DEPLOYMENT_SOP.md).
- Kubernetes: `deploy/k8s/` and `deploy/azure-pipelines.yml`; replicas coordinate the import and migrations with MariaDB `GET_LOCK` ([KUBERNETES_DEPLOYMENT.md](./KUBERNETES_DEPLOYMENT.md)).

- Python backend (FastAPI, SQLAlchemy Core, PyMySQL, python-oracledb) and a no-build web page (plain JavaScript modules with a ~150-line view helper, `frontend/js/dom.js`) instead of Node.js/TypeScript and React. The first build (2026-11-18) used Node.js and React; it was rewritten on 2026-11-19 because the company CI builds from a Python base image. The API paths and JSON did not change.
- Two folders, `backend/` and `frontend/`, instead of a monorepo with shared `packages/`.
- Plain SQL migrations (`backend/db/migrations`) instead of an ORM: the schema is reviewed as real DDL.
- Mock Oracle data is generated in memory by the server (deterministic per day), so no files or volumes are needed.
- Trends are computed directly from the ledger, deliveries and issues; `daily_snapshot` exists but is not filled until 90-day charts get slow.
- Alerts go to one `admin_alert` table (time check, sweep found rows, stale or failed import) instead of a separate `time_check_alert`.
- Issue polling pages on (`RECTIME`, `SUIT_BARCODE`), not `RECTIME` alone: many rows share a second, and a page ending inside such a group skipped the rest (found by the catch-up sweep during the first test run).
- Classification order: an incomplete (GOWN / OTHER / OTHER) row only needs `SUIT_LEVEL` mapped; it is never held for its OTHER color or size.
- **CSV upload of Oracle exports** (Settings › Import, admin; `ISSUE_SOURCE=csv` turns off the automatic import): for sites that cannot reach Oracle. Rows go through the same import, so the ORA-02 rule (each `SUIT_BARCODE` + `INSERT_TIME` once) also covers re-uploads and a later switch to the live connection; watermarks are not touched. A file with any unreadable row is rejected as a whole. Times must include seconds.
- **Unregistered barcodes can be left out of the issued numbers one by one** (Settings › Data quality, lead or admin; table `excluded_barcode`). Their issues get status `ignored` and their stock movements are reversed with `issue_correction` ledger entries dated at the issue time, so Trends, the unregistered bucket and the Stock warning stay consistent; new imports of that barcode are ignored too. "Count again" re-classifies them. (Replaces the all-or-nothing switch of 2026-11-20.)
- **Settings sections by role** (hidden when the user can do nothing there; the API enforces the same): Sizes & colors, Correct stock, Full count — floor staff, lead and admin; Data quality — lead and admin; Oracle values, Import — admin only; This device — everyone.
- **Locations are named P1 and P2** (were Fab1 / Fab2; 2026-11-20). **Garment types have a counting unit** (`garment_type.unit`: pieces; boots in pairs), shown next to quantities.
- **Dev sign-in: Admin needs a passcode** (`ADMIN_PASSCODE`, a secret). Unlocking returns a signed token (HMAC, valid `ADMIN_TOKEN_HOURS`, default 12) that the page sends as `X-Admin-Token`; without it the API refuses the admin user. SSO will replace this.
- **Barcodes are stored exactly as in Oracle, except trailing spaces** (`issue_import.suit_barcode` `VARCHAR(255)`, collation `utf8mb4_nopad_bin`): case, leading and inner spaces matter for the "each row once" rule and the data quality list. Trailing spaces are padding (Oracle `CHAR` columns, aligned exports) and are removed by both the CSV upload and the live import (`clean_barcode`).
- Not built yet: SSO (a dev user picker stands in), email/Teams digest (ALR-02), late registration (DQ-08), estimated split (DQ-09), correction approval rules (HIS-07), CSV upload for the starting count.


## 2. Data model (MariaDB)

```
-- Reference data
garment_type(id, code, name, plural, icon, sort, active, is_system)  -- Gown, Hood, Boot; soft delete via active (SET-03);
color(id, name, sort, active, is_system)                              --   is_system = the hidden "Unregistered" value
size(id, code, sort, active, is_system)                               --   of each (DQ-03)
location(id, code, name)                                           -- Fab1, Fab2

-- Current balance: one row per garment × color × size × location
stock_item(id, garment_type_id, color_id, size_id, location_id,
           on_hand INT (signed — may go negative, URD rule 7.4), min_qty INT UNSIGNED NULL,
           updated_at, UNIQUE(garment_type_id, color_id, size_id, location_id))
           -- unregistered bucket = per location, the item whose type, color and size are the system "Unregistered" values

-- Deliveries
delivery(id, received_at, created_at, created_by → app_user,      -- received_at may be back-dated (RCV-08);
         status ENUM(posted,corrected,voided), note,               -- created_at = when it was entered
         idempotency_key UNIQUE)
delivery_line(id, delivery_id, stock_item_id, qty_original, qty_current)
delivery_correction(id, delivery_id, user_id → app_user, at,       -- one row per Save correction / Void (HIS-04/05)
                    is_void BOOL, total_delta INT, note)

-- Oracle issue import
oracle_value_map(id, oracle_column ENUM(SUIT_TYPE,SUIT_COLOR,SUIT_SIZE,SUIT_LEVEL), oracle_value,
                 garment_type_id NULL, color_id NULL, size_id NULL, location_id NULL,
                 is_ignored BOOL, row_count, first_seen, last_seen, updated_by, updated_at,
                 UNIQUE(oracle_column, oracle_value),
                 CHECK: is_ignored, or exactly the FK matching oracle_column is set)          -- MAP-*
issue_import(id, suit_barcode, insert_time DATETIME, rectime DATETIME,   -- raw Oracle DATE values (seconds), local to their zones
             suit_type, suit_color, suit_size, suit_level,
             issued_at DATETIME(6), recorded_at DATETIME(6),  -- INSERT_TIME and RECTIME converted to UTC
             issued_day DATE,                          -- site-time day of issued_at (what Trends count by)
             location_id NULL, stock_item_id NULL,     -- set when mapped
             quality ENUM(complete,incomplete,recovered),               -- DQ-01/03; recovered only via DQ-08
             status ENUM(applied,held_unmapped,before_start,ignored),
             imported_at,
             UNIQUE(suit_barcode, insert_time),                         -- ORA-02 (no EMPLOYEE_ID / INSERT_USER)
             INDEX(issued_day), INDEX(issued_at), INDEX(status), INDEX(suit_barcode))
dq_pattern(id, suit_type, suit_color, suit_size, active)                 -- e.g. GOWN / OTHER / OTHER
starting_count(location_id PK, as_of DATETIME(6), entered_by → app_user) -- URD rule 7.8
sync_watermark(suit_level PK, last_rectime DATETIME, updated_at)      -- one per SUIT_LEVEL; raw RECTIME (Phoenix time)
sync_run(id, kind ENUM(poll,sweep), started_at, finished_at,
         rows_read, rows_new, rows_applied, rows_held, rows_incomplete,
         rows_time_check_failed,                                         -- ORA-13
         first_issued_day DATE NULL, last_issued_day DATE NULL,          -- days touched → snapshot rebuild (§2.2)
         status ENUM(ok,failed), error)

-- Stock history: every change to on_hand, append-only (AUD-01/03)
ledger_entry(id, stock_item_id, at DATETIME(6),
             kind ENUM(starting_count,delivery,delivery_correction,issue,issue_correction,stock_correction),
             delta INT, qty_before INT, qty_after INT,
             source ENUM(user,oracle_import), user_id NULL → app_user,  -- user_id set iff source = user
             delivery_line_id NULL, delivery_correction_id NULL,
             issue_import_id NULL, stock_correction_id NULL,
             CHECK: exactly one cause FK is set, matching kind,
             INDEX(stock_item_id, at), INDEX(at))

stock_correction(id, stock_item_id, counted, system_qty, user_id → app_user, at, note,
                 reason ENUM(starting_count,spot_check,damaged,found,miscount_at_delivery,other))  -- ADJ-03
audit_log(id, at, user_id → app_user, entity, entity_id,           -- minimums, sizes/colors, value mapping,
          action ENUM(create,update,deactivate,restore), before JSON, after JSON)  -- DQ patterns, roles (AUD-02)
app_user(id, sso_subject UNIQUE, name, role ENUM(floor,lead,viewer,admin), active)

-- Trends cache (rebuildable from the tables above)
time_check_alert(id, issue_import_id, sync_run_id, gap_hours DECIMAL(9,2),   -- ORA-13: RECTIME before scan,
                 future_scan BOOL, alerted_at NULL, acknowledged_by NULL, acknowledged_at NULL)  -- or scan in the future
daily_snapshot(day DATE, stock_item_id, on_hand INT NULL, delivered INT, issued INT,
               PRIMARY KEY(day, stock_item_id))  -- on_hand NULL for days before the location's starting count
```

Invariant: `stock_item.on_hand = Σ ledger_entry.delta` for that item. Every write — delivery, correction, imported issue — goes through one `StockLedger.apply()` inside an InnoDB transaction with `SELECT … FOR UPDATE` on the affected stock items, locked in ascending `id` order; the transaction is retried on deadlock (error 1213).

Design notes:

- **Balance vs history.** `stock_item` holds only the current balance (one row per item). The history is `ledger_entry`; stock on any past date is `Σ delta` up to that time. Issued per day comes from `issue_import.issued_day` (scan day, site time); delivered per period from `delivery_line.qty_current` by `delivery.received_at`.
- **Real foreign keys instead of "type + id" pairs.** Both `oracle_value_map` and `ledger_entry` use one nullable FK per possible target plus a `CHECK`, so MariaDB enforces every reference.
- **Timestamps.** `INSERT_TIME` and `RECTIME` are Oracle `DATE` columns (seconds, no time zone), so their raw copies are `DATETIME` (seconds) and `UNIQUE(suit_barcode, insert_time)` compares them exactly. Times GI creates itself use `DATETIME(6)`.
- **Unregistered bucket.** A hidden system garment type, color and size called "Unregistered" (`is_system = true`, never shown in pickers or per-type totals); each location's bucket is the stock item using all three. Per-type queries filter `is_system = false`; location and grand totals include the bucket.
- **Names.** `app_user` instead of `user`, and `is_ignored` instead of `ignore` (a reserved word in MariaDB), so no identifier needs quoting. Reserved words only matter for table and column names; ENUM values such as `'user'` or `'ignored'` are quoted strings and need no change.
- **How issues reach the ledger.** Importing never edits a ledger entry. For each `issue_import` row that is `applied`, the import **inserts** one new `ledger_entry` (kind `issue`, delta −1, `issue_import_id` → that row) and updates `stock_item.on_hand` in the same transaction. Rows that are `held_unmapped`, `before_start` or `ignored` create no ledger entry; a held row gets its entry when its value is mapped. Any later fix — e.g. late registration (DQ-08) — is another new entry (kind `issue_correction`), never a change to the old one.

### 2.1 MariaDB notes

- InnoDB, `utf8mb4` / `utf8mb4_unicode_ci`, server time zone UTC; API converts to site time.
- Line and import quantities use `INT UNSIGNED` / `CHECK (qty > 0)`; `on_hand` is signed on purpose.
- IDs `BIGINT UNSIGNED AUTO_INCREMENT`; timestamps `DATETIME(6)`, stored in UTC.
- App DB user has `INSERT, SELECT` only on `ledger_entry`.
- Trend queries read `daily_snapshot` — built by the API scheduler, not MariaDB events, so jobs live in source control. See §2.2 for when it is rebuilt.
- Backups: nightly `mariadb-backup` + binlogs for point-in-time recovery.
- Volume: about 1,000 issues a day ≈ 365,000 rows a year in each of `issue_import` and `ledger_entry` — no partitioning needed.

### 2.2 Snapshot rebuilds and the import interval

`daily_snapshot` is a cache, so any change dated in the past must refresh it. Days are site-time calendar days (`SITE_TIMEZONE`), and every issue is counted on `issued_day` — the site-time day of its scan (`INSERT_TIME`) — **not** the day it was entered (`RECTIME`) or imported.

- After each import run: rebuild the snapshot rows for every day from `sync_run.first_issued_day` to `last_issued_day` (a 12-hourly run after midnight touches yesterday and today).
- After a back-dated delivery, a delivery correction or a stock correction: rebuild from that day to today.
- Nightly at 00:30: rebuild yesterday and today as a safety net.
- The current day is always read live from the ledger and `issue_import` for "today so far".

So the import interval (`ORACLE_POLL_SECONDS`, from 5 minutes up to 12 hours) never changes the per-day totals; it only changes how soon they are complete (see URD ORA-01).


## 3. Oracle issue import design

### 3.1 Query (every `ORACLE_POLL_SECONDS`, single-instance lock so runs never overlap)

```sql
SELECT SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL,
       INSERT_TIME, RECTIME
  FROM <ORACLE_ISSUE_TABLE>                        -- from configuration (§1.3), validated identifier
 WHERE STATE = 'EMPLOYEE GOWN ISSUE'
   AND SUIT_LEVEL = :level                         -- one query per location (SUIT_LEVEL)
   AND RECTIME > :levelWatermark - INTERVAL '10' MINUTE   -- when the record was entered; overlap for late commits
 ORDER BY RECTIME
 FETCH FIRST :maxRows ROWS ONLY                    -- Oracle 12c+; ROWNUM wrapper if older
```

Plus, in the same run, a **discovery query** for locations GI has no watermark for yet: `SUIT_LEVEL NOT IN (:knownLevels) AND RECTIME > :oldestWatermark − overlap`. A new `SUIT_LEVEL` found this way gets its own watermark from then on.

**Daily catch-up sweep** (03:00 site time): re-read every row with `INSERT_TIME` from `ORACLE_SWEEP_DAYS` (default 3) days ago onwards — with **no upper limit**, so a row stamped with a future scan time is also caught — and import any that are missing. Rows already present are skipped by the unique key, so a normal sweep imports nothing. If it does import rows, the polling missed them: the admin is alerted with the barcodes, locations and times, so the cause can be found.

- Bind variables for all values; `EMPLOYEE_ID`, `INSERT_USER`, `INOUT_CATEGORY` and `INOUT_ACTION` are not selected (not needed).
- Rows are append-only in Oracle (never edited or deleted), so only new rows need reading; the overlap only covers rows committed late.
- **Watermark on `RECTIME`, not `INSERT_TIME`.** `INSERT_TIME` is the scan time; a record entered hours later still carries the old scan time and would fall behind an `INSERT_TIME` watermark and never be read.
- **One watermark per location.** `RECTIME` only increases *within* a location (`SUIT_LEVEL`); across locations a later-arriving row can carry an earlier `RECTIME`. With a single watermark, Fab1's newest row could push the watermark past Fab2 rows that arrive afterwards with earlier times, and those would be skipped. So each `SUIT_LEVEL` keeps its own watermark (`sync_watermark`) and is queried separately.
- Watermarks are kept as raw `RECTIME` values (Phoenix local time), so the query compares like with like and no conversion happens inside Oracle.
- The sweep is the safety net for anything the watermarks cannot see (an ordering quirk not yet known, a clock problem); it is cheap — about 3 days of rows, nearly all skipped.
- Indexes on `(STATE, SUIT_LEVEL, RECTIME)` and `(STATE, INSERT_TIME)` are advisable — TODO with the DBA.
- **Time zones** (ORA-12): Oracle `DATE` columns are read as plain local date-times (the query formats them with `TO_CHAR`). GI converts them explicitly — `INSERT_TIME` from `ORACLE_INSERT_TIME_ZONE` (Taipei, UTC+8) and `RECTIME` from `ORACLE_RECTIME_ZONE` (Phoenix, UTC−7) — to UTC `issued_at` / `recorded_at`, and derives `issued_day` in `SITE_TIMEZONE` (Phoenix). Example: `INSERT_TIME` 20 Nov 09:00 (Taipei) = 19 Nov 18:00 in Phoenix → counted on **19 Nov**. It never relies on the Oracle session or server time zone. Neither zone has daylight saving, so the offsets are fixed (Taipei is 15 hours ahead of Phoenix). If the columns turn out to be `TIMESTAMP WITH TIME ZONE`, the stored zone is used instead (check on site).

### 3.2 Processing each row (one MariaDB transaction per batch)

Only the server sets `status`; no screen edits it directly. One function, `classifyIssue(row)`, decides `status`, `quality` and `stock_item_id`, and is used by the import **and** by every action that can change the answer later (§3.3), so a row is always classified by the same rules.

1. **De-duplicate**: insert into `issue_import` keyed by `(suit_barcode, insert_time)`; rows already present are skipped (ORA-02). Set `issued_at`, `recorded_at` and `issued_day`.
   **Time check** (ORA-13): if `recorded_at` is more than `ORACLE_TIME_TOLERANCE_MINUTES` (default 10) before `issued_at`, or `issued_at` is in the future, the row is still imported normally (counted on its `INSERT_TIME` day) and listed in `time_check_alert`; at the end of the run the admin gets **one alert per run** listing every such row. During the historic backfill they are only summarised.
   Such a row is also why the sweep matters: with a `RECTIME` days in the past it falls behind its location's watermark and is found only by the sweep (which reads by `INSERT_TIME`).
2. **`classifyIssue`** — checks in this order; the first match wins:

   | # | Check | Result |
   |---|---|---|
   | a | Any of the four values is mapped to Ignore (`is_ignored`) | `ignored` — no stock item |
   | b | Any of the four values is not mapped yet | `held_unmapped` — no stock item |
   | c | Data quality (`dq_pattern`, today GOWN / OTHER / OTHER = barcode not registered in the suit master) | sets `quality` and the stock item: complete → the real item; incomplete → the location's unregistered bucket (type unknown) |
   | d | The location has no starting count yet, or `issued_at` is before its `as_of` | `before_start` — Trends only |
   | e | Otherwise | `applied` |

   Ignore is checked before unmapped, so a row from an ignored location (e.g. a test area) is never held just because it also has a new size code.
3. **Apply**: only `applied` writes to stock — `StockLedger.apply(issue, −1)` inserts one ledger entry (`source = oracle_import`, `issue_import_id` set). All other statuses touch no stock and no ledger.
4. Advance each location's watermark (highest `RECTIME` read for that `SUIT_LEVEL`) only after commit; write `sync_run` with counts per status and the range of **issue days** touched (records entered late touch past days); rebuild those days' snapshots (§2.2).

`quality` and `status` are independent: an `incomplete` row can be `applied` (to the unregistered bucket) or `before_start`.

### 3.3 Status changes after import

| From | To | Triggered by | Ledger |
|---|---|---|---|
| — (new row) | `ignored` / `held_unmapped` / `before_start` / `applied` | Import run, via `classifyIssue` | −1 entry only for `applied` |
| `held_unmapped` | `ignored` / `before_start` / `applied` | Lead or admin maps the missing value (or sets it to Ignore) → all held rows using that value are re-classified in one transaction | −1 entry for each row that becomes `applied` |
| `before_start` | `applied` | Starting count saved for that location → its `before_start` rows with `issued_at ≥ as_of` are re-classified | −1 entry for each |

- **Why the starting-count step matters:** floor staff finish counting at, say, 14:00, but the counts may be entered at 16:00. Imports between 14:00 and 16:00 find no starting count and set `before_start` — including issues after 14:00 that should reduce stock. Saving the count (as-of 14:00) re-classifies those, so nothing is lost. The same covers Fab2 going live after Fab1: Fab2 rows stay `before_start` until Fab2's count is saved.
- **Final states:** `applied`, and `before_start` rows earlier than the as-of time never change again. `ignored` rows stay ignored if the value is later un-ignored — changing an existing mapping applies only to new rows (MAP-03, TODO).
- Each re-classification is a single transaction, recorded in `audit_log` with the number of rows changed.
- **Late registration** (DQ-08, only if the TODO confirms barcodes get registered after being issued): each import run checks the unregistered barcodes against `ORACLE_SUIT_TABLE`; for each one now registered, its `applied` unregistered-bucket rows move to the real item with a pair of new `issue_correction` entries (+1 unregistered bucket, −1 real item) and `quality = recovered`. Status stays `applied`.

### 3.4 Other paths

- **Failure**: Oracle unreachable → run fails, watermarks unchanged, next run catches up; no successful run for more than twice the poll interval → banner + admin alert (ORA-07).
- **Backfill** (ORA-09): same code path from a start date in batches; everything before the cut-off lands as `before_start`.
- **Data quality report** (DQ-05): `issue_import` grouped by day, location, `quality`; unregistered-barcode list = distinct `suit_barcode` of `incomplete` rows with counts and first/last seen.
- **Daily catch-up sweep** (§3.1) replaces a count-only reconciliation: it re-reads the last 3 days by `INSERT_TIME` (records are entered within about 15 hours of the scan), imports anything missing and alerts if it found any.

## 4. API sketch

| Method & path | Purpose | Req |
|---|---|---|
| `GET /meta` | garment types, active colors, sizes, locations | SET-02 |
| `POST /deliveries` (Idempotency-Key) | post a delivery | RCV-05/06 |
| `GET /deliveries?limit=` | history | HIS-01 |
| `POST /deliveries/:id/correction` | correct / void | HIS-04/05 |
| `GET /stock/summary` | totals, days of cover, reorder top 5, by location, today | STK-01..05 |
| `GET /stock/grid?type=&location=` | size × color cells with status | GRD-02 |
| `GET /stock/items/:id`, `PATCH /stock/items/:id/min` | detail, minimum | GRD-03/04 |
| `POST /corrections`, `GET /corrections` | stock correction, log | ADJ-* |
| `GET /trends/delivered?days=&per=day\|week\|month` | delivered per period | TRD-01 |
| `GET /trends/issued?days=` | issued per day | TRD-02 |
| `GET /trends/stock?days=` | stock over time + deliveries vs issues | TRD-03/04 |
| `GET /trends/breakdown?days=&metric=` | by size / location | TRD-06 |
| `GET /sync/status`, `GET /sync/runs`, `POST /sync/run` | import status, history, run now | ORA-07/08 |
| `GET /oracle-values?column=&unmapped=`, `PUT /oracle-values/:id` | Oracle value mapping | MAP-* |
| `GET /data-quality?days=`, `GET/PUT /data-quality/patterns` | incomplete-row report, known-bad patterns | DQ-01/05 |
| `POST /starting-count` `{location, asOf, counts[]}` | starting count with cut-off | ADJ-05, rule 7.8 |
| `POST/DELETE /colors`, `/sizes`, `PATCH` order | master data | SET-* |

## 5. Phased delivery

Team assumption: 2 developers (1 full-stack lead + 1 frontend), part-time designer/QA, plus a contact on the Oracle issuing system. Sprints are 2 weeks.

### Phase 0 — Foundations + Oracle discovery (Sprint 1)
- Work through the vendor / DBA items in [`TODO.md`](./TODO.md). **Gate:** connection and read access with the configured table; the column types (`DATE`, confirmed) and time zones are already checked.
- On site, with the configured table: run `SELECT DISTINCT` on `SUIT_TYPE`, `SUIT_COLOR`, `SUIT_SIZE`, `SUIT_LEVEL` and draft the initial value mapping (MAP-04); measure the share of GOWN / OTHER / OTHER rows and how many distinct unregistered barcodes there are.
- Request the read-only Oracle account and firewall access from the GI server (long lead time — start day 1).
- Monorepo, lint/typecheck, CI (GitHub Actions: build, unit, integration against MariaDB 11.4 + Oracle Free service containers, e2e).
- Docker-compose dev env; `.env.example`; migrations; seed reproducing the mockup data plus synthetic Oracle issue and suit master tables with the real column names.
- Broadsheet tokens into `packages/ui`; app shell with device detection and the phone / laptop layouts (§1.2); auth stub + roles.

**Exit**: app shell on a dev server; Oracle columns, keys and values understood; CI green.

### Phase 1 — Ledger + Receive (Sprints 2–3)
- `StockLedger.apply()`, invariant check job.
- Receive › New delivery (RCV-01..08) with draft persistence and idempotent post.
- Receive › History with correction / void (HIS-01..06).

**Exit**: floor staff can post and correct deliveries on a phone.

### Phase 2 — Oracle issue import + data quality (Sprints 4–5)
- Import job (§3) with per-location `RECTIME` watermarks, discovery query, daily catch-up sweep, overlap, `(barcode, INSERT_TIME)` de-duplication, time zone conversion and check, held-unmapped handling.
- Data quality: known-bad patterns, unregistered bucket, data quality report with the unregistered-barcode list (DQ-01, 03–07); late registration (DQ-08) only if confirmed.
- Oracle values screen (MAP-01..05) and sync status / admin screen (ORA-07/08).
- Backfill of issue history (ORA-09).
- Integration tests against an Oracle Free container with the real column layout and sample rows, including GOWN / OTHER / OTHER rows.

**Exit**: real issues from Oracle (test or prod copy) flow into GI; re-runs are no-ops.

### Phase 3 — Stock views + starting count (Sprint 6)
- Stock › Summary (STK-01..05) and Grid with minimums (GRD-01..06), negative flag, unregistered-bucket line and notice (DQ-04).
- Starting count entry with per-location as-of time (ADJ-05, rule 7.8): size × color grid per garment and location on the phone, plus CSV import.
- Stock correction (ADJ-01..07); sizes & colors (SET-01..05).
- In-app below-minimum indicator (ALR-01).

**Exit**: the lead can load a starting count and see live calculated stock.

### Phase 4 — Trends + alerts (Sprint 7)
- `daily_snapshot` rebuild jobs (§2.2); Trends: delivered per period, issued per day, stock over time, deliveries vs issues, breakdowns (TRD-01..07).
- Daily digest and stale-import alert (ALR-02/03).

**Exit**: the lead's three questions are answered on phone and laptop; chart totals match the ledger.

### Phase 5 — Hardening, pilot, rollout (Sprints 8–9)
- Accessibility audit, load test (posting during import), backups, monitoring, runbook, production deploy.
- **Go-live at Fab1**: floor staff count everything at a quiet moment; counts entered in GI with the as-of time when counting finished.
- **2-week parallel run**: floor staff keep counting manually; compare against GI daily; investigate gaps (missing deliveries, unmapped items, Oracle timing).
- When the accuracy target is met, **stop manual counting at Fab1**; repeat starting count + a shorter parallel run at **Fab2**.

### Backlog
Size × color grid entry for deliveries (1a), receive against a standing order (1c), additional garment types (after the first release is stable), purchasing integration, approval workflow for corrections (HIS-07).

## 6. Timeline

| Sprint | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Phase | 0 Foundations + Oracle discovery | 1 Receive | 1 Receive | 2 Oracle import | 2 Oracle import | 3 Stock | 4 Trends | 5 Pilot Fab1 | 5 Rollout Fab2 |

≈ 14 weeks to Fab1 go-live, ≈ 18 weeks until manual counting stops at both fabs. The main schedule risk is Oracle access (Phase 0 gate).

## 7. Testing strategy

- **Unit** (`packages/domain`, ledger): status thresholds incl. negative, days of cover, delivery correction diff, void, line merge.
- **Import** (MariaDB + Oracle Free containers, real column names): idempotent re-run; overlap window; two rows with the same `INSERT_TIME`; same barcode issued twice at different times (both counted); late-committed row; other `STATE` values ignored; unmapped value → held → mapped → applied; GOWN / OTHER / OTHER booked to the unregistered bucket (and excluded from Gowns) and listed as unregistered; late registration moving earlier rows (if DQ-08 is built); row before vs after the starting-count cut-off; a 12-hour import crossing midnight books issues to the right days and rebuilds both days' snapshots; a record entered 15 hours after its scan is read (`RECTIME` watermark) and counted on the scan day; Fab2 rows arriving after Fab1 rows with earlier `RECTIME` are not skipped (per-location watermarks); a row the polls missed is found by the sweep; a new `SUIT_LEVEL` is discovered; Taipei→Phoenix day conversion around both midnights; rows with `RECTIME` before the scan are imported and counted; Oracle outage then catch-up; watermark advances only on commit.
- **Integration**: every write endpoint asserts the ledger invariant; delivery posted concurrently with an import run.
- **Device detection** (unit): table of real phone, tablet and laptop user-agent strings and client hints → expected layout; manual override.
- **E2E** (Playwright device profiles — e.g. iPhone 13 and Pixel 7 for phone, Desktop Chrome 1440×900 for laptop): URD §9 acceptance criteria in both layouts, plus a narrow laptop window still showing the laptop layout.
- **Pilot reconciliation**: daily GI vs manual count report during the parallel run; gowns compared at type level as well as per size while GOWN / OTHER / OTHER rows still occur.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Oracle access / account approval slow | Blocks Phase 2 | Request in Sprint 1; build against an Oracle Free container with the real column layout |
| Unregistered barcodes persist (vendor fix late) | Stock per type / size / color overstated, usage per type understated; below-minimum alerts late | Unregistered bucket per location, notice on Stock, unregistered-barcode list for the vendor, regular full spot checks clearing the bucket (DQ-*); total issued per day and location totals stay correct |
| `RECTIME` not indexed | Slow import, load on the issuing system | Ask the DBA for an index or view; smaller batches; longer interval |
| Time zones applied wrongly | Issues on the wrong day, wrong starting-count cut-off | Explicit, configurable zones; time check on every row (ORA-13); Phase 0 sample check (hour-of-day of scans should match Phoenix shifts); tests around both midnights |
| `RECTIME` not in order across locations, or other ordering quirks | Rows skipped by the import | Per-location watermarks; daily 3-day catch-up sweep with alert |
| Records entered up to ~15 hours after the scan | "Issued today" and stock lag by up to ~15 h; below-minimum alerts late; past days change | Count by scan day; rebuild touched days; "issues up to" stamp; regular spot checks |
| Device misdetected (e.g. new browser, tablet) | Wrong layout | Manual view switch remembered per device; detection tests with real UA strings |
| Deliveries not entered (or entered late) | Negative / wrong stock | Negative flag, daily digest, back-dating (RCV-08), pilot reconciliation |
| Starting count done while issuing continues | Off by a few items from day 1 | Count at a quiet moment, record as-of when finished, cut-off rule 7.8, parallel run |
| Concurrent writes / deadlocks | Lost updates | Single ledger write path, ordered row locks, retry on 1213 |

## 9. Definition of done (per feature)

Requirement IDs linked in the PR · unit + e2e tests · works in the phone layout (on phone device profiles) and the laptop layout · touch targets ≥ 44 px · ledger invariant test passes · design tokens only · reviewed and merged with CI green.
