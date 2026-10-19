# Build Plan — Cleanroom Garment Inventory (GI)

Companion to the [URD](./URD.md). Requirement IDs (e.g. `RCV-01`) refer to that document.

## 1. Recommended architecture

```
 Phone / handheld scanner / laptop / kiosk
            │  HTTPS (intranet: garments.fab.local)
            ▼
 ┌──────────────────────────────┐
 │ Web app (PWA)                │  React + TypeScript + Vite
 │  - responsive: top tabs <900px, sidebar ≥900px
 │  - offline draft (IndexedDB) for Receive
 │  - Broadsheet design tokens (CSS variables)
 └──────────────┬───────────────┘
                │ JSON REST (OpenAPI)
 ┌──────────────▼───────────────┐
 │ API service                  │  Node.js + TypeScript (Fastify), Zod validation
 │  - auth (OIDC / SSO), RBAC   │
 │  - stock ledger service      │
 │  - alerts job                │
 └──────────────┬───────────────┘
                ▼
         PostgreSQL 16  (Drizzle ORM + migrations)
```

**Why**: one language end to end, a PWA covers phones, scanners (keyboard-wedge input) and laptops from one codebase, and PostgreSQL transactions give the concurrency guarantees in NFR-06/07. Swap any piece if IT has a standard stack (e.g. .NET / SQL Server) — the data model and phases do not change.

### 1.1 Repository layout (monorepo, pnpm workspaces)

```
apps/
  web/            React PWA
  api/            Fastify service
packages/
  domain/         shared types, stock-key logic, status rules, days-of-cover calc
  ui/             Broadsheet tokens + shared components (Segmented, Dropdown, Stepper, StatusCell…)
design/mockups/   source mockups (reference only)
docs/             URD, build plan, ADRs
infra/            docker-compose (dev), deployment manifests
```

## 2. Data model

```
garment_type(id, code, name, plural, icon, sort, active)          -- Gown, Hood, Boot
color(id, name, sort, active)                                      -- soft delete via active (SET-03)
size(id, code, sort, active)
location(id, code, name)                                           -- Fab1, Fab2
stock_item(id, garment_type_id, color_id, size_id, location_id,
           on_hand int >= 0, min_qty int null, updated_at,
           UNIQUE(garment_type_id, color_id, size_id, location_id))

delivery(id, received_at, created_by, status[posted|corrected|voided], note, idempotency_key UNIQUE)
delivery_line(id, delivery_id, stock_item_id, qty_original, qty_current)

ledger_entry(id, stock_item_id, at, user_id, kind[delivery|delivery_correction|issue|adjustment|initial_load],
             delta int, qty_before, qty_after, ref_type, ref_id, reason, note)   -- append-only (AUD-01/03)

adjustment(id, stock_item_id, counted, system_qty, reason, note, user_id, at)
min_change(id, stock_item_id, old_min, new_min, user_id, at)
issue_txn(id, badge_id, person_name, location_id, at, user_or_kiosk)      -- if Issue in scope
issue_line(id, issue_txn_id, stock_item_id, garment_barcode)
garment_barcode(barcode, garment_type_id, color_id, size_id)              -- if Issue in scope
user(id, sso_subject, name, role[clerk|lead|viewer|admin])
daily_snapshot(date, stock_item_id, on_hand, delivered, issued)           -- feeds Trends
```

Invariant: `stock_item.on_hand = Σ ledger_entry.delta` for that item. Every write goes through one `StockLedger.apply()` function inside a DB transaction with `SELECT … FOR UPDATE` on the affected stock items.

## 3. API sketch

| Method & path | Purpose | Req |
|---|---|---|
| `GET /meta` | garment types, active colors, sizes, locations | SET-02 |
| `POST /deliveries` (Idempotency-Key header) | post a delivery | RCV-05/06, NFR-06 |
| `GET /deliveries?limit=` | history | HIS-01 |
| `POST /deliveries/:id/correction` `{lines:[{lineId, qty}]}` | correct / void (all 0) | HIS-04/05 |
| `GET /stock/summary` | totals, days of cover, reorder top 5, by location | STK-01..03 |
| `GET /stock/grid?type=&location=` | size × color cells with status | GRD-02 |
| `GET /stock/items/:id` | detail panel | GRD-03 |
| `PATCH /stock/items/:id/min` | change minimum | GRD-04 |
| `POST /adjustments`, `GET /adjustments` | correct stock + log | ADJ-02..05 |
| `GET /trends/over-time?days=` | stock series + deliveries/issues per day | TRD-01/02 |
| `GET /trends/breakdown?days=&metric=` | per day, by size, by location | TRD-03..05 |
| `POST/DELETE /colors`, `/sizes` (soft delete), `PATCH` order | master data | SET-01..05 |
| `POST /issues` | issue transaction | ISS-* |
| `GET /badges/:id` | badge lookup + clearance | ISS-01/02 |

## 4. Phased delivery

Estimates assume 2 developers (1 full-stack lead + 1 frontend), 1 part-time designer/QA. Sprints are 2 weeks.

