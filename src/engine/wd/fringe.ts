import type { FringeSpec } from '../types';
import { rate } from '../money';

/**
 * Parse the "Fringes" column of a wage determination.
 *
 * Observed forms: "21.45", "6.915", ".15+a", "12.00+a", "3%+21.00", "4%+5.33",
 * "3.5%+3.25", "25%", "8%+3.27+a", "7.455+A&B", "" (survey rates with no fringe).
 */
export function parseFringe(raw: string): FringeSpec {
  const text = raw.trim();
  const spec: FringeSpec = { fixed: 0, percent: 0, footnotes: [], raw: text };
  if (text === '') return spec;
  for (const part of text.split(/[+&,]/)) {
    const token = part.trim();
    if (token === '') continue;
    const pct = /^(\d*\.?\d+)\s*%$/.exec(token);
    if (pct) {
      spec.percent += Number(pct[1]);
      continue;
    }
    const num = /^\$?\s*(\d*\.?\d+)$/.exec(token);
    if (num) {
      spec.fixed += Number(num[1]);
      continue;
    }
    const foot = /^([A-Za-z]{1,3})\.?$/.exec(token);
    if (foot) {
      spec.footnotes.push(foot[1]!.toLowerCase());
      continue;
    }
    // Unknown token: keep it as a footnote so the reviewer sees it.
    spec.footnotes.push(token);
  }
  spec.fixed = rate(spec.fixed);
  return spec;
}

/** Hourly fringe required for a given basic rate (percent fringes are a share of the basic rate). */
export function requiredFringe(spec: FringeSpec, baseRate: number): number {
  return rate(spec.fixed + (spec.percent / 100) * baseRate);
}

export function describeFringe(spec: FringeSpec): string {
  return spec.raw === '' ? '—' : spec.raw;
}
