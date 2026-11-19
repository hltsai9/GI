import { exec, one, rows, type Conn } from './db.js';

export interface ItemKey {
  garmentTypeId: number;
  colorId: number;
  sizeId: number;
  locationId: number;
}

/** Finds or lazily creates the stock item for a combination (BUILD_PLAN §2). */
export async function stockItemId(conn: Conn, k: ItemKey, defaultMin: number | null = null): Promise<number> {
  await exec(
    conn,
    `INSERT INTO stock_item (garment_type_id, color_id, size_id, location_id, min_qty) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE min_qty = COALESCE(min_qty, VALUES(min_qty))`,
    [k.garmentTypeId, k.colorId, k.sizeId, k.locationId, defaultMin],
  );
  const r = await one<{ id: number }>(
    conn,
    'SELECT id FROM stock_item WHERE garment_type_id = ? AND color_id = ? AND size_id = ? AND location_id = ?',
    [k.garmentTypeId, k.colorId, k.sizeId, k.locationId],
  );
  return r!.id;
}

export interface SystemIds {
  typeId: number;
  colorId: number;
  sizeId: number;
}

let systemIds: SystemIds | undefined;

/** Ids of the hidden "Unregistered" type, color and size (DQ-03). */
export async function unregisteredIds(conn: Conn): Promise<SystemIds> {
  if (systemIds) return systemIds;
  const [t] = await rows<{ id: number }>(conn, 'SELECT id FROM garment_type WHERE is_system LIMIT 1');
  const [c] = await rows<{ id: number }>(conn, 'SELECT id FROM color WHERE is_system LIMIT 1');
  const [s] = await rows<{ id: number }>(conn, 'SELECT id FROM size WHERE is_system LIMIT 1');
  systemIds = { typeId: t.id, colorId: c.id, sizeId: s.id };
  return systemIds;
}

/** The unregistered bucket for a location (one stock item per location). */
export async function unregisteredBucket(conn: Conn, locationId: number): Promise<number> {
  const u = await unregisteredIds(conn);
  return stockItemId(conn, { garmentTypeId: u.typeId, colorId: u.colorId, sizeId: u.sizeId, locationId });
}

export function resetCaches() {
  systemIds = undefined;
}
