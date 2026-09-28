import { PDFArray, PDFDict, PDFDocument, PDFName, degrees, rgb, type PDFPage, type RGB } from 'pdf-lib';
import type { LineAnalysis } from '../checks/evaluate';
import { daysBetween, formatDate, isIsoDate } from '../dates';
import { cents, formatHours, formatMoney, formatRate, sum } from '../money';
import type { Contractor, Finding, ISODate, Payroll, PayrollLine, Project, RuleId, Severity } from '../types';
import {
  INK,
  MUTED,
  PdfFlow,
  WHITE,
  embedStandardFonts,
  wrapText,
  type FlowCell,
  type FlowFonts,
  type FontStyle,
  type Margins,
} from './pdf-layout';
import {
  REVIEW_AID_NOTICE,
  SEVERITY_GROUP_LABELS,
  SOURCE_LABELS,
  TIER_LABELS,
  bySeverity,
  maskIdentifier,
  plural,
  wdLong,
  wdShort,
} from './wording';

export interface ReviewerIdentity {
  name: string;
  title: string;
  organization: string;
}

export interface StampContext {
  project: Project;
  wdNumber: string | null;
  wdModification: number | null;
  contractor: Contractor;
  payroll: Payroll;
  /** Findings for this payroll. Findings for other payrolls are ignored, so the project's full list may be passed. */
  findings: Finding[];
  reviewer: ReviewerIdentity;
  reviewedOn: ISODate;
  /** Per-line computations from evaluateProject(); adds a rate comparison table to the worksheet. */
  lineAnalyses?: Map<string, LineAnalysis>;
}

export interface StampedPayroll {
  bytes: Uint8Array;
  /** True when the notation was stamped on the contractor's own PDF. */
  usedOriginal: boolean;
  /** Why a supplied original could not be used; the document was then generated without it. */
  originalProblem: string | null;
  pageCount: number;
  /** 1-based page on which the Payroll Review Worksheet starts. */
  worksheetPage: number;
}

export interface ReviewResult {
  findings: Finding[];
  violations: number;
  warnings: number;
  notes: number;
  owed: number;
  tone: 'violations' | 'warnings' | 'clean';
}

/** Middle dot, as in "WD OH20260047 Mod 2 \u00b7 9/27/2026". */
const SEPARATOR = ' \u00b7 ';

const LETTER_PORTRAIT: [number, number] = [612, 792];
const LETTER_LANDSCAPE: [number, number] = [792, 612];
const WORKSHEET_MARGINS: Margins = { top: 54, right: 54, bottom: 54, left: 54 };

const TONE_COLORS: Record<ReviewResult['tone'], RGB> = {
  violations: rgb(0.66, 0.09, 0.09),
  warnings: rgb(0.58, 0.34, 0.02),
  clean: rgb(0.06, 0.38, 0.2),
};

/** Counts and amount owed for one payroll, from the findings that belong to it. */
export function reviewResult(ctx: Pick<StampContext, 'payroll' | 'findings'>): ReviewResult {
  const findings = ctx.findings.filter((f) => f.payrollId === ctx.payroll.id).sort(bySeverity);
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const violations = count('violation');
  const warnings = count('warning');
  return {
    findings,
    violations,
    warnings,
    notes: count('info'),
    owed: cents(sum(findings.map((f) => f.amountOwed))),
    tone: violations > 0 ? 'violations' : warnings > 0 ? 'warnings' : 'clean',
  };
}

/**
 * The two-line review notation, e.g. "REVIEWED against WD OH20260047 Mod 2 · 9/27/2026 ·
 * J. Rivera, Labor Standards Officer" and "Result: 2 violations, $601.20 owed". Some CDBG
 * programs require payrolls to carry a notation showing they were compared with the wage
 * determination; the same text heads the worksheet so the two always agree.
 */
