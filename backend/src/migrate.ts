import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/migrate.ts in development, dist/src/migrate.js when compiled: find the db/ folder either way.
const dbDir = [join(here, '..', 'db'), join(here, '..', '..', 'db')].find((d) => existsSync(join(d, 'migrations'))) ?? join(here, '..', 'db');
const migrationsDir = join(dbDir, 'migrations');

/** Applies db/migrations/*.sql in order; optionally the dev seed. */
export async function migrate(url = config.MARIADB_URL, { seedDev = false } = {}): Promise<string[]> {
  const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name VARCHAR(191) PRIMARY KEY, applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB`);
    const [done] = await conn.query<mysql.RowDataPacket[]>('SELECT name FROM schema_migration');
    const applied = new Set(done.map((r) => r.name as string));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      await conn.query(await readFile(join(migrationsDir, f), 'utf8'));
      await conn.query('INSERT INTO schema_migration (name) VALUES (?)', [f]);
      ran.push(f);
    }
    if (seedDev) {
      for (const f of ['seed/dev-users.sql', 'seed/mock-value-map.sql', 'seed-dev.sql']) await conn.query(await readFile(join(dbDir, f), 'utf8'));
    }
    return ran;
  } finally {
    await conn.end();
  }
}

/** Startup seeds for test installs: dev users (DEV_AUTH) and the mock data's value mapping (ISSUE_SOURCE=mock). */
export async function applyStartupSeeds(url: string, opts: { devUsers: boolean; mockMapping: boolean }): Promise<string[]> {
  const files = [...(opts.devUsers ? ['seed/dev-users.sql'] : []), ...(opts.mockMapping ? ['seed/mock-value-map.sql'] : [])];
  if (!files.length) return [];
  const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
  try {
    for (const f of files) await conn.query(await readFile(join(dbDir, f), 'utf8'));
    return files;
  } finally {
    await conn.end();
  }
}

/** Drops every table (tests only). */
export async function resetDatabase(url: string): Promise<void> {
  const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
  try {
    const [tables] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    if (tables.length) {
      await conn.query(
        'SET FOREIGN_KEY_CHECKS = 0; ' + tables.map((r) => `DROP TABLE \`${r.t}\``).join('; ') + '; SET FOREIGN_KEY_CHECKS = 1;',
      );
    }
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const seedDev = process.argv.includes('--seed-dev');
  migrate(config.MARIADB_URL, { seedDev })
    .then((ran) => console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date', seedDev ? '(+ dev seed)' : ''))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
