import { isIsoDate, parseDateLoose } from '../dates';
import { parseAmount } from '../money';
import type { ISODate } from '../types';

/**
 * Cell-level parsing shared by the tabular importers. Spreadsheet cells arrive as
 * strings (CSV), or as numbers, booleans and Date objects (XLSX), so every helper
 * accepts `unknown` and never throws.
 */

/** Display text of a cell: trimmed, inner whitespace collapsed, dates as ISO. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return cellDate(value) ?? '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  return '';
}

export function isBlankCell(value: unknown): boolean {
  return cellText(value) === '';
}

export function isBlankRow(row: readonly unknown[] | undefined): boolean {
  return !row || row.every(isBlankCell);
}

/**
 * A calendar date from a cell. XLSX readers hand back dates at UTC midnight, so
 * Date objects are read in UTC (reading local components shifts the day west of
 * Greenwich). A one-second nudge absorbs serial-number rounding like 23:59:59.999.
 */
export function cellDate(value: unknown): ISODate | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) return null;
    const d = new Date(ms + 1000);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    return parseDateLoose(s) ?? findDates(s).at(-1) ?? null;
  }
  return parseDateLoose(value);
}

export interface ParsedNumber {
  value: number | null;
  /** The cell held text that is not a number (as opposed to being blank). */
  invalid: boolean;
}

const BLANKISH = /^(?:-+|—|–|n\/?a|none|null|\.)$/i;

/**
 * Parse an hours or money cell. Accepts "$1,234.50", "(12.00)", "8:30" (h:mm),
 * trailing units ("40 hrs", "$26.85/hr") and European decimal commas ("26,85")
 * when the comma cannot be a thousands separator.
 */
export function parseNumberCell(value: unknown): ParsedNumber {
  if (value === null || value === undefined) return { value: null, invalid: false };
  if (typeof value === 'number') return Number.isFinite(value) ? { value, invalid: false } : { value: null, invalid: true };
  if (typeof value === 'boolean' || value instanceof Date) return { value: null, invalid: true };
  let s = String(value).trim();
  if (s === '' || BLANKISH.test(s)) return { value: null, invalid: false };
  s = s
    .replace(/^usd\s*/i, '')
    .replace(/\s*(?:\/\s*(?:hr|hour|h)|per\s+hour|hrs?\.?|hours?|h)$/i, '')
    .trim();
  const hm = /^(\d{1,3}):([0-5]\d)$/.exec(s);
  if (hm) return { value: roundHours(Number(hm[1]) + Number(hm[2]) / 60), invalid: false };
  if (/^[-(]?\$?\s*\d{1,3}(?:\.\d{3})*,\d{1,2}\)?$|^[-(]?\$?\s*\d+,\d{1,2}\)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = parseAmount(s);
  return n === null ? { value: null, invalid: true } : { value: n, invalid: false };
}

/** Hours carry at most three decimals; this removes float noise from sums and spreadsheets. */
export function roundHours(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const RANGE_SEP = '\\s*(?:-|–|—|to|through|thru)\\s*';

/**
 * Every full date written in a line of text, in order of appearance, including the
 * end of ranges such as "June 8 - 14, 2026" or "May 31 - June 6, 2026".
 */
export function findDates(text: string): ISODate[] {
  const found: { at: number; iso: ISODate }[] = [];
  const push = (at: number, iso: ISODate | null) => {
    if (iso) found.push({ at, iso });
  };
  const ymd = (y: string, monthName: string, d: string) => {
    const mi = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    return mi < 0 ? null : parseDateLoose(`${y}-${mi + 1}-${d}`);
  };
  const consumed: [number, number][] = [];
  const overlaps = (start: number, end: number) => consumed.some(([a, b]) => start < b && end > a);

  const crossMonth = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?${RANGE_SEP}${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(crossMonth)) {
    push(m.index, ymd(m[5]!, m[1]!, m[2]!));
    push(m.index + m[0].length - 1, ymd(m[5]!, m[3]!, m[4]!));
    consumed.push([m.index, m.index + m[0].length]);
  }
  const sameMonth = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?${RANGE_SEP}(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(sameMonth)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    push(m.index, ymd(m[4]!, m[1]!, m[2]!));
    push(m.index + m[0].length - 1, ymd(m[4]!, m[1]!, m[3]!));
    consumed.push([m.index, m.index + m[0].length]);
  }
  const named = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(named)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    push(m.index, ymd(m[3]!, m[1]!, m[2]!));
  }
  for (const m of text.matchAll(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2}))\b/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    push(m.index, parseDateLoose(m[1]!));
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.iso);
}
