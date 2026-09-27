import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfText } from '../src/engine/pdf/extract';
import { importPayrollPdf } from '../src/engine/pdf/index';
import { defaultDays, fillWh347, formatAmountPlain, formatHoursPlain } from '../src/engine/pdf/wh347-fill';
import type { Wh347FillData, Wh347FillWorker } from '../src/engine/pdf/wh347-fill';
import { parseWh347, type Wh347Line } from '../src/engine/pdf/wh347-parse';
import { PAGE1_COLUMNS, PAGE1_SLOTS } from '../src/engine/pdf/wh347-layout';
import { cents, extend, sum } from '../src/engine/money';

const template = new Uint8Array(fs.readFileSync('public/forms/wh347-rev2025.pdf'));
const opts = { pdfjs };

// ---------------------------------------------------------------------------
// Fictional payroll builders

interface WorkerSpec {
  entryNo: string;
  lastName: string;
  firstName: string;
  middleInitial?: string;
  id: string;
  classification: string;
  apprentice?: boolean;
  rateST: number;
  rateOT?: number;
  dailyST: number[];
  dailyOT?: number[];
  plan?: number;
  cash?: number;
  otherWork?: number;
  otherDeduction?: number;
  fringeCredits?: (number | null)[];
}

function worker(s: WorkerSpec): Wh347FillWorker {
  const dailyST = [...s.dailyST, 0, 0, 0, 0, 0, 0, 0].slice(0, 7);
  const dailyOT = [...(s.dailyOT ?? []), 0, 0, 0, 0, 0, 0, 0].slice(0, 7);
  const totalST = sum(dailyST);
  const totalOT = sum(dailyOT);
  const cash = s.cash ?? 0;
  const rateOT = s.rateOT ?? (totalOT > 0 ? cents(s.rateST * 1.5) : null);
  const gross = cents(extend(totalST, s.rateST + cash) + (rateOT === null ? 0 : extend(totalOT, rateOT + cash)));
  const grossAll = cents(gross + (s.otherWork ?? 0));
  const tax = extend(grossAll, 0.11);
  const fica = extend(grossAll, 0.0765);
  const other = s.otherDeduction ?? 0;
  const deductions = cents(tax + fica + other);
  return {
    entryNo: s.entryNo,
    lastName: s.lastName,
    firstName: s.firstName,
    middleInitial: s.middleInitial ?? '',
    identifyingNumber: s.id,
    apprentice: s.apprentice ?? false,
    classification: s.classification,
    dailyST,
    dailyOT,
    totalST,
    totalOT,
    rateST: s.rateST,
    rateOT,
    fringePlanHourly: s.plan ?? 0,
    fringeCashHourly: cash,
    grossThisProject: gross,
    grossAllWork: grossAll,
    deductionDetail: { taxWithholdings: tax, fica, other: other || null },
    deductions,
    netPay: cents(grossAll - deductions),
    ...(s.fringeCredits ? { fringeCredits: s.fringeCredits } : {}),
  };
}

const official = {
  name: 'Marisol Quenneville',
  title: 'Payroll Manager',
  phone: '(555) 010-4471',
  email: 'payroll@birchline.example',
};

