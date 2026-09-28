import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfFlow, embedStandardFonts, toWinAnsi, wrapText } from '../src/engine/docs/pdf-layout';
import { longDate, maskIdentifier, wdLong, wdShort } from '../src/engine/docs/wording';

const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  // isEvalSupported is gone from pdf.js 6 typings but still passed, for older builds.
  const params = { data: bytes.slice(), isEvalSupported: false, disableFontFace: true, enableXfa: false, verbosity: 0 };
  const task = pdfjs.getDocument(params);
  const doc = await task.promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    out.push(
      content.items
        .map((i) => ('str' in i ? i.str : ''))
        .join(' ')
        .replace(/\s+/g, ' '),
    );
  }
  await task.destroy();
  return out;
}

describe('toWinAnsi', () => {
  it('rewrites typographic punctuation to ASCII', () => {
    expect(toWinAnsi(`a${ch(0x2014)}b${ch(0x2013)}c${ch(0x2212)}d`)).toBe('a-b-c-d');
    expect(toWinAnsi(`${ch(0x201c)}quoted${ch(0x201d)} ${ch(0x2018)}single${ch(0x2019)}`)).toBe('"quoted" \'single\'');
    expect(toWinAnsi(`2.75${ch(0xd7)}40 ${ch(0x2265)} 40 ${ch(0x2264)} 1${ch(0x2026)}`)).toBe('2.75x40 >= 40 <= 1...');
    expect(toWinAnsi(`A${ch(0x2192)}B`)).toBe('A->B');
  });

  it('keeps Latin-1 letters and the middle dot', () => {
    expect(toWinAnsi('José Muñoz · Zoë')).toBe('José Muñoz · Zoë');
  });

  it('strips accents that WinAnsi cannot encode and replaces the rest with "?"', () => {
    expect(toWinAnsi(`Ha${ch(0x0161)}ek Ond${ch(0x0159)}ej`)).toBe('Hašek Ondrej');
    expect(toWinAnsi(`${ch(0x0141)}ukasz`)).toBe('Lukasz');
    expect(toWinAnsi(`${ch(0x738b)} ${ch(0x1f600)}`)).toBe('? ?');
    expect(toWinAnsi(ch(0xfb01))).toBe('fi');
  });

  it('drops control and invisible characters and handles newlines', () => {
    expect(toWinAnsi(`a${ch(0)}b${ch(7)}c${ch(0x200b)}d${ch(0xfeff)}e`)).toBe('abcde');
    expect(toWinAnsi('one\r\ntwo\rthree')).toBe('one two three');
    expect(toWinAnsi('one\r\ntwo', { keepNewlines: true })).toBe('one\ntwo');
    expect(toWinAnsi(`tab\there${ch(0xa0)}nbsp`)).toBe('tab here nbsp');
  });

  it('tolerates null-ish input', () => {
    expect(toWinAnsi(undefined as unknown as string)).toBe('');
    expect(toWinAnsi('')).toBe('');
  });

  it('produces text Helvetica can always encode, whatever the input', async () => {
    const doc = await PDFDocument.create();
    const fonts = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica),
      doc.embedFont(StandardFonts.HelveticaBold),
      doc.embedFont(StandardFonts.HelveticaOblique),
    ]);
    const chunks: string[] = [];
    for (let cp = 0; cp < 0x3100; cp++) if (cp < 0xd800 || cp > 0xdfff) chunks.push(String.fromCodePoint(cp));
    chunks.push(ch(0x1f600, 0x1f4a9, 0x20000, 0xe000, 0xfffd, 0xffff));
    chunks.push('\uD800 lone surrogate');
    const clean = toWinAnsi(chunks.join(''));
    for (const font of fonts) expect(() => font.widthOfTextAtSize(clean, 10)).not.toThrow();
    const page = doc.addPage();
    expect(() => page.drawText(clean.slice(0, 500), { x: 10, y: 10, size: 6, font: fonts[0]! })).not.toThrow();
  });
});

