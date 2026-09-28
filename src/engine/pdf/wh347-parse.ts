import { daysBetween, isIsoDate, parseDateLoose } from '../dates';
import { cents, parseAmount, sum } from '../money';
import type { ISODate, PayrollLine } from '../types';
import type { PdfTextItem, PdfTextPage } from './extract';
import { groupLines, splitWords } from './lines';
import {
  APPRENTICE_ROWS,
  CHECKBOX_CENTER_RISE,
  DAY_COLUMNS,
  DAY_HEADER_ROWS,
  FRINGE_PLAN_COLUMNS,
  FRINGE_ROWS,
  FRINGE_TOTAL_CREDIT,
  FRINGE_WORKER_NAME,
  PAGE1_ANCHORS,
  PAGE1_CHECKBOXES,
  PAGE1_COLUMNS,
  PAGE1_HEADER,
  PAGE1_SLOTS,
  PAGE2_ANCHORS,
  PAGE2_HEADER,
  PAGE2_REMARKS,
  PAGE2_SIGNATURE_ROW,
  SPLIT_COLUMNS,
  STATEMENT_CHECKBOXES,
  STATEMENT_KEYS,
  STOT_LABEL_BASELINES,
  STOT_LABEL_X,
  type Anchor,
  type Box,
  type CheckboxSpot,
  type Page1Column,
  type Range,
  type StatementKey,
} from './wh347-layout';

/** A worker row read from the form: PayrollLine without an id, plus what the form shows beyond it. */
export interface Wh347Line extends Omit<PayrollLine, 'id'> {
  entryNo: string | null;
  lastName: string;
  firstName: string;
  middleInitial: string;
  /** Column (8) components; `deductions` holds the total. */
  deductionDetail: { taxWithholdings: number | null; fica: number | null; other: number | null };
  /** 1-based PDF page, 1-based page-1 sheet, 1-based slot on that sheet. */
  source: { page: number; sheet: number; slot: number };
}

export interface Wh347Meta {
  projectName: string | null;
  projectNumber: string | null;
  projectLocation: string | null;
  wdNumber: string | null;
  payrollNumber: string | null;
  weekEnding: ISODate | null;
  businessName: string | null;
  businessAddress: string | null;
  contractorRole: 'prime' | 'subcontractor' | null;
  isFinal: boolean;
  /** A "no work performed" statement was written across the worker table. */
  noWork: boolean;
  /** Typed text in the signature box on page 2; null when page 2 is missing. */
  signed: boolean | null;
  certifyingOfficial: string | null;
}

export interface Wh347Statement {
  statements: Record<StatementKey, boolean>;
  apprenticePrograms: { name: string; registeredWith: 'OA' | 'SAA' | null; classification: string | null }[];
  fringePlans: { name: string | null; type: string | null; planNumber: string | null; funded: boolean | null }[];
  fringeCredits: { workerName: string; credits: (number | null)[]; total: number | null }[];
  signature: string | null;
  signatureDate: ISODate | null;
  phone: string | null;
  email: string | null;
  remarks: string | null;
  projectNumber: string | null;
  payrollNumber: string | null;
  weekEnding: ISODate | null;
}

export interface LowConfidence {
  /** Index into `lines`. */
  row: number;
  /** PayrollLine field name, e.g. "rateST" or "dailyST[2]". */
  field: string;
  reason: string;
}

export interface Wh347ParseResult {
  recognized: boolean;
  formRevision: 'rev-2025' | null;
  meta: Wh347Meta;
  lines: Wh347Line[];
  lowConfidence: LowConfidence[];
  warnings: string[];
  /** Column (4) headings from the first sheet. */
  days: { name: string | null; date: ISODate | null }[];
  /** Page 2 (Statement of Compliance), merged across copies; null when absent. */
  statement: Wh347Statement | null;
  /** Number of page-1 sheets read. */
  sheets: number;
}

/**
 * Read a certified payroll filled on the official WH-347 (Rev. January 2025).
 *
 * Each page is identified by its printed labels, then the form geometry is
 * mapped onto the page from where those labels actually are, so payrolls
 * printed with a small shift or scale still read correctly. Values are taken
 * by position: each worker occupies an ST row and an OT row, and every text
 * run is assigned to the column and row its centre falls in. Anything the
 * reader had to guess is listed in `lowConfidence` for the reviewer.
 */
