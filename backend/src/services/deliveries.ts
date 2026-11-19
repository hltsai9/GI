import { z } from 'zod';
import { exec, getPool, one, rows, withTx, type Conn } from '../db.js';
import { applyMovements, type Movement } from '../ledger.js';
import { stockItemId } from '../stockItems.js';
import { fromDb, siteDay } from '../time.js';
import { HttpError } from '../http.js';

export const DEFAULT_MIN = 2; // RCV-06 (TODO: confirm with the lead)

export const deliveryInput = z.object({
  receivedAt: z.string().datetime().optional(),
  note: z.string().max(255).optional(),
  lines: z
    .array(z.object({
      garmentTypeId: z.number().int(), colorId: z.number().int(), sizeId: z.number().int(),
      locationId: z.number().int(), qty: z.number().int().positive(),
    }))
    .min(1),
});

/** Posts a delivery (RCV-05). The Idempotency-Key makes a retried post return the first result. */
export async function postDelivery(input: z.infer<typeof deliveryInput>, idempotencyKey: string, userId: number, now = new Date()) {
  const existing = await one<{ id: number }>(getPool(), 'SELECT id FROM delivery WHERE idempotency_key = ?', [idempotencyKey]);
  if (existing) return { id: existing.id, duplicate: true };

  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now;
  if (receivedAt.getTime() > now.getTime() + 5 * 60_000) throw new HttpError(400, 'delivery time is in the future');
  if (now.getTime() - receivedAt.getTime() > 2 * 86_400_000) throw new HttpError(400, 'a delivery can be back-dated by at most one day (RCV-08)');

  // RCV-02: merge lines for the same item
  const merged = new Map<string, (typeof input.lines)[number]>();
  for (const l of input.lines) {
    const k = `${l.garmentTypeId}|${l.colorId}|${l.sizeId}|${l.locationId}`;
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, qty: prev.qty + l.qty } : { ...l });
  }

  return withTx(async (conn) => {
    await assertRealValues(conn, [...merged.values()]);
    const d = await exec(conn,
      'INSERT INTO delivery (received_at, received_day, created_by, note, idempotency_key) VALUES (?,?,?,?,?)',
      [receivedAt, siteDay(receivedAt), userId, input.note ?? null, idempotencyKey]);
    const movements: Movement[] = [];
    let total = 0;
    for (const l of merged.values()) {
      const itemId = await stockItemId(conn, l, DEFAULT_MIN);
      const line = await exec(conn, 'INSERT INTO delivery_line (delivery_id, stock_item_id, qty_original, qty_current) VALUES (?,?,?,?)',
        [d.insertId, itemId, l.qty, l.qty]);
      movements.push({ stockItemId: itemId, delta: l.qty, at: receivedAt, kind: 'delivery', userId, deliveryLineId: line.insertId });
      total += l.qty;
    }
    await applyMovements(conn, movements);
    return { id: d.insertId, duplicate: false, total, lines: merged.size };
  });
}

async function assertRealValues(conn: import('mysql2/promise').PoolConnection, lines: { garmentTypeId: number; colorId: number; sizeId: number; locationId: number }[]) {
  for (const l of lines) {
    const ok = await one(conn,
      `SELECT 1 FROM garment_type g, color c, size s, location l
        WHERE g.id = ? AND c.id = ? AND s.id = ? AND l.id = ? AND NOT g.is_system AND NOT c.is_system AND NOT s.is_system
          AND g.active AND c.active AND s.active`,
      [l.garmentTypeId, l.colorId, l.sizeId, l.locationId]);
    if (!ok) throw new HttpError(400, 'unknown or inactive garment type, color, size or location');
  }
}

