import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { evaluateProject } from '../src/engine/checks/evaluate';
import { buildLedger } from '../src/engine/restitution';
import { normalizeLabel } from '../src/engine/mapping';
import { parseWageDetermination } from '../src/engine/wd/parse';
import type {
  ClassificationMapping,
  Contractor,
  Finding,
  Payroll,
  PayrollLine,
  Project,
  RestitutionRecord,
} from '../src/engine/types';
import { NOT_ON_WD } from '../src/engine/types';
import {
  buildStampedPayroll,
  buildStampedPayrollPdf,
  reviewNotation,
  reviewResult,
  type StampContext,
} from '../src/engine/docs/stamp';
import {
  composeLetter,
  letterBlocks,
  letterPayrollSummaries,
  letterToDocx,
  letterToPdf,
  letterToText,
  type Letter,
  type LetterContext,
  type LetterKind,
} from '../src/engine/docs/letters';

// ---------------------------------------------------------------------------
// A fictional project evaluated by the real engine

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const blankForm = new Uint8Array(fs.readFileSync('public/forms/wh347-rev2025.pdf'));
const wd = parseWageDetermination(fs.readFileSync('fixtures/wd/sample-modern.txt', 'utf8'));
const wdKey = (label: string) => {
  const c = wd.classifications.find((x) => normalizeLabel(x.label) === normalizeLabel(label));
  if (!c) throw new Error(`no classification ${label}`);
  return c.key;
};

const reviewer = {
  name: 'J. Rivera',
  title: 'Labor Standards Officer',
  organization: 'Pine County Community Development',
  email: 'jrivera@example.org',
  phone: '555-0100',
};

const project: Project = {
  id: 'p1',
  name: 'Maple Street Water & Sewer Replacement',
  projectNumber: 'B-26-DC-99-0047',
  location: 'Harlow, Sample State',
  owner: 'Village of Harlow Creek',
  fundingSource: 'CDBG',
  wdLockDate: '2026-04-01',
  reviewer,
  settings: { overtimeRuleApplies: true, lateAfterDays: 14, arithmeticToleranceDollars: 1, executiveOrderMinimumWage: null },
  createdAt: '',
  updatedAt: '',
};

function contractor(p: Partial<Contractor> & Pick<Contractor, 'id' | 'name'>): Contractor {
  return {
    projectId: 'p1',
    tier: 'subcontractor',
    trade: '',
    startDate: null,
    endDate: null,
    contactName: '',
    contactEmail: '',
    address: '',
    apprenticePrograms: [],
    ...p,
  };
}

const prime = contractor({
  id: 'c-prime',
  name: 'Northfield Civil Works Inc.',
  tier: 'prime',
  trade: 'General',
  startDate: '2026-08-23',
  contactName: 'Avery Stone',
  contactEmail: 'payroll@northfield.example',
  address: '410 Quarry Road\nHarlow, SS 00000',
});
const sub = contractor({
  id: 'c-sub',
  name: 'Ridgeline Concrete LLC',
  trade: 'Concrete',
  startDate: '2026-08-30',
  contactName: 'Dana Whitfield',
  contactEmail: 'office@ridgeline.example',
  address: '77 Mill Lane; Pine Falls, SS 00000',
});
const contractors = [prime, sub];

let seq = 0;
function line(p: Partial<PayrollLine>): PayrollLine {
  return {
    id: `L${++seq}`,
    workerName: 'Worker',
    workerId: '1000',
    classification: 'Laborer Group 1',
    apprentice: false,
    dailyST: [],
    dailyOT: [],
    totalST: 40,
    totalOT: 0,
    rateST: 26.85,
    rateOT: null,
    fringePlanHourly: 12.4,
    fringeCashHourly: 0,
    grossThisProject: null,
    grossAllWork: null,
    deductions: null,
    netPay: null,
    ...p,
  };
}

function payroll(p: Partial<Payroll> & Pick<Payroll, 'id' | 'contractorId' | 'weekEnding'>): Payroll {
  return {
    projectId: 'p1',
    payrollNumber: '1',
    receivedDate: null,
    noWork: false,
    isFinal: false,
    supersedesPayrollId: null,
    statementOfComplianceSigned: true,
    source: { kind: 'manual', fileName: null, fileId: null },
    lines: [],
    status: 'received',
    reviewNote: '',
    reviewedAt: null,
    createdAt: '',
    updatedAt: '',
    ...p,
  };
}