export function parseWh347(pages: readonly PdfTextPage[]): Wh347ParseResult {
  const result: Wh347ParseResult = {
    recognized: false,
    formRevision: null,
    meta: emptyMeta(),
    lines: [],
    lowConfidence: [],
    warnings: [],
    days: [],
    statement: null,
    sheets: 0,
  };

  if (!pages.some((p) => p.items.some((i) => i.str.trim() !== ''))) {
    result.warnings.push(
      'This PDF has no text layer (it looks scanned or printed as an image), so it cannot be read automatically. Key the payroll in by hand.',
    );
    return result;
  }

  const sheets: { page: number; frame: Frame }[] = [];
  const statements: { page: number; frame: Frame }[] = [];
  let oldRevision = false;
  pages.forEach((page, index) => {
    const text = normalize(page.items.map((i) => i.str).join(' '));
    if (/WITHHOLDING EXEMPTIONS|NAME AND INDIVIDUAL IDENTIFYING NUMBER/.test(text)) oldRevision = true;
    if (isSheetPage(text)) {
      const frame = locateFrame(page, PAGE1_ANCHORS, true);
      if (frame) sheets.push({ page: index + 1, frame });
    } else if (isStatementPage(text)) {
      const frame = locateFrame(page, PAGE2_ANCHORS, false);
      if (frame) statements.push({ page: index + 1, frame });
    }
  });

  if (sheets.length === 0 && statements.length === 0) {
    result.warnings.push(
      oldRevision
        ? 'This looks like the older WH-347 (before the January 2025 revision). Only the Rev. January 2025 form can be read automatically; import the contractor\'s spreadsheet export or key the payroll in.'
        : 'This PDF does not look like a WH-347 (Rev. January 2025) certified payroll. Import the contractor\'s spreadsheet export or key the payroll in.',
    );
    return result;
  }

  result.recognized = true;
  result.formRevision = 'rev-2025';
  result.sheets = sheets.length;

  sheets.forEach(({ page, frame }, s) => readSheet(frame, page, s, result));
  if (sheets.length === 0) {
    result.warnings.push('Only the Statement of Compliance (page 2) was found; the payroll sheet (page 1) is not in this PDF.');
  } else if (result.lines.length === 0 && !result.meta.noWork) {
    result.warnings.push(
      'No worker rows could be read from the payroll sheet. If the PDF shows entries, they may be drawn as images; key them in.',
    );
  }
  if ([...sheets, ...statements].some((s) => s.frame.poorFit)) {
    result.warnings.push('The form labels are not where the official form puts them; check the imported values against the PDF.');
  }

  if (statements.length > 0) {
    const read = statements.map(({ frame }) => readStatement(frame));
    result.statement = mergeStatements(read);
    result.meta.signed = result.statement.signature !== null;
    result.meta.certifyingOfficial = read.map((r) => r.official).find((o) => o !== null) ?? null;
    fillMissingMeta(result.meta, read[0]!);
    checkStatement(result);
  } else if (sheets.length > 0) {
    result.warnings.push('Page 2 (Statement of Compliance) is not in this PDF. Ask the contractor for the signed statement.');
  }
  return result;
}

function emptyMeta(): Wh347Meta {
  return {
    projectName: null,
    projectNumber: null,
    projectLocation: null,
    wdNumber: null,
    payrollNumber: null,
    weekEnding: null,
    businessName: null,
    businessAddress: null,
    contractorRole: null,
    isFinal: false,
    noWork: false,
    signed: null,
    certifyingOfficial: null,
  };
}

// ---------------------------------------------------------------------------
// Page recognition and geometry

