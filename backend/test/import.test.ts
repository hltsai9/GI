import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { one, rows } from '../src/db.js';
import { MockIssueSource, type MockRow } from '../src/import/mockSource.js';
import { poll, sweep } from '../src/import/importer.js';
import { invariantViolations } from '../src/ledger.js';
import { saveStartingCount } from '../src/services/counts.js';
import { setMapping } from '../src/services/settings.js';
import { db, freshDb, onHand, refIds, row, userId } from './helpers.js';

// "Now" for the mock: 20 Nov 2026 12:00 Phoenix = 19:00 UTC
const NOW = new Date('2026-11-20T19:00:00Z');
const src = (data: MockRow[], now = NOW) => new MockIssueSource(data, () => now);
const status = async (barcode: string) => (await one<{ status: string; quality: string; issued_day: string }>(db(),
  'SELECT status, quality, issued_day FROM issue_import WHERE suit_barcode = ?', [barcode]))!;

async function startCount(location: 'Fab1' | 'Fab2', asOfUtc: string) {
  const ids = await refIds();
  return saveStartingCount({ locationId: ids.loc[location], asOf: asOfUtc, counts: [
    { garmentTypeId: ids.type.GOWN, colorId: ids.color.White, sizeId: ids.size.LG, qty: 100 },
  ] }, await userId(), NOW);
}

beforeEach(async () => {
  await freshDb();
  config.ORACLE_MAX_ROWS = 5000;
  config.ORACLE_BACKFILL_FROM = '2026-11-01 00:00:00';
});

