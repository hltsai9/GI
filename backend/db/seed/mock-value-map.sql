-- Value mapping for the codes used by the mock Oracle data (mock-oracle/generate.ts).
-- Applied at startup whenever ISSUE_SOURCE=mock. With real Oracle data the lead maps values in Settings.
INSERT IGNORE INTO oracle_value_map (oracle_column, oracle_value, garment_type_id)
  SELECT 'SUIT_TYPE', v.c, g.id FROM (SELECT 'GOWN' c, 'GOWN' g UNION ALL SELECT 'HOOD','HOOD' UNION ALL SELECT 'BOOT','BOOT') v
  JOIN garment_type g ON g.code = v.g;
INSERT IGNORE INTO oracle_value_map (oracle_column, oracle_value, color_id)
  SELECT 'SUIT_COLOR', v.c, c.id FROM (SELECT 'WHITE' c, 'White' n UNION ALL SELECT 'BLUE','Blue' UNION ALL SELECT 'BLACK','Black' UNION ALL SELECT 'OTHER','Other') v
  JOIN color c ON c.name = v.n;
INSERT IGNORE INTO oracle_value_map (oracle_column, oracle_value, size_id)
  SELECT 'SUIT_SIZE', v.c, s.id FROM (SELECT 'S' c, 'SM' n UNION ALL SELECT 'M','MED' UNION ALL SELECT 'L','LG' UNION ALL SELECT 'XL','XLG'
    UNION ALL SELECT '2XL','2XLG' UNION ALL SELECT '3XL','3XLG' UNION ALL SELECT '4XL','4XLG' UNION ALL SELECT 'OTHER','Other') v
  JOIN size s ON s.code = v.n;
INSERT IGNORE INTO oracle_value_map (oracle_column, oracle_value, location_id)
  SELECT 'SUIT_LEVEL', v.c, l.id FROM (SELECT 'FAB1' c, 'P1' n UNION ALL SELECT 'FAB2','P2') v
  JOIN location l ON l.code = v.n;
-- A test area that should never touch stock (MAP-05). '5XL' is deliberately left unmapped
-- so the "held" flow can be seen.
INSERT IGNORE INTO oracle_value_map (oracle_column, oracle_value, is_ignored) VALUES ('SUIT_LEVEL', 'TEST', TRUE);

