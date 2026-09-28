import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import writeXlsxFile from 'write-excel-file/node';
import type { Cell, SheetData } from 'write-excel-file';
import {
  TEMPLATE_COLUMNS,
  decodeText,
  guessDelimiter,
  importPayrollFile,
  parseCsvText,
  pickPayrollSheet,
  readSpreadsheet,
  SpreadsheetError,
  templateColumnMap,
  templateCsv,
  type ImportFileOptions,
} from '../src/engine/importers';
import type { PayrollLine } from '../src/engine/types';

const encode = (text: string) => new TextEncoder().encode(text);
const fixtureText = (name: string) => fs.readFileSync(`fixtures/payrolls/${name}`, 'utf8');

function ids(): ImportFileOptions {
  let n = 0;
  return { idFactory: () => `L${++n}` };
}

const withoutIds = (lines: PayrollLine[]) => lines.map(({ id: _id, ...rest }) => rest);

// ---------------------------------------------------------------------------
// XLSX helpers

/** A spreadsheet cell as Excel would store it: numbers as numbers, dates as dates. */
function toCell(value: unknown): Cell {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return { value, type: Date, format: 'mm/dd/yyyy' };
  if (typeof value === 'number') return { value, type: Number };
  const s = String(value);
  if (/^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d*\.\d+$|^-?\d+$/.test(s) && !/^0\d/.test(s)) return { value: Number(s.replace(/,/g, '')), type: Number };
  return { value: s, type: String };
}