const p1 = payroll({
  id: 'P1',
  contractorId: 'c-sub',
  payrollNumber: '1',
  weekEnding: '2026-09-12',
  receivedDate: '2026-09-15',
  source: { kind: 'wh347-pdf', fileName: 'ridgeline-wk1.pdf', fileId: null },
  reviewNote: 'Called D. Whitfield on 9/27 about the welder classification.',
  lines: [
    line({
      workerName: 'Maria Delgado',
      workerId: '4821',
      rateST: 24.1,
      grossThisProject: 964,
      grossAllWork: 964,
      deductions: 180,
      netPay: 784,
    }),
    line({
      workerName: 'Tomás Ñúñez',
      workerId: '123-45-6789',
      classification: 'Cement Mason',
      totalOT: 5,
      rateST: 24.18,
      rateOT: 24.18,
      fringePlanHourly: 6.12,
    }),
    line({ workerName: 'Sam Okafor', workerId: '5512', classification: 'Welder', rateST: 30, fringePlanHourly: 10 }),
  ],
});
const p2 = payroll({
  id: 'P2',
  contractorId: 'c-sub',
  payrollNumber: '2',
  weekEnding: '2026-09-19',
  receivedDate: '2026-09-24',
  statementOfComplianceSigned: false,
  lines: [line({ workerName: 'Maria Delgado', workerId: '4821', fringePlanHourly: 10 })],
});
const p3 = payroll({
  id: 'P3',
  contractorId: 'c-prime',
  payrollNumber: '101',
  weekEnding: '2026-09-12',
  receivedDate: '2026-09-14',
  lines: [line({ workerName: 'Priya Castellano', workerId: '7730', classification: 'Electrician', rateST: 44, fringePlanHourly: 22.32 })],
});
const payrolls = [p1, p2, p3];

const mapping = (label: string, key: string, contractorId: string): ClassificationMapping => ({
  id: `m-${contractorId}-${label}`,
  projectId: 'p1',
  contractorId,
  payrollLabel: normalizeLabel(label),
  classificationKey: key,
});
const mappings = [
  mapping('Laborer Group 1', wdKey('LABORER — GROUP 1'), 'c-sub'),
  mapping('Cement Mason', wdKey('CEMENT MASON/CONCRETE FINISHER'), 'c-sub'),
  mapping('Welder', NOT_ON_WD, 'c-sub'),
  mapping('Electrician', wdKey('ELECTRICIAN'), 'c-prime'),
];

const evaluation = evaluateProject({ project, wd, contractors, payrolls, mappings, asOf: '2026-09-28' });
const findingFor = (ruleId: Finding['ruleId'], payrollId: string) => {
  const f = evaluation.findings.find((x) => x.ruleId === ruleId && x.payrollId === payrollId);
  if (!f) throw new Error(`no ${ruleId} finding on ${payrollId}`);
  return f;
};
const records: RestitutionRecord[] = [
  {
    findingKey: findingFor('base-rate-below-wd', 'P1').key,
    projectId: 'p1',
    status: 'requested',
    amountPaid: 0,
    note: '',
    updatedAt: '2026-09-27T15:00:00Z',
  },
  {
    findingKey: findingFor('fringe-shortfall', 'P2').key,
    projectId: 'p1',
    status: 'paid',
    amountPaid: 96,
    note: 'Check 1043',
    updatedAt: '2026-09-27T15:05:00Z',
  },
];
const ledger = buildLedger([...evaluation.findings, ...evaluation.historicalFindings], records, contractors);
const summaries = letterPayrollSummaries(payrolls, evaluation.payrolls);

function stampContext(overrides: Partial<StampContext> = {}): StampContext {
  return {
    project,
    wdNumber: wd.decisionNumber,
    wdModification: wd.currentModification,
    contractor: sub,
    payroll: p1,
    findings: evaluation.findings,
    reviewer: { name: reviewer.name, title: reviewer.title, organization: reviewer.organization },
    reviewedOn: '2026-09-27',
    lineAnalyses: evaluation.lines,
    ...overrides,
  };
}

