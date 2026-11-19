import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db.js';
import { applyStartupSeeds, migrate } from './migrate.js';
import { startScheduler } from './scheduler.js';

await migrate(); // under a database lock, so several replicas can start together
// Test installs: users for dev sign-in, and the mapping for the mock data's codes (both idempotent).
await applyStartupSeeds(undefined, { devUsers: config.DEV_AUTH, mockMapping: config.ISSUE_SOURCE === 'mock' });
const app = buildApp();
await app.listen({ port: config.PORT, host: '0.0.0.0' });
const stopScheduler = process.env.NO_SCHEDULER !== 'true' ? startScheduler((m) => app.log.info(m)) : () => {};

// Kubernetes sends SIGTERM before stopping a pod: finish requests in flight, then exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal}: shutting down`);
    stopScheduler();
    await app.close();
    await closePool();
    process.exit(0);
  });
}
