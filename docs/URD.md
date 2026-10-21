# User Requirements Document — Cleanroom Garment Inventory (GI)

| | |
|---|---|
| Version | 0.3 (draft for review) |
| Date | 2026-10-21 |
| Source | UI mockups in [`design/mockups/`](../design/mockups/) (`Garment Inventory.dc.html` explorations 1a–1j, `Garment Inventory App.dc.html` consolidated app, `Garment Inventory Devices.dc.html` phone + laptop frames) |
| Status | Draft — items marked **[OPEN]** need a decision from the business owner (cleanroom lead) |

---

## 1. Background

Today, cleanroom floor staff **count garments by hand** on the shelves at Fab1 and Fab2 and report the numbers to the cleanroom lead, who uses them to judge stock and reorder. Manual counting:

- takes floor staff time away from other work, every time the lead needs a number;
- gives only a snapshot — there is no record of how much was delivered or used over time;
- is error-prone, and errors are only found at the next count.

Garment **issuing is already recorded** in another system, which stores every issue in an **Oracle database**. That data is not currently used for stock keeping.

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
| **Issue import** | Scheduled, read-only import of issue records from the Oracle database; mapping of Oracle items to GI stock items; sync status | — (new) |
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
| **Floor staff** | Cleanroom floor staff receiving the morning delivery (~06:40) | Enter deliveries; fix a wrong delivery entry | Phone |
| **Cleanroom lead** | Owns stock levels and reordering | Read stock, deliveries and issues; set minimums; manage sizes/colors; enter starting counts and stock corrections; review unmapped Oracle items | Laptop, phone |
| **Viewer** | Fab managers, purchasing | Read stock and trends | Laptop |
| **Admin** | IT | Users and roles, Oracle connection, item mapping, monitoring | Laptop |

## 5. Domain model and definitions

- **Garment type** — Gown, Hood, Boots (**[OPEN]** gloves, masks, liners later?).
- **Color** — White, Blue, Black, Other (editable in Settings).
- **Size** — SM, MED, LG, XLG, 2XLG, 3XLG, 4XLG, Other (editable in Settings).
- **Location** — Fab1, Fab2.
- **Stock item** — the unique combination *garment × color × size × location*, with its own **on hand** and **minimum**.
- **Stocked item** — a stock item with a minimum set. Others show "—" / "Not stocked — set a minimum to start".
- **Delivery** — garments received, entered by floor staff: timestamp, user, lines (stock item + quantity), correction note.
- **Issue** — one or more garments handed out, **as recorded in the Oracle database**. GI holds a read-only copy keyed by the Oracle record ID.
- **Item mapping** — how an Oracle item (code + location) translates to a GI stock item.
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

| ID | Requirement | Pri |
|---|---|---|
| ORA-01 | GI reads issue records from the Oracle database over a **read-only** account, on a schedule (default every 5 minutes; **[OPEN]** confirm), using an agreed view or table. | M |
| ORA-02 | Each Oracle issue record is imported **exactly once**, keyed by its Oracle record ID; re-running an import never double-counts. | M |
| ORA-03 | Import is incremental (from the last imported timestamp / ID, with a small overlap window to catch late-committed rows). | M |
| ORA-04 | Each imported issue is mapped to a GI stock item via the item mapping and reduces its on hand. | M |
| ORA-05 | Issue records whose item cannot be mapped are held in an **Unmapped items** list (Oracle code, description, location, count, first/last seen) and do not affect stock until mapped; mapping them applies the held issues. | M |
| ORA-06 | If an Oracle record is cancelled or changed after import, GI applies the difference as a correction to that issue (needs the source to expose cancellations / updates — **[OPEN]**). | S |
| ORA-07 | Sync status is visible on Stock and Trends: "Issues up to HH:MM". If the last successful import is older than 30 minutes, a warning is shown to everyone and admins are notified. | M |
| ORA-08 | Admin screen: connection test, last runs (time, rows read, rows imported, unmapped, errors), and "Run now". | M |
| ORA-09 | Historic backfill: on first run, import issues from a chosen start date so Trends have history from day one. | S |
| ORA-10 | The Oracle database load stays small: one query per run, indexed on the incremental key, row limit per run. | M |

