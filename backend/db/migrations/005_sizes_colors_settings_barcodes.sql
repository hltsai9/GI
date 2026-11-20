-- New sizes and color (requested 2026-11-20). If one was already added in Settings › Sizes & colors,
-- it is only made visible again. Size order: XSM first; 5XLG–7XLG after 4XLG; UNI before Other.
INSERT INTO color (name, sort, is_system) VALUES ('Grey', 5, FALSE)
  ON DUPLICATE KEY UPDATE active = TRUE;
INSERT INTO size (code, sort, is_system) VALUES ('XSM', 0, FALSE), ('5XLG', 8, FALSE), ('6XLG', 9, FALSE), ('7XLG', 10, FALSE), ('UNI', 11, FALSE)
  ON DUPLICATE KEY UPDATE active = TRUE;
UPDATE size SET sort = CASE code
    WHEN 'XSM' THEN 1 WHEN 'SM' THEN 2 WHEN 'MED' THEN 3 WHEN 'LG' THEN 4 WHEN 'XLG' THEN 5
    WHEN '2XLG' THEN 6 WHEN '3XLG' THEN 7 WHEN '4XLG' THEN 8 WHEN '5XLG' THEN 9 WHEN '6XLG' THEN 10
    WHEN '7XLG' THEN 11 WHEN 'UNI' THEN 12 WHEN 'Other' THEN 13 ELSE sort + 13 END
  WHERE NOT is_system;
UPDATE color SET sort = CASE name WHEN 'Grey' THEN 4 WHEN 'Other' THEN 5 ELSE sort END WHERE NOT is_system;

-- Settings the lead can change in the app.
CREATE TABLE app_setting (
  name        VARCHAR(64)  NOT NULL PRIMARY KEY,
  value       VARCHAR(255) NOT NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_setting_user FOREIGN KEY (updated_by) REFERENCES app_user(id)
) ENGINE=InnoDB;
-- Whether issues of unregistered barcodes (GOWN / OTHER / OTHER) count in the issued numbers (DQ).
INSERT INTO app_setting (name, value) VALUES ('count_unregistered_issues', 'true');

-- Barcodes are kept exactly as Oracle has them: case and spaces matter (the default collation ignored
-- case and trailing spaces), and dirty barcodes can be longer than 64 characters.
ALTER TABLE issue_import MODIFY suit_barcode VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL;
