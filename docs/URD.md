# User Requirements Document — Cleanroom Garment Inventory (GI)

| | |
|---|---|
| Version | 0.2 (draft for review) |
| Date | 2026-10-21 |
| Source | UI mockups in [`design/mockups/`](../design/mockups/) (`Garment Inventory.dc.html` explorations 1a–1j, `Garment Inventory App.dc.html` consolidated app, `Garment Inventory Devices.dc.html` phone + laptop frames) |
| Status | Draft — items marked **[OPEN]** need a decision from the business owner |

---

## 1. Purpose

Cleanroom stores staff at two fabs (**Fab1** and **Fab2**) need one system to:

1. record bulk morning deliveries of cleanroom garments,
2. know how much of every garment / color / size is on hand at each location,
3. be warned before any item runs out, and
4. understand consumption trends so reorders are sized correctly.

Today this is assumed to be done on paper or spreadsheets; counts drift, and stock-outs in the gowning room stop people entering the cleanroom.

## 2. Scope

### 2.1 In scope (from the consolidated app mockup)

| Area | Screens |
|---|---|
| **Receive** | New delivery (line-by-line bulk entry), Delivery history (view / correct / void) |
| **Stock** | Summary (front page: totals, days of cover, reorder list, by-location), Grid (size × color per garment and location, per-item minimum) |
| **Trends** | Over time (stock per garment, deliveries vs issues), Breakdown (issued per day, by size, by location) |
| **Settings** | Sizes & colors (master data), Correct stock (cycle-count adjustments with reason + log) |

### 2.2 Explored but not in the consolidated app — **[OPEN]**

| Item | Mockup | Question |
|---|---|---|
| **Issue flow** (badge scan → one scan per garment → confirm) | 1d | Is issuing done in this system, or do issue counts come from another system (e.g. a vending/kiosk feed)? Trends and "days of cover" depend on issue data either way. |
| **Kiosk mode** (hands-free, auto-save 8 s after last scan, duplicate-scan detection) | 1e | Needed for gowning rooms in phase 1, or later? |
| **Receive by size × color grid** | 1a | Keep as an alternate entry mode for single-garment deliveries? |
| **Receive against standing order** | 1c | Is there a standing order / PO to check against? |
| **Stock sorted by urgency list** | 1f | Superseded by Summary + Grid? |

### 2.3 Out of scope (v1)

- Purchasing / PO creation with suppliers (the app shows *what* to reorder, it does not place orders).
- Laundry cycle tracking, per-garment lifetime / wash count.
- Billing / cost-center charge-back.

## 3. Users and roles

| Role | Who | Main tasks | Device |
|---|---|---|---|
| **Stores clerk** | Cleanroom stores staff, early shift (~06:40 deliveries) | Receive deliveries, correct deliveries, cycle counts | Phone |
| **Stores lead / supervisor** | Owns stock levels | Set minimums, review stock & trends, approve large corrections, manage sizes/colors | Laptop, phone |
| **Fab user** (if Issue is in scope) | Anyone gowning up | Scan badge + garments to take items | Kiosk (tablet / PC with camera) in gowning room |
| **Viewer** | Fab managers, EHS, purchasing | Read stock and trends | Laptop |
| **Admin** | IT | Users, roles, locations, integrations | Laptop |

## 4. Domain model and definitions

- **Garment type** — Gown, Hood, Boots (fixed list in v1; **[OPEN]** gloves, masks, liners later?).
- **Color** — White, Blue, Black, Other (editable in Settings).
- **Size** — SM, MED, LG, XLG, 2XLG, 3XLG, 4XLG, Other (editable in Settings).
- **Location** — Fab1, Fab2.
- **Stock item (SKU)** — the unique combination *garment × color × size × location*. Every stock item has its own **on-hand quantity** and **minimum**.
- **Stocked item** — a stock item with a minimum set (> 0). Combinations without a minimum show "—" / "Not stocked — set a minimum to start".
- **Delivery** — a bulk receipt with a timestamp, a set of lines (stock item + quantity) and a correction note.
- **Issue** — one garment leaving stores to a person (badge).
- **Adjustment (correction)** — a change to on-hand that is not a delivery or issue; always has a reason and is logged.
- **Days of cover** — on-hand ÷ average weekday issues over the last 7 days ("About 4.2 days at the usual rate").
- **Stock status** — *Below min* (on-hand < min), *Close to min* (on-hand < ~1.5 × min, **[OPEN]** confirm threshold), *Plenty*.