async function xlsx(sheets: { name: string; rows: unknown[][] }[]): Promise<Uint8Array> {
  const data: SheetData[] = sheets.map((s) => s.rows.map((row) => row.map(toCell)));
  const buffer = await writeXlsxFile(data, { buffer: true, sheets: sheets.map((s) => s.name) });
  return new Uint8Array(buffer);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipPart {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  flags?: number;
  /** Uncompressed size to declare (defaults to the real size for stored parts). */
  declaredSize?: number;
  uncompressed?: Uint8Array;
}

/** Hand-built ZIP archive, so the tests can produce workbooks no spreadsheet program would write. */
function zip(parts: ZipPart[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const p of parts) {
    const name = encode(p.name);
    const method = p.method ?? 0;
    const plain = p.uncompressed ?? p.data;
    const crc = crc32(plain);
    const size = p.declaredSize ?? plain.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, p.flags ?? 0, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, p.data.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, p.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, p.flags ?? 0, true);
    entry.setUint16(10, method, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, p.data.length, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + p.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, parts.length, true);
  end.setUint16(10, parts.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const WORKBOOK_PARTS = (sheetXml: string): ZipPart[] => [
  { name: '[Content_Types].xml', data: encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
  { name: 'xl/workbook.xml', data: encode('<?xml version="1.0"?><workbook><sheets><sheet name="Payroll" sheetId="1" r:id="rId1"/></sheets></workbook>') },
  { name: 'xl/_rels/workbook.xml.rels', data: encode('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
  { name: 'xl/worksheets/sheet1.xml', data: encode(sheetXml) },
];

async function expectSpreadsheetError(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SpreadsheetError);
  expect((error as Error).message).toMatch(pattern);
}

// ---------------------------------------------------------------------------

describe('parseCsvText', () => {
  it('handles quoted commas, quotes, embedded line breaks and CRLF', () => {
    expect(parseCsvText('Name,Note\r\n"Doe, Jane","said ""hi""\r\non Monday"\r\n')).toEqual([
      ['Name', 'Note'],
      ['Doe, Jane', 'said "hi"\r\non Monday'],
    ]);
  });

  it('strips a byte-order mark and trailing blank lines, keeps blank lines in between', () => {
    expect(parseCsvText('\uFEFFName,Hours\n\nDoe,40\n\n\n')).toEqual([['Name', 'Hours'], [''], ['Doe', '40']]);
  });

  it('detects semicolon, tab and pipe delimiters even below single-cell title lines', () => {
    expect(guessDelimiter('Ridgeline Concrete LLC\nPayroll Register\nName;Hours;Rate\nDoe;40;26,85\nRoe;38;26,85\n')).toBe(';');
    expect(parseCsvText('Name\tHours\nDoe, Jane\t40\n')).toEqual([['Name', 'Hours'], ['Doe, Jane', '40']]);
    expect(guessDelimiter('A|B|C\n1|2|3\n')).toBe('|');
    expect(guessDelimiter('just one column\nand another\n')).toBe(',');
  });

  it('returns no rows for empty or whitespace-only text', () => {
    expect(parseCsvText('')).toEqual([]);
    expect(parseCsvText(' \r\n\t\n')).toEqual([]);
    expect(parseCsvText('\uFEFF')).toEqual([]);
  });

  it('does not throw on an unterminated quote', () => {
    expect(() => parseCsvText('Name,Hours\n"Doe, Jane,40\n')).not.toThrow();
  });
});

describe('decodeText', () => {
  it('decodes UTF-8 (with or without BOM), UTF-16 and Windows-1252', () => {
    expect(decodeText(encode('\uFEFFRenée'))).toBe('Renée');
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('Name\tJosé').flatMap((ch) => [ch.charCodeAt(0), 0])]);
    expect(decodeText(utf16)).toBe('Name\tJosé');
    const utf16NoBom = new Uint8Array(Array.from('Name,Hours\r\nDoe,40').flatMap((ch) => [ch.charCodeAt(0), 0]));
    expect(decodeText(utf16NoBom)).toBe('Name,Hours\r\nDoe,40');
    expect(decodeText(new Uint8Array([0x52, 0x65, 0x6e, 0xe9, 0x65]))).toBe('Renée');
  });
});

// ---------------------------------------------------------------------------

describe('importPayrollFile', () => {
  it('imports CSV, TSV and TXT files', async () => {
    const csv = await importPayrollFile('register.CSV', encode(fixtureText('quickbooks-register.csv')), ids());
    expect(csv).toMatchObject({ status: 'ok', sourceKind: 'csv', fileName: 'register.CSV', sheetName: null, message: null });
    expect(csv.lines).toHaveLength(3);

    const tsv = await importPayrollFile('p.tsv', encode('Worker Name\tST Hours\tOT Hours\tST Rate\tOT Rate\nNora Pike\t40\t2\t30\t45\n'), ids());
    expect(tsv.lines[0]).toMatchObject({ workerName: 'Nora Pike', totalST: 40, totalOT: 2, rateOT: 45 });

    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('Employee\tHours\tRate\r\nNora Pike\t40\t30\r\n').flatMap((ch) => [ch.charCodeAt(0), 0])]);
    const txt = await importPayrollFile('export.txt', utf16, ids());
    expect(txt.status).toBe('ok');
    expect(txt.lines[0]).toMatchObject({ workerName: 'Nora Pike', totalST: 40, rateST: 30 });
  });

  it('reads a European semicolon export with decimal commas', async () => {
    const r = await importPayrollFile('lohn.csv', encode('Name;Hours;Rate;Gross\n"Pike, Nora";40;30,50;1.220,00\n'), ids());
    expect(r.lines[0]).toMatchObject({ totalST: 40, rateST: 30.5, grossThisProject: 1220 });
  });

  it('returns clear statuses for empty, unsupported and unreadable files', async () => {
    expect((await importPayrollFile('empty.csv', new Uint8Array())).status).toBe('empty');
    expect((await importPayrollFile('blank.csv', encode('  \r\n \n'))).status).toBe('empty');
    expect((await importPayrollFile('bom.csv', encode('\uFEFF'))).status).toBe('empty');

    const pdf = await importPayrollFile('wh347.pdf', encode('%PDF-1.7\n%âãÏÓ\n1 0 obj'));
    expect(pdf.status).toBe('unsupported');
    expect(pdf.message).toMatch(/PDF importer/);
    expect((await importPayrollFile('scan.pdf', encode('not really a pdf'))).status).toBe('unsupported');

    const xls = await importPayrollFile('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    expect(xls.status).toBe('unsupported');
    expect(xls.message).toMatch(/97-2003/);

    const html = await importPayrollFile('export.xls', encode('<html><body><table><tr><td>Name</td></tr></table></body></html>'));
    expect(html.status).toBe('unsupported');
    expect(html.message).toMatch(/web page/);

    const binary = await importPayrollFile('photo.csv', new Uint8Array(Array.from({ length: 600 }, (_, i) => (i * 7) % 32)));
    expect(binary.status).toBe('unsupported');

    const garbageXlsx = await importPayrollFile('payroll.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]));
    expect(garbageXlsx.status).toBe('error');
    expect(garbageXlsx.message).toMatch(/not a valid \.xlsx/);

    const docx = await importPayrollFile('letter.docx', zip([{ name: 'word/document.xml', data: encode('<w:document/>') }]));
    expect(docx.status).toBe('unsupported');

    const ods = await importPayrollFile('payroll.ods', zip([{ name: 'content.xml', data: encode('<office:document/>') }]));
    expect(ods.status).toBe('unsupported');
    expect(ods.message).toMatch(/OpenDocument/);

    for (const r of [pdf, xls, html, binary, garbageXlsx, docx, ods]) {
      expect(r.lines).toEqual([]);
      expect(r.warnings).toEqual([r.message]);
    }
  });

  it('reads plain text saved under an Excel name as CSV', async () => {
    const r = await importPayrollFile('payroll.xlsx', encode('Employee,Hours,Rate\n"Pike, Nora",40,30\n'), ids());
    expect(r.status).toBe('ok');
    expect(r.sourceKind).toBe('csv');
    expect(r.warnings[0]).toMatch(/named like an Excel workbook but contains plain text/);
  });

  it('reports no-header and no-lines results', async () => {
    const noHeader = await importPayrollFile('notes.csv', encode('hello,world\n1,2\n'));
    expect(noHeader.status).toBe('no-header');
    expect(noHeader.message).toMatch(/No header row/);
    const noLines = await importPayrollFile('blank-week.csv', encode('Employee,Hours,Rate\n'));
    expect(noLines.status).toBe('no-lines');
  });

  it('round-trips each CSV fixture through an .xlsx workbook with the same result', async () => {
    for (const name of ['quickbooks-register.csv', 'wh347-2008-layout.csv', 'wh347-2025-layout.csv', 'gusto-payroll.csv']) {
      const text = fixtureText(name);
      const fromCsv = await importPayrollFile(name, encode(text), ids());
      const book = await xlsx([{ name: 'Payroll', rows: parseCsvText(text) }]);
      const fromXlsx = await importPayrollFile(name.replace('.csv', '.xlsx'), book, ids());
      expect(fromXlsx.status, name).toBe('ok');
      expect(fromXlsx.sourceKind).toBe('xlsx');
      expect(fromXlsx.sheetName).toBe('Payroll');
      expect(withoutIds(fromXlsx.lines), name).toEqual(withoutIds(fromCsv.lines));
      expect(fromXlsx.meta, name).toEqual(fromCsv.meta);
    }
  });

  it('keeps leading zeros of a last-four SSN column stored as a number', async () => {
    const book = await xlsx([{ name: 'Sheet1', rows: [['Employee', 'SSN (last 4)', 'Hours', 'Rate'], ['Pike, Nora', 317, 40, 30]] }]);
    const r = await importPayrollFile('p.xlsx', book, ids());
    expect(r.lines[0]!.workerId).toBe('0317');
  });

  describe('in a time zone west of UTC', () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });

    it('reads Date cells and date-formatted headers without shifting a day', async () => {
      process.env.TZ = 'America/Los_Angeles';
      const day = (d: number) => new Date(Date.UTC(2026, 5, d));
      const rows: unknown[][] = [
        ['Contractor: Tamarack Electric Co.'],
        ['Week Ending', day(13)],
        ['Employee', day(7), day(8), day(9), day(10), day(11), day(12), day(13), 'Rate'],
        ['Pike, Nora', 0, 8, 8, 8, 8, 8, 0, 44],
      ];
      const r = await importPayrollFile('p.xlsx', await xlsx([{ name: 'Payroll', rows }]), ids());
      expect(r.meta.weekEnding).toBe('2026-06-13');
      expect(r.meta.dayDates).toEqual(['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13']);
      expect(r.lines[0]).toMatchObject({ dailyST: [0, 8, 8, 8, 8, 8, 0], totalST: 40, rateST: 44 });
      expect(r.warnings).toEqual([]);
    });
  });

  it('picks the payroll sheet in a multi-sheet workbook, or the sheet asked for', async () => {
    const book = await xlsx([
      { name: 'Instructions', rows: [['Fill in one row per worker.'], ['Use the J/A column for apprentices.']] },
      { name: 'Week 23', rows: parseCsvText(fixtureText('wh347-2025-layout.csv')) },
      { name: 'Rates', rows: [['Classification', 'Rate'], ['Carpenter', 33.1]] },
    ]);
    const picked = await importPayrollFile('book.xlsx', book, ids());
    expect(picked.sheetName).toBe('Week 23');
    expect(picked.sheetNames).toEqual(['Instructions', 'Week 23', 'Rates']);
    expect(picked.lines).toHaveLength(3);
    expect(picked.warnings).toContain('Read sheet "Week 23" (3 sheets in the workbook).');

    const asked = await importPayrollFile('book.xlsx', book, { ...ids(), sheetName: 'Rates' });
    expect(asked.sheetName).toBe('Rates');
    expect(asked.status).toBe('no-header');

    const missing = await importPayrollFile('book.xlsx', book, { ...ids(), sheetName: 'Nope' });
    expect(missing.sheetName).toBe('Week 23');
    expect(missing.warnings).toContain('The workbook has no sheet named "Nope".');
  });

  it('reports a workbook whose sheets are all empty', async () => {
    const r = await importPayrollFile('empty.xlsx', await xlsx([{ name: 'Sheet1', rows: [[null]] }]));
    expect(r.status).toBe('empty');
    expect(r.sheetNames).toEqual(['Sheet1']);
  });
});

