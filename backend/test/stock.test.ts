import { beforeEach, describe, expect, it } from 'vitest';
import { one } from '../src/db.js';
import { invariantViolations } from '../src/ledger.js';
import { correctDelivery, postDelivery } from '../src/services/deliveries.js';
import { saveCorrection, saveStartingCount } from '../src/services/counts.js';
import { stockSummary } from '../src/services/stock.js';
import { db, freshDb, onHand, refIds, userId } from './helpers.js';

const NOW = new Date('2026-11-20T19:00:00Z');
let ids: Awaited<ReturnType<typeof refIds>>;
const line = (qty: number, size = 'LG', loc = 'Fab1') => ({ garmentTypeId: ids.type.GOWN, colorId: ids.color.White, sizeId: ids.size[size], locationId: ids.loc[loc], qty });

beforeEach(async () => {
  await freshDb();
  ids = await refIds();
});

describe('deliveries and corrections', () => {
  it('posts a delivery, merges duplicate lines and ignores a retried post (RCV-02/05)', async () => {
    const u = await userId('dev-floor');
    const r = await postDelivery({ lines: [line(30), line(10), line(5, 'MED')] }, 'key-1', u, NOW);
    expect(r).toMatchObject({ duplicate: false, total: 45, lines: 2 });
    expect((await postDelivery({ lines: [line(30)] }, 'key-1', u, NOW)).duplicate).toBe(true);
    expect(await onHand('GOWN', 'White', 'LG', 'Fab1')).toBe(40);
  });

  it('applies only the difference on correction and reverses everything on void (HIS-04/05)', async () => {
    const u = await userId('dev-floor');
    const d = await postDelivery({ lines: [line(60), line(40, 'MED')] }, 'k', u, NOW);
    const lines = await db().query('SELECT id FROM delivery_line WHERE delivery_id = ? ORDER BY id', [d.id]);
    const [lg, med] = (lines[0] as { id: number }[]).map((l) => l.id);
    const c = await correctDelivery(d.id, { lines: [{ lineId: lg, qty: 50 }] }, u, NOW);
    expect(c.totalDelta).toBe(-10);
    expect(await onHand('GOWN', 'White', 'LG', 'Fab1')).toBe(50);
    const v = await correctDelivery(d.id, { void: true, lines: [] }, u, NOW);
    expect(v).toMatchObject({ voided: true, totalDelta: -90 });
    expect(await onHand('GOWN', 'White', 'MED', 'Fab1')).toBe(0);
    expect(med).toBeGreaterThan(0);
    expect(await invariantViolations(db())).toEqual([]);
  });

  it('starting count keeps deliveries received after its as-of time', async () => {
    const lead = await userId();
    // Delivery at 07:00 Phoenix (14:00 UTC); the count was finished at 06:00 (13:00 UTC) but entered later.
    await postDelivery({ receivedAt: '2026-11-20T14:00:00Z', lines: [line(30)] }, 'd1', await userId('dev-floor'), NOW);
    await saveStartingCount({ locationId: ids.loc.Fab1, asOf: '2026-11-20T13:00:00Z',
      counts: [{ garmentTypeId: ids.type.GOWN, colorId: ids.color.White, sizeId: ids.size.LG, qty: 42 }] }, lead, NOW);
    expect(await onHand('GOWN', 'White', 'LG', 'Fab1')).toBe(72);
    expect(await invariantViolations(db())).toEqual([]);
  });

  it('refuses to correct a delivery that the starting count already includes', async () => {
    const d = await postDelivery({ receivedAt: '2026-11-20T12:00:00Z', lines: [line(30)] }, 'd1', await userId('dev-floor'), NOW);
    await saveStartingCount({ locationId: ids.loc.Fab1, asOf: '2026-11-20T13:00:00Z', counts: [] }, await userId(), NOW);
    const dl = (await one<{ id: number }>(db(), 'SELECT id FROM delivery_line WHERE delivery_id = ?', [d.id]))!;
    await expect(correctDelivery(d.id, { lines: [{ lineId: dl.id, qty: 20 }] }, await userId(), NOW)).rejects.toThrow(/starting count/);
  });

  it('a spot check clears the unregistered bucket (DQ-06)', async () => {
    const lead = await userId();
    const r = await saveCorrection({ reason: 'spot_check', locationId: ids.loc.Fab1, clearUnregistered: true,
      items: [{ garmentTypeId: ids.type.GOWN, colorId: ids.color.White, sizeId: ids.size.LG, qty: 12 }] }, lead, NOW);
    expect(r.changed).toHaveLength(1); // bucket was already 0
    expect(await onHand('GOWN', 'White', 'LG', 'Fab1')).toBe(12);
  });

  it('lists items below minimum in the reorder list', async () => {
    await postDelivery({ lines: [line(3)] }, 'k', await userId('dev-floor'), NOW); // min is 20 in the dev seed
    const s = await stockSummary(db(), NOW);
    // Most urgent first: items at 0 of their minimum come before 3 of 20.
    const ratios = s.reorder.map((r) => r.on_hand / r.min_qty);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(s.reorder.every((r) => r.on_hand < r.min_qty)).toBe(true);
    expect(s.belowMinCount).toBe(90); // all 90 seeded items, including the one at 3 of 20
    expect(s.totals.find((t) => t.name === 'Gown')!.onHand).toBe(3);
  });
});
