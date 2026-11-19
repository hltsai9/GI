import { z } from 'zod';
import { exec, one, rows, withTx, type Conn } from '../db.js';
import { HttpError } from '../http.js';
import { reclassify } from '../import/importer.js';
import { fromDb } from '../time.js';

export async function meta(conn: Conn) {
  const [types, colors, sizes, locations] = await Promise.all([
    rows(conn, 'SELECT id, code, name, plural, icon FROM garment_type WHERE active AND NOT is_system ORDER BY sort'),
    rows(conn, 'SELECT id, name, active FROM color WHERE NOT is_system ORDER BY sort'),
    rows(conn, 'SELECT id, code, active FROM size WHERE NOT is_system ORDER BY sort'),
    rows(conn, 'SELECT id, code, name FROM location ORDER BY id'),
  ]);
  return { types, colors, sizes, locations };
}

type Kind = 'color' | 'size';
const table = (k: Kind) => (k === 'color' ? { t: 'color', col: 'name' } : { t: 'size', col: 'code' });

/** SET-01: add a size or color at the end of the list (or restore it if it exists hidden). */
export async function addValue(kind: Kind, value: string, userId: number) {
  const v = value.trim();
  if (!v || v.length > 32) throw new HttpError(400, 'value must be 1–32 characters');
  const { t, col } = table(kind);
  return withTx(async (conn) => {
    const existing = await one<{ id: number; active: number; is_system: number }>(conn, `SELECT id, active, is_system FROM ${t} WHERE ${col} = ?`, [v]);
    if (existing?.is_system) throw new HttpError(400, 'that name is reserved');
    if (existing?.active) throw new HttpError(409, `${kind} "${v}" already exists`);
    if (existing) {
      await exec(conn, `UPDATE ${t} SET active = TRUE WHERE id = ?`, [existing.id]);
      await audit(conn, userId, t, existing.id, 'restore', null, { [col]: v });
      return { id: existing.id, restored: true };
    }
    const max = await one<{ m: number }>(conn, `SELECT COALESCE(MAX(sort), 0) AS m FROM ${t} WHERE NOT is_system`);
    const r = await exec(conn, `INSERT INTO ${t} (${col}, sort) VALUES (?, ?)`, [v, Number(max!.m) + 1]);
    await audit(conn, userId, t, r.insertId, 'create', null, { [col]: v });
    return { id: r.insertId, restored: false };
  });
}

/** SET-03: removing only hides the value; stock and history are kept. */
export async function setActive(kind: Kind, id: number, active: boolean, userId: number) {
  const { t } = table(kind);
  return withTx(async (conn) => {
    const r = await exec(conn, `UPDATE ${t} SET active = ? WHERE id = ? AND NOT is_system`, [active, id]);
    if (!r.affectedRows) throw new HttpError(404, `${kind} not found`);
    await audit(conn, userId, t, id, active ? 'restore' : 'deactivate', null, null);
    return { id, active };
  });
}

/** SET-04: new display order for sizes. */
export async function reorderSizes(ids: number[], userId: number) {
  return withTx(async (conn) => {
    for (const [i, id] of ids.entries()) await exec(conn, 'UPDATE size SET sort = ? WHERE id = ? AND NOT is_system', [i + 1, id]);
    await audit(conn, userId, 'size', null, 'update', null, { order: ids });
    return { ok: true };
  });
}

async function audit(conn: Conn, userId: number | null, entity: string, id: number | null, action: string, before: unknown, after: unknown) {
  await exec(conn, 'INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json) VALUES (?,?,?,?,?,?)',
    [userId, entity, id === null ? null : String(id), action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]);
}

// ---------------------------------------------------------------- Oracle value mapping (MAP-*)

const COLUMN_TARGET = {
  SUIT_TYPE: { fk: 'garment_type_id', table: 'garment_type', label: 'name' },
  SUIT_COLOR: { fk: 'color_id', table: 'color', label: 'name' },
  SUIT_SIZE: { fk: 'size_id', table: 'size', label: 'code' },
  SUIT_LEVEL: { fk: 'location_id', table: 'location', label: 'code' },
} as const;
type OracleColumn = keyof typeof COLUMN_TARGET;
const issueColumn: Record<OracleColumn, string> = { SUIT_TYPE: 'suit_type', SUIT_COLOR: 'suit_color', SUIT_SIZE: 'suit_size', SUIT_LEVEL: 'suit_level' };

