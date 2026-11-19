// Generates mock Oracle data that behaves like the real issuing system:
// - one row per garment issued; STATE = 'EMPLOYEE GOWN ISSUE' (plus other states to filter out)
// - INSERT_TIME = scan time in Taipei time; RECTIME = entry time in Phoenix time, 0–15 h later
// - records are entered in batches per location, so RECTIME is ordered within a location only;
//   Fab2's batches become visible up to 40 min after their RECTIME (out of order across locations)
// - ~3 % of barcodes are not registered in the suit master → reported as GOWN / OTHER / OTHER
// - a new size code "5XL" (unmapped), a "TEST" location (ignored), and now and then a row with a bad clock
//
// Deterministic per calendar day: the rows for a given day are identical whenever and wherever they
// are generated, so several replicas (each generating its own copy) import the same data.
//
// Usage: npm run mock:generate -- [--days 45] [--ahead 2] [--out mock-oracle/data]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const DAYS = Number(args.days ?? 45);
const AHEAD = Number(args.ahead ?? 2); // rows scanned "in the future" become visible as time passes
const OUT = args.out ?? 'mock-oracle/data';

const PHX = 'America/Phoenix';
const TPE = 'Asia/Taipei';
const FMT = 'yyyy-MM-dd HH:mm:ss';

/** Deterministic random numbers from a text seed (FNV-1a hash → mulberry32). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rand: () => number, items: [T, number][]): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [v, w] of items) if ((x -= w) <= 0) return v;
  return items[items.length - 1][0];
};

const TYPES = ['GOWN', 'HOOD', 'BOOT'] as const;
const COLORS: [string, number][] = [['WHITE', 70], ['BLUE', 22], ['BLACK', 7], ['OTHER', 1]];
const SIZES: [string, number][] = [['S', 8], ['M', 22], ['L', 30], ['XL', 22], ['2XL', 10], ['3XL', 4], ['4XL', 2], ['5XL', 0.3]];
const LEVELS: { level: string; people: number }[] = [
  { level: 'FAB1', people: 140 },
  { level: 'FAB2', people: 85 },
  { level: 'TEST', people: 2 },
];

// Each type × color × size has a fixed pool of 40 garments; a barcode always means the same garment.
interface Garment { barcode: string; type: string; color: string; size: string; registered: boolean }
const COLOR_CODE: Record<string, string> = { WHITE: 'WH', BLUE: 'BU', BLACK: 'BK', OTHER: 'OT' }; // unique per color
const garments = new Map<string, Garment>();
function garmentFor(type: string, color: string, size: string, rand: () => number): Garment {
  const barcode = `${type[0]}-${COLOR_CODE[color]}${size.padStart(3, '0')}-${String(Math.floor(rand() * 40)).padStart(3, '0')}`;
  let g = garments.get(barcode);
  if (!g) {
    g = { barcode, type, color, size, registered: rng(`registered|${barcode}`)() > 0.03 };
    garments.set(barcode, g);
  }
  return g;
}

/** Times records are entered for a location on a Phoenix day: every 1–4 h. Same for any generation run. */
const batchCache = new Map<string, DateTime[]>();
function batches(level: string, day: DateTime): DateTime[] {
  const key = `${level}|${day.toISODate()}`;
  let times = batchCache.get(key);
  if (!times) {
    const rand = rng(`batches|${key}`);
    times = [];
    let t = day.plus({ minutes: 20 + Math.floor(rand() * 100) });
    while (t < day.plus({ days: 1 })) {
      times.push(t);
      t = t.plus({ minutes: 60 + Math.floor(rand() * 180) });
    }
    batchCache.set(key, times);
  }
  return times;
}
function enteredAt(level: string, at: DateTime, rand: () => number): DateTime {
  const day = at.startOf('day');
  const next = [...batches(level, day), ...batches(level, day.plus({ days: 1 }))].filter((t) => t > at);
  // Usually the next batch; sometimes one or more are skipped and the row waits for a later one.
  const skip = rand() < 0.25 ? Math.floor(rand() * 4) : 0;
  const t = next[Math.min(skip, next.length - 1)];
  return t.diff(at, 'hours').hours > 15 ? at.plus({ hours: 14 + rand() }) : t;
}

