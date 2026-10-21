# Build Plan — Cleanroom Garment Inventory (GI)

Companion to the [URD](./URD.md). Requirement IDs (e.g. `RCV-01`, `ORA-02`) refer to that document.

## 1. Architecture

```
 Phone / laptop browser
        │  HTTPS (intranet: garments.fab.local)
        ▼
 ┌──────────────────────────────┐
 │ Web app (SPA)                │  React + TypeScript + Vite
 │  - layout by device type:    │
 │    phone → top tabs,         │
 │    laptop → left sidebar     │
 │  - delivery draft kept in browser storage
 │  - Broadsheet design tokens
 └──────────────┬───────────────┘
                │ JSON REST (OpenAPI)
 ┌──────────────▼───────────────┐            ┌───────────────────────────┐
 │ API service                  │            │ Oracle DB (issuing system)│
 │  Node.js + TS (Fastify), Zod │            │  read-only account        │
 │  - auth (OIDC / SSO), RBAC   │            │  rows with STATE =        │
 │  - stock ledger service      │            │  'EMPLOYEE GOWN ISSUE'    │
 │                              │            │  (1 row = 1 garment)      │
 │                              │            └────────────▲──────────────┘
 │  - scheduler:                │                         │ SELECT only,
 │     · Oracle issue import ───┼─────────────────────────┘ every 5 min
 │     · daily snapshot, alerts │
 └──────────────┬───────────────┘
                ▼
   MariaDB 11.4 LTS, InnoDB, utf8mb4  (Drizzle ORM, mysql2 driver + migrations)
```

**Why**: one language end to end; one web app serves phones and laptops with nothing to install, choosing its layout by device type (§1.2); MariaDB InnoDB transactions with row locks keep deliveries and imported issues consistent (NFR-06/07). Oracle is read with `node-oracledb` in **thin mode** (pure JavaScript — no Oracle Instant Client to install on the server). MariaDB is fixed; the web/API layers can be swapped for an IT-standard stack without changing the data model or phases.

### 1.1 Repository layout (monorepo, pnpm workspaces)

```
apps/
  web/            React SPA
  api/            Fastify service + scheduler (Oracle import, snapshots, alerts)
packages/
  domain/         shared types, stock key, status rules, days-of-cover calc
  ui/             Broadsheet tokens + shared components (Segmented, Dropdown, Stepper, StatusCell, charts…)
design/mockups/   source mockups (reference only)
docs/             URD, build plan, to-do list, ADRs
.env.example      configuration template (no real values)
infra/            docker-compose (dev: MariaDB + Oracle Free container), deployment manifests
```

### 1.2 Layout by device type

- At start-up the web app classifies the device once:
  1. a saved manual choice ("Switch to phone / laptop view", stored per device in `localStorage`), else
  2. `navigator.userAgentData.mobile` (User-Agent Client Hints), else
  3. the user-agent string (`iPhone`, `Android … Mobile`, `Mobile`).
  Phone → **phone layout**; anything else → **laptop layout**. Tablets: TODO — default laptop layout, with touch-size targets when `(pointer: coarse)`.
- The result is stored in a React context (`DeviceContext`) and set as `data-device="phone|laptop"` on `<html>`. Each tab has a phone and a laptop **page component** sharing the same data hooks and domain logic; only composition differs (e.g. Stock: stacked cards on phone, grid + detail side by side on laptop).
- Resizing or rotating never swaps layouts. Inside each layout, CSS still flexes (phone 320–480 px, both orientations; laptop ≥ 1024 px).
- Device detection lives in one small module with unit tests over a table of real user-agent strings.

### 1.3 Configuration