// ---------------------------------------------------------------------------

describe('readSpreadsheet', () => {
  it('reads every sheet with numbers as numbers and dates as Date objects', async () => {
    const book = await xlsx([
      { name: 'A', rows: [['Name', 'Hours', 'Date'], ['Doe, Jane', 40.5, new Date(Date.UTC(2026, 5, 13))]] },
      { name: 'B', rows: [['x']] },
    ]);
    const { sheets, warnings } = await readSpreadsheet(book);
    expect(warnings).toEqual([]);
    expect(sheets.map((s) => s.name)).toEqual(['A', 'B']);
    expect(sheets[0]!.rows[1]![0]).toBe('Doe, Jane');
    expect(sheets[0]!.rows[1]![1]).toBe(40.5);
    expect(sheets[0]!.rows[1]![2]).toBeInstanceOf(Date);
    const fromBuffer = await readSpreadsheet(book.slice().buffer);
    expect(fromBuffer.sheets).toHaveLength(2);
  });

  it('refuses non-workbooks, old .xls files and encrypted archives', async () => {
    await expectSpreadsheetError(readSpreadsheet(encode('Name,Hours\n')), /not a valid \.xlsx/);
    await expectSpreadsheetError(readSpreadsheet(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /97-2003/);
    await expectSpreadsheetError(readSpreadsheet(zip([{ name: 'readme.txt', data: encode('hi') }])), /not a valid \.xlsx/);
    await expectSpreadsheetError(
      readSpreadsheet(zip(WORKBOOK_PARTS('<worksheet/>').map((p) => (p.name === 'xl/workbook.xml' ? { ...p, flags: 1 } : p)))),
      /encrypted/,
    );
    const truncated = await xlsx([{ name: 'A', rows: [['x']] }]);
    await expectSpreadsheetError(readSpreadsheet(truncated.subarray(0, truncated.length - 30)), /not a valid|damaged/);
  });

  it('refuses a sheet that declares an enormous used range', async () => {
    const sheet = '<?xml version="1.0"?><worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>';
    await expectSpreadsheetError(readSpreadsheet(zip(WORKBOOK_PARTS(sheet))), /1,048,576 rows × 16,384 columns/);
  });

  it('refuses a text file with far more rows than a payroll, without parsing all of it', async () => {
    const text = 'Employee,Hours\n' + 'Doe,8\n'.repeat(25_000);
    const result = await importPayrollFile('huge.csv', new TextEncoder().encode(text));
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/more than 20,000 rows/);
  });

  it('reads the used range however the attribute is quoted or spaced', async () => {
    // Single quotes, spaces around "=" and long row numbers are valid XML and must not slip past the guard.
    for (const dim of [`<dimension ref='A1:Z4000000'/>`, '<dimension ref = "A1:Z4000000"/>', '<dimension ref="A1:Z40000000"/>']) {
      const sheet = `<?xml version="1.0"?><worksheet>${dim}<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`;
      await expectSpreadsheetError(readSpreadsheet(zip(WORKBOOK_PARTS(sheet))), /too large to open safely/);
    }
    const unreadable = '<?xml version="1.0"?><worksheet><dimension ref=A1:Z4000000/><sheetData/></worksheet>';
    await expectSpreadsheetError(readSpreadsheet(zip(WORKBOOK_PARTS(unreadable))), /unreadable size declaration/);
  });

  it('refuses a sheet with a single cell placed far away', async () => {
    const sheet = '<?xml version="1.0"?><worksheet><sheetData><row r="900000"><x:c r="ZZ900000" t="inlineStr"><is><t>x</t></is></x:c></row></sheetData></worksheet>';
    await expectSpreadsheetError(readSpreadsheet(zip(WORKBOOK_PARTS(sheet))), /too large to open safely/);
  });

  it('refuses XML document type declarations (entity expansion)', async () => {
    const sheet = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><worksheet><sheetData/></worksheet>';
    await expectSpreadsheetError(readSpreadsheet(zip(WORKBOOK_PARTS(sheet))), /document type declarations/);
  });

  it('measures inflated size instead of trusting the declared size', async () => {
    const big = new Uint8Array(2_000_000).fill(0x41);
    const compressed = await deflateRaw(big);
    const parts = [...WORKBOOK_PARTS('<worksheet/>'), { name: 'xl/media/image1.png', data: compressed, method: 8 as const, uncompressed: big, declaredSize: 10 }];
    await expectSpreadsheetError(readSpreadsheet(zip(parts), { limits: { maxTotalUncompressed: 1_000_000 } }), /expands to more data/);
    await expectSpreadsheetError(readSpreadsheet(zip(parts), { limits: { maxEntryUncompressed: 500_000 } }), /expands to more data/);
  });

  it('refuses a declared size over the limit before inflating, and damaged compressed data', async () => {
    const parts = WORKBOOK_PARTS('<worksheet/>');
    await expectSpreadsheetError(readSpreadsheet(zip(parts.map((p, i) => (i === 0 ? { ...p, declaredSize: 2 ** 31 } : p)))), /expands to more data/);
    const damaged = [...parts, { name: 'xl/styles.xml', data: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x12]), method: 8 as const, uncompressed: encode('<styleSheet/>') }];
    await expectSpreadsheetError(readSpreadsheet(zip(damaged)), /damaged/);
  });

  it('refuses files over the byte limit', async () => {
    const book = await xlsx([{ name: 'A', rows: [['x']] }]);
    await expectSpreadsheetError(readSpreadsheet(book, { limits: { maxBytes: 100 } }), /larger than/);
  });
});

