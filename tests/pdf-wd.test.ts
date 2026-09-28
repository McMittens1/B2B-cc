import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfText, type PdfTextItem } from '../src/engine/pdf/extract';
import { wdTextFromPdfFile } from '../src/engine/pdf/index';
import { groupLines, joinRuns, splitWords, wdTextFromPdf } from '../src/engine/pdf/lines';
import { parseWageDetermination } from '../src/engine/wd/parse';
import type { ParsedWageDetermination } from '../src/engine/types';

const opts = { pdfjs };
const load = (name: string) => fs.readFileSync(`fixtures/wd/${name}`, 'utf8');

interface RenderOptions {
  size?: number;
  leading?: number;
  linesPerPage?: number;
  /** Add the date/title header and URL/page footer a browser prints. */
  browserChrome?: boolean;
  marginLeft?: number;
}

/** Lay wage determination text out the way SAM.gov's PDF does: Courier, one text line per printed line. */
async function textToPdf(text: string, o: RenderOptions = {}): Promise<Uint8Array> {
  const size = o.size ?? 9;
  const leading = o.leading ?? 10.5;
  const perPage = o.linesPerPage ?? 66;
  const doc = await PDFDocument.create();
  const courier = await doc.embedFont(StandardFonts.Courier);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const pageCount = Math.ceil(lines.length / perPage);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([612, 792]);
    lines.slice(p * perPage, (p + 1) * perPage).forEach((line, i) => {
      const safe = line.replace(/[^\x20-\x7e]/g, '?');
      if (safe.trim()) page.drawText(safe, { x: o.marginLeft ?? 54, y: 740 - i * leading, size, font: courier });
    });
    if (o.browserChrome) {
      page.drawText('9/27/26, 10:15 AM', { x: 24, y: 774, size: 7, font: helvetica });
      page.drawText('SAM.gov', { x: 290, y: 774, size: 7, font: helvetica });
      page.drawText('https://sam.gov/wage-determination/XX20260047/2', { x: 24, y: 16, size: 7, font: helvetica });
      page.drawText(`${p + 1}/${pageCount}`, { x: 570, y: 16, size: 7, font: helvetica });
    }
  }
  return new Uint8Array(await doc.save());
}

function shape(wd: ParsedWageDetermination) {
  return {
    decisionNumber: wd.decisionNumber,
    decisionDate: wd.decisionDate,
    supersededDecision: wd.supersededDecision,
    state: wd.state,
    counties: wd.counties,
    constructionTypes: wd.constructionTypes,
    modifications: wd.modifications,
    blocks: wd.blocks,
    classifications: wd.classifications,
    warnings: wd.warnings,
  };
}

function withoutLineNumbers(wd: ReturnType<typeof shape>) {
  return {
    ...wd,
    blocks: wd.blocks.map(({ line: _line, ...b }) => b),
    classifications: wd.classifications.map(({ line: _line, ...c }) => c),
  };
}

