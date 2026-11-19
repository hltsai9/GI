import type { PoolConnection } from 'mysql2/promise';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { exec, getPool, one, rows, withTx } from '../db.js';
import { applyMovements, type Movement } from '../ledger.js';
import { fromDb, issueTimes, nowLocal, shiftNaive, utcToLocal } from '../time.js';
import { classifyIssue, ClassifyContext, noteValuesSeen, type Classification } from './classify.js';
import type { IssueSource, OracleIssueRow, RectimeKey } from './source.js';

const keyOf = (r: OracleIssueRow): RectimeKey => ({ rectime: r.RECTIME, barcode: r.SUIT_BARCODE });

export interface RunSummary {
  runId: number;
  kind: 'poll' | 'sweep' | 'backfill';
  read: number;
  new: number;
  byStatus: Record<string, number>;
  incomplete: number;
  timeCheckFailed: number;
  issueDays: [string, string] | null;
}

interface Counters {
  read: number;
  new: number;
  byStatus: Record<string, number>;
  incomplete: number;
  timeCheckFailed: number;
  minDay?: string;
  maxDay?: string;
  timeAlerts: Record<string, unknown>[];
}

const newCounters = (): Counters => ({ read: 0, new: 0, byStatus: {}, incomplete: 0, timeCheckFailed: 0, timeAlerts: [] });

/** Imports a batch of Oracle rows in one transaction; returns the highest RECTIME per level. */
async function importBatch(batch: OracleIssueRow[], runId: number, c: Counters, now: Date): Promise<void> {
  if (!batch.length) return;
  await withTx(async (conn) => {
    const ctx = await ClassifyContext.load(conn);
    const seen = new Map<string, number>();
    const movements: Movement[] = [];
    const tolMs = config.ORACLE_TIME_TOLERANCE_MINUTES * 60_000;
    for (const r of batch) {
      c.read++;
      for (const [col, v] of [['SUIT_TYPE', r.SUIT_TYPE], ['SUIT_COLOR', r.SUIT_COLOR], ['SUIT_SIZE', r.SUIT_SIZE], ['SUIT_LEVEL', r.SUIT_LEVEL]]) {
        const k = `${col}\u0000${v}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      const exists = await one(conn, 'SELECT id FROM issue_import WHERE suit_barcode = ? AND insert_time = ?', [r.SUIT_BARCODE, r.INSERT_TIME]);
      if (exists) continue; // ORA-02: each row exactly once
      const { issuedAt, recordedAt, issuedDay } = issueTimes(r.INSERT_TIME, r.RECTIME);
      const cls: Classification = await classifyIssue(conn, ctx, {
        suit_type: r.SUIT_TYPE, suit_color: r.SUIT_COLOR, suit_size: r.SUIT_SIZE, suit_level: r.SUIT_LEVEL, issued_at: issuedAt,
      });
      const ins = await exec(
        conn,
        `INSERT INTO issue_import (suit_barcode, insert_time, rectime, suit_type, suit_color, suit_size, suit_level,
           issued_at, recorded_at, issued_day, location_id, stock_item_id, quality, status, sync_run_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.SUIT_BARCODE, r.INSERT_TIME, r.RECTIME, r.SUIT_TYPE, r.SUIT_COLOR, r.SUIT_SIZE, r.SUIT_LEVEL,
          issuedAt, recordedAt, issuedDay, cls.locationId, cls.stockItemId, cls.quality, cls.status, runId],
      );
      c.new++;
      c.byStatus[cls.status] = (c.byStatus[cls.status] ?? 0) + 1;
      if (cls.quality === 'incomplete') c.incomplete++;
      if (!c.minDay || issuedDay < c.minDay) c.minDay = issuedDay;
      if (!c.maxDay || issuedDay > c.maxDay) c.maxDay = issuedDay;
      if (cls.status === 'applied') {
        movements.push({ stockItemId: cls.stockItemId!, delta: -1, at: issuedAt, kind: 'issue', issueImportId: ins.insertId });
      }
      // ORA-13: RECTIME before the scan (beyond tolerance) or a scan in the future
      const gapMs = recordedAt.getTime() - issuedAt.getTime();
      const future = issuedAt.getTime() > now.getTime() + tolMs;
      if (gapMs < -tolMs || future) {
        c.timeCheckFailed++;
        c.timeAlerts.push({
          barcode: r.SUIT_BARCODE, level: r.SUIT_LEVEL, insertTime: r.INSERT_TIME, rectime: r.RECTIME,
          gapHours: Math.round((gapMs / 3_600_000) * 100) / 100, futureScan: future,
        });
      }
    }
    await noteValuesSeen(conn, seen, now);
    await applyMovements(conn, movements);
  });
}

