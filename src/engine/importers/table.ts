import { addDays, parseDateLoose } from '../dates';
import { normalizeLabel } from '../mapping';
import { cents, formatHours, formatMoney, formatRate, rate, sum, sumCents } from '../money';
import type { ISODate, PayrollLine } from '../types';
import { cellDate, cellText, findDates, isBlankRow, parseNumberCell, roundHours } from './cells';
import {
  DAY_NUMBERS,
  combineHeaderRows,
  detectHeaderCells,
  headerCellsFromRow,
  headerSignature,
  normalizeHeaderText,
  type ColumnDetection,
  type ColumnMap,
  type DayField,
  type FieldConfidence,
  type SingleColumnField,
} from './columns';
import { displayName, formatPersonName, looksLikeIdOnly, nameKey, splitNameAndId } from './names';

/**
 * Turn the rows of a payroll spreadsheet (CSV or XLSX, already split into cells)
 * into PayrollLine records.
 *
 * Real exports are messy: title lines above the header, a header repeated on
 * every printed page, subtotal and total rows, one worker spread over an "S" row
 * and an "O" row (the old WH-347 layout) or over one row per earning type, and
 * names written "Last, First". Every assumption made while reading such a file is
 * reported as a warning with its row number so the reviewer can check it.
 */

export interface ImportTableOptions {
  /** A mapping confirmed earlier for this layout; replaces detection (the header row is still located). */
  columnMap?: ColumnMap;
  idFactory?: () => string;
  /** Zero-based header row, when the caller already knows it. */
  headerRowIndex?: number;
  /** With `headerRowIndex`: 2 when a group-label row sits above the column names. */
  headerRowCount?: 1 | 2;
}

export interface PayrollTableMeta {
  weekEnding: ISODate | null;
  payrollNumber: string | null;
  contractorName: string | null;
  projectName: string | null;
  /** Distinct week-ending dates found in a week-ending column; more than one means the file spans several weeks. */
  weekEndings: ISODate[];
  /** Header text of the seven daily-hours columns, when present. */
  dayLabels: string[] | null;
  /** Calendar dates of the daily-hours columns, when the headers carry full dates. */
  dayDates: (ISODate | null)[] | null;
}

export interface TableImportResult {
  /** Zero-based index of the (first) header row, or -1 when no header was recognized. */
  headerRowIndex: number;
  /** 1, or 2 for a group-label row above the column names; 0 when no header was found. */
  headerRowCount: number;
  /** Header text per column (two-row headers joined). */
  headers: string[];
  /** Key for remembering a confirmed `columnMap` for this layout (see `headerSignature`). */
  headerSignature: string;
  columnMap: ColumnMap;
  /** Per-field confidence 0..1 (1 for every field of a supplied mapping). */
  confidence: FieldConfidence;
  /** Overall 0..1 confidence that the header was understood (1 when a confirmed mapping was supplied). */
  score: number;
  lines: PayrollLine[];
  /** 1-based sheet row numbers (CSV record numbers) that produced each line, keyed by line id. */
  lineRows: Record<string, number[]>;
  meta: PayrollTableMeta;
  warnings: string[];
}

const HEADER_SCAN_ROWS = 60;
const MAX_WARNINGS = 200;

export interface HeaderLocation {
  index: number;
  count: 1 | 2;
  detection: ColumnDetection;
}

/**
 * Find the header row: the row within the first 60 whose cells best match payroll
 * column names. A second row is folded in when it makes the match clearly better
 * (group labels such as "Deductions" above "FICA | Withholding | Other").
 */
export function findHeaderRow(rows: readonly (readonly unknown[])[]): HeaderLocation | null {
  let best: HeaderLocation | null = null;
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const row = asRow(rows[r]);
    if (nonEmptyCount(row) < 2) continue;
    const single = detectHeaderCells(headerCellsFromRow(row));
    let candidate: HeaderLocation = { index: r, count: 1, detection: single };
    const next = asRow(rows[r + 1]);
    if (nonEmptyCount(next) > 0) {
      const combined = detectHeaderCells(combineHeaderRows(row, next));
      if (combined.strength > single.strength + 1) candidate = { index: r, count: 2, detection: combined };
    }
    if (candidate.detection.strength > 0 && (!best || candidate.detection.strength > best.detection.strength)) {
      best = candidate;
    }
  }
  return best;
}

export function emptyTableResult(warnings: string[] = []): TableImportResult {
  return {
    headerRowIndex: -1,
    headerRowCount: 0,
    headers: [],
    headerSignature: '',
    columnMap: {},
    confidence: {},
    score: 0,
    lines: [],
    lineRows: {},
    meta: { weekEnding: null, payrollNumber: null, contractorName: null, projectName: null, weekEndings: [], dayLabels: null, dayDates: null },
    warnings,
  };
}

/** Import payroll lines from spreadsheet rows. Never throws on malformed content. */
export function importPayrollTable(rows: readonly (readonly unknown[])[], opts: ImportTableOptions = {}): TableImportResult {
  if (rows.every((r) => isBlankRow(asRow(r)))) return emptyTableResult(['The file is empty.']);

  let location: HeaderLocation | null;
  if (opts.headerRowIndex !== undefined && opts.headerRowIndex >= 0 && opts.headerRowIndex < rows.length) {
    const count = opts.headerRowCount === 2 ? 2 : 1;
    const top = asRow(rows[opts.headerRowIndex]);
    const cells = count === 2 ? combineHeaderRows(top, asRow(rows[opts.headerRowIndex + 1])) : headerCellsFromRow(top);
    location = { index: opts.headerRowIndex, count, detection: detectHeaderCells(cells) };
  } else {
    location = findHeaderRow(rows);
  }
  if (!location) {
    return emptyTableResult([
      `No header row with recognizable payroll columns (worker name or ID plus hours, rates or pay) was found in the first ${HEADER_SCAN_ROWS} rows. Check that this is a payroll register, or map the columns by hand.`,
    ]);
  }
  return new TableReader(rows, location, opts).read();
}

// ---------------------------------------------------------------------------

type Channel = 'st' | 'ot';
type RowType = 'st' | 'ot' | 'dt' | 'other';

