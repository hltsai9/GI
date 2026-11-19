import type { IssueSource, OracleIssueRow } from './source.js';
import { ISSUE_STATE } from './source.js';
import type { Config } from '../config.js';

// Real Oracle access (node-oracledb thin mode: no Instant Client needed). Dates are read
// with TO_CHAR so they arrive as naive strings and GI applies the time zones itself.
const COLS = `SUIT_BARCODE, SUIT_TYPE, SUIT_COLOR, SUIT_SIZE, SUIT_LEVEL,
  TO_CHAR(INSERT_TIME, 'YYYY-MM-DD HH24:MI:SS') AS INSERT_TIME,
  TO_CHAR(RECTIME, 'YYYY-MM-DD HH24:MI:SS') AS RECTIME`;
const D = (b: string) => `TO_DATE(:${b}, 'YYYY-MM-DD HH24:MI:SS')`;
// Keyset position on (RECTIME, SUIT_BARCODE); written so an index on (STATE, SUIT_LEVEL, RECTIME) is used.
const AFTER_KEY = `RECTIME >= ${D('r1')} AND (RECTIME > ${D('r2')} OR SUIT_BARCODE > :bc)`;

export async function createOracleSource(cfg: Config): Promise<IssueSource> {
  const oracledb = (await import('oracledb')).default;
  const pool = await oracledb.createPool({
    user: cfg.ORACLE_USER,
    password: cfg.ORACLE_PASSWORD,
    connectString: cfg.ORACLE_CONNECT_STRING,
    poolMin: 0,
    poolMax: 2,
  });
  const table = cfg.ORACLE_ISSUE_TABLE!; // validated identifier (config.ts)

  async function q(sql: string, binds: Record<string, string | number>): Promise<OracleIssueRow[]> {
    const conn = await pool.getConnection();
    try {
      const r = await conn.execute<OracleIssueRow>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return r.rows ?? [];
    } finally {
      await conn.close();
    }
  }

  return {
    byLevel: (level, after, limit) =>
      q(
        `SELECT ${COLS} FROM ${table} WHERE STATE = :state AND SUIT_LEVEL = :lvl AND ${AFTER_KEY}
          ORDER BY RECTIME, SUIT_BARCODE FETCH FIRST :lim ROWS ONLY`,
        { state: ISSUE_STATE, lvl: level, r1: after.rectime, r2: after.rectime, bc: after.barcode, lim: limit },
      ),
    otherLevels: (known, after, limit) => {
      const binds: Record<string, string | number> = { state: ISSUE_STATE, r1: after.rectime, r2: after.rectime, bc: after.barcode, lim: limit };
      known.forEach((k, i) => (binds[`k${i}`] = k));
      const notIn = known.length ? `AND SUIT_LEVEL NOT IN (${known.map((_, i) => `:k${i}`).join(',')})` : '';
      return q(
        `SELECT ${COLS} FROM ${table} WHERE STATE = :state ${notIn} AND ${AFTER_KEY}
          ORDER BY RECTIME, SUIT_BARCODE FETCH FIRST :lim ROWS ONLY`,
        binds,
      );
    },
    byInsertTime: (from, after, limit) =>
      q(
        `SELECT ${COLS} FROM ${table} WHERE STATE = :state AND INSERT_TIME >= ${D('fromT')}
           ${after ? `AND (INSERT_TIME > ${D('aT')} OR (INSERT_TIME = ${D('aT2')} AND SUIT_BARCODE > :aB))` : ''}
          ORDER BY INSERT_TIME, SUIT_BARCODE FETCH FIRST :lim ROWS ONLY`,
        after
          ? { state: ISSUE_STATE, fromT: from, aT: after.insertTime, aT2: after.insertTime, aB: after.barcode, lim: limit }
          : { state: ISSUE_STATE, fromT: from, lim: limit },
      ),
    close: () => pool.close(0),
  };
}
