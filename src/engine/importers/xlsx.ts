import readXlsxFile, { readSheetNames } from 'read-excel-file/web-worker';
import { findHeaderRow } from './table';

/**
 * Read .xlsx workbooks in the browser and in Node.
 *
 * read-excel-file's "web-worker" entry is used everywhere: it unzips with fflate and
 * parses XML with @xmldom/xmldom, so it needs neither the DOM (the default browser
 * entry uses DOMParser) nor Node streams (the /node entry).
 *
 * Workbooks arrive by email from third parties, and the library inflates every
 * archive entry into memory and allocates the whole used range of a sheet as a
 * dense array. So the archive is checked first: entry count, inflated sizes
 * (measured, not trusted from the header), no encryption, no DTDs, and a bounded
 * sheet area.
 */

export interface SpreadsheetSheet {
  name: string;
  rows: unknown[][];
}

export interface SpreadsheetLimits {
  maxBytes: number;
  maxEntries: number;
  maxEntryUncompressed: number;
  maxTotalUncompressed: number;
  /** Rows × columns of a sheet's used range. */
  maxSheetCells: number;
  maxSheets: number;
}

export const DEFAULT_SPREADSHEET_LIMITS: SpreadsheetLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxEntries: 5_000,
  maxEntryUncompressed: 128 * 1024 * 1024,
  maxTotalUncompressed: 256 * 1024 * 1024,
  maxSheetCells: 5_000_000,
  maxSheets: 30,
};

/** A workbook that cannot or should not be opened; the message is written for the reviewer. */
export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

export interface SpreadsheetReadResult {
  sheets: SpreadsheetSheet[];
  /** Sheets that exist but could not be read (for example chart sheets). */
  warnings: string[];
}

const NOT_XLSX = 'This file is not a valid .xlsx workbook. Save it from Excel as "Excel Workbook (.xlsx)" or as CSV and import it again.';
const CORRUPT = 'The .xlsx file is damaged and cannot be read. Ask the contractor to send it again, or save it as CSV.';

/** Read every sheet of an .xlsx workbook into rows of cell values (string, number, boolean, Date or null). */
export async function readSpreadsheet(
  data: ArrayBuffer | Uint8Array,
  opts: { limits?: Partial<SpreadsheetLimits> } = {},
): Promise<SpreadsheetReadResult> {
  const limits = { ...DEFAULT_SPREADSHEET_LIMITS, ...opts.limits };
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > limits.maxBytes) {
    throw new SpreadsheetError(`The workbook is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB and was not opened.`);
  }
  if (isOleCompoundFile(bytes)) {
    throw new SpreadsheetError(
      'This is an Excel 97-2003 (.xls) workbook or a password-protected workbook. Save it as an unprotected .xlsx workbook or as CSV and import it again.',
    );
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new SpreadsheetError(NOT_XLSX);
  await inspectArchive(bytes, limits);

  const buffer = bytes.slice().buffer;
  let names: string[];
  try {
    names = await readSheetNames(buffer);
  } catch {
    throw new SpreadsheetError(NOT_XLSX);
  }
  const sheets: SpreadsheetSheet[] = [];
  const warnings: string[] = [];
  for (const name of names.slice(0, limits.maxSheets)) {
    try {
      const rows = await readXlsxFile(buffer, { sheet: name });
      sheets.push({ name, rows: rows.map((row) => Array.from(row as unknown[], (v) => (v === undefined ? null : v))) });
    } catch {
      sheets.push({ name, rows: [] });
      warnings.push(`Sheet "${name}" could not be read (it may be a chart sheet).`);
    }
  }
  if (names.length > limits.maxSheets) {
    warnings.push(`Only the first ${limits.maxSheets} of ${names.length} sheets were read.`);
  }
  return { sheets, warnings };
}

const PAYROLL_SHEET = /payroll|wh-?\s?347|certified|register|cpr|wages|week/i;
const OTHER_SHEET = /instruction|note|list|lookup|codes|summary|statement|compliance|signature|page\s*2|rates|wd|setup|help/i;

/**
 * Index of the sheet most likely to hold the payroll lines (the strongest payroll
 * header, nudged by sheet names such as "Payroll" or "Instructions"); -1 when every
 * sheet is empty.
 */
