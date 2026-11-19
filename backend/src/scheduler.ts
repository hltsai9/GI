import { DateTime } from 'luxon';
import { config } from './config.js';
import { getIssueSource } from './import/index.js';
import { alert, poll, sweep, syncStatus } from './import/importer.js';
import { invariantViolations } from './ledger.js';
import { getPool, one, withNamedLock } from './db.js';
import { fromDb, siteDay } from './time.js';

/**
 * Regular import, daily catch-up sweep at 03:00 and stale check (ORA-03/03a/07).
 * Safe with several replicas: each run takes the "import" lock in MariaDB, so only one
 * instance imports at a time; if it dies, the lock is freed and another takes over.
 */
export function startScheduler(log: (msg: string) => void = console.log): () => void {
  const tick = async () => {
    try {
      const r = await withNamedLock('import', async () => {
        const source = await getIssueSource();
        const run = await poll(source);
        if (run.new) log(`import: ${run.new} new rows ${JSON.stringify(run.byStatus)}`);
        if (await sweepDue()) {
          await sweep(source);
          const bad = await invariantViolations(getPool());
          if (bad.length) await alert('import_failed', `Ledger check: ${bad.length} stock items disagree with their ledger`, bad.slice(0, 20));
        }
      });
      if (!r.ran) return; // another instance is importing
    } catch (err) {
      log(`import failed: ${(err as Error).message}`);
      await staleAlert().catch(() => {});
    }
  };
  void tick();
  const timer = setInterval(tick, config.ORACLE_POLL_SECONDS * 1000);
  return () => clearInterval(timer);
}

/** The sweep runs once per site day, after 03:00; recorded in sync_run, so any instance knows. */
async function sweepDue(now = new Date()): Promise<boolean> {
  if (DateTime.fromJSDate(now, { zone: config.SITE_TIMEZONE }).hour < 3) return false;
  const last = await one<{ at: string | null }>(getPool(), "SELECT MAX(started_at) AS at FROM sync_run WHERE kind = 'sweep' AND status = 'ok'");
  return !last?.at || siteDay(fromDb(last.at)) !== siteDay(now);
}

/** One "import is stale" alert until someone marks it checked. */
async function staleAlert() {
  const s = await syncStatus();
  if (!s.stale) return;
  const open = await one(getPool(), "SELECT 1 FROM admin_alert WHERE kind = 'import_stale' AND acknowledged_at IS NULL LIMIT 1");
  if (!open) await alert('import_stale', `No successful issue import for more than ${(2 * config.ORACLE_POLL_SECONDS) / 60} minutes`, s);
}
