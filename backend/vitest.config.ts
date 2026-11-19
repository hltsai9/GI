import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one test database, so run files one at a time.
    fileParallelism: false,
    env: { MARIADB_URL: process.env.TEST_MARIADB_URL ?? 'mysql://gi:gi@localhost:3306/gi_test' },
  },
});
