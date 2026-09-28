import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { addDays, formatDate, isIsoDate, weekday } from '../dates';
import type { Contractor, ISODate, Payroll, Project } from '../types';
import {
  APPRENTICE_ROWS,
  CHECKBOX_CENTER_RISE,
  DAY_COLUMNS,
  DAY_HEADER_ROWS,
  FORM_HEIGHT,
  FORM_WIDTH,
  FRINGE_PLAN_COLUMNS,
  FRINGE_PLAN_COUNT,
  FRINGE_ROWS,
  FRINGE_ROWS_PER_PAGE,
  FRINGE_TOTAL_CREDIT,
  FRINGE_WORKER_NAME,
  PAGE1_CHECKBOXES,
  PAGE1_COLUMNS,
  PAGE1_HEADER,
  PAGE1_SLOTS,
  PAGE2_HEADER,
  PAGE2_REMARKS,
  PAGE2_SIGNATURE_ROW,
  STATEMENT_CHECKBOXES,
  WORKERS_PER_SHEET,
  type Box,
  type CheckboxSpot,
  type Page1Column,
  type Range,
  type StatementKey,
} from './wh347-layout';

export interface Wh347Day {
  /** Day of week as printed at the top of column (4), e.g. "Sun". */
  name: string;
  date: ISODate;
}

export interface Wh347FillWorker {
  /** (1A) worker entry number. */
  entryNo: string;
  lastName: string;
  firstName: string;
  middleInitial: string;
  /** (1E) identifying number, e.g. the last four digits of the SSN. */
  identifyingNumber: string;
  /** (2) "RA" when true, "J" otherwise. */
  apprentice: boolean;
  classification: string;
  /** Straight-time hours for each of the seven days of column (4). */
  dailyST: readonly number[];
  dailyOT: readonly number[];
  totalST: number;
  totalOT: number;
  rateST: number;
  rateOT: number | null;
  /** (6B) hourly fringe benefit credit. */
  fringePlanHourly: number;
  /** (6C) hourly payment in lieu of fringe benefits. */
  fringeCashHourly: number;
  /** (7A) gross earned on this project. */
  grossThisProject: number | null;
  /** (7B) gross earned for all work. */
  grossAllWork: number | null;
  /** Column (8) breakdown; the total goes in `deductions`. */
  deductionDetail?: { taxWithholdings: number | null; fica: number | null; other: number | null };
  /** (8) total deductions. */
  deductions: number | null;
  /** (9) net pay. */
  netPay: number | null;
  /**
   * Page 2 hourly credit under each plan of Wh347FillData.fringePlans. When
   * omitted and exactly one plan is listed, the whole (6B) credit goes to it.
   */
  fringeCredits?: readonly (number | null)[];
}

export interface Wh347FringePlan {
  name: string;
  type: string;
  planNumber: string;
  funded: boolean;
}

export interface Wh347ApprenticeProgram {
  name: string;
  registeredWith: 'OA' | 'SAA';
  classification: string;
}

export interface Wh347FillData {
  projectName: string;
  projectNumber: string;
  projectLocation: string;
  wdNumber: string;
  payrollNumber: string;
  weekEnding: ISODate;
  businessName: string;
  businessAddress: string;
  contractorRole: 'prime' | 'subcontractor';
  isFinal: boolean;
  /** Days of column (4); defaults to the seven days ending on weekEnding. */
  days?: readonly Wh347Day[];
  workers: readonly Wh347FillWorker[];
  certifyingOfficial: { name: string; title: string; phone?: string; email?: string };
  /** When false the signature and signature date are left blank. */
  signed: boolean;
  /** Date next to the signature; defaults to weekEnding. */
  signatureDate?: ISODate;
  apprenticePrograms?: readonly Wh347ApprenticeProgram[];
  /** Up to six fringe benefit plans for the page 2 hourly credit table. */
  fringePlans?: readonly Wh347FringePlan[];
  remarks?: string;
}

const INK = rgb(0.05, 0.08, 0.3);
/** Fill colour of the form's entry boxes, used to cover the printed telephone placeholder. */
const BOX_FILL = rgb(251 / 255, 228 / 255, 213 / 255);
const SHORT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  signature: PDFFont;
}

/**
 * Draw a complete certified payroll onto the official WH-347 (Rev. January
 * 2025) template: one page-1 sheet per eight workers, then page 2 with the
 * Statement of Compliance (repeated only when the fringe credit table needs
 * more than eight rows). Used for demonstration data and as the round-trip
 * fixture for the PDF reader.
 */