const NUMERIC_FIELDS = [
  'totalST', 'totalOT', 'totalDT', 'totalHours', 'rateST', 'rateOT', 'stPay', 'otPay',
  'fringePlanHourly', 'fringeCashHourly', 'fringePlanAmount', 'fringeCashAmount',
  'grossPay', 'grossThisProject', 'grossAllWork', 'deductionsTotal',
  'dedFica', 'dedSocialSecurity', 'dedMedicare', 'dedFederal', 'dedState', 'netPay',
] as const;
type NumericField = (typeof NUMERIC_FIELDS)[number];

/** Amounts that belong to the worker's line as a whole rather than to its ST or OT part. */
const LINE_AMOUNTS = [
  'fringePlanAmount', 'fringeCashAmount', 'grossPay', 'grossThisProject', 'grossAllWork', 'deductionsTotal',
  'dedFica', 'dedSocialSecurity', 'dedMedicare', 'dedFederal', 'dedState', 'dedOther', 'netPay',
] as const;
type LineAmount = (typeof LINE_AMOUNTS)[number];
const HOURLY_FRINGES = ['fringePlanHourly', 'fringeCashHourly'] as const;
type HourlyFringe = (typeof HOURLY_FRINGES)[number];

const TOTALS_FIELDS: readonly NumericField[] = ['totalHours', 'totalST', 'totalOT', 'grossPay', 'grossThisProject', 'grossAllWork', 'deductionsTotal', 'netPay'];

interface RowRecord {
  row: number;
  name: string;
  workerId: string;
  classification: string;
  apprenticeText: string;
  rowType: RowType | null;
  rowTypeText: string;
  days: (number | null)[] | null;
  stDays: (number | null)[] | null;
  otDays: (number | null)[] | null;
  num: Partial<Record<NumericField, number>>;
  dedOther: number | null;
  weekEnding: ISODate | null;
  weekEndingText: string;
  payrollNumber: string;
  contractorName: string;
  projectName: string;
  invalid: string[];
  hasNumbers: boolean;
  texts: string[];
}

interface ChannelData {
  hours: number | null;
  rate: number | null;
  pay: number | null;
  days: (number | null)[] | null;
}

interface ChannelAcc {
  hours: number | null;
  rate: number | null;
  pay: number | null;
  days: number[] | null;
}

interface LineAcc {
  rows: number[];
  name: string;
  key: string;
  workerId: string;
  classification: string;
  apprenticeTexts: { row: number; text: string }[];
  empty: boolean;
  typed: Set<Channel>;
  st: ChannelAcc;
  ot: ChannelAcc;
  dtHours: number;
  totalHours: number | null;
  amounts: Partial<Record<LineAmount, number>>;
  hourly: Partial<Record<HourlyFringe, number>>;
  /** Text of a single-cell row with no figures, which may turn out to be a section heading. */
  heading: string | null;
}

class TableReader {
  private readonly map: ColumnMap;
  private readonly confidence: FieldConfidence;
  private readonly score: number;
  private readonly headerTexts: string[];
  private readonly headerRowsRaw: (readonly unknown[])[];
  private readonly dataStart: number;
  private readonly hasDayColumns: boolean;
  private readonly idIsLastFour: boolean;
  private readonly warnings: string[] = [];
  private warningOverflow = 0;
  private readonly newId: () => string;

  private readonly lines: LineAcc[] = [];
  private current: LineAcc | null = null;
  private sectionSums = new Map<NumericField, number>();
  private sectionCount = 0;
  private readonly allSums = new Map<NumericField, number>();
  private allCount = 0;
  private section: { label: string; row: number } | null = null;
  private readonly sectionRows: number[] = [];
  private readonly records: RowRecord[] = [];

  private readonly derivedST: number[] = [];
  private readonly derivedOT: number[] = [];
  private readonly summedAmountRows: string[] = [];
  private grossUsedForBoth = false;

  constructor(
    private readonly rows: readonly (readonly unknown[])[],
    private readonly location: HeaderLocation,
    opts: ImportTableOptions,
  ) {
    this.headerTexts = location.detection.headers;
    this.headerRowsRaw = Array.from({ length: location.count }, (_, i) => asRow(rows[location.index + i]));
    this.dataStart = location.index + location.count;
    if (opts.columnMap) {
      this.map = sanitizeMap(opts.columnMap, (m) => this.warn(m));
      this.confidence = Object.fromEntries(
        Object.entries(this.map)
          .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
          .map(([k]) => [k, 1]),
      ) as FieldConfidence;
      this.score = 1;
    } else {
      this.map = location.detection.columnMap;
      this.confidence = location.detection.confidence;
      this.score = location.detection.score;
    }
    this.hasDayColumns = DAY_NUMBERS.some((n) => ['day', 'st', 'ot'].some((p) => this.map[`${p}${n}` as DayField] !== undefined));
    const idHeader = this.map.workerId !== undefined ? this.headerTexts[this.map.workerId] ?? '' : '';
    this.idIsLastFour = /ssn|social|last\s*(?:4|four)/i.test(idHeader);
    let seq = 0;
    this.newId = opts.idFactory ?? (() => defaultId(++seq));
    for (const note of location.detection.notes) this.warn(note);
  }

