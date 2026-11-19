/** One Oracle issue-table row, as GI reads it. Dates are naive "YYYY-MM-DD HH:mm:ss". */
export interface OracleIssueRow {
  SUIT_BARCODE: string;
  SUIT_TYPE: string;
  SUIT_COLOR: string;
  SUIT_SIZE: string;
  SUIT_LEVEL: string;
  INSERT_TIME: string; // Taipei time: when the barcode was scanned (= issued)
  RECTIME: string; // Phoenix time: when the record was entered into the database
}

export const ISSUE_STATE = 'EMPLOYEE GOWN ISSUE';

/** Keyset position: rows with RECTIME > rectime, or equal RECTIME and SUIT_BARCODE > barcode. */
export interface RectimeKey {
  rectime: string;
  barcode: string;
}

/** Read-only access to the issuing system's issue rows (only STATE = ISSUE_STATE). */
export interface IssueSource {
  /**
   * Rows of one SUIT_LEVEL after a (RECTIME, SUIT_BARCODE) position, ordered by both.
   * Paging on the pair, not RECTIME alone: many rows share a RECTIME second, and a page
   * that ends inside such a group would otherwise skip the rest of it.
   */
  byLevel(level: string, after: RectimeKey, limit: number): Promise<OracleIssueRow[]>;
  /** Same, for levels not in `known` (discovery of new locations). */
  otherLevels(known: string[], after: RectimeKey, limit: number): Promise<OracleIssueRow[]>;
  /** Rows with INSERT_TIME >= from (no upper limit), keyset-paged by (INSERT_TIME, SUIT_BARCODE). */
  byInsertTime(from: string, after: { insertTime: string; barcode: string } | null, limit: number): Promise<OracleIssueRow[]>;
  close(): Promise<void>;
}
