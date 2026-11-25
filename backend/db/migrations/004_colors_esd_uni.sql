-- 2026-11-24: colors ESD and UNI, listed after Grey and before Other.
-- If a site already added one of them in Settings › Sizes & colors, it is kept (and shown again if hidden).
UPDATE color SET sort = 7 WHERE name = 'Other' AND NOT is_system;
INSERT INTO color (name, sort, is_system) VALUES ('ESD', 5, FALSE), ('UNI', 6, FALSE)
  ON DUPLICATE KEY UPDATE sort = VALUES(sort), active = TRUE;