function payrollA(): Wh347FillData {
  return {
    projectName: 'Harlow Creek Water Main Replacement',
    projectNumber: 'B-26-DC-00-0001',
    projectLocation: 'Harlow, Sample County',
    wdNumber: 'XX20260047 Mod 2',
    payrollNumber: '7',
    weekEnding: '2026-07-11',
    businessName: 'Birchline Utility Contractors, LLC',
    businessAddress: '1400 Quarry Road, Harlow, SS 45000',
    contractorRole: 'prime',
    isFinal: false,
    certifyingOfficial: official,
    signed: true,
    signatureDate: '2026-07-14',
    fringePlans: [{ name: 'Tri-County Laborers Health Fund', type: 'Health', planNumber: 'TCL-501', funded: true }],
    workers: [
      worker({
        entryNo: '1',
        lastName: 'Okonkwo-Barrett',
        firstName: 'Renata',
        middleInitial: 'J',
        id: '4821',
        classification: 'Laborer Group 1',
        rateST: 26.85,
        dailyST: [0, 8, 8, 8, 8, 8],
        plan: 12.4,
      }),
      worker({
        entryNo: '2',
        lastName: 'Lindqvist',
        firstName: 'Tomas',
        id: '0937',
        classification: 'Power Equipment Operator Group 2',
        rateST: 39.65,
        dailyST: [0, 8, 8, 10, 8, 6],
        plan: 25.1,
      }),
      worker({
        entryNo: '3',
        lastName: 'Achterberg',
        firstName: 'Casey',
        middleInitial: 'M',
        id: '7710',
        classification: 'Electrician',
        rateST: 44,
        dailyST: [0, 7.5, 7.5, 7.25, 8, 0],
        cash: 22.32,
        otherWork: 312.5,
      }),
    ],
  };
}

function payrollB(): Wh347FillData {
  const lab = (entryNo: string, lastName: string, firstName: string, extra: Partial<WorkerSpec> = {}) =>
    worker({
      entryNo,
      lastName,
      firstName,
      id: String(1000 + Number(entryNo) * 37).slice(-4),
      classification: 'Laborer Group 2',
      rateST: 27.6,
      dailyST: [0, 8, 8, 8, 8, 8, 0],
      plan: 12.4,
      ...extra,
    });
  return {
    projectName: 'Pine County Lift Station No. 4',
    projectNumber: 'USDA-RD 55-017-2026',
    projectLocation: 'Pine County, Sample State',
    wdNumber: 'XX20260047',
    payrollNumber: '12',
    weekEnding: '2026-08-01',
    businessName: 'Kestrel Ridge Concrete & Pipe, Inc.',
    businessAddress: '77 Foundry Lane, Suite 3, Pine Hollow, SS 45012',
    contractorRole: 'subcontractor',
    isFinal: true,
    certifyingOfficial: { name: 'Desmond Oyelaran-Pike', title: 'Vice President, Operations', phone: '555-010-2290' },
    signed: true,
    apprenticePrograms: [
      { name: 'Sample State Laborers JATC', registeredWith: 'OA', classification: 'Laborer' },
      { name: 'Tri-County Carpenters Apprenticeship Trust', registeredWith: 'SAA', classification: 'Carpenter' },
    ],
    fringePlans: [
      { name: 'Laborers Health & Welfare', type: 'Health', planNumber: 'LHW-11', funded: true },
      { name: 'Laborers Pension Trust', type: 'Pension', planNumber: 'LPT-4', funded: true },
      { name: 'Company Vacation Plan', type: 'Vacation', planNumber: 'KR-VAC', funded: false },
    ],
    remarks: 'Saturday work authorized by the resident engineer.',
    workers: [
      lab('1', 'Abernathy', 'Joaquin', { dailyOT: [0, 0, 0, 0, 0, 0, 4], fringeCredits: [6.1, 5.2, 1.1] }),
      lab('2', 'Brisbois', 'Lena', { middleInitial: 'K', dailyST: [0, 8, 8, 8, 8, 8, 0], dailyOT: [0, 2, 2, 0, 0, 0, 0], fringeCredits: [6.1, 5.2, 1.1] }),
      lab('3', 'Castellanos-Reyes', 'Maximiliano', { apprentice: true, rateST: 16.56, plan: 7.44, fringeCredits: [3.66, 3.12, 0.66] }),
      lab('4', 'Dunleavy', 'Priya', { fringeCredits: [6.1, 5.2, 1.1], otherDeduction: 45 }),
      worker({
        entryNo: '5',
        lastName: 'Eskildsen',
        firstName: 'Hollis',
        id: '5521',
        classification: 'Carpenter (Including Form Work)',
        rateST: 31.4,
        dailyST: [0, 8, 8, 8, 8, 8],
        dailyOT: [0, 1.5, 0, 0, 0, 0, 5],
        cash: 18.65,
      }),
      worker({
        entryNo: '6',
        lastName: 'Fairweather',
        firstName: 'Odessa',
        middleInitial: 'R',
        id: '6604',
        classification: 'Carpenter Apprentice',
        apprentice: true,
        rateST: 18.84,
        dailyST: [0, 8, 8, 8, 8],
        plan: 11.19,
        fringeCredits: [5, 5, 1.19],
      }),
      lab('7', 'Grünewald', 'Anselm', { dailyST: [0, 10, 10, 10, 10], fringeCredits: [6.1, 5.2, 1.1] }),
      lab('8', "O'Rourke-Tan", 'Wen', { dailyST: [0, 8, 8, 8, 8, 8], dailyOT: [0, 0, 0, 0, 0, 0, 8], fringeCredits: [6.1, 5.2, 1.1] }),
      lab('9', 'Halvorsen', 'Ines', { apprentice: true, rateST: 19.32, plan: 8.68, dailyST: [0, 8, 8, 8, 8, 8, 0], fringeCredits: [4.27, 3.64, 0.77] }),
      worker({
        entryNo: '10',
        lastName: 'Iwu',
        firstName: 'Chidera',
        id: '9012',
        classification: 'Cement Mason/Concrete Finisher',
        rateST: 24.18,
        dailyST: [0, 8, 8, 8, 8, 8],
        dailyOT: [0, 0, 0, 0, 0, 2.75],
        cash: 6.12,
      }),
      lab('11', 'Jablonski', 'Theo', { dailyST: [0, 0, 0, 4, 8, 8], fringeCredits: [6.1, 5.2, 1.1] }),
    ],
  };
}

