# User Requirements Document — Cleanroom Garment Inventory (GI)

| | |
|---|---|
| Version | 0.5 (draft for review) |
| Date | 2026-10-21 |
| Source | UI mockups in [`design/mockups/`](../design/mockups/) (`Garment Inventory.dc.html` explorations 1a–1j, `Garment Inventory App.dc.html` consolidated app, `Garment Inventory Devices.dc.html` phone + laptop frames) |
| Status | Draft — items marked **[OPEN]** still need an answer; they are tracked in [`TODO.md`](./TODO.md) |

---

## 1. Background

Today, cleanroom floor staff **count garments by hand** on the shelves at Fab1 and Fab2 and report the numbers to the cleanroom lead, who uses them to judge stock and reorder. Manual counting:

- takes floor staff time away from other work, every time the lead needs a number;
- gives only a snapshot — there is no record of how much was delivered or used over time;
- is error-prone, and errors are only found at the next count.

Garment **issuing is already recorded** in another system (from an outside vendor), which writes one row per garment to an **Oracle database**. Every garment has its own barcode. Issue rows are those with `STATE = 'EMPLOYEE GOWN ISSUE'`; each row carries the garment's barcode, type, color, size and location (`SUIT_LEVEL`). That data is not currently used for stock keeping.

Not all of the Oracle data is accurate: rows with **type GOWN and both color and size = OTHER** are known to be wrong (the real color and size were not recorded). The lead is asking the vendor to fix this; until then, GI must cope with it (§6.4).

## 2. Goal

Replace manual counting with a calculated stock level:

```
stock on hand  =  starting count  +  deliveries (entered in GI)  −  issues (imported from Oracle)
```

- Floor staff **only enter the number of each garment when a delivery arrives**. They no longer count stock.
- Issues are **read automatically** from the Oracle database; nobody types them.
- The lead can see, at any time, on a phone or laptop:
  1. **how many garments were delivered** per period,
  2. **how many were issued per day**, and
  3. **how many are in stock** now.

### 2.1 Success measures

| Measure | Target |
|---|---|
| Routine manual stock counts | Stopped after the pilot (only occasional spot checks remain) |
| Time to record a morning delivery | < 2 minutes on a phone |
| Stock accuracy | Spot-check count within ±5 % of system stock for ≥ 95 % of stocked items **[OPEN]** confirm target |
| Freshness of issue data | Issues visible in GI within 15 minutes of being recorded in Oracle **[OPEN]** confirm |

## 3. Scope

### 3.1 In scope

| Area | What | Mockup |
|---|---|---|
| **Receive** | Enter a delivery line by line; view, correct or void past deliveries | App › Receive |
| **Issue import** | Scheduled, read-only import of `EMPLOYEE GOWN ISSUE` rows from the Oracle database; mapping of Oracle values to GI values; handling of incomplete rows; sync status | — (new) |
| **Stock** | Summary (totals, days of cover, reorder list, by location); size × color grid with per-item minimum | App › Stock |
| **Trends** | Delivered per period, issued per day, stock over time, breakdowns by size and location | App › Trends |
| **Settings** | Sizes & colors; stock correction (starting count and occasional spot-check fixes) | App › Settings |

### 3.2 Out of scope

- **Issuing garments in GI** — badge scan, garment scan and kiosk mode (mockups 1d, 1e). Issuing stays in the existing system; GI only reads its data.
- **Barcode scanning of any kind**, and handheld scanner hardware. All entry is by touch / keyboard.
- **Writing back to the Oracle database.** GI never changes Oracle data.
- Routine manual stock counting (replaced by the calculation above).
- Purchasing / PO creation (GI shows *what* to reorder; it does not place orders).
- Laundry cycles, per-garment lifetime, cost-center charge-back.

### 3.3 Mockup items not carried forward (may return later)

| Item | Mockup | Note |
|---|---|---|
| Receive by size × color grid | 1a | Possible faster entry for single-garment deliveries — backlog |
| Receive against a standing order | 1c | Only if a standing order exists **[OPEN]** |
| Stock sorted by urgency | 1f | Covered by Stock › Summary reorder list |

## 4. Users and roles

| Role | Who | Main tasks | Device |
|---|---|---|---|
| **Floor staff** | Cleanroom floor staff receiving the morning delivery (~06:40) | Enter deliveries; fix a wrong delivery entry; the one-off full count before go-live | Phone |
| **Cleanroom lead** | Owns stock levels and reordering | Read stock, deliveries and issues; set minimums; manage sizes/colors; stock corrections; map new Oracle values; follow up data quality with the vendor | Laptop, phone |
| **Viewer** | Fab managers, purchasing | Read stock and trends | Laptop |
| **Admin** | IT | Users and roles, Oracle connection, value mapping, data-quality patterns, monitoring | Laptop |

