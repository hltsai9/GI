# Build Plan — Cleanroom Garment Inventory (GI)

Companion to the [URD](./URD.md). Requirement IDs (e.g. `RCV-01`, `ORA-02`) refer to that document.

## 1. Architecture

```
 Phone / laptop browser
        │  HTTPS (intranet: garments.fab.local)
        ▼
 ┌──────────────────────────────┐
 │ Web app (responsive SPA)     │  React + TypeScript + Vite
 │  - top tabs <900px, sidebar ≥900px
 │  - delivery draft kept in browser storage
 │  - Broadsheet design tokens
 └──────────────┬───────────────┘
                │ JSON REST (OpenAPI)
 ┌──────────────▼───────────────┐            ┌───────────────────────────┐
 │ API service                  │            │ Oracle DB (issuing system)│
 │  Node.js + TS (Fastify), Zod │            │  read-only account        │
 │  - auth (OIDC / SSO), RBAC   │            │  agreed view: issues      │
 │  - stock ledger service      │            └────────────▲──────────────┘
 │  - scheduler:                │                         │ SELECT only,
 │     · Oracle issue import ───┼─────────────────────────┘ every 5 min
 │     · daily snapshot, alerts │
 └──────────────┬───────────────┘
                ▼
   MariaDB 11.4 LTS, InnoDB, utf8mb4  (Drizzle ORM, mysql2 driver + migrations)
```

**Why**: one language end to end; one responsive web app serves phones and laptops with nothing to install; MariaDB InnoDB transactions with row locks keep deliveries and imported issues consistent (NFR-06/07). Oracle is read with `node-oracledb` in **thin mode** (pure JavaScript — no Oracle Instant Client to install on the server). MariaDB is fixed; the web/API layers can be swapped for an IT-standard stack without changing the data model or phases.

### 1.1 Repository layout (monorepo, pnpm workspaces)

```
apps/
  web/            React SPA
  api/            Fastify service + scheduler (Oracle import, snapshots, alerts)
packages/
  domain/         shared types, stock key, status rules, days-of-cover calc
  ui/             Broadsheet tokens + shared components (Segmented, Dropdown, Stepper, StatusCell, charts…)
design/mockups/   source mockups (reference only)
docs/             URD, build plan, ADRs
infra/            docker-compose (dev: MariaDB + Oracle Free container), deployment manifests
```

## 2. Data model (MariaDB)

