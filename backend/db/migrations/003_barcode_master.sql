-- 2026-11-24: barcode master (the attributes of each barcode) and issue rows that need it.
--
-- The Oracle barcode master table (setting ORACLE_BARCODE_MASTER_TABLE, or a CSV upload) can hold several rows
-- per barcode; the one with the latest RECTIME is the barcode's current type, color and size. GI keeps only
-- that latest version here. RECTIME is only compared with other RECTIMEs of the same table (raw value).
CREATE TABLE barcode_master (
  suit_barcode   VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin PRIMARY KEY,
  suit_category  VARCHAR(64) NULL,
  suit_type      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,
  suit_color     VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,
  suit_size      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,
  rectime        DATETIME NOT NULL,                  -- raw RECTIME of the version kept
  versions       INT UNSIGNED NOT NULL DEFAULT 1,    -- rows read for this barcode the last time it was read
  -- TRUE when two rows share the latest RECTIME but have other values: GI cannot tell which is current
  -- and does not use this barcode to decide anything until a newer row arrives.
  tied           BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

-- Issue rows: values may be empty (NULL) in Oracle; such a row is recorded (missing_values) and its type,
-- color and size are filled from the barcode master. Several rows for the same scan with other values are a
-- conflict: the row matching the barcode master is kept. Until the master can decide, the scan is held.
ALTER TABLE issue_import
  MODIFY suit_type  VARCHAR(64) NULL,
  MODIFY suit_color VARCHAR(64) NULL,
  MODIFY suit_size  VARCHAR(64) NULL,
  MODIFY suit_level VARCHAR(64) NULL,
  ADD COLUMN missing_values SET('SUIT_TYPE','SUIT_COLOR','SUIT_SIZE','SUIT_LEVEL') NULL AFTER suit_level,  -- empty in Oracle
  ADD COLUMN conflict ENUM('pending','resolved') NULL AFTER missing_values,  -- several versions of the scan
  MODIFY status ENUM('applied','held_unmapped','held_conflict','held_missing','before_start','ignored') NOT NULL,
  ADD KEY ix_issue_waiting (status, suit_barcode);

-- Other versions of a scan; '' stands for an empty (NULL) Oracle value, so the unique key also covers them.
-- issue_import_id is the scan; the version in issue_import is the one kept.

ALTER TABLE sync_run
  MODIFY kind ENUM('poll','sweep','backfill','upload','master','master_upload') NOT NULL,
  ADD COLUMN rows_missing INT UNSIGNED NOT NULL DEFAULT 0 AFTER rows_conflicts,  -- new scans with empty values
  ADD COLUMN rows_waiting INT UNSIGNED NOT NULL DEFAULT 0 AFTER rows_held,       -- new scans waiting for the barcode master
  ADD COLUMN rows_resolved INT UNSIGNED NOT NULL DEFAULT 0 AFTER rows_waiting;   -- scans decided or filled by the barcode master