## 5. Domain model and definitions

- **Garment type** — Gown, Hood, Boots (**[OPEN]** gloves, masks, liners later?).
- **Color** — White, Blue, Black, Other (editable in Settings).
- **Size** — SM, MED, LG, XLG, 2XLG, 3XLG, 4XLG, Other (editable in Settings).
- **Location** — Fab1, Fab2.
- **Stock item** — the unique combination *garment × color × size × location*, with its own **on hand** and **minimum**.
- **Stocked item** — a stock item with a minimum set. Others show "—" / "Not stocked — set a minimum to start".
- **Delivery** — garments received, entered by floor staff: timestamp, user, lines (stock item + quantity), correction note.
- **Issue** — one garment handed out, i.e. one Oracle row with `STATE = 'EMPLOYEE GOWN ISSUE'`. GI holds a read-only copy. Garments are laundered and reused, so the same barcode is issued many times; an issue is identified by barcode + time (§6.3).
- **Value mapping** — how a value in an Oracle column translates to a GI value (e.g. `SUIT_TYPE` "GOWN" → Gown, a `SUIT_LEVEL` value → Fab1).
- **Incomplete issue** — an issue row whose color and size are known to be wrong; today: `SUIT_TYPE` = GOWN with `SUIT_COLOR` = OTHER and `SUIT_SIZE` = OTHER.
- **Unknown bucket** — per garment type and location, a separate stock line that collects incomplete issues that could not be recovered (§6.4).
- **Starting count** — the full count by floor staff just before go-live, with an *as-of* time per location. Stock starts from it.
- **Stock correction** — a change to on hand that is neither a delivery nor an issue (starting count, spot check, damaged, found). Always has a reason and is logged.
- **On hand** — starting count + deliveries − issues ± corrections. Calculated, never counted routinely.
- **Days of cover** — on hand ÷ average weekday issues over the last 7 days ("About 4.2 days at the usual rate").
- **Stock status** — *Below min* (on hand < min), *Close to min* (on hand < 1.5 × min, **[OPEN]** confirm), *Plenty*; *Negative* (on hand < 0 — see rule 7.4).

## 6. Functional requirements

Priority: **M** = must (v1), **S** = should, **C** = could.

### 6.1 Receive — new delivery

| ID | Requirement | Pri |
|---|---|---|
| RCV-01 | Floor staff build a delivery from lines. Each line = garment, color, size, location (dropdowns) + quantity (numeric keypad). | M |
| RCV-02 | "Add line" adds the line to the top of the list. A line for an existing garment/color/size/location merges into it (quantities summed). | M |
| RCV-03 | Each staged line shows garment icon, name, "color · size · location", quantity and −/+ buttons (step 5). A line reaching 0 is removed. | M |
| RCV-04 | Footer shows number of lines, total items and **Post delivery**. Empty state: "No lines yet. Add each garment, color, size and location from the delivery." | M |
| RCV-05 | Posting adds every line to on hand in one transaction, records the delivery with timestamp and user, clears the draft and confirms "N items added to stock · HH:MM". | M |
| RCV-06 | Posting to a combination with no minimum creates the stock item with a default minimum (mockup: 2; **[OPEN]** confirm). | M |
| RCV-07 | The draft survives a page reload or dropped connection until posted. | S |
| RCV-08 | The delivery time defaults to now and can be back-dated (same day or previous day) when entry is late. | S |

### 6.2 Receive — delivery history and correction

| ID | Requirement | Pri |
|---|---|---|
| HIS-01 | List past deliveries newest first: when, "N items · N lines · locations", and an "Edited" badge + note if corrected. | M |
| HIS-02 | Opening a delivery shows its lines with −/+ (step 1). Changed lines show "was N" highlighted. | M |
| HIS-03 | Live summary: "Tap − / + to fix a quantity." / "+N items will be added to stock" / "−N items will be taken out of stock" / "Quantities moved, total unchanged." | M |
| HIS-04 | **Save correction** applies only the *difference* to on hand and stamps the delivery "Corrected <date time> · ±N items". | M |
| HIS-05 | **Void delivery** sets all lines to 0 and saves like a correction, stamping "Voided <date time>". | M |
| HIS-06 | Original quantities are kept in the audit trail. | M |
| HIS-07 | Corrections older than N days or larger than X items need the lead role. **[OPEN]** N, X. | S |