function letterContext(overrides: Partial<LetterContext> = {}): LetterContext {
  return {
    project,
    contractor: sub,
    contractors,
    reviewer,
    date: '2026-09-28',
    findings: evaluation.findings,
    ledgerRows: ledger.rows,
    payrolls: summaries,
    responseDays: 14,
    wdNumber: wd.decisionNumber,
    wdModification: wd.currentModification,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PDF reading helpers

interface PageText {
  text: string;
  width: number;
  height: number;
  items: { str: string; x: number; y: number; horizontal: boolean }[];
}

async function readPdf(bytes: Uint8Array): Promise<PageText[]> {
  // isEvalSupported is gone from pdf.js 6 typings but still passed, for older builds.
  const params = { data: bytes.slice(), isEvalSupported: false, disableFontFace: true, enableXfa: false, verbosity: 0 };
  const task = pdfjs.getDocument(params);
  const doc = await task.promise;
  const pages: PageText[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.flatMap((i) => {
      if (!('str' in i)) return [];
      const m = pdfjs.Util.transform(viewport.transform, i.transform);
      return [{ str: i.str, x: m[4], y: m[5], horizontal: m[0] > 0 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 }];
    });
    pages.push({
      text: items
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' '),
      width: viewport.width,
      height: viewport.height,
      items,
    });
  }
  await task.destroy();
  return pages;
}

const joined = (pages: PageText[]) => pages.map((p) => p.text).join(' ');

// ---------------------------------------------------------------------------

describe('scenario sanity', () => {
  it('produces the findings the documents are tested against', () => {
    const r = reviewResult(stampContext());
    expect(r.violations).toBe(3);
    expect(r.warnings).toBe(1);
    expect(r.owed).toBe(170.45);
    expect(r.findings.every((f) => f.payrollId === 'P1')).toBe(true);
    expect(evaluation.findings.filter((f) => f.ruleId === 'missing-week').map((f) => [f.contractorId, f.weekEnding])).toEqual([
      ['c-prime', '2026-08-29'],
      ['c-prime', '2026-09-05'],
      ['c-sub', '2026-09-05'],
    ]);
  });
});

describe('review notation', () => {
  it('summarizes violations, amount owed and warnings', () => {
    expect(reviewNotation(stampContext())).toEqual({
      heading: 'REVIEWED against WD XX20260047 Mod 2 · 9/27/2026 · J. Rivera, Labor Standards Officer',
      result: 'Result: 3 violations, $170.45 owed, 1 warning',
    });
  });

  it('says "No exceptions noted" for a clean payroll and handles a missing WD', () => {
    const clean = reviewNotation(stampContext({ payroll: p3, contractor: prime }));
    expect(clean.result).toBe('Result: No exceptions noted');
    const noWd = reviewNotation(stampContext({ wdNumber: null, wdModification: null, reviewer: { name: '', title: '', organization: '' } }));
    expect(noWd.heading).toBe('REVIEWED (wage determination not recorded) · 9/27/2026 · Reviewer');
  });
});

describe('buildStampedPayroll with the contractor original', () => {
  it('stamps page 1 of the WH-347 and appends the review worksheet', async () => {
    const before = blankForm.slice();
    const result = await buildStampedPayroll(blankForm, stampContext());
    expect(Buffer.from(blankForm).equals(Buffer.from(before))).toBe(true);
    expect(result.usedOriginal).toBe(true);
    expect(result.originalProblem).toBeNull();
    expect(result.worksheetPage).toBe(3);
    expect(result.pageCount).toBeGreaterThanOrEqual(3);

    const pages = await readPdf(result.bytes);
    expect(pages.length).toBe(result.pageCount);
    const first = pages[0]!;
    expect(first.text).toContain('Davis-Bacon and Related Acts Weekly');
    expect(first.text).toContain('REVIEWED against WD XX20260047 Mod 2 · 9/27/2026 · J. Rivera, Labor Standards Officer');
    expect(first.text).toContain('Result: 3 violations, $170.45 owed, 1 warning');
    expect(first.text).toContain('Worksheet: page 3');
    expect(first.text).toContain('not a legal determination');
    expect(pages[1]!.text).not.toContain('REVIEWED');

    // The notation sits in the top-right corner of the form, reading left to right.
    const stampItem = first.items.find((i) => i.str.startsWith('REVIEWED'))!;
    expect(stampItem.horizontal).toBe(true);
    expect(stampItem.y).toBeLessThan(40);
    expect(stampItem.x).toBeGreaterThan(first.width / 3);

    const worksheet = joined(pages.slice(result.worksheetPage - 1));
    for (const expected of [
      'Payroll Review Worksheet',
      'Maple Street Water & Sewer Replacement (B-26-DC-99-0047)',
      'Ridgeline Concrete LLC - Subcontractor, Concrete',
      'Week ending 9/12/2026',
      'XX20260047, Modification 2',
      'Checks performed',
      'Violations (3)',
      'Warnings (1)',
      'Maria Delgado',
      'basic rate $24.10 is below $26.85',
      '$110.00',
      '$60.45',
      'Total (2 workers) $170.45',
      'Total restitution on this payroll: $170.45',
      'Rate comparison with the wage determination',
      'Not on WD (conformance needed)',
      'Called D. Whitfield',
      'Reviewer signature',
      'not a legal determination',
    ]) {
      expect(worksheet).toContain(expected);
    }
    expect(worksheet).toContain('Page 1 of');

    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
    expect(reloaded.getPage(result.worksheetPage - 1).getSize()).toEqual({ width: 612, height: 792 });
  });

  it.each([0, 90, 180, 270])('places the notation top-right on a page rotated %i degrees', async (rotation) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.setCropBox(20, 30, 560, 740);
    page.drawText('CONTRACTOR PAYROLL', { x: 60, y: 400, size: 14, font });
    page.setRotation(degrees(rotation));
    const bytes = await buildStampedPayrollPdf(await doc.save(), stampContext());
    const [first] = await readPdf(bytes);
    const item = first!.items.find((i) => i.str.startsWith('REVIEWED'))!;
    expect(item).toBeDefined();
    expect(item.horizontal).toBe(true);
    expect(item.y).toBeGreaterThan(0);
    expect(item.y).toBeLessThan(40);
    expect(item.x).toBeGreaterThan(first!.width - 460);
    expect(item.x).toBeLessThan(first!.width);
  });

  it('keeps every page of a multi-page original', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([612, 792]);
    const result = await buildStampedPayroll(await doc.save(), stampContext());
    expect(result.usedOriginal).toBe(true);
    expect(result.worksheetPage).toBe(5);
  });
});