  read(): TableImportResult {
    for (let r = this.dataStart; r < this.rows.length; r++) {
      const raw = asRow(this.rows[r]);
      if (isBlankRow(raw) || this.isRepeatedHeader(raw)) continue;
      const rec = this.readRow(raw, r + 1);
      if (this.isLabeledTotals(rec, raw)) {
        this.endSection();
        continue;
      }
      if (!rec.hasNumbers) {
        this.handleRowWithoutNumbers(rec);
        continue;
      }
      if (this.isUnlabeledTotals(rec)) {
        this.warn(`Row ${rec.row} has no worker, classification or ST/OT marker and its figures equal the sum of the rows above, so it was read as a totals row and skipped.`);
        this.endSection();
        continue;
      }
      if (rec.rowType === 'other') {
        this.warn(`${label(rec)}: pay type "${rec.rowTypeText}" is not straight time or overtime; the row was skipped.`);
        continue;
      }
      for (const message of rec.invalid) this.warn(message);
      this.records.push(rec);
      this.place(rec);
      this.accumulate(rec);
    }

    const result: TableImportResult = {
      headerRowIndex: this.location.index,
      headerRowCount: this.location.count,
      headers: this.headerTexts,
      headerSignature: headerSignature(this.headerTexts),
      columnMap: this.map,
      confidence: this.confidence,
      score: this.score,
      lines: [],
      lineRows: {},
      meta: this.buildMeta(),
      warnings: this.warnings,
    };
    for (const acc of this.lines) {
      if (acc.empty) {
        if (acc.heading === null) this.warn(`Row ${acc.rows[0]}${acc.name ? ` (${acc.name})` : ''} has no hours, rates or amounts; it was skipped.`);
        continue;
      }
      const line = this.finalize(acc);
      result.lines.push(line);
      result.lineRows[line.id] = acc.rows;
    }
    this.summaryWarnings(result);
    if (result.lines.length === 0) this.warn('No worker lines were found below the header row.');
    if (this.warningOverflow > 0) this.warnings.push(`… and ${this.warningOverflow} more warnings.`);
    return result;
  }

  // -- rows -----------------------------------------------------------------

  private cell(raw: readonly unknown[], field: SingleColumnField): unknown {
    const col = this.map[field];
    return col === undefined ? undefined : raw[col];
  }

  private text(raw: readonly unknown[], field: SingleColumnField): string {
    return cellText(this.cell(raw, field));
  }

  private readRow(raw: readonly unknown[], row: number): RowRecord {
    const nameCell = this.text(raw, 'workerName');
    let name = '';
    let workerId = this.normalizeId(this.cell(raw, 'workerId'));
    if (nameCell) {
      if (looksLikeIdOnly(nameCell)) {
        if (!workerId) workerId = nameCell;
      } else {
        const split = splitNameAndId(nameCell);
        name = displayName(split.name);
        if (!workerId && split.id) workerId = split.id;
      }
    }
    if (!name) {
      name = formatPersonName({
        first: this.text(raw, 'firstName'),
        middle: this.text(raw, 'middleName'),
        last: this.text(raw, 'lastName'),
        suffix: '',
      });
    }

    const invalid: string[] = [];
    const parse = (col: number): number | null => {
      const parsed = parseNumberCell(raw[col]);
      if (parsed.invalid) {
        invalid.push(
          `Row ${row}${name ? ` (${name})` : ''}: "${cellText(raw[col])}" in column "${this.headerTexts[col] || columnLetter(col)}" is not a number; it was treated as blank.`,
        );
      }
      return parsed.value;
    };
    const number = (field: SingleColumnField): number | null => {
      const col = this.map[field];
      return col === undefined ? null : parse(col);
    };

    const num: Partial<Record<NumericField, number>> = {};
    for (const f of NUMERIC_FIELDS) {
      const v = number(f);
      if (v !== null) num[f] = v;
    }
    const dayValues = (prefix: 'day' | 'st' | 'ot') =>
      DAY_NUMBERS.some((n) => this.map[`${prefix}${n}`] !== undefined)
        ? DAY_NUMBERS.map((n) => number(`${prefix}${n}`))
        : null;
    const days = dayValues('day');
    const stDays = dayValues('st');
    const otDays = dayValues('ot');

    const others = (this.map.dedOther ?? []).map(parse).filter((v): v is number => v !== null);

    const rowTypeText = this.text(raw, 'rowType');
    const weekCell = this.cell(raw, 'weekEnding');
    const hasNumbers =
      Object.keys(num).length > 0 ||
      others.length > 0 ||
      [days, stDays, otDays].some((d) => d?.some((v) => v !== null));

    return {
      row,
      name,
      workerId,
      classification: this.text(raw, 'classification'),
      apprenticeText: this.text(raw, 'apprenticeFlag'),
      rowType: parseRowType(rowTypeText),
      rowTypeText,
      days,
      stDays,
      otDays,
      num,
      dedOther: others.length > 0 ? sumCents(others) : null,
      weekEnding: cellDate(weekCell),
      weekEndingText: cellText(weekCell),
      payrollNumber: this.text(raw, 'payrollNumber'),
      contractorName: this.text(raw, 'contractorName'),
      projectName: this.text(raw, 'projectName'),
      invalid,
      hasNumbers,
      texts: raw.map(cellText),
    };
  }