function payrollC(): Wh347FillData {
  return {
    ...payrollA(),
    payrollNumber: '8',
    weekEnding: '2026-07-18',
    signed: false,
    signatureDate: undefined,
    workers: payrollA().workers.slice(0, 2),
  };
}

function expectedLine(w: Wh347FillWorker): Partial<Wh347Line> {
  return {
    entryNo: w.entryNo,
    lastName: w.lastName,
    firstName: w.firstName,
    middleInitial: w.middleInitial,
    workerName: `${w.lastName}, ${[w.firstName, w.middleInitial].filter(Boolean).join(' ')}`,
    workerId: w.identifyingNumber,
    classification: w.classification,
    apprentice: w.apprentice,
    dailyST: [...w.dailyST],
    dailyOT: [...w.dailyOT],
    totalST: w.totalST,
    totalOT: w.totalOT,
    rateST: w.rateST,
    rateOT: w.rateOT,
    fringePlanHourly: w.fringePlanHourly,
    fringeCashHourly: w.fringeCashHourly,
    grossThisProject: w.grossThisProject,
    grossAllWork: w.grossAllWork,
    deductions: w.deductions,
    netPay: w.netPay,
    deductionDetail: {
      taxWithholdings: w.deductionDetail?.taxWithholdings ?? null,
      fica: w.deductionDetail?.fica ?? null,
      other: w.deductionDetail?.other ?? null,
    },
  };
}

function strip(line: Wh347Line): Partial<Wh347Line> {
  const { source: _source, ...rest } = line;
  return rest;
}

async function roundTrip(data: Wh347FillData) {
  const pdf = await fillWh347(template, data);
  return importPayrollPdf(pdf, opts);
}

// ---------------------------------------------------------------------------

