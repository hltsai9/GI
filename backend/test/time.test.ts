import { describe, expect, it } from 'vitest';
import { issueTimes, localToUtc, siteDay } from '../src/time.js';

describe('Oracle time zones (ORA-12)', () => {
  it('reads INSERT_TIME as Taipei and RECTIME as Phoenix time', () => {
    const { issuedAt, recordedAt } = issueTimes('2026-11-20 09:00:00', '2026-11-19 18:30:00');
    expect(issuedAt.toISOString()).toBe('2026-11-20T01:00:00.000Z');
    expect(recordedAt.toISOString()).toBe('2026-11-20T01:30:00.000Z');
  });

  it('counts an issue on the Phoenix day of the scan, which can differ from the Taipei date', () => {
    // 09:00 on 20 Nov in Taipei is 18:00 on 19 Nov in Phoenix
    expect(issueTimes('2026-11-20 09:00:00', '2026-11-20 03:00:00').issuedDay).toBe('2026-11-19');
    // 15:30 on 20 Nov in Taipei is 00:30 on 20 Nov in Phoenix
    expect(issueTimes('2026-11-20 15:30:00', '2026-11-20 03:00:00').issuedDay).toBe('2026-11-20');
  });

  it('handles both midnights', () => {
    expect(siteDay(localToUtc('2026-11-19 23:59:59', 'America/Phoenix'))).toBe('2026-11-19');
    expect(siteDay(localToUtc('2026-11-20 00:00:00', 'America/Phoenix'))).toBe('2026-11-20');
    expect(issueTimes('2026-11-20 14:59:59', '2026-11-20 00:00:00').issuedDay).toBe('2026-11-19');
    expect(issueTimes('2026-11-20 15:00:00', '2026-11-20 00:00:00').issuedDay).toBe('2026-11-20');
  });

  it('has no daylight-saving jump in either zone', () => {
    // US DST would start 8 Mar 2026; Phoenix does not observe it
    const before = localToUtc('2026-03-07 12:00:00', 'America/Phoenix').getTime();
    const after = localToUtc('2026-03-09 12:00:00', 'America/Phoenix').getTime();
    expect(after - before).toBe(2 * 86_400_000);
  });

  it('rejects malformed dates', () => {
    expect(() => localToUtc('20/11/2026', 'Asia/Taipei')).toThrow();
  });
});
