import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISSUE_STATE, type IssueSource, type OracleIssueRow, type RectimeKey } from './source.js';
import { nowLocal } from '../time.js';
import { config } from '../config.js';

/** A row of the mock Oracle table, plus when it becomes visible in the "database". */
export interface MockRow extends OracleIssueRow {
  STATE: string;
  /** Phoenix local time the row is committed; before this it is invisible (simulates late entry). */
  VISIBLE_AT: string;
}

/**
 * Behaves like the Oracle issue table for the queries GI runs (see oracleSource.ts),
 * including rows that only appear later (records entered up to ~15 h after the scan)
 * and RECTIME that is only in order within a location.
 */
export class MockIssueSource implements IssueSource {
  constructor(
    private readonly data: MockRow[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  static fromDir(dir = config.MOCK_ORACLE_DIR): MockIssueSource {
    const text = readFileSync(join(dir, 'issues.ndjson'), 'utf8');
    const data = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as MockRow);
    return new MockIssueSource(data);
  }

  private visible(): MockRow[] {
    const nowPhx = nowLocal(config.ORACLE_RECTIME_ZONE, this.now());
    return this.data.filter((r) => r.STATE === ISSUE_STATE && r.VISIBLE_AT <= nowPhx);
  }

  async byLevel(level: string, after: RectimeKey, limit: number) {
    return strip(
      this.visible()
        .filter((r) => r.SUIT_LEVEL === level && afterKey(r, after))
        .sort((a, b) => cmp(a.RECTIME, b.RECTIME) || cmp(a.SUIT_BARCODE, b.SUIT_BARCODE))
        .slice(0, limit),
    );
  }

  async otherLevels(known: string[], after: RectimeKey, limit: number) {
    return strip(
      this.visible()
        .filter((r) => !known.includes(r.SUIT_LEVEL) && afterKey(r, after))
        .sort((a, b) => cmp(a.RECTIME, b.RECTIME) || cmp(a.SUIT_BARCODE, b.SUIT_BARCODE))
        .slice(0, limit),
    );
  }

  async byInsertTime(from: string, after: { insertTime: string; barcode: string } | null, limit: number) {
    return strip(
      this.visible()
        .filter((r) => r.INSERT_TIME >= from)
        .filter((r) => !after || r.INSERT_TIME > after.insertTime || (r.INSERT_TIME === after.insertTime && r.SUIT_BARCODE > after.barcode))
        .sort((a, b) => cmp(a.INSERT_TIME, b.INSERT_TIME) || cmp(a.SUIT_BARCODE, b.SUIT_BARCODE))
        .slice(0, limit),
    );
  }

  async close() {}
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const afterKey = (r: OracleIssueRow, k: RectimeKey) => r.RECTIME > k.rectime || (r.RECTIME === k.rectime && r.SUIT_BARCODE > k.barcode);

function strip(rs: MockRow[]): OracleIssueRow[] {
  return rs.map(({ SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL, INSERT_TIME, RECTIME }) => ({
    SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL, INSERT_TIME, RECTIME,
  }));
}
