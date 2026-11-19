import mysql, { type ConnectionOptions, type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { config } from './config.js';

/** Database connection settings: MARIADB_HOST/USER/PASSWORD/… when MARIADB_HOST is set, else MARIADB_URL. */
export function dbOptions(override?: string | ConnectionOptions): ConnectionOptions {
  if (typeof override === 'string') return { uri: override };
  if (override) return override;
  if (config.MARIADB_HOST) {
    return { host: config.MARIADB_HOST, port: config.MARIADB_PORT, user: config.MARIADB_USER, password: config.MARIADB_PASSWORD, database: config.MARIADB_DATABASE };
  }
  return { uri: config.MARIADB_URL };
}

export type Conn = Pool | PoolConnection;

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      ...dbOptions(),
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

/**
 * Runs fn only if this process gets the named MariaDB lock (GET_LOCK), so that with several
 * replicas only one runs it at a time. The lock is held on its own connection and is released
 * automatically if the process dies. Returns { ran: false } when another instance holds it.
 */
export async function withNamedLock<T>(name: string, fn: () => Promise<T>, waitSeconds = 0): Promise<{ ran: true; result: T } | { ran: false }> {
  const conn = await getPool().getConnection();
  try {
    const [r] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(CONCAT(DATABASE(), ?), ?) AS got', [`:${name}`, waitSeconds]);
    if (Number(r[0].got) !== 1) return { ran: false };
    try {
      return { ran: true, result: await fn() };
    } finally {
      await conn.query('SELECT RELEASE_LOCK(CONCAT(DATABASE(), ?))', [`:${name}`]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

/** Readiness: can we reach the database? */
export async function dbReachable(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