export function reviewNotation(ctx: StampContext): { heading: string; result: string } {
  const r = reviewResult(ctx);
  const wd = wdShort(ctx.wdNumber, ctx.wdModification);
  const reviewer = [ctx.reviewer.name.trim(), ctx.reviewer.title.trim()].filter(Boolean).join(', ') || 'Reviewer';
  const heading = [wd ? `REVIEWED against ${wd}` : 'REVIEWED (wage determination not recorded)', formatDate(ctx.reviewedOn), reviewer].join(
    SEPARATOR,
  );
  const parts: string[] = [];
  if (r.violations > 0) parts.push(plural(r.violations, 'violation'));
  if (r.owed > 0) parts.push(`${formatMoney(r.owed)} owed`);
  if (r.warnings > 0) parts.push(plural(r.warnings, 'warning'));
  const result = parts.length > 0 ? `Result: ${parts.join(', ')}` : 'Result: No exceptions noted';
  return { heading, result };
}

/**
 * Produce the reviewer's copy of a payroll: the contractor's original PDF with a review
 * notation stamped on page 1 and a Payroll Review Worksheet appended. Without an original
 * (payroll keyed in or imported from a spreadsheet), or when the original cannot be
 * opened or modified, the worksheet is generated on its own followed by the payroll lines
 * as recorded, and `originalProblem` says why the original was not used.
 */
export async function buildStampedPayroll(original: Uint8Array | null, ctx: StampContext): Promise<StampedPayroll> {
  let problem: string | null = null;
  if (original && original.byteLength > 0) {
    try {
      return await stampOriginal(original, ctx);
    } catch (err) {
      problem = describeOriginalProblem(err);
    }
  } else if (original) {
    problem = 'The original file is empty.';
  }
  return generateWithoutOriginal(ctx, problem);
}

/** buildStampedPayroll() returning just the PDF bytes. */
export async function buildStampedPayrollPdf(original: Uint8Array | null, ctx: StampContext): Promise<Uint8Array> {
  return (await buildStampedPayroll(original, ctx)).bytes;
}

// ---------------------------------------------------------------------------

class OriginalProblem extends Error {}

function describeOriginalProblem(err: unknown): string {
  if (err instanceof OriginalProblem) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (/no pdf header/i.test(message)) return 'The file is not a PDF.';
  const short = message.length > 160 ? `${message.slice(0, 157)}...` : message;
  return `The original PDF could not be opened or modified (${short}).`;
}