function normalize(s: string): string {
  return s
    .replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function isSheetPage(text: string): boolean {
  return (
    text.includes('CERTIFIED PAYROLL NO') &&
    (text.includes('(6B)') || text.includes('TOTAL FRINGE BENEFIT CREDIT')) &&
    (text.includes('(1A)') || text.includes('WORKER ENTRY NO'))
  );
}

function isStatementPage(text: string): boolean {
  return (
    text.includes('SIGNATURE OF CERTIFYING OFFICIAL') &&
    (text.includes('HOURLY CREDIT FOR FRINGE BENEFITS') || text.includes('APPRENTICESHIP PROGRAM NAME'))
  );
}

/** A page's words in blank-form coordinates. */
interface Frame {
  tokens: Token[];
  poorFit: boolean;
}

interface Token {
  str: string;
  /** Left edge, right edge and vertical centre in blank-form coordinates. */
  x0: number;
  x1: number;
  cy: number;
  size: number;
}

interface Located {
  anchor: Anchor;
  x: number;
  y: number;
}

/**
 * Find the form's labels on the page, fit page = scale × form + offset on
 * each axis, and return the page's words mapped back to form coordinates.
 */
function locateFrame(page: PdfTextPage, anchors: readonly Anchor[], sheet: boolean): Frame | null {
  const horizontal = page.items.filter((i) => i.angle === 0 && i.str.trim() !== '');
  const found = locateAnchors(horizontal, anchors);
  if (found.length < Math.ceil(anchors.length / 2)) return null;

  let fx = fitAxis(found.map((f) => ({ ref: f.anchor.x, got: f.x })));
  let fy = fitAxis(found.map((f) => ({ ref: f.anchor.y, got: f.y })));

  if (sheet) {
    // The ST/OT labels printed in every slot pin down the row positions.
    const rowPairs: { ref: number; got: number }[] = [];
    for (const b of STOT_LABEL_BASELINES) {
      for (const [label, ref] of [['ST', b.st], ['OT', b.ot]] as const) {
        const ex = fx.s * STOT_LABEL_X + fx.t;
        const ey = fy.s * ref + fy.t;
        const hit = horizontal.find((i) => i.str.trim() === label && Math.abs(i.x - ex) < 6 && Math.abs(i.y - ey) < 5);
        if (hit) rowPairs.push({ ref, got: hit.y });
      }
    }
    if (rowPairs.length >= 4) fy = fitAxis([...found.map((f) => ({ ref: f.anchor.y, got: f.y })), ...rowPairs]);
  }

  const residual = Math.max(
    ...found.map((f) => Math.max(Math.abs(fx.s * f.anchor.x + fx.t - f.x), Math.abs(fy.s * f.anchor.y + fy.t - f.y))),
  );
  if (residual > 4) {
    // Drop labels that disagree with the rest (e.g. a stray match) and refit.
    const kept = found.filter(
      (f) => Math.abs(fx.s * f.anchor.x + fx.t - f.x) <= 4 && Math.abs(fy.s * f.anchor.y + fy.t - f.y) <= 4,
    );
    if (kept.length >= 3) {
      fx = fitAxis(kept.map((f) => ({ ref: f.anchor.x, got: f.x })));
      fy = fitAxis(kept.map((f) => ({ ref: f.anchor.y, got: f.y })));
    }
  }

  const tokens: Token[] = [];
  for (const item of horizontal) {
    for (const word of splitWords(item)) {
      const size = word.fontSize / fy.s;
      const x0 = (word.x - fx.t) / fx.s;
      tokens.push({
        str: word.str,
        x0,
        x1: x0 + word.w / fx.s,
        cy: (word.y - fy.t) / fy.s + 0.35 * size,
        size,
      });
    }
  }
  return { tokens, poorFit: residual > 8 || fx.poor || fy.poor };
}

function locateAnchors(items: readonly PdfTextItem[], anchors: readonly Anchor[]): Located[] {
  const candidates = anchors.map((anchor) => findLabel(items, anchor.label));
  // Rough shift from labels that appear exactly once, to choose among repeated matches.
  const dxs: number[] = [];
  const dys: number[] = [];
  candidates.forEach((c, i) => {
    if (c.exact.length === 1) {
      dxs.push(c.exact[0]!.x - anchors[i]!.x);
      dys.push(c.exact[0]!.y - anchors[i]!.y);
    }
  });
  const dx = median(dxs, 0);
  const dy = median(dys, 0);
  const located: Located[] = [];
  candidates.forEach((c, i) => {
    const anchor = anchors[i]!;
    const pool = c.exact.length > 0 ? c.exact : c.partial;
    let best: Point | null = null;
    let bestDist = 40;
    for (const p of pool) {
      const d = Math.hypot(p.x - (anchor.x + dx), p.y - (anchor.y + dy));
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    if (best) located.push({ anchor, x: best.x, y: best.y });
  });
  return located;
}

type Point = { x: number; y: number };

/** Where a label is printed: runs that are exactly the label, else runs or lines that contain it. */
function findLabel(items: readonly PdfTextItem[], label: string): { exact: Point[]; partial: Point[] } {
  const target = normalize(label);
  const exact: Point[] = [];
  const partial: Point[] = [];
  for (const item of items) {
    const n = normalize(item.str);
    if (n === target) exact.push({ x: item.x, y: item.y });
    else {
      const idx = n.indexOf(target);
      if (idx >= 0) partial.push({ x: item.x + idx * (item.w / Math.max(1, item.str.length)), y: item.y });
    }
  }
  if (exact.length > 0 || partial.length > 0) return { exact, partial };
  // The label may be split over several runs (other PDF producers).
  for (const line of groupLines(items)) {
    let joined = '';
    const starts: { at: number; item: PdfTextItem }[] = [];
    for (const item of line.items) {
      if (joined) joined += ' ';
      starts.push({ at: joined.length, item });
      joined += normalize(item.str);
    }
    const idx = joined.indexOf(target);
    if (idx < 0) continue;
    const host = [...starts].reverse().find((s) => s.at <= idx)!;
    const offset = idx - host.at;
    partial.push({ x: host.item.x + offset * (host.item.w / Math.max(1, host.item.str.length)), y: host.item.y });
  }
  return { exact, partial };
}

function fitAxis(pairs: readonly { ref: number; got: number }[]): { s: number; t: number; poor: boolean } {
  if (pairs.length === 0) return { s: 1, t: 0, poor: true };
  const refs = pairs.map((p) => p.ref);
  const spread = Math.max(...refs) - Math.min(...refs);
  if (pairs.length >= 2 && spread > 20) {
    const mr = sum(refs) / pairs.length;
    const mg = sum(pairs.map((p) => p.got)) / pairs.length;
    let cov = 0;
    let varr = 0;
    for (const p of pairs) {
      cov += (p.ref - mr) * (p.got - mg);
      varr += (p.ref - mr) ** 2;
    }
    const s = cov / varr;
    if (s > 0.85 && s < 1.15) return { s, t: mg - s * mr, poor: false };
  }
  return { s: 1, t: median(pairs.map((p) => p.got - p.ref), 0), poor: pairs.length < 2 };
}

// ---------------------------------------------------------------------------
// Reading regions

function tokensIn(frame: Frame, range: Range, y0: number, y1: number): Token[] {
  return frame.tokens.filter((t) => {
    const cx = (t.x0 + t.x1) / 2;
    return cx >= range.x0 && cx < range.x1 && t.cy >= y0 && t.cy < y1;
  });
}

/** Words in reading order: top line first, left to right. */
function textOf(tokens: readonly Token[]): string {
  const sorted = [...tokens].sort((a, b) => b.cy - a.cy || a.x0 - b.x0);
  const lines: Token[][] = [];
  for (const t of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0]!.cy - t.cy) <= 0.5 * Math.max(t.size, 1)) line.push(t);
    else lines.push([t]);
  }
  return lines
    .map((l) => l.sort((a, b) => a.x0 - b.x0).map((t) => t.str).join(' '))
    .join(' ')
    .trim();
}

