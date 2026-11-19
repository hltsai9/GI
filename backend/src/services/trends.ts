import { DateTime } from 'luxon';
import { config } from '../config.js';
import { rows, type Conn } from '../db.js';
import { fromDb, siteDay } from '../time.js';

/** Inclusive list of site-time days ending today. */
export function dayRange(days: number, now = new Date()): string[] {
  const end = DateTime.fromJSDate(now, { zone: config.SITE_TIMEZONE }).startOf('day');
  return Array.from({ length: days }, (_, i) => end.minus({ days: days - 1 - i }).toISODate()!);
}

function bucketOf(day: string, per: 'day' | 'week' | 'month'): string {
  const d = DateTime.fromISO(day);
  if (per === 'week') return d.startOf('week').toISODate()!;
  if (per === 'month') return d.toFormat('yyyy-MM');
  return day;
}

async function seriesTypes(conn: Conn, includeSystem: boolean) {
  return rows<{ id: number; name: string; is_system: number }>(conn,
    `SELECT id, name, is_system FROM garment_type WHERE active ${includeSystem ? '' : 'AND NOT is_system'} ORDER BY sort`);
}

/** TRD-01: items delivered per day / week / month, by garment type. */
export async function delivered(conn: Conn, days: number, per: 'day' | 'week' | 'month', now = new Date()) {
  const range = dayRange(days, now);
  const rs = await rows<{ day: string; type_id: number; n: number }>(conn,
    `SELECT d.received_day AS day, si.garment_type_id AS type_id, SUM(dl.qty_current) AS n
       FROM delivery d JOIN delivery_line dl ON dl.delivery_id = d.id JOIN stock_item si ON si.id = dl.stock_item_id
      WHERE d.received_day BETWEEN ? AND ? GROUP BY d.received_day, si.garment_type_id`, [range[0], range[range.length - 1]]);
  const types = await seriesTypes(conn, false);
  const buckets = [...new Set(range.map((d) => bucketOf(d, per)))];
  const points = buckets.map((b) => {
    const values: Record<string, number> = {};
    for (const t of types) values[t.name] = rs.filter((r) => r.type_id === t.id && bucketOf(r.day, per) === b).reduce((s, r) => s + Number(r.n), 0);
    return { bucket: b, values, total: Object.values(values).reduce((a, c) => a + c, 0) };
  });
  return { per, series: types.map((t) => t.name), points, total: points.reduce((s, p) => s + p.total, 0) };
}

/** TRD-02: items issued per day by garment type, with unregistered garments as their own series. */
export async function issued(conn: Conn, days: number, now = new Date()) {
  const range = dayRange(days, now);
  const rs = await rows<{ day: string; type_id: number; n: number }>(conn,
    `SELECT ii.issued_day AS day, si.garment_type_id AS type_id, COUNT(*) AS n
       FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id
      WHERE ii.issued_day BETWEEN ? AND ? AND ii.status IN ('applied','before_start')
      GROUP BY ii.issued_day, si.garment_type_id`, [range[0], range[range.length - 1]]);
  const types = await seriesTypes(conn, true);
  const points = range.map((day) => {
    const values: Record<string, number> = {};
    for (const t of types) values[t.name] = Number(rs.find((r) => r.day === day && r.type_id === t.id)?.n ?? 0);
    return { day, values, total: Object.values(values).reduce((a, c) => a + c, 0) };
  });
  const weekdays = points.slice(0, -1).filter((p) => DateTime.fromISO(p.day).weekday <= 5);
  const avg = weekdays.length ? weekdays.reduce((s, p) => s + p.total, 0) / weekdays.length : 0;
  return { series: types.map((t) => t.name), points, weekdayAverage: Math.round(avg), today: siteDay(now) };
}

/**
 * TRD-03/04: end-of-day stock per garment type, plus delivered vs issued per day.
 * A location contributes only from the day of its starting count; before any, stock is null.
 */