interface Row {
  SUIT_BARCODE: string; SUIT_TYPE: string; SUIT_COLOR: string; SUIT_SIZE: string; SUIT_LEVEL: string;
  INSERT_TIME: string; RECTIME: string; STATE: string; VISIBLE_AT: string;
}
const rows: Row[] = [];
const today = DateTime.now().setZone(PHX).startOf('day');

for (let d = -DAYS; d <= AHEAD; d++) {
  const day = today.plus({ days: d });
  const iso = day.toISODate()!;
  const weekend = day.weekday >= 6;
  const epochDay = Math.round(day.toUTC().toSeconds() / 86400);
  for (const { level, people } of LEVELS) {
    const rand = rng(`scans|${level}|${iso}`);
    const n = Math.round(people * (weekend ? 0.55 : 1) * (0.85 + rand() * 0.3));
    for (let p = 0; p < n; p++) {
      // Gowning peaks at Phoenix shift starts: 06:00, 14:00, 22:00
      const shift = pick<number>(rand, [[6, 50], [14, 35], [22, 15]]);
      const start = day.plus({ hours: shift, minutes: Math.floor(rand() * 75) - 15, seconds: Math.floor(rand() * 60) });
      const color = pick(rand, COLORS);
      const size = pick(rand, SIZES);
      const scans: [DateTime, Garment, string][] = [];
      TYPES.forEach((type, i) => {
        if (type === 'HOOD' && rand() < 0.05) return; // some people reuse a hood
        scans.push([start.plus({ seconds: i * 7 + Math.floor(rand() * 5) }), garmentFor(type, color, size, rand), 'EMPLOYEE GOWN ISSUE']);
      });
      if (rand() < 0.3) scans.push([start.plus({ hours: 8 }), garmentFor('GOWN', color, size, rand), 'EMPLOYEE GOWN RETURN']);
      for (const [at, g, state] of scans) {
        const r2 = rng(`entry|${g.barcode}|${at.toISO()}`);
        const entered = enteredAt(level, at, r2).plus({ seconds: Math.floor(r2() * 50) });
        const visible = level === 'FAB2' ? entered.plus({ minutes: Math.floor(r2() * 40) }) : entered;
        rows.push({
          SUIT_BARCODE: g.barcode,
          SUIT_TYPE: g.registered ? g.type : 'GOWN',
          SUIT_COLOR: g.registered ? g.color : 'OTHER',
          SUIT_SIZE: g.registered ? g.size : 'OTHER',
          SUIT_LEVEL: level,
          INSERT_TIME: at.setZone(TPE).toFormat(FMT),
          RECTIME: entered.toFormat(FMT),
          STATE: state,
          VISIBLE_AT: visible.toFormat(FMT),
        });
      }
    }
    // Every 30th day, one FAB1 row has a bad clock: RECTIME ~150 h before the scan (ORA-13).
    if (level === 'FAB1' && epochDay % 30 === 0) {
      const bad = rows.find((r) => r.SUIT_LEVEL === 'FAB1' && r.STATE === 'EMPLOYEE GOWN ISSUE' && r.INSERT_TIME >= day.setZone(TPE).toFormat(FMT));
      if (bad) bad.RECTIME = DateTime.fromFormat(bad.RECTIME, FMT, { zone: PHX }).minus({ hours: 150 }).toFormat(FMT);
    }
  }
}

// Keep unique (SUIT_BARCODE, INSERT_TIME), as in Oracle.
const seen = new Set<string>();
const unique = rows.filter((r) => (seen.has(r.SUIT_BARCODE + r.INSERT_TIME) ? false : (seen.add(r.SUIT_BARCODE + r.INSERT_TIME), true)));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'issues.ndjson'), unique.map((r) => JSON.stringify(r)).join('\n') + '\n');
const master = [...garments.values()].filter((g) => g.registered)
  .map((g) => JSON.stringify({ SUIT_BARCODE: g.barcode, SUIT_CATEGORY: 'CLEANROOM', SUIT_TYPE: g.type, SUIT_COLOR: g.color, SUIT_SIZE: g.size }));
writeFileSync(join(OUT, 'suit_master.ndjson'), master.join('\n') + '\n');

const issues = unique.filter((r) => r.STATE === 'EMPLOYEE GOWN ISSUE');
console.log(`wrote ${unique.length} rows (${issues.length} issues, ${issues.filter((r) => r.SUIT_COLOR === 'OTHER' && r.SUIT_SIZE === 'OTHER').length} unregistered) and ${master.length} registered barcodes to ${OUT}`);
