import { cents } from '../money';
import { RESTITUTION_STATUS_LABELS, type LedgerRow } from '../restitution';
import type { Finding, ISODate } from '../types';
import type { Cell, SheetData } from 'write-excel-file';
import { RULE_LABELS, SEVERITY_LABELS } from './wording';

/**
 * Spreadsheet exports of the restitution ledger and findings.
 *
 * Worker names, classifications and notes come from contractors' files, and a cell that
 * starts with "=", "+", "-" or "@" is run as a formula when a CSV is opened in Excel or
 * LibreOffice. Text cells are therefore neutralized with a leading apostrophe. Numbers
 * Wagebench computes are written as plain numbers so they stay numeric. The XLSX export
 * types every cell explicitly (text is never parsed as a formula), so it needs no prefix.
 */

/** An amount Wagebench formatted itself, written as is so a negative stays a number. */
interface Amount {
  amount: string;
}

type CsvValue = string | number | Amount | null | undefined;

const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;

/** Prefix text that a spreadsheet would treat as a formula with a single quote. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) || FORMULA_START.test(text.trimStart()) ? `'${text}` : text;
}

/** One CSV field: text is neutralized, then quoted if it holds a quote, comma or line break. */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'object') return value.amount;
  const text = neutralizeFormula(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(header: string[], rows: CsvValue[][], opts: CsvOptions): string {
  const lines = [header, ...rows].map((r) => r.map(csvField).join(','));
  return `${opts.bom === false ? '' : '\uFEFF'}${lines.join('\r\n')}\r\n`;
}

export interface CsvOptions {
  /** Start with a UTF-8 byte order mark so Excel reads accented names correctly (default true). */
  bom?: boolean;
}

/** Dollar amounts as plain numbers with two decimals, e.g. 601.2 → "601.20". */
function amount(value: number): Amount {
  return { amount: Number.isFinite(value) ? cents(value).toFixed(2) : '' };
}

const LEDGER_HEADER = [
  'Contractor',
  'Week ending',
  'Worker',
  'Issue',
  'Finding',
  'Amount owed',
  'Amount paid',
  'Balance',
  'Status',
  'Note',
  'Last updated',
  'Corrected payroll received',
  'Finding key',
];

/** The restitution ledger as CSV (RFC 4180, CRLF line endings). */
export function ledgerToCsv(rows: readonly LedgerRow[], opts: CsvOptions = {}): string {
  return csv(
    LEDGER_HEADER,
    rows.map((r) => [
      r.contractorName,
      r.finding.weekEnding ?? '',
      r.finding.workerName ?? '',
      RULE_LABELS[r.finding.ruleId] ?? r.finding.ruleId,
      r.finding.title,
      amount(r.amountOwed),
      amount(r.amountPaid),
      amount(r.balance),
      RESTITUTION_STATUS_LABELS[r.status] ?? r.status,
      r.note,
      r.updatedAt ?? '',
      r.finding.supersededBy ? 'Yes' : 'No',
      r.finding.key,
    ]),
    opts,
  );
}

const FINDINGS_HEADER = [
  'Contractor',
  'Week ending',
  'Severity',
  'Check',
  'Worker',
  'Title',
  'Detail',
  'Amount owed',
  'Superseded',
  'Finding key',
];

/** Findings as CSV; `contractorNames` maps contractor id to name. */
export function findingsToCsv(
  findings: readonly Finding[],
  contractorNames: ReadonlyMap<string, string>,
  opts: CsvOptions = {},
): string {
  return csv(
    FINDINGS_HEADER,
    findings.map((f) => [
      contractorNames.get(f.contractorId) ?? 'Unknown contractor',
      f.weekEnding ?? '',
      SEVERITY_LABELS[f.severity] ?? f.severity,
      RULE_LABELS[f.ruleId] ?? f.ruleId,
      f.workerName ?? '',
      f.title,
      f.detail,
      amount(f.amountOwed),
      f.supersededBy ? 'Yes' : 'No',
      f.key,
    ]),
    opts,
  );
}

// ---------------------------------------------------------------------------
// XLSX

const MONEY_FORMAT = '$#,##0.00;[Red]-$#,##0.00';
const DATE_FORMAT = 'mm/dd/yyyy';
const TIMESTAMP_FORMAT = 'mm/dd/yyyy hh:mm';

function isoToUtcDate(date: ISODate | null | undefined): Date | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function timestamp(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The restitution ledger as an .xlsx workbook with real dates and money formats and a
 * totals row. write-excel-file is loaded on demand; its browser build produces a Blob in
 * both the browser and Node, which is returned as bytes.
 */
export async function ledgerToXlsx(rows: readonly LedgerRow[]): Promise<Uint8Array> {
  const { default: writeXlsxFile } = await import('write-excel-file');
  const header: Cell[] = LEDGER_HEADER.slice(0, 12).map((value) => ({
    value,
    fontWeight: 'bold',
    backgroundColor: '#E8EAEE',
    wrap: true,
  }));
  const text = (value: string | null | undefined): Cell => (value ? { type: String, value } : null);
  const money = (value: number): Cell => ({ type: Number, value: cents(value), format: MONEY_FORMAT });
  const date = (value: Date | null, format: string): Cell => (value ? { type: Date, value, format } : null);

  const body: Cell[][] = rows.map((r) => [
    text(r.contractorName),
    date(isoToUtcDate(r.finding.weekEnding), DATE_FORMAT),
    text(r.finding.workerName),
    text(RULE_LABELS[r.finding.ruleId] ?? r.finding.ruleId),
    text(r.finding.title),
    money(r.amountOwed),
    money(r.amountPaid),
    money(r.balance),
    text(RESTITUTION_STATUS_LABELS[r.status] ?? r.status),
    text(r.note),
    date(timestamp(r.updatedAt), TIMESTAMP_FORMAT),
    text(r.finding.supersededBy ? 'Yes' : 'No'),
  ]);
  const total = (pick: (r: LedgerRow) => number): Cell => ({
    type: Number,
    value: cents(rows.reduce((a, r) => a + pick(r), 0)),
    format: MONEY_FORMAT,
    fontWeight: 'bold',
    topBorderStyle: 'thin',
  });
  const totals: Cell[] = [
    { type: String, value: `Total (${rows.length} ${rows.length === 1 ? 'item' : 'items'})`, fontWeight: 'bold' },
    null,
    null,
    null,
    null,
    total((r) => r.amountOwed),
    total((r) => r.amountPaid),
    total((r) => r.balance),
    null,
    null,
    null,
    null,
  ];

  const data: SheetData = [header, ...body, totals];
  const blob = await writeXlsxFile(data, {
    sheet: 'Restitution ledger',
    columns: [
      { width: 30 },
      { width: 12 },
      { width: 24 },
      { width: 28 },
      { width: 50 },
      { width: 13 },
      { width: 13 },
      { width: 13 },
      { width: 18 },
      { width: 40 },
      { width: 17 },
      { width: 12 },
    ],
    stickyRowsCount: 1,
    fontFamily: 'Calibri',
    fontSize: 11,
  });
  return new Uint8Array(await blob.arrayBuffer());
}
