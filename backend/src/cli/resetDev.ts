// Drops and recreates the development database with the dev seed. Refuses unless DEV_AUTH=true.
import { config } from '../config.js';
import { migrate, resetDatabase } from '../migrate.js';

if (!config.DEV_AUTH) throw new Error('refusing to reset: DEV_AUTH is not true (is this production?)');
await resetDatabase();
console.log(await migrate(undefined, { seedDev: true }));