export async function oracleValues(conn: Conn) {
  const rs = await rows<Record<string, unknown> & { oracle_column: OracleColumn; oracle_value: string; first_seen: string | null; last_seen: string | null }>(conn,
    `SELECT m.id, m.oracle_column, m.oracle_value, m.is_ignored, m.row_count, m.first_seen, m.last_seen,
            COALESCE(g.name, c.name, s.code, l.code) AS gi_value,
            COALESCE(m.garment_type_id, m.color_id, m.size_id, m.location_id) AS gi_id
       FROM oracle_value_map m LEFT JOIN garment_type g ON g.id = m.garment_type_id LEFT JOIN color c ON c.id = m.color_id
       LEFT JOIN size s ON s.id = m.size_id LEFT JOIN location l ON l.id = m.location_id
      ORDER BY (COALESCE(m.garment_type_id, m.color_id, m.size_id, m.location_id) IS NULL AND NOT m.is_ignored) DESC, m.oracle_column, m.oracle_value`);
  const held = await rows<{ c: string; v: string; n: number }>(conn,
    `SELECT 'SUIT_TYPE' c, suit_type v, COUNT(*) n FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_type
     UNION ALL SELECT 'SUIT_COLOR', suit_color, COUNT(*) FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_color
     UNION ALL SELECT 'SUIT_SIZE', suit_size, COUNT(*) FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_size
     UNION ALL SELECT 'SUIT_LEVEL', suit_level, COUNT(*) FROM issue_import WHERE status = 'held_unmapped' GROUP BY suit_level`);
  return rs.map((r) => ({
    ...r,
    first_seen: r.first_seen ? fromDb(r.first_seen).toISOString() : null,
    last_seen: r.last_seen ? fromDb(r.last_seen).toISOString() : null,
    mapped: r.gi_id !== null || !!r.is_ignored,
    heldRows: Number(held.find((h) => h.c === r.oracle_column && h.v === r.oracle_value)?.n ?? 0),
  }));
}

export const mappingInput = z.object({ targetId: z.number().int().nullable().optional(), ignore: z.boolean().optional() });

/**
 * Maps (or ignores) one Oracle value, then re-classifies held rows that use it (MAP-03).
 * Already applied rows are not re-booked: changing an existing mapping affects new rows only.
 */
export async function setMapping(id: number, input: z.infer<typeof mappingInput>, userId: number) {
  return withTx(async (conn) => {
    const m = await one<{ oracle_column: OracleColumn; oracle_value: string }>(conn, 'SELECT oracle_column, oracle_value FROM oracle_value_map WHERE id = ? FOR UPDATE', [id]);
    if (!m) throw new HttpError(404, 'value not found');
    const target = COLUMN_TARGET[m.oracle_column];
    const ignore = !!input.ignore;
    const targetId = ignore ? null : input.targetId ?? null;
    if (!ignore && targetId === null) throw new HttpError(400, 'choose a GI value or Ignore');
    if (targetId !== null && !(await one(conn, `SELECT 1 FROM ${target.table} WHERE id = ?`, [targetId]))) throw new HttpError(400, 'unknown GI value');
    await exec(conn,
      `UPDATE oracle_value_map SET garment_type_id = NULL, color_id = NULL, size_id = NULL, location_id = NULL,
         ${target.fk} = ?, is_ignored = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [targetId, ignore, userId, new Date(), id]);
    await audit(conn, userId, 'oracle_value_map', id, 'update', null, { column: m.oracle_column, value: m.oracle_value, targetId, ignore });
    const applied = await reclassify(conn, `status = 'held_unmapped' AND ${issueColumn[m.oracle_column]} = ?`, [m.oracle_value], userId,
      `mapped ${m.oracle_column} ${m.oracle_value}`);
    return { id, reclassified: applied };
  });
}

// ---------------------------------------------------------------- data quality (DQ-05)

export async function dataQuality(conn: Conn, days: number) {
  const perDay = await rows<{ day: string; location: string | null; incomplete: number; total: number }>(conn,
    `SELECT issued_day AS day, l.code AS location, SUM(quality = 'incomplete') AS incomplete, COUNT(*) AS total
       FROM issue_import ii LEFT JOIN location l ON l.id = ii.location_id
      WHERE issued_day >= CURDATE() - INTERVAL ? DAY AND status <> 'ignored'
      GROUP BY issued_day, l.code ORDER BY issued_day`, [days]);
  const barcodes = await unregisteredBarcodes(conn);
  const patterns = await rows(conn, 'SELECT id, suit_type, suit_color, suit_size, active FROM dq_pattern ORDER BY id');
  return { perDay: perDay.map((r) => ({ ...r, incomplete: Number(r.incomplete), total: Number(r.total) })), unregisteredBarcodes: barcodes, patterns };
}

export async function unregisteredBarcodes(conn: Conn) {
  const rs = await rows<{ barcode: string; times: number; first_seen: string; last_seen: string; locations: string }>(conn,
    `SELECT ii.suit_barcode AS barcode, COUNT(*) AS times, MIN(ii.issued_at) AS first_seen, MAX(ii.issued_at) AS last_seen,
            GROUP_CONCAT(DISTINCT ii.suit_level ORDER BY ii.suit_level) AS locations
       FROM issue_import ii WHERE ii.quality = 'incomplete' GROUP BY ii.suit_barcode ORDER BY times DESC, barcode`);
  return rs.map((r) => ({ ...r, times: Number(r.times), first_seen: fromDb(r.first_seen).toISOString(), last_seen: fromDb(r.last_seen).toISOString() }));
}