describe('pickPayrollSheet', () => {
  it('prefers the sheet with the strongest payroll header and a payroll-like name', () => {
    const payrollRows = [['Employee', 'Hours', 'Rate'], ['Pike, Nora', 40, 30]];
    expect(pickPayrollSheet([])).toBe(-1);
    expect(pickPayrollSheet([{ name: 'Sheet1', rows: [] }, { name: 'Sheet2', rows: [[null, '']] }])).toBe(-1);
    expect(pickPayrollSheet([{ name: 'Notes', rows: [['hello']] }, { name: 'Data', rows: payrollRows }])).toBe(1);
    expect(pickPayrollSheet([{ name: 'Instructions', rows: payrollRows }, { name: 'Payroll', rows: payrollRows }])).toBe(1);
    expect(pickPayrollSheet([{ name: 'Only', rows: [['no header here']] }])).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('payroll template', () => {
  it('has one header row and one example row', () => {
    const rows = parseCsvText(templateCsv());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(TEMPLATE_COLUMNS.map((c) => c.header));
    expect(templateCsv().endsWith('\r\n')).toBe(true);
  });

  it('maps 1:1 onto the importer fields with full confidence', async () => {
    const r = await importPayrollFile('template.csv', encode(templateCsv()), ids());
    expect(r.status).toBe('ok');
    expect(r.columnMap).toEqual(templateColumnMap());
    for (const [field, conf] of Object.entries(r.confidence)) expect(conf, field).toBeGreaterThanOrEqual(0.95);
    expect(r.warnings).toEqual([]);
    expect(r.meta).toMatchObject({ weekEnding: '2026-06-13', payrollNumber: '7', contractorName: 'Cedar Hollow Framing LLC', projectName: 'Linden Street Senior Housing' });
    expect(r.lines).toEqual([
      {
        id: 'L1',
        workerName: 'Ana L Rivera',
        workerId: '0427',
        classification: 'Carpenter',
        apprentice: false,
        dailyST: [0, 8, 8, 8, 8, 8, 0],
        dailyOT: [0, 0, 0, 0, 2, 0, 0],
        totalST: 40,
        totalOT: 2,
        rateST: 31.5,
        rateOT: 47.25,
        fringePlanHourly: 12.4,
        fringeCashHourly: 0,
        grossThisProject: 1354.5,
        grossAllWork: 1354.5,
        deductions: 268.62,
        netPay: 1085.88,
      },
    ]);
  });
});