describe('buildStampedPayroll without a usable original', () => {
  it('generates the worksheet followed by the payroll lines as submitted', async () => {
    const result = await buildStampedPayroll(null, stampContext({ payroll: { ...p1, source: { kind: 'xlsx', fileName: 'ridgeline.xlsx', fileId: null } } }));
    expect(result).toMatchObject({ usedOriginal: false, originalProblem: null, worksheetPage: 1 });
    const pages = await readPdf(result.bytes);
    expect(pages[0]!.text).toContain('Payroll Review Worksheet');
    expect(pages[0]!.text).toContain('REVIEWED against WD XX20260047 Mod 2');
    expect(pages[0]!.text).toContain('Result: 3 violations, $170.45 owed, 1 warning');
    expect(pages[0]!.text).toContain('imported from Excel workbook "ridgeline.xlsx"');

    const last = pages[pages.length - 1]!;
    expect(last.width).toBe(792);
    expect(last.text).toContain('Payroll as submitted');
    expect(last.text).toContain('Maria Delgado');
    expect(last.text).toContain('Sam Okafor');
    expect(last.text).toContain('***-**-6789');
    expect(last.text).toContain('Total (3 lines)');
    expect(joined(pages)).not.toContain('123-45-6789');

    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getTitle()).toBe('Payroll review - Ridgeline Concrete LLC - week ending 9/12/2026');
  });

  it('documents a clean payroll and a no-work payroll', async () => {
    const clean = joined(await readPdf(await buildStampedPayrollPdf(null, stampContext({ payroll: p3, contractor: prime }))));
    expect(clean).toContain('Result: No exceptions noted');
    expect(clean).toContain('No exceptions noted.');
    expect(clean).toContain('No underpayments were identified on this payroll.');

    const noWork = payroll({ id: 'P9', contractorId: 'c-prime', weekEnding: '2026-09-19', noWork: true, receivedDate: null });
    const text = joined(await readPdf(await buildStampedPayrollPdf(null, stampContext({ payroll: noWork, contractor: prime, findings: [] }))));
    expect(text).toContain('No work reported');
    expect(text).toContain('No work performed this week (no payroll lines).');
    expect(text).toContain('Received date not recorded');
  });

  it.each([
    ['not a PDF', new TextEncoder().encode('Hello, this is an email attachment, not a PDF.'), 'The file is not a PDF.'],
    ['empty', new Uint8Array(0), 'The original file is empty.'],
    ['garbage after a PDF header', new TextEncoder().encode('%PDF-1.7\n' + 'x'.repeat(50)), 'could not be opened'],
  ])('falls back when the original is %s', async (_label, bytes, problem) => {
    const result = await buildStampedPayroll(bytes, stampContext());
    expect(result.usedOriginal).toBe(false);
    expect(result.originalProblem).toContain(problem);
    const pages = await readPdf(result.bytes);
    expect(pages[0]!.text).toContain('REVIEWED against WD XX20260047 Mod 2');
    expect(pages[0]!.text).toContain("The contractor's original PDF could not be stamped");
    expect(joined(pages)).toContain('Payroll as submitted');
  });

  it('never fails on a truncated original', async () => {
    const truncated = blankForm.slice(0, Math.floor(blankForm.byteLength / 3));
    const result = await buildStampedPayroll(truncated, stampContext());
    const pages = await readPdf(result.bytes);
    expect(joined(pages)).toContain('REVIEWED against WD XX20260047 Mod 2');
    if (!result.usedOriginal) expect(result.originalProblem).toBeTruthy();
  });

  it('does not stamp an encrypted original', async () => {
    const doc = await PDFDocument.load(blankForm);
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -44 });
    const encrypted = await doc.save({ useObjectStreams: false });
    await expect(PDFDocument.load(encrypted)).rejects.toThrow();
    const result = await buildStampedPayroll(encrypted, stampContext());
    expect(result.usedOriginal).toBe(false);
    expect(result.originalProblem).toContain('encrypted');
  });
});

