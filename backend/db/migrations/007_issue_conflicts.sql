-- A row with the same SUIT_BARCODE and INSERT_TIME as an issue already imported is the same scan and is not
-- counted again (ORA-02). If its type, color, size or level differ, it is recorded here, so the data quality
-- report can show both versions instead of the second one disappearing silently.
CREATE TABLE issue_import_conflict (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  issue_import_id  BIGINT UNSIGNED NOT NULL,          -- the row that was kept (and counted)
  suit_type        VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  suit_color       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  suit_size        VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  suit_level       VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  rectime          DATETIME NOT NULL,
  times            INT UNSIGNED NOT NULL DEFAULT 1,   -- how often this version was seen (uploads, re-reads)
  sync_run_id      BIGINT UNSIGNED NULL,
  first_seen_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_conflict (issue_import_id, suit_type, suit_color, suit_size, suit_level),
  CONSTRAINT fk_conflict_issue FOREIGN KEY (issue_import_id) REFERENCES issue_import(id) ON DELETE CASCADE,
  CONSTRAINT fk_conflict_run   FOREIGN KEY (sync_run_id)     REFERENCES sync_run(id)
) ENGINE=InnoDB;

ALTER TABLE admin_alert MODIFY kind ENUM('time_check','sweep_found_rows','import_stale','import_failed','data_conflict') NOT NULL;
ALTER TABLE sync_run ADD COLUMN rows_conflicts INT UNSIGNED NOT NULL DEFAULT 0 AFTER rows_new;
