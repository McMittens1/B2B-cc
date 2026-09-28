import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfText, PdfReadError, type PdfReadErrorCode } from '../src/engine/pdf/extract';
import { importPayrollPdf } from '../src/engine/pdf/index';

const opts = { pdfjs };
const template = new Uint8Array(fs.readFileSync('public/forms/wh347-rev2025.pdf'));

async function readError(data: Uint8Array, extra: { maxPages?: number } = {}): Promise<PdfReadError> {
  try {
    await extractPdfText(data, { ...opts, ...extra });
  } catch (err) {
    if (err instanceof PdfReadError) return err;
    throw err;
  }
  throw new Error('expected extractPdfText to fail');
}

/** Assemble a PDF from numbered object bodies, computing the cross-reference table. */
function rawPdf(objects: string[], trailer: string): Uint8Array {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const hex = (seed: number, bytes: number) =>
  Array.from({ length: bytes }, (_, i) => ((seed * 31 + i * 17) % 256).toString(16).padStart(2, '0')).join('');

describe('extractPdfText errors', () => {
  it.each<[string, Uint8Array, PdfReadErrorCode]>([
    ['empty input', new Uint8Array(0), 'empty'],
    ['a text file', new TextEncoder().encode('Name,Hours\nPat,40\n'), 'not-pdf'],
    ['random bytes', Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251), 'not-pdf'],
    ['a PDF header followed by garbage', new TextEncoder().encode('%PDF-1.7\n' + 'garbage '.repeat(200)), 'corrupt'],
  ])('rejects %s', async (_label, data, code) => {
    const err = await readError(data);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PdfReadError');
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(10);
  });

  it('rejects a password-protected PDF', async () => {
    const pdf = rawPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
        `<< /Filter /Standard /V 1 /R 2 /O <${hex(3, 32)}> /U <${hex(5, 32)}> /P -44 >>`,
      ],
      `/Root 1 0 R /Encrypt 4 0 R /ID [<${hex(7, 16)}> <${hex(7, 16)}>]`,
    );
    const err = await readError(pdf);
    expect(err.code).toBe('encrypted');
    expect(err.message).toMatch(/password/);
  });

  it('rejects a document with more pages than allowed', async () => {
    const err = await readError(template, { maxPages: 1 });
    expect(err.code).toBe('too-many-pages');
  });

  it('surfaces read errors from importPayrollPdf as PdfReadError', async () => {
    await expect(importPayrollPdf(new Uint8Array([1, 2, 3]), opts)).rejects.toBeInstanceOf(PdfReadError);
  });

  it('reads what it can from a truncated PDF, or reports it as corrupt', async () => {
    const truncated = template.slice(0, Math.floor(template.byteLength / 3));
    try {
      const text = await extractPdfText(truncated, opts);
      expect(Array.isArray(text.pages)).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(PdfReadError);
      expect((err as PdfReadError).code).toBe('corrupt');
    }
  });
});

describe('extractPdfText', () => {
  it('reads the official blank WH-347', async () => {
    const { pages, hasText } = await extractPdfText(template, opts);
    expect(hasText).toBe(true);
    expect(pages.map((p) => [p.width, p.height])).toEqual([
      [792, 612],
      [792, 612],
    ]);
    const label = pages[0]!.items.find((i) => i.str === 'CERTIFIED PAYROLL NO.')!;
    expect(label.x).toBeCloseTo(346.8, 0);
    expect(label.y).toBeCloseTo(482.0, 0);
    expect(label.fontSize).toBeCloseTo(9, 0);
    expect(label.angle).toBe(0);
    // Column headings in the worker table are printed sideways.
    const rotated = pages[0]!.items.find((i) => i.str === 'WORKER ENTRY NO.')!;
    expect(Math.abs(rotated.angle)).toBe(90);
  });

  it('reports hasText false for an image-only PDF', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    for (let i = 0; i < 12; i++) page.drawRectangle({ x: 36 + i * 40, y: 400 - i * 12, width: 30, height: 10 });
    const { pages, hasText } = await extractPdfText(await doc.save(), opts);
    expect(hasText).toBe(false);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.items).toEqual([]);
  });

  it('reports text as displayed on a rotated page', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Courier);
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(90));
    // Drawn rotated so it reads left-to-right once the viewer turns the page.
    page.drawText('LANDSCAPE', { x: 612 - 100, y: 50, size: 10, font, rotate: degrees(90) });
    const { pages } = await extractPdfText(await doc.save(), opts);
    expect([pages[0]!.width, pages[0]!.height]).toEqual([792, 612]);
    const item = pages[0]!.items.find((i) => i.str === 'LANDSCAPE')!;
    expect(item.angle).toBe(0);
    expect(item.x).toBeCloseTo(50, 1);
    expect(item.y).toBeCloseTo(100, 1);
    expect(item.monospace).toBe(true);
  });

  it('does not detach or modify the caller\'s bytes', async () => {
    const copy = template.slice();
    await extractPdfText(copy, opts);
    expect(copy.byteLength).toBe(template.byteLength);
    expect(Buffer.from(copy).equals(Buffer.from(template))).toBe(true);
  });
});