describe('wdTextFromPdf', () => {
  it('rebuilds sample-modern.txt so the parser reads the same classifications', async () => {
    const txt = load('sample-modern.txt');
    const fromTxt = parseWageDetermination(txt);
    const text = await wdTextFromPdfFile(await textToPdf(txt), opts);
    const fromPdf = parseWageDetermination(text);

    expect(fromTxt.classifications.length).toBeGreaterThan(8);
    expect(fromPdf.classifications.map((c) => [c.label, c.parent, c.baseRate, c.fringe.raw, c.unit, c.executiveOrderFlag])).toEqual(
      fromTxt.classifications.map((c) => [c.label, c.parent, c.baseRate, c.fringe.raw, c.unit, c.executiveOrderFlag]),
    );
    // Line numbers match too: indentation and blank lines were restored exactly.
    expect(shape(fromPdf)).toEqual(shape(fromTxt));
    expect(text.split('\n').map((l) => l.trimEnd())).toEqual(txt.replace(/\n$/, '').split('\n').map((l) => l.trimEnd()));
  });

  it('keeps nesting under a heading ("LABORER" → "GROUP 1") and per-day units', async () => {
    const fromPdf = parseWageDetermination(await wdTextFromPdfFile(await textToPdf(load('sample-modern.txt')), opts));
    const laborer = fromPdf.classifications.filter((c) => c.rateId === 'LABO0265-006');
    expect(laborer.map((c) => c.label)).toEqual(['LABORER — GROUP 1', 'LABORER — GROUP 2']);
    expect(laborer[0]!.baseRate).toBe(26.85);
    expect(laborer[0]!.description).toMatch(/Common or General Laborer/);
    expect(fromPdf.classifications.find((c) => c.rateId === 'SUXX2024-021')!.unit).toBe('day');
  });

  it.each(['wd1.txt', 'wd3.txt', 'wd9.txt'])('round-trips the real multi-page determination %s', async (name) => {
    const txt = load(name);
    const fromTxt = parseWageDetermination(txt);
    const fromPdf = parseWageDetermination(await wdTextFromPdfFile(await textToPdf(txt), opts));
    expect(fromTxt.classifications.length).toBeGreaterThan(10);
    expect(shape(fromPdf)).toEqual(shape(fromTxt));
  });

  it('ignores browser print headers and footers, and a different font size and margin', async () => {
    const txt = load('sample-modern.txt');
    const fromTxt = parseWageDetermination(txt);
    const pdf = await textToPdf(txt, { size: 8, leading: 9.4, linesPerPage: 40, browserChrome: true, marginLeft: 70 });
    const text = await wdTextFromPdfFile(pdf, opts);
    expect(text).not.toMatch(/SAM\.gov|https:|10:15 AM/);
    // A blank line that falls exactly on a page break cannot be seen in the PDF, so line numbers may shift.
    expect(withoutLineNumbers(shape(parseWageDetermination(text)))).toEqual(withoutLineNumbers(shape(fromTxt)));
  });

  it('returns an empty string for a PDF without text', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawRectangle({ x: 10, y: 10, width: 100, height: 100 });
    expect(await wdTextFromPdfFile(await doc.save(), opts)).toBe('');
    expect(wdTextFromPdf([])).toBe('');
  });

  it('lays runs on a character grid', () => {
    const run = (str: string, col: number, y: number): PdfTextItem => ({
      str,
      x: 50 + col * 6,
      y,
      w: str.length * 6,
      h: 10,
      fontSize: 10,
      angle: 0,
      fontName: 'courier',
      monospace: true,
    });
    const text = wdTextFromPdf([
      {
        width: 612,
        height: 792,
        items: [run('LABORER', 0, 700), run('GROUP', 5, 688), run('1....$', 11, 688), run('26.85', 18, 688), run('Note', 0, 652)],
      },
    ]);
    expect(text).toBe('LABORER\n     GROUP 1....$ 26.85\n\n\nNote');
  });

  it('joins runs that meet on the grid and separates runs that overlap', () => {
    const run = (str: string, x: number): PdfTextItem => ({
      str,
      x,
      y: 700,
      w: str.length * 6,
      h: 10,
      fontSize: 10,
      angle: 0,
      fontName: 'courier',
      monospace: true,
    });
    const page = (items: PdfTextItem[]) => ({ width: 612, height: 792, items });
    expect(wdTextFromPdf([page([run('ELECTRI', 50), run('CIAN....$', 92)])])).toBe('ELECTRICIAN....$');
    expect(wdTextFromPdf([page([run('ELECTRICIAN', 50), run('$', 80)])])).toBe('ELECTRICIAN $');
  });
});

describe('line helpers', () => {
  const item = (str: string, x: number, y: number, w = str.length * 5): PdfTextItem => ({
    str,
    x,
    y,
    w,
    h: 9,
    fontSize: 9,
    angle: 0,
    fontName: 'f1',
    monospace: false,
  });

  it('groups runs by baseline and orders them left to right', () => {
    const lines = groupLines([item('world', 60, 100.8), item('Hello', 20, 100), item('Next', 20, 88), item('   ', 90, 100)]);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Next']);
    expect(groupLines([])).toEqual([]);
  });

  it('skips rotated runs', () => {
    const rotated = { ...item('WORKER ENTRY NO.', 56, 336), angle: 90 };
    expect(groupLines([rotated, item('ST', 316, 321)]).map((l) => l.text)).toEqual(['ST']);
  });

  it('joins touching runs without a space', () => {
    expect(joinRuns([item('26.', 10, 0, 15), item('85', 25, 0, 10)])).toBe('26.85');
    expect(joinRuns([item('26.85', 10, 0, 25), item('12.40', 60, 0, 25)])).toBe('26.85 12.40');
  });

  it('splits a merged run into positioned words', () => {
    const words = splitWords(item('  8  10 7.5', 100, 50, 55));
    expect(words.map((w) => [w.str, w.x, w.w])).toEqual([
      ['8', 110, 5],
      ['10', 125, 10],
      ['7.5', 140, 15],
    ]);
    expect(splitWords(item('   ', 0, 0))).toEqual([]);
    expect(splitWords(item('single', 3, 4))).toEqual([item('single', 3, 4)]);
  });
});

describe('extractPdfText on wage determination PDFs', () => {
  it('reports positions in points from the bottom-left', async () => {
    const pdf = await textToPdf(' CARP0187-004 06/01/2025');
    const { pages, hasText } = await extractPdfText(pdf, opts);
    expect(hasText).toBe(true);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.width).toBe(612);
    expect(pages[0]!.height).toBe(792);
    const first = pages[0]!.items.find((i) => i.str.startsWith('CARP'))!;
    expect(first.y).toBeCloseTo(740, 1);
    expect(first.x).toBeCloseTo(54 + 5.4, 1);
    expect(first.fontSize).toBeCloseTo(9, 1);
    expect(first.angle).toBe(0);
  });
});
