import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';

/**
 * Text layout for the PDFs a reviewer produces (review worksheet, letters).
 *
 * pdf-lib draws text at a point and nothing more, so this module wraps text, flows it
 * down the page and paginates tables. Documents use only the standard 14 fonts (no font
 * files to ship or embed), which can encode only the WinAnsi character set. Worker
 * names, job titles and notes come from third parties, so every string goes through
 * toWinAnsi() first and generation never throws on an unexpected character.
 */

// ---------------------------------------------------------------------------
// WinAnsi text

/** Code points in Windows-1252 above Latin-1's 0x80–0x9F gap, all present in Helvetica. */
const CP1252_EXTRAS = [
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
];

const WIN_ANSI = new Set<number>(CP1252_EXTRAS);
for (let cp = 0x20; cp <= 0x7e; cp++) WIN_ANSI.add(cp);
for (let cp = 0xa0; cp <= 0xff; cp++) WIN_ANSI.add(cp);

/**
 * Typographic characters rewritten to plain ASCII even when WinAnsi could encode them,
 * so documents read the same in every viewer and in copied text. Keyed by code point.
 */
const REPLACEMENTS = new Map<number, string>([
  // Dashes and minus signs
  ...[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((cp) => [cp, '-'] as const),
  // Quotes, primes and guillemets
  ...[0x2018, 0x2019, 0x201a, 0x201b, 0x2032].map((cp) => [cp, "'"] as const),
  ...[0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb].map((cp) => [cp, '"'] as const),
  // Math signs and arrows
  [0x00d7, 'x'],
  [0x00f7, '/'],
  [0x2044, '/'],
  [0x2215, '/'],
  [0x2265, '>='],
  [0x2264, '<='],
  [0x2260, '!='],
  [0x2248, '~'],
  [0x2192, '->'],
  [0x2190, '<-'],
  [0x2194, '<->'],
  [0x21d2, '=>'],
  // Ellipsis, bullets and symbols
  [0x2026, '...'],
  [0x2022, '-'],
  [0x2023, '-'],
  [0x25cf, '-'],
  [0x2116, 'No.'],
  [0x2713, 'v'],
  [0x2714, 'v'],
  // Letters with neither a WinAnsi form nor an NFKD decomposition
  [0x0131, 'i'],
  [0x0141, 'L'],
  [0x0142, 'l'],
  [0x0110, 'D'],
  [0x0111, 'd'],
  // Tabs and unusual spaces become spaces; invisible characters are dropped
  ...[0x0009, 0x00a0, 0x2007, 0x202f, 0x3000].map((cp) => [cp, ' '] as const),
  ...[0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((cp) => [cp, ''] as const),
]);

/**
 * Rewrite text so pdf-lib's standard fonts can encode every character: typographic
 * punctuation becomes ASCII, accented letters outside WinAnsi lose their accents, control
 * characters are dropped, and anything else becomes "?". Newlines are kept only when
 * asked (the wrapper splits on them); otherwise they become spaces.
 */
export function toWinAnsi(text: string, opts: { keepNewlines?: boolean } = {}): string {
  let out = '';
  for (const ch of String(text ?? '').replace(/\r\n?/g, '\n')) {
    if (ch === '\n') {
      out += opts.keepNewlines ? '\n' : ' ';
      continue;
    }
    const cp = ch.codePointAt(0)!;
    const replaced = REPLACEMENTS.get(cp);
    if (replaced !== undefined) {
      out += replaced;
      continue;
    }
    if (WIN_ANSI.has(cp)) {
      out += ch;
      continue;
    }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    if (cp >= 0x2000 && cp <= 0x200a) {
      out += ' ';
      continue;
    }
    const decomposed = ch.normalize('NFKD').replace(/\p{M}/gu, '');
    const usable = decomposed !== '' && [...decomposed].every((c) => WIN_ANSI.has(c.codePointAt(0)!));
    out += usable ? decomposed : '?';
  }
  return out;
}

/**
 * Break text into lines no wider than `maxWidth` points, measured with the font that
 * will draw it. Explicit newlines start new lines (an empty line is kept as ""); a word
 * wider than the line is broken between characters so nothing ever overflows.
 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const clean = toWinAnsi(text, { keepNewlines: true });
  const width = (s: string) => font.widthOfTextAtSize(s, size);
  const lines: string[] = [];
  for (const paragraph of clean.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (word === '') continue;
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      if (width(word) <= maxWidth) {
        line = word;
        continue;
      }
      for (const ch of word) {
        if (line && width(line + ch) > maxWidth) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Share `available` width between columns given each column's natural width (content on
 * one line) and minimum width (its longest unbreakable word). Columns that fit within an
 * even share keep their natural width; wider ones split what is left. If that would
 * squeeze a column below its minimum, space is shared in proportion to how much each
 * column can shrink. Units are arbitrary (points, twips, characters).
 */
export function fitColumnWidths(natural: readonly number[], minimum: readonly number[], available: number): number[] {
  const n = natural.length;
  if (n === 0) return [];
  const nat = natural.map((w, i) => Math.max(w, minimum[i] ?? 0, 1));
  const min = nat.map((w, i) => Math.min(w, Math.max(minimum[i] ?? 0, 1)));
  const total = nat.reduce((a, b) => a + b, 0);
  if (total <= available) return nat.map((w) => w + ((available - total) * w) / total);
  const fair = available / n;
  const narrowTotal = nat.filter((w) => w <= fair).reduce((a, b) => a + b, 0);
  const wideTotal = total - narrowTotal;
  const widths = nat.map((w) => (w <= fair ? w : ((available - narrowTotal) * w) / wideTotal));
  if (widths.every((w, i) => w >= min[i]! - 1e-6)) return widths;
  const minTotal = min.reduce((a, b) => a + b, 0);
  if (minTotal >= available) return min.map((m) => (m * available) / minTotal);
  const flex = nat.map((w, i) => w - min[i]!);
  const flexTotal = flex.reduce((a, b) => a + b, 0) || 1;
  return min.map((m, i) => m + ((available - minTotal) * flex[i]!) / flexTotal);
}

/** Shorten text with "..." so it fits `maxWidth` on one line. */
export function truncateText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const clean = toWinAnsi(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  const chars = [...clean];
  while (chars.length > 0 && font.widthOfTextAtSize(`${chars.join('').trimEnd()}...`, size) > maxWidth) chars.pop();
  return chars.length ? `${chars.join('').trimEnd()}...` : '';
}

// ---------------------------------------------------------------------------
// Flow layout

export const INK = rgb(0.1, 0.1, 0.12);
export const MUTED = rgb(0.38, 0.38, 0.42);
export const RULE = rgb(0.72, 0.72, 0.75);
export const HEADER_FILL = rgb(0.91, 0.92, 0.94);
export const WHITE = rgb(1, 1, 1);

export type FontStyle = 'regular' | 'bold' | 'oblique';

export interface FlowFonts {
  regular: PDFFont;
  bold: PDFFont;
  oblique: PDFFont;
}

/** A run of text in one style. In a table cell, each run starts on a new line. */
export interface FlowRun {
  text: string;
  style?: FontStyle;
}

export type FlowCell = string | FlowRun[];

export interface FlowColumn {
  header: string;
  /** Share of the table width, relative to the other columns. */
  weight: number;
  align?: 'left' | 'right';
}

export interface FlowTable {
  title?: string;
  /**
   * 'weights' (default) splits the width by column weight; 'auto' sizes columns from
   * their measured content, as a browser would, and ignores the weights.
   */
  layout?: 'weights' | 'auto';
  columns: FlowColumn[];
  rows: FlowCell[][];
  /** A totals row, drawn bold under a heavier rule. */
  footer?: FlowCell[];
  fontSize?: number;
}

export interface TextOptions {
  size?: number;
  style?: FontStyle;
  color?: RGB;
  indent?: number;
  /** Extra indent for continuation lines (numbered or bulleted items). */
  hanging?: number;
  /** Space after the paragraph, in points. */
  after?: number;
  align?: 'left' | 'right' | 'center';
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FlowOptions {
  pageSize: [number, number];
  margins: Margins;
}

export async function embedStandardFonts(doc: PDFDocument): Promise<FlowFonts> {
  const [regular, bold, oblique] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.HelveticaOblique),
  ]);
  return { regular, bold, oblique };
}