describe('wrapText', () => {
  it('keeps every line within the width and loses no words', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const text =
      'Fringe is owed on all hours worked: $2.40 x 40 hrs = $96.00. Required fringe $12.40/hr (WD "12.40"). Credited $10.00 plan + $0.00 cash.';
    const lines = wrapText(text, font, 9, 150);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(150);
    expect(lines.join(' ')).toBe(text);
  });

  it('breaks a word longer than the line between characters', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const word = 'X'.repeat(300);
    const lines = wrapText(word, font, 10, 100);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join('')).toBe(word);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(100);
  });

  it('keeps explicit and blank lines, and survives degenerate widths', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(wrapText('first\n\nthird', font, 10, 400)).toEqual(['first', '', 'third']);
    expect(wrapText('', font, 10, 400)).toEqual(['']);
    expect(wrapText('abc', font, 10, 0)).toEqual(['a', 'b', 'c']);
    expect(wrapText(`em${ch(0x2014)}dash ${ch(0x738b)}`, font, 10, 400)).toEqual(['em-dash ?']);
  });
});

describe('PdfFlow', () => {
  it('paginates a long table, repeats the header and numbers the pages', async () => {
    const doc = await PDFDocument.create();
    const flow = new PdfFlow(doc, await embedStandardFonts(doc), {
      pageSize: [612, 792],
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
    });
    flow.addPage();
    flow.table({
      title: 'Workers',
      columns: [
        { header: 'Name header', weight: 3 },
        { header: 'Amount header', weight: 1, align: 'right' },
      ],
      rows: Array.from({ length: 150 }, (_, i) => [`Fictional Worker ${i + 1}`, `$${i}.00`]),
      footer: ['Total', '$11,175.00'],
    });
    flow.finish('Test footer');
    const texts = await pageTexts(await doc.save());
    expect(texts.length).toBeGreaterThan(2);
    for (const t of texts) expect(t).toContain('Name header');
    expect(texts.join(' ')).toContain('Fictional Worker 150');
    expect(texts[texts.length - 1]).toContain('Total $11,175.00');
    expect(texts[0]).toContain(`Page 1 of ${texts.length}`);
    expect(texts.filter((t) => t.includes('Workers ')).length).toBe(1);
  });

  it('splits a row taller than a page instead of looping', async () => {
    const doc = await PDFDocument.create();
    const flow = new PdfFlow(doc, await embedStandardFonts(doc), {
      pageSize: [300, 300],
      margins: { top: 30, right: 30, bottom: 30, left: 30 },
    });
    const huge = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    flow.table({ columns: [{ header: 'Detail', weight: 1 }], rows: [[huge], ['after']] });
    const texts = await pageTexts(await doc.save());
    expect(texts.length).toBeGreaterThan(3);
    const all = texts.join(' ');
    expect(all).toContain('word0');
    expect(all).toContain('word399');
    expect(all).toContain('after');
  });

  it('flows long paragraphs across pages', async () => {
    const doc = await PDFDocument.create();
    const flow = new PdfFlow(doc, await embedStandardFonts(doc), {
      pageSize: [612, 792],
      margins: { top: 72, right: 72, bottom: 72, left: 72 },
    });
    flow.text(Array.from({ length: 1500 }, (_, i) => `w${i}`).join(' '), { size: 10 });
    expect(flow.pages.length).toBeGreaterThan(1);
    expect(doc.getPageCount()).toBe(flow.pages.length);
  });
});

describe('wording helpers', () => {
  it('formats wage determination references', () => {
    expect(wdShort('OH20260047', 2)).toBe('WD OH20260047 Mod 2');
    expect(wdShort('OH20260047', 0)).toBe('WD OH20260047 Mod 0');
    expect(wdShort('OH20260047', null)).toBe('WD OH20260047');
    expect(wdShort('  ', 1)).toBeNull();
    expect(wdLong('OH20260047', 2)).toBe('wage determination OH20260047, Modification 2');
    expect(wdLong(null, null)).toBe('the applicable wage determination');
  });

  it('writes long dates and masks full SSNs only', () => {
    expect(longDate('2026-09-28')).toBe('September 28, 2026');
    expect(longDate('not a date')).toBe(formatDash());
    expect(maskIdentifier('123-45-6789')).toBe('***-**-6789');
    expect(maskIdentifier('123456789')).toBe('***-**-6789');
    expect(maskIdentifier('6789')).toBe('6789');
    expect(maskIdentifier('EMP-0042')).toBe('EMP-0042');
  });
});

function formatDash(): string {
  return String.fromCodePoint(0x2014);
}
