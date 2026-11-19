import { exec, rows, type Conn } from '../db.js';
import { fromDb } from '../time.js';
import { stockItemId, unregisteredBucket } from '../stockItems.js';

export type IssueStatus = 'applied' | 'held_unmapped' | 'before_start' | 'ignored';
export type Quality = 'complete' | 'incomplete' | 'recovered';
type Column = 'SUIT_TYPE' | 'SUIT_COLOR' | 'SUIT_SIZE' | 'SUIT_LEVEL';

interface MapRow {
  oracle_column: Column;
  oracle_value: string;
  garment_type_id: number | null;
  color_id: number | null;
  size_id: number | null;
  location_id: number | null;
  is_ignored: number;
}

export interface RawIssue {
  suit_type: string;
  suit_color: string;
  suit_size: string;
  suit_level: string;
  issued_at: Date;
}

export interface Classification {
  status: IssueStatus;
  quality: Quality;
  locationId: number | null;
  stockItemId: number | null;
}

/** Everything classifyIssue needs, loaded once per import run or re-classification. */
export class ClassifyContext {
  private constructor(
    private readonly map: Map<string, MapRow>,
    private readonly patterns: Set<string>,
    private readonly startingCounts: Map<number, Date>,
  ) {}

  static async load(conn: Conn): Promise<ClassifyContext> {
    const map = new Map<string, MapRow>();
    for (const r of await rows<MapRow>(conn, 'SELECT * FROM oracle_value_map')) map.set(`${r.oracle_column}|${r.oracle_value}`, r);
    const patterns = new Set(
      (await rows<{ k: string }>(conn, "SELECT CONCAT(suit_type,'|',suit_color,'|',suit_size) k FROM dq_pattern WHERE active")).map((r) => r.k),
    );
    const startingCounts = new Map<number, Date>();
    for (const r of await rows<{ location_id: number; as_of: string }>(conn, 'SELECT location_id, as_of FROM starting_count')) {
      startingCounts.set(r.location_id, fromDb(r.as_of));
    }
    return new ClassifyContext(map, patterns, startingCounts);
  }

  /** Stock item ids already resolved in this context (avoids one query per row). */
  readonly items = new Map<string, number>();

  lookup(column: Column, value: string): MapRow | undefined {
    return this.map.get(`${column}|${value}`);
  }

  isIncomplete(r: RawIssue): boolean {
    return this.patterns.has(`${r.suit_type}|${r.suit_color}|${r.suit_size}`);
  }

  startingCount(locationId: number): Date | undefined {
    return this.startingCounts.get(locationId);
  }
}

const mapped = (m: MapRow | undefined, fk: keyof MapRow) => (m && !m.is_ignored ? (m[fk] as number | null) : null);

/**
 * Decides status, quality and stock item for one issue row (BUILD_PLAN §3.2).
 * Checks run in a fixed order and the first match wins:
 *  a) any value mapped to Ignore      → ignored
 *  b) incomplete (known-bad pattern)  → unregistered bucket of the location (only SUIT_LEVEL must be mapped)
 *     complete                        → all four values must be mapped, else held_unmapped
 *  c) no starting count yet / before it → before_start
 *  d) otherwise                       → applied
 * Creates the stock item if it does not exist yet; never touches the ledger.
 */
export async function classifyIssue(conn: Conn, ctx: ClassifyContext, r: RawIssue): Promise<Classification> {
  const level = ctx.lookup('SUIT_LEVEL', r.suit_level);
  const incomplete = ctx.isIncomplete(r);
  const cols: [Column, string][] = incomplete
    ? [['SUIT_LEVEL', r.suit_level]]
    : [['SUIT_TYPE', r.suit_type], ['SUIT_COLOR', r.suit_color], ['SUIT_SIZE', r.suit_size], ['SUIT_LEVEL', r.suit_level]];
  const quality: Quality = incomplete ? 'incomplete' : 'complete';

  if (cols.some(([c, v]) => ctx.lookup(c, v)?.is_ignored)) return { status: 'ignored', quality, locationId: null, stockItemId: null };

  const locationId = mapped(level, 'location_id');
  if (cols.some(([c, v]) => !isMapped(ctx.lookup(c, v)))) return { status: 'held_unmapped', quality, locationId, stockItemId: null };

  const cacheKey = incomplete ? `U|${locationId}` : `${r.suit_type}|${r.suit_color}|${r.suit_size}|${locationId}`;
  let itemId = ctx.items.get(cacheKey);
  if (itemId === undefined) {
    itemId = incomplete
      ? await unregisteredBucket(conn, locationId!)
      : await stockItemId(conn, {
          garmentTypeId: mapped(ctx.lookup('SUIT_TYPE', r.suit_type), 'garment_type_id')!,
          colorId: mapped(ctx.lookup('SUIT_COLOR', r.suit_color), 'color_id')!,
          sizeId: mapped(ctx.lookup('SUIT_SIZE', r.suit_size), 'size_id')!,
          locationId: locationId!,
        });
    ctx.items.set(cacheKey, itemId);
  }

  const start = ctx.startingCount(locationId!);
  if (!start || r.issued_at < start) return { status: 'before_start', quality, locationId, stockItemId: itemId };
  return { status: 'applied', quality, locationId, stockItemId: itemId };
}

function isMapped(m: MapRow | undefined): boolean {
  if (!m || m.is_ignored) return false;
  return (m.garment_type_id ?? m.color_id ?? m.size_id ?? m.location_id) !== null;
}

/** Records Oracle values seen in a run so unmapped ones appear in Settings › Oracle values (ORA-05). */
export async function noteValuesSeen(conn: Conn, counts: Map<string, number>, at: Date): Promise<void> {
  for (const [key, n] of counts) {
    const [column, value] = key.split('\u0000');
    await exec(
      conn,
      `INSERT INTO oracle_value_map (oracle_column, oracle_value, row_count, first_seen, last_seen) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE row_count = row_count + VALUES(row_count), first_seen = COALESCE(first_seen, VALUES(first_seen)), last_seen = VALUES(last_seen)`,
      [column, value, n, at, at],
    );
  }
}
