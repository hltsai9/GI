-- Unregistered barcodes the lead or admin chose to leave out of the issued numbers, one by one (dirty data).
-- Their issues get status 'ignored' (stock movements reversed); removing the row counts them again.
CREATE TABLE excluded_barcode (
  suit_barcode  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL PRIMARY KEY,
  note          VARCHAR(255) NULL,
  excluded_by   BIGINT UNSIGNED NULL,
  excluded_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_excl_user FOREIGN KEY (excluded_by) REFERENCES app_user(id)
) ENGINE=InnoDB;
-- Replaced by the per-barcode choice above.
DELETE FROM app_setting WHERE name = 'count_unregistered_issues';