```
garment_type(id, code, name, plural, icon, sort, active)          -- Gown, Hood, Boot
color(id, name, sort, active)                                      -- soft delete via active (SET-03)
size(id, code, sort, active)
location(id, code, name)                                           -- Fab1, Fab2
stock_item(id, garment_type_id, color_id, size_id, location_id,
           on_hand INT (signed — may go negative, URD rule 7.4), min_qty INT UNSIGNED NULL, updated_at,
           UNIQUE(garment_type_id, color_id, size_id, location_id))

delivery(id, received_at, created_by, status ENUM(posted,corrected,voided), note, idempotency_key UNIQUE)
delivery_line(id, delivery_id, stock_item_id, qty_original, qty_current)

-- Oracle issue import
oracle_item_map(id, oracle_item_code, oracle_location, stock_item_id NULL, description,
                updated_by, updated_at, UNIQUE(oracle_item_code, oracle_location))
issue_import(id, oracle_record_id UNIQUE, issued_at, oracle_item_code, oracle_location, qty,
             stock_item_id NULL, status ENUM(applied,held_unmapped,cancelled), ledger_entry_id NULL,
             imported_at, source_updated_at)
sync_run(id, started_at, finished_at, from_watermark, to_watermark,
         rows_read, rows_applied, rows_held, status ENUM(ok,failed), error)

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

1. **Contract first.** Agree with the issuing system's owner on a read-only **view** (e.g. `GI_ISSUES_V`) exposing: stable record ID, issued timestamp, item code, location, quantity, last-updated timestamp, cancelled flag (if available). A view decouples GI from changes to their tables. Index on the last-updated column.
2. **Run** (every 5 min, single-instance lock so runs never overlap):
   - read rows where `updated_at > watermark − 10 min` (overlap catches late commits), ordered, max N rows;
   - upsert into `issue_import` by `oracle_record_id` (idempotent, ORA-02);
   - new rows: map item → `stock_item`; mapped → `StockLedger.apply(issue, −qty)`; unmapped → `held_unmapped`;
   - changed / cancelled rows: apply the difference as `issue_correction` (ORA-06);
   - advance the watermark only after the MariaDB transaction commits; write `sync_run`.
3. **Mapping applied**: when the lead maps an Oracle item, all its `held_unmapped` rows are applied in one transaction.
4. **Failure**: Oracle down → run fails, watermark unchanged, next run catches up; stale > 30 min → banner + admin alert (ORA-07).
5. **Backfill** (ORA-09): same code path from a start date, in batches.
6. **Granularity fallback**: if Oracle only knows garment *type* (no size/color), issue-driven stock can only be kept per type × location; the grid then shows deliveries per size/color but on hand per type. Decide in Phase 0 (URD open question 1).

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
| `POST /corrections`, `POST /corrections/starting-count`, `GET /corrections` | stock correction, bulk starting count, log | ADJ-* |
| `GET /trends/delivered?days=&per=day\|week\|month` | delivered per period | TRD-01 |
| `GET /trends/issued?days=` | issued per day | TRD-02 |
| `GET /trends/stock?days=` | stock over time + deliveries vs issues | TRD-03/04 |
| `GET /trends/breakdown?days=&metric=` | by size / location | TRD-06 |
| `GET /sync/status`, `GET /sync/runs`, `POST /sync/run` | import status, history, run now | ORA-07/08 |
| `GET /mapping?unmapped=`, `PUT /mapping/:id` | Oracle item mapping | MAP-* |
| `POST/DELETE /colors`, `/sizes`, `PATCH` order | master data | SET-* |

## 5. Phased delivery

Team assumption: 2 developers (1 full-stack lead + 1 frontend), part-time designer/QA, plus a contact on the Oracle issuing system. Sprints are 2 weeks.

### Phase 0 — Foundations + Oracle discovery (Sprint 1)
- Resolve URD §10 questions 1–4 with the lead and the Oracle system owner. **Gate:** a sample of real issue rows and an agreed view definition.
- Request the read-only Oracle account and firewall access from the GI server (long lead time — start day 1).
- Monorepo, lint/typecheck, CI (GitHub Actions: build, unit, integration against MariaDB 11.4 + Oracle Free service containers, e2e).
- Docker-compose dev env; migrations; seed reproducing the mockup data.
- Broadsheet tokens into `packages/ui`; responsive app shell; auth stub + roles.

**Exit**: app shell on a dev server; Oracle sample data understood; CI green.

### Phase 1 — Ledger + Receive (Sprints 2–3)
- `StockLedger.apply()`, invariant check job.
- Receive › New delivery (RCV-01..08) with draft persistence and idempotent post.
- Receive › History with correction / void (HIS-01..06).

**Exit**: floor staff can post and correct deliveries on a phone.

### Phase 2 — Oracle issue import (Sprints 4–5)
- Import job (§3) with watermark, overlap, idempotency, held-unmapped handling, change/cancel handling.
- Item mapping screen (MAP-01..04) and sync status / admin screen (ORA-07/08).
- Backfill of issue history (ORA-09).
- Integration tests against an Oracle Free container loaded with the agreed view and sample rows.

**Exit**: real issues from Oracle (test or prod copy) flow into GI; re-runs are no-ops.

### Phase 3 — Stock views + starting count (Sprint 6)
- Stock › Summary (STK-01..05) and Grid with minimums (GRD-01..06), negative flag.
- Stock correction + bulk starting count / CSV import (ADJ-01..07); sizes & colors (SET-01..05).
- In-app below-minimum indicator (ALR-01).

**Exit**: the lead can load a starting count and see live calculated stock.

### Phase 4 — Trends + alerts (Sprint 7)
- `daily_snapshot` job; Trends: delivered per period, issued per day, stock over time, deliveries vs issues, breakdowns (TRD-01..07).
- Daily digest and stale-import alert (ALR-02/03).

**Exit**: the lead's three questions are answered on phone and laptop; chart totals match the ledger.

### Phase 5 — Hardening, pilot, rollout (Sprints 8–9)
- Accessibility audit, load test (posting during import), backups, monitoring, runbook, production deploy.
- **Go-live at Fab1**: full starting count entered in GI.
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
- **Import** (MariaDB + Oracle Free containers): idempotent re-run, overlap window, late-committed row, unmapped → mapped, cancellation, Oracle outage then catch-up, watermark advances only on commit.
- **Integration**: every write endpoint asserts the ledger invariant; delivery posted concurrently with an import run.
- **E2E** (Playwright, 390×844 phone and 1440×900 laptop): URD §9 acceptance criteria.
- **Pilot reconciliation**: daily GI vs manual count report during the parallel run.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Oracle access / account approval slow | Blocks Phase 2 | Request in Sprint 1; build against an Oracle Free container with the agreed view |
| Oracle data lacks size/color/location detail | Stock only per garment type | Discover in Phase 0; granularity fallback (§3.6) |
| Unstable record IDs or no cancellation info | Double counts or drift | Agree the view contract; reconcile daily totals Oracle vs GI |
| Deliveries not entered (or entered late) | Negative / wrong stock | Negative flag, daily digest, back-dating (RCV-08), pilot reconciliation |
| Inaccurate starting count | Wrong stock from day 1 | Careful full count at go-live; parallel run before stopping manual counts |
| Import load on Oracle | Issuing system slowed | Incremental indexed query, row limit, 5-min cadence, agreed with the Oracle DBA |
| Concurrent writes / deadlocks | Lost updates | Single ledger write path, ordered row locks, retry on 1213 |

## 9. Definition of done (per feature)

Requirement IDs linked in the PR · unit + e2e tests · works at 390 px and 1440 px · touch targets ≥ 44 px · ledger invariant test passes · design tokens only · reviewed and merged with CI green.