describe('fillWh347 → importPayrollPdf round trip', () => {
  it('reads back a three-worker payroll exactly', async () => {
    const data = payrollA();
    const result = await roundTrip(data);

    expect(result.hasText).toBe(true);
    expect(result.recognized).toBe(true);
    expect(result.formRevision).toBe('rev-2025');
    expect(result.pageCount).toBe(2);
    expect(result.sheets).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.lowConfidence).toEqual([]);
    expect(result.meta).toEqual({
      projectName: data.projectName,
      projectNumber: data.projectNumber,
      projectLocation: data.projectLocation,
      wdNumber: data.wdNumber,
      payrollNumber: '7',
      weekEnding: '2026-07-11',
      businessName: data.businessName,
      businessAddress: data.businessAddress,
      contractorRole: 'prime',
      isFinal: false,
      noWork: false,
      signed: true,
      certifyingOfficial: 'Marisol Quenneville, Payroll Manager',
    });
    expect(result.days).toEqual(defaultDays('2026-07-11'));
    expect(result.lines.map(strip)).toEqual(data.workers.map(expectedLine));
    expect(result.lines.map((l) => l.source)).toEqual([
      { page: 1, sheet: 1, slot: 1 },
      { page: 1, sheet: 1, slot: 2 },
      { page: 1, sheet: 1, slot: 3 },
    ]);

    const st = result.statement!;
    expect(st.signature).toBe('Marisol Quenneville');
    expect(st.signatureDate).toBe('2026-07-14');
    expect(st.phone).toBe('(555) 010-4471');
    expect(st.email).toBe('payroll@birchline.example');
    expect(st.statements).toEqual({
      correctAndComplete: true,
      recordsComplete: true,
      classificationsAccurate: true,
      apprenticesRegistered: false,
      fringeBenefitsPaid: true,
      fullWagesPaid: true,
    });
    expect(st.fringePlans).toEqual([{ name: 'Tri-County Laborers Health Fund', type: 'Health', planNumber: 'TCL-501', funded: true }]);
    expect(st.fringeCredits).toEqual([
      { workerName: 'Okonkwo-Barrett, Renata', credits: [12.4], total: 12.4 },
      { workerName: 'Lindqvist, Tomas', credits: [25.1], total: 25.1 },
    ]);
    expect(st.apprenticePrograms).toEqual([]);
    expect(st.remarks).toBeNull();
  });

  it('reads eleven workers across two sheets with apprentices, overtime and cash fringe', async () => {
    const data = payrollB();
    const result = await roundTrip(data);

    expect(result.recognized).toBe(true);
    expect(result.sheets).toBe(2);
    // Two page-1 sheets, then page 2 and a continuation for the ninth fringe-credit row.
    expect(result.pageCount).toBe(4);
    expect(result.warnings).toEqual([]);
    expect(result.lowConfidence).toEqual([]);
    expect(result.lines).toHaveLength(11);
    const expected = data.workers.map(expectedLine);
    // "Grünewald" survives because ü is in the WinAnsi set the standard fonts cover.
    expect(result.lines.map(strip)).toEqual(expected);
    expect(result.lines[8]!.source).toEqual({ page: 2, sheet: 2, slot: 1 });
    expect(result.lines[10]!.source).toEqual({ page: 2, sheet: 2, slot: 3 });

    expect(result.meta.contractorRole).toBe('subcontractor');
    expect(result.meta.isFinal).toBe(true);
    expect(result.meta.signed).toBe(true);
    expect(result.meta.certifyingOfficial).toBe('Desmond Oyelaran-Pike, Vice President, Operations');
    expect(result.meta.businessName).toBe('Kestrel Ridge Concrete & Pipe, Inc.');

    const apprentices = result.lines.filter((l) => l.apprentice).map((l) => l.lastName);
    expect(apprentices).toEqual(['Castellanos-Reyes', 'Fairweather', 'Halvorsen']);
    const ot = result.lines.find((l) => l.lastName === 'Eskildsen')!;
    expect(ot.dailyOT).toEqual([0, 1.5, 0, 0, 0, 0, 5]);
    expect(ot.totalOT).toBe(6.5);
    expect(ot.rateOT).toBe(47.1);
    expect(ot.fringeCashHourly).toBe(18.65);

    const st = result.statement!;
    expect(st.apprenticePrograms).toEqual([
      { name: 'Sample State Laborers JATC', registeredWith: 'OA', classification: 'Laborer' },
      { name: 'Tri-County Carpenters Apprenticeship Trust', registeredWith: 'SAA', classification: 'Carpenter' },
    ]);
    expect(st.statements.apprenticesRegistered).toBe(true);
    expect(st.fringePlans).toEqual([
      { name: 'Laborers Health & Welfare', type: 'Health', planNumber: 'LHW-11', funded: true },
      { name: 'Laborers Pension Trust', type: 'Pension', planNumber: 'LPT-4', funded: true },
      { name: 'Company Vacation Plan', type: 'Vacation', planNumber: 'KR-VAC', funded: false },
    ]);
    const planWorkers = data.workers.filter((w) => w.fringePlanHourly > 0);
    expect(st.fringeCredits).toEqual(
      planWorkers.map((w) => ({
        workerName: `${w.lastName}, ${w.firstName}`,
        credits: [...w.fringeCredits!],
        total: w.fringePlanHourly,
      })),
    );
    expect(st.remarks).toContain('Saturday work authorized by the resident engineer.');
    expect(st.remarks).toContain('Continuation 2 of 2');
    expect(st.signatureDate).toBe('2026-08-01');
  });

  it('reports an unsigned Statement of Compliance', async () => {
    const data = payrollC();
    const result = await roundTrip(data);

    expect(result.recognized).toBe(true);
    expect(result.meta.signed).toBe(false);
    expect(result.statement!.signature).toBeNull();
    expect(result.statement!.signatureDate).toBeNull();
    expect(result.meta.certifyingOfficial).toBe('Marisol Quenneville, Payroll Manager');
    expect(result.meta.payrollNumber).toBe('8');
    expect(result.meta.weekEnding).toBe('2026-07-18');
    expect(result.lines.map(strip)).toEqual(data.workers.map(expectedLine));
    expect(result.lowConfidence).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no typed signature/);
  });

  it('still reads the form when the whole page is shifted and scaled', async () => {
    const data = payrollA();
    const filled = await fillWh347(template, data);
    const src = await PDFDocument.load(filled);
    const out = await PDFDocument.create();
    const embedded = await out.embedPages(src.getPages());
    for (const e of embedded) {
      const page = out.addPage([792, 612]);
      page.drawPage(e, { x: 9, y: -6, xScale: 0.975, yScale: 0.97 });
    }
    const result = await importPayrollPdf(await out.save(), opts);
    expect(result.recognized).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.lines.map(strip)).toEqual(data.workers.map(expectedLine));
    expect(result.meta.signed).toBe(true);
  });

  it('reads a form placed on a rotated portrait page', async () => {
    const data = payrollC();
    const filled = await fillWh347(template, data);
    const src = await PDFDocument.load(filled);
    const out = await PDFDocument.create();
    const embedded = await out.embedPages(src.getPages());
    for (const e of embedded) {
      const page = out.addPage([612, 792]);
      page.setRotation(degrees(90));
      page.drawPage(e, { x: 612, y: 0, rotate: degrees(90) });
    }
    const result = await importPayrollPdf(await out.save(), opts);
    expect(result.recognized).toBe(true);
    expect(result.lines.map(strip)).toEqual(data.workers.map(expectedLine));
  });

  it('draws nothing but headers for a payroll without workers, and still produces both pages', async () => {
    const data: Wh347FillData = { ...payrollA(), workers: [], fringePlans: [] };
    const result = await roundTrip(data);
    expect(result.pageCount).toBe(2);
    expect(result.lines).toEqual([]);
    expect(result.meta.projectName).toBe(data.projectName);
    expect(result.warnings.some((w) => /No worker rows/.test(w))).toBe(true);
  });

  it('rejects impossible fill data', async () => {
    await expect(fillWh347(template, { ...payrollA(), weekEnding: '2026-02-30' })).rejects.toThrow(/week ending/);
    const plans = Array.from({ length: 7 }, (_, i) => ({ name: `Plan ${i}`, type: 'Health', planNumber: String(i), funded: true }));
    await expect(fillWh347(template, { ...payrollA(), fringePlans: plans })).rejects.toThrow(/6 fringe benefit plans/);
    await expect(fillWh347(template.slice(0, 0), payrollA())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hand-drawn variants: what other payroll software prints onto the form

type Cell = { col: keyof typeof PAGE1_COLUMNS; text: string; row?: 'st' | 'ot' | 'full' };

async function drawOnForm(slots: Cell[][], extra?: (page: import('pdf-lib').PDFPage, font: import('pdf-lib').PDFFont) => void) {
  const doc = await PDFDocument.load(template);
  doc.removePage(1);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPage(0);
  slots.forEach((cells, i) => {
    const slot = PAGE1_SLOTS[i]!;
    for (const c of cells) {
      const r = PAGE1_COLUMNS[c.col];
      const size = 6;
      const w = font.widthOfTextAtSize(c.text, size);
      const cy = c.row === 'ot' ? (slot.bottom + slot.mid) / 2 : c.row === 'full' ? (slot.bottom + slot.top) / 2 : (slot.mid + slot.top) / 2;
      page.drawText(c.text, { x: (r.x0 + r.x1) / 2 - w / 2, y: cy - 0.35 * size, size, font });
    }
  });
  extra?.(page, font);
  return new Uint8Array(await doc.save());
}

const baseCells: Cell[] = [
  { col: 'entryNo', text: '1', row: 'full' },
  { col: 'lastName', text: 'Varga', row: 'full' },
  { col: 'firstName', text: 'Nell', row: 'full' },
  { col: 'workerId', text: '3310', row: 'full' },
  { col: 'journeyApprentice', text: 'J', row: 'full' },
  { col: 'classification', text: 'Laborer', row: 'full' },
  ...(['day1', 'day2', 'day3', 'day4', 'day5'] as const).map((col) => ({ col, text: '8.00', row: 'st' as const })),
];

describe('parseWh347 on payrolls printed by other software', () => {
  it('splits "26.85/40.28" printed in one cell, and reads "$" amounts and 40.00-style hours', async () => {
    const pdf = await drawOnForm([
      [
        ...baseCells,
        { col: 'day6', text: '2.00', row: 'ot' },
        { col: 'totalHours', text: '40.00/2.00', row: 'st' },
        { col: 'rate', text: '26.85/40.28', row: 'st' },
        { col: 'fringePlanHourly', text: '$12.40', row: 'full' },
        { col: 'fringeCashHourly', text: '$0.00', row: 'full' },
        { col: 'grossThisProject', text: '$1,154.56', row: 'full' },
        { col: 'netPay', text: '$ 902.10', row: 'full' },
      ],
    ]);
    const result = await importPayrollPdf(pdf, opts);
    const line = result.lines[0]!;
    expect(result.lines).toHaveLength(1);
    expect(line.dailyST).toEqual([0, 8, 8, 8, 8, 8, 0]);
    expect(line.dailyOT).toEqual([0, 0, 0, 0, 0, 0, 2]);
    expect(line.totalST).toBe(40);
    expect(line.totalOT).toBe(2);
    expect(line.rateST).toBe(26.85);
    expect(line.rateOT).toBe(40.28);
    expect(line.fringePlanHourly).toBe(12.4);
    expect(line.fringeCashHourly).toBe(0);
    expect(line.grossThisProject).toBe(1154.56);
    expect(line.netPay).toBe(902.1);
    expect(line.grossAllWork).toBeNull();
    expect(line.deductions).toBeNull();
    expect(result.lowConfidence).toEqual([]);
    // No page 2 in this PDF.
    expect(result.meta.signed).toBeNull();
    expect(result.warnings.some((w) => /Page 2 \(Statement of Compliance\) is not in this PDF/.test(w))).toBe(true);
  });

  it('flags cells it had to guess at', async () => {
    const pdf = await drawOnForm([
      [
        ...baseCells.filter((c) => c.col !== 'journeyApprentice'),
        { col: 'day6', text: '4', row: 'ot' },
        { col: 'totalHours', text: '44', row: 'st' },
        { col: 'rate', text: '26.8S', row: 'st' },
        { col: 'taxWithholdings', text: '100.00', row: 'full' },
        { col: 'fica', text: '80.00', row: 'full' },
      ],
      [
        { col: 'lastName', text: 'Wexley', row: 'full' },
        { col: 'classification', text: 'Laborer Apprentice', row: 'full' },
        ...(['day1', 'day2'] as const).map((col) => ({ col, text: '8', row: 'st' as const })),
        { col: 'rate', text: '18.00', row: 'st' },
      ],
    ]);
    const result = await importPayrollPdf(pdf, opts);
    expect(result.lines).toHaveLength(2);
    const [a, b] = result.lines;
    // One combined total in column (5) is split using the daily hours.
    expect(a!.totalST).toBe(40);
    expect(a!.totalOT).toBe(4);
    expect(a!.rateST).toBe(0);
    expect(a!.deductions).toBe(180);
    expect(b!.apprentice).toBe(true);
    expect(b!.totalST).toBe(16);
    expect(b!.workerName).toBe('Wexley');
    const fields = result.lowConfidence.map((f) => `${f.row}:${f.field}`);
    expect(fields).toEqual(
      expect.arrayContaining([
        '0:apprentice',
        '0:totalOT',
        '0:rateST',
        '0:deductions',
        '1:apprentice',
        '1:totalST',
      ]),
    );
    expect(result.lowConfidence.find((f) => f.row === 0 && f.field === 'rateST' && /not a number/.test(f.reason))).toBeTruthy();
  });

  it('recognizes a "no work performed" payroll', async () => {
    const pdf = await drawOnForm([], (page, font) => {
      page.drawText('*** NO WORK PERFORMED THIS WEEK ***', { x: 120, y: 312, size: 9, font });
    });
    const result = await importPayrollPdf(pdf, opts);
    expect(result.recognized).toBe(true);
    expect(result.meta.noWork).toBe(true);
    expect(result.lines).toEqual([]);
    expect(result.warnings.some((w) => /No worker rows/.test(w))).toBe(false);
  });

  it('reads the blank official form as a recognized, empty payroll', async () => {
    const result = await importPayrollPdf(template, opts);
    expect(result.recognized).toBe(true);
    expect(result.lines).toEqual([]);
    expect(result.meta.signed).toBe(false);
    expect(result.meta.projectName).toBeNull();
    expect(result.meta.weekEnding).toBeNull();
    expect(result.meta.contractorRole).toBeNull();
    expect(result.statement!.statements.correctAndComplete).toBe(false);
    expect(result.statement!.fringePlans).toEqual([]);
    expect(result.statement!.fringeCredits).toEqual([]);
    expect(result.statement!.phone).toBeNull();
    expect(result.days.every((d) => d.name === null && d.date === null)).toBe(true);
  });

  it('accepts a separate Statement of Compliance on its own', async () => {
    const filled = await fillWh347(template, payrollA());
    const src = await PDFDocument.load(filled);
    const out = await PDFDocument.create();
    const [p2] = await out.copyPages(src, [1]);
    out.addPage(p2!);
    const result = await importPayrollPdf(await out.save(), opts);
    expect(result.recognized).toBe(true);
    expect(result.sheets).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.meta.signed).toBe(true);
    expect(result.meta.payrollNumber).toBe('7');
    expect(result.meta.weekEnding).toBe('2026-07-11');
    expect(result.warnings.some((w) => /Only the Statement of Compliance/.test(w))).toBe(true);
  });

  it('warns when page 2 belongs to a different week or omits the 6B plan credits', async () => {
    const a = await fillWh347(template, payrollA());
    const c = await fillWh347(template, { ...payrollC(), fringePlans: [], workers: payrollA().workers });
    const docA = await PDFDocument.load(a);
    const docC = await PDFDocument.load(c);
    const out = await PDFDocument.create();
    const [sheet] = await out.copyPages(docA, [0]);
    const [statement] = await out.copyPages(docC, [1]);
    out.addPage(sheet!);
    out.addPage(statement!);
    const result = await importPayrollPdf(await out.save(), opts);
    expect(result.warnings.join('\n')).toMatch(/Page 2 is for the week ending 2026-07-18, but the payroll sheet shows 2026-07-11/);
    expect(result.warnings.join('\n')).toMatch(/payroll number "8"/);
    expect(result.warnings.join('\n')).toMatch(/signature/);
  });

  it('does not recognize other PDFs', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText('Invoice 2026-114 — Birchline Utility Contractors', { x: 72, y: 700, size: 12, font });
    page.drawText('PROJECT NAME: Harlow Creek   WEEK ENDING DATE: 7/11/2026', { x: 72, y: 680, size: 10, font });
    const result = await importPayrollPdf(await doc.save(), opts);
    expect(result.hasText).toBe(true);
    expect(result.recognized).toBe(false);
    expect(result.formRevision).toBeNull();
    expect(result.lines).toEqual([]);
    expect(result.warnings[0]).toMatch(/does not look like a WH-347/);
  });

  it('points out the pre-2025 WH-347', () => {
    const item = (str: string, y: number) => ({ str, x: 40, y, w: str.length * 4, h: 8, fontSize: 8, angle: 0 });
    const result = parseWh347([
      { width: 792, height: 612, items: [item('PAYROLL', 560), item('NO. OF WITHHOLDING EXEMPTIONS', 500)] },
    ]);
    expect(result.recognized).toBe(false);
    expect(result.warnings[0]).toMatch(/older WH-347/);
  });

  it('asks for keying when the PDF has no text layer', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([792, 612]);
    for (let i = 0; i < 20; i++) page.drawRectangle({ x: 40 + i * 30, y: 100 + i * 10, width: 20, height: 8 });
    const result = await importPayrollPdf(await doc.save(), opts);
    expect(result.hasText).toBe(false);
    expect(result.recognized).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no text layer.*Key the payroll in/);
  });

  it('handles an empty page list', () => {
    const result = parseWh347([]);
    expect(result.recognized).toBe(false);
    expect(result.lines).toEqual([]);
  });
});