function boxText(frame: Frame, box: Box): string | null {
  return textOf(tokensIn(frame, box, box.y0, box.y1)) || null;
}

/** The form prints its empty boxes as symbol-font glyphs (private-use code points) or ☐-style characters. */
const EMPTY_BOX_GLYPHS = /^[\uE000-\uF8FF\u2610\u25A1\u274F-\u2752]+$/;

/**
 * A box counts as checked when anything besides the form's own box glyph is
 * printed on it: an "X", a check mark character, or a second symbol glyph.
 */
function isChecked(frame: Frame, spot: CheckboxSpot): boolean {
  const cyBox = spot.y + CHECKBOX_CENTER_RISE * spot.size;
  const hits = frame.tokens.filter((t) => {
    const cx = (t.x0 + t.x1) / 2;
    return (
      cx >= spot.x - 1.5 &&
      cx <= spot.x + spot.size + 1.5 &&
      Math.abs(t.cy - cyBox) <= spot.size / 2 + 1.5 &&
      /[^\s_]/.test(t.str)
    );
  });
  return hits.some((t) => !EMPTY_BOX_GLYPHS.test(t.str)) || hits.length > 1;
}

interface NumberCell {
  values: number[];
  raw: string;
  /** Text that is not a number. */
  bad: boolean;
  /** Two values printed as "a/b" in one cell. */
  slashPair: boolean;
}

function readNumbers(tokens: readonly Token[]): NumberCell {
  const raw = textOf(tokens);
  const cleaned = raw.replace(/\$\s+/g, '$').trim();
  if (cleaned === '' || /^[-\u2013\u2014]+$/.test(cleaned)) return { values: [], raw, bad: false, slashPair: false };
  const slashPair = /\d\s*\/\s*[$\d.]/.test(cleaned);
  const parts = cleaned.split(/\s*\/\s*|\s+/).filter(Boolean);
  const values: number[] = [];
  let bad = false;
  for (const part of parts) {
    const n = parseAmount(part);
    if (n === null) bad = true;
    else values.push(n);
  }
  return { values, raw, bad, slashPair };
}

// ---------------------------------------------------------------------------
// Page 1

function readSheet(frame: Frame, pageNumber: number, sheetIndex: number, result: Wh347ParseResult): void {
  readSheetHeader(frame, sheetIndex, result);
  if (sheetIndex === 0) result.days = readDays(frame, result.meta.weekEnding);

  PAGE1_SLOTS.forEach((slot, slotIndex) => {
    const inSlot = frame.tokens.filter((t) => t.cy >= slot.bottom && t.cy < slot.top);
    const cells: Cells = new Map();
    let used = 0;
    for (const t of inSlot) {
      const col = columnOf(t);
      if (!col) continue;
      used++;
      let cell = cells.get(col);
      if (!cell) {
        cell = { st: [], ot: [], all: [], overflow: false };
        cells.set(col, cell);
      }
      cell.all.push(t);
      if (SPLIT_COLUMNS.has(col)) (t.cy >= slot.mid ? cell.st : cell.ot).push(t);
      if (runsIntoOtherColumn(t, col)) cell.overflow = true;
    }
    if (used === 0) return;
    if (/\bNO\s+WORK\b/i.test(textOf(inSlot))) {
      result.meta.noWork = true;
      return;
    }
    const line = readWorker(cells, result, {
      page: pageNumber,
      sheet: sheetIndex + 1,
      slot: slotIndex + 1,
    });
    result.lines.push(line);
  });
}

/** A word that reaches well into a neighbouring data column may belong there, or be two values run together. */
function runsIntoOtherColumn(t: Token, own: Page1Column): boolean {
  return (Object.entries(PAGE1_COLUMNS) as [Page1Column, Range][]).some(
    ([key, r]) => key !== own && Math.min(t.x1, r.x1) - Math.max(t.x0, r.x0) > 2,
  );
}

/** The data column a word belongs to: the one containing its centre, else the one it overlaps most. */
function columnOf(t: Token): Page1Column | null {
  const cx = (t.x0 + t.x1) / 2;
  let best: Page1Column | null = null;
  let bestOverlap = 0;
  for (const [key, r] of Object.entries(PAGE1_COLUMNS) as [Page1Column, Range][]) {
    if (cx >= r.x0 && cx < r.x1) return key;
    const overlap = Math.min(t.x1, r.x1) - Math.max(t.x0, r.x0);
    if (overlap > bestOverlap) {
      best = key;
      bestOverlap = overlap;
    }
  }
  return best;
}

