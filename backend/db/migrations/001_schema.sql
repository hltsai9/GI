-- GI schema (MariaDB 10.11+ / 11.4 LTS). All DATETIME columns hold UTC unless noted.
-- See docs/BUILD_PLAN.md §2 for the design. Consolidated on 2026-11-23, and again on 2026-11-24 (barcode master,
-- colors ESD / UNI, empty RECTIME merged in). An older database must be dropped and re-created (docs/RELEASE_NOTES.md).

-- ---------------------------------------------------------------- reference data
CREATE TABLE garment_type (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code       VARCHAR(32)  NOT NULL UNIQUE,
  name       VARCHAR(64)  NOT NULL,
  plural     VARCHAR(64)  NOT NULL,
  unit       VARCHAR(16)  NOT NULL DEFAULT 'pieces',   -- how it is counted: pieces; boots in pairs
  icon       VARCHAR(64)  NULL,
  sort       INT          NOT NULL DEFAULT 0,
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  is_system  BOOLEAN      NOT NULL DEFAULT FALSE      -- the hidden "Unregistered" type (DQ-03)
) ENGINE=InnoDB;

CREATE TABLE color (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(64)  NOT NULL UNIQUE,
  sort       INT          NOT NULL DEFAULT 0,
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  is_system  BOOLEAN      NOT NULL DEFAULT FALSE
) ENGINE=InnoDB;

CREATE TABLE size (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code       VARCHAR(32)  NOT NULL UNIQUE,
  sort       INT          NOT NULL DEFAULT 0,
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  is_system  BOOLEAN      NOT NULL DEFAULT FALSE
) ENGINE=InnoDB;

CREATE TABLE location (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code       VARCHAR(32)  NOT NULL UNIQUE,
  name       VARCHAR(64)  NOT NULL
) ENGINE=InnoDB;

