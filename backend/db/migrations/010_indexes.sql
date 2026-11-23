-- Indexes for the queries that grow with the number of imported issues (tens of thousands a week):
-- the Daily grid, Trends and Stock read issues and ledger entries of a day range; the data quality page
-- groups issues by barcode. Each index holds every column its query needs, so the table itself is not read.
ALTER TABLE issue_import
  ADD INDEX ix_issue_day_status_item (issued_day, status, stock_item_id),
  ADD INDEX ix_issue_barcode_values (suit_barcode, suit_type, suit_color, suit_size),
  ADD INDEX ix_issue_quality_barcode (quality, suit_barcode, issued_at, suit_level),
  DROP INDEX ix_issue_day,
  DROP INDEX ix_issue_barcode;
ALTER TABLE ledger_entry
  ADD INDEX ix_le_day_item (day, stock_item_id, delta),
  DROP INDEX ix_le_day;