interface CellLine {
  text: string;
  style: FontStyle;
}

type RowKind = 'header' | 'body' | 'footer';

/**
 * Lays content out top to bottom, adding pages as needed. Only pages the flow creates
 * are tracked, so it can append a worksheet to someone else's PDF and number just its
 * own pages.
 */
export class PdfFlow {
  readonly pages: PDFPage[] = [];
  y = 0;
  private current: PDFPage | null = null;
  private size: [number, number];
  private readonly margins: Margins;

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: FlowFonts,
    opts: FlowOptions,
  ) {
    this.size = opts.pageSize;
    this.margins = opts.margins;
  }

  font(style: FontStyle = 'regular'): PDFFont {
    return this.fonts[style];
  }

  get page(): PDFPage {
    return this.current ?? this.addPage();
  }

  get left(): number {
    return this.margins.left;
  }

  get width(): number {
    return this.size[0] - this.margins.left - this.margins.right;
  }

  /** Start a new page; `size` also becomes the size of pages added automatically after it. */
  addPage(size?: [number, number]): PDFPage {
    if (size) this.size = size;
    const page = this.doc.addPage(this.size);
    this.pages.push(page);
    this.current = page;
    this.y = this.size[1] - this.margins.top;
    return page;
  }

  /** Space left above the bottom margin on the current page. */
  remaining(): number {
    return this.current ? this.y - this.margins.bottom : 0;
  }

  /** Move to a new page unless `height` points still fit on this one. */
  ensure(height: number): void {
    if (!this.current || this.remaining() < height) this.addPage();
  }

  gap(points: number): void {
    if (this.current) this.y -= points;
  }

  text(text: string, opts: TextOptions = {}): void {
    const size = opts.size ?? 10;
    const font = this.font(opts.style);
    const color = opts.color ?? INK;
    const indent = opts.indent ?? 0;
    const hanging = opts.hanging ?? 0;
    const lineHeight = size * 1.3;
    const lines = wrapText(text, font, size, Math.max(1, this.width - indent - hanging));
    lines.forEach((line, i) => {
      this.ensure(lineHeight);
      if (line !== '') {
        const x0 = this.left + indent + (i > 0 ? hanging : 0);
        const w = font.widthOfTextAtSize(line, size);
        const x =
          opts.align === 'right'
            ? this.left + this.width - w
            : opts.align === 'center'
              ? this.left + (this.width - w) / 2
              : x0;
        this.page.drawText(line, { x, y: this.y - size * 0.9, size, font, color });
      }
      this.y -= lineHeight;
    });
    this.y -= opts.after ?? size * 0.5;
  }

  /** A heading kept on the same page as at least `keepWith` points of what follows. */
  heading(text: string, size = 11.5, keepWith = 40): void {
    const lines = wrapText(text, this.fonts.bold, size, this.width).length;
    this.ensure(lines * size * 1.3 + keepWith);
    this.text(text, { size, style: 'bold', after: size * 0.35 });
  }

  rule(color: RGB = RULE, thickness = 0.75): void {
    this.ensure(6);
    const y = this.y - 2;
    this.page.drawLine({
      start: { x: this.left, y },
      end: { x: this.left + this.width, y },
      thickness,
      color,
    });
    this.y -= 6;
  }

  /** Label / value pairs in two columns, e.g. the worksheet header. */
  keyValues(rows: [string, string][], opts: { labelWidth?: number; size?: number } = {}): void {
    const size = opts.size ?? 9;
    const labelWidth = opts.labelWidth ?? 130;
    const lineHeight = size * 1.3;
    for (const [label, value] of rows) {
      const labelLines = wrapText(label, this.fonts.bold, size, labelWidth - 8);
      const valueLines = wrapText(value || '-', this.fonts.regular, size, Math.max(1, this.width - labelWidth));
      const height = Math.max(labelLines.length, valueLines.length) * lineHeight;
      this.ensure(Math.min(height, lineHeight * 3));
      const n = Math.max(labelLines.length, valueLines.length);
      for (let i = 0; i < n; i++) {
        this.ensure(lineHeight);
        const baseline = this.y - size * 0.9;
        const l = labelLines[i];
        const v = valueLines[i];
        if (l) this.page.drawText(l, { x: this.left, y: baseline, size, font: this.fonts.bold, color: MUTED });
        if (v) this.page.drawText(v, { x: this.left + labelWidth, y: baseline, size, font: this.fonts.regular, color: INK });
        this.y -= lineHeight;
      }
      this.y -= 1.5;
    }
    this.y -= size * 0.5;
  }

  /** Lines of text inside a bordered box, e.g. the review result. */
  banner(runs: FlowRun[], opts: { borderColor: RGB; color?: RGB; size?: number; fill?: RGB }): void {
    const size = opts.size ?? 9.5;
    const pad = 6;
    const lineHeight = size * 1.3;
    const lines: CellLine[] = [];
    for (const run of runs) {
      const style = run.style ?? 'regular';
      for (const text of wrapText(run.text, this.font(style), size, this.width - 2 * pad)) lines.push({ text, style });
    }
    const height = lines.length * lineHeight + 2 * pad;
    this.ensure(Math.min(height + 4, this.size[1] - this.margins.top - this.margins.bottom));
    const top = this.y;
    this.page.drawRectangle({
      x: this.left,
      y: top - height,
      width: this.width,
      height,
      borderColor: opts.borderColor,
      borderWidth: 1.25,
      color: opts.fill,
    });
    lines.forEach((line, i) => {
      if (line.text === '') return;
      this.page.drawText(line.text, {
        x: this.left + pad,
        y: top - pad - i * lineHeight - size * 0.9,
        size,
        font: this.font(line.style),
        color: opts.color ?? INK,
      });
    });
    this.y = top - height - 10;
  }

  /**
   * A table with a shaded header row that repeats on every page. Rows stay together when
   * they fit on one page; a row taller than a whole page is split between lines.
   */
  table(spec: FlowTable): void {
    const size = spec.fontSize ?? 8.5;
    const lineHeight = size * 1.25;
    const padX = 3.5;
    const padY = 2.5;
    const widths = spec.layout === 'auto' ? this.autoWidths(spec, size, padX) : this.weightedWidths(spec);
    const offsets = widths.map((_, i) => widths.slice(0, i).reduce((a, w) => a + w, 0));

    const layoutCell = (cell: FlowCell | undefined, col: number, forced?: FontStyle): CellLine[] => {
      const runs: FlowRun[] = cell === undefined ? [] : typeof cell === 'string' ? [{ text: cell }] : cell;
      const out: CellLine[] = [];
      for (const run of runs) {
        const style = forced ?? run.style ?? 'regular';
        if (run.text === '') continue;
        for (const text of wrapText(run.text, this.font(style), size, Math.max(1, widths[col]! - 2 * padX))) {
          out.push({ text, style });
        }
      }
      return out;
    };
    const layoutRow = (cells: FlowCell[], forced?: FontStyle) => spec.columns.map((_, i) => layoutCell(cells[i], i, forced));

    const header = layoutRow(
      spec.columns.map((c) => c.header),
      'bold',
    );
    const headerHeight = Math.max(1, ...header.map((c) => c.length)) * lineHeight + 2 * padY;
    const pageBody = this.size[1] - this.margins.top - this.margins.bottom;
    const titleHeight = spec.title ? wrapText(spec.title, this.fonts.bold, 10, this.width).length * 13 + 4 : 0;

    const drawRow = (lines: CellLine[][], kind: RowKind) => {
      const total = Math.max(1, ...lines.map((c) => c.length));
      let start = 0;
      while (start < total) {
        const remainingLines = total - start;
        const freshCapacity = Math.floor((pageBody - headerHeight - 2 * padY) / lineHeight);
        let available = Math.floor((this.remaining() - 2 * padY) / lineHeight);
        if (!this.current || (available < remainingLines && (remainingLines <= freshCapacity || available < 1))) {
          this.addPage();
          if (kind !== 'header') drawRow(header, 'header');
          available = Math.floor((this.remaining() - 2 * padY) / lineHeight);
        }
        const take = Math.min(Math.max(available, 1), remainingLines);
        const top = this.y;
        const height = take * lineHeight + 2 * padY;
        if (kind === 'header') {
          this.page.drawRectangle({ x: this.left, y: top - height, width: this.width, height, color: HEADER_FILL });
        }
        if (kind === 'footer') {
          this.page.drawLine({
            start: { x: this.left, y: top },
            end: { x: this.left + this.width, y: top },
            thickness: 1,
            color: INK,
          });
        }
        spec.columns.forEach((column, col) => {
          const cellLines = lines[col] ?? [];
          for (let i = start; i < start + take; i++) {
            const line = cellLines[i];
            if (!line || line.text === '') continue;
            const font = this.font(line.style);
            const w = font.widthOfTextAtSize(line.text, size);
            const x =
              column.align === 'right'
                ? this.left + offsets[col]! + widths[col]! - padX - w
                : this.left + offsets[col]! + padX;
            this.page.drawText(line.text, {
              x,
              y: top - padY - (i - start) * lineHeight - size * 0.9,
              size,
              font,
              color: INK,
            });
          }
        });
        this.page.drawLine({
          start: { x: this.left, y: top - height },
          end: { x: this.left + this.width, y: top - height },
          thickness: kind === 'body' ? 0.4 : 0.75,
          color: kind === 'body' ? RULE : INK,
        });
        this.y = top - height;
        start += take;
        if (start < total) {
          this.addPage();
          if (kind !== 'header') drawRow(header, 'header');
        }
      }
    };

    const firstRow = spec.rows[0] ? layoutRow(spec.rows[0]) : null;
    const firstRowHeight = firstRow ? Math.max(1, ...firstRow.map((c) => c.length)) * lineHeight + 2 * padY : 0;
    this.ensure(Math.min(titleHeight + headerHeight + firstRowHeight, pageBody));
    if (spec.title) this.text(spec.title, { size: 10, style: 'bold', after: 4 });
    drawRow(header, 'header');
    spec.rows.forEach((row, i) => drawRow(i === 0 && firstRow ? firstRow : layoutRow(row), 'body'));
    if (spec.footer) drawRow(layoutRow(spec.footer, 'bold'), 'footer');
    this.y -= 10;
  }

  private weightedWidths(spec: FlowTable): number[] {
    const totalWeight = spec.columns.reduce((a, c) => a + Math.max(0, c.weight), 0) || 1;
    return spec.columns.map((c) => (this.width * Math.max(0, c.weight)) / totalWeight);
  }

  private autoWidths(spec: FlowTable, size: number, padX: number): number[] {
    const measure = (cell: FlowCell | undefined, forced?: FontStyle) => {
      const runs: FlowRun[] = cell === undefined ? [] : typeof cell === 'string' ? [{ text: cell }] : cell;
      let natural = 0;
      let minimum = 0;
      for (const run of runs) {
        const font = this.font(forced ?? run.style);
        for (const line of toWinAnsi(run.text, { keepNewlines: true }).split('\n')) {
          natural = Math.max(natural, font.widthOfTextAtSize(line, size));
          for (const word of line.split(' ')) minimum = Math.max(minimum, font.widthOfTextAtSize(word, size));
        }
      }
      return { natural, minimum };
    };
    const natural: number[] = [];
    const minimum: number[] = [];
    spec.columns.forEach((column, col) => {
      const cells = [
        measure(column.header, 'bold'),
        ...spec.rows.map((r) => measure(r[col])),
        measure(spec.footer?.[col], 'bold'),
      ];
      natural.push(Math.max(...cells.map((c) => c.natural)) + 2 * padX + 1);
      minimum.push(Math.max(...cells.map((c) => c.minimum)) + 2 * padX + 1);
    });
    return fitColumnWidths(natural, minimum, this.width);
  }

  /** Draw a footer line on every page this flow created, with "Page i of n". */
  finish(footerText: string): void {
    const size = 7.5;
    const n = this.pages.length;
    this.pages.forEach((page, i) => {
      const { width } = page.getSize();
      const y = Math.max(12, this.margins.bottom / 2 - size / 2);
      const right = `Page ${i + 1} of ${n}`;
      const rightWidth = this.fonts.regular.widthOfTextAtSize(right, size);
      const available = width - this.margins.left - this.margins.right - rightWidth - 12;
      const left = truncateText(footerText, this.fonts.regular, size, Math.max(1, available));
      page.drawText(left, { x: this.margins.left, y, size, font: this.fonts.regular, color: MUTED });
      page.drawText(right, { x: width - this.margins.right - rightWidth, y, size, font: this.fonts.regular, color: MUTED });
    });
  }
}