### 6.4 Stock — summary (front page)

| ID | Requirement | Pri |
|---|---|---|
| STK-01 | Per garment: total on hand (Fab1 + Fab2) in large print with icon, plus "About N.N days at the usual rate". | M |
| STK-02 | **Reorder** list: the 5 stock items furthest below minimum (by on hand ÷ min), each "Garment · color · size · location — on hand / min". | M |
| STK-03 | **By location**: totals per garment for Fab1 and Fab2. | M |
| STK-04 | Today at a glance: delivered today and issued today per garment. | M |
| STK-05 | Freshness stamp ("As of HH:MM · issues up to HH:MM"); refreshes without manual reload. | S |

### 6.5 Stock — grid

| ID | Requirement | Pri |
|---|---|---|
| GRD-01 | Choose garment (Gowns / Hoods / Boots, with icons) and location (Fab1 / Fab2). | M |
| GRD-02 | Rows = sizes, columns = colors; each cell shows on hand, colored by status with a text legend; non-stocked cells show "—"; negative cells clearly flagged. | M |
| GRD-03 | Tapping a cell shows a detail panel: title, status, on hand, minimum with −/+ ("Alert below"), location, issued today, last delivery. | M |
| GRD-04 | Changing the minimum takes effect everywhere immediately and is logged. Minimum ≥ 1 once stocked. | M |
| GRD-05 | Switching garment/location keeps the same color/size selected if it exists, else White · LG. | S |
| GRD-06 | Selecting a non-stocked cell lets the lead set a minimum to start stocking it. | S |

### 6.6 Trends (the lead's three questions)

| ID | Requirement | Pri |
|---|---|---|
| TRD-01 | **Delivered per period**: bar chart of items delivered per day, with a switch for per week / per month, total for the range. | M |
| TRD-02 | **Issued per day**: bar chart of items issued per day, "N a weekday, on average", today marked "so far". | M |
| TRD-03 | **Stock over time**: line per garment for the selected range, legend with current value. | M |
| TRD-04 | **Deliveries vs issues**: mirrored bars on a shared baseline per day, with "Delivered N · Issued N · Net ±N". | M |
| TRD-05 | Range 7 / 14 / 30 / 90 days (**[OPEN]** confirm); filter by garment and location. | M |
| TRD-06 | Breakdown by size and by location (Fab1 vs Fab2), switchable between Delivered / Issued / Stock. | S |
| TRD-07 | Export the data behind any chart as CSV. | S |

### 6.7 Settings — sizes and colors

| ID | Requirement | Pri |
|---|---|---|
| SET-01 | Sizes and colors as removable chips; add a new size / color by text. | M |
| SET-02 | New values appear immediately in Receive, Stock, Stock correction and item mapping. | M |
| SET-03 | Removing a value only **hides** it; stock records and history are kept and it can be restored. | M |
| SET-04 | Sizes keep a user-defined display order. | S |
| SET-05 | Only lead/admin can change master data. | M |

### 6.8 Settings — stock correction

| ID | Requirement | Pri |
|---|---|---|
| ADJ-01 | Banner: "Only for when the system count is wrong. To fix a delivery, use Receive › History instead. Every correction is logged." | M |
| ADJ-02 | Pick garment, color, size, location → show **In system**; enter **Counted on the shelf**; show the difference live. | M |
| ADJ-03 | Reason required: Starting count, Spot check, Damaged, Found, Miscount at delivery, Other (note required for Other). | M |
| ADJ-04 | Save sets on hand to the counted value and adds to **Recent corrections**: item, reason, date time, "from → to". | M |
| ADJ-05 | **Starting count** for go-live: enter counts for many items at once (size × color grid per garment and location) or import a CSV. | M |
| ADJ-06 | Full correction log, filterable by item, reason, user, date. | S |
| ADJ-07 | Only the lead/admin can make stock corrections. | M |

### 6.9 Settings — Oracle item mapping

| ID | Requirement | Pri |
|---|---|---|
| MAP-01 | List Oracle items (code, description, location) with their GI stock item; edit the mapping with garment / color / size / location dropdowns. | M |
| MAP-02 | Unmapped items are shown first with a count of held issues. | M |
| MAP-03 | Mapping changes are logged; changing an existing mapping affects only issues imported afterwards (**[OPEN]** or re-apply history?). | M |
| MAP-04 | If the Oracle data already carries garment type, color, size and location as separate fields, mapping is automatic and this screen only handles exceptions. | S |

