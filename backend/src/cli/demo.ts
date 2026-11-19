// Builds a demo database: resets it, imports the mock Oracle data, enters a starting count
// for both fabs 21 days ago and a morning delivery every day since. Dev only.
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { closePool, getPool, one, rows } from '../db.js';
import { migrate, resetDatabase } from '../migrate.js';
import { getIssueSource } from '../import/index.js';
import { poll } from '../import/importer.js';
import { saveStartingCount } from '../services/counts.js';
import { postDelivery } from '../services/deliveries.js';

if (!config.DEV_AUTH) throw new Error('refusing: DEV_AUTH is not true');
await resetDatabase(config.MARIADB_URL);
await migrate(config.MARIADB_URL, { seedDev: true });
const db = getPool();
const user = async (s: string) => (await one<{ id: number }>(db, 'SELECT id FROM app_user WHERE sso_subject = ?', [s]))!.id;
const lead = await user('dev-lead');
const floor = await user('dev-floor');

const source = await getIssueSource();
console.log('import', (await poll(source, new Date(), 'backfill')).byStatus);

const today = DateTime.now().setZone(config.SITE_TIMEZONE).startOf('day');
const startDay = today.minus({ days: 21 });
const asOf = startDay.set({ hour: 5 });

// Average daily issues per item over the week before the count → starting stock of ~4 days.
type Use = { location_id: number; garment_type_id: number; color_id: number; size_id: number; n: number };
const usage = await rows<Use>(db,
  `SELECT si.location_id, si.garment_type_id, si.color_id, si.size_id, COUNT(*) / 7 AS n
     FROM issue_import ii JOIN stock_item si ON si.id = ii.stock_item_id JOIN garment_type g ON g.id = si.garment_type_id
    WHERE NOT g.is_system AND ii.issued_day >= ? AND ii.issued_day < ?
    GROUP BY si.location_id, si.garment_type_id, si.color_id, si.size_id`,
  [startDay.minus({ days: 7 }).toISODate(), startDay.toISODate()]);
for (const loc of await rows<{ id: number; code: string }>(db, 'SELECT id, code FROM location')) {
  const counts = usage.filter((u) => u.location_id === loc.id)
    .map((u) => ({ garmentTypeId: u.garment_type_id, colorId: u.color_id, sizeId: u.size_id, qty: Math.round(Number(u.n) * 4) }));
  const r = await saveStartingCount({ locationId: loc.id, asOf: asOf.toUTC().toISO()!, counts }, lead);
  console.log(`starting count ${loc.code}: ${counts.length} items, ${r.issuesApplied} issues applied since`);
}

// Each morning at 06:40 a delivery tops every item back up to ~4 days of its usual use.
const target = new Map(usage.map((u) => [`${u.location_id}|${u.garment_type_id}|${u.color_id}|${u.size_id}`, Math.ceil(Number(u.n) * 4)]));
for (let d = startDay.plus({ days: 1 }); d <= today; d = d.plus({ days: 1 })) {
  const at = d.set({ hour: 6, minute: 40 });
  if (at > DateTime.now()) break;
  const balances = await rows<Use & { bal: number }>(db,
    `SELECT si.location_id, si.garment_type_id, si.color_id, si.size_id, 0 AS n, COALESCE(SUM(l.delta), 0) AS bal
       FROM stock_item si JOIN garment_type g ON g.id = si.garment_type_id LEFT JOIN ledger_entry l ON l.stock_item_id = si.id AND l.at < ?
      WHERE NOT g.is_system GROUP BY si.id`, [at.toUTC().toJSDate()]);
  const lines = balances.flatMap((b) => {
    const t = target.get(`${b.location_id}|${b.garment_type_id}|${b.color_id}|${b.size_id}`) ?? 0;
    const qty = Math.round(Math.max(0, t - Number(b.bal)) * (0.85 + Math.random() * 0.3) / 5) * 5;
    return qty > 0 ? [{ garmentTypeId: b.garment_type_id, colorId: b.color_id, sizeId: b.size_id, locationId: b.location_id, qty }] : [];
  });
  if (lines.length) await postDelivery({ lines }, `demo-${d.toISODate()}`, floor, at.toUTC().toJSDate());
}
const n = await one<{ n: number }>(db, 'SELECT COUNT(*) n FROM delivery');
console.log(`${n!.n} demo deliveries`);
await source.close();
await closePool();