  private normalizeId(value: unknown): string {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      const s = String(value);
      return this.idIsLastFour && s.length < 4 ? s.padStart(4, '0') : s;
    }
    return cellText(value);
  }

  private isRepeatedHeader(raw: readonly unknown[]): boolean {
    return this.headerRowsRaw.some((header) => {
      let filled = 0;
      let same = 0;
      header.forEach((h, c) => {
        const hn = normalizeHeaderText(h);
        if (!hn) return;
        filled++;
        if (normalizeHeaderText(raw[c]) === hn) same++;
      });
      return filled > 0 && same >= Math.max(2, Math.ceil(filled * 0.6));
    });
  }

  private isLabeledTotals(rec: RowRecord, raw: readonly unknown[]): boolean {
    if (rec.texts.some((t) => STRICT_TOTAL.test(t))) return true;
    const nameCols = (['workerName', 'lastName', 'firstName', 'workerId'] as const)
      .map((f) => this.map[f])
      .filter((c): c is number => c !== undefined);
    if (nameCols.some((c) => BROAD_TOTAL.test(cellText(raw[c])))) return true;
    const first = rec.texts.findIndex((t) => t !== '');
    return first >= 0 && first !== this.map.classification && BROAD_TOTAL.test(rec.texts[first]!);
  }

  private isUnlabeledTotals(rec: RowRecord): boolean {
    if (rec.name || rec.workerId || rec.classification || rec.rowType) return false;
    let present = 0;
    let matches = 0;
    for (const f of TOTALS_FIELDS) {
      const v = rec.num[f];
      if (v === undefined || v === 0) continue;
      present++;
      const section = this.sectionSums.get(f);
      const all = this.allSums.get(f);
      if (
        (this.sectionCount >= 2 && section !== undefined && Math.abs(section - v) < 0.011) ||
        (this.allCount >= 2 && all !== undefined && Math.abs(all - v) < 0.011)
      ) {
        matches++;
      }
    }
    return matches > 0 && matches * 2 >= present;
  }

  private accumulate(rec: RowRecord) {
    for (const f of TOTALS_FIELDS) {
      const v = rec.num[f];
      if (v === undefined) continue;
      this.sectionSums.set(f, (this.sectionSums.get(f) ?? 0) + v);
      this.allSums.set(f, (this.allSums.get(f) ?? 0) + v);
    }
    this.sectionCount++;
    this.allCount++;
  }

  private endSection() {
    this.sectionSums = new Map();
    this.sectionCount = 0;
    this.current = null;
  }

  private handleRowWithoutNumbers(rec: RowRecord) {
    if (rec.name) {
      if (PAGE_TITLE.test(rec.texts.join(' '))) {
        this.current = null;
        return;
      }
      const filled = rec.texts.filter(Boolean);
      this.current = this.newLine(rec);
      if (filled.length === 1) this.current.heading = filled[0]!;
      return;
    }
    const current = this.current;
    if (current && (rec.workerId || rec.classification) && (!rec.workerId || !current.workerId || sameId(rec.workerId, current.workerId))) {
      if (!current.workerId) current.workerId = rec.workerId;
      if (!current.classification) current.classification = rec.classification;
      current.rows.push(rec.row);
      return;
    }
    const filled = rec.texts.filter(Boolean);
    if (filled.length === 1 && this.map.classification === undefined && !NOT_A_SECTION.test(filled[0]!)) {
      this.section = { label: filled[0]!, row: rec.row };
      this.current = null;
    }
  }

  // -- grouping -------------------------------------------------------------

  private place(rec: RowRecord) {
    const current = this.current;
    const idCompatible = (acc: LineAcc) => !rec.workerId || !acc.workerId || sameId(rec.workerId, acc.workerId);
    const continuation = current !== null && !rec.name && idCompatible(current);
    const repeat = current !== null && rec.name !== '' && nameKey(rec.name) === current.key && idCompatible(current);
    const sameClass =
      current !== null &&
      (!rec.classification || !current.classification || normalizeLabel(rec.classification) === normalizeLabel(current.classification));

    if (current && current.empty && (continuation || repeat) && sameClass) {
      this.merge(current, rec, rec.rowType);
      return;
    }
    if (current && current.empty && current.heading !== null && rec.name && this.map.classification === undefined) {
      // A lone label followed by named workers is a section heading ("CARPENTERS"), not a worker.
      this.lines.splice(this.lines.indexOf(current), 1);
      this.section = { label: current.heading, row: current.rows[0]! };
      this.current = null;
      this.place(rec);
      return;
    }
    if (rec.rowType === 'st' || rec.rowType === 'ot' || rec.rowType === 'dt') {
      const channel: Channel = rec.rowType === 'st' ? 'st' : 'ot';
      if (current && (continuation || repeat) && sameClass && !hasChannel(current, channel)) {
        this.merge(current, rec, rec.rowType);
        return;
      }
      if (current && continuation) {
        this.warn(`${label(rec)}: a second ${channel.toUpperCase()} row with no worker name follows ${describe(current)}; it was listed as another line for the same worker.`);
        this.startLine(rec, current);
        return;
      }
      this.startLine(rec, null);
      return;
    }
    if (current && continuation) {
      const looksLikeOvertime =
        !hasOvertimeValues(rec) &&
        (!rec.classification || sameClass) &&
        !hasChannel(current, 'ot') &&
        (rec.num.rateST === undefined || current.st.rate === null || rec.num.rateST >= current.st.rate * 1.25 - 0.005);
      if (looksLikeOvertime) {
        this.merge(current, rec, 'ot');
        this.warn(`Row ${rec.row} has no worker name or ST/OT marker; it was read as the overtime row for ${describe(current)}.`);
        return;
      }
      this.warn(`Row ${rec.row} has no worker name; it was listed as another line for ${describe(current)}.`);
      this.startLine(rec, current);
      return;
    }
    if (repeat && current) {
      const sameRate = rec.num.rateST !== undefined && current.st.rate !== null && Math.abs(rec.num.rateST - current.st.rate) < 0.005;
      if (sameClass && sameRate) this.warn(`${label(rec)}: the worker is listed again with the same classification and rate as ${describe(current)}; check for a duplicate line.`);
    }
    if (!rec.name && !rec.workerId) this.warn(`Row ${rec.row} has hours or pay but no worker name or identifying number.`);
    this.startLine(rec, null);
  }

  private newLine(rec: RowRecord, inherit: LineAcc | null = null): LineAcc {
    const acc: LineAcc = {
      rows: [rec.row],
      name: rec.name || inherit?.name || '',
      key: nameKey(rec.name || inherit?.name || ''),
      workerId: rec.workerId || inherit?.workerId || '',
      classification: rec.classification,
      apprenticeTexts: rec.apprenticeText ? [{ row: rec.row, text: rec.apprenticeText }] : [],
      empty: true,
      typed: new Set(),
      st: { hours: null, rate: null, pay: null, days: null },
      ot: { hours: null, rate: null, pay: null, days: null },
      dtHours: 0,
      totalHours: null,
      amounts: {},
      hourly: {},
      heading: null,
    };
    this.lines.push(acc);
    return acc;
  }

  private startLine(rec: RowRecord, inherit: LineAcc | null) {
    const acc = this.newLine(rec, inherit);
    this.merge(acc, rec, rec.rowType);
    this.current = acc;
  }

  private merge(acc: LineAcc, rec: RowRecord, as: RowType | null) {
    if (!acc.rows.includes(rec.row)) acc.rows.push(rec.row);
    if (acc.empty && !acc.classification && !rec.classification && this.section && this.map.classification === undefined) {
      acc.classification = this.section.label;
      this.sectionRows.push(acc.rows[0]!);
    }
    acc.empty = false;
    if (!acc.workerId && rec.workerId) acc.workerId = rec.workerId;
    if (!acc.classification && rec.classification) acc.classification = rec.classification;
    if (rec.apprenticeText && !acc.apprenticeTexts.some((a) => a.row === rec.row)) acc.apprenticeTexts.push({ row: rec.row, text: rec.apprenticeText });

    const { st, ot, dt } = channelsOf(rec, as);
    if (st) this.mergeChannel(acc, 'st', st, rec);
    if (ot) this.mergeChannel(acc, 'ot', ot, rec);
    if (as === 'st' || as === 'ot' || as === 'dt') acc.typed.add(as === 'st' ? 'st' : 'ot');
    if (dt > 0) {
      acc.dtHours = roundHours(acc.dtHours + dt);
      this.warn(`${label(rec)}: ${dt} double-time hours were added to the overtime hours.`);
    }
    if (as === null && rec.num.totalHours !== undefined) acc.totalHours = rec.num.totalHours;

    for (const f of HOURLY_FRINGES) {
      const v = rec.num[f];
      if (v === undefined) continue;
      const had = acc.hourly[f];
      if (had === undefined) acc.hourly[f] = v;
      else if (Math.abs(had - v) > 0.00005) this.warn(`${label(rec)}: fringe rate ${v} differs from ${had} on the worker's other row; ${had} was kept.`);
    }
    const summed: string[] = [];
    for (const f of LINE_AMOUNTS) {
      const v = f === 'dedOther' ? rec.dedOther ?? undefined : rec.num[f];
      if (v === undefined) continue;
      const had = acc.amounts[f];
      if (had === undefined) acc.amounts[f] = v;
      else if (Math.abs(had - v) >= 0.005) {
        acc.amounts[f] = cents(had + v);
        summed.push(f);
      }
    }
    if (summed.length > 0) this.summedAmountRows.push(acc.rows.join('+'));
  }

  private mergeChannel(acc: LineAcc, channel: Channel, data: ChannelData, rec: RowRecord) {
    const target = acc[channel];
    if (data.hours !== null) target.hours = roundHours((target.hours ?? 0) + data.hours);
    if (data.pay !== null) target.pay = cents((target.pay ?? 0) + data.pay);
    if (data.rate !== null) {
      if (target.rate === null) target.rate = data.rate;
      else if (Math.abs(target.rate - data.rate) > 0.00005) {
        this.warn(`${label(rec)}: ${channel.toUpperCase()} rate ${data.rate} differs from ${target.rate} on the worker's other row; ${target.rate} was kept.`);
      }
    }
    if (data.days) {
      const base = target.days ?? [0, 0, 0, 0, 0, 0, 0];
      target.days = base.map((h, i) => roundHours(h + (data.days![i] ?? 0)));
    }
  }

  // -- output ---------------------------------------------------------------

  private finalize(acc: LineAcc): PayrollLine {
    const row = acc.rows[0]!;
    const who = `Row ${row}${acc.name ? ` (${acc.name})` : ''}`;
    const zeros = () => [0, 0, 0, 0, 0, 0, 0];
    const dailyST = this.hasDayColumns ? acc.st.days ?? zeros() : [];
    const dailyOT = this.hasDayColumns ? acc.ot.days ?? zeros() : [];
    const totalST = roundHours(acc.st.hours ?? (this.hasDayColumns ? sum(dailyST) : 0));
    const totalOT = roundHours((acc.ot.hours ?? (this.hasDayColumns ? sum(dailyOT) : 0)) + acc.dtHours);
    if (acc.totalHours !== null && acc.st.hours !== null && Math.abs(acc.totalHours - (totalST + totalOT)) > 0.01 && this.map.totalST !== undefined) {
      this.warn(`${who}: total hours ${acc.totalHours} do not equal ${totalST} ST + ${totalOT} OT.`);
    }

    let rateST = acc.st.rate;
    if (rateST === null && acc.st.pay !== null && totalST > 0) {
      rateST = rate(acc.st.pay / totalST);
      this.derivedST.push(row);
    }
    if (rateST === null && totalST > 0) {
      this.warn(`${who}: no straight-time rate of pay was found; it was set to $0.00. Enter the rate before reviewing this line.`);
    }
    let rateOT = acc.ot.rate;
    if (rateOT === null && acc.ot.pay !== null && totalOT > 0) {
      rateOT = rate(acc.ot.pay / totalOT);
      this.derivedOT.push(row);
    }

    const hours = roundHours(totalST + totalOT);
    const hourlyFringe = (hourly: HourlyFringe, amount: 'fringePlanAmount' | 'fringeCashAmount', what: string): number => {
      const direct = acc.hourly[hourly];
      if (direct !== undefined) return rate(direct);
      const dollars = acc.amounts[amount];
      if (dollars === undefined || dollars === 0) return 0;
      if (hours <= 0) {
        this.warn(`${who}: ${what} of ${formatMoney(dollars)} could not be converted to an hourly amount because no hours were reported; it was left at $0.00/hr.`);
        return 0;
      }
      const perHour = rate(dollars / hours);
      this.warn(`${who}: ${what} of ${formatMoney(dollars)} for the week was converted to ${formatRate(perHour)}/hr over ${formatHours(hours)} hours.`);
      return perHour;
    };
    const fringePlanHourly = hourlyFringe('fringePlanHourly', 'fringePlanAmount', 'fringe paid to plans');
    const fringeCashHourly = hourlyFringe('fringeCashHourly', 'fringeCashAmount', 'fringe paid in cash');

    const a = acc.amounts;
    if (a.grossPay !== undefined && a.grossThisProject === undefined && a.grossAllWork === undefined) this.grossUsedForBoth = true;
    const grossThisProject = a.grossThisProject ?? a.grossPay ?? null;
    const grossAllWork = a.grossAllWork ?? a.grossPay ?? null;

    let deductions: number | null = a.deductionsTotal ?? null;
    if (deductions === null) {
      const splitFica = a.dedSocialSecurity !== undefined || a.dedMedicare !== undefined;
      const ficaDuplicated =
        a.dedFica !== undefined && splitFica && Math.abs(a.dedFica - (a.dedSocialSecurity ?? 0) - (a.dedMedicare ?? 0)) < 0.011;
      const parts = [
        ficaDuplicated ? undefined : a.dedFica,
        a.dedSocialSecurity,
        a.dedMedicare,
        a.dedFederal,
        a.dedState,
        a.dedOther,
      ].filter((v): v is number => v !== undefined);
      if (parts.length > 0) deductions = sumCents(parts);
    }

    const { classification, apprentice } = this.resolveApprentice(acc, who);
    return {
      id: this.newId(),
      workerName: acc.name,
      workerId: acc.workerId,
      classification,
      apprentice,
      dailyST,
      dailyOT,
      totalST,
      totalOT,
      rateST: rateST === null ? 0 : rate(rateST),
      rateOT: rateOT === null ? null : rate(rateOT),
      fringePlanHourly,
      fringeCashHourly,
      grossThisProject: grossThisProject === null ? null : cents(grossThisProject),
      grossAllWork: grossAllWork === null ? null : cents(grossAllWork),
      deductions: deductions === null ? null : cents(deductions),
      netPay: a.netPay === undefined ? null : cents(a.netPay),
    };
  }

  private resolveApprentice(acc: LineAcc, who: string): { classification: string; apprentice: boolean } {
    const stripped = stripApprentice(acc.classification);
    let flag: boolean | null = null;
    for (const { row, text } of acc.apprenticeTexts) {
      const parsed = parseApprenticeFlag(text);
      if (parsed === null) this.warn(`Row ${row}: journeyworker/apprentice value "${text}" was not recognized; the worker was treated as a journeyworker.`);
      else flag = flag === true ? true : parsed;
    }
    if (stripped.apprentice && flag === false) {
      this.warn(`${who}: the classification says apprentice but the J/A column says journeyworker; the worker was treated as an apprentice.`);
    }
    return { classification: stripped.classification, apprentice: stripped.apprentice || flag === true };
  }

  private summaryWarnings(result: TableImportResult) {
    if (this.derivedST.length > 0) {
      this.warn(`Straight-time rates were calculated as straight-time pay ÷ straight-time hours (the file has no rate column) for ${rowList(this.derivedST)}.`);
    }
    if (this.derivedOT.length > 0) {
      this.warn(`Overtime rates were calculated as overtime pay ÷ overtime hours (the file has no overtime rate column) for ${rowList(this.derivedOT)}.`);
    }
    if (this.grossUsedForBoth) {
      this.warn('The file has a single gross pay column; it was used as both gross for this project and gross for all work. Confirm the worker had no pay from other jobs this week.');
    }
    if (this.summedAmountRows.length > 0) {
      const shown = this.summedAmountRows.slice(0, 8).join(', ');
      this.warn(`Gross, deduction or net amounts on a worker's separate ST and OT rows were added together (rows ${shown}${this.summedAmountRows.length > 8 ? ', …' : ''}).`);
    }
    if (this.sectionRows.length > 0) {
      this.warn(`The file has no classification column; classifications were taken from the section headings above ${rowList(this.sectionRows)}.`);
    }
    const { weekEnding, dayDates } = result.meta;
    const lastDay = dayDates?.[6] ?? null;
    if (weekEnding && lastDay && lastDay !== weekEnding) {
      this.warn(`The daily-hours columns end on ${lastDay}, but the week ending date is ${weekEnding}.`);
    }
  }

  private buildMeta(): PayrollTableMeta {
    const title = scanTitleRows(this.rows.slice(0, this.location.index).map(asRow));
    const days = this.map.day1 !== undefined || this.map.st1 !== undefined || this.map.ot1 !== undefined ? this.location.detection.days : null;

    const weekEndings = [...new Set(this.records.map((r) => r.weekEnding).filter((d): d is ISODate => d !== null))].sort();
    const unreadable = this.records.find((r) => r.weekEndingText && !r.weekEnding);
    if (unreadable) this.warn(`Row ${unreadable.row}: week ending "${unreadable.weekEndingText}" is not a date.`);
    let weekEnding: ISODate | null = weekEndings.at(-1) ?? null;
    if (weekEndings.length > 1) {
      this.warn(`The file contains ${weekEndings.length} different week ending dates (${weekEndings.join(', ')}). Each certified payroll covers one week; split the file or import each week separately. ${weekEnding} was used.`);
    }
    if (weekEnding && title.weekEnding && title.weekEnding !== weekEnding) {
      this.warn(`The title says week ending ${title.weekEnding}, but the week ending column says ${weekEnding}; the column was used.`);
    }
    weekEnding ??= title.weekEnding;
    weekEnding ??= days?.dates[6] ?? null;
    const dayDates = days ? days.dates.map((iso, i) => iso ?? withYear(days.monthDays[i] ?? null, weekEnding)) : null;

    const first = (pick: (r: RowRecord) => string) => this.records.map(pick).find((v) => v !== '') ?? null;
    return {
      weekEnding,
      payrollNumber: first((r) => r.payrollNumber) ?? title.payrollNumber,
      contractorName: first((r) => r.contractorName) ?? title.contractorName,
      projectName: first((r) => r.projectName) ?? title.projectName,
      weekEndings,
      dayLabels: days?.labels ?? null,
      dayDates,
    };
  }

  private warn(message: string) {
    if (this.warnings.length >= MAX_WARNINGS) this.warningOverflow++;
    else this.warnings.push(message);
  }
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function channelsOf(rec: RowRecord, as: RowType | null): { st: ChannelData | null; ot: ChannelData | null; dt: number } {
  const n = rec.num;
  const sumDays = (d: (number | null)[] | null) => (d && d.some((v) => v !== null) ? roundHours(sum(d.map((v) => v ?? 0))) : null);
  const otColumns = (): ChannelData | null =>
    n.totalOT !== undefined || n.rateOT !== undefined || n.otPay !== undefined || rec.otDays?.some((v) => v !== null)
      ? { hours: n.totalOT ?? sumDays(rec.otDays), rate: n.rateOT ?? null, pay: n.otPay ?? null, days: rec.otDays }
      : null;

  if (as === 'ot' || as === 'dt') {
    const days = rec.days ?? rec.otDays ?? rec.stDays;
    return {
      st: null,
      ot: { hours: n.totalOT ?? n.totalHours ?? n.totalST ?? n.totalDT ?? sumDays(days), rate: n.rateOT ?? n.rateST ?? null, pay: n.otPay ?? n.stPay ?? null, days },
      dt: 0,
    };
  }
  if (as === 'st') {
    const days = rec.days ?? rec.stDays;
    return {
      st: { hours: n.totalST ?? n.totalHours ?? sumDays(days), rate: n.rateST ?? null, pay: n.stPay ?? null, days },
      ot: otColumns(),
      dt: n.totalDT ?? 0,
    };
  }
  const ot = otColumns();
  const stDays = rec.stDays ?? rec.days;
  const dt = n.totalDT ?? 0;
  let stHours = n.totalST ?? null;
  if (stHours === null && n.totalHours !== undefined) stHours = roundHours(n.totalHours - (ot?.hours ?? 0) - dt);
  if (stHours === null) stHours = sumDays(stDays);
  const hasSt = stHours !== null || n.rateST !== undefined || n.stPay !== undefined;
  return {
    st: hasSt ? { hours: stHours, rate: n.rateST ?? null, pay: n.stPay ?? null, days: stDays } : null,
    ot,
    dt,
  };
}