### 6.10 Alerts

| ID | Requirement | Pri |
|---|---|---|
| ALR-01 | When an item drops below its minimum, show it in the app (badge on Stock) for the lead. | M |
| ALR-02 | Daily digest to the lead of items below minimum and any negative stock. **[OPEN]** channel (email / Teams). | S |
| ALR-03 | Alert when the Oracle import has failed or is stale (ORA-07). | M |

### 6.11 Audit

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

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 **Responsive web app** | Runs in the browser; no app install. Phone (390 px) first: single column, touch targets ≥ 44 px, tabs across the top. |
| NFR-02 **Laptop** | ≥ 900 px wide: tabs move to a left sidebar; layouts widen (mockup: 1440 × 900). |
| NFR-03 **Cleanroom-friendly** | Usable with gloves: large targets, −/+ steppers, numeric keypad for quantities, high contrast. |
| NFR-04 **Manual entry only** | No barcode scanning and no scanner hardware. |
| NFR-05 **Performance** | Screens load in < 2 s on plant Wi-Fi; posting a delivery < 1 s; charts for 90 days < 2 s. |
| NFR-06 **Reliability** | Draft deliveries survive connection drops; posting is idempotent; the Oracle import is idempotent and resumes after downtime without gaps. |
| NFR-07 **Concurrency** | A delivery being posted while issues are imported must not lose either update. |
| NFR-08 **Database** | MariaDB (InnoDB) is GI's system of record. The Oracle database is read-only source data. |
| NFR-09 **Security** | Intranet only (`garments.fab.local`), HTTPS, company SSO, role-based access. Oracle credentials stored as secrets, never in code; least-privilege read-only Oracle account. |
| NFR-10 **Data retention** | Ledger and history kept ≥ 2 years. **[OPEN]** confirm. |
| NFR-11 **Accessibility** | WCAG 2.1 AA contrast; status never by color alone. |
| NFR-12 **Look & feel** | "Broadsheet" design system tokens used in the mockups (`design/mockups/_ds/`). |
| NFR-13 **Locale** | English; dates like "Mon 5 Oct · 09:41"; site time zone (Oracle and MariaDB timestamps normalized). |

## 9. Acceptance criteria (v1 sign-off)

- Floor staff enter and post a 5-line mixed delivery on a phone in under 2 minutes.
- After posting, Stock and Trends show the new quantities without reload.
- An issue recorded in Oracle appears in GI (issued today, on hand reduced) within the agreed freshness window.
- Re-running the import for an already imported period changes nothing.
- An Oracle item with no mapping appears under Unmapped items and does not change stock until mapped; once mapped, its held issues are applied.
- Correcting a delivery by −10 reduces on hand by exactly 10 and marks it "Edited"; voiding reverses all its lines.
- The lead can answer, on a phone, "how many delivered this week", "how many issued per day" and "how many in stock" from the Trends and Stock tabs.
- On hand recomputed from the ledger equals stored on hand for every item.
- **Pilot check:** during the 2-week parallel run, system stock matches manual counts within the agreed accuracy target.

## 10. Open questions

1. **Oracle issue data**: which system writes it, which table/view, and at what detail — does each record carry garment type, color, size and location, or only an item code? (Decides whether stock can be shown per size/color or only per garment type.)
2. Is the Oracle record ID stable and unique? Are cancellations / returns recorded, and how?
3. Who grants the read-only Oracle account and network access from the GI server; any query-window restrictions?
4. Required freshness of issue data (5 min? hourly? daily?).
5. How far back to backfill issue history.
6. Starting count: one full count per location at go-live, or from an existing spreadsheet?
7. Default minimum for new stock items (mockup: 2) and the "Close to min" threshold.
8. Delivery chart periods (day / week / month) and trend ranges.
9. Approval rules for large or late delivery corrections.
10. Alert channel (email, Teams, other).
11. Additional garment types (gloves, masks, liners, glasses).
12. Hosting (on-prem vs internal cloud), SSO provider, existing MariaDB server or a new one.
