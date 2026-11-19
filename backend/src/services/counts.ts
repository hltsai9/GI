import { z } from 'zod';
import type { PoolConnection } from 'mysql2/promise';
import { exec, one, rows, withTx, type Conn } from '../db.js';
import { applyMovements, type Movement } from '../ledger.js';
import { stockItemId, unregisteredBucket } from '../stockItems.js';
import { fromDb } from '../time.js';
import { HttpError } from '../http.js';
import { reclassify } from '../import/importer.js';

const countLine = z.object({
  garmentTypeId: z.number().int(), colorId: z.number().int(), sizeId: z.number().int(), qty: z.number().int().min(0),
});

export const startingCountInput = z.object({
  locationId: z.number().int(),
  asOf: z.string().datetime(),
  counts: z.array(countLine),
});

/** Balance of an item as of a moment: current on_hand minus movements dated at or after it. */
async function balanceAt(conn: PoolConnection, itemId: number, at: Date): Promise<number> {
  const r = await one<{ on_hand: number; later: number }>(conn,
    `SELECT s.on_hand, COALESCE((SELECT SUM(delta) FROM ledger_entry WHERE stock_item_id = s.id AND at >= ?), 0) AS later
       FROM stock_item s WHERE s.id = ?`, [at, itemId]);
  return r!.on_hand - Number(r!.later);
}

/**
 * Starting count for a location (ADJ-05, rule 7.8). Sets every item's balance as of `asOf`
 * to the counted quantity (uncounted items to 0), keeps movements dated after `asOf`, then
 * re-classifies that location's issues scanned after `asOf` so they reduce stock.
 */
export async function saveStartingCount(input: z.infer<typeof startingCountInput>, userId: number, now = new Date()) {
  const asOf = new Date(input.asOf);
  if (asOf > now) throw new HttpError(400, 'the as-of time is in the future');
  return withTx(async (conn) => {
    if (await one(conn, 'SELECT 1 FROM starting_count WHERE location_id = ? FOR UPDATE', [input.locationId])) {
      throw new HttpError(409, 'this location already has a starting count; use a stock correction instead');
    }
    const counted = new Map<number, number>();
    for (const c of input.counts) {
      const id = await stockItemId(conn, { ...c, locationId: input.locationId });
      counted.set(id, (counted.get(id) ?? 0) + c.qty);
    }
    const bucket = await unregisteredBucket(conn, input.locationId);
    const others = await rows<{ id: number }>(conn, 'SELECT id FROM stock_item WHERE location_id = ?', [input.locationId]);
    for (const o of others) if (!counted.has(o.id)) counted.set(o.id, 0);
    counted.set(bucket, 0);

    const movements: Movement[] = [];
    for (const [itemId, qty] of counted) {
      const before = await balanceAt(conn, itemId, asOf);
      if (qty === 0 && before === 0) continue;
      const sc = await exec(conn,
        "INSERT INTO stock_correction (stock_item_id, counted, system_qty, reason, user_id, at) VALUES (?,?,?,'starting_count',?,?)",
        [itemId, qty, before, userId, asOf]);
      if (qty !== before) movements.push({ stockItemId: itemId, delta: qty - before, at: asOf, kind: 'starting_count', userId, stockCorrectionId: sc.insertId });
    }
    await applyMovements(conn, movements);
    await exec(conn, 'INSERT INTO starting_count (location_id, as_of, entered_by) VALUES (?,?,?)', [input.locationId, asOf, userId]);
    const reclassified = await reclassify(conn, "status = 'before_start' AND location_id = ? AND issued_at >= ?",
      [input.locationId, asOf], userId, 'starting count saved');
    return { items: movements.length, issuesApplied: reclassified };
  });
}

export const correctionInput = z.object({
  reason: z.enum(['spot_check', 'damaged', 'found', 'miscount_at_delivery', 'other']),
  note: z.string().max(255).optional(),
  locationId: z.number().int(),
  items: z.array(countLine),
  /** Spot check of everything at the location: also clears the unregistered bucket (DQ-06). */
  clearUnregistered: z.boolean().optional(),
});

/** Stock correction (ADJ-02..04): sets each item's current on_hand to the counted value. */
export async function saveCorrection(input: z.infer<typeof correctionInput>, userId: number, now = new Date()) {
  if (input.reason === 'other' && !input.note) throw new HttpError(400, 'a note is required for reason "other"');
  if (input.clearUnregistered && input.reason !== 'spot_check') throw new HttpError(400, 'clearing the unregistered bucket needs a spot check');
  return withTx(async (conn) => {
    const targets = new Map<number, number>();
    for (const c of input.items) targets.set(await stockItemId(conn, { ...c, locationId: input.locationId }), c.qty);
    if (input.clearUnregistered) targets.set(await unregisteredBucket(conn, input.locationId), 0);
    const ids = [...targets.keys()].sort((a, b) => a - b);
    if (!ids.length) throw new HttpError(400, 'nothing to correct');
    const current = await rows<{ id: number; on_hand: number }>(conn,
      `SELECT id, on_hand FROM stock_item WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, ids);
    const movements: Movement[] = [];
    const log: { stockItemId: number; from: number; to: number }[] = [];
    for (const r of current) {
      const to = targets.get(r.id)!;
      if (to === r.on_hand) continue;
      const sc = await exec(conn,
        'INSERT INTO stock_correction (stock_item_id, counted, system_qty, reason, note, user_id, at) VALUES (?,?,?,?,?,?,?)',
        [r.id, to, r.on_hand, input.reason, input.note ?? null, userId, now]);
      movements.push({ stockItemId: r.id, delta: to - r.on_hand, at: now, kind: 'stock_correction', userId, stockCorrectionId: sc.insertId });
      log.push({ stockItemId: r.id, from: r.on_hand, to });
    }
    await applyMovements(conn, movements);
    return { changed: log };
  });
}

export async function listCorrections(conn: Conn, limit = 20) {
  const rs = await rows<Record<string, unknown> & { at: string }>(conn,
    `SELECT sc.id, sc.at, sc.reason, sc.note, sc.counted, sc.system_qty, u.name AS user_name,
            g.name AS garment, g.is_system, c.name AS color, s.code AS size, l.code AS location
       FROM stock_correction sc JOIN app_user u ON u.id = sc.user_id JOIN stock_item si ON si.id = sc.stock_item_id
       JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
       JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
      ORDER BY sc.at DESC, sc.id DESC LIMIT ?`, [limit]);
  return rs.map((r) => ({ ...r, at: fromDb(r.at).toISOString() }));
}

export async function startingCounts(conn: Conn) {
  const rs = await rows<{ location_id: number; code: string; as_of: string | null; entered_by: string | null }>(conn,
    `SELECT l.id AS location_id, l.code, sc.as_of, u.name AS entered_by
       FROM location l LEFT JOIN starting_count sc ON sc.location_id = l.id LEFT JOIN app_user u ON u.id = sc.entered_by ORDER BY l.id`);
  return rs.map((r) => ({ locationId: r.location_id, location: r.code, asOf: r.as_of ? fromDb(r.as_of).toISOString() : null, enteredBy: r.entered_by }));
}