function hasOvertimeValues(rec: RowRecord): boolean {
  const n = rec.num;
  return n.totalOT !== undefined || n.rateOT !== undefined || n.otPay !== undefined || n.totalDT !== undefined || (rec.otDays?.some((v) => v !== null) ?? false);
}

function hasChannel(acc: LineAcc, channel: Channel): boolean {
  const c = acc[channel];
  return acc.typed.has(channel) || (c.hours ?? 0) > 0 || (c.days?.some((h) => h !== 0) ?? false) || (channel === 'ot' && acc.dtHours > 0);
}

function parseRowType(text: string): RowType | null {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return null;
  if (/^(?:s|st|str|straight(?: time)?|reg(?:ular)?(?: (?:time|pay|hours|earnings|hourly|wages))?|r|rt|hourly|base)$/.test(s)) return 'st';
  if (/^(?:o|ot|overtime(?: (?:pay|hours|earnings|wages))?|ot (?:pay|hours|earnings|wages)|1 5x?|time and (?:a |one )?half)$/.test(s)) return 'ot';
  if (/^(?:dt|double(?: time| ot| overtime)?(?: (?:pay|hours|earnings))?|2x|2 0x?)$/.test(s)) return 'dt';
  return 'other';
}

/** Interpret a J/A or "Apprentice (Y/N)" cell; null when the value is not recognized. */
export function parseApprenticeFlag(text: string): boolean | null {
  const s = text.trim().toLowerCase();
  if (!s) return false;
  if (/^(?:j|jw|jm|jman|journey\w*|n|no|false|0|none|-)$/.test(s)) return false;
  if (/^(?:a|y|yes|true|x|1|appr?\.?|apprentice)$/.test(s)) return true;
  if (/\bappr?(?:entice)?\b|%|\b\d+(?:st|nd|rd|th)\b|\b(?:level|period|step|yr|year)\b|^a[-\s]?\d/.test(s)) return true;
  return null;
}