export async function fillWh347(template: Uint8Array, data: Wh347FillData): Promise<Uint8Array> {
  validate(data);
  const src = await PDFDocument.load(template);
  if (src.getPageCount() < 2) throw new Error('The WH-347 template must have two pages.');
  const out = await PDFDocument.create();
  const [sheetForm, statementForm] = await out.embedPages([src.getPage(0), src.getPage(1)]);
  const fonts: Fonts = {
    regular: await out.embedFont(StandardFonts.Helvetica),
    bold: await out.embedFont(StandardFonts.HelveticaBold),
    signature: await out.embedFont(StandardFonts.HelveticaOblique),
  };
  const days = data.days ?? defaultDays(data.weekEnding);

  const sheetCount = Math.max(1, Math.ceil(data.workers.length / WORKERS_PER_SHEET));
  for (let s = 0; s < sheetCount; s++) {
    const page = out.addPage([FORM_WIDTH, FORM_HEIGHT]);
    page.drawPage(sheetForm!);
    drawSheet(page, fonts, data, days, data.workers.slice(s * WORKERS_PER_SHEET, (s + 1) * WORKERS_PER_SHEET));
  }

  const fringeWorkers = data.workers.filter((w) => w.fringePlanHourly > 0);
  const statementCount = Math.max(1, Math.ceil(fringeWorkers.length / FRINGE_ROWS_PER_PAGE));
  for (let s = 0; s < statementCount; s++) {
    const page = out.addPage([FORM_WIDTH, FORM_HEIGHT]);
    page.drawPage(statementForm!);
    const rows = fringeWorkers.slice(s * FRINGE_ROWS_PER_PAGE, (s + 1) * FRINGE_ROWS_PER_PAGE);
    drawStatement(page, fonts, data, rows, s, statementCount);
  }

  out.setTitle(`WH-347 certified payroll ${data.payrollNumber}, ${data.businessName}, week ending ${formatDate(data.weekEnding)}`);
  out.setCreator('Wagebench');
  out.setProducer('Wagebench');
  return out.save();
}

function validate(data: Wh347FillData): void {
  if (!isIsoDate(data.weekEnding)) throw new Error(`Invalid week ending date: ${data.weekEnding}`);
  if ((data.fringePlans?.length ?? 0) > FRINGE_PLAN_COUNT) {
    throw new Error(`The WH-347 has room for ${FRINGE_PLAN_COUNT} fringe benefit plans; got ${data.fringePlans!.length}.`);
  }
  if (data.days && data.days.length !== 7) throw new Error('Column (4) needs exactly seven days.');
  for (const w of data.workers) {
    if (w.dailyST.length > 7 || w.dailyOT.length > 7) {
      throw new Error(`Worker ${w.entryNo}: daily hours have more than seven entries.`);
    }
  }
}

export interface Wh347FromPayrollInput {
  project: Pick<Project, 'name' | 'projectNumber' | 'location'>;
  contractor: Pick<Contractor, 'name' | 'address' | 'tier' | 'apprenticePrograms'>;
  payroll: Pick<Payroll, 'payrollNumber' | 'weekEnding' | 'isFinal' | 'statementOfComplianceSigned' | 'lines'>;
  wdNumber: string;
  certifyingOfficial: Wh347FillData['certifyingOfficial'];
  fringePlans?: readonly Wh347FringePlan[];
  remarks?: string;
}

/**
 * Lay out a stored payroll as WH-347 fill data, so demonstration payrolls can
 * be handed out as the PDF a contractor would send. Worker names are split
 * into last, first and middle initial the way the form asks for them.
 */