## 5. Functional requirements

Priority: **M** = must (v1), **S** = should, **C** = could.

### 5.1 Receive — new delivery

| ID | Requirement | Pri |
|---|---|---|
| RCV-01 | User builds a delivery from lines. Each line = garment, color, size, location (dropdowns) + quantity (numeric keypad). | M |
| RCV-02 | "Add line" adds the line to the top of the list. Adding a line whose garment/color/size/location already exists merges into that line (quantities summed). | M |
| RCV-03 | Each staged line shows garment icon, name, "color · size · location", quantity and −/+ buttons (step 5). A line reaching 0 is removed. | M |
| RCV-04 | Footer shows number of lines and total items, and a **Post delivery** button. Empty state: "No lines yet. Add each garment, color, size and location from the delivery." | M |
| RCV-05 | Posting increases on-hand for every line atomically, records the delivery with timestamp and user, clears the draft, and confirms "N items added to stock · HH:MM". | M |
| RCV-06 | Posting to a combination that has no minimum creates the stock item with a default minimum (mockup uses 2; **[OPEN]** confirm default). | M |
| RCV-07 | The draft survives an app reload / dropped connection until posted (phone use on the floor). | S |
| RCV-08 | Alternate entry: size × color grid for one garment + location (mockup 1a). | C |
| RCV-09 | Alternate entry: check against a standing order with expected vs counted and variance (mockup 1c). | C |
| RCV-10 | Scan a carton / label barcode with the phone camera to pre-fill a line. **[OPEN]** do supplier labels carry barcodes? | C |

### 5.2 Receive — delivery history and correction

| ID | Requirement | Pri |
|---|---|---|
| HIS-01 | List past deliveries newest first: when, "N items · N lines · locations", and an "Edited" badge + note if corrected. | M |
| HIS-02 | Opening a delivery shows its lines with −/+ (step 1) to fix quantities. Changed lines show "was N" highlighted. | M |
| HIS-03 | Live summary of the effect: "Tap − / + to fix a quantity." / "+N items will be added to stock" / "−N items will be taken out of stock" / "Quantities moved, total unchanged." | M |
| HIS-04 | **Save correction** applies only the *difference* to on-hand (never re-posts the whole delivery), floors on-hand at 0, and stamps the delivery "Corrected <date time> · ±N items". | M |
| HIS-05 | **Void delivery** sets all lines to 0 (then saved like a correction), stamping "Voided <date time>". | M |
| HIS-06 | Original quantities are kept in the audit trail; the delivery list shows the corrected quantities. | M |
| HIS-07 | Corrections older than N days, or larger than X items, require supervisor role. **[OPEN]** N, X. | S |

### 5.3 Stock — summary (front page)

| ID | Requirement | Pri |
|---|---|---|
| STK-01 | Per garment: total on hand (Fab1 + Fab2) in large print with icon, plus "About N.N days at the usual rate". | M |
| STK-02 | **Reorder** list: the 5 stock items furthest below minimum (sorted by on-hand ÷ min), each "Garment · color · size · location — on-hand / min". | M |
| STK-03 | **By location** table: totals per garment for Fab1 and Fab2. | M |
| STK-04 | "As of HH:MM" freshness stamp; data refreshes without manual reload. | S |

### 5.4 Stock — grid