const LEVEL = String.raw`(?:\d+\s*(?:st|nd|rd|th)?\s*(?:yr|year|period|level|step|term)s?\.?|(?:level|period|step|yr|year|term)\s*\d+|\d+\s*%)`;
const APPRENTICE_RE = new RegExp(String.raw`[\s(\[-]*(?:${LEVEL}\s*)?\b(?:apprentice|appr|app)\b\.?(?:\s*[-–:#,(]?\s*${LEVEL})?\s*[)\]]?`, 'i');

/**
 * Detect "Apprentice"/"Appr" in a classification and remove it (with any period
 * or level next to it), so "Electrician Apprentice 2nd yr" maps like "Electrician".
 */
export function stripApprentice(classification: string): { classification: string; apprentice: boolean } {
  if (!APPRENTICE_RE.test(classification)) return { classification: classification.trim(), apprentice: false };
  const cleaned = classification
    .replace(APPRENTICE_RE, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:,/]+|[\s\-–:,/(]+$/g, '')
    .trim();
  return { classification: cleaned, apprentice: true };
}

const STRICT_TOTAL =
  /^(?:(?:grand|sub|page|report|company|department|dept|job|project|payroll|weekly|week|employee|crew|craft|class|classification)\s*-?\s*)?totals?\s*:?$|^totals?\s+(?:for|all|of|this)\b|^sub-?\s?totals?\b|^grand\s+totals?\b/i;