export function wh347FromPayroll(input: Wh347FromPayrollInput): Wh347FillData {
  const { project, contractor, payroll } = input;
  const seven = (values: readonly number[]) => Array.from({ length: 7 }, (_, i) => values[i] ?? 0);
  return {
    projectName: project.name,
    projectNumber: project.projectNumber,
    projectLocation: project.location,
    wdNumber: input.wdNumber,
    payrollNumber: payroll.payrollNumber,
    weekEnding: payroll.weekEnding,
    businessName: contractor.name,
    businessAddress: contractor.address,
    contractorRole: contractor.tier === 'prime' ? 'prime' : 'subcontractor',
    isFinal: payroll.isFinal,
    certifyingOfficial: input.certifyingOfficial,
    signed: payroll.statementOfComplianceSigned,
    apprenticePrograms: contractor.apprenticePrograms.map((p) => ({
      name: p.name,
      registeredWith: p.registeredWith,
      classification: p.classification,
    })),
    ...(input.fringePlans ? { fringePlans: input.fringePlans } : {}),
    ...(input.remarks ? { remarks: input.remarks } : {}),
    workers: payroll.lines.map((line, i) => {
      const name = splitWorkerName(line.workerName);
      return {
        entryNo: String(i + 1),
        lastName: name.last,
        firstName: name.first,
        middleInitial: name.middleInitial,
        identifyingNumber: line.workerId,
        apprentice: line.apprentice,
        classification: line.classification,
        dailyST: seven(line.dailyST),
        dailyOT: seven(line.dailyOT),
        totalST: line.totalST,
        totalOT: line.totalOT,
        rateST: line.rateST,
        rateOT: line.rateOT,
        fringePlanHourly: line.fringePlanHourly,
        fringeCashHourly: line.fringeCashHourly,
        grossThisProject: line.grossThisProject,
        grossAllWork: line.grossAllWork,
        deductions: line.deductions,
        netPay: line.netPay,
      };
    }),
  };
}

/** "Okafor, Renata J" or "Renata J Okafor" → last, first, middle initial. */
export function splitWorkerName(name: string): { last: string; first: string; middleInitial: string } {
  const clean = name.replace(/\s+/g, ' ').trim();
  const initial = (t: string | undefined) => (t && /^[A-Za-z]\.?$/.test(t) ? t : '');
  const comma = /^([^,]+),\s*(.*)$/.exec(clean);
  if (comma) {
    const rest = comma[2]!.split(' ').filter(Boolean);
    const mi = rest.length > 1 ? initial(rest[rest.length - 1]) : '';
    return { last: comma[1]!.trim(), first: (mi ? rest.slice(0, -1) : rest).join(' '), middleInitial: mi };
  }
  const tokens = clean.split(' ').filter(Boolean);
  if (tokens.length <= 1) return { last: tokens[0] ?? '', first: '', middleInitial: '' };
  const mi = tokens.length > 2 ? initial(tokens[1]) : '';
  return {
    first: tokens[0]!,
    middleInitial: mi,
    last: tokens.slice(mi ? 2 : 1).join(' '),
  };
}

/** The seven days ending on the week-ending date, as printed at the top of column (4). */
export function defaultDays(weekEnding: ISODate): Wh347Day[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekEnding, i - 6);
    return { name: SHORT_DAY_NAMES[weekday(date)]!, date };
  });
}

// ---------------------------------------------------------------------------
// Page 1

function drawSheet(
  page: PDFPage,
  fonts: Fonts,
  data: Wh347FillData,
  days: readonly Wh347Day[],
  workers: readonly Wh347FillWorker[],
): void {
  const header: Record<keyof typeof PAGE1_HEADER, string> = {
    projectName: data.projectName,
    projectNumber: data.projectNumber,
    payrollNumber: data.payrollNumber,
    businessName: data.businessName,
    projectLocation: data.projectLocation,
    wdNumber: data.wdNumber,
    weekEnding: formatDate(data.weekEnding),
    businessAddress: data.businessAddress,
  };
  for (const [field, value] of Object.entries(header) as [keyof typeof PAGE1_HEADER, string][]) {
    drawInBox(page, value, PAGE1_HEADER[field], HEADER_STYLE(fonts));
  }
  if (data.isFinal) drawMark(page, fonts.bold, PAGE1_CHECKBOXES.final);
  drawMark(page, fonts.bold, data.contractorRole === 'prime' ? PAGE1_CHECKBOXES.prime : PAGE1_CHECKBOXES.subcontractor);

  // One size for the whole heading row reads better than each cell shrinking on its own.
  const narrowest = Math.min(...DAY_COLUMNS.map((c) => PAGE1_COLUMNS[c].x1 - PAGE1_COLUMNS[c].x0)) - 2 * PAD;
  const nameSize = fitSize(days.map((d) => d.name), fonts.regular, narrowest, 5.5, 3.5);
  const dateSize = fitSize(days.map((d) => shortDate(d.date)), fonts.regular, narrowest, 5.5, 3.5);
  DAY_COLUMNS.forEach((col, i) => {
    const day = days[i];
    if (!day) return;
    const range = PAGE1_COLUMNS[col];
    drawInBox(page, day.name, { ...range, ...DAY_HEADER_ROWS.names }, { font: fonts.regular, size: nameSize });
    drawInBox(page, shortDate(day.date), { ...range, ...DAY_HEADER_ROWS.dates }, { font: fonts.regular, size: dateSize });
  });

  workers.forEach((w, i) => drawWorker(page, fonts.regular, w, PAGE1_SLOTS[i]!));
}

