-- Development / demo data only (tests and `npm run demo`). Never run in production.
-- Minimums for the common items, so the reorder list has something to show.
INSERT IGNORE INTO stock_item (garment_type_id, color_id, size_id, location_id, min_qty)
  SELECT g.id, c.id, s.id, l.id,
         CASE WHEN c.name = 'White' THEN 20 WHEN c.name = 'Blue' THEN 10 ELSE 4 END
    FROM garment_type g, color c, size s, location l
   WHERE g.is_system = FALSE AND c.is_system = FALSE AND s.is_system = FALSE
     AND c.name IN ('White','Blue','Black') AND s.code IN ('SM','MED','LG','XLG','2XLG');
