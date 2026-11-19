import { DateTime } from 'luxon';
import { config } from '../config.js';
import { exec, one, rows, type Conn } from '../db.js';
import { fromDb, siteDay } from '../time.js';
import { HttpError } from '../http.js';

export type Status = 'negative' | 'below_min' | 'close_to_min' | 'plenty' | 'not_stocked';
export const CLOSE_TO_MIN_FACTOR = 1.5; // TODO: confirm with the lead

export function stockStatus(onHand: number, min: number | null): Status {
  if (onHand < 0) return 'negative';
  if (!min) return 'not_stocked';
  if (onHand < min) return 'below_min';
  if (onHand < min * CLOSE_TO_MIN_FACTOR) return 'close_to_min';
  return 'plenty';
}

const today = (now: Date) => siteDay(now);

/** Average issues per weekday over the last 7 full days, per garment type (days of cover). */
async function weekdayIssueRate(conn: Conn, now: Date): Promise<Map<number, number>> {
  const end = DateTime.fromJSDate(now, { zone: config.SITE_TIMEZONE }).startOf('day');
  const days: string[] = [];
  for (let i = 1; days.length < 5 && i <= 14; i++) {
    const d = end.minus({ days: i });
    if (d.weekday <= 5) days.push(d.toISODate()!);
  }
  const rs = await rows<{ type_id: number; n: number }>(conn,
    `SELECT si.garment_type_id AS type_id, COUNT(*) AS n FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id
      WHERE ii.status IN ('applied','before_start') AND ii.issued_day IN (${days.map(() => '?').join(',')})
      GROUP BY si.garment_type_id`, days);
  return new Map(rs.map((r) => [r.type_id, Number(r.n) / days.length]));
}

export async function stockSummary(conn: Conn, now = new Date()) {
  const day = today(now);
  const types = await rows<{ id: number; name: string; plural: string; icon: string }>(conn,
    'SELECT id, name, plural, icon FROM garment_type WHERE NOT is_system AND active ORDER BY sort');
  const byTypeLoc = await rows<{ type_id: number; location: string; on_hand: number }>(conn,
    `SELECT si.garment_type_id AS type_id, l.code AS location, SUM(si.on_hand) AS on_hand
       FROM stock_item si JOIN location l ON l.id = si.location_id GROUP BY si.garment_type_id, l.code`);
  const locations = await rows<{ id: number; code: string }>(conn, 'SELECT id, code FROM location ORDER BY id');
  const rate = await weekdayIssueRate(conn, now);
  const delivered = await rows<{ type_id: number; n: number }>(conn,
    `SELECT si.garment_type_id AS type_id, SUM(dl.qty_current) AS n FROM delivery d JOIN delivery_line dl ON dl.delivery_id = d.id
       JOIN stock_item si ON si.id = dl.stock_item_id WHERE d.received_day = ? GROUP BY si.garment_type_id`, [day]);
  const issued = await rows<{ type_id: number; n: number }>(conn,
    `SELECT si.garment_type_id AS type_id, COUNT(*) AS n FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id
      WHERE ii.issued_day = ? AND ii.status IN ('applied','before_start') GROUP BY si.garment_type_id`, [day]);
  const n = (list: { type_id: number; n: number }[], id: number) => Number(list.find((r) => r.type_id === id)?.n ?? 0);

  const totals = types.map((t) => {
    const perLoc = Object.fromEntries(locations.map((l) => [l.code, Number(byTypeLoc.find((r) => r.type_id === t.id && r.location === l.code)?.on_hand ?? 0)]));
    const total = Object.values(perLoc).reduce((a, b) => a + b, 0);
    const r = rate.get(t.id) ?? 0;
    return {
      garmentTypeId: t.id, name: t.name, plural: t.plural, icon: t.icon, onHand: total, byLocation: perLoc,
      daysOfCover: r > 0 ? Math.round((total / r) * 10) / 10 : null,
      deliveredToday: n(delivered, t.id), issuedToday: n(issued, t.id),
    };
  });

  const unregistered = await rows<{ location: string; on_hand: number }>(conn,
    `SELECT l.code AS location, si.on_hand FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id
       JOIN location l ON l.id = si.location_id WHERE g.is_system ORDER BY l.id`);
  const unregisteredToday = await one<{ n: number }>(conn,
    "SELECT COUNT(*) AS n FROM issue_import WHERE issued_day = ? AND quality = 'incomplete' AND status IN ('applied','before_start')", [day]);

  const reorder = await rows<Record<string, unknown> & { on_hand: number; min_qty: number }>(conn,
    `SELECT si.id, g.name AS garment, g.icon, c.name AS color, s.code AS size, l.code AS location, si.on_hand, si.min_qty
       FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
       JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
      WHERE NOT g.is_system AND si.min_qty IS NOT NULL AND si.on_hand < si.min_qty
      ORDER BY si.on_hand / si.min_qty, si.id LIMIT 5`);
  const negative = await one<{ n: number }>(conn,
    'SELECT COUNT(*) AS n FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id WHERE si.on_hand < 0 AND NOT g.is_system');
  const belowMin = await one<{ n: number }>(conn,
    'SELECT COUNT(*) AS n FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id WHERE NOT g.is_system AND si.min_qty IS NOT NULL AND si.on_hand < si.min_qty');

  return {
    asOf: now.toISOString(),
    day,
    totals,
    unregistered: unregistered.map((u) => ({ location: u.location, onHand: u.on_hand, sinceLastCheck: Math.max(0, -u.on_hand) })),
    unregisteredToday: Number(unregisteredToday?.n ?? 0),
    reorder: reorder.map((r) => ({ ...r, status: stockStatus(r.on_hand, r.min_qty) })),
    belowMinCount: Number(belowMin?.n ?? 0),
    negativeCount: Number(negative?.n ?? 0),
  };
}