function readSheetHeader(frame: Frame, sheetIndex: number, result: Wh347ParseResult): void {
  const read = {
    projectName: boxText(frame, PAGE1_HEADER.projectName),
    projectNumber: boxText(frame, PAGE1_HEADER.projectNumber),
    payrollNumber: boxText(frame, PAGE1_HEADER.payrollNumber),
    businessName: boxText(frame, PAGE1_HEADER.businessName),
    projectLocation: boxText(frame, PAGE1_HEADER.projectLocation),
    wdNumber: boxText(frame, PAGE1_HEADER.wdNumber),
    businessAddress: boxText(frame, PAGE1_HEADER.businessAddress),
  };
  const weekText = boxText(frame, PAGE1_HEADER.weekEnding);
  const weekEnding = weekText ? parseDateLoose(weekText) : null;
  const final = isChecked(frame, PAGE1_CHECKBOXES.final);
  const prime = isChecked(frame, PAGE1_CHECKBOXES.prime);
  const sub = isChecked(frame, PAGE1_CHECKBOXES.subcontractor);
  const role = prime && !sub ? 'prime' : sub && !prime ? 'subcontractor' : null;
  const meta = result.meta;

  if (sheetIndex === 0) {
    Object.assign(meta, read);
    meta.weekEnding = weekEnding;
    meta.isFinal = final;
    meta.contractorRole = role;
    if (weekText && !weekEnding) result.warnings.push(`The week ending date "${weekText}" could not be read as a date.`);
    if (!weekText) result.warnings.push('The week ending date is blank on the payroll sheet.');
    if (prime && sub) result.warnings.push('Both the prime contractor and subcontractor boxes are checked.');
    return;
  }

  const sheet = sheetIndex + 1;
  const compare: [string, string | null, string | null][] = [
    ['payroll number', meta.payrollNumber, read.payrollNumber],
    ['project number', meta.projectNumber, read.projectNumber],
    ['business name', meta.businessName, read.businessName],
    ['week ending date', meta.weekEnding, weekEnding],
  ];
  for (const [label, first, here] of compare) {
    if (first && here && normalize(first) !== normalize(here)) {
      result.warnings.push(`Sheet ${sheet} shows ${label} "${here}", but sheet 1 shows "${first}".`);
    }
  }
  for (const [key, value] of Object.entries(read) as [keyof typeof read, string | null][]) {
    if (meta[key] === null && value !== null) meta[key] = value;
  }
  if (meta.weekEnding === null && weekEnding) meta.weekEnding = weekEnding;
  if (final) meta.isFinal = true;
  if (meta.contractorRole === null) meta.contractorRole = role;
}

function readDays(frame: Frame, weekEnding: ISODate | null): { name: string | null; date: ISODate | null }[] {
  return DAY_COLUMNS.map((col) => {
    const range = PAGE1_COLUMNS[col];
    const name = textOf(tokensIn(frame, range, DAY_HEADER_ROWS.names.y0, DAY_HEADER_ROWS.names.y1)) || null;
    const dateText = textOf(tokensIn(frame, range, DAY_HEADER_ROWS.dates.y0, DAY_HEADER_ROWS.dates.y1));
    return { name, date: dateText ? dayDate(dateText, weekEnding) : null };
  });
}