async function stampOriginal(original: Uint8Array, ctx: StampContext): Promise<StampedPayroll> {
  const doc = await PDFDocument.load(original, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  if (doc.isEncrypted) {
    throw new OriginalProblem(
      'The original PDF is encrypted (password or permissions protected), so a notation cannot be added to it.',
    );
  }
  const pages = doc.getPages();
  const first = pages[0];
  if (!first) throw new OriginalProblem('The original PDF has no pages.');
  removeActiveContent(doc);
  const fonts = await embedStandardFonts(doc);
  const worksheetPage = pages.length + 1;
  stampFirstPage(first, ctx, fonts, worksheetPage);

  const flow = new PdfFlow(doc, fonts, { pageSize: LETTER_PORTRAIT, margins: WORKSHEET_MARGINS });
  writeWorksheet(flow, ctx, { kind: 'stamped', originalPages: pages.length });
  flow.finish(worksheetFooter(ctx));
  const bytes = await doc.save();
  return { bytes, usedOriginal: true, originalProblem: null, pageCount: doc.getPageCount(), worksheetPage };
}

async function generateWithoutOriginal(ctx: StampContext, problem: string | null): Promise<StampedPayroll> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Payroll review - ${ctx.contractor.name} - week ending ${formatDate(ctx.payroll.weekEnding)}`);
  doc.setSubject(`Payroll review worksheet for ${ctx.project.name}`);
  doc.setAuthor(ctx.reviewer.name);
  doc.setCreator('Wagebench');
  doc.setProducer('Wagebench');
  const fonts = await embedStandardFonts(doc);
  const flow = new PdfFlow(doc, fonts, { pageSize: LETTER_PORTRAIT, margins: WORKSHEET_MARGINS });
  writeWorksheet(flow, ctx, { kind: 'generated', problem });
  writePayrollLines(flow, ctx);
  flow.finish(worksheetFooter(ctx));
  const bytes = await doc.save();
  return { bytes, usedOriginal: false, originalProblem: problem, pageCount: doc.getPageCount(), worksheetPage: 1 };
}

const ACTIVE_ACTIONS = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'ResetForm', 'Rendition']);

/**
 * Drop scripts, launch actions and XFA from the copy being stamped. The reviewer passes
 * this copy on to others, and a viewer that finds XFA renders the XFA form instead of the
 * page content, which would hide the notation. Page content itself is left untouched.
 */
function removeActiveContent(doc: PDFDocument): void {
  const attempt = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A malformed entry of an unexpected type is left alone; it cannot be followed either.
    }
  };
  const catalog = doc.catalog;
  attempt(() => catalog.delete(PDFName.of('OpenAction')));
  attempt(() => catalog.delete(PDFName.of('AA')));
  attempt(() => catalog.delete(PDFName.of('NeedsRendering')));
  attempt(() => catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.delete(PDFName.of('JavaScript')));
  attempt(() => catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.delete(PDFName.of('XFA')));
  for (const page of doc.getPages()) {
    attempt(() => page.node.delete(PDFName.of('AA')));
    let annots: PDFArray | undefined;
    attempt(() => {
      annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    });
    for (let i = 0; annots && i < annots.size(); i++) {
      const list = annots;
      attempt(() => {
        const annot = list.lookupMaybe(i, PDFDict);
        if (!annot) return;
        annot.delete(PDFName.of('AA'));
        const action = annot.lookupMaybe(PDFName.of('A'), PDFDict);
        const kind = action?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText();
        if (kind && ACTIVE_ACTIONS.has(kind)) annot.delete(PDFName.of('A'));
      });
    }
  }
}

function worksheetFooter(ctx: StampContext): string {
  return `Payroll Review Worksheet - ${ctx.contractor.name} - payroll ${ctx.payroll.payrollNumber || '(no number)'} - week ending ${formatDate(ctx.payroll.weekEnding)} - reviewer's working document`;
}

// ---------------------------------------------------------------------------
// Page-1 notation

interface StampLine {
  text: string;
  style: FontStyle;
  size: number;
}

/**
 * Draw the notation box in the top-right corner of the page as it is displayed. Pages
 * with a /Rotate entry or an offset crop box are handled by mapping display coordinates
 * back to the page's own coordinate space and rotating the drawing to match.
 */
