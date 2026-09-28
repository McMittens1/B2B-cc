import type { PayrollSourceKind } from '../types';
import { decodeText, looksLikeUtf16le, parseCsvText } from './csv';
import { emptyTableResult, importPayrollTable, type ImportTableOptions, type TableImportResult } from './table';
import { pickPayrollSheet, readSpreadsheet, SpreadsheetError, type SpreadsheetLimits } from './xlsx';

export * from './columns';
export { parseCsvText, decodeText, guessDelimiter } from './csv';
export { displayName, parsePersonName, splitNameAndId } from './names';
export {
  findHeaderRow,
  importPayrollTable,
  parseApprenticeFlag,
  stripApprentice,
  type ImportTableOptions,
  type PayrollTableMeta,
  type TableImportResult,
} from './table';
export { TEMPLATE_COLUMNS, templateColumnMap, templateCsv, type TemplateColumn } from './template';
export {
  DEFAULT_SPREADSHEET_LIMITS,
  SpreadsheetError,
  pickPayrollSheet,
  readSpreadsheet,
  type SpreadsheetLimits,
  type SpreadsheetSheet,
} from './xlsx';

/**
 * - ok: lines were read (check `warnings`).
 * - no-lines: a header was found but no worker rows under it.
 * - no-header: nothing that looks like payroll columns; offer manual mapping.
 * - empty: the file or every sheet is blank.
 * - unsupported: a format this importer does not read (PDF, .xls, .ods…); `message` says what to do.
 * - error: the file could not be read (damaged, encrypted, too large).
 */
export type ImportStatus = 'ok' | 'no-lines' | 'no-header' | 'empty' | 'unsupported' | 'error';

export interface PayrollFileImportResult extends TableImportResult {
  status: ImportStatus;
  fileName: string;
  /** For `Payroll.source.kind`; null when nothing was read. */
  sourceKind: Extract<PayrollSourceKind, 'csv' | 'xlsx'> | null;
  /** Workbook sheet the lines came from. */
  sheetName: string | null;
  sheetNames: string[];
  /** Why the import did not succeed, written for the reviewer; null when status is ok. */
  message: string | null;
}

export interface ImportFileOptions extends ImportTableOptions {
  /** Read this workbook sheet instead of the one that looks most like a payroll. */
  sheetName?: string;
  limits?: Partial<SpreadsheetLimits>;
}

const TEXT_EXTENSIONS = new Set(['csv', 'txt', 'tsv', 'tab', 'prn']);
const XLSX_EXTENSIONS = new Set(['xlsx', 'xlsm']);

/**
 * Import a payroll file received from a contractor: CSV/TSV/TXT text or an .xlsx
 * workbook, chosen by extension and confirmed by the file's first bytes (payroll
 * systems often save CSV text under an .xls name). PDFs belong to the WH-347 PDF
 * reader and come back as "unsupported". Never throws.
 */
export async function importPayrollFile(name: string, data: Uint8Array, opts: ImportFileOptions = {}): Promise<PayrollFileImportResult> {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? '';
  const sniff = sniffFormat(data);
  const fail = (status: ImportStatus, message: string): PayrollFileImportResult => ({
    ...emptyTableResult([message]),
    status,
    fileName: name,
    sourceKind: null,
    sheetName: null,
    sheetNames: [],
    message,
  });

  try {
    if (data.length === 0 || sniff === 'blank') return fail('empty', 'The file is empty.');
    if (sniff === 'pdf' || ext === 'pdf') {
      return fail('unsupported', 'This is a PDF. PDF payrolls (WH-347 forms) are read by the PDF importer, not the spreadsheet importer.');
    }
    if (sniff === 'ole') {
      return fail(
        'unsupported',
        'This is an Excel 97-2003 (.xls) workbook or a password-protected workbook. Open it in Excel and save it as an unprotected .xlsx workbook or as CSV, then import it again.',
      );
    }
    if (sniff === 'zip') {
      if (ext === 'ods') return fail('unsupported', 'OpenDocument spreadsheets (.ods) are not supported. Save the file as .xlsx or CSV and import it again.');
      if (ext && !XLSX_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext) && ext !== 'xls') {
        return fail('unsupported', `".${ext}" files are not payroll spreadsheets this importer can read. Use .xlsx or CSV.`);
      }
      return await importWorkbook(name, data, opts, fail);
    }
    if (sniff === 'markup') {
      return fail('unsupported', 'This file is a web page or XML export, not a spreadsheet. Save it from Excel as .xlsx or CSV and import it again.');
    }
    if (sniff === 'binary') {
      return fail('unsupported', 'The file is not a spreadsheet or text file this importer can read. Use .xlsx or CSV.');
    }
    if (XLSX_EXTENSIONS.has(ext)) {
      const text = importText(name, data, opts);
      text.warnings.unshift(`"${name}" is named like an Excel workbook but contains plain text; it was read as CSV.`);
      return text;
    }
    return importText(name, data, opts);
  } catch (error) {
    return fail('error', error instanceof SpreadsheetError ? error.message : 'The file could not be read.');
  }
}

