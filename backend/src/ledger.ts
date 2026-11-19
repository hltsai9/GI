import type { PoolConnection } from 'mysql2/promise';
import { exec, rows } from './db.js';
import { siteDay } from './time.js';

export type LedgerKind =
  | 'starting_count'
  | 'delivery'
  | 'delivery_correction'
  | 'issue'
  | 'issue_correction'
  | 'stock_correction';

export interface Movement {
  stockItemId: number;
  delta: number;
  at: Date; // when it happened
  kind: LedgerKind;
  userId?: number; // set for user actions; absent for the Oracle import
  deliveryLineId?: number;
  deliveryCorrectionId?: number;
  issueImportId?: number;
  stockCorrectionId?: number;
}

/**
 * The only way stock changes (BUILD_PLAN §2): locks the affected stock items in id order,
 * appends one ledger entry per movement and updates on_hand, inside the caller's transaction.
 * Returns the new on_hand per stock item.
 */
export async function applyMovements(conn: PoolConnection, movements: Movement[]): Promise<Map<number, number>> {
  const balances = new Map<number, number>();
  if (!movements.length) return balances;
  const ids = [...new Set(movements.map((m) => m.stockItemId))].sort((a, b) => a - b);
  const locked = await rows<{ id: number; on_hand: number }>(
    conn,
    `SELECT id, on_hand FROM stock_item WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`,
    ids,
  );
  for (const r of locked) balances.set(r.id, r.on_hand);
  for (const m of movements) {
    const before = balances.get(m.stockItemId);
    if (before === undefined) throw new Error(`stock item ${m.stockItemId} not found`);
    const after = before + m.delta;
    await exec(
      conn,
      `INSERT INTO ledger_entry (stock_item_id, at, day, kind, delta, qty_before, qty_after, source, user_id,
         delivery_line_id, delivery_correction_id, issue_import_id, stock_correction_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        m.stockItemId, m.at, siteDay(m.at), m.kind, m.delta, before, after,
        m.userId ? 'user' : 'oracle_import', m.userId ?? null,
        m.deliveryLineId ?? null, m.deliveryCorrectionId ?? null, m.issueImportId ?? null, m.stockCorrectionId ?? null,
      ],
    );
    balances.set(m.stockItemId, after);
  }
  for (const [id, onHand] of balances) {
    await exec(conn, 'UPDATE stock_item SET on_hand = ? WHERE id = ?', [onHand, id]);
  }
  return balances;
}

/** Items whose on_hand differs from the sum of their ledger entries (should always be empty). */
export async function invariantViolations(conn: PoolConnection | import('mysql2/promise').Pool) {
  return rows<{ id: number; on_hand: number; ledger_sum: number }>(
    conn,
    `SELECT s.id, s.on_hand, COALESCE(SUM(l.delta), 0) AS ledger_sum
       FROM stock_item s LEFT JOIN ledger_entry l ON l.stock_item_id = s.id
      GROUP BY s.id, s.on_hand
     HAVING s.on_hand <> COALESCE(SUM(l.delta), 0)`,
  );
}
