import { afterAll, describe, expect, it } from 'vitest';
import { closePool, dbOptions, withNamedLock } from '../src/db.js';
import { config } from '../src/config.js';

afterAll(() => closePool());

describe('named lock (one importer across replicas)', () => {
  it('lets only one caller run at a time, and frees the lock afterwards', async () => {
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = r));
    const first = withNamedLock('test', () => holding.then(() => 'first'));
    await new Promise((r) => setTimeout(r, 100)); // first has the lock now
    expect(await withNamedLock('test', async () => 'second')).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, result: 'first' });
    expect(await withNamedLock('test', async () => 'third')).toEqual({ ran: true, result: 'third' });
  });
});

describe('database settings', () => {
  it('uses MARIADB_HOST / USER / PASSWORD / DATABASE when MARIADB_HOST is set', () => {
    const saved = { ...config };
    Object.assign(config, { MARIADB_HOST: 'db.example.local', MARIADB_PORT: 3307, MARIADB_USER: 'gi', MARIADB_PASSWORD: 'p@ss:w/rd#1', MARIADB_DATABASE: 'gi_test' });
    expect(dbOptions()).toEqual({ host: 'db.example.local', port: 3307, user: 'gi', password: 'p@ss:w/rd#1', database: 'gi_test' });
    Object.assign(config, saved, { MARIADB_HOST: undefined, MARIADB_PASSWORD: undefined });
    expect(dbOptions()).toEqual({ uri: config.MARIADB_URL });
  });
});