### 6.3 Issue import from Oracle

**Source columns.** The table name is set in GI's configuration at installation (not stored in this repository):

| Oracle column | Use in GI |
|---|---|
| `SUIT_BARCODE` | Garment barcode. Part of the issue key; used to recover color/size for incomplete rows (DQ-02). |
| `SUIT_TYPE` | → garment type (value mapping) |
| `SUIT_COLOR` | → color (value mapping) |
| `SUIT_SIZE` | → size (value mapping) |
| `SUIT_LEVEL` | → location, Fab1 / Fab2 (value mapping) |
| `STATE` | Filter: only `'EMPLOYEE GOWN ISSUE'` is imported |
| `INOUT_CATEGORY`, `INOUT_ACTION` | Not imported — always the same for `EMPLOYEE GOWN ISSUE` rows |
| `INSERT_TIME` | Part of the issue key. Assumed to be when the row was written → incremental import key. **[OPEN]** confirm (TODO) |
| `RECTIME` | Assumed to be the time of the issue → "issued at" for Trends and the starting-count cut-off. **[OPEN]** confirm (TODO) |
| `EMPLOYEE_ID`, `INSERT_USER` | **Not imported** — GI only needs counts (data minimization). **[OPEN]** unless per-employee reports are wanted |

Rows are **never edited or deleted** after they are written, and `SUIT_BARCODE` + `INSERT_TIME` is unique. `EMPLOYEE GOWN ISSUE` covers **all garment types** (gowns, hoods, boots).

A second Oracle table — the **suit master** (`SUIT_BARCODE`, `SUIT_CATEGORY`, `SUIT_TYPE`, `SUIT_COLOR`, `SUIT_SIZE`) — is **not needed** for the import. It is optional, only as an extra way to recover incomplete rows (DQ-08), if it turns out to hold the real color and size.

| ID | Requirement | Pri |
|---|---|---|
| ORA-01 | GI reads rows with `STATE = 'EMPLOYEE GOWN ISSUE'` from the Oracle database over a **read-only** account, on a schedule (default every 5 minutes; **[OPEN]** confirm). | M |
| ORA-02 | Each row is **one garment issued** (quantity 1). Each row is imported **exactly once**, keyed by `SUIT_BARCODE` + `INSERT_TIME` (barcode alone is not unique, as garments are reused); re-running an import never double-counts. (Confirmed unique; rows are never edited or deleted.) | M |
| ORA-03 | Import is incremental on `INSERT_TIME`, with an overlap window (e.g. 10 minutes) to catch late-committed rows and rows sharing the same timestamp. | M |
| ORA-04 | Each row's `SUIT_TYPE`, `SUIT_COLOR`, `SUIT_SIZE` and `SUIT_LEVEL` are translated through the value mapping (§6.10) to a GI stock item, whose on hand is reduced by 1. Incomplete rows follow §6.4. | M |
| ORA-05 | A row containing a value not yet in the value mapping (e.g. a new size code) is **held**: it does not affect stock, is listed under Settings › Oracle values with a count, and is applied as soon as the value is mapped. | M |
| ORA-06 | Reversals ("cancellations"): if an issue is undone — scanned by mistake, or the garment handed back unused — and the source records it (rows are never edited or deleted, so it would have to be a separate row, e.g. another `STATE`), GI gives the garment back to stock. **[OPEN]** whether and how this is recorded (TODO); until known, handled by stock correction. | S |
| ORA-07 | Sync status is visible on Stock and Trends: "Issues up to HH:MM". If the last successful import is older than 30 minutes, a warning is shown and admins are notified. | M |
| ORA-08 | Admin screen: connection test, last runs (time, rows read, applied, held, incomplete, errors), and "Run now". | M |
| ORA-09 | Historic backfill from a chosen start date, **for Trends only** — issues before the starting count do not change stock (rule 7.8). | S |
| ORA-10 | The Oracle load stays small: one query per run with bind variables, filtered on `STATE` and `INSERT_TIME` (index advisable — **[OPEN]** TODO), row limit per run. | M |
| ORA-11 | Oracle connection details, credentials and table names are **configuration**, set at installation, never in source code. Table names are validated as plain identifiers before use. | M |

### 6.4 Data quality — incomplete issue rows