function importText(name: string, data: Uint8Array, opts: ImportFileOptions): PayrollFileImportResult {
  const rows = parseCsvText(decodeText(data));
  if (rows.length === 0) {
    return { ...emptyTableResult(['The file is empty.']), status: 'empty', fileName: name, sourceKind: 'csv', sheetName: null, sheetNames: [], message: 'The file is empty.' };
  }
  return withStatus(importPayrollTable(rows, opts), name, 'csv', null, []);
}

async function importWorkbook(
  name: string,
  data: Uint8Array,
  opts: ImportFileOptions,
  fail: (status: ImportStatus, message: string) => PayrollFileImportResult,
): Promise<PayrollFileImportResult> {
  let workbook;
  try {
    workbook = await readSpreadsheet(data, { limits: opts.limits });
  } catch (error) {
    return fail('error', error instanceof SpreadsheetError ? error.message : 'The workbook could not be read.');
  }
  const { sheets } = workbook;
  const warnings = [...workbook.warnings];
  const sheetNames = sheets.map((s) => s.name);
  let index = opts.sheetName !== undefined ? sheets.findIndex((s) => s.name === opts.sheetName) : -1;
  if (opts.sheetName !== undefined && index < 0) warnings.push(`The workbook has no sheet named "${opts.sheetName}".`);
  if (index < 0) index = pickPayrollSheet(sheets);
  const sheet = sheets[index];
  if (!sheet) {
    return { ...fail('empty', 'Every sheet in the workbook is empty.'), sourceKind: 'xlsx', sheetNames };
  }
  if (sheets.length > 1) warnings.push(`Read sheet "${sheet.name}" (${sheets.length} sheets in the workbook).`);
  const result = withStatus(importPayrollTable(sheet.rows, opts), name, 'xlsx', sheet.name, sheetNames);
  result.warnings.unshift(...warnings);
  return result;
}

function withStatus(
  table: TableImportResult,
  fileName: string,
  sourceKind: 'csv' | 'xlsx',
  sheetName: string | null,
  sheetNames: string[],
): PayrollFileImportResult {
  let status: ImportStatus = 'ok';
  let message: string | null = null;
  if (table.headerRowIndex < 0) {
    status = table.warnings[0] === 'The file is empty.' ? 'empty' : 'no-header';
    message = table.warnings[0] ?? 'No payroll columns were recognized.';
  } else if (table.lines.length === 0) {
    status = 'no-lines';
    message = 'A header row was found, but no worker lines below it.';
  }
  return { ...table, status, fileName, sourceKind, sheetName, sheetNames, message };
}

type Sniffed = 'blank' | 'pdf' | 'ole' | 'zip' | 'markup' | 'binary' | 'text';

function sniffFormat(data: Uint8Array): Sniffed {
  if (data.every((b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d)) return 'blank';
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => data[i + k] === b);
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf';
  if (at(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'ole';
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'zip';
  const head = decodeText(data.subarray(0, 512)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (/^<(?:!doctype|html|\?xml|table)/.test(head)) return 'markup';
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff) || looksLikeUtf16le(data)) return 'text';
  const n = Math.min(data.length, 1024);
  let controls = 0;
  for (let i = 0; i < n; i++) {
    const b = data[i]!;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) controls++;
  }
  return controls > n * 0.1 ? 'binary' : 'text';
}