describe('issue import', () => {
  it('imports each row once and is a no-op when re-run (ORA-02)', async () => {
    const data = [row({ SUIT_BARCODE: 'G-1', INSERT_TIME: '2026-11-20 08:00:00', RECTIME: '2026-11-19 18:00:00' })];
    expect((await poll(src(data), NOW)).new).toBe(1);
    expect((await poll(src(data), NOW)).new).toBe(0);
    expect((await sweep(src(data), NOW)).new).toBe(0);
    expect(Number((await one<{ n: number }>(db(), 'SELECT COUNT(*) n FROM issue_import'))!.n)).toBe(1);
  });

  it('reduces stock only after the starting count, and re-classifies issues scanned after it', async () => {
    // Count finished 06:00 Phoenix (13:00 UTC); entered later. Issues at 05:00 and 07:00 Phoenix.
    const data = [
      row({ SUIT_BARCODE: 'G-early', INSERT_TIME: '2026-11-20 20:00:00', RECTIME: '2026-11-20 05:30:00' }), // 05:00 PHX
      row({ SUIT_BARCODE: 'G-late', INSERT_TIME: '2026-11-20 22:00:00', RECTIME: '2026-11-20 07:30:00' }), // 07:00 PHX
    ];
    await poll(src(data), NOW);
    expect((await status('G-early')).status).toBe('before_start');
    expect((await status('G-late')).status).toBe('before_start');
    const r = await startCount('Fab1', '2026-11-20T13:00:00Z');
    expect(r.issuesApplied).toBe(1);
    expect((await status('G-early')).status).toBe('before_start');
    expect((await status('G-late')).status).toBe('applied');
    expect(await onHand('GOWN', 'White', 'LG', 'Fab1')).toBe(99);
    expect(await invariantViolations(db())).toEqual([]);
  });

  it('keeps a watermark per location, so a later-arriving Fab2 row with an earlier RECTIME is not skipped', async () => {
    await startCount('Fab1', '2026-11-19T00:00:00Z');
    await startCount('Fab2', '2026-11-19T00:00:00Z');
    const f1 = row({ SUIT_BARCODE: 'G-f1', SUIT_LEVEL: 'FAB1', INSERT_TIME: '2026-11-21 00:00:00', RECTIME: '2026-11-20 10:30:00' });
    const f2 = row({ SUIT_BARCODE: 'G-f2', SUIT_LEVEL: 'FAB2', INSERT_TIME: '2026-11-20 23:00:00', RECTIME: '2026-11-20 10:05:00',
      VISIBLE_AT: '2026-11-20 10:50:00' }); // committed 45 min after its RECTIME
    const fab2old = row({ SUIT_BARCODE: 'G-f2old', SUIT_LEVEL: 'FAB2', INSERT_TIME: '2026-11-20 20:00:00', RECTIME: '2026-11-20 06:00:00' });
    const data = [f1, f2, fab2old];
    await poll(src(data, new Date('2026-11-20T17:40:00Z')), NOW); // 10:40 PHX: f2 not visible yet
    expect(await one(db(), "SELECT 1 FROM issue_import WHERE suit_barcode = 'G-f2'")).toBeUndefined();
    await poll(src(data, new Date('2026-11-20T18:00:00Z')), NOW); // 11:00 PHX
    expect((await status('G-f2')).status).toBe('applied');
  });

  it('pages through rows that share a RECTIME without skipping any', async () => {
    await startCount('Fab1', '2026-11-19T00:00:00Z');
    config.ORACLE_MAX_ROWS = 2;
    const data = ['A', 'B', 'C', 'D', 'E'].map((b) => row({ SUIT_BARCODE: `G-${b}`, INSERT_TIME: '2026-11-21 00:00:00', RECTIME: '2026-11-20 10:00:00' }));
    const r = await poll(src(data), NOW);
    expect(r.new).toBe(5);
  });

  it('counts a record entered ~15 h after the scan on the scan day', async () => {
    await startCount('Fab1', '2026-11-18T00:00:00Z');
    // Scan 23:50 on 19 Nov Phoenix (= 14:50 on 20 Nov Taipei), entered 14:40 on 20 Nov Phoenix
    const data = [row({ SUIT_BARCODE: 'G-late', INSERT_TIME: '2026-11-20 14:50:00', RECTIME: '2026-11-20 14:40:00' })];
    await poll(src(data, new Date('2026-11-20T21:41:00Z')), new Date('2026-11-20T21:41:00Z'));
    expect((await status('G-late')).issued_day).toBe('2026-11-19');
  });

  it('holds rows with an unmapped value and applies them once it is mapped (ORA-05, MAP-03)', async () => {
    await startCount('Fab1', '2026-11-19T00:00:00Z');
    const data = [row({ SUIT_BARCODE: 'G-5xl', SUIT_SIZE: '5XL', INSERT_TIME: '2026-11-21 00:00:00', RECTIME: '2026-11-20 09:30:00' })];
    await poll(src(data), NOW);
    expect((await status('G-5xl')).status).toBe('held_unmapped');
    const m = (await one<{ id: number }>(db(), "SELECT id FROM oracle_value_map WHERE oracle_column = 'SUIT_SIZE' AND oracle_value = '5XL'"))!;
    const ids = await refIds();
    const r = await setMapping(m.id, { targetId: ids.size.Other }, await userId());
    expect(r.reclassified).toBe(1);
    expect((await status('G-5xl')).status).toBe('applied');
    expect(await onHand('GOWN', 'White', 'Other', 'Fab1')).toBe(-1);
  });

  it('ignores rows from an ignored location and from other STATEs', async () => {
    const data = [
      row({ SUIT_BARCODE: 'G-test', SUIT_LEVEL: 'TEST', INSERT_TIME: '2026-11-21 00:00:00', RECTIME: '2026-11-20 09:30:00' }),
      row({ SUIT_BARCODE: 'G-ret', STATE: 'EMPLOYEE GOWN RETURN', INSERT_TIME: '2026-11-21 00:00:00', RECTIME: '2026-11-20 09:30:00' }),
    ];
    await poll(src(data), NOW);
    expect((await status('G-test')).status).toBe('ignored');
    expect(await one(db(), "SELECT 1 FROM issue_import WHERE suit_barcode = 'G-ret'")).toBeUndefined();
  });

  it('books GOWN / OTHER / OTHER to the location\'s unregistered bucket, not to gowns (DQ-03)', async () => {
    await startCount('Fab2', '2026-11-19T00:00:00Z');
    const data = [row({ SUIT_BARCODE: 'X-1', SUIT_LEVEL: 'FAB2', SUIT_COLOR: 'OTHER', SUIT_SIZE: 'OTHER', INSERT_TIME: '2026-11-21 00:00:00', RECTIME: '2026-11-20 09:30:00' })];
    await poll(src(data), NOW);
    expect(await status('X-1')).toMatchObject({ status: 'applied', quality: 'incomplete' });
    expect(await onHand('UNREGISTERED', 'Unregistered', 'Unregistered', 'Fab2')).toBe(-1);
    expect(await onHand('GOWN', 'Other', 'Other', 'Fab2')).toBe(0);
  });

  it('imports a row with RECTIME days before the scan, alerts, and the sweep finds it if the poll cannot (ORA-13, ORA-03a)', async () => {
    await startCount('Fab1', '2026-11-15T00:00:00Z');
    const normal = row({ SUIT_BARCODE: 'G-n', INSERT_TIME: '2026-11-21 00:00:00', RECTIME: '2026-11-20 09:30:00' });
    await poll(src([normal]), NOW);
    // Bad clock: RECTIME 140 h before the scan, so it is far behind the FAB1 watermark.
    const bad = row({ SUIT_BARCODE: 'G-bad', INSERT_TIME: '2026-11-21 01:00:00', RECTIME: '2026-11-14 15:00:00', VISIBLE_AT: '2026-11-20 10:00:00' });
    expect((await poll(src([normal, bad]), NOW)).new).toBe(0);
    const s = await sweep(src([normal, bad]), NOW);
    expect(s.new).toBe(1);
    expect(s.timeCheckFailed).toBe(1);
    const alerts = await rows<{ kind: string }>(db(), 'SELECT kind FROM admin_alert ORDER BY id');
    expect(alerts.map((a) => a.kind)).toEqual(['time_check', 'sweep_found_rows']);
    expect((await status('G-bad')).status).toBe('applied');
  });

  it('runs the mock data set end to end with the ledger intact', async () => {
    const data: MockRow[] = [];
    for (let i = 0; i < 300; i++) {
      const h = String(i % 24).padStart(2, '0');
      data.push(row({ SUIT_BARCODE: `G-${i}`, SUIT_LEVEL: i % 3 ? 'FAB1' : 'FAB2', SUIT_SIZE: ['S', 'M', 'L', 'XL'][i % 4],
        INSERT_TIME: `2026-11-20 ${h}:00:00`, RECTIME: `2026-11-20 ${h}:10:00` }));
    }
    await startCount('Fab1', '2026-11-19T00:00:00Z');
    const r = await poll(src(data, new Date('2026-11-21T12:00:00Z')), NOW);
    expect(r.new).toBe(300);
    expect(await invariantViolations(db())).toEqual([]);
  });
});
