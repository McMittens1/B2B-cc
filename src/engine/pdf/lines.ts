import type { PdfTextItem, PdfTextPage } from './extract';

/** Text runs that share a baseline, left to right. */
export interface PdfTextLine {
  /** Baseline of the first run placed on the line. */
  y: number;
  items: PdfTextItem[];
  text: string;
}

/**
 * Group horizontal text runs into lines. Runs whose baselines differ by no
 * more than `yTolerance` (default: 30% of the median font size) share a line.
 * Rotated runs (vertical column headings) are skipped.
 */
export function groupLines(items: readonly PdfTextItem[], opts: { yTolerance?: number } = {}): PdfTextLine[] {
  const horizontal = items.filter((i) => i.angle === 0 && i.str.trim() !== '');
  if (horizontal.length === 0) return [];
  const tol = opts.yTolerance ?? 0.3 * median(horizontal.map((i) => i.fontSize).filter((s) => s > 0), 10);
  const sorted = [...horizontal].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextLine[] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= tol) last.items.push(item);
    else lines.push({ y: item.y, items: [item], text: '' });
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = joinRuns(line.items);
  }
  return lines;
}

/** Join runs of one line, inserting a space where the gap between runs is wider than a thin space. */
export function joinRuns(items: readonly PdfTextItem[]): string {
  let out = '';
  let end = -Infinity;
  for (const item of items) {
    if (out !== '' && !out.endsWith(' ') && !item.str.startsWith(' ') && item.x - end > 0.2 * (item.fontSize || 1)) {
      out += ' ';
    }
    out += item.str;
    end = item.x + item.w;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Split a run into whitespace-separated words with estimated positions.
 * pdf.js sometimes merges neighbouring cells into one run; splitting lets each
 * word be placed in the column it actually sits in.
 */
export function splitWords(item: PdfTextItem): PdfTextItem[] {
  const str = item.str;
  if (!/\s/.test(str.trim())) {
    const lead = str.length - str.trimStart().length;
    const trimmed = str.trim();
    if (lead === 0 && trimmed.length === str.length) return trimmed ? [item] : [];
    const charW = str.length > 0 ? item.w / str.length : 0;
    return trimmed ? [{ ...item, str: trimmed, x: item.x + lead * charW, w: trimmed.length * charW }] : [];
  }
  const charW = str.length > 0 ? item.w / str.length : 0;
  const words: PdfTextItem[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    words.push({ ...item, str: m[0], x: item.x + m.index * charW, w: m[0].length * charW });
  }
  return words;
}

// ---------------------------------------------------------------------------
// Wage determination text

/**
 * Rebuild the plain text of a wage determination from a PDF of it.
 *
 * SAM.gov publishes wage determinations as fixed-pitch text, and the parser in
 * src/engine/wd/parse.ts relies on indentation (to nest "GROUP 1" under
 * "LABORER") and on blank lines (to separate labels from notes). pdf.js drops
 * leading spaces and splits runs at space gaps, so this lays every run back on
 * a character grid computed from the dominant font's character width, and
 * restores blank lines from the vertical gaps between baselines. Runs in other
 * font sizes (browser print headers and footers) are dropped.
 */
export function wdTextFromPdf(pages: readonly PdfTextPage[]): string {
  const all = pages.flatMap((p) => p.items.filter((i) => i.angle === 0 && i.str.trim() !== ''));
  if (all.length === 0) return '';

  const bodySize = dominantFontSize(all);
  const inBody = (i: PdfTextItem) => Math.abs(i.fontSize - bodySize) <= 0.2 * bodySize;
  const bodyItems = all.filter(inBody);
  const charW = estimateCharWidth(bodyItems, bodySize);

  const normalized = pages.map((p) =>
    p.items
      .filter((i) => i.angle === 0 && i.str.trim() !== '' && inBody(i))
      .map((i) => trimLeading(i, charW)),
  );
  const minX = Math.min(...normalized.flat().map((i) => i.x));
  const pageLines = normalized.map((items) => groupLines(items, { yTolerance: 0.3 * bodySize }));
  const pitch = linePitch(pageLines, bodySize);

  const out: string[] = [];
  for (const lines of pageLines) {
    let prevY: number | null = null;
    for (const line of lines) {
      const text = layoutLine(line.items, minX, charW);
      if (isPrintChrome(text)) continue;
      if (prevY !== null) {
        const blanks = Math.max(0, Math.round((prevY - line.y) / pitch) - 1);
        for (let b = 0; b < Math.min(blanks, 3); b++) out.push('');
      }
      out.push(text);
      prevY = line.y;
    }
  }
  return out.join('\n');
}

function trimLeading(item: PdfTextItem, charW: number): PdfTextItem {
  const lead = item.str.length - item.str.trimStart().length;
  if (lead === 0) return item;
  return { ...item, str: item.str.trimStart(), x: item.x + lead * charW };
}

function layoutLine(items: readonly PdfTextItem[], minX: number, charW: number): string {
  let s = '';
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const col = Math.max(0, Math.round((item.x - minX) / charW));
    if (col > s.length) s += ' '.repeat(col - s.length);
    else if (s.length > 0 && !s.endsWith(' ')) s += ' ';
    s += item.str;
  }
  return s.replace(/\s+$/, '');
}

function dominantFontSize(items: readonly PdfTextItem[]): number {
  const weight = new Map<number, number>();
  for (const i of items) {
    const size = Math.round(i.fontSize * 2) / 2;
    weight.set(size, (weight.get(size) ?? 0) + i.str.trim().length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight) {
      best = size;
      bestWeight = w;
    }
  }
  return best > 0 ? best : 10;
}

function estimateCharWidth(items: readonly PdfTextItem[], fontSize: number): number {
  const widths = items.filter((i) => i.str.length >= 2 && i.w > 0).map((i) => i.w / i.str.length);
  // Courier and other fixed-pitch faces advance 0.6 em per character.
  return median(widths, 0.6 * fontSize) || 0.6 * fontSize;
}

/** Most common baseline-to-baseline distance: the single-spaced line pitch. */
function linePitch(pageLines: readonly PdfTextLine[][], fontSize: number): number {
  const counts = new Map<number, number>();
  for (const lines of pageLines) {
    for (let i = 1; i < lines.length; i++) {
      const d = Math.round((lines[i - 1]!.y - lines[i]!.y) * 10) / 10;
      if (d > 0.5 * fontSize) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount || (c === bestCount && d < best)) {
      best = d;
      bestCount = c;
    }
  }
  return best > 0 ? best : 1.2 * fontSize;
}

const PRINT_CHROME = [
  /^\s*Page\s+\d+\s+of\s+\d+\s*$/i,
  /^\s*\d+\s*\/\s*\d+\s*$/,
  /^\s*https?:\/\/\S+\s*(\d+\s*\/\s*\d+)?\s*$/i,
];

function isPrintChrome(line: string): boolean {
  return PRINT_CHROME.some((re) => re.test(line));
}

function median(values: readonly number[], fallback: number): number {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return fallback;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
