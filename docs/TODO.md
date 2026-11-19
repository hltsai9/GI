# To-do — open questions to clarify

Checklist of the **[OPEN]** items in the [URD](./URD.md). Tick an item when it is answered, and update the URD / [build plan](./BUILD_PLAN.md) with the answer.

## Check with the lead (requester)

- [x] **Cancellations / reversals** — none: staff check the input, so issues are not made by mistake. → ORA-06 dropped
- [ ] **Vendor fix for GOWN / OTHER / OTHER rows** — expected date (old rows will not be corrected). → DQ-07
- [x] **Tablets** — may be used; they get the laptop layout. → NFR-02b
- [ ] **Import interval** — how fresh must stock and "issued today" be? Every 5 minutes (default), hourly, or every 6 / 12 hours? Per-day totals are correct either way; a longer interval only delays them. → ORA-01, §2.1
- [ ] **History** — how far back to load issue history for Trends. → ORA-09
- [ ] **Accuracy target** — spot check within ±5 % for ≥ 95 % of stocked items? → §2.1
- [ ] **Per-employee usage report** — wanted? If not, `EMPLOYEE_ID` stays out of GI. → §6.3
- [ ] **Minimums** — default minimum for new stock items (mockup: 2) and the "Close to min" threshold (1.5 × min). → RCV-06, §5
- [ ] **Charts** — delivery chart periods (day / week / month) and trend ranges (7 / 14 / 30 / 90 days). → TRD-01, TRD-05
- [ ] **Approval rules** — delivery corrections older than N days or larger than X items need the lead? → HIS-07
- [ ] **Alerts** — channel for the daily digest (email, Teams, other). → ALR-02
- [x] **Garment types** — gowns, hoods, boots for v1; more may be added once the first release is stable. → §5
- [ ] **Standing order** — is there one to check deliveries against (mockup 1c)? → §3.3
- [ ] **Data retention** — keep history ≥ 2 years? → NFR-10

- [ ] **Spot checks while barcodes are unregistered** — how often can floor staff do a quick full count per fab (e.g. weekly) to clear the unregistered bucket? → DQ-06
- [ ] **Estimated split** — show unregistered issues split across gowns / hoods / boots by the usual mix, labelled "estimated", in Trends? → DQ-09
- [x] **Site time zone** — both fabs are in Phoenix; days and times shown in Phoenix time. → NFR-13

## Check with the vendor / Oracle DBA

- [x] **`INSERT_TIME` vs `RECTIME`** — `INSERT_TIME` = scan/issue time (Taipei), `RECTIME` = record entered (Phoenix); they can be on different days. → ORA-03, ORA-12
- [x] **Delay between scan and record** — usually within about 15 hours. → catch-up sweep window 3 days
- [x] **Check the 15 hours** — measured after converting to Phoenix time: delays are spread over single-digit hours up to 13–14 hours, so records really are entered up to ~15 hours after the scan. → ORA-12
- [x] **Is `INSERT_TIME` really Taipei time?** — consistent with the delay check: if `INSERT_TIME` were Phoenix time, every converted delay would be 15 hours or more; if it were UTC, 8 hours or more. Delays of a few hours rule both out. → ORA-12
- [x] **`RECTIME` earlier than `INSERT_TIME` (rare)** — seen about two months ago with gaps beyond −130 hours (over 5 days), not since. Assumed fixed; GI imports such rows and alerts the admin every time one appears. → ORA-13
- [ ] **Where is `RECTIME` set** — by the database server when the row is inserted, or by the recording app/PC at each location? If by each location's PC, clock differences would explain both the out-of-order times across locations and the rare `RECTIME` before scan. → ORA-03, ORA-13
- [x] **Column types** — `DATE` (the delay query returned plain numbers; `TIMESTAMP` columns would have returned intervals). To be certain: `SELECT column_name, data_type FROM all_tab_columns WHERE table_name = '<ISSUE_TABLE>' AND column_name IN ('INSERT_TIME','RECTIME')`. → ORA-12
- [ ] **Index** — are there indexes on `(STATE, SUIT_LEVEL, RECTIME)` and `(STATE, INSERT_TIME)` in the issue table? If not, can they be added, or a view provided? → ORA-10
- [x] **Cancellations in Oracle** — not needed (no cancellations). → ORA-06
- [ ] **Late registration** — when a garment is issued with an unregistered barcode (GOWN / OTHER / OTHER), is that barcode registered in the suit master later? If yes, GI can move its earlier issues to the right size and color (DQ-08). If barcodes are never registered afterwards, DQ-08 is dropped. → DQ-08

## At installation (configuration, not in the repository)

- [ ] Oracle connect string, read-only account and password (as a secret)
- [ ] Oracle issue table name (and suit master table name, only if DQ-08 is built)
- [ ] Network access from the GI server to the Oracle database
- [ ] Hosting (on-prem vs internal cloud), SSO provider, MariaDB server (existing or new)

## Technical decisions (developer)

- [ ] Changing an existing value mapping: apply only to new rows, or re-apply to history? → MAP-03