const BROAD_TOTAL = /^(?:grand\s+|sub-?\s*|page\s+|report\s+)?totals?\b|\btotals?\s*:?$|^(?:sum|count|average|avg)\s*:?$/i;
/** Page headers and footers repeated inside a printed register. */
const PAGE_TITLE = /\bpage\s*\d|\b(?:payroll|report|register|summary|continued|certified)\b|\bweek\s+end|\bperiod\b|\bprinted\b/i;
const NOT_A_SECTION = /\b(?:payroll|report|register|summary|page|continued|totals?|week|period)\b|\d{1,2}[/.-]\d{1,2}/i;

/** A header date written without the year ("6/8"), placed in the year of the week it belongs to. */
function withYear(monthDay: { month: number; day: number } | null, weekEnding: ISODate | null): ISODate | null {
  if (!monthDay || !weekEnding) return null;
  const year = Number(weekEnding.slice(0, 4));
  const candidate = parseDateLoose(`${year}-${monthDay.month}-${monthDay.day}`);
  if (candidate && candidate <= addDays(weekEnding, 7)) return candidate;
  return parseDateLoose(`${year - 1}-${monthDay.month}-${monthDay.day}`);
}

function sameId(a: string, b: string): boolean {
  const da = a.replace(/\D/g, '');
  const db = b.replace(/\D/g, '');
  return da !== '' && db !== '' ? da.slice(-4) === db.slice(-4) : a.trim().toLowerCase() === b.trim().toLowerCase();
}

const MAX_COLUMNS = 16_384;

function sanitizeMap(map: ColumnMap, warn: (m: string) => void): ColumnMap {
  const clean: ColumnMap = {};
  const valid = (c: unknown): c is number => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < MAX_COLUMNS;
  for (const [field, value] of Object.entries(map)) {
    if (field === 'dedOther') {
      const cols = Array.isArray(value) ? value.filter(valid) : [];
      if (cols.length > 0) clean.dedOther = cols;
      continue;
    }
    if (valid(value)) clean[field as SingleColumnField] = value;
    else if (value !== undefined) warn(`The saved column mapping for "${field}" is not a valid column number; it was ignored.`);
  }
  return clean;
}

