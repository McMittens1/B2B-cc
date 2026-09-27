/**
 * Money and hour arithmetic.
 *
 * Wage rates in wage determinations carry up to three decimals (e.g. 6.915) and
 * hours carry up to two. Multiplying floats directly produces drift such as
 * 40 * 26.85 = 1073.9999999. We scale to integers, multiply exactly, and round
 * once, half away from zero, to whole cents.
 */

const RATE_SCALE = 10_000; // supports 4 decimals in rates
const HOUR_SCALE = 1_000; // supports 3 decimals in hours

function scaled(value: number, scale: number): number {
  return Math.round(value * scale);
}

/** hours × rate, rounded to cents. */
export function extend(hours: number, rate: number): number {
  const product = scaled(hours, HOUR_SCALE) * scaled(rate, RATE_SCALE); // units: 1e-7 dollars
  return roundHalfAway(product / (HOUR_SCALE * RATE_SCALE / 100)) / 100;
}

/** Round a dollar amount to cents, half away from zero. */
export function cents(value: number): number {
  return roundHalfAway(value * 100) / 100;
}

/** Round an hourly rate to 4 decimals to remove float noise. */
export function rate(value: number): number {
  return Math.round(value * RATE_SCALE) / RATE_SCALE;
}

function roundHalfAway(x: number): number {
  // Guard against representation error just below .5 (e.g. 2.675 * 100 = 267.49999999999997)
  const nudged = x + Math.sign(x) * 1e-9;
  return Math.sign(nudged) * Math.round(Math.abs(nudged));
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function sumCents(values: readonly number[]): number {
  return cents(sum(values.map((v) => cents(v))));
}

export function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(cents(value));
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format an hourly rate, keeping a third decimal when the WD specifies one. */
export function formatRate(value: number): string {
  const r = rate(value);
  const decimals = Math.round(r * 1000) % 10 !== 0 ? 3 : 2;
  return `$${r.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatHours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

/** Parse a money-ish string like "$1,234.50", "(12.00)", "12.5" into a number, or null. */
export function parseAmount(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).trim();
  if (s === '' || s === '-' || s === '—') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}
