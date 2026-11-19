import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { startScheduler } from './scheduler.js';

await migrate();
const app = buildApp();
await app.listen({ port: config.PORT, host: '0.0.0.0' });
if (process.env.NO_SCHEDULER !== 'true') startScheduler((m) => app.log.info(m));
