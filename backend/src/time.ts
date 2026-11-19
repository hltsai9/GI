import { DateTime } from 'luxon';
import { config } from './config.js';

// Oracle DATE columns have no time zone: INSERT_TIME is Taipei time, RECTIME is Phoenix
// time (ORA-12). GI converts them explicitly and stores UTC.

const ORACLE_FMT = 'yyyy-MM-dd HH:mm:ss';

/** Parses a naive "YYYY-MM-DD HH:mm:ss" in the given zone; returns a UTC JS Date. */
export function localToUtc(naive: string, zone: string): Date {
  const dt = DateTime.fromFormat(naive, ORACLE_FMT, { zone });
  if (!dt.isValid) throw new Error(`invalid Oracle date "${naive}": ${dt.invalidExplanation}`);
  return dt.toUTC().toJSDate();
}

/** Formats a UTC instant as a naive local time in the given zone (for Oracle bind values). */
export function utcToLocal(d: Date, zone: string): string {
  return DateTime.fromJSDate(d, { zone }).toFormat(ORACLE_FMT);
}

/** Site-time calendar day (YYYY-MM-DD) of a UTC instant. */
export function siteDay(d: Date, zone = config.SITE_TIMEZONE): string {
  return DateTime.fromJSDate(d, { zone }).toISODate()!;
}

/** Parses a DATETIME string read from MariaDB (stored in UTC). */
export function fromDb(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

export function issueTimes(insertTime: string, rectime: string) {
  const issuedAt = localToUtc(insertTime, config.ORACLE_INSERT_TIME_ZONE);
  const recordedAt = localToUtc(rectime, config.ORACLE_RECTIME_ZONE);
  return { issuedAt, recordedAt, issuedDay: siteDay(issuedAt) };
}

/** Shifts a naive Oracle timestamp by minutes, keeping the naive format. */
export function shiftNaive(naive: string, minutes: number): string {
  return DateTime.fromFormat(naive, ORACLE_FMT, { zone: 'UTC' }).plus({ minutes }).toFormat(ORACLE_FMT);
}

export function nowLocal(zone: string, now = new Date()): string {
  return utcToLocal(now, zone);
}