| ID | Requirement | Pri |
|---|---|---|
| DQ-01 | A row is **incomplete** when it matches a known-bad pattern. Today the only pattern is `SUIT_TYPE` = GOWN with `SUIT_COLOR` = OTHER and `SUIT_SIZE` = OTHER. Admins can add or remove patterns without a code change. | M |
| DQ-02 | **Recovery by barcode:** for an incomplete row, GI looks up the same `SUIT_BARCODE` in earlier complete rows. Because a barcode's color and size never change (confirmed), any earlier complete row gives the answer; the row is booked to that item and marked "recovered". | M |
| DQ-03 | An incomplete row that cannot be recovered still counts in **issued per day**, **garment-type totals** and **location totals** (these stay correct), but is booked to that type and location's **unknown bucket**, not to the real "Other · Other" item. | M |
| DQ-04 | The unknown bucket is shown as its own line ("Gowns · color/size unknown") on Stock › Summary and below the Stock › Grid, with the notice "N gown issues in the last 7 days had no color/size — stock per size and color may be overstated by up to N." | M |
| DQ-05 | **Data quality report** for the lead: incomplete rows per day (recovered / unrecovered), by location, with example barcodes — to show the vendor and to check whether their fix works. | M |
| DQ-06 | After a spot check of the affected garments, the lead can clear the unknown bucket with a stock correction (reason "Spot check"), which also corrects the per-size items. | M |
| DQ-07 | When the vendor's fix is in place, no GI change is needed: complete rows import normally and the unknown bucket stops growing. The vendor will **not** correct old rows, so incomplete rows stay in history; Trends by size/color for gowns show them as "unknown". | M |
| DQ-08 | Optional second recovery source: look up the barcode in the suit master table, if it is configured and its color/size are real (not OTHER). **[OPEN]** check the master table (TODO). | C |

### 6.5 Stock — summary (front page)

| ID | Requirement | Pri |
|---|---|---|
| STK-01 | Per garment: total on hand (Fab1 + Fab2) in large print with icon, plus "About N.N days at the usual rate". | M |
| STK-02 | **Reorder** list: the 5 stock items furthest below minimum (by on hand ÷ min), each "Garment · color · size · location — on hand / min". | M |
| STK-03 | **By location**: totals per garment for Fab1 and Fab2. | M |
| STK-04 | Today at a glance: delivered today and issued today per garment. | M |
| STK-05 | Freshness stamp ("As of HH:MM · issues up to HH:MM"); refreshes without manual reload. | S |

### 6.6 Stock — grid

| ID | Requirement | Pri |
|---|---|---|
| GRD-01 | Choose garment (Gowns / Hoods / Boots, with icons) and location (Fab1 / Fab2). | M |
| GRD-02 | Rows = sizes, columns = colors; each cell shows on hand, colored by status with a text legend; non-stocked cells show "—"; negative cells clearly flagged. | M |
| GRD-03 | Tapping a cell shows a detail panel: title, status, on hand, minimum with −/+ ("Alert below"), location, issued today, last delivery. | M |
| GRD-04 | Changing the minimum takes effect everywhere immediately and is logged. Minimum ≥ 1 once stocked. | M |
| GRD-05 | Switching garment/location keeps the same color/size selected if it exists, else White · LG. | S |
| GRD-06 | Selecting a non-stocked cell lets the lead set a minimum to start stocking it. | S |

### 6.7 Trends (the lead's three questions)

| ID | Requirement | Pri |
|---|---|---|
| TRD-01 | **Delivered per period**: bar chart of items delivered per day, with a switch for per week / per month, total for the range. | M |
| TRD-02 | **Issued per day**: bar chart of items issued per day, "N a weekday, on average", today marked "so far". | M |
| TRD-03 | **Stock over time**: line per garment for the selected range, legend with current value. | M |
| TRD-04 | **Deliveries vs issues**: mirrored bars on a shared baseline per day, with "Delivered N · Issued N · Net ±N". | M |
| TRD-05 | Range 7 / 14 / 30 / 90 days (**[OPEN]** confirm); filter by garment and location. | M |
| TRD-06 | Breakdown by size and by location (Fab1 vs Fab2), switchable between Delivered / Issued / Stock. | S |
| TRD-07 | Export the data behind any chart as CSV. | S |

### 6.8 Settings — sizes and colors