describe('characters outside WinAnsi', () => {
  const weird = `Zo${cp(0x00eb)} ${cp(0x738b)}${cp(0x5c0f)}${cp(0x660e)} ${cp(0x1f477)} ${cp(0x0141)}ukasz ${cp(0x2014)} ${cp(0x201c)}Q${cp(0x201d)} ${cp(0x2265)} 2${cp(0x00d7)}3${cp(1)}`;
  const weirdPayroll: Payroll = {
    ...p1,
    reviewNote: `Note with ${cp(0x2192)} arrows, tabs\tand ${cp(0x200b)}zero-width ${cp(0xfeff)}marks${cp(0)}`,
    lines: p1.lines.map((l, i) => (i === 0 ? { ...l, workerName: weird, classification: `Laborer ${cp(0x2116)}1 ${cp(0x2014)} ${cp(0x0394)}` } : l)),
  };
  const weirdFindings: Finding[] = [
    {
      ...findingFor('base-rate-below-wd', 'P1'),
      workerName: weird,
      title: `${weird}: basic rate ${cp(0x2264)} WD`,
      detail: `Short $2.75/hr ${cp(0x00d7)} 40 hrs ${cp(0x2265)} ${cp(0x20ac)}0 ${cp(0x2026)} ${cp(0x1f4b5)}`,
    },
  ];

  it('generates the stamped original and the worksheet without throwing', async () => {
    const ctx = stampContext({
      payroll: weirdPayroll,
      findings: weirdFindings,
      reviewer: { name: `J. ${cp(0x201c)}Jo${cp(0x201d)} Rivera`, title: `Officer ${cp(0x2014)} Labor`, organization: `Pine ${cp(0x2116)}4` },
    });
    const stamped = await buildStampedPayroll(blankForm, ctx);
    expect(stamped.usedOriginal).toBe(true);
    const generated = await buildStampedPayroll(null, ctx);
    const text = joined(await readPdf(generated.bytes));
    expect(text).toContain('Lukasz');
    expect(text).toContain('Zoë ??? ?');
    expect(text).toContain('J. "Jo" Rivera, Officer - Labor');
    expect(text).toContain('Laborer No.1 - ?');
  });

  it('renders letters to PDF and Word without throwing', async () => {
    const odd: Contractor = { ...sub, name: `${cp(0x738b)} Concrete ${cp(0x2014)} ${cp(0x1f3d7)}`, contactName: `Dana ${cp(2)}Whitfield` };
    for (const kind of ['correction-request', 'missing-payrolls', 'review-memo'] as LetterKind[]) {
      const letter = composeLetter(kind, letterContext({ contractor: odd, contractors: [prime, odd], findings: [...evaluation.findings, ...weirdFindings] }));
      const pdf = await letterToPdf(letter);
      expect(joined(await readPdf(pdf))).toContain('Maple Street Water & Sewer Replacement');
      const docx = await letterToDocx(letter);
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
      if (kind !== 'review-memo') expect(xml).toContain('Dana Whitfield');
    }
  });
});

// ---------------------------------------------------------------------------
// Letters