| ID | Requirement | Pri |
|---|---|---|
| GRD-01 | Choose garment (Gowns / Hoods / Boots, with icons) and location (Fab1 / Fab2). | M |
| GRD-02 | Grid rows = sizes, columns = colors; each cell shows on-hand, colored by status (Below min / Close to min / Plenty) with legend; non-stocked cells show "—". | M |
| GRD-03 | Tapping a cell selects it (ring) and shows a detail panel: title, status text, on-hand, minimum with −/+ ("Alert below"), location, issued today, last delivery. | M |
| GRD-04 | Changing the minimum takes effect immediately everywhere (summary, reorder list, grid colors) and is logged. Minimum ≥ 1 once stocked. | M |
| GRD-05 | Switching garment/location keeps the same color/size selected if it exists, else falls back to White · LG. | S |
| GRD-06 | Selecting a non-stocked cell lets the user set a minimum to start stocking it. | S |

### 5.5 Trends

| ID | Requirement | Pri |
|---|---|---|
| TRD-01 | **Over time**: line chart of stock on hand per garment for the selected range (7 / 14 / 30 days; **[OPEN]** confirm ranges), with legend showing current value. | M |
| TRD-02 | **Deliveries vs issues**: mirrored bars on a shared baseline per day, with totals "Delivered N · Issued N · Net ±N". | M |
| TRD-03 | **Breakdown**: issued per day (bar chart, "N a weekday, on average", today marked "so far"). | M |
| TRD-04 | Toggle metric **Issued / Stock** for the breakdown. | M |
| TRD-05 | Breakdown by size (bars) and by location (Fab1 vs Fab2). | M |
| TRD-06 | Filter by garment type. | S |
| TRD-07 | Export the underlying data as CSV. | C |

### 5.6 Settings — sizes and colors

| ID | Requirement | Pri |
|---|---|---|
| SET-01 | List sizes and colors as removable chips; add new size / color by text. | M |
| SET-02 | New values appear immediately in Receive, Stock and Correct stock. | M |
| SET-03 | Removing a value only **hides** it from those screens; its stock records and history are kept (soft delete) and can be restored. | M |
| SET-04 | Sizes keep a user-defined display order. | S |
| SET-05 | Only supervisor/admin can change master data. | M |

### 5.7 Settings — correct stock (adjustment)

| ID | Requirement | Pri |
|---|---|---|
| ADJ-01 | Banner: "Only for when the system count is wrong. To fix a delivery, use Receive › History instead. Every correction is logged." | M |
| ADJ-02 | Pick garment, color, size, location → show **In system** quantity; enter **Counted on the shelf**; show the difference live. Changing the item clears the counted field. | M |
| ADJ-03 | Reason is required: Cycle count, Damaged, Found, Miscount at delivery, Other (free-text note when Other). | M |
| ADJ-04 | Save sets on-hand to the counted value and appends to **Recent corrections**: item, reason, date time, "from → to". | M |
| ADJ-05 | Full adjustment log is filterable by item, reason, user, date. | S |

### 5.8 Issue (conditional — see 2.2)

| ID | Requirement | Pri |
|---|---|---|
| ISS-01 | Step 1: scan badge with the device camera or type badge number; show name, badge and clearance ("Cleared for Fab1"). | M* |
| ISS-02 | Reject badges not cleared for the room's fab. | M* |
| ISS-03 | Step 2: scan garment barcodes with the device camera; checklist Gown / Hood / Boots shows what is still missing; "Issue N to <name>". | M* |
| ISS-04 | Confirm decrements on-hand by 1 per garment at the room's location; result screen shows "from → to" per item and flags "Below min". | M* |
| ISS-05 | Auto-return to badge scan after 5 s. | M* |
| ISS-06 | Kiosk mode: no taps; auto-save 8 s after the last scan; new badge restarts; duplicate scans counted once with a warning; "Recent at this kiosk" list. | S* |
| ISS-07 | Issuing an item with 0 on hand. **[OPEN]** block, or allow and flag a count discrepancy? | M* |

\* Only if the Issue flow is confirmed in scope.

### 5.9 Alerts

| ID | Requirement | Pri |
|---|---|---|
| ALR-01 | When an item drops below its minimum, notify stores leads (in-app badge at minimum). | M |
| ALR-02 | Daily digest (email / Teams) of items below minimum. **[OPEN]** channel. | S |

### 5.10 Audit

