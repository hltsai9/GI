// Records the API responses the frontend needs into frontend/public/demo-data, for the
// read-only demo on GitHub Pages. Run after `npm run demo`. File names must match
// demoFile() in frontend/src/api.ts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { closePool, getPool, rows } from '../db.js';

process.env.NODE_ENV = 'test'; // quiet logger
const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'public', 'demo-data');
const demoFile = (path: string) => path.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_') + '.json';

const app = buildApp();
const db = getPool();
const types = await rows<{ id: number }>(db, 'SELECT id FROM garment_type WHERE active AND NOT is_system');
const locations = await rows<{ id: number }>(db, 'SELECT id FROM location');
const items = await rows<{ id: number }>(db, 'SELECT id FROM stock_item');

const paths = [
  '/me', '/meta', '/deliveries?limit=30', '/stock/summary', '/starting-counts', '/corrections', '/oracle-values',
  '/data-quality?days=30', '/data-quality/unregistered.csv', '/sync/status', '/sync/runs', '/alerts',
  ...types.flatMap((t) => locations.map((l) => `/stock/grid?garmentTypeId=${t.id}&locationId=${l.id}`)),
  ...items.map((i) => `/stock/items/${i.id}`),
];
// Must match the requests in frontend/src/pages/Trends.tsx.
for (const days of [7, 14, 30, 90]) {
  paths.push(`/trends/delivered?days=${days}&per=day`, `/trends/delivered?days=${Math.max(days, 56)}&per=week`,
    `/trends/delivered?days=${Math.max(days, 180)}&per=month`, `/trends/issued?days=${days}`, `/trends/stock?days=${days}`,
    `/trends/breakdown?days=${days}&metric=issued`, `/trends/breakdown?days=${days}&metric=delivered`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let n = 0;
for (const p of [...new Set(paths)]) {
  const res = await app.inject({ method: 'GET', url: `/api${p}`, headers: { 'x-dev-user': 'dev-lead' } });
  if (res.statusCode !== 200) throw new Error(`${p}: ${res.statusCode} ${res.body}`);
  writeFileSync(join(out, demoFile(p)), res.body);
  n++;
}
console.log(`wrote ${n} responses to ${out}`);
await app.close();
await closePool();