| ID | Requirement | Pri |
|---|---|---|
| SET-01 | Sizes and colors as removable chips; add a new size / color by text. | M |
| SET-02 | New values appear immediately in Receive, Stock, Stock correction and the Oracle value mapping. | M |
| SET-03 | Removing a value only **hides** it; stock records and history are kept and it can be restored. | M |
| SET-04 | Sizes keep a user-defined display order. | S |
| SET-05 | Only lead/admin can change master data. | M |

### 6.9 Settings — stock correction

| ID | Requirement | Pri |
|---|---|---|
| ADJ-01 | Banner: "Only for when the system count is wrong. To fix a delivery, use Receive › History instead. Every correction is logged." | M |
| ADJ-02 | Pick garment, color, size, location → show **In system**; enter **Counted on the shelf**; show the difference live. | M |
| ADJ-03 | Reason required: Starting count, Spot check, Damaged, Found, Miscount at delivery, Other (note required for Other). | M |
| ADJ-04 | Save sets on hand to the counted value and adds to **Recent corrections**: item, reason, date time, "from → to". | M |
| ADJ-05 | **Starting count** for go-live: floor staff count everything; counts are entered for many items at once (size × color grid per garment and location) or imported from CSV, with an **as-of time** per location (when the count was done). | M |
| ADJ-06 | Full correction log, filterable by item, reason, user, date. | S |
| ADJ-07 | Only the lead/admin can make stock corrections. | M |

### 6.10 Settings — Oracle values (value mapping)

| ID | Requirement | Pri |
|---|---|---|
| MAP-01 | For each of `SUIT_TYPE`, `SUIT_COLOR`, `SUIT_SIZE` and `SUIT_LEVEL`, list every value seen in Oracle with the GI value it maps to (e.g. "GOWN" → Gown, a `SUIT_LEVEL` value → Fab1), the row count and first/last seen. Edit with a dropdown. | M |
| MAP-02 | New values not yet mapped are shown first, with the number of held rows (ORA-05). | M |
| MAP-03 | Mapping a value applies its held rows. Changing an existing mapping affects only rows imported afterwards (**[OPEN]** or re-apply history?). All changes are logged. | M |
| MAP-04 | The initial mapping is prepared in Phase 0 from the distinct values found in Oracle. | M |
| MAP-05 | A value can be mapped to "Ignore" (e.g. a test location); its rows are counted in the import log but never touch stock. | S |

### 6.11 Alerts

| ID | Requirement | Pri |
|---|---|---|
| ALR-01 | When an item drops below its minimum, show it in the app (badge on Stock) for the lead. | M |
| ALR-02 | Daily digest to the lead of items below minimum and any negative stock. **[OPEN]** channel (email / Teams). | S |
| ALR-03 | Alert when the Oracle import has failed or is stale (ORA-07). | M |

### 6.12 Audit

| ID | Requirement | Pri |
|---|---|---|
| AUD-01 | Every change to on hand is a ledger entry (starting count, delivery, delivery correction, issue import, stock correction) with user or source, timestamp, before/after and reason. On hand is always reproducible from the ledger. | M |
| AUD-02 | Minimum, master-data and mapping changes are logged. | M |
| AUD-03 | Ledger entries are append-only; corrections are new entries, never edits. | M |

## 7. Key business rules

