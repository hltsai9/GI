-- Reference data every installation needs.
INSERT INTO garment_type (code, name, plural, unit, icon, sort, is_system) VALUES
  ('GOWN', 'Gown',  'Gowns', 'pieces', 'gown', 1, FALSE),
  ('HOOD', 'Hood',  'Hoods', 'pieces', 'hood', 2, FALSE),
  ('BOOT', 'Boots', 'Boots', 'pairs',  'boot', 3, FALSE),
  ('UNREGISTERED', 'Unregistered', 'Unregistered garments', 'pieces', NULL, 99, TRUE);

INSERT INTO color (name, sort, is_system) VALUES
  ('White', 1, FALSE), ('Blue', 2, FALSE), ('Black', 3, FALSE), ('Grey', 4, FALSE), ('Other', 5, FALSE),
  ('Unregistered', 99, TRUE);

INSERT INTO size (code, sort, is_system) VALUES
  ('XSM', 1, FALSE), ('SM', 2, FALSE), ('MED', 3, FALSE), ('LG', 4, FALSE), ('XLG', 5, FALSE),
  ('2XLG', 6, FALSE), ('3XLG', 7, FALSE), ('4XLG', 8, FALSE), ('5XLG', 9, FALSE), ('6XLG', 10, FALSE),
  ('7XLG', 11, FALSE), ('UNI', 12, FALSE), ('Other', 13, FALSE),
  ('Unregistered', 99, TRUE);

INSERT INTO location (code, name) VALUES ('P1', 'P1'), ('P2', 'P2');

-- Known-bad pattern: barcode not registered in the suit master (DQ-01).
INSERT INTO dq_pattern (suit_type, suit_color, suit_size) VALUES ('GOWN', 'OTHER', 'OTHER');