export async function stockOverTime(conn: Conn, days: number, now = new Date()) {
  const range = dayRange(days, now);
  const starts = await rows<{ location_id: number; as_of: string }>(conn, 'SELECT location_id, as_of FROM starting_count');
  const startDay = new Map(starts.map((s) => [s.location_id, siteDay(fromDb(s.as_of))]));
  const opening = await rows<{ type_id: number; location_id: number; n: number }>(conn,
    `SELECT si.garment_type_id AS type_id, si.location_id, SUM(l.delta) AS n FROM ledger_entry l JOIN stock_item si ON si.id = l.stock_item_id
      WHERE l.day < ? GROUP BY si.garment_type_id, si.location_id`, [range[0]]);
  const daily = await rows<{ day: string; type_id: number; location_id: number; n: number }>(conn,
    `SELECT l.day, si.garment_type_id AS type_id, si.location_id, SUM(l.delta) AS n FROM ledger_entry l JOIN stock_item si ON si.id = l.stock_item_id
      WHERE l.day BETWEEN ? AND ? GROUP BY l.day, si.garment_type_id, si.location_id`, [range[0], range[range.length - 1]]);
  const types = await seriesTypes(conn, false);
  const locations = [...startDay.keys()];
  const running = new Map<string, number>();
  for (const o of opening) running.set(`${o.type_id}|${o.location_id}`, Number(o.n));
  const points = range.map((day) => {
    for (const d of daily.filter((x) => x.day === day)) {
      const k = `${d.type_id}|${d.location_id}`;
      running.set(k, (running.get(k) ?? 0) + Number(d.n));
    }
    const live = locations.filter((l) => startDay.get(l)! <= day);
    const values: Record<string, number | null> = {};
    for (const t of types) values[t.name] = live.length ? live.reduce((s, l) => s + (running.get(`${t.id}|${l}`) ?? 0), 0) : null;
    return { day, values };
  });
  const [del, iss] = await Promise.all([delivered(conn, days, 'day', now), issued(conn, days, now)]);
  const flows = range.map((day, i) => ({ day, delivered: del.points[i].total, issued: iss.points[i].total }));
  const dTot = flows.reduce((s, f) => s + f.delivered, 0);
  const iTot = flows.reduce((s, f) => s + f.issued, 0);
  return { series: types.map((t) => t.name), points, flows, totals: { delivered: dTot, issued: iTot, net: dTot - iTot } };
}

/** TRD-06: breakdown by size and by location for the range. */
export async function breakdown(conn: Conn, days: number, metric: 'issued' | 'delivered', now = new Date()) {
  const range = dayRange(days, now);
  const sql = metric === 'issued'
    ? `SELECT s.code AS size, l.code AS location, COUNT(*) AS n FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id
         JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
        WHERE ii.issued_day BETWEEN ? AND ? AND ii.status IN ('applied','before_start') GROUP BY s.code, s.sort, l.code ORDER BY s.sort`
    : `SELECT s.code AS size, l.code AS location, SUM(dl.qty_current) AS n FROM delivery d JOIN delivery_line dl ON dl.delivery_id = d.id
         JOIN stock_item si ON si.id = dl.stock_item_id JOIN size s ON s.id = si.size_id JOIN location l ON l.id = si.location_id
        WHERE d.received_day BETWEEN ? AND ? GROUP BY s.code, s.sort, l.code ORDER BY s.sort`;
  const rs = await rows<{ size: string; location: string; n: number }>(conn, sql, [range[0], range[range.length - 1]]);
  const bySize = new Map<string, number>();
  const byLocation = new Map<string, number>();
  for (const r of rs) {
    bySize.set(r.size, (bySize.get(r.size) ?? 0) + Number(r.n));
    byLocation.set(r.location, (byLocation.get(r.location) ?? 0) + Number(r.n));
  }
  return { metric, bySize: [...bySize].map(([size, n]) => ({ size, n })), byLocation: [...byLocation].map(([location, n]) => ({ location, n })) };
}