/** Column (4) dates are often printed without a year; take the one nearest the week ending. */
function dayDate(text: string, weekEnding: ISODate | null): ISODate | null {
  const full = parseDateLoose(text);
  if (full) return full;
  const m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(text.trim());
  if (!m || !weekEnding) return null;
  const year = Number(weekEnding.slice(0, 4));
  let best: ISODate | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const iso = `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
    if (isIsoDate(iso) && Math.abs(daysBetween(iso, weekEnding)) <= 13) best = iso;
  }
  return best;
}

type Cells = Map<Page1Column, { st: Token[]; ot: Token[]; all: Token[]; overflow: boolean }>;

/** The PayrollLine field each column feeds, for lowConfidence entries. */
const COLUMN_FIELD: Record<Page1Column, string> = {
  entryNo: 'entryNo',
  lastName: 'workerName',
  firstName: 'workerName',
  middleInitial: 'workerName',
  workerId: 'workerId',
  journeyApprentice: 'apprentice',
  classification: 'classification',
  day0: 'dailyST[0]',
  day1: 'dailyST[1]',
  day2: 'dailyST[2]',
  day3: 'dailyST[3]',
  day4: 'dailyST[4]',
  day5: 'dailyST[5]',
  day6: 'dailyST[6]',
  totalHours: 'totalST',
  rate: 'rateST',
  fringePlanHourly: 'fringePlanHourly',
  fringeCashHourly: 'fringeCashHourly',
  grossThisProject: 'grossThisProject',
  grossAllWork: 'grossAllWork',
  taxWithholdings: 'deductionDetail.taxWithholdings',
  fica: 'deductionDetail.fica',
  otherDeductions: 'deductionDetail.other',
  deductions: 'deductions',
  netPay: 'netPay',
};

function readWorker(cells: Cells, result: Wh347ParseResult, source: Wh347Line['source']): Wh347Line {
  const row = result.lines.length;
  const flag = (field: string, reason: string) => result.lowConfidence.push({ row, field, reason });
  const text = (col: Page1Column) => textOf(cells.get(col)?.all ?? []);
  for (const [col, cell] of cells) {
    if (cell.overflow) flag(COLUMN_FIELD[col], `"${textOf(cell.all)}" runs into the next column; check it against the PDF.`);
  }

  const single = (col: Page1Column, field: string): number | null => {
    const cell = readNumbers(cells.get(col)?.all ?? []);
    if (cell.bad) flag(field, `"${cell.raw}" is not a number.`);
    if (cell.values.length > 1) flag(field, `Several values ("${cell.raw}"); used the first.`);
    return cell.values[0] ?? null;
  };

  const split = (col: Page1Column, field: string): { st: number | null; ot: number | null } => {
    const c = cells.get(col);
    const st = readNumbers(c?.st ?? []);
    const ot = readNumbers(c?.ot ?? []);
    for (const [cell, label] of [[st, 'straight-time'], [ot, 'overtime']] as const) {
      if (cell.bad) flag(field, `${label} entry "${cell.raw}" is not a number.`);
    }
    if (st.values.length === 2 && ot.values.length === 0) {
      if (!st.slashPair) flag(field, `Read "${st.raw}" as straight time and overtime.`);
      return { st: st.values[0]!, ot: st.values[1]! };
    }
    if (st.values.length > 1) flag(field, `Several straight-time values ("${st.raw}"); used the first.`);
    if (ot.values.length > 1) flag(field, `Several overtime values ("${ot.raw}"); used the first.`);
    return { st: st.values[0] ?? null, ot: ot.values[0] ?? null };
  };

  const lastName = text('lastName');
  const firstName = text('firstName');
  const middleInitial = text('middleInitial');
  const workerName = [lastName, [firstName, middleInitial].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (!workerName) flag('workerName', 'No worker name in columns (1B)–(1D).');

  const classification = text('classification');
  if (!classification) flag('classification', 'Column (3) labor classification is blank.');

  const ja = text('journeyApprentice').toUpperCase().replace(/[^A-Z]/g, '');
  let apprentice = false;
  if (/^(RA|A|AP|APP|APPR|APPRENTICE|REGISTEREDAPPRENTICE)$/.test(ja)) apprentice = true;
  else if (/^(J|JW|JM|JOURNEYWORKER|JOURNEYMAN|JOURNEYPERSON)$/.test(ja)) apprentice = false;
  else if (ja === '') {
    apprentice = /apprentice/i.test(classification);
    const treatedAs = apprentice ? 'an apprentice because the classification says so' : 'a journeyworker';
    flag('apprentice', `Column (2) is blank; treated as ${treatedAs}.`);
  } else {
    flag('apprentice', `Column (2) shows "${text('journeyApprentice')}"; treated as a journeyworker.`);
  }

  const dailyST: number[] = [];
  const dailyOT: number[] = [];
  DAY_COLUMNS.forEach((col, i) => {
    const v = split(col, `dailyST[${i}]`);
    dailyST.push(v.st ?? 0);
    dailyOT.push(v.ot ?? 0);
  });
  const sumST = roundHours(sum(dailyST));
  const sumOT = roundHours(sum(dailyOT));

  const totals = split('totalHours', 'totalST');
  let totalST = totals.st;
  let totalOT = totals.ot;
  if (totalST === null && totalOT === null) {
    totalST = sumST;
    totalOT = sumOT;
    if (sumST + sumOT > 0) flag('totalST', 'Column (5) is blank; totals were added up from the daily hours.');
  } else if (totalOT === null && sumOT > 0 && totalST !== null && Math.abs(totalST - (sumST + sumOT)) < 0.005) {
    totalST = sumST;
    totalOT = sumOT;
    flag('totalOT', 'Column (5) shows one combined total; split into straight time and overtime from the daily hours.');
  } else {
    if (totalST === null) {
      totalST = sumST;
      flag('totalST', 'Straight-time total is blank; added up from the daily hours.');
    }
    if (totalOT === null) {
      totalOT = sumOT;
      if (sumOT > 0) flag('totalOT', 'Overtime total is blank; added up from the daily hours.');
    }
  }

  const rates = split('rate', 'rateST');
  if (rates.st === null) flag('rateST', 'Column (6A) straight-time rate is blank.');

  const taxWithholdings = single('taxWithholdings', 'deductionDetail.taxWithholdings');
  const fica = single('fica', 'deductionDetail.fica');
  const other = single('otherDeductions', 'deductionDetail.other');
  let deductions = single('deductions', 'deductions');
  if (deductions === null && (taxWithholdings !== null || fica !== null || other !== null)) {
    deductions = cents((taxWithholdings ?? 0) + (fica ?? 0) + (other ?? 0));
    flag('deductions', 'Total deductions is blank; added up tax withholdings, FICA and other.');
  }

  const entryNo = text('entryNo') || null;

  return {
    workerName,
    workerId: text('workerId'),
    classification,
    apprentice,
    dailyST,
    dailyOT,
    totalST,
    totalOT,
    rateST: rates.st ?? 0,
    rateOT: rates.ot,
    fringePlanHourly: single('fringePlanHourly', 'fringePlanHourly') ?? 0,
    fringeCashHourly: single('fringeCashHourly', 'fringeCashHourly') ?? 0,
    grossThisProject: single('grossThisProject', 'grossThisProject'),
    grossAllWork: single('grossAllWork', 'grossAllWork'),
    deductions,
    netPay: single('netPay', 'netPay'),
    entryNo,
    lastName,
    firstName,
    middleInitial,
    deductionDetail: { taxWithholdings, fica, other },
    source,
  };
}

function roundHours(h: number): number {
  return Math.round(h * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Page 2

interface StatementPage extends Wh347Statement {
  official: string | null;
  projectName: string | null;
  businessName: string | null;
  projectLocation: string | null;
}

const PLACEHOLDER = /^[\s_()\-\u2013\u2014]*$/;

function readStatement(frame: Frame): StatementPage {
  const header = (field: keyof typeof PAGE2_HEADER) => boxText(frame, PAGE2_HEADER[field]);
  const statements = Object.fromEntries(
    STATEMENT_KEYS.map((k) => [k, isChecked(frame, STATEMENT_CHECKBOXES[k])]),
  ) as Record<StatementKey, boolean>;

  const apprenticePrograms: Wh347Statement['apprenticePrograms'] = [];
  for (const row of APPRENTICE_ROWS) {
    const name = boxText(frame, row.name);
    const classification = boxText(frame, row.classification);
    const oa = isChecked(frame, row.oa);
    const saa = isChecked(frame, row.saa);
    if (!name && !classification && !oa && !saa) continue;
    apprenticePrograms.push({
      name: name ?? '',
      registeredWith: oa && !saa ? 'OA' : saa && !oa ? 'SAA' : null,
      classification,
    });
  }

  const fringePlans = FRINGE_PLAN_COLUMNS.map((col) => {
    const funded = isChecked(frame, col.funded);
    const unfunded = isChecked(frame, col.unfunded);
    return {
      name: boxText(frame, col.name),
      type: boxText(frame, col.type),
      planNumber: boxText(frame, col.planNumber),
      funded: funded && !unfunded ? true : unfunded && !funded ? false : null,
    };
  });
  while (fringePlans.length > 0) {
    const last = fringePlans[fringePlans.length - 1]!;
    if (last.name || last.type || last.planNumber || last.funded !== null) break;
    fringePlans.pop();
  }

  const fringeCredits: Wh347Statement['fringeCredits'] = [];
  for (const row of FRINGE_ROWS) {
    const at = (range: Range) => tokensIn(frame, range, row.y0, row.y1);
    const workerName = textOf(at(FRINGE_WORKER_NAME));
    const credits = FRINGE_PLAN_COLUMNS.map((c) => readNumbers(at(c.credit)).values[0] ?? null);
    const total = readNumbers(at(FRINGE_TOTAL_CREDIT)).values[0] ?? null;
    if (!workerName && total === null && credits.every((c) => c === null)) continue;
    fringeCredits.push({ workerName, credits: credits.slice(0, Math.max(fringePlans.length, lastIndex(credits) + 1)), total });
  }

  const signature = boxText(frame, PAGE2_SIGNATURE_ROW.signature);
  const dateText = boxText(frame, PAGE2_SIGNATURE_ROW.date);
  const phoneTokens = tokensIn(frame, PAGE2_SIGNATURE_ROW.phone, PAGE2_SIGNATURE_ROW.phone.y0, PAGE2_SIGNATURE_ROW.phone.y1)
    .filter((t) => !PLACEHOLDER.test(t.str));
  const weekText = header('weekEnding');

  return {
    statements,
    apprenticePrograms,
    fringePlans,
    fringeCredits,
    signature,
    signatureDate: dateText ? parseDateLoose(dateText) : null,
    phone: textOf(phoneTokens) || null,
    email: boxText(frame, PAGE2_SIGNATURE_ROW.email),
    remarks: boxText(frame, PAGE2_REMARKS),
    official: header('certifyingOfficial'),
    projectName: header('projectName'),
    projectNumber: header('projectNumber'),
    payrollNumber: header('payrollNumber'),
    businessName: header('businessName'),
    projectLocation: header('projectLocation'),
    weekEnding: weekText ? parseDateLoose(weekText) : null,
  };
}

function lastIndex(values: readonly (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
}

function mergeStatements(pages: readonly StatementPage[]): Wh347Statement {
  const first = pages[0]!;
  const statements = Object.fromEntries(
    STATEMENT_KEYS.map((k) => [k, pages.some((p) => p.statements[k])]),
  ) as Record<StatementKey, boolean>;
  const signed = pages.find((p) => p.signature !== null);
  return {
    statements,
    apprenticePrograms: pages.flatMap((p) => p.apprenticePrograms),
    fringePlans: pages.find((p) => p.fringePlans.length > 0)?.fringePlans ?? [],
    fringeCredits: pages.flatMap((p) => p.fringeCredits),
    signature: signed?.signature ?? null,
    signatureDate: signed?.signatureDate ?? pages.find((p) => p.signatureDate)?.signatureDate ?? null,
    phone: pages.find((p) => p.phone)?.phone ?? null,
    email: pages.find((p) => p.email)?.email ?? null,
    remarks: pages.map((p) => p.remarks).filter(Boolean).join('\n') || null,
    projectNumber: first.projectNumber,
    payrollNumber: first.payrollNumber,
    weekEnding: first.weekEnding,
  };
}

/** Header fields missing from page 1 (or when page 1 is absent) come from page 2. */
function fillMissingMeta(meta: Wh347Meta, page: StatementPage): void {
  meta.projectName ??= page.projectName;
  meta.projectNumber ??= page.projectNumber;
  meta.payrollNumber ??= page.payrollNumber;
  meta.businessName ??= page.businessName;
  meta.projectLocation ??= page.projectLocation;
  meta.weekEnding ??= page.weekEnding;
}

/** Cross-checks between the Statement of Compliance and the payroll sheet that a reviewer would otherwise do by eye. */
function checkStatement(result: Wh347ParseResult): void {
  const st = result.statement!;
  const { meta, warnings, lines } = result;

  if (!st.signature) {
    warnings.push(
      'The signature box on page 2 has no typed signature. If the statement was signed by hand or with an image, confirm it on the PDF.',
    );
  }
  if (st.weekEnding && meta.weekEnding && st.weekEnding !== meta.weekEnding) {
    warnings.push(`Page 2 is for the week ending ${st.weekEnding}, but the payroll sheet shows ${meta.weekEnding}.`);
  }
  if (st.payrollNumber && meta.payrollNumber && normalize(st.payrollNumber) !== normalize(meta.payrollNumber)) {
    warnings.push(`Page 2 shows payroll number "${st.payrollNumber}", but the payroll sheet shows "${meta.payrollNumber}".`);
  }

  const unchecked: string[] = [];
  const labels: Record<StatementKey, string> = {
    correctAndComplete: 'payroll correct and complete',
    recordsComplete: 'records complete and available',
    classificationsAccurate: 'classifications accurate',
    apprenticesRegistered: 'apprentices registered',
    fringeBenefitsPaid: 'fringe benefits paid',
    fullWagesPaid: 'full weekly wages paid',
  };
  const needed: StatementKey[] = ['correctAndComplete', 'recordsComplete', 'classificationsAccurate', 'fullWagesPaid'];
  if (lines.some((l) => l.apprentice)) needed.push('apprenticesRegistered');
  if (lines.some((l) => l.fringePlanHourly > 0 || l.fringeCashHourly > 0)) needed.push('fringeBenefitsPaid');
  for (const key of needed) if (!st.statements[key]) unchecked.push(labels[key]);
  if (unchecked.length > 0) {
    warnings.push(
      `No mark was read in these Statement of Compliance boxes: ${unchecked.join('; ')}. Marks drawn as graphics cannot be read; confirm on the PDF.`,
    );
  }

  if (lines.some((l) => l.apprentice) && st.apprenticePrograms.length === 0) {
    warnings.push('Apprentices are listed on the payroll sheet, but page 2 names no registered apprenticeship program.');
  }

  const credited = lines.filter((l) => l.fringePlanHourly > 0);
  if (credited.length > 0 && st.fringeCredits.length === 0) {
    warnings.push('Column (6B) claims fringe benefit plan credits, but page 2 lists no plan credits for any worker.');
    return;
  }
  for (const row of st.fringeCredits) {
    const credits = row.credits.filter((c): c is number => c !== null);
    if (row.total !== null && credits.length > 0 && Math.abs(cents(sum(credits)) - row.total) > 0.005) {
      warnings.push(`Page 2: the plan credits for ${row.workerName || 'a worker'} do not add up to the total hourly credit.`);
    }
    const line = matchWorker(lines, row.workerName);
    const total = row.total ?? (credits.length > 0 ? cents(sum(credits)) : null);
    if (line && total !== null && Math.abs(total - line.fringePlanHourly) > 0.005) {
      warnings.push(
        `${line.workerName}: page 2 claims an hourly fringe credit of ${total.toFixed(2)}, but column (6B) shows ${line.fringePlanHourly.toFixed(2)}.`,
      );
    }
  }
}

function matchWorker(lines: readonly Wh347Line[], name: string): Wh347Line | null {
  const key = nameKey(name);
  if (!key) return null;
  return (
    lines.find((l) => nameKey(`${l.lastName}, ${l.firstName}`) === key) ??
    lines.find((l) => nameKey(l.workerName) === key) ??
    null
  );
}

function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

function median(values: readonly number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
