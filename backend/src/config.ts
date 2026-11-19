import 'dotenv/config';
import { z } from 'zod';

// Oracle identifiers cannot be bind variables, so table names are validated here (ORA-11).
const oracleIdentifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z][A-Za-z0-9_$#]*)?$/, 'must be TABLE or SCHEMA.TABLE');

const schema = z.object({
  MARIADB_URL: z.string().default('mysql://gi:gi@localhost:3306/gi'),
  ISSUE_SOURCE: z.enum(['mock', 'oracle']).default('mock'),
  MOCK_ORACLE_DIR: z.string().default('./mock-oracle/data'),
  ORACLE_CONNECT_STRING: z.string().optional(),
  ORACLE_USER: z.string().optional(),
  ORACLE_PASSWORD: z.string().optional(),
  ORACLE_ISSUE_TABLE: z.string().optional(),
  ORACLE_SUIT_TABLE: z.string().optional(),
  ORACLE_POLL_SECONDS: z.coerce.number().int().min(60).max(43_200).default(300),
  ORACLE_OVERLAP_MINUTES: z.coerce.number().int().min(0).default(10),
  ORACLE_MAX_ROWS: z.coerce.number().int().min(1).default(5000),
  ORACLE_SWEEP_DAYS: z.coerce.number().int().min(1).default(3),
  ORACLE_TIME_TOLERANCE_MINUTES: z.coerce.number().int().min(0).default(10),
  ORACLE_BACKFILL_FROM: z.string().default('2026-10-01 00:00:00'),
  SITE_TIMEZONE: z.string().default('America/Phoenix'),
  ORACLE_INSERT_TIME_ZONE: z.string().default('Asia/Taipei'),
  ORACLE_RECTIME_ZONE: z.string().default('America/Phoenix'),
  PORT: z.coerce.number().int().default(3000),
  DEV_AUTH: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.ISSUE_SOURCE === 'oracle') {
    for (const key of ['ORACLE_CONNECT_STRING', 'ORACLE_USER', 'ORACLE_PASSWORD', 'ORACLE_ISSUE_TABLE'] as const) {
      if (!cfg[key]) throw new Error(`${key} is required when ISSUE_SOURCE=oracle`);
    }
    oracleIdentifier.parse(cfg.ORACLE_ISSUE_TABLE);
    if (cfg.ORACLE_SUIT_TABLE) oracleIdentifier.parse(cfg.ORACLE_SUIT_TABLE);
  }
  return cfg;
}

export const config = loadConfig();
