-- The two locations are called P1 and P2 (requested 2026-11-20). Only the names change: stock, history and
-- the Oracle mapping (SUIT_LEVEL FAB1 / FAB2) point at the same locations as before.
UPDATE location SET code = 'P1', name = 'P1' WHERE code = 'Fab1';
UPDATE location SET code = 'P2', name = 'P2' WHERE code = 'Fab2';

-- How each garment type is counted, shown next to quantities: boots are counted in pairs.
ALTER TABLE garment_type ADD COLUMN unit VARCHAR(16) NOT NULL DEFAULT 'pieces' AFTER plural;
UPDATE garment_type SET unit = 'pairs' WHERE code = 'BOOT';
