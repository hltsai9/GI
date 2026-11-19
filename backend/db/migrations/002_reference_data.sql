-- Reference data every installation needs.
INSERT INTO garment_type (code, name, plural, icon, sort, is_system) VALUES
  ('GOWN', 'Gown',  'Gowns', 'gown', 1, FALSE),
  ('HOOD', 'Hood',  'Hoods', 'hood', 2, FALSE),
  ('BOOT', 'Boots', 'Boots', 'boot', 3, FALSE),
  ('UNREGISTERED', 'Unregistered', 'Unregistered garments', NULL, 99, TRUE);

INSERT INTO color (name, sort, is_system) VALUES
  ('White', 1, FALSE), ('Blue', 2, FALSE), ('Black', 3, FALSE), ('Other', 4, FALSE),
  ('Unregistered', 99, TRUE);

INSERT INTO size (code, sort, is_system) VALUES
  ('SM', 1, FALSE), ('MED', 2, FALSE), ('LG', 3, FALSE), ('XLG', 4, FALSE),
  ('2XLG', 5, FALSE), ('3XLG', 6, FALSE), ('4XLG', 7, FALSE), ('Other', 8, FALSE),
  ('Unregistered', 99, TRUE);

INSERT INTO location (code, name) VALUES ('Fab1', 'Fab1'), ('Fab2', 'Fab2');

-- Known-bad pattern: barcode not registered in the suit master (DQ-01).
INSERT INTO dq_pattern (suit_type, suit_color, suit_size) VALUES ('GOWN', 'OTHER', 'OTHER');