export function pickPayrollSheet(sheets: readonly SpreadsheetSheet[]): number {
  let best = -1;
  let bestScore = -Infinity;
  sheets.forEach((sheet, i) => {
    if (!sheet.rows.some((row) => row.some((v) => v !== null && v !== undefined && String(v).trim() !== ''))) return;
    const strength = findHeaderRow(sheet.rows)?.detection.strength ?? 0;
    let score = strength > 0 ? strength : -1;
    if (PAYROLL_SHEET.test(sheet.name)) score += strength > 0 ? 2 : 0.5;
    if (OTHER_SHEET.test(sheet.name)) score -= strength > 0 ? 3 : 0.5;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Archive checks
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

function isOleCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

function readCentralDirectory(bytes: Uint8Array, limits: SpreadsheetLimits): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpreadsheetError(NOT_XLSX);
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const start = view.getUint32(eocd + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new SpreadsheetError('The workbook uses the ZIP64 format for very large files and was not opened. Save it as CSV instead.');
  }
  if (count > limits.maxEntries) throw new SpreadsheetError('The workbook contains an unusually large number of parts and was not opened.');
  if (start + size > eocd) throw new SpreadsheetError(CORRUPT);

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== 0x02014b50) throw new SpreadsheetError(CORRUPT);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    if (p + 46 + nameLength > eocd) throw new SpreadsheetError(CORRUPT);
    entries.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = entry.offset;
  if (o + 30 > bytes.length || view.getUint32(o, true) !== 0x04034b50) throw new SpreadsheetError(CORRUPT);
  const begin = o + 30 + view.getUint16(o + 26, true) + view.getUint16(o + 28, true);
  const end = begin + entry.compressedSize;
  if (end > bytes.length) throw new SpreadsheetError(CORRUPT);
  return bytes.subarray(begin, end);
}

const WORKSHEET = /^xl\/worksheets\/[^/]+\.xml$/i;
const XML_PART = /\.(?:xml|rels|vml)$/i;
const DIMENSION = /<(?:\w+:)?dimension\s[^>]*?\bref="([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?"/;
const CELL_REF = /<(?:\w+:)?c\s[^>]*?\br="([A-Z]{1,3})(\d{1,7})"/g;

async function inspectArchive(bytes: Uint8Array, limits: SpreadsheetLimits): Promise<void> {
  const entries = readCentralDirectory(bytes, limits);
  if (!entries.some((e) => e.name === 'xl/workbook.xml')) throw new SpreadsheetError(NOT_XLSX);
  let declared = 0;
  for (const entry of entries) {
    if (entry.flags & 0x1) throw new SpreadsheetError('The workbook is encrypted. Ask for an unprotected copy or a CSV export.');
    if (entry.method !== 0 && entry.method !== 8) throw new SpreadsheetError(CORRUPT);
    declared += entry.uncompressedSize;
  }
  if (declared > limits.maxTotalUncompressed) throw tooLarge();

  const canInflate = typeof DecompressionStream === 'function';
  let total = 0;
  for (const entry of entries) {
    const data = entryData(bytes, entry);
    const isXml = XML_PART.test(entry.name);
    const scan = WORKSHEET.test(entry.name) ? new SheetAreaScanner() : null;
    const decoder = new TextDecoder();
    let entrySize = 0;
    let tail = '';
    const onChunk = (chunk: Uint8Array) => {
      entrySize += chunk.length;
      total += chunk.length;
      if (entrySize > limits.maxEntryUncompressed || total > limits.maxTotalUncompressed) throw tooLarge();
      if (!isXml) return;
      const text = decoder.decode(chunk, { stream: true });
      if (/<!(?:DOCTYPE|ENTITY)/i.test(tail + text)) {
        throw new SpreadsheetError('The workbook contains XML document type declarations, which Excel never writes. It was not opened.');
      }
      tail = text.slice(-16);
      scan?.push(text);
    };
    if (entry.method === 0) onChunk(data);
    else if (canInflate) await inflate(data, onChunk);
    if (scan && scan.area() > limits.maxSheetCells) {
      throw new SpreadsheetError(
        `A sheet in this workbook claims ${scan.describe()}, which is too large to open safely. Delete the unused rows and columns in Excel and save again, or export the payroll as CSV.`,
      );
    }
  }
}

/** Inflate a raw-deflate entry chunk by chunk, so size limits apply before the data is all in memory. */
async function inflate(data: Uint8Array, onChunk: (chunk: Uint8Array) => void): Promise<void> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } catch {
    return;
  }
  const reader = stream.getReader();
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new SpreadsheetError(CORRUPT);
      }
      if (result.done) return;
      onChunk(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function tooLarge(): SpreadsheetError {
  return new SpreadsheetError('The workbook expands to more data than a payroll should contain and was not opened. Save it as CSV and import that instead.');
}

/** Tracks the largest row and column a worksheet declares or uses, across streamed text chunks. */
class SheetAreaScanner {
  private carry = '';
  private maxRow = 0;
  private maxCol = 0;
  private dimension: string | null = null;

  push(text: string) {
    const chunk = this.carry + text;
    if (this.dimension === null) {
      const d = DIMENSION.exec(chunk);
      if (d) {
        this.dimension = d[0];
        this.note(d[3] ?? d[1]!, d[4] ?? d[2]!);
      }
    }
    for (const m of chunk.matchAll(CELL_REF)) this.note(m[1]!, m[2]!);
    this.carry = chunk.slice(-256);
  }

  area(): number {
    return this.maxRow * this.maxCol;
  }

  describe(): string {
    return `${this.maxRow.toLocaleString('en-US')} rows × ${this.maxCol.toLocaleString('en-US')} columns`;
  }

  private note(column: string, row: string) {
    let c = 0;
    for (const ch of column) c = c * 26 + (ch.charCodeAt(0) - 64);
    this.maxCol = Math.max(this.maxCol, c);
    this.maxRow = Math.max(this.maxRow, Number(row));
  }
}
