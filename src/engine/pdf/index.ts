import { extractPdfText, type ExtractOptions } from './extract';
import { wdTextFromPdf } from './lines';
import { parseWh347, type Wh347ParseResult } from './wh347-parse';

export { extractPdfText, PdfReadError } from './extract';
export type { ExtractOptions, PdfReadErrorCode, PdfText, PdfTextItem, PdfTextPage, PdfjsModule } from './extract';
export { groupLines, splitWords, wdTextFromPdf } from './lines';
export type { PdfTextLine } from './lines';
export { parseWh347 } from './wh347-parse';
export type { LowConfidence, Wh347Line, Wh347Meta, Wh347ParseResult, Wh347Statement } from './wh347-parse';
export { defaultDays, fillWh347 } from './wh347-fill';
export type { Wh347ApprenticeProgram, Wh347Day, Wh347FillData, Wh347FillWorker, Wh347FringePlan } from './wh347-fill';

export interface PayrollPdfImport extends Wh347ParseResult {
  /** False for scanned or image-only PDFs, which have to be keyed in. */
  hasText: boolean;
  pageCount: number;
}

/**
 * Read a certified payroll PDF: extract its text layer and, when it is the
 * official WH-347 (Rev. January 2025), the header, worker rows and Statement
 * of Compliance. Throws PdfReadError when the file cannot be opened at all.
 */
export async function importPayrollPdf(data: Uint8Array, opts: ExtractOptions = {}): Promise<PayrollPdfImport> {
  const text = await extractPdfText(data, opts);
  return { ...parseWh347(text.pages), hasText: text.hasText, pageCount: text.pages.length };
}

/** Read the text of a wage determination PDF (SAM.gov layout) for src/engine/wd/parse.ts. */
export async function wdTextFromPdfFile(data: Uint8Array, opts: ExtractOptions = {}): Promise<string> {
  const text = await extractPdfText(data, opts);
  return wdTextFromPdf(text.pages);
}