All environment-specific values are set at installation in a `.env` file (or the host's secret store) — never committed. The repository ships `.env.example` with placeholders only.

| Key | Purpose |
|---|---|
| `ORACLE_CONNECT_STRING` | Oracle host / service (Easy Connect) |
| `ORACLE_USER`, `ORACLE_PASSWORD` | Read-only account (password as a secret) |
| `ORACLE_ISSUE_TABLE` | Issue table or view, `SCHEMA.TABLE` |
| `ORACLE_SUIT_TABLE` | Optional suit master table for DQ-08; empty = not used |
| `ORACLE_POLL_SECONDS`, `ORACLE_OVERLAP_MINUTES`, `ORACLE_MAX_ROWS` | Import schedule and batch (defaults 300 / 10 / 5000) |
| `MARIADB_URL` | GI database |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | SSO |
| `SITE_TIMEZONE` | Display time zone |

Table names cannot be bind variables, so the API validates them at start-up against `^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z][A-Za-z0-9_$#]*)?$` and refuses to start otherwise (ORA-11). An admin "Test connection" checks access and that the expected columns exist.

## 2. Data model (MariaDB)

```
garment_type(id, code, name, plural, icon, sort, active)          -- Gown, Hood, Boot
color(id, name, sort, active)                                      -- soft delete via active (SET-03)
size(id, code, sort, active)
location(id, code, name)                                           -- Fab1, Fab2
stock_item(id, garment_type_id, color_id, size_id, location_id,
           on_hand INT (signed — may go negative, URD rule 7.4), min_qty INT UNSIGNED NULL,
           is_unknown_bucket BOOL,             -- one per garment type × location, system color/size "Unknown" (DQ-03)
           updated_at, UNIQUE(garment_type_id, color_id, size_id, location_id))

delivery(id, received_at, created_by, status ENUM(posted,corrected,voided), note, idempotency_key UNIQUE)
delivery_line(id, delivery_id, stock_item_id, qty_original, qty_current)

-- Oracle issue import
oracle_value_map(id, oracle_column ENUM(SUIT_TYPE,SUIT_COLOR,SUIT_SIZE,SUIT_LEVEL), oracle_value,
                 gi_ref_id NULL, ignore BOOL, row_count, first_seen, last_seen, updated_by, updated_at,
                 UNIQUE(oracle_column, oracle_value))                  -- MAP-*
issue_import(id, suit_barcode, insert_time, rectime,                     -- copy of one Oracle row
             suit_type, suit_color, suit_size, suit_level,
             stock_item_id NULL,
             quality ENUM(complete,recovered,incomplete),               -- DQ-01..03
             status ENUM(applied,held_unmapped,before_start,ignored,reversed),
             ledger_entry_id NULL, imported_at,
             UNIQUE(suit_barcode, insert_time))                         -- ORA-02 (no EMPLOYEE_ID / INSERT_USER)
dq_pattern(id, suit_type, suit_color, suit_size, active)                 -- e.g. GOWN / OTHER / OTHER
barcode_profile(suit_barcode PK, garment_type_id, color_id, size_id,    -- color/size of this barcode (never changes),
                source ENUM(issue_history,suit_master), last_seen)       -- for recovery (DQ-02/08)
starting_count(location_id PK, as_of DATETIME(3), entered_by)            -- URD rule 7.8
sync_run(id, started_at, finished_at, from_watermark, to_watermark,
         rows_read, rows_applied, rows_held, rows_incomplete, rows_recovered, status ENUM(ok,failed), error)

ledger_entry(id, stock_item_id, at, actor (user id or 'oracle-import'),
             kind ENUM(starting_count,delivery,delivery_correction,issue,issue_correction,stock_correction),
             delta INT, qty_before, qty_after, ref_type, ref_id, reason, note)   -- append-only (AUD-01/03)

stock_correction(id, stock_item_id, counted, system_qty, reason, note, user_id, at)
min_change(id, stock_item_id, old_min, new_min, user_id, at)
user(id, sso_subject, name, role ENUM(floor,lead,viewer,admin))
daily_snapshot(date, stock_item_id, on_hand, delivered, issued)               -- feeds Trends
```

Invariant: `stock_item.on_hand = Σ ledger_entry.delta` for that item. Every write — delivery, correction, imported issue — goes through one `StockLedger.apply()` inside an InnoDB transaction with `SELECT … FOR UPDATE` on the affected stock items, locked in ascending `id` order; the transaction is retried on deadlock (error 1213).

### 2.1 MariaDB notes

- InnoDB, `utf8mb4` / `utf8mb4_unicode_ci`, server time zone UTC; API converts to site time.
- Line and import quantities use `INT UNSIGNED` / `CHECK (qty > 0)`; `on_hand` is signed on purpose.
- IDs `BIGINT UNSIGNED AUTO_INCREMENT`; timestamps `DATETIME(3)`.
- App DB user has `INSERT, SELECT` only on `ledger_entry`.
- Trend queries read `daily_snapshot` (rebuilt nightly, current day on demand) — built by the API scheduler, not MariaDB events, so jobs live in source control.
- Backups: nightly `mariadb-backup` + binlogs for point-in-time recovery.

## 3. Oracle issue import design

### 3.1 Query (every 5 min, single-instance lock so runs never overlap)

```sql
SELECT SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL,
       INSERT_TIME, RECTIME
  FROM <ORACLE_ISSUE_TABLE>                        -- from configuration (§1.3), validated identifier
 WHERE STATE = 'EMPLOYEE GOWN ISSUE'
   AND INSERT_TIME > :watermark - INTERVAL '10' MINUTE   -- overlap for late commits / equal timestamps
 ORDER BY INSERT_TIME
 FETCH FIRST :maxRows ROWS ONLY                    -- Oracle 12c+; ROWNUM wrapper if older
```

- Bind variables for all values; `EMPLOYEE_ID`, `INSERT_USER`, `INOUT_CATEGORY` and `INOUT_ACTION` are not selected (not needed).
- Rows are append-only in Oracle (never edited or deleted), so only new rows need reading; the overlap only covers rows committed late.
- An index on `INSERT_TIME` (ideally `STATE, INSERT_TIME`) is advisable — TODO with the DBA.
- Which of `INSERT_TIME` / `RECTIME` is the write time vs the issue time is a TODO; the watermark column and the "issued at" column are configurable until confirmed.
- `node-oracledb` thin mode; timestamps converted from the Oracle session time zone to UTC.

### 3.2 Processing each row (one MariaDB transaction per batch)

1. **De-duplicate**: insert into `issue_import` keyed by `(suit_barcode, insert_time)`; rows already present are skipped (ORA-02).
2. **Map values** through `oracle_value_map`. Any unmapped value → `held_unmapped`; any value mapped to Ignore → `ignored` (ORA-05, MAP-05).
3. **Data-quality check** against `dq_pattern` (today GOWN / OTHER / OTHER):
   - complete → upsert `barcode_profile` (a barcode's color/size never change);
   - incomplete → look up `barcode_profile`; if missing and `ORACLE_SUIT_TABLE` is configured, look the barcode up in the suit master (DQ-08, only if its color/size are not OTHER); if found → book to that color/size, `quality = recovered`; otherwise → book to the type × location **unknown bucket**, `quality = incomplete` (DQ-02/03).
4. **Cut-off**: if the issue time is before the location's `starting_count.as_of` → `before_start` (Trends only, no stock change; URD rule 7.8).
5. Otherwise `StockLedger.apply(issue, −1)` → `applied`.
6. Advance the watermark only after commit; write `sync_run` with counts per outcome.

### 3.3 Other paths

- **Mapping a new value** applies all its `held_unmapped` rows in one transaction (MAP-03).
- **Reversals** (ORA-06, TODO with the lead): since Oracle rows are never edited or deleted, a reversal could only appear as a separate row (e.g. another `STATE`). If one exists, add it to the query and apply +1, marking the original `reversed`. Until then, handled by stock correction.
- **Failure**: Oracle unreachable → run fails, watermark unchanged, next run catches up; stale > 30 min → banner + admin alert (ORA-07).
- **Backfill** (ORA-09): same code path from a start date in batches; everything before the cut-off lands as `before_start`, which also builds `barcode_profile` so recovery works from day one.
- **Data quality report** (DQ-05): `issue_import` grouped by day, location, `quality`.
- **Daily reconciliation**: count of issue rows per day in Oracle vs `issue_import`; mismatch → admin alert.

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
- Work through the vendor / DBA items in [`TODO.md`](./TODO.md). **Gate:** meaning of `INSERT_TIME` vs `RECTIME`.
- On site, with the configured table: run `SELECT DISTINCT` on `SUIT_TYPE`, `SUIT_COLOR`, `SUIT_SIZE`, `SUIT_LEVEL` and draft the initial value mapping (MAP-04); measure the share of GOWN / OTHER / OTHER rows, how many of their barcodes have earlier complete rows, and whether the suit master table has real color/size for them (DQ-08).
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
- Import job (§3) with watermark, overlap, `(barcode, INSERT_TIME)` de-duplication, held-unmapped handling.
- Data quality: known-bad patterns, barcode recovery, optional suit-master recovery, unknown bucket, data quality report (DQ-01..08).
- Oracle values screen (MAP-01..05) and sync status / admin screen (ORA-07/08); daily reconciliation.
- Backfill of issue history (ORA-09).
- Integration tests against an Oracle Free container with the real column layout and sample rows, including GOWN / OTHER / OTHER rows.

**Exit**: real issues from Oracle (test or prod copy) flow into GI; re-runs are no-ops.

### Phase 3 — Stock views + starting count (Sprint 6)
- Stock › Summary (STK-01..05) and Grid with minimums (GRD-01..06), negative flag, unknown-bucket line and notice (DQ-04).
- Starting count entry with per-location as-of time (ADJ-05, rule 7.8): size × color grid per garment and location on the phone, plus CSV import.
- Stock correction (ADJ-01..07); sizes & colors (SET-01..05).
- In-app below-minimum indicator (ALR-01).

**Exit**: the lead can load a starting count and see live calculated stock.

### Phase 4 — Trends + alerts (Sprint 7)
- `daily_snapshot` job; Trends: delivered per period, issued per day, stock over time, deliveries vs issues, breakdowns (TRD-01..07).
- Daily digest and stale-import alert (ALR-02/03).

**Exit**: the lead's three questions are answered on phone and laptop; chart totals match the ledger.

### Phase 5 — Hardening, pilot, rollout (Sprints 8–9)
- Accessibility audit, load test (posting during import), backups, monitoring, runbook, production deploy.
- **Go-live at Fab1**: floor staff count everything at a quiet moment; counts entered in GI with the as-of time when counting finished.
- **2-week parallel run**: floor staff keep counting manually; compare against GI daily; investigate gaps (missing deliveries, unmapped items, Oracle timing).
- When the accuracy target is met, **stop manual counting at Fab1**; repeat starting count + a shorter parallel run at **Fab2**.

### Backlog
Size × color grid entry for deliveries (1a), receive against a standing order (1c), additional garment types, purchasing integration, approval workflow for corrections (HIS-07).

## 6. Timeline

| Sprint | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| Phase | 0 Foundations + Oracle discovery | 1 Receive | 1 Receive | 2 Oracle import | 2 Oracle import | 3 Stock | 4 Trends | 5 Pilot Fab1 | 5 Rollout Fab2 |

≈ 14 weeks to Fab1 go-live, ≈ 18 weeks until manual counting stops at both fabs. The main schedule risk is Oracle access (Phase 0 gate).

## 7. Testing strategy

- **Unit** (`packages/domain`, ledger): status thresholds incl. negative, days of cover, delivery correction diff, void, line merge.
- **Import** (MariaDB + Oracle Free containers, real column names): idempotent re-run; overlap window; two rows with the same `INSERT_TIME`; same barcode issued twice at different times (both counted); late-committed row; other `STATE` values ignored; unmapped value → held → mapped → applied; GOWN / OTHER / OTHER with and without barcode history, with and without the suit master configured; row before vs after the starting-count cut-off; Oracle outage then catch-up; watermark advances only on commit.
- **Integration**: every write endpoint asserts the ledger invariant; delivery posted concurrently with an import run.
- **Device detection** (unit): table of real phone, tablet and laptop user-agent strings and client hints → expected layout; manual override.
- **E2E** (Playwright device profiles — e.g. iPhone 13 and Pixel 7 for phone, Desktop Chrome 1440×900 for laptop): URD §9 acceptance criteria in both layouts, plus a narrow laptop window still showing the laptop layout.
- **Pilot reconciliation**: daily GI vs manual count report during the parallel run; gowns compared at type level as well as per size while GOWN / OTHER / OTHER rows still occur.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Oracle access / account approval slow | Blocks Phase 2 | Request in Sprint 1; build against an Oracle Free container with the real column layout |
| GOWN / OTHER / OTHER rows persist (vendor fix late) | Per-size gown stock overstated | Barcode recovery, unknown bucket, notice on Stock, data quality report for the vendor, spot-check correction (DQ-*); type-level gown totals stay correct |
| Reversals not recorded in Oracle | Stock drifts low | Clarify with the lead (TODO); spot checks + stock correction; watch drift in the pilot |
| `INSERT_TIME` not indexed | Slow import, load on the issuing system | Ask the DBA for an index or view; smaller batches; longer interval |
| `INSERT_TIME` / `RECTIME` meaning guessed wrong | Missed rows or wrong cut-off | Confirm before Phase 2 (TODO); both columns configurable |
| Device misdetected (e.g. new browser, tablet) | Wrong layout | Manual view switch remembered per device; detection tests with real UA strings |
| Deliveries not entered (or entered late) | Negative / wrong stock | Negative flag, daily digest, back-dating (RCV-08), pilot reconciliation |
| Starting count done while issuing continues | Off by a few items from day 1 | Count at a quiet moment, record as-of when finished, cut-off rule 7.8, parallel run |
| Concurrent writes / deadlocks | Lost updates | Single ledger write path, ordered row locks, retry on 1213 |

## 9. Definition of done (per feature)

Requirement IDs linked in the PR · unit + e2e tests · works in the phone layout (on phone device profiles) and the laptop layout · touch targets ≥ 44 px · ledger invariant test passes · design tokens only · reviewed and merged with CI green.
