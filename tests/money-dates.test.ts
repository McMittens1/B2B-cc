import { describe, expect, it } from 'vitest';
import { cents, extend, formatMoney, formatRate, parseAmount } from '../src/engine/money';
import { addDays, daysBetween, nextWeekday, parseDateLoose, weekday } from '../src/engine/dates';

describe('money', () => {
  it('multiplies hours by rates without float drift', () => {
    expect(extend(40, 26.85)).toBe(1074);
    expect(extend(37.5, 6.915)).toBe(259.31); // 259.3125
    expect(extend(5, 13.425)).toBe(67.13); // 67.125 rounds half away from zero
    expect(extend(0.1, 0.2)).toBe(0.02);
    expect(extend(1234.25, 99.999)).toBe(123423.77);
  });

  it('rounds cents half away from zero', () => {
    expect(cents(2.675)).toBe(2.68);
    expect(cents(-2.675)).toBe(-2.68);
    expect(cents(1.005)).toBe(1.01);
  });

  it('parses amounts as they appear in payroll exports', () => {
    expect(parseAmount('$1,234.50')).toBe(1234.5);
    expect(parseAmount('(12.00)')).toBe(-12);
    expect(parseAmount('-3.5')).toBe(-3.5);
    expect(parseAmount('.75')).toBe(0.75);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
    expect(parseAmount(42)).toBe(42);
  });

  it('formats money and rates', () => {
    expect(formatMoney(1074)).toBe('$1,074.00');
    expect(formatMoney(-5.5)).toBe('-$5.50');
    expect(formatRate(6.915)).toBe('$6.915');
    expect(formatRate(26.85)).toBe('$26.85');
  });
});

describe('dates', () => {
  it('does calendar arithmetic in UTC', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDays('2026-03-08', 7)).toBe('2026-03-15'); // across US DST change
    expect(daysBetween('2026-07-11', '2026-07-31')).toBe(20);
    expect(weekday('2026-07-11')).toBe(6); // Saturday
    expect(nextWeekday('2026-07-06', 6)).toBe('2026-07-11');
    expect(nextWeekday('2026-07-11', 6)).toBe('2026-07-11');
  });

  it('parses the date formats payroll exports use', () => {
    expect(parseDateLoose('2026-06-14')).toBe('2026-06-14');
    expect(parseDateLoose('6/14/2026')).toBe('2026-06-14');
    expect(parseDateLoose('06/14/26')).toBe('2026-06-14');
    expect(parseDateLoose('14-Jun-2026')).toBe('2026-06-14');
    expect(parseDateLoose('Jun 14, 2026')).toBe('2026-06-14');
    expect(parseDateLoose(46187)).toBe('2026-06-14'); // Excel serial
    expect(parseDateLoose('2/30/2026')).toBeNull();
    expect(parseDateLoose('soon')).toBeNull();
  });
});