function drawWorker(
  page: PDFPage,
  font: PDFFont,
  w: Wh347FillWorker,
  slot: { top: number; mid: number; bottom: number },
): void {
  const full = (col: Page1Column): Box => ({ ...PAGE1_COLUMNS[col], y0: slot.bottom, y1: slot.top });
  const st = (col: Page1Column): Box => ({ ...PAGE1_COLUMNS[col], y0: slot.mid, y1: slot.top });
  const ot = (col: Page1Column): Box => ({ ...PAGE1_COLUMNS[col], y0: slot.bottom, y1: slot.mid });
  const text = { font, size: 7, minSize: 4, maxLines: 3 };
  const num = { font, size: 6.5, minSize: 3.5 };

  drawInBox(page, w.entryNo, full('entryNo'), text);
  drawInBox(page, w.lastName, full('lastName'), { ...text, align: 'left' });
  drawInBox(page, w.firstName, full('firstName'), { ...text, align: 'left' });
  drawInBox(page, w.middleInitial, full('middleInitial'), text);
  drawInBox(page, w.identifyingNumber, full('workerId'), text);
  drawInBox(page, w.apprentice ? 'RA' : 'J', full('journeyApprentice'), text);
  drawInBox(page, w.classification, full('classification'), { ...text, size: 6, align: 'left' });

  DAY_COLUMNS.forEach((col, i) => {
    const hST = w.dailyST[i] ?? 0;
    const hOT = w.dailyOT[i] ?? 0;
    if (hST !== 0) drawInBox(page, formatHoursPlain(hST), st(col), { ...num, size: 6 });
    if (hOT !== 0) drawInBox(page, formatHoursPlain(hOT), ot(col), { ...num, size: 6 });
  });
  drawInBox(page, formatHoursPlain(w.totalST), st('totalHours'), num);
  drawInBox(page, formatHoursPlain(w.totalOT), ot('totalHours'), num);
  drawInBox(page, formatAmountPlain(w.rateST), st('rate'), num);
  if (w.rateOT !== null) drawInBox(page, formatAmountPlain(w.rateOT), ot('rate'), num);
  drawInBox(page, formatAmountPlain(w.fringePlanHourly), full('fringePlanHourly'), num);
  drawInBox(page, formatAmountPlain(w.fringeCashHourly), full('fringeCashHourly'), num);

  const optional: [Page1Column, number | null | undefined][] = [
    ['grossThisProject', w.grossThisProject],
    ['grossAllWork', w.grossAllWork],
    ['taxWithholdings', w.deductionDetail?.taxWithholdings],
    ['fica', w.deductionDetail?.fica],
    ['otherDeductions', w.deductionDetail?.other],
    ['deductions', w.deductions],
    ['netPay', w.netPay],
  ];
  for (const [col, value] of optional) {
    if (value !== null && value !== undefined) drawInBox(page, formatAmountPlain(value), full(col), num);
  }
}

// ---------------------------------------------------------------------------
// Page 2