function asRow(row: unknown): readonly unknown[] {
  return Array.isArray(row) ? row : [];
}

function nonEmptyCount(row: readonly unknown[]): number {
  let n = 0;
  for (const v of row) if (cellText(v) !== '') n++;
  return n;
}

function label(rec: RowRecord): string {
  return `Row ${rec.row}${rec.name ? ` (${rec.name})` : ''}`;
}

function describe(acc: LineAcc): string {
  return `${acc.name || 'the worker'} (row ${acc.rows[0]})`;
}

function rowList(rows: readonly number[]): string {
  if (rows.length === 1) return `row ${rows[0]}`;
  const shown = rows.slice(0, 10).join(', ');
  return `rows ${shown}${rows.length > 10 ? `, … (${rows.length} rows)` : ''}`;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `column ${s}`;
}

function defaultId(seq: number): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : `line-${Date.now().toString(36)}-${seq}`;
}

// ---------------------------------------------------------------------------
// Title lines above the header
// ---------------------------------------------------------------------------

interface TitleMeta {
  weekEnding: ISODate | null;
  payrollNumber: string | null;
  contractorName: string | null;
  projectName: string | null;
}

const WEEK_ENDING_LABEL =
  /\b(?:(?:pay\s*|payroll\s+|work\s*)?(?:week|wk|period)\s*(?:ending|ended|end(?:ing)?)(?:\s*date)?|w\/e|p\/e)\b\s*[:#.-]?\s*(.*)$/i;
const PAY_PERIOD_LABEL = /\b(?:pay\s*|payroll\s+)?period\b\s*(?:covered|dates?|from)?\s*:?\s*(.*)$/i;
const PAYROLL_NO_LABEL = /\b(?:certified\s+)?payroll\s*(?:no\b\.?|number|num\b\.?|#)\s*[:#.]?\s*([A-Za-z0-9][\w-]*)?/i;
const CONTRACTOR_LABEL =
  /^\s*(?:name\s+of\s+)?(?:prime\s+)?(?:contractor\s+or\s+sub-?contractor|sub-?contractor|contractor|company|employer|firm)(?:\s+name)?\s*:\s*(.*)$/i;
const CONTRACTOR_ONLY = /^\s*(?:name\s+of\s+)?(?:prime\s+)?(?:contractor\s+or\s+sub-?contractor|sub-?contractor|contractor|company|employer|firm)(?:\s+name)?\s*:?\s*$/i;
const PROJECT_LABEL = /^\s*(?:project\s+and\s+location|project\s+or\s+contract(?:\s+no\.?)?|project(?:\s+name)?|job(?:\s+name)?)\s*:\s*(.*)$/i;
const PROJECT_ONLY = /^\s*(?:project\s+and\s+location|project\s+or\s+contract(?:\s+no\.?)?|project(?:\s+name)?|job(?:\s+name)?)\s*:?\s*$/i;
const REPORT_WORDS =
  /\b(?:payroll|report|register|summary|detail|certified|journal|statement|page|week|period|date)\b|wh-?\s?347|department of labor|u\.\s?s\./i;

/** Read week ending, payroll number, contractor and project from the lines above the header. */
export function scanTitleRows(rows: readonly (readonly unknown[])[]): TitleMeta {
  const meta: TitleMeta = { weekEnding: null, payrollNumber: null, contractorName: null, projectName: null };
  let rangeEnd: ISODate | null = null;
  let firstLine: string | null = null;
  let firstLineSeen = false;

  for (const row of rows) {
    const cells = Array.from(row);
    const nextValue = (i: number): unknown => cells.slice(i + 1).find((v) => cellText(v) !== '');
    const filled = cells.filter((v) => cellText(v) !== '');
    if (!firstLineSeen && filled.length > 0) {
      firstLineSeen = true;
      if (filled.length === 1 && typeof filled[0] === 'string') firstLine = cellText(filled[0]);
    }
    cells.forEach((cell, i) => {
      const raw = typeof cell === 'string' ? cell : cellText(cell);
      const t = cellText(cell);
      if (!t) return;
      const firstSegment = (s: string) => s.split(/\s{2,}|\t/)[0]!.trim();

      const we = WEEK_ENDING_LABEL.exec(t);
      if (we && !meta.weekEnding) {
        const value = we[1]?.trim() ? we[1] : nextValue(i);
        meta.weekEnding = cellDate(value) ?? findDates(cellText(value)).at(-1) ?? null;
      } else if (!we) {
        const pp = PAY_PERIOD_LABEL.exec(t);
        const dates = findDates(pp ? (pp[1]?.trim() ? pp[1] : cellText(nextValue(i))) : t);
        if (dates.length >= 2 && !rangeEnd) rangeEnd = dates.at(-1)!;
      }

      const pn = PAYROLL_NO_LABEL.exec(t);
      if (pn && !meta.payrollNumber) {
        const value = pn[1] ?? cellText(nextValue(i));
        if (value && !/^(?:for|week|period|date)$/i.test(value)) meta.payrollNumber = value;
      }

      if (!meta.contractorName) {
        const m = CONTRACTOR_LABEL.exec(raw.replace(/\r?\n/g, '  '));
        if (m && m[1]?.trim()) meta.contractorName = firstSegment(m[1]);
        else if (CONTRACTOR_ONLY.test(t)) meta.contractorName = cellText(nextValue(i)) || null;
      }
      if (!meta.projectName) {
        const m = PROJECT_LABEL.exec(raw.replace(/\r?\n/g, '  '));
        if (m && m[1]?.trim()) meta.projectName = firstSegment(m[1]);
        else if (PROJECT_ONLY.test(t)) meta.projectName = cellText(nextValue(i)) || null;
      }
    });
  }
  meta.weekEnding ??= rangeEnd;
  if (!meta.contractorName && firstLine && !REPORT_WORDS.test(firstLine) && findDates(firstLine).length === 0 && !/:/.test(firstLine)) {
    meta.contractorName = firstLine;
  }
  return meta;
}

