import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { config } from './config.js';

export type Conn = Pool | PoolConnection;

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: config.MARIADB_URL,
      connectionLimit: 10,
      timezone: 'Z', // JS Dates are written and read as UTC
      dateStrings: true, // DATETIME/DATE come back as strings; see time.ts
      multipleStatements: false,
      decimalNumbers: true,
    });
    pool.on('connection', (c) => {
      c.query("SET time_zone = '+00:00'");
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function rows<T>(conn: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await conn.query<RowDataPacket[]>(sql, params);
  return r as T[];
}

export async function one<T>(conn: Conn, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(conn, sql, params))[0];
}

export async function exec(conn: Conn, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await conn.query<ResultSetHeader>(sql, params);
  return r;
}

const DEADLOCK = 1213;
const LOCK_WAIT_TIMEOUT = 1205;

/** Runs fn in a transaction, retrying on InnoDB deadlocks (BUILD_PLAN §2). */
export async function withTx<T>(fn: (conn: PoolConnection) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      const code = (err as { errno?: number }).errno;
      if ((code === DEADLOCK || code === LOCK_WAIT_TIMEOUT) && attempt < attempts) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}
