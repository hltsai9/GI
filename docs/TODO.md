# To-do — open questions to clarify

Checklist of the **[OPEN]** items in the [URD](./URD.md). Tick an item when it is answered, and update the URD / [build plan](./BUILD_PLAN.md) with the answer.

## Check with the lead (requester)

- [ ] **Cancellations / reversals** — does it happen that a garment is issued by mistake (wrong scan) or handed back unused? How often? Is it recorded anywhere — in the issuing system (as a separate row, e.g. another `STATE`, since rows are never edited or deleted) or on paper? → decides ORA-06. Until answered, reversals are fixed with a stock correction.
- [ ] **Vendor fix for GOWN / OTHER / OTHER rows** — expected date (old rows will not be corrected). → DQ-07
- [ ] **Tablets** — will anyone use GI on a tablet? If so, phone or laptop layout? (Default: laptop layout with touch-size targets.) → NFR-02b
- [ ] **Freshness** — is an issue visible in GI within 15 minutes good enough (import every 5 minutes)? → ORA-01, §2.1
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

## Check with the vendor / Oracle DBA

- [ ] **`INSERT_TIME` vs `RECTIME`** — which is the moment the garment was issued, and which the time the row was written? → §6.3, import watermark and starting-count cut-off
- [ ] **Index** — is there an index on `INSERT_TIME` (ideally `STATE, INSERT_TIME`) in the issue table? If not, can one be added, or a view provided? → ORA-10
- [ ] **Cancellations in Oracle** — if the lead confirms they happen: how does the issuing system record them? → ORA-06
- [ ] **Suit master table** (optional) — for barcodes that appear in GOWN / OTHER / OTHER issue rows, does the master table hold the real color and size? If yes, use it as a second recovery source. → DQ-08

## At installation (configuration, not in the repository)

- [ ] Oracle connect string, read-only account and password (as a secret)
- [ ] Oracle issue table name (and suit master table name, if DQ-08 is used)
- [ ] Network access from the GI server to the Oracle database
- [ ] Hosting (on-prem vs internal cloud), SSO provider, MariaDB server (existing or new)

## Technical decisions (developer)

- [ ] Changing an existing value mapping: apply only to new rows, or re-apply to history? → MAP-03
