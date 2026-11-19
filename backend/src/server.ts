import { buildApp } from './app.js';
import { config } from './config.js';
import { applyStartupSeeds, migrate } from './migrate.js';
import { startScheduler } from './scheduler.js';

await migrate();
// Test installs: users for dev sign-in, and the mapping for the mock data's codes (both idempotent).
await applyStartupSeeds(config.MARIADB_URL, { devUsers: config.DEV_AUTH, mockMapping: config.ISSUE_SOURCE === 'mock' });
const app = buildApp();
await app.listen({ port: config.PORT, host: '0.0.0.0' });
if (process.env.NO_SCHEDULER !== 'true') startScheduler((m) => app.log.info(m));