CREATE TABLE app_user (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sso_subject  VARCHAR(191) NOT NULL UNIQUE,
  name         VARCHAR(128) NOT NULL,
  role         ENUM('floor','lead','viewer','admin') NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- current balance
CREATE TABLE stock_item (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  garment_type_id  BIGINT UNSIGNED NOT NULL,
  color_id         BIGINT UNSIGNED NOT NULL,
  size_id          BIGINT UNSIGNED NOT NULL,
  location_id      BIGINT UNSIGNED NOT NULL,
  on_hand          INT NOT NULL DEFAULT 0,              -- signed on purpose (URD rule 7.4)
  min_qty          INT UNSIGNED NULL,                   -- NULL = not stocked
  updated_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_stock_item (garment_type_id, color_id, size_id, location_id),
  CONSTRAINT fk_si_type  FOREIGN KEY (garment_type_id) REFERENCES garment_type(id),
  CONSTRAINT fk_si_color FOREIGN KEY (color_id)        REFERENCES color(id),
  CONSTRAINT fk_si_size  FOREIGN KEY (size_id)         REFERENCES size(id),
  CONSTRAINT fk_si_loc   FOREIGN KEY (location_id)     REFERENCES location(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- deliveries
CREATE TABLE delivery (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  received_at      DATETIME(6) NOT NULL,                -- may be back-dated (RCV-08)
  received_day     DATE NOT NULL,                       -- site-time day of received_at
  created_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by       BIGINT UNSIGNED NOT NULL,
  status           ENUM('posted','corrected','voided') NOT NULL DEFAULT 'posted',
  note             VARCHAR(255) NULL,
  idempotency_key  VARCHAR(64) NOT NULL UNIQUE,
  KEY ix_delivery_day (received_day),
  CONSTRAINT fk_del_user FOREIGN KEY (created_by) REFERENCES app_user(id)
) ENGINE=InnoDB;

CREATE TABLE delivery_line (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  delivery_id    BIGINT UNSIGNED NOT NULL,
  stock_item_id  BIGINT UNSIGNED NOT NULL,
  qty_original   INT UNSIGNED NOT NULL,
  qty_current    INT UNSIGNED NOT NULL,
  CONSTRAINT ck_dl_qty CHECK (qty_original > 0),
  CONSTRAINT fk_dl_delivery FOREIGN KEY (delivery_id)   REFERENCES delivery(id),
  CONSTRAINT fk_dl_item     FOREIGN KEY (stock_item_id) REFERENCES stock_item(id)
) ENGINE=InnoDB;

CREATE TABLE delivery_correction (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  delivery_id  BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  at           DATETIME(6) NOT NULL,
  is_void      BOOLEAN NOT NULL DEFAULT FALSE,
  total_delta  INT NOT NULL,
  note         VARCHAR(255) NULL,
  CONSTRAINT fk_dc_delivery FOREIGN KEY (delivery_id) REFERENCES delivery(id),
  CONSTRAINT fk_dc_user     FOREIGN KEY (user_id)     REFERENCES app_user(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- stock corrections / starting count
CREATE TABLE starting_count (
  location_id  BIGINT UNSIGNED PRIMARY KEY,
  as_of        DATETIME(6) NOT NULL,
  entered_by   BIGINT UNSIGNED NOT NULL,
  entered_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_sc_loc  FOREIGN KEY (location_id) REFERENCES location(id),
  CONSTRAINT fk_sc_user FOREIGN KEY (entered_by)  REFERENCES app_user(id)
) ENGINE=InnoDB;

CREATE TABLE stock_correction (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stock_item_id  BIGINT UNSIGNED NOT NULL,
  counted        INT NOT NULL,
  system_qty     INT NOT NULL,
  reason         ENUM('starting_count','spot_check','damaged','found','miscount_at_delivery','other') NOT NULL,
  note           VARCHAR(255) NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  at             DATETIME(6) NOT NULL,
  CONSTRAINT ck_sc_other_note CHECK (reason <> 'other' OR (note IS NOT NULL AND note <> '')),
  CONSTRAINT fk_corr_item FOREIGN KEY (stock_item_id) REFERENCES stock_item(id),
  CONSTRAINT fk_corr_user FOREIGN KEY (user_id)       REFERENCES app_user(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Oracle issue import
CREATE TABLE oracle_value_map (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  oracle_column    ENUM('SUIT_TYPE','SUIT_COLOR','SUIT_SIZE','SUIT_LEVEL') NOT NULL,
  oracle_value     VARCHAR(64) NOT NULL,
  garment_type_id  BIGINT UNSIGNED NULL,
  color_id         BIGINT UNSIGNED NULL,
  size_id          BIGINT UNSIGNED NULL,
  location_id      BIGINT UNSIGNED NULL,
  is_ignored       BOOLEAN NOT NULL DEFAULT FALSE,
  row_count        INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen       DATETIME(6) NULL,
  last_seen        DATETIME(6) NULL,
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME(6) NULL,
  UNIQUE KEY uq_ovm (oracle_column, oracle_value),
  -- at most the one FK matching oracle_column may be set; ignored rows set none
  CONSTRAINT ck_ovm_target CHECK (
    (garment_type_id IS NULL OR (oracle_column = 'SUIT_TYPE'  AND NOT is_ignored)) AND
    (color_id        IS NULL OR (oracle_column = 'SUIT_COLOR' AND NOT is_ignored)) AND
    (size_id         IS NULL OR (oracle_column = 'SUIT_SIZE'  AND NOT is_ignored)) AND
    (location_id     IS NULL OR (oracle_column = 'SUIT_LEVEL' AND NOT is_ignored))
  ),
  CONSTRAINT fk_ovm_type  FOREIGN KEY (garment_type_id) REFERENCES garment_type(id),
  CONSTRAINT fk_ovm_color FOREIGN KEY (color_id)        REFERENCES color(id),
  CONSTRAINT fk_ovm_size  FOREIGN KEY (size_id)         REFERENCES size(id),
  CONSTRAINT fk_ovm_loc   FOREIGN KEY (location_id)     REFERENCES location(id),
  CONSTRAINT fk_ovm_user  FOREIGN KEY (updated_by)      REFERENCES app_user(id)
) ENGINE=InnoDB;

CREATE TABLE dq_pattern (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  suit_type   VARCHAR(64) NOT NULL,
  suit_color  VARCHAR(64) NOT NULL,
  suit_size   VARCHAR(64) NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY uq_dq (suit_type, suit_color, suit_size)
) ENGINE=InnoDB;

CREATE TABLE sync_run (
  id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind                    ENUM('poll','sweep','backfill','upload','master','master_upload') NOT NULL,
  note                    VARCHAR(255) NULL,            -- e.g. the uploaded file's name
  started_at              DATETIME(6) NOT NULL,
  finished_at             DATETIME(6) NULL,
  rows_read               INT UNSIGNED NOT NULL DEFAULT 0,
  rows_total              INT UNSIGNED NULL,            -- CSV upload: issue rows in the file (progress)
  rows_other_state        INT UNSIGNED NULL,            -- CSV upload: rows skipped for another STATE
  rows_new                INT UNSIGNED NOT NULL DEFAULT 0,
  rows_conflicts          INT UNSIGNED NOT NULL DEFAULT 0, -- rows repeating a scan with other values (first time seen)
  rows_missing            INT UNSIGNED NOT NULL DEFAULT 0, -- new scans with an empty value in Oracle
  rows_applied            INT UNSIGNED NOT NULL DEFAULT 0,
  rows_held               INT UNSIGNED NOT NULL DEFAULT 0, -- held_unmapped
  rows_waiting            INT UNSIGNED NOT NULL DEFAULT 0, -- new scans waiting for the barcode master
  rows_resolved           INT UNSIGNED NOT NULL DEFAULT 0, -- scans decided or filled by the barcode master
  rows_ignored            INT UNSIGNED NOT NULL DEFAULT 0,
  rows_before_start       INT UNSIGNED NOT NULL DEFAULT 0,
  rows_incomplete         INT UNSIGNED NOT NULL DEFAULT 0,
  rows_time_check_failed  INT UNSIGNED NOT NULL DEFAULT 0, -- scans in the future (ORA-13)
  first_issued_day        DATE NULL,
  last_issued_day         DATE NULL,
  status                  ENUM('running','ok','failed') NOT NULL DEFAULT 'running',
  error                   TEXT NULL
) ENGINE=InnoDB;

-- Barcode master: the latest version of each barcode (highest RECTIME; a row without RECTIME counts as the
-- oldest) from the Oracle table ORACLE_BARCODE_MASTER_TABLE or CSV uploads. RECTIME is only compared with
-- other RECTIMEs of the same table (raw value).
CREATE TABLE barcode_master (
  suit_barcode   VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin PRIMARY KEY,
  suit_category  VARCHAR(64) NULL,
  suit_type      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,
  suit_color     VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,
  suit_size      VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NULL,
  rectime        DATETIME NULL,                      -- raw RECTIME of the version kept; NULL = it had none
  versions       INT UNSIGNED NOT NULL DEFAULT 1,    -- rows read for this barcode the last time it was read
  -- TRUE when two rows share the latest RECTIME (or both have none) but have other values: GI cannot tell
  -- which is current and does not use this barcode to decide anything until a newer row arrives.
  tied           BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

CREATE TABLE issue_import (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  -- exactly as in Oracle (case, leading and inner spaces); trailing padding removed
  suit_barcode   VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  insert_time    DATETIME NOT NULL,                     -- raw Oracle DATE: the scan (= issue) time, Phoenix local time
  -- the version kept; type / color / size filled from the barcode master when empty in Oracle (NULL = still empty)
  suit_type      VARCHAR(64) NULL,
  suit_color     VARCHAR(64) NULL,
  suit_size      VARCHAR(64) NULL,
  suit_level     VARCHAR(64) NULL,
  missing_values SET('SUIT_TYPE','SUIT_COLOR','SUIT_SIZE','SUIT_LEVEL') NULL,  -- columns empty in Oracle
  conflict       ENUM('pending','resolved') NULL,       -- several versions of the scan: undecided / decided by the barcode master
  issued_at      DATETIME(6) NOT NULL,                  -- INSERT_TIME in UTC
  issued_day     DATE NOT NULL,                         -- site-time (Phoenix) day of the scan
  location_id    BIGINT UNSIGNED NULL,
  stock_item_id  BIGINT UNSIGNED NULL,
  quality        ENUM('complete','incomplete','recovered') NOT NULL,
  status         ENUM('applied','held_unmapped','held_conflict','held_missing','before_start','ignored') NOT NULL,
  sync_run_id    BIGINT UNSIGNED NULL,
  imported_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_issue (suit_barcode, insert_time),      -- ORA-02: each scan once
  KEY ix_issue_insert_time (insert_time),               -- the import resumes from the newest scan
  KEY ix_issue_at (issued_at),
  KEY ix_issue_status (status),
  -- each index below holds every column its query needs (Daily grid, Trends, Stock, Data quality)
  KEY ix_issue_day_status_item (issued_day, status, stock_item_id),
  KEY ix_issue_barcode_values (suit_barcode, suit_type, suit_color, suit_size),
  KEY ix_issue_quality_barcode (quality, suit_barcode, issued_at, suit_level),
  KEY ix_issue_waiting (status, suit_barcode),
  CONSTRAINT fk_ii_loc  FOREIGN KEY (location_id)   REFERENCES location(id),
  CONSTRAINT fk_ii_item FOREIGN KEY (stock_item_id) REFERENCES stock_item(id),
  CONSTRAINT fk_ii_run  FOREIGN KEY (sync_run_id)   REFERENCES sync_run(id)
) ENGINE=InnoDB;

-- Other versions of a scan (same SUIT_BARCODE and INSERT_TIME, other type, color, size or level): not counted
-- (ORA-02); the barcode master decides which version is kept in issue_import. '' stands for an empty Oracle value.
CREATE TABLE issue_import_conflict (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_import_id  BIGINT UNSIGNED NOT NULL,          -- the scan; the version kept is in issue_import
  suit_type        VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  suit_color       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  suit_size        VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  suit_level       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  times            INT UNSIGNED NOT NULL DEFAULT 1,   -- how often this version was seen (uploads, re-reads)
  sync_run_id      BIGINT UNSIGNED NULL,
  first_seen_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_conflict (issue_import_id, suit_type, suit_color, suit_size, suit_level),
  CONSTRAINT fk_conflict_issue FOREIGN KEY (issue_import_id) REFERENCES issue_import(id) ON DELETE CASCADE,
  CONSTRAINT fk_conflict_run   FOREIGN KEY (sync_run_id)     REFERENCES sync_run(id)
) ENGINE=InnoDB;

-- Unregistered barcodes the lead or admin chose to leave out of the issued numbers, one by one (dirty data).
-- Their issues get status 'ignored' (stock movements reversed); removing the row counts them again.
CREATE TABLE excluded_barcode (
  suit_barcode  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL PRIMARY KEY,
  note          VARCHAR(255) NULL,
  excluded_by   BIGINT UNSIGNED NULL,
  excluded_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_excl_user FOREIGN KEY (excluded_by) REFERENCES app_user(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- stock history (append-only)
CREATE TABLE ledger_entry (
  id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stock_item_id           BIGINT UNSIGNED NOT NULL,
  at                      DATETIME(6) NOT NULL,         -- when the movement happened (UTC)
  day                     DATE NOT NULL,                -- site-time day of `at`
  kind                    ENUM('starting_count','delivery','delivery_correction','issue','issue_correction','stock_correction') NOT NULL,
  delta                   INT NOT NULL,
  qty_before              INT NOT NULL,
  qty_after               INT NOT NULL,
  source                  ENUM('user','oracle_import') NOT NULL,
  user_id                 BIGINT UNSIGNED NULL,
  delivery_line_id        BIGINT UNSIGNED NULL,
  delivery_correction_id  BIGINT UNSIGNED NULL,
  issue_import_id         BIGINT UNSIGNED NULL,
  stock_correction_id     BIGINT UNSIGNED NULL,
  written_at              DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY ix_le_item_at (stock_item_id, at),
  KEY ix_le_day_item (day, stock_item_id, delta),
  CONSTRAINT ck_le_user CHECK ((source = 'user') = (user_id IS NOT NULL)),
  CONSTRAINT ck_le_after CHECK (qty_after = qty_before + delta),
  CONSTRAINT ck_le_cause CHECK (CASE kind
      WHEN 'delivery'            THEN delivery_line_id IS NOT NULL AND delivery_correction_id IS NULL AND issue_import_id IS NULL AND stock_correction_id IS NULL
      WHEN 'delivery_correction' THEN delivery_line_id IS NOT NULL AND delivery_correction_id IS NOT NULL AND issue_import_id IS NULL AND stock_correction_id IS NULL
      WHEN 'issue'               THEN issue_import_id IS NOT NULL AND delivery_line_id IS NULL AND delivery_correction_id IS NULL AND stock_correction_id IS NULL
      WHEN 'issue_correction'    THEN issue_import_id IS NOT NULL AND delivery_line_id IS NULL AND delivery_correction_id IS NULL AND stock_correction_id IS NULL
      ELSE                            stock_correction_id IS NOT NULL AND delivery_line_id IS NULL AND delivery_correction_id IS NULL AND issue_import_id IS NULL
    END),
  CONSTRAINT fk_le_item FOREIGN KEY (stock_item_id)          REFERENCES stock_item(id),
  CONSTRAINT fk_le_user FOREIGN KEY (user_id)                REFERENCES app_user(id),
  CONSTRAINT fk_le_dl   FOREIGN KEY (delivery_line_id)       REFERENCES delivery_line(id),
  CONSTRAINT fk_le_dc   FOREIGN KEY (delivery_correction_id) REFERENCES delivery_correction(id),
  CONSTRAINT fk_le_ii   FOREIGN KEY (issue_import_id)        REFERENCES issue_import(id),
  CONSTRAINT fk_le_sc   FOREIGN KEY (stock_correction_id)    REFERENCES stock_correction(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- audit and alerts
CREATE TABLE audit_log (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  user_id    BIGINT UNSIGNED NULL,
  entity     VARCHAR(64) NOT NULL,
  entity_id  VARCHAR(64) NULL,
  action     ENUM('create','update','deactivate','restore','reclassify') NOT NULL,
  before_json JSON NULL,
  after_json  JSON NULL,
  KEY ix_audit_entity (entity, entity_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES app_user(id)
) ENGINE=InnoDB;

CREATE TABLE admin_alert (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at               DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  kind             ENUM('time_check','sweep_found_rows','import_stale','import_failed','data_conflict') NOT NULL,
  message          VARCHAR(500) NOT NULL,
  details          JSON NULL,
  acknowledged_by  BIGINT UNSIGNED NULL,
  acknowledged_at  DATETIME(6) NULL,
  KEY ix_alert_open (acknowledged_at),
  CONSTRAINT fk_alert_user FOREIGN KEY (acknowledged_by) REFERENCES app_user(id)
) ENGINE=InnoDB;

-- Trends cache. v1 computes trends from the tables above; this table is filled only
-- if 90-day chart queries become slow (BUILD_PLAN §2.2).
CREATE TABLE daily_snapshot (
  day            DATE NOT NULL,
  stock_item_id  BIGINT UNSIGNED NOT NULL,
  on_hand        INT NULL,
  delivered      INT NOT NULL DEFAULT 0,
  issued         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, stock_item_id),
  CONSTRAINT fk_ds_item FOREIGN KEY (stock_item_id) REFERENCES stock_item(id)
) ENGINE=InnoDB;
