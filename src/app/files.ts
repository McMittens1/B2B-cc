import { loadBrowserPdfjs } from '../engine/pdf/pdfjs-browser';
import { importPayrollPdf, PdfReadError, wdTextFromPdfFile, type PayrollPdfImport } from '../engine/pdf';

/** Browser-side file helpers: read uploads and route PDFs through the lazily loaded pdf.js. */

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function fileBytes(file: File): Promise<Uint8Array> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; Wagebench accepts files up to 25 MB.`);
  }
  return new Uint8Array(await file.arrayBuffer());
}

export function isPdf(file: File): boolean {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}

/** Explain a PDF problem in terms of what the reviewer can do about it. */
export function explainPdfError(e: unknown): string {
  if (e instanceof PdfReadError) {
    switch (e.code) {
      case 'encrypted':
        return 'The PDF is password-protected. Ask the contractor for an unprotected copy.';
      case 'not-pdf':
        return 'The file is not a PDF.';
      case 'empty':
        return 'The file is empty.';
      case 'too-many-pages':
        return e.message;
      default:
        return 'The PDF could not be read. It may be damaged; ask for a new copy.';
    }
  }
  return (e as Error)?.message ?? String(e);
}

/** Text of a wage determination from a pasted .txt or a SAM.gov PDF. */
export async function readWageDeterminationFile(file: File): Promise<string> {
  if (!isPdf(file)) {
    if (file.size > MAX_FILE_BYTES) throw new Error('That file is too large to be a wage determination.');
    return file.text();
  }
  try {
    const text = await wdTextFromPdfFile(await fileBytes(file), { pdfjs: await loadBrowserPdfjs() });
    if (!text.trim()) throw new Error('The PDF has no readable text (it may be a scan). Copy the text from SAM.gov instead.');
    return text;
  } catch (e) {
    throw new Error(explainPdfError(e));
  }
}

export async function readPayrollPdf(bytes: Uint8Array): Promise<PayrollPdfImport> {
  return importPayrollPdf(bytes, { pdfjs: await loadBrowserPdfjs() });
}