| ID | Requirement | Pri |
|---|---|---|
| AUD-01 | Every change to on-hand is a ledger entry (delivery, delivery correction, issue, adjustment) with user, timestamp, before/after and reason. On-hand is always reproducible from the ledger. | M |
| AUD-02 | Minimum changes and master-data changes are logged. | M |
| AUD-03 | Ledger entries are append-only; corrections are new entries, never edits. | M |

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 **Phone-first** | Designed for 390 px phones first: single column, touch targets ≥ 44 px, tabs across the top under the app name. |
| NFR-02 **Desktop** | ≥ 900 px wide: tabs move to a left sidebar; layouts widen (mockup: 1440 × 900 laptop). |
| NFR-03 **Cleanroom-friendly** | Usable with gloves: large targets, −/+ steppers instead of typing where possible, numeric keypad for quantities, high contrast. |
| NFR-04 **No dedicated scanners** | No handheld scanner hardware is used. Any barcode reading (Issue flow, RCV-10) uses the built-in camera of the phone, tablet or kiosk; every scan step also accepts typed input. |
| NFR-05 **Performance** | Screens load in < 2 s on the plant Wi-Fi; posting a delivery < 1 s. |
| NFR-06 **Reliability** | Draft deliveries survive connection drops; posting is idempotent (no double-posting on retry). |
| NFR-07 **Concurrency** | Two clerks posting / issuing at once must not lose updates (transactional stock updates). |
| NFR-08a **Database** | MariaDB (InnoDB) is the system of record. |
| NFR-08 **Security** | Intranet only (`garments.fab.local`), company SSO, role-based access, HTTPS. |
| NFR-09 **Data retention** | Ledger and history kept ≥ 2 years. **[OPEN]** confirm policy. |
| NFR-10 **Accessibility** | WCAG 2.1 AA contrast; status never conveyed by color alone (text label + legend). |
| NFR-11 **Look & feel** | Follow the "Broadsheet" design system tokens used in the mockups (`design/mockups/_ds/`). |
| NFR-12 **Locale** | English; dates like "Mon 5 Oct · 09:41"; site time zone. |

## 7. Key business rules

1. A stock item is identified by garment × color × size × location; quantities never mix locations.
2. On-hand never goes below 0 through a delivery correction (floored at 0).
3. Correcting a delivery applies only the difference; it is not an adjustment and is not entered in Correct stock.
4. Adjustments are only for counts that are wrong for reasons other than a delivery miscount; reason is mandatory.
5. Removing a size or color hides it; it never deletes stock or history.
6. Days of cover uses the average weekday issue rate over the last 7 days.

## 8. Acceptance criteria (v1 sign-off)

- A clerk can enter and post a 5-line mixed delivery on a phone in under 1 minute.
- After posting, Stock › Summary, Stock › Grid and Trends reflect the new quantities without reload.
- Correcting a posted delivery by −10 reduces on-hand by exactly 10 and marks the delivery "Edited".
- Voiding a delivery reverses all its lines.
- Lowering a minimum below on-hand removes the item from the Reorder list immediately.
- A cycle-count correction appears in Recent corrections with reason and from → to.
- Removing color "Other" hides it from all pickers but its historical stock remains in reports.
- On-hand recomputed from the ledger equals stored on-hand for every item.

## 9. Open questions (summary)

1. Is **Issue** (badge + scan) in scope for v1, or are issue counts imported from elsewhere?
2. Kiosk mode in v1?
3. Barcode format on garments and on delivery cartons, and whether it reads reliably with phone/tablet cameras.
4. Badge system / HR source for names and fab clearance.
5. Default minimum for newly stocked items (mockup: 2).
6. "Close to min" threshold.
7. Trend ranges (7 / 14 / 30 days?).
8. Approval rules for large or late corrections.
9. Alert channel (email, Teams, other).
10. Additional garment types (gloves, masks, liners, glasses).
11. Hosting: on-prem server vs internal cloud; SSO provider; existing MariaDB server/cluster to use, or a new instance?
12. Migration: initial stock load from a full count, or an existing spreadsheet?