### Phase 0 — Foundations (Sprint 1)
- Confirm open questions in URD §9 (especially Issue scope, hosting, SSO). **Gate.**
- Monorepo, lint/format/typecheck, CI (GitHub Actions: build + unit + e2e).
- Docker-compose dev env (Postgres), migrations, seed script reproducing the mockup data.
- Broadsheet tokens ported into `packages/ui`; app shell with responsive tabs (top < 900 px, sidebar ≥ 900 px).
- Auth stub + role model; OIDC integration behind a flag.
- `packages/domain`: stock key, status (below / close / plenty), days-of-cover — with unit tests.

**Exit**: empty app shell deploys to a dev server; CI green.

### Phase 1 — Core stock ledger + Receive (Sprints 2–3)
- Ledger service with transactional `apply()`; invariant check job.
- Receive › New delivery (RCV-01..06), offline draft (RCV-07), idempotent post.
- Receive › History with correction / void (HIS-01..06).
- Shared components: Dropdown with icons, quantity Stepper, line list, toast.

**Exit**: a clerk can post and correct deliveries on a phone; ledger invariant holds under concurrent posting test.

### Phase 2 — Stock views (Sprints 4–5)
- Stock › Summary (STK-01..04) incl. days of cover (needs issue data — use seeded/imported issues until Phase 4).
- Stock › Grid with detail panel and editable minimum (GRD-01..06).
- In-app low-stock indicator (ALR-01).

**Exit**: supervisors can see stock and set minimums; reorder list correct against test fixtures.

### Phase 3 — Settings + adjustments (Sprint 6)
- Sizes & colors with soft delete and ordering (SET-01..05).
- Correct stock with reasons and Recent corrections log (ADJ-01..05).
- Min-change and master-data audit (AUD-02).

**Exit**: v1 data maintenance complete; audit log reviewable.

### Phase 4 — Issue / consumption data (Sprints 7–8) — *scope depends on URD §2.2*
- **Option A (Issue in app)**: badge lookup integration, guided issue flow (ISS-01..05, 07), garment barcode registry, camera + wedge scanning.
- **Option B (import)**: scheduled import of issue counts from the existing vending/kiosk system into `ledger_entry(kind=issue)`.
- Kiosk mode (ISS-06) as a stretch or Phase 6.

**Exit**: real issue data flowing; days of cover and trends use live consumption.

### Phase 5 — Trends + alerts (Sprint 9)
- Nightly `daily_snapshot` job; Trends › Over time and Breakdown (TRD-01..06) with charts (lightweight SVG or a small chart lib).
- Daily below-minimum digest (ALR-02); CSV export (TRD-07).

**Exit**: trends match ledger totals for the selected range.

### Phase 6 — Hardening + rollout (Sprint 10)
- Initial stock load: full physical count per location via Correct stock (`initial_load` reason) or spreadsheet import.
- Load test (concurrent clerks + kiosks), accessibility audit (NFR-10), glove-use usability test on real handhelds in a gowning room.
- Backups, monitoring, runbook; production deploy.
- Pilot at **Fab1** for 2 weeks in parallel with the current process → fix list → roll out to **Fab2**.

### Later / backlog
Kiosk mode (if not in Phase 4), alternate receive modes (grid 1a, against-order 1c), carton barcode scanning, additional garment types, purchasing integration, approval workflow for large corrections (HIS-07).

## 5. Timeline overview

| Sprint | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Phase | 0 Foundations | 1 Receive | 1 Receive | 2 Stock | 2 Stock | 3 Settings | 4 Issue | 4 Issue | 5 Trends | 6 Rollout |

≈ 20 weeks to Fab1 pilot; Fab2 follows ~2 weeks after a successful pilot. Phase 4 Option B (import) could save about one sprint.

## 6. Testing strategy

- **Unit** (`packages/domain`, ledger service): status thresholds, days of cover, delivery correction diff math, void, floor at 0, merge of duplicate lines.
- **Integration** (API + Postgres in CI): every write endpoint asserts the ledger invariant; concurrent post/issue test.
- **E2E** (Playwright, phone 390×844 and laptop 1440×900 viewports — matching the mockup frames): the acceptance criteria in URD §8 as scripted scenarios.
- **Usability**: gloved-hand test on target handheld; kiosk dwell/auto-save timing.

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Issue scope undecided | Days of cover and trends meaningless without consumption data | Decide in Phase 0; Option B import as fallback |
| Badge / HR integration delay | Blocks Issue flow | Mock badge service; start integration request in Sprint 1 |
| Garments lack barcodes | Issue-by-scan impossible | Confirm in Phase 0; fall back to tap-to-issue |
| Plant Wi-Fi dead spots in stores | Lost postings | Offline draft + idempotent post |
| Initial count inaccurate | Wrong alerts from day 1 | Full count at go-live; cycle-count reason; 2-week parallel pilot |
| Concurrent updates | Wrong on-hand | Single ledger write path, row locks, invariant job |

## 8. Definition of done (per feature)

Requirement IDs covered and linked in the PR · unit + e2e tests · works at 390 px and 1440 px · touch targets ≥ 44 px · ledger invariant test passes · design tokens only (no hard-coded colors/fonts) · reviewed and merged with CI green.
