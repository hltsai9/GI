-- 2026-11-25: when several rows of a barcode share its latest RECTIME but differ in type, color or size, keep
-- every different version, so Data quality can show them (only one row is kept when they are the same).
ALTER TABLE barcode_master
  ADD COLUMN tie_values JSON NULL AFTER tied;  -- [[type, color, size], …] of the different rows at the latest RECTIME