1. A stock item is garment × color × size × location; quantities never mix locations.
2. Floor staff enter deliveries only. Issues come only from Oracle. Stock corrections are only for the starting count and exceptions.
3. Correcting a delivery applies only the difference; it is not a stock correction.
4. On hand **may go below 0** — e.g. issues imported before the matching delivery was entered. GI never blocks or hides this: the item is flagged *Negative* so the lead can check for a missing delivery.
5. Removing a size or color hides it; it never deletes stock or history.
6. Days of cover uses the average weekday issue rate over the last 7 days.
7. GI never writes to the Oracle database.
8. **Starting count cut-off:** stock starts from the starting count's as-of time per location. Issues with an issue time before it, and deliveries received before it, are history for Trends only and never change stock. The count should be done at a quiet moment (after the morning delivery is put away), and the as-of time recorded when counting finishes.
9. One Oracle issue row = one garment.
10. Incomplete issue rows never reduce a real size/color item unless recovered by barcode (DQ-02/08); otherwise they go to the unknown bucket (DQ-03).
11. A garment's barcode keeps the same type, color and size for its whole life.

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 **Web app, layout by device type** | Runs in the browser; no app install. GI detects the **type of device** when it loads and shows the layout made for it — not a layout chosen by window width. Resizing or rotating does not switch layouts. |
| NFR-02 **Phone layout** | For phones: single column, touch targets ≥ 44 px, tabs across the top under the app name (mockup: 390 × 844). Content still fits any phone width (320–480 px) and both orientations. |
| NFR-02a **Laptop layout** | For laptops and desktops: tabs in a left sidebar; wider multi-column layouts (mockup: 1440 × 900). Content still fits windows from 1024 px up. |
| NFR-02b **Device detection** | Phone = the browser reports a mobile device (User-Agent Client Hints `mobile`, falling back to the user-agent string). Everything else gets the laptop layout. Tablets: **[OPEN]** (TODO) — default laptop layout with touch-size targets when the screen is touch-only. A "Switch to phone / laptop view" option overrides detection and is remembered on that device. |
| NFR-03 **Cleanroom-friendly** | Usable with gloves: large targets, −/+ steppers, numeric keypad for quantities, high contrast. |
| NFR-04 **Manual entry only** | GI users never scan: no barcode scanning and no scanner hardware in GI. (Garment barcodes exist only in the Oracle issue data.) |
| NFR-05 **Performance** | Screens load in < 2 s on plant Wi-Fi; posting a delivery < 1 s; charts for 90 days < 2 s. |
| NFR-06 **Reliability** | Draft deliveries survive connection drops; posting is idempotent; the Oracle import is idempotent and resumes after downtime without gaps. |
| NFR-07 **Concurrency** | A delivery being posted while issues are imported must not lose either update. |
| NFR-08 **Database** | MariaDB (InnoDB) is GI's system of record. The Oracle database is read-only source data. |
| NFR-09 **Security** | Intranet only (`garments.fab.local`), HTTPS, company SSO, role-based access. Oracle credentials stored as secrets, never in code; least-privilege read-only Oracle account. Personal data (`EMPLOYEE_ID`, `INSERT_USER`) is not copied into GI. |
| NFR-10 **Data retention** | Ledger and history kept ≥ 2 years. **[OPEN]** confirm. |
| NFR-11 **Accessibility** | WCAG 2.1 AA contrast; status never by color alone. |
| NFR-12 **Look & feel** | "Broadsheet" design system tokens used in the mockups (`design/mockups/_ds/`). |
| NFR-13 **Locale** | English; dates like "Mon 5 Oct · 09:41"; site time zone (Oracle and MariaDB timestamps normalized). |

## 9. Acceptance criteria (v1 sign-off)

- Floor staff enter and post a 5-line mixed delivery on a phone in under 2 minutes.
- A phone always gets the phone layout and a laptop the laptop layout, even when the laptop window is made narrow; the view switch overrides it.
- After posting, Stock and Trends show the new quantities without reload.
- An issue recorded in Oracle appears in GI (issued today, on hand reduced) within the agreed freshness window.
- Re-running the import for an already imported period changes nothing.
- A row with a new, unmapped value is held and does not change stock; once the value is mapped, its held rows are applied.
- A GOWN / OTHER / OTHER row whose barcode has earlier complete rows is booked to that color and size; one without is booked to the unknown bucket and appears in the data quality report.
- After the starting count (as-of 14:00, say), an issue at 13:55 does not change stock and one at 14:05 does.
- Correcting a delivery by −10 reduces on hand by exactly 10 and marks it "Edited"; voiding reverses all its lines.
- The lead can answer, on a phone, "how many delivered this week", "how many issued per day" and "how many in stock" from the Trends and Stock tabs.
- On hand recomputed from the ledger equals stored on hand for every item.
- **Pilot check:** during the 2-week parallel run, system stock matches manual counts within the agreed accuracy target.

## 10. Open questions

All open questions are tracked as a checklist in [`TODO.md`](./TODO.md).

### Decided

- Issue data comes from Oracle rows with `STATE = 'EMPLOYEE GOWN ISSUE'`, which covers all garment types; `SUIT_LEVEL` is the location; one row per garment.
- `SUIT_BARCODE` + `INSERT_TIME` is unique; rows are never edited or deleted.
- `INOUT_CATEGORY` and `INOUT_ACTION` are constant for these rows and are not needed.
- The suit master table is not needed for the import (optional for recovery only, DQ-08).
- A barcode's color and size never change — recovery by barcode (DQ-02) is reliable.
- GOWN / OTHER / OTHER rows are incomplete; the vendor may fix new rows (date unknown) but will not correct old ones.
- Oracle connection details and table names go in configuration at installation.
- Floor staff do a full starting count of everything before go-live.
- Layout is chosen by device type (phone / laptop), not by window width.
