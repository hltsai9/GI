-- 2026-11-24: some rows of the Oracle barcode master table have no RECTIME. Such a row counts as the oldest
-- version of its barcode: any row with a RECTIME wins over it; it is used only when the barcode has no dated row.
ALTER TABLE barcode_master MODIFY rectime DATETIME NULL;  -- NULL = the version kept has no RECTIME