async function startRun(kind: RunSummary['kind']): Promise<number> {
  const r = await exec(getPool(), 'INSERT INTO sync_run (kind, started_at) VALUES (?, ?)', [kind, new Date()]);
  return r.insertId;
}

async function finishRun(runId: number, kind: RunSummary['kind'], c: Counters, error?: unknown): Promise<RunSummary> {
  await exec(
    getPool(),
    `UPDATE sync_run SET finished_at = ?, rows_read = ?, rows_new = ?, rows_applied = ?, rows_held = ?, rows_ignored = ?,
       rows_before_start = ?, rows_incomplete = ?, rows_time_check_failed = ?, first_issued_day = ?, last_issued_day = ?,
       status = ?, error = ? WHERE id = ?`,
    [new Date(), c.read, c.new, c.byStatus.applied ?? 0, c.byStatus.held_unmapped ?? 0, c.byStatus.ignored ?? 0,
      c.byStatus.before_start ?? 0, c.incomplete, c.timeCheckFailed, c.minDay ?? null, c.maxDay ?? null,
      error ? 'failed' : 'ok', error ? String((error as Error).stack ?? error) : null, runId],
  );
  if (error) {
    await alert('import_failed', `Issue import (${kind}) failed: ${(error as Error).message ?? error}`, { runId });
  } else if (c.timeAlerts.length) {
    // One alert per run listing every row (ORA-13); backfill only summarises.
    await alert(
      'time_check',
      kind === 'backfill'
        ? `History load: ${c.timeAlerts.length} rows have RECTIME before the scan or a scan in the future`
        : `${c.timeAlerts.length} issue rows have RECTIME before the scan or a scan in the future`,
      kind === 'backfill' ? { runId, count: c.timeAlerts.length, examples: c.timeAlerts.slice(0, 20) } : { runId, rows: c.timeAlerts },
    );
  }
  return {
    runId, kind, read: c.read, new: c.new, byStatus: c.byStatus, incomplete: c.incomplete,
    timeCheckFailed: c.timeCheckFailed, issueDays: c.minDay ? [c.minDay, c.maxDay!] : null,
  };
}

export async function alert(kind: string, message: string, details: unknown): Promise<void> {
  await exec(getPool(), 'INSERT INTO admin_alert (kind, message, details) VALUES (?,?,?)', [kind, message.slice(0, 500), JSON.stringify(details)]);
}

let running = false;

/** Guards against overlapping runs in this process (the scheduler is single-instance). */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw new Error('an import is already running');
  running = true;
  try {
    return await fn();
  } finally {
    running = false;
  }
}

/**
 * Regular import (ORA-03): one query per known SUIT_LEVEL from its own RECTIME watermark,
 * plus discovery of levels without a watermark. Watermarks move only after each batch commits.
 */
export function poll(source: IssueSource, now = new Date(), kind: 'poll' | 'backfill' = 'poll'): Promise<RunSummary> {
  return exclusive(async () => {
    const runId = await startRun(kind);
    const c = newCounters();
    try {
      const overlap = -config.ORACLE_OVERLAP_MINUTES;
      const max = config.ORACLE_MAX_ROWS;
      const marks = await rows<{ suit_level: string; last_rectime: string }>(getPool(), 'SELECT suit_level, last_rectime FROM sync_watermark');
      for (const m of marks) {
        let after: RectimeKey = { rectime: shiftNaive(m.last_rectime, overlap), barcode: '' };
        for (;;) {
          const batch = await source.byLevel(m.suit_level, after, max);
          await importBatch(batch, runId, c, now);
          if (batch.length) await setWatermark(m.suit_level, batch[batch.length - 1].RECTIME);
          if (batch.length < max) break;
          after = keyOf(batch[batch.length - 1]);
        }
      }
      // Discovery: levels GI has never seen, read from the oldest watermark (or the backfill start).
      const known = marks.map((m) => m.suit_level);
      let after: RectimeKey = {
        rectime: known.length ? shiftNaive(marks.map((m) => m.last_rectime).sort()[0], overlap) : config.ORACLE_BACKFILL_FROM,
        barcode: '',
      };
      for (;;) {
        const batch = await source.otherLevels(known, after, max);
        await importBatch(batch, runId, c, now);
        const byLevel = new Map<string, string>();
        for (const r of batch) if (!byLevel.has(r.SUIT_LEVEL) || r.RECTIME > byLevel.get(r.SUIT_LEVEL)!) byLevel.set(r.SUIT_LEVEL, r.RECTIME);
        for (const [lvl, rect] of byLevel) await setWatermark(lvl, rect);
        if (batch.length < max) break;
        after = keyOf(batch[batch.length - 1]);
      }
      return await finishRun(runId, kind, c);
    } catch (err) {
      await finishRun(runId, kind, c, err);
      throw err;
    }
  });
}