describe('composeLetter: correction request', () => {
  const letter = composeLetter('correction-request', letterContext());
  const table = (title: string) => letter.tables.find((t) => t.title === title);

  it('addresses the contractor and copies the prime contractor and owner', () => {
    expect(letter.kind).toBe('correction-request');
    expect(letter.date).toBe('2026-09-28');
    expect(letter.to).toEqual(['Dana Whitfield', 'Ridgeline Concrete LLC', '77 Mill Lane', 'Pine Falls, SS 00000', 'office@ridgeline.example']);
    expect(letter.from).toEqual([
      'Pine County Community Development',
      'J. Rivera, Labor Standards Officer',
      'jrivera@example.org',
      '555-0100',
    ]);
    expect(letter.subject).toBe(
      'Certified payroll corrections required - Maple Street Water & Sewer Replacement (project no. B-26-DC-99-0047)',
    );
    expect(letter.paragraphs[0]).toBe('Dear Dana Whitfield:');
    expect(letter.closing).toContain('cc: Northfield Civil Works Inc. (prime contractor)');
    expect(letter.closing).toContain('cc: Village of Harlow Creek');
  });

  it('lists back wages by worker and week with a total', () => {
    const due = table('Back wages due')!;
    expect(due.columns).toEqual(['Week ending', 'Payroll no.', 'Worker', 'Underpayment', 'Amount due']);
    expect(due.rows).toEqual([
      ['9/12/2026', '1', 'Maria Delgado', 'Basic hourly rate below the wage determination', '$110.00'],
      ['9/12/2026', '1', 'Tomás Ñúñez', 'Overtime paid below 1.5x the basic rate', '$60.45'],
    ]);
    expect(due.footer).toEqual(['Total', '', '', '', '$170.45']);
    expect(due.numericColumns).toEqual([4]);
    expect(table('How the amounts were calculated')!.rows.map((r) => r[1])).toEqual(['Maria Delgado', 'Tomás Ñúñez']);
    expect(table('Total due to each worker')).toBeUndefined();
  });

  it('gives restitution instructions, the deadline and proof of payment', () => {
    const text = letter.paragraphs.join('\n');
    expect(text).toContain('Back wages totaling $170.45 are due to 2 workers');
    expect(text).toContain('within 14 days of the date of this letter (by October 12, 2026)');
    expect(text).toContain('1. Pay each worker');
    expect(text).toContain('marked as a correction');
    expect(text).toContain('cancelled checks');
    expect(text).toContain('Payments you reported for 1 underpayment ($96.00) still need proof of payment');
    expect(text).toContain('may be withheld');
    expect(text).toContain('contact J. Rivera at jrivera@example.org or 555-0100');
  });

  it('lists non-monetary corrections and missing weeks', () => {
    const items = table('Other items requiring correction')!;
    const all = items.rows.map((r) => r.join(' | ')).join('\n');
    expect(all).toContain('9/19/2026 | 2 | Provide a signed Statement of Compliance for this payroll.');
    expect(all).toContain('Sam Okafor: "Welder" is not a classification on the wage determination');
    expect(all).toContain('Standard Form 1444');
    expect(all).toContain('not full Social Security numbers. Workers: Tomás Ñúñez.');
    expect(table('Payrolls not received')!.rows).toEqual([['Ridgeline Concrete LLC', '9/5/2026', '1']]);
  });

  it('places each table after the paragraph that introduces it', () => {
    const blocks = letterBlocks(letter);
    const dueIndex = blocks.findIndex((b) => b.type === 'table' && b.table.title === 'Back wages due');
    const intro = blocks[dueIndex - 1]!;
    expect(intro.type === 'paragraph' && intro.text.startsWith('Workers were paid less')).toBe(true);
    expect(blocks.filter((b) => b.type === 'table')).toHaveLength(letter.tables.length);
    expect(blocks.filter((b) => b.type === 'paragraph')).toHaveLength(letter.paragraphs.length);
  });

  it('shows paid and balance columns once a partial payment is recorded', () => {
    const partial = buildLedger(evaluation.findings, [{ ...records[0]!, status: 'paid', amountPaid: 50 }], contractors);
    const l = composeLetter('correction-request', letterContext({ ledgerRows: partial.rows }));
    const due = l.tables.find((t) => t.title === 'Back wages due')!;
    expect(due.columns.slice(-3)).toEqual(['Owed', 'Paid', 'Balance due']);
    expect(due.rows[0]!.slice(-3)).toEqual(['$110.00', '$50.00', '$60.00']);
    expect(due.footer!.slice(-3)).toEqual(['$266.45', '$50.00', '$216.45']);
  });

  it('derives the ledger from findings, lists a worker total across weeks, and ignores superseded history', () => {
    const history: Finding = { ...findingFor('soc-missing', 'P2'), key: 'old', supersededBy: 'P7' };
    const l = composeLetter('correction-request', letterContext({ ledgerRows: undefined, findings: [...evaluation.findings, history] }));
    const perWorker = l.tables.find((t) => t.title === 'Total due to each worker')!;
    expect(perWorker.rows).toEqual([
      ['Maria Delgado', '2', '$206.00'],
      ['Tomás Ñúñez', '1', '$60.45'],
    ]);
    const items = l.tables.find((t) => t.title === 'Other items requiring correction')!;
    expect(items.rows.filter((r) => r.join(' ').includes('Statement of Compliance'))).toHaveLength(1);
  });

  it('needs an addressee and says so when nothing needs correcting', () => {
    expect(() => composeLetter('correction-request', letterContext({ contractor: null }))).toThrow(/contractor/);
    const clean = composeLetter('correction-request', letterContext({ contractor: prime, findings: [], ledgerRows: [], missingWeeks: [] }));
    expect(clean.tables).toEqual([]);
    expect(clean.paragraphs.join(' ')).toContain('No items requiring correction were found');
  });
});