export async function listDeliveries(conn: Conn, limit = 20) {
  const ds = await rows<{ id: number; received_at: string; status: string; note: string | null; created_by_name: string }>(conn,
    `SELECT d.id, d.received_at, d.status, d.note, u.name AS created_by_name
       FROM delivery d JOIN app_user u ON u.id = d.created_by ORDER BY d.received_at DESC, d.id DESC LIMIT ?`, [limit]);
  if (!ds.length) return [];
  const ids = ds.map((d) => d.id);
  const lines = await rows<Record<string, unknown> & { delivery_id: number }>(conn,
    `SELECT dl.id, dl.delivery_id, dl.stock_item_id, dl.qty_original, dl.qty_current,
            g.name AS garment, g.icon, c.name AS color, s.code AS size, l.code AS location
       FROM delivery_line dl JOIN stock_item si ON si.id = dl.stock_item_id
       JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
       JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
      WHERE dl.delivery_id IN (${ids.map(() => '?').join(',')}) ORDER BY dl.id`, ids);
  const corrections = await rows<{ delivery_id: number; at: string; is_void: number; total_delta: number; user_name: string; note: string | null }>(conn,
    `SELECT dc.delivery_id, dc.at, dc.is_void, dc.total_delta, u.name AS user_name, dc.note
       FROM delivery_correction dc JOIN app_user u ON u.id = dc.user_id
      WHERE dc.delivery_id IN (${ids.map(() => '?').join(',')}) ORDER BY dc.at`, ids);
  return ds.map((d) => ({
    id: d.id,
    receivedAt: fromDb(d.received_at).toISOString(),
    status: d.status,
    note: d.note,
    createdBy: d.created_by_name,
    lines: lines.filter((l) => l.delivery_id === d.id),
    corrections: corrections.filter((c) => c.delivery_id === d.id).map((c) => ({
      at: fromDb(c.at).toISOString(), isVoid: !!c.is_void, totalDelta: c.total_delta, by: c.user_name, note: c.note,
    })),
  }));
}

export const correctionInput = z.object({
  void: z.boolean().optional(),
  note: z.string().max(255).optional(),
  lines: z.array(z.object({ lineId: z.number().int(), qty: z.number().int().min(0) })).default([]),
});

/** Corrects or voids a delivery (HIS-04/05): applies only the difference. */
export async function correctDelivery(deliveryId: number, input: z.infer<typeof correctionInput>, userId: number, now = new Date()) {
  return withTx(async (conn) => {
    const d = await one<{ id: number; received_at: string; status: string }>(conn,
      'SELECT id, received_at, status FROM delivery WHERE id = ? FOR UPDATE', [deliveryId]);
    if (!d) throw new HttpError(404, 'delivery not found');
    if (d.status === 'voided') throw new HttpError(409, 'delivery is already voided');
    const receivedAt = fromDb(d.received_at);
    const lines = await rows<{ id: number; stock_item_id: number; qty_current: number; location_id: number }>(conn,
      `SELECT dl.id, dl.stock_item_id, dl.qty_current, si.location_id FROM delivery_line dl
         JOIN stock_item si ON si.id = dl.stock_item_id WHERE dl.delivery_id = ? FOR UPDATE`, [deliveryId]);
    // A delivery before a location's starting count is already part of that count (rule 7.8).
    for (const l of lines) {
      const sc = await one<{ as_of: string }>(conn, 'SELECT as_of FROM starting_count WHERE location_id = ?', [l.location_id]);
      if (sc && receivedAt < fromDb(sc.as_of)) throw new HttpError(409, 'this delivery was received before the starting count and is already included in it');
    }
    const target = new Map(lines.map((l) => [l.id, input.void ? 0 : l.qty_current]));
    for (const c of input.lines) {
      if (!target.has(c.lineId)) throw new HttpError(400, `line ${c.lineId} is not part of delivery ${deliveryId}`);
      if (!input.void) target.set(c.lineId, c.qty);
    }
    const changes = lines.map((l) => ({ ...l, delta: target.get(l.id)! - l.qty_current })).filter((l) => l.delta !== 0);
    if (!changes.length) throw new HttpError(400, 'nothing to change');
    const total = changes.reduce((s, l) => s + l.delta, 0);
    const voided = lines.every((l) => target.get(l.id) === 0);
    const dc = await exec(conn,
      'INSERT INTO delivery_correction (delivery_id, user_id, at, is_void, total_delta, note) VALUES (?,?,?,?,?,?)',
      [deliveryId, userId, now, voided, total, input.note ?? null]);
    for (const l of changes) await exec(conn, 'UPDATE delivery_line SET qty_current = ? WHERE id = ?', [target.get(l.id), l.id]);
    await exec(conn, 'UPDATE delivery SET status = ? WHERE id = ?', [voided ? 'voided' : 'corrected', deliveryId]);
    // The correction fixes what arrived, so it is dated with the delivery.
    await applyMovements(conn, changes.map((l) => ({
      stockItemId: l.stock_item_id, delta: l.delta, at: receivedAt, kind: 'delivery_correction' as const,
      userId, deliveryLineId: l.id, deliveryCorrectionId: dc.insertId,
    })));
    return { id: dc.insertId, totalDelta: total, voided };
  });
}
