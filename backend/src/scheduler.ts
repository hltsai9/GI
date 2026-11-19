import { DateTime } from 'luxon';
import { config } from './config.js';
import { getIssueSource } from './import/index.js';
import { alert, poll, sweep, syncStatus } from './import/importer.js';
import { invariantViolations } from './ledger.js';
import { getPool } from './db.js';

/** Regular import, daily catch-up sweep at 03:00 and stale check (ORA-03/03a/07). Single instance. */
export function startScheduler(log: (msg: string) => void = console.log): () => void {
  let lastSweepDay = '';
  let staleAlerted = false;
  const tick = async () => {
    try {
      const source = await getIssueSource();
      const r = await poll(source);
      if (r.new) log(`import: ${r.new} new rows ${JSON.stringify(r.byStatus)}`);
      const now = DateTime.now().setZone(config.SITE_TIMEZONE);
      if (now.hour >= 3 && lastSweepDay !== now.toISODate()) {
        lastSweepDay = now.toISODate()!;
        await sweep(source);
        const bad = await invariantViolations(getPool());
        if (bad.length) await alert('import_failed', `Ledger check: ${bad.length} stock items disagree with their ledger`, bad.slice(0, 20));
      }
      staleAlerted = false;
    } catch (err) {
      log(`import failed: ${(err as Error).message}`);
      const s = await syncStatus().catch(() => null);
      if (s?.stale && !staleAlerted) {
        staleAlerted = true;
        await alert('import_stale', `No successful issue import for more than ${(2 * config.ORACLE_POLL_SECONDS) / 60} minutes`, s).catch(() => {});
      }
    }
  };
  void tick();
  const timer = setInterval(tick, config.ORACLE_POLL_SECONDS * 1000);
  return () => clearInterval(timer);
}