describe('composeLetter: missing payrolls', () => {
  it('lists every contractor for the prime, with its responsibility for subcontractors', () => {
    const letter = composeLetter('missing-payrolls', letterContext({ contractor: prime }));
    const t = letter.tables[0]!;
    expect(t.rows).toEqual([
      ['Northfield Civil Works Inc.', '8/29/2026, 9/5/2026', '2'],
      ['Ridgeline Concrete LLC', '9/5/2026', '1'],
    ]);
    expect(t.footer).toEqual(['Total', '', '3']);
    const text = letter.paragraphs.join('\n');
    expect(text).toContain('As prime contractor, Northfield Civil Works Inc. is responsible');
    expect(text).toContain('No work performed');
    expect(text).toContain('Payment under the contract may be withheld');
    expect(text).toContain('by October 12, 2026');
    expect(letter.closing.some((l) => l.includes('prime contractor'))).toBe(false);
  });

  it('lists only the subcontractor’s own weeks when addressed to it', () => {
    const letter = composeLetter('missing-payrolls', letterContext({ missingWeeks: [
      { contractorId: 'c-sub', weekEnding: '2026-09-05' },
      { contractorId: 'c-prime', weekEnding: '2026-08-29' },
      { contractorId: 'c-sub', weekEnding: 'garbage' },
    ] }));
    expect(letter.tables[0]!.rows).toEqual([['Ridgeline Concrete LLC', '9/5/2026', '1']]);
    expect(letter.paragraphs.join(' ')).not.toContain('As prime contractor');
  });

  it('confirms when nothing is missing', () => {
    const letter = composeLetter('missing-payrolls', letterContext({ missingWeeks: [] }));
    expect(letter.tables).toEqual([]);
    expect(letter.paragraphs[1]).toContain('have been received');
  });
});

describe('composeLetter: review memo', () => {
  const memo = composeLetter('review-memo', letterContext({ contractor: undefined }));

  it('summarizes payrolls, exceptions, restitution and missing weeks', () => {
    expect(memo.to).toEqual(['Project file', 'Village of Harlow Creek']);
    expect(memo.from).toEqual(['J. Rivera, Labor Standards Officer', 'Pine County Community Development']);
    expect(memo.subject).toBe('Certified payroll review summary - Maple Street Water & Sewer Replacement (project no. B-26-DC-99-0047)');
    expect(memo.tables.map((t) => t.title)).toEqual(['Payrolls reviewed', 'Open exceptions', 'Restitution status', 'Payrolls not received']);
    const text = memo.paragraphs.join('\n');
    expect(text).toContain('3 payrolls from 2 contractors were reviewed');
    expect(text).toContain('1 had no exceptions, 0 had warnings only, and 2 had violations');
    expect(text).toContain('underpayments identified to date total $266.45');
    expect(text).toContain('Contractors report paying $96.00');
    expect(text).toContain('$170.45 remains outstanding');
    expect(text).toContain('not a legal determination');
    const restitution = memo.tables.find((t) => t.title === 'Restitution status')!;
    expect(restitution.rows).toEqual([['Ridgeline Concrete LLC', '$266.45', '$96.00', '$0.00', '$170.45', '1 requested, 1 owed, 1 paid (unverified)']]);
    const payrollsTable = memo.tables.find((t) => t.title === 'Payrolls reviewed')!;
    expect(payrollsTable.rows[0]).toEqual(['Northfield Civil Works Inc.', '101', '9/12/2026', '9/14/2026', 'No exceptions', '-']);
  });

  it('handles a project with nothing reviewed yet', () => {
    const empty = composeLetter('review-memo', letterContext({ contractor: undefined, payrolls: [], findings: [], ledgerRows: [], missingWeeks: [] }));
    expect(empty.tables).toEqual([]);
    const text = empty.paragraphs.join(' ');
    expect(text).toContain('No payrolls have been reviewed yet.');
    expect(text).toContain('No underpayments have been identified.');
    expect(text).toContain('No payrolls are outstanding.');
  });
});

