# To-do — open questions to clarify

Checklist of the **[OPEN]** items in the [URD](./URD.md). Tick an item when it is answered, and update the URD / [build plan](./BUILD_PLAN.md) with the answer.

## Check with the lead (requester)

- [ ] **Cancellations / reversals** — does it happen that a garment is issued by mistake (wrong scan) or handed back unused? How often? Is it recorded anywhere — in the issuing system (as a separate row, e.g. another `STATE`, since rows are never edited or deleted) or on paper? → decides ORA-06. Until answered, reversals are fixed with a stock correction.
- [ ] **Vendor fix for GOWN / OTHER / OTHER rows** — expected date (old rows will not be corrected). → DQ-07
- [ ] **Tablets** — will anyone use GI on a tablet? If so, phone or laptop layout? (Default: laptop layout with touch-size targets.) → NFR-02b
- [ ] **Import interval** — how fresh must stock and "issued today" be? Every 5 minutes (default), hourly, or every 6 / 12 hours? Per-day totals are correct either way; a longer interval only delays them. → ORA-01, §2.1
- [ ] **History** — how far back to load issue history for Trends. → ORA-09
- [ ] **Accuracy target** — spot check within ±5 % for ≥ 95 % of stocked items? → §2.1
- [ ] **Per-employee usage report** — wanted? If not, `EMPLOYEE_ID` stays out of GI. → §6.3
- [ ] **Minimums** — default minimum for new stock items (mockup: 2) and the "Close to min" threshold (1.5 × min). → RCV-06, §5
- [ ] **Charts** — delivery chart periods (day / week / month) and trend ranges (7 / 14 / 30 / 90 days). → TRD-01, TRD-05
- [ ] **Approval rules** — delivery corrections older than N days or larger than X items need the lead? → HIS-07
- [ ] **Alerts** — channel for the daily digest (email, Teams, other). → ALR-02
- [ ] **Garment types** — any more than gowns, hoods, boots (gloves, masks, liners, glasses)? → §5
- [ ] **Standing order** — is there one to check deliveries against (mockup 1c)? → §3.3
- [ ] **Data retention** — keep history ≥ 2 years? → NFR-10

- [ ] **Spot checks while barcodes are unregistered** — how often can floor staff do a quick full count per fab (e.g. weekly) to clear the unregistered bucket? → DQ-06
- [ ] **Estimated split** — show unregistered issues split across gowns / hoods / boots by the usual mix, labelled "estimated", in Trends? → DQ-09
- [ ] **Site time zone** — are both fabs in Taiwan, so days and times are shown in Taipei time? → NFR-13

## Check with the vendor / Oracle DBA

- [x] **`INSERT_TIME` vs `RECTIME`** — `INSERT_TIME` = scan/issue time (Taipei), `RECTIME` = record entered (Phoenix); they can be on different days. → ORA-03, ORA-12
- [ ] **Delay between scan and record** — how long after the scan is a record usually entered, and what is the longest it can be (hours? days?) → decides how late "issued today" and stock can be, and the reconciliation window (7 days assumed)
- [ ] **Column types** — are `INSERT_TIME` / `RECTIME` `DATE`, `TIMESTAMP`, or `TIMESTAMP WITH TIME ZONE`? → ORA-12
- [ ] **Index** — is there an index on `RECTIME` (ideally `STATE, RECTIME`) in the issue table? If not, can one be added, or a view provided? → ORA-10
- [ ] **Cancellations in Oracle** — if the lead confirms they happen: how does the issuing system record them? → ORA-06
- [ ] **Late registration** — when a garment is issued with an unregistered barcode (GOWN / OTHER / OTHER), is that barcode registered in the suit master later? If yes, GI can move its earlier issues to the right size and color (DQ-08). If barcodes are never registered afterwards, DQ-08 is dropped. → DQ-08

## At installation (configuration, not in the repository)

- [ ] Oracle connect string, read-only account and password (as a secret)
- [ ] Oracle issue table name (and suit master table name, only if DQ-08 is built)
- [ ] Network access from the GI server to the Oracle database
- [ ] Hosting (on-prem vs internal cloud), SSO provider, MariaDB server (existing or new)

## Technical decisions (developer)

- [ ] Changing an existing value mapping: apply only to new rows, or re-apply to history? → MAP-03