async function setWatermark(level: string, rectime: string) {
  await exec(
    getPool(),
    `INSERT INTO sync_watermark (suit_level, last_rectime) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE last_rectime = GREATEST(last_rectime, VALUES(last_rectime))`,
    [level, rectime],
  );
}

/**
 * Daily catch-up sweep (ORA-03a): re-reads every row scanned in the last ORACLE_SWEEP_DAYS,
 * with no upper limit, and imports any the polls missed. Alerts if it found any.
 */
export function sweep(source: IssueSource, now = new Date()): Promise<RunSummary> {
  return exclusive(async () => {
    const runId = await startRun('sweep');
    const c = newCounters();
    try {
      const from = utcToLocal(DateTime.fromJSDate(now).minus({ days: config.ORACLE_SWEEP_DAYS }).toJSDate(), config.ORACLE_INSERT_TIME_ZONE);
      let after: { insertTime: string; barcode: string } | null = null;
      const found: Record<string, unknown>[] = [];
      for (;;) {
        const batch = await source.byInsertTime(from, after, config.ORACLE_MAX_ROWS);
        const before = c.new;
        await importBatch(batch, runId, c, now);
        if (c.new > before) {
          // Which ones were new? Look them up by run id after the batch.
          const fresh = await rows<Record<string, unknown>>(getPool(),
            'SELECT suit_barcode AS barcode, suit_level AS level, insert_time AS insertTime, rectime FROM issue_import WHERE sync_run_id = ? LIMIT 50', [runId]);
          found.splice(0, found.length, ...fresh);
        }
        if (batch.length < config.ORACLE_MAX_ROWS) break;
        const last = batch[batch.length - 1];
        after = { insertTime: last.INSERT_TIME, barcode: last.SUIT_BARCODE };
      }
      const summary = await finishRun(runId, 'sweep', c);
      if (c.new) await alert('sweep_found_rows', `Catch-up sweep found ${c.new} issue rows the regular import missed`, { runId, rows: found });
      return summary;
    } catch (err) {
      await finishRun(runId, 'sweep', c, err);
      throw err;
    }
  });
}

/** Re-classifies rows whose answer may have changed (BUILD_PLAN §3.3); applies new −1 entries. */
export async function reclassify(
  conn: PoolConnection,
  where: string,
  params: unknown[],
  userId: number | null,
  reason: string,
): Promise<number> {
  const ctx = await ClassifyContext.load(conn);
  const candidates = await rows<{
    id: number; suit_type: string; suit_color: string; suit_size: string; suit_level: string; issued_at: string; status: string;
  }>(conn, `SELECT id, suit_type, suit_color, suit_size, suit_level, issued_at, status FROM issue_import WHERE ${where} FOR UPDATE`, params);
  const movements: Movement[] = [];
  let changed = 0;
  for (const r of candidates) {
    const issuedAt = fromDb(r.issued_at);
    const cls = await classifyIssue(conn, ctx, { ...r, issued_at: issuedAt });
    if (cls.status === r.status) continue;
    await exec(conn, 'UPDATE issue_import SET status = ?, quality = ?, location_id = ?, stock_item_id = ? WHERE id = ?',
      [cls.status, cls.quality, cls.locationId, cls.stockItemId, r.id]);
    if (cls.status === 'applied') movements.push({ stockItemId: cls.stockItemId!, delta: -1, at: issuedAt, kind: 'issue', issueImportId: r.id });
    changed++;
  }
  await applyMovements(conn, movements);
  if (changed) {
    await exec(conn, 'INSERT INTO audit_log (user_id, entity, action, after_json) VALUES (?,?,?,?)',
      [userId, 'issue_import', 'reclassify', JSON.stringify({ reason, rows: changed })]);
  }
  return changed;
}

/** Sync status for the "Issues up to HH:MM" stamp and the stale warning (ORA-07). */
export async function syncStatus(now = new Date()) {
  const last = await one<{ finished_at: string; kind: string }>(getPool(),
    "SELECT finished_at, kind FROM sync_run WHERE status = 'ok' AND kind <> 'sweep' ORDER BY finished_at DESC LIMIT 1");
  const latestIssue = await one<{ at: string | null }>(getPool(), 'SELECT MAX(issued_at) AS at FROM issue_import');
  const lastOk = last ? fromDb(last.finished_at) : null;
  const staleAfterMs = 2 * config.ORACLE_POLL_SECONDS * 1000;
  return {
    lastSuccessfulImport: lastOk?.toISOString() ?? null,
    issuesUpTo: latestIssue?.at ? fromDb(latestIssue.at).toISOString() : null,
    stale: !lastOk || now.getTime() - lastOk.getTime() > staleAfterMs,
    pollSeconds: config.ORACLE_POLL_SECONDS,
    nowPhoenix: nowLocal(config.ORACLE_RECTIME_ZONE, now),
  };
}