describe('letter renderers', () => {
  const kinds: LetterKind[] = ['correction-request', 'missing-payrolls', 'review-memo'];
  const letters = Object.fromEntries(kinds.map((k) => [k, composeLetter(k, letterContext())])) as Record<LetterKind, Letter>;

  it.each(kinds)('renders a %s as text', (kind) => {
    const text = letterToText(letters[kind]);
    expect(text).toContain(letters[kind].subject);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/\n{3,}/);
    if (kind === 'review-memo') {
      expect(text.startsWith('MEMORANDUM\n')).toBe(true);
      expect(text).toContain('SUBJECT: Certified payroll review summary');
      expect(text).toContain('PAYROLLS REVIEWED');
    } else {
      expect(text).toContain(`Re: ${letters[kind].subject}`);
      expect(text).toContain('September 28, 2026');
    }
  });

  it('draws text tables with aligned columns and right-aligned amounts', () => {
    const text = letterToText(letters['correction-request']);
    const lines = text.split('\n');
    const header = lines.findIndex((l) => l.startsWith('Week ending | Payroll no. | Worker'));
    expect(header).toBeGreaterThan(0);
    expect(lines[header + 1]).toMatch(/^-+-\+-/);
    const total = lines.find((l) => l.startsWith('Total ') && l.endsWith('$170.45'));
    expect(total).toBeDefined();
    const row = lines.find((l) => l.includes('Maria Delgado') && l.endsWith('$110.00'))!;
    expect(row.length).toBe(total!.length);
  });

  it.each(kinds)('renders a %s as a Word document with real tables', async (kind) => {
    const bytes = await letterToDocx(letters[kind]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK');
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain(letters[kind].subject.replace(/&/g, '&amp;'));
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:tblHeader');
    for (const t of letters[kind].tables) expect(xml).toContain(t.title);
    if (kind === 'review-memo') expect(xml).toContain('MEMORANDUM');
  });

  it.each(kinds)('renders a %s as a Letter-size PDF', async (kind) => {
    const bytes = await letterToPdf(letters[kind]);
    const pages = await readPdf(bytes);
    const text = joined(pages);
    expect(text).toContain(letters[kind].subject);
    for (const t of letters[kind].tables) expect(text).toContain(t.title);
    expect(pages[0]!.width).toBe(612);
    expect(pages[0]!.height).toBe(792);
    expect(pages[0]!.text).toContain(`Page 1 of ${pages.length}`);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe(letters[kind].subject);
  });

  it('paginates long tables in the PDF and repeats the header row', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...summaries[0]!,
      payrollId: `X${i}`,
      payrollNumber: String(i + 1),
    }));
    const memo = composeLetter('review-memo', letterContext({ contractor: undefined, payrolls: many }));
    const pages = await readPdf(await letterToPdf(memo));
    expect(pages.length).toBeGreaterThan(3);
    const withHeader = pages.filter((p) => p.text.includes('Contractor Payroll no. Week ending Received Result Owed'));
    expect(withHeader.length).toBeGreaterThan(2);
    expect(joined(pages)).toContain('not a legal determination');
  });

  it('renders tables whose rows are ragged or whose position is out of range', async () => {
    const letter: Letter = {
      kind: 'correction-request',
      date: '2026-09-28',
      to: ['Someone'],
      from: ['Office'],
      subject: 'Odd tables',
      paragraphs: ['Only paragraph.'],
      tables: [
        { title: 'Ragged', columns: ['A', 'B', 'C'], rows: [['1'], ['1', '2', '3', '4']], afterParagraph: 7 },
        { title: 'Empty', columns: [], rows: [] },
        { title: 'Before', columns: ['Amount'], rows: [['$1.00'], ['($2.00)']], afterParagraph: -1 },
      ],
      closing: [],
    };
    expect(letterBlocks(letter).map((b) => (b.type === 'table' ? b.table.title : 'p'))).toEqual(['Before', 'p', 'Ragged', 'Empty']);
    expect(letterToText(letter)).toContain('RAGGED');
    expect(joined(await readPdf(await letterToPdf(letter)))).toContain('Ragged');
    const xml = await (await JSZip.loadAsync(await letterToDocx(letter))).file('word/document.xml')!.async('string');
    expect(xml).toContain('Ragged');
  });
});