export async function stockGrid(conn: Conn, garmentTypeId: number, locationId: number) {
  const sizes = await rows<{ id: number; code: string }>(conn, 'SELECT id, code FROM size WHERE active AND NOT is_system ORDER BY sort');
  const colors = await rows<{ id: number; name: string }>(conn, 'SELECT id, name FROM color WHERE active AND NOT is_system ORDER BY sort');
  const items = await rows<{ id: number; color_id: number; size_id: number; on_hand: number; min_qty: number | null }>(conn,
    'SELECT id, color_id, size_id, on_hand, min_qty FROM stock_item WHERE garment_type_id = ? AND location_id = ?', [garmentTypeId, locationId]);
  return {
    sizes, colors,
    rows: sizes.map((s) => ({
      sizeId: s.id, size: s.code,
      cells: colors.map((c) => {
        const it = items.find((i) => i.color_id === c.id && i.size_id === s.id);
        return it
          ? { stockItemId: it.id, colorId: c.id, onHand: it.on_hand, min: it.min_qty, status: stockStatus(it.on_hand, it.min_qty) }
          : { stockItemId: null, colorId: c.id, onHand: 0, min: null, status: 'not_stocked' as Status };
      }),
    })),
  };
}

export async function stockItemDetail(conn: Conn, id: number, now = new Date()) {
  const it = await one<Record<string, unknown> & { on_hand: number; min_qty: number | null }>(conn,
    `SELECT si.id, si.on_hand, si.min_qty, g.name AS garment, c.name AS color, s.code AS size, l.code AS location
       FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id JOIN color c ON c.id = si.color_id
       JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id WHERE si.id = ?`, [id]);
  if (!it) throw new HttpError(404, 'stock item not found');
  const issuedToday = await one<{ n: number }>(conn,
    "SELECT COUNT(*) AS n FROM issue_import WHERE stock_item_id = ? AND issued_day = ? AND status IN ('applied','before_start')", [id, today(now)]);
  const last = await one<{ received_at: string; qty: number }>(conn,
    `SELECT d.received_at, dl.qty_current AS qty FROM delivery_line dl JOIN delivery d ON d.id = dl.delivery_id
      WHERE dl.stock_item_id = ? AND dl.qty_current > 0 ORDER BY d.received_at DESC LIMIT 1`, [id]);
  return {
    ...it, status: stockStatus(it.on_hand, it.min_qty), issuedToday: Number(issuedToday?.n ?? 0),
    lastDelivery: last ? { at: fromDb(last.received_at).toISOString(), qty: last.qty } : null,
  };
}

export async function setMinimum(conn: Conn, id: number, min: number | null, userId: number) {
  const before = await one<{ min_qty: number | null }>(conn, 'SELECT min_qty FROM stock_item WHERE id = ?', [id]);
  if (!before) throw new HttpError(404, 'stock item not found');
  await exec(conn, 'UPDATE stock_item SET min_qty = ? WHERE id = ?', [min, id]);
  await exec(conn, "INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json) VALUES (?, 'stock_item.min_qty', ?, 'update', ?, ?)",
    [userId, String(id), JSON.stringify({ min: before.min_qty }), JSON.stringify({ min })]);
  return { id, min };
}
