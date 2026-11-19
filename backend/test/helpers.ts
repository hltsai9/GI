import { config } from '../src/config.js';
import { closePool, getPool, one, rows } from '../src/db.js';
import { migrate, resetDatabase } from '../src/migrate.js';
import { resetCaches } from '../src/stockItems.js';
import type { MockRow } from '../src/import/mockSource.js';

export async function freshDb() {
  if (!config.MARIADB_URL.includes('gi_test')) throw new Error('tests must run against the gi_test database');
  await closePool();
  resetCaches();
  await resetDatabase(config.MARIADB_URL);
  await migrate(config.MARIADB_URL, { seedDev: true });
}

export const db = () => getPool();

export async function userId(subject = 'dev-lead') {
  return (await one<{ id: number }>(db(), 'SELECT id FROM app_user WHERE sso_subject = ?', [subject]))!.id;
}

export async function refIds() {
  const q = async (sql: string) => Object.fromEntries((await rows<{ k: string; id: number }>(db(), sql)).map((r) => [r.k, r.id]));
  return {
    type: await q('SELECT code k, id FROM garment_type'),
    color: await q('SELECT name k, id FROM color'),
    size: await q('SELECT code k, id FROM size'),
    loc: await q('SELECT code k, id FROM location'),
  };
}

/** Builds a mock Oracle row. Times are naive: insert = Taipei, rect = Phoenix. */
export function row(p: Partial<MockRow> & { INSERT_TIME: string; RECTIME: string }): MockRow {
  return {
    SUIT_BARCODE: p.SUIT_BARCODE ?? `G-${Math.random().toString(36).slice(2, 9)}`,
    SUIT_TYPE: p.SUIT_TYPE ?? 'GOWN',
    SUIT_COLOR: p.SUIT_COLOR ?? 'WHITE',
    SUIT_SIZE: p.SUIT_SIZE ?? 'L',
    SUIT_LEVEL: p.SUIT_LEVEL ?? 'FAB1',
    STATE: p.STATE ?? 'EMPLOYEE GOWN ISSUE',
    INSERT_TIME: p.INSERT_TIME,
    RECTIME: p.RECTIME,
    VISIBLE_AT: p.VISIBLE_AT ?? p.RECTIME,
  };
}

export async function onHand(garment: string, color: string, size: string, loc: string) {
  const r = await one<{ on_hand: number }>(db(),
    `SELECT si.on_hand FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
       JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
      WHERE g.code = ? AND c.name = ? AND s.code = ? AND l.code = ?`, [garment, color, size, loc]);
  return r?.on_hand ?? 0;
}