function stampFirstPage(page: PDFPage, ctx: StampContext, fonts: FlowFonts, worksheetPage: number): void {
  const rotation = (((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360;
  const crop = page.getCropBox();
  const sideways = rotation === 90 || rotation === 270;
  const viewWidth = sideways ? crop.height : crop.width;
  const viewHeight = sideways ? crop.width : crop.height;
  if (!(viewWidth > 0 && viewHeight > 0)) throw new OriginalProblem('Page 1 of the original PDF has no usable size.');

  const notation = reviewNotation(ctx);
  const result = reviewResult(ctx);
  const color = TONE_COLORS[result.tone];
  const size = viewWidth < 400 ? 6 : 7.5;
  // Forms like the WH-347 have almost no top margin: keep the box to two lines, close to the edge,
  // so it covers as little of the form's own heading as possible. The worksheet carries the rest.
  const margin = Math.min(6, Math.max(3, viewWidth * 0.008));
  const pad = size * 0.55;
  const maxBoxWidth = Math.min(440, viewWidth - 2 * margin);

  const lines: StampLine[] = [];
  const add = (text: string, style: FontStyle, lineSize: number) => {
    for (const t of wrapText(text, fonts[style], lineSize, Math.max(1, maxBoxWidth - 2 * pad))) {
      lines.push({ text: t, style, size: lineSize });
    }
  };
  add(notation.heading, 'bold', size);
  add(`${notation.result}${SEPARATOR}Worksheet: page ${worksheetPage}`, 'bold', size);

  const textWidth = Math.max(...lines.map((l) => fonts[l.style].widthOfTextAtSize(l.text, l.size)));
  const boxWidth = Math.min(maxBoxWidth, textWidth + 2 * pad);
  const boxHeight = lines.reduce((a, l) => a + l.size * 1.28, 0) + 2 * pad - size * 0.28;
  const u = viewWidth - margin - boxWidth;
  const v = Math.max(0, viewHeight - margin - boxHeight);

  const toPage = (du: number, dv: number) => {
    switch (rotation) {
      case 90:
        return { x: crop.x + crop.width - dv, y: crop.y + du };
      case 180:
        return { x: crop.x + crop.width - du, y: crop.y + crop.height - dv };
      case 270:
        return { x: crop.x + dv, y: crop.y + crop.height - du };
      default:
        return { x: crop.x + du, y: crop.y + dv };
    }
  };
  const rotate = degrees(rotation);

  page.drawRectangle({
    ...toPage(u, v),
    width: boxWidth,
    height: boxHeight,
    rotate,
    color: WHITE,
    opacity: 0.88,
    borderColor: color,
    borderWidth: 1,
    borderOpacity: 1,
  });
  let cursor = v + boxHeight - pad;
  for (const line of lines) {
    const baseline = cursor - line.size * 0.9;
    page.drawText(line.text, {
      ...toPage(u + pad, baseline),
      size: line.size,
      font: fonts[line.style],
      color: line.style === 'oblique' ? MUTED : color,
      rotate,
    });
    cursor -= line.size * 1.28;
  }
}

// ---------------------------------------------------------------------------
// Worksheet

type WorksheetSource = { kind: 'stamped'; originalPages: number } | { kind: 'generated'; problem: string | null };

interface CheckDefinition {
  label: string | ((ctx: StampContext) => string);
  rules: RuleId[];
  /** Needs payroll lines (skipped on a "no work" payroll). */
  lineLevel?: boolean;
  /** Needs the wage determination. */
  needsWd?: boolean;
  /** Rate checks cannot run on lines whose classification is not matched. */
  needsMapping?: boolean;
  /** Returns a reason when the check does not apply to this project or payroll. */
  skip?: (ctx: StampContext) => string | null;
}

const CHECKS: CheckDefinition[] = [
  {
    label: 'Classifications compared with the wage determination (work not listed requires a conformance, SF-1444)',
    rules: ['classification-not-on-wd', 'classification-unmapped', 'per-day-rate'],
    lineLevel: true,
    needsWd: true,
  },
  {
    label: 'Basic hourly rates at or above the WD rate for each classification',
    rules: ['base-rate-below-wd'],
    lineLevel: true,
    needsWd: true,
    needsMapping: true,
  },
  {
    label: 'Fringe benefits (plan credits and cash in lieu) cover the WD fringe on all hours worked',
    rules: ['fringe-shortfall', 'fringe-footnote'],
    lineLevel: true,
    needsWd: true,
    needsMapping: true,
  },
  {
    label: 'Overtime: hours over 40 in the workweek paid at 1.5x the basic rate (CWHSSA)',
    rules: ['overtime-rate', 'overtime-unreported'],
    lineLevel: true,
    skip: (ctx) => (ctx.project.settings.overtimeRuleApplies ? null : 'Not applicable to this contract'),
  },
  {
    label: 'Apprentices: registration, wage percentage and ratio',
    rules: ['apprentice-unregistered', 'apprentice-rate', 'apprentice-ratio'],
    lineLevel: true,
    needsWd: true,
    skip: (ctx) => (ctx.payroll.lines.some((l) => l.apprentice) ? null : 'No apprentices on this payroll'),
  },
  {
    label: 'Executive Order minimum wage for classifications marked **',
    rules: ['eo-minimum-wage'],
    lineLevel: true,
    needsWd: true,
    skip: (ctx) => (ctx.project.settings.executiveOrderMinimumWage === null ? 'Not applicable to this project' : null),
  },
  {
    label: 'Arithmetic: daily hours, gross pay, deductions and net pay',
    rules: ['hours-arithmetic', 'gross-arithmetic', 'net-arithmetic', 'gross-exceeds-all-work'],
    lineLevel: true,
  },
  {
    label: 'Identifying numbers (no full Social Security numbers)',
    rules: ['full-ssn'],
    lineLevel: true,
  },
  {
    label: 'Statement of Compliance signed',
    rules: ['soc-missing'],
  },
  {
    label: (ctx) => `Submitted on time (within ${ctx.project.settings.lateAfterDays} days of the week ending)`,
    rules: ['late-submission', 'invalid-date'],
    skip: (ctx) => (ctx.payroll.receivedDate ? null : 'Received date not recorded'),
  },
  {
    label: 'Duplicate weeks and payroll numbering',
    rules: ['duplicate-week', 'payroll-number-gap'],
  },
];

function checkRows(ctx: StampContext, findings: Finding[]): FlowCell[][] {
  const unmatched = findings.filter((f) => f.ruleId === 'classification-unmapped' || f.ruleId === 'classification-not-on-wd').length;
  return CHECKS.map((check) => {
    const label = typeof check.label === 'function' ? check.label(ctx) : check.label;
    let result: string;
    const skipped = check.skip?.(ctx) ?? null;
    if (check.lineLevel && ctx.payroll.noWork) result = 'No work reported';
    else if (check.lineLevel && ctx.payroll.lines.length === 0) result = 'No payroll lines';
    else if (skipped) result = skipped;
    else if (check.needsWd && !ctx.wdNumber?.trim()) result = 'Wage determination not recorded';
    else {
      const own = findings.filter((f) => check.rules.includes(f.ruleId));
      const parts: string[] = [];
      const v = own.filter((f) => f.severity === 'violation').length;
      const w = own.filter((f) => f.severity === 'warning').length;
      const n = own.filter((f) => f.severity === 'info').length;
      if (v) parts.push(plural(v, 'violation'));
      if (w) parts.push(plural(w, 'warning'));
      if (n) parts.push(plural(n, 'note'));
      result = parts.length ? parts.join(', ') : 'No exceptions';
      if (check.needsMapping && unmatched > 0) result += `; ${plural(unmatched, 'line')} not rate-checked (no WD classification)`;
    }
    return [label, result];
  });
}

function writeWorksheet(flow: PdfFlow, ctx: StampContext, source: WorksheetSource): void {
  const { project, contractor, payroll } = ctx;
  const result = reviewResult(ctx);
  const notation = reviewNotation(ctx);

  flow.addPage(LETTER_PORTRAIT);
  flow.text('Payroll Review Worksheet', { size: 17, style: 'bold', after: 3 });
  flow.text(REVIEW_AID_NOTICE, { size: 7.5, style: 'oblique', color: MUTED, after: 10 });
  flow.banner(
    [
      { text: notation.heading, style: 'bold' },
      { text: notation.result, style: 'bold' },
    ],
    { borderColor: TONE_COLORS[result.tone], color: TONE_COLORS[result.tone], size: 9.5 },
  );

  if (source.kind === 'stamped') {
    flow.text(
      `Original: the contractor's PDF${payroll.source.fileName ? ` "${payroll.source.fileName}"` : ''} (${plural(source.originalPages, 'page')}). The review notation is stamped on page 1; this worksheet begins on page ${source.originalPages + 1}.`,
      { size: 8.5, color: MUTED, after: 8 },
    );
  } else if (source.problem) {
    flow.text(
      `The contractor's original PDF could not be stamped: ${source.problem} Keep the original file with this worksheet. The payroll lines as recorded in Wagebench follow the worksheet.`,
      { size: 8.5, style: 'oblique', color: TONE_COLORS.warnings, after: 8 },
    );
  } else {
    const how =
      payroll.source.kind === 'manual'
        ? 'entered by the reviewer'
        : `imported from ${SOURCE_LABELS[payroll.source.kind] ?? 'a file'}${payroll.source.fileName ? ` "${payroll.source.fileName}"` : ''}`;
    flow.text(`No original PDF: the payroll was ${how}. The payroll lines as submitted follow the worksheet.`, {
      size: 8.5,
      color: MUTED,
      after: 8,
    });
  }

  const flags = [
    payroll.noWork ? 'No work performed' : null,
    payroll.isFinal ? 'Final payroll' : null,
    payroll.supersedesPayrollId ? 'Corrected payroll (replaces an earlier submission)' : null,
  ].filter(Boolean);
  const received = payroll.receivedDate
    ? `${formatDate(payroll.receivedDate)}${
        isIsoDate(payroll.receivedDate) && isIsoDate(payroll.weekEnding)
          ? ` (${plural(daysBetween(payroll.weekEnding, payroll.receivedDate), 'day')} after week ending)`
          : ''
      }`
    : 'Not recorded';
  flow.keyValues([
    ['Project', [project.name, project.projectNumber ? `(${project.projectNumber})` : ''].filter(Boolean).join(' ')],
    ['Location', project.location],
    ['Owner / grantee', project.owner],
    ['Funding', project.fundingSource],
    ['Contractor', [contractor.name, [TIER_LABELS[contractor.tier], contractor.trade].filter(Boolean).join(', ')].filter(Boolean).join(' - ')],
    ['Payroll no.', [payroll.payrollNumber || '(none)', ...flags].join(' - ')],
    ['Week ending', formatDate(payroll.weekEnding)],
    ['Received', received],
    ['Statement of Compliance', payroll.statementOfComplianceSigned ? 'Signed' : 'Not signed'],
    [
      'Wage determination',
      ctx.wdNumber?.trim()
        ? `${ctx.wdNumber.trim()}${ctx.wdModification !== null ? `, Modification ${ctx.wdModification}` : ''}${project.wdLockDate ? ` (locked in ${formatDate(project.wdLockDate)})` : ''}`
        : 'Not recorded',
    ],
    ['Workers on payroll', payroll.noWork ? 'None (no work performed)' : String(payroll.lines.length)],
    ['Reviewed on', formatDate(ctx.reviewedOn)],
    ['Reviewer', [ctx.reviewer.name, ctx.reviewer.title, ctx.reviewer.organization].filter((s) => s.trim()).join(', ')],
  ]);

  flow.heading('Checks performed');
  flow.table({
    columns: [
      { header: 'Check', weight: 64 },
      { header: 'Result', weight: 36 },
    ],
    rows: checkRows(ctx, result.findings),
  });

  flow.heading('Findings');
  if (result.findings.length === 0) {
    flow.text('No exceptions noted.', { size: 9.5, after: 8 });
  }
  for (const severity of ['violation', 'warning', 'info'] as const) {
    const group = result.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    flow.table({
      title: `${SEVERITY_GROUP_LABELS[severity]} (${group.length})`,
      columns: [
        { header: '#', weight: 4 },
        { header: 'Worker', weight: 19 },
        { header: 'Finding', weight: 62 },
        { header: 'Amount owed', weight: 15, align: 'right' },
      ],
      rows: group.map((f, i) => [
        String(i + 1),
        f.workerName ?? '(payroll)',
        [
          { text: f.supersededBy ? `${f.title} (superseded by a corrected payroll)` : f.title, style: 'bold' as const },
          { text: f.detail },
        ],
        f.amountOwed > 0 ? formatMoney(f.amountOwed) : '-',
      ]),
    });
  }

  writeRateComparison(flow, ctx);

  flow.heading('Restitution');
  const owedByWorker = new Map<string, number>();
  for (const f of result.findings) {
    if (f.amountOwed <= 0) continue;
    const worker = f.workerName ?? '(worker not named)';
    owedByWorker.set(worker, cents((owedByWorker.get(worker) ?? 0) + f.amountOwed));
  }
  if (owedByWorker.size === 0) {
    flow.text('No underpayments were identified on this payroll.', { size: 9.5, after: 8 });
  } else {
    flow.table({
      columns: [
        { header: 'Worker', weight: 70 },
        { header: 'Back wages owed', weight: 30, align: 'right' },
      ],
      rows: [...owedByWorker.entries()].map(([worker, amount]) => [worker, formatMoney(amount)]),
      footer: [`Total (${plural(owedByWorker.size, 'worker')})`, formatMoney(result.owed)],
    });
    flow.text(
      `Restitution required: the contractor must pay the back wages shown to each worker, submit a corrected certified payroll marked as a correction, and provide proof of payment (for example cancelled checks or receipts signed by the workers). Total restitution on this payroll: ${formatMoney(result.owed)}.`,
      { size: 9, after: 8 },
    );
  }

  if (payroll.reviewNote.trim()) {
    flow.heading("Reviewer's notes");
    flow.text(payroll.reviewNote.trim(), { size: 9, after: 8 });
  }

  writeSignature(flow, ctx);
}

function writeRateComparison(flow: PdfFlow, ctx: StampContext): void {
  const analyses = ctx.lineAnalyses;
  if (!analyses || ctx.payroll.lines.length === 0) return;
  flow.heading('Rate comparison with the wage determination');
  flow.table({
    fontSize: 7.5,
    columns: [
      { header: 'Worker', weight: 17 },
      { header: 'Payroll classification', weight: 17 },
      { header: 'WD classification', weight: 20 },
      { header: 'Hours ST / OT', weight: 10, align: 'right' },
      { header: 'Paid base + fringe', weight: 13, align: 'right' },
      { header: 'Required base + fringe', weight: 13, align: 'right' },
      { header: 'Owed', weight: 10, align: 'right' },
    ],
    rows: ctx.payroll.lines.map((line) => {
      const a = analyses.get(line.id);
      const wd = a?.classification
        ? `${a.classification.label}${a.classification.scope ? ` (${a.classification.scope})` : ''}`
        : a?.mappingSource === 'not-on-wd'
          ? 'Not on WD (conformance needed)'
          : 'Not matched';
      const paidFringe = a ? a.paidFringe : line.fringePlanHourly + line.fringeCashHourly;
      const required =
        a && a.requiredBase !== null ? `${formatRate(a.requiredBase)} + ${formatRate(a.requiredFringe ?? 0)}` : '-';
      return [
        line.workerName || '(unnamed)',
        `${line.classification || '(blank)'}${line.apprentice ? ' (apprentice)' : ''}`,
        wd,
        `${formatHours(line.totalST)} / ${formatHours(line.totalOT)}`,
        `${formatRate(a ? a.paidBase : line.rateST)} + ${formatRate(paidFringe)}`,
        required,
        a && a.owed > 0 ? formatMoney(a.owed) : '-',
      ];
    }),
  });
}

function writeSignature(flow: PdfFlow, ctx: StampContext): void {
  const size = 9;
  flow.ensure(118);
  flow.heading('Review sign-off', 11.5, 90);
  flow.text(
    `I compared this payroll with ${wdLong(ctx.wdNumber, ctx.wdModification)} and recorded the results above.`,
    { size, after: 26 },
  );
  const page = flow.page;
  const lineY = flow.y;
  const sigEnd = flow.left + flow.width * 0.62;
  const dateStart = flow.left + flow.width * 0.7;
  page.drawLine({ start: { x: flow.left, y: lineY }, end: { x: sigEnd, y: lineY }, thickness: 0.75, color: INK });
  page.drawLine({ start: { x: dateStart, y: lineY }, end: { x: flow.left + flow.width, y: lineY }, thickness: 0.75, color: INK });
  page.drawText('Reviewer signature', { x: flow.left, y: lineY - 10, size: 7.5, font: flow.fonts.regular, color: MUTED });
  page.drawText('Date', { x: dateStart, y: lineY - 10, size: 7.5, font: flow.fonts.regular, color: MUTED });
  flow.y = lineY - 18;
  const printed = [ctx.reviewer.name, ctx.reviewer.title, ctx.reviewer.organization].filter((s) => s.trim());
  flow.text(printed.join(', ') || 'Reviewer', { size, style: 'bold', after: 4 });
}

// ---------------------------------------------------------------------------
// Payroll lines as submitted (only when there is no original to attach)

function money(value: number | null): string {
  return value === null ? '-' : formatMoney(value);
}

function sumKnown(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? cents(sum(known)) : null;
}

function writePayrollLines(flow: PdfFlow, ctx: StampContext): void {
  const { payroll, contractor } = ctx;
  flow.addPage(LETTER_LANDSCAPE);
  flow.text('Payroll as submitted', { size: 14, style: 'bold', after: 3 });
  const masked = payroll.lines.some((l) => maskIdentifier(l.workerId) !== l.workerId.trim());
  flow.text(
    `${contractor.name} - payroll ${payroll.payrollNumber || '(no number)'} - week ending ${formatDate(payroll.weekEnding)}. Source: ${SOURCE_LABELS[payroll.source.kind] ?? 'unknown'}${payroll.source.fileName ? ` "${payroll.source.fileName}"` : ''}.${masked ? ' Identifying numbers that look like full SSNs are shown as the last four digits only.' : ''}`,
    { size: 8.5, color: MUTED, after: 8 },
  );
  if (payroll.lines.length === 0) {
    flow.text(payroll.noWork ? 'No work performed this week (no payroll lines).' : 'No payroll lines were entered.', {
      size: 10,
    });
    return;
  }
  const lines: PayrollLine[] = payroll.lines;
  flow.table({
    fontSize: 7,
    columns: [
      { header: 'Worker', weight: 15 },
      { header: 'ID', weight: 7 },
      { header: 'Classification', weight: 15 },
      { header: 'J / RA', weight: 4 },
      { header: 'ST hrs', weight: 5, align: 'right' },
      { header: 'OT hrs', weight: 5, align: 'right' },
      { header: 'Rate', weight: 6.5, align: 'right' },
      { header: 'OT rate', weight: 6.5, align: 'right' },
      { header: 'Fringe plan', weight: 6, align: 'right' },
      { header: 'Fringe cash', weight: 6, align: 'right' },
      { header: 'Gross (project)', weight: 8, align: 'right' },
      { header: 'Gross (all work)', weight: 8, align: 'right' },
      { header: 'Deductions', weight: 8, align: 'right' },
      { header: 'Net pay', weight: 8, align: 'right' },
    ],
    rows: lines.map((l) => [
      l.workerName || '(unnamed)',
      maskIdentifier(l.workerId) || '-',
      l.classification || '(blank)',
      l.apprentice ? 'RA' : 'J',
      formatHours(l.totalST),
      formatHours(l.totalOT),
      formatRate(l.rateST),
      l.rateOT === null ? '-' : formatRate(l.rateOT),
      formatRate(l.fringePlanHourly),
      formatRate(l.fringeCashHourly),
      money(l.grossThisProject),
      money(l.grossAllWork),
      money(l.deductions),
      money(l.netPay),
    ]),
    footer: [
      `Total (${plural(lines.length, 'line')})`,
      '',
      '',
      '',
      formatHours(Math.round(sum(lines.map((l) => l.totalST)) * 100) / 100),
      formatHours(Math.round(sum(lines.map((l) => l.totalOT)) * 100) / 100),
      '',
      '',
      '',
      '',
      money(sumKnown(lines.map((l) => l.grossThisProject))),
      money(sumKnown(lines.map((l) => l.grossAllWork))),
      money(sumKnown(lines.map((l) => l.deductions))),
      money(sumKnown(lines.map((l) => l.netPay))),
    ],
  });
}
