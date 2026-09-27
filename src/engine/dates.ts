import type { ISODate } from './types';

/** Calendar-date arithmetic on YYYY-MM-DD strings, done in UTC so time zones never shift a day. */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function toUtc(date: ISODate): number {
  const m = ISO.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtc(ms: number): ISODate {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromUtc(toUtc(date) + days * 86_400_000);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: ISODate): number {
  return new Date(toUtc(date)).getUTCDay();
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** First date on or after `from` that falls on `dow`. */
export function nextWeekday(from: ISODate, dow: number): ISODate {
  const delta = (dow - weekday(from) + 7) % 7;
  return addDays(from, delta);
}

export function todayIso(now: Date = new Date()): ISODate {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function formatDate(date: ISODate | null | undefined): string {
  if (!date || !isIsoDate(date)) return '—';
  const [y, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

/**
 * Parse common human date formats found in payroll exports into ISO:
 * 2026-06-14, 6/14/2026, 06/14/26, 14-Jun-2026, Jun 14, 2026, and Excel serial numbers.
 */
export function parseDateLoose(input: unknown): ISODate | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return fromUtc(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()));
  }
  if (typeof input === 'number' && input > 20000 && input < 80000) {
    // Excel serial date (1900 system).
    return fromUtc(Date.UTC(1899, 11, 30) + Math.round(input) * 86_400_000);
  }
  const s = String(input).trim();
  if (isIsoDate(s)) return s;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return normalizeYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return normalizeYmd(y, Number(m[1]), Number(m[2]));
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})$/.exec(s);
  if (m) {
    const mi = months.indexOf(m[2]!.toLowerCase());
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (mi >= 0) return normalizeYmd(y, mi + 1, Number(m[1]));
  }
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mi = months.indexOf(m[1]!.toLowerCase());
    if (mi >= 0) return normalizeYmd(Number(m[3]), mi + 1, Number(m[2]));
  }
  return null;
}

function normalizeYmd(y: number, mo: number, d: number): ISODate | null {
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}