describe('number formatting used on the form', () => {
  it.each([
    [8, '8'],
    [7.5, '7.5'],
    [7.25, '7.25'],
    [0, '0'],
  ])('hours %s → %s', (h, s) => expect(formatHoursPlain(h)).toBe(s));

  it.each([
    [26.85, '26.85'],
    [40.275, '40.275'],
    [1234.5, '1,234.50'],
    [1000000, '1,000,000.00'],
    [0, '0.00'],
    [-12.3, '-12.30'],
  ])('amount %s → %s', (v, s) => expect(formatAmountPlain(v)).toBe(s));
});

it.runIf(process.env.WH347_DUMP)('dumps samples', async () => {
  fs.writeFileSync(`${process.env.WH347_DUMP}/a.pdf`, await fillWh347(template, payrollA()));
  fs.writeFileSync(`${process.env.WH347_DUMP}/b.pdf`, await fillWh347(template, payrollB()));
});

describe('extractPdfText on the filled form', () => {
  it('leaves the caller\'s buffer usable', async () => {
    const pdf = await fillWh347(template, payrollC());
    const before = pdf.byteLength;
    await extractPdfText(pdf, opts);
    expect(pdf.byteLength).toBe(before);
    const again = await extractPdfText(pdf, opts);
    expect(again.pages).toHaveLength(2);
  });
});
