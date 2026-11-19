// Generates mock Oracle data that behaves like the real issuing system:
// - one row per garment issued; STATE = 'EMPLOYEE GOWN ISSUE' (plus other states to filter out)
// - INSERT_TIME = scan time in Taipei time; RECTIME = entry time in Phoenix time, 0–15 h later
// - records are entered in batches per location, so RECTIME is ordered within a location only;
//   Fab2's batches become visible up to 40 min after their RECTIME (out of order across locations)
// - ~3 % of barcodes are not registered in the suit master → reported as GOWN / OTHER / OTHER
// - a new size code "5XL" (unmapped), a "TEST" location (ignored), one row with a bad clock
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

// Deterministic PRNG so every run produces the same data for the same day.
let seed = 20261118;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T,>(items: [T, number][]): T => {
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
];

interface Garment { barcode: string; type: string; color: string; size: string; registered: boolean }
const garments = new Map<string, Garment[]>(); // pool per type|color|size
let serial = 100000;
function garmentFor(type: string, color: string, size: string): Garment {
  const key = `${type}|${color}|${size}`;
  const pool = garments.get(key) ?? [];
  garments.set(key, pool);
  if (pool.length < 40 || rand() < 0.02) {
    const g = { barcode: `${type[0]}-${serial++}`, type, color, size, registered: rand() > 0.03 };
    pool.push(g);
    return g;
  }
  return pool[Math.floor(rand() * pool.length)];
}

interface Row {
  SUIT_BARCODE: string; SUIT_TYPE: string; SUIT_COLOR: string; SUIT_SIZE: string; SUIT_LEVEL: string;
  INSERT_TIME: string; RECTIME: string; STATE: string; VISIBLE_AT: string;
}
const rows: Row[] = [];
const scans: { level: string; at: DateTime; g: Garment; state: string }[] = [];

const today = DateTime.now().setZone(PHX).startOf('day');
for (let d = -DAYS; d <= AHEAD; d++) {
  const day = today.plus({ days: d });
  const weekend = day.weekday >= 6;
  for (const { level, people } of [...LEVELS, { level: 'TEST', people: 2 }]) {
    const n = Math.round(people * (weekend ? 0.55 : 1) * (0.85 + rand() * 0.3));
    for (let p = 0; p < n; p++) {
      // Gowning peaks at Phoenix shift starts: 06:00, 14:00, 22:00
      const shift = pick<number>([[6, 50], [14, 35], [22, 15]]);
      const start = day.plus({ hours: shift, minutes: Math.floor(rand() * 75) - 15, seconds: Math.floor(rand() * 60) });
      const color = pick(COLORS);
      const size = pick(SIZES);
      TYPES.forEach((type, i) => {
        if (type === 'HOOD' && rand() < 0.05) return; // some people reuse a hood
        scans.push({ level, at: start.plus({ seconds: i * 7 + Math.floor(rand() * 5) }), g: garmentFor(type, color, size), state: 'EMPLOYEE GOWN ISSUE' });
      });
      if (rand() < 0.3) scans.push({ level, at: start.plus({ hours: 8 }), g: garmentFor('GOWN', color, size), state: 'EMPLOYEE GOWN RETURN' });
    }
  }
}

// Records are entered in batches per location every 1–4 h, so the delay is 0–15 h.
const batchTimes = new Map<string, DateTime[]>();
for (const { level } of [...LEVELS, { level: 'TEST' }]) {
  const times: DateTime[] = [];
  let t = today.plus({ days: -DAYS - 1 });
  const end = today.plus({ days: AHEAD + 2 });
  while (t < end) {
    t = t.plus({ minutes: 60 + Math.floor(rand() * 180) });
    times.push(t);
  }
  batchTimes.set(level, times);
}
const nextBatch = (level: string, at: DateTime) => {
  const times = batchTimes.get(level)!;
  // Usually the next batch; sometimes one is skipped and the row waits for a later one.
  const i = times.findIndex((t) => t > at);
  const skip = rand() < 0.25 ? Math.floor(rand() * 4) : 0;
  const t = times[Math.min(i + skip, times.length - 1)];
  return t.diff(at, 'hours').hours > 15 ? at.plus({ hours: 14 + rand() }) : t;
};

for (const s of scans) {
  const entered = nextBatch(s.level, s.at).plus({ seconds: Math.floor(rand() * 50) });
  const visible = s.level === 'FAB2' ? entered.plus({ minutes: Math.floor(rand() * 40) }) : entered;
  const g = s.g;
  rows.push({
    SUIT_BARCODE: g.barcode,
    SUIT_TYPE: g.registered ? g.type : 'GOWN',
    SUIT_COLOR: g.registered ? g.color : 'OTHER',
    SUIT_SIZE: g.registered ? g.size : 'OTHER',
    SUIT_LEVEL: s.level,
    INSERT_TIME: s.at.setZone(TPE).toFormat(FMT),
    RECTIME: entered.toFormat(FMT),
    STATE: s.state,
    VISIBLE_AT: visible.toFormat(FMT),
  });
}

// One row with a bad clock about a month ago: RECTIME ~140 h before the scan (ORA-13).
const bad = rows.find((r) => r.STATE === 'EMPLOYEE GOWN ISSUE' && r.SUIT_LEVEL === 'FAB1' && r.INSERT_TIME.startsWith(today.minus({ days: 30 }).setZone(TPE).toFormat('yyyy-MM-dd')));
if (bad) {
  const rect = DateTime.fromFormat(bad.RECTIME, FMT, { zone: PHX }).minus({ hours: 150 }).toFormat(FMT);
  bad.RECTIME = rect;
}

// Keep unique (SUIT_BARCODE, INSERT_TIME), as in Oracle.
const seen = new Set<string>();
const unique = rows.filter((r) => (seen.has(r.SUIT_BARCODE + r.INSERT_TIME) ? false : (seen.add(r.SUIT_BARCODE + r.INSERT_TIME), true)));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'issues.ndjson'), unique.map((r) => JSON.stringify(r)).join('\n') + '\n');
const master = [...garments.values()].flat().filter((g) => g.registered)
  .map((g) => JSON.stringify({ SUIT_BARCODE: g.barcode, SUIT_CATEGORY: 'CLEANROOM', SUIT_TYPE: g.type, SUIT_COLOR: g.color, SUIT_SIZE: g.size }));
writeFileSync(join(OUT, 'suit_master.ndjson'), master.join('\n') + '\n');

const issues = unique.filter((r) => r.STATE === 'EMPLOYEE GOWN ISSUE');
console.log(`wrote ${unique.length} rows (${issues.length} issues, ${issues.filter((r) => r.SUIT_COLOR === 'OTHER' && r.SUIT_SIZE === 'OTHER').length} unregistered) and ${master.length} registered barcodes to ${OUT}`);
