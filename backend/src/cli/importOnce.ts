// Runs one import (and optionally the sweep) against the configured source. Dev helper.
import { closePool } from '../db.js';
import { getIssueSource } from '../import/index.js';
import { poll, sweep } from '../import/importer.js';

const source = await getIssueSource();
const t0 = Date.now();
console.log(await poll(source, new Date(), process.argv.includes('--backfill') ? 'backfill' : 'poll'));
if (process.argv.includes('--sweep')) console.log(await sweep(source));
console.log(`took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await source.close();
await closePool();