function drawStatement(
  page: PDFPage,
  fonts: Fonts,
  data: Wh347FillData,
  fringeRows: readonly Wh347FillWorker[],
  index: number,
  count: number,
): void {
  const official = [data.certifyingOfficial.name, data.certifyingOfficial.title].filter(Boolean).join(', ');
  const header: Record<keyof typeof PAGE2_HEADER, string> = {
    projectName: data.projectName,
    projectNumber: data.projectNumber,
    payrollNumber: data.payrollNumber,
    businessName: data.businessName,
    projectLocation: data.projectLocation,
    weekEnding: formatDate(data.weekEnding),
    certifyingOfficial: official,
  };
  for (const [field, value] of Object.entries(header) as [keyof typeof PAGE2_HEADER, string][]) {
    drawInBox(page, value, PAGE2_HEADER[field], HEADER_STYLE(fonts));
  }

  const plans = data.fringePlans ?? [];
  const programs = data.apprenticePrograms ?? [];
  const remarks: string[] = [];

  if (index === 0) {
    const statements: Record<StatementKey, boolean> = {
      correctAndComplete: true,
      recordsComplete: true,
      classificationsAccurate: true,
      apprenticesRegistered: programs.length > 0 || data.workers.some((w) => w.apprentice),
      fringeBenefitsPaid: data.workers.some((w) => w.fringePlanHourly > 0 || w.fringeCashHourly > 0),
      fullWagesPaid: true,
    };
    for (const [key, checked] of Object.entries(statements) as [StatementKey, boolean][]) {
      if (checked) drawMark(page, fonts.bold, STATEMENT_CHECKBOXES[key]);
    }

    programs.slice(0, APPRENTICE_ROWS.length).forEach((p, i) => {
      const row = APPRENTICE_ROWS[i]!;
      drawInBox(page, p.name, row.name, { font: fonts.regular, size: 7, minSize: 4.5, align: 'left' });
      drawInBox(page, p.classification, row.classification, { font: fonts.regular, size: 7, minSize: 4.5, align: 'left' });
      drawMark(page, fonts.bold, p.registeredWith === 'OA' ? row.oa : row.saa);
    });
    const extra = programs.slice(APPRENTICE_ROWS.length);
    if (extra.length > 0) {
      remarks.push(
        `Additional apprenticeship programs: ${extra.map((p) => `${p.name} (${p.registeredWith}, ${p.classification})`).join('; ')}.`,
      );
    }

    if (data.signed) {
      drawInBox(page, data.certifyingOfficial.name, PAGE2_SIGNATURE_ROW.signature, {
        font: fonts.signature,
        size: 12,
        minSize: 7,
        align: 'left',
        pad: 6,
      });
      drawInBox(page, formatDate(data.signatureDate ?? data.weekEnding), PAGE2_SIGNATURE_ROW.date, {
        font: fonts.regular,
        size: 8,
        minSize: 5,
      });
    }
    const contact = { font: fonts.regular, size: 8, minSize: 5, align: 'left' as const, pad: 3.5 };
    if (data.certifyingOfficial.phone) {
      // Cover the printed "( __ __ __ ) __ __ __ – __ __ __ __" guide so the number stays legible.
      const box = PAGE2_SIGNATURE_ROW.phone;
      page.drawRectangle({ x: box.x0 + 1.2, y: box.y0 + 1, width: box.x1 - box.x0 - 2.4, height: box.y1 - box.y0 - 2, color: BOX_FILL });
      drawInBox(page, data.certifyingOfficial.phone, box, contact);
    }
    if (data.certifyingOfficial.email) drawInBox(page, data.certifyingOfficial.email, PAGE2_SIGNATURE_ROW.email, contact);
    if (data.remarks) remarks.unshift(data.remarks);
  } else {
    remarks.push(`Continuation ${index + 1} of ${count}: hourly fringe benefit credits for further workers.`);
  }

  if (fringeRows.length > 0) {
    plans.forEach((plan, i) => {
      const col = FRINGE_PLAN_COLUMNS[i]!;
      const cell = { font: fonts.regular, size: 6, minSize: 3.5, align: 'left' as const };
      drawInBox(page, plan.name, col.name, { ...cell, maxLines: 2 });
      drawInBox(page, plan.type, col.type, cell);
      drawInBox(page, plan.planNumber, col.planNumber, cell);
      drawMark(page, fonts.bold, plan.funded ? col.funded : col.unfunded);
    });
    fringeRows.forEach((w, r) => {
      const row = FRINGE_ROWS[r]!;
      const at = (range: Range): Box => ({ ...range, y0: row.y0, y1: row.y1 });
      const num = { font: fonts.regular, size: 6.5, minSize: 3.5 };
      drawInBox(page, `${w.lastName}, ${w.firstName}`, at(FRINGE_WORKER_NAME), {
        font: fonts.regular,
        size: 6.5,
        minSize: 3.5,
        align: 'left',
      });
      const credits = w.fringeCredits ?? (plans.length === 1 ? [w.fringePlanHourly] : []);
      credits.slice(0, FRINGE_PLAN_COUNT).forEach((credit, i) => {
        if (credit === null || credit === undefined) return;
        drawInBox(page, formatAmountPlain(credit), at(FRINGE_PLAN_COLUMNS[i]!.credit), num);
      });
      drawInBox(page, formatAmountPlain(w.fringePlanHourly), at(FRINGE_TOTAL_CREDIT), num);
    });
  }

  if (remarks.length > 0) {
    const style: TextStyle = { font: fonts.regular, size: 7.5, minSize: 5, maxLines: 3, align: 'left', pad: 3.5 };
    drawInBox(page, remarks.join(' '), PAGE2_REMARKS, style);
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers

interface TextStyle {
  font: PDFFont;
  size: number;
  minSize?: number;
  maxLines?: number;
  align?: 'left' | 'center';
  /** Horizontal inset from the box edges (default 1.5 pt). */
  pad?: number;
}

const PAD = 1.5;
const HEADER_STYLE = (fonts: Fonts): TextStyle => ({ font: fonts.regular, size: 8, minSize: 5, maxLines: 2, align: 'left', pad: 3.5 });
const LINE_HEIGHT = 1.12;
const CAP_CENTER = 0.35;

/**
 * Draw text inside a box, shrinking the font (down to minSize) and wrapping
 * at spaces (up to maxLines) until it fits. Lines are centred vertically so
 * each baseline sits where the reader expects the middle of the cell.
 */
function drawInBox(page: PDFPage, value: string, box: Box, style: TextStyle): void {
  const text = encodable(style.font, value).replace(/\s+/g, ' ').trim();
  if (!text) return;
  const pad = style.pad ?? PAD;
  const width = box.x1 - box.x0 - 2 * pad;
  const height = box.y1 - box.y0;
  const maxLines = style.maxLines ?? 1;
  const minSize = style.minSize ?? style.size;

  let size = style.size;
  let lines = wrap(text, style.font, size, width, maxLines);
  while (size > minSize && !fits(lines, style.font, size, width, height, maxLines)) {
    size = Math.max(minSize, Math.round((size - 0.25) * 100) / 100);
    lines = wrap(text, style.font, size, width, maxLines);
  }

  const lineHeight = size * LINE_HEIGHT;
  const centerY = (box.y0 + box.y1) / 2;
  lines.forEach((line, i) => {
    const lineWidth = style.font.widthOfTextAtSize(line, size);
    const x = style.align === 'left' ? box.x0 + pad : box.x0 + (box.x1 - box.x0 - lineWidth) / 2;
    const y = centerY + ((lines.length - 1) / 2 - i) * lineHeight - CAP_CENTER * size;
    page.drawText(line, { x, y, size, font: style.font, color: INK });
  });
}

/** Largest size (in quarter points) at which every text fits the width on one line. */
function fitSize(texts: readonly string[], font: PDFFont, width: number, max: number, min: number): number {
  let size = max;
  while (size > min && texts.some((t) => font.widthOfTextAtSize(encodable(font, t), size) > width)) size -= 0.25;
  return size;
}

function fits(lines: readonly string[], font: PDFFont, size: number, width: number, height: number, maxLines: number): boolean {
  if (lines.length > maxLines) return false;
  if (lines.length * size * LINE_HEIGHT > height + 0.5) return false;
  return lines.every((l) => font.widthOfTextAtSize(l, size) <= width);
}

/** Greedy word wrap; returns more than maxLines lines when the text cannot fit. */
function wrap(text: string, font: PDFFont, size: number, width: number, maxLines: number): string[] {
  if (maxLines <= 1 || font.widthOfTextAtSize(text, size) <= width) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawMark(page: PDFPage, font: PDFFont, spot: CheckboxSpot): void {
  const size = spot.size * 0.9;
  const cx = spot.x + spot.size / 2;
  const cy = spot.y + CHECKBOX_CENTER_RISE * spot.size;
  page.drawText('X', { x: cx - font.widthOfTextAtSize('X', size) / 2, y: cy - 0.36 * size, size, font, color: INK });
}

const charsets = new WeakMap<PDFFont, Set<number>>();

/** Standard PDF fonts only cover WinAnsi; fold accents and replace anything else so drawing never throws. */
function encodable(font: PDFFont, text: string): string {
  let set = charsets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsets.set(font, set);
  }
  const supported = set;
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (supported.has(code)) out += ch;
    else if (/\s/.test(ch)) out += ' ';
    else {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += base && [...base].every((c) => supported.has(c.codePointAt(0)!)) ? base : '?';
    }
  }
  return out;
}

function shortDate(date: ISODate): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** Hours without trailing zeros ("8", "7.5", "7.25"). */
export function formatHoursPlain(hours: number): string {
  return String(Number(hours.toFixed(3)));
}

/**
 * Amount with thousands separators and at least two decimals, keeping a
 * third or fourth decimal when present so rates like 40.275 print exactly.
 */
export function formatAmountPlain(value: number): string {
  const negative = value < 0;
  let [whole = '0', frac = ''] = Math.abs(value).toFixed(4).split('.');
  frac = frac.replace(/0+$/, '').padEnd(2, '0');
  whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
