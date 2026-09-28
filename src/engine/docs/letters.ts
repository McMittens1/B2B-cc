import { PDFDocument } from 'pdf-lib';
import type { PayrollState, PayrollSummary } from '../checks/evaluate';
import { addDays, formatDate, isIsoDate, todayIso } from '../dates';
import { cents, formatMoney, sum } from '../money';
import { buildLedger, type LedgerRow } from '../restitution';
import type { Contractor, Finding, ISODate, Payroll, Project, RuleId } from '../types';
import { MUTED, PdfFlow, embedStandardFonts, fitColumnWidths } from './pdf-layout';
import { RULE_LABELS, addressLines, longDate, plural, wdLong } from './wording';

export type LetterKind = 'correction-request' | 'missing-payrolls' | 'review-memo';

export const LETTER_KIND_LABELS: Record<LetterKind, string> = {
  'correction-request': 'Correction request',
  'missing-payrolls': 'Missing payrolls',
  'review-memo': 'Review memo to file',
};

export interface LetterTable {
  title: string;
  columns: string[];
  rows: string[][];
  /** Totals row, aligned with the columns. */
  footer?: string[];
  /** Index of the paragraph the table follows; after the last paragraph when omitted. */
  afterParagraph?: number;
  /** Columns holding amounts or counts, right-aligned by the renderers. Detected when omitted. */
  numericColumns?: number[];
}

/**
 * A letter or memo as plain data, so the reviewer can preview it and the same content
 * renders to text (email body), Word (to edit on letterhead) and PDF (to send as is).
 */
export interface Letter {
  kind: LetterKind;
  date: ISODate;
  to: string[];
  from: string[];
  subject: string;
  paragraphs: string[];
  tables: LetterTable[];
  closing: string[];
}

export interface LetterReviewer {
  name: string;
  title: string;
  organization: string;
  email?: string;
  phone?: string;
}

export interface MissingWeek {
  contractorId: string;
  weekEnding: ISODate;
}

/** One payroll as the letters describe it; build with letterPayrollSummaries(). */
export interface LetterPayrollSummary {
  payrollId: string;
  contractorId: string;
  payrollNumber: string;
  weekEnding: ISODate;
  receivedDate: ISODate | null;
  noWork: boolean;
  state: PayrollState;
  violations: number;
  warnings: number;
  owed: number;
}

export interface LetterContext {
  project: Project;
  /** Addressee. Required for a correction request; omitted for the memo. */
  contractor?: Contractor | null;
  /** Every contractor on the project, for names and to find the prime contractor. */
  contractors?: readonly Contractor[];
  /** Defaults to the project's reviewer. */
  reviewer?: LetterReviewer;
  /** Date of the letter; defaults to today. */
  date?: ISODate;
  /**
   * Open findings (dismissed ones removed). Findings on superseded payrolls may be
   * included; they are history and never listed as items to correct.
   */
  findings: readonly Finding[];
  /** Rows from buildLedger(); derived from the findings (all unpaid) when omitted. */
  ledgerRows?: readonly LedgerRow[];
  payrolls?: readonly LetterPayrollSummary[];
  /** Weeks with no payroll; taken from "missing-week" findings when omitted. */
  missingWeeks?: readonly MissingWeek[];
  /** Days the contractor has to respond (default 14). */
  responseDays?: number;
  wdNumber?: string | null;
  wdModification?: number | null;
}

/** Join payrolls with their evaluation summaries into the shape the letters use. */
export function letterPayrollSummaries(
  payrolls: readonly Payroll[],
  summaries: ReadonlyMap<string, PayrollSummary>,
): LetterPayrollSummary[] {
  return payrolls
    .map((p) => {
      const s = summaries.get(p.id);
      return {
        payrollId: p.id,
        contractorId: p.contractorId,
        payrollNumber: p.payrollNumber,
        weekEnding: p.weekEnding,
        receivedDate: p.receivedDate,
        noWork: p.noWork,
        state: s?.state ?? 'clean',
        violations: s?.violations ?? 0,
        warnings: s?.warnings ?? 0,
        owed: s?.owed ?? 0,
      };
    })
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding) || a.payrollNumber.localeCompare(b.payrollNumber));
}

/**
 * Draft a letter from the review results. Wording is factual and states what the
 * contractor must do and by when; amounts come from the findings so the letter always
 * matches the worksheet and the restitution ledger.
 */
export function composeLetter(kind: LetterKind, ctx: LetterContext): Letter {
  const env = letterEnvironment(ctx);
  switch (kind) {
    case 'correction-request':
      return correctionRequest(env);
    case 'missing-payrolls':
      return missingPayrolls(env);
    case 'review-memo':
      return reviewMemo(env);
    default:
      throw new Error(`Unknown letter kind: ${String(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// Composition

interface LetterEnv {
  ctx: LetterContext;
  project: Project;
  contractor: Contractor | null;
  reviewer: LetterReviewer;
  date: ISODate;
  days: number;
  dueDate: ISODate;
  nameOf: (contractorId: string) => string;
  contractorsById: Map<string, Contractor>;
  payrollById: Map<string, LetterPayrollSummary>;
  ledgerRows: readonly LedgerRow[];
  missing: MissingWeek[];
  wd: string;
}

function letterEnvironment(ctx: LetterContext): LetterEnv {
  const reviewer = ctx.reviewer ?? ctx.project.reviewer;
  const date = ctx.date && isIsoDate(ctx.date) ? ctx.date : todayIso();
  const days =
    typeof ctx.responseDays === 'number' && Number.isFinite(ctx.responseDays) && ctx.responseDays > 0
      ? Math.round(ctx.responseDays)
      : 14;
  const contractorsById = new Map((ctx.contractors ?? []).map((c) => [c.id, c]));
  if (ctx.contractor) contractorsById.set(ctx.contractor.id, ctx.contractor);
  const ledgerRows = ctx.ledgerRows ?? buildLedger(ctx.findings, [], [...contractorsById.values()]).rows;
  const missing = (
    ctx.missingWeeks ??
    ctx.findings
      .filter((f) => f.ruleId === 'missing-week' && f.weekEnding)
      .map((f) => ({ contractorId: f.contractorId, weekEnding: f.weekEnding! }))
  )
    .filter((m) => isIsoDate(m.weekEnding))
    .slice()
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
  return {
    ctx,
    project: ctx.project,
    contractor: ctx.contractor ?? null,
    reviewer,
    date,
    days,
    dueDate: addDays(date, days),
    nameOf: (id) => contractorsById.get(id)?.name ?? 'Unknown contractor',
    contractorsById,
    payrollById: new Map((ctx.payrolls ?? []).map((p) => [p.payrollId, p])),
    ledgerRows,
    missing,
    wd: wdLong(ctx.wdNumber, ctx.wdModification),
  };
}

class Body {
  readonly paragraphs: string[] = [];
  readonly tables: LetterTable[] = [];

  p(text: string): this {
    this.paragraphs.push(text);
    return this;
  }

  /** Attach a table after the paragraph written most recently. */
  t(table: Omit<LetterTable, 'afterParagraph'>): this {
    this.tables.push({ ...table, afterParagraph: this.paragraphs.length - 1 });
    return this;
  }
}

const nonEmpty = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim() !== '';

function projectLabel(project: Project): string {
  return project.projectNumber.trim() ? `${project.name} (project no. ${project.projectNumber.trim()})` : project.name;
}

function letterFrom(r: LetterReviewer): string[] {
  return [r.organization, [r.name, r.title].filter(nonEmpty).join(', '), r.email, r.phone].filter(nonEmpty);
}

function addressee(c: Contractor): string[] {
  return [c.contactName, c.name, ...addressLines(c.address), c.contactEmail].filter(nonEmpty);
}

function salutation(c: Contractor | null): string {
  const who = c?.contactName.trim() || c?.name.trim();
  return who ? `Dear ${who}:` : 'To the contractor:';
}

function contactSentence(r: LetterReviewer): string {
  const how = [r.email, r.phone].filter(nonEmpty).join(' or ');
  const who = r.name.trim() || 'the reviewer';
  return `If you have questions about this letter, contact ${who}${how ? ` at ${how}` : ''}.`;
}

function signature(env: LetterEnv, cc: string[]): string[] {
  const r = env.reviewer;
  const lines = ['Sincerely,', '', '', ...[r.name, r.title, r.organization].filter(nonEmpty)];
  if (cc.length) lines.push('', ...cc.map((c) => `cc: ${c}`));
  return lines;
}

function ccFor(env: LetterEnv, addressed: Contractor | null): string[] {
  const cc: string[] = [];
  if (addressed && addressed.tier !== 'prime') {
    const prime = [...env.contractorsById.values()].find((c) => c.tier === 'prime' && c.id !== addressed.id);
    if (prime) cc.push(`${prime.name} (prime contractor)`);
  }
  const owner = env.project.owner.trim();
  if (owner && owner !== env.reviewer.organization.trim()) cc.push(owner);
  return cc;
}

function weekRange(weeks: string[]): string | null {
  const sorted = [...new Set(weeks.filter((w) => isIsoDate(w)))].sort();
  if (sorted.length === 0) return null;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return first === last ? `the week ending ${formatDate(first)}` : `weeks ending ${formatDate(first)} through ${formatDate(last)}`;
}

function missingTable(env: LetterEnv, weeks: MissingWeek[]): Omit<LetterTable, 'afterParagraph'> {
  const byContractor = new Map<string, string[]>();
  for (const m of weeks) byContractor.set(m.contractorId, [...(byContractor.get(m.contractorId) ?? []), m.weekEnding]);
  const rows = [...byContractor.entries()]
    .map(([id, list]) => [env.nameOf(id), [...new Set(list)].sort().map(formatDate).join(', '), String(new Set(list).size)])
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
  const total = sum(rows.map((r) => Number(r[2])));
  return {
    title: 'Payrolls not received',
    columns: ['Contractor', 'Weeks ending', 'Weeks'],
    rows,
    footer: rows.length > 1 ? ['Total', '', String(total)] : undefined,
    numericColumns: [2],
  };
}

const UNDERPAYMENT_LABELS: Partial<Record<RuleId, string>> = {
  'base-rate-below-wd': 'Basic hourly rate below the wage determination',
  'fringe-shortfall': 'Fringe benefits short',
  'overtime-rate': 'Overtime paid below 1.5x the basic rate',
  'overtime-unreported': 'Hours over 40 paid at straight time',
  'eo-minimum-wage': 'Below the Executive Order minimum wage',
  'apprentice-rate': 'Apprentice paid below the program wage schedule',
  'apprentice-ratio': 'Apprentice over the allowed ratio (journeyworker rate due)',
};

/** What the contractor must do about a finding that carries no back wages; null if nothing. */
function correctionItem(f: Finding): string | null {
  const worker = f.workerName?.trim() || 'Worker';
  switch (f.ruleId) {
    case 'soc-missing':
      return f.severity === 'violation'
        ? 'Provide a signed Statement of Compliance for this payroll.'
        : 'Sign the "no work performed" payroll.';
    case 'classification-not-on-wd':
      return `${worker}: ${f.title}. Reclassify the worker to the listed classification that matches the work performed and pay that rate, or request a conformance (Standard Form 1444) through the contracting agency.`;
    case 'apprentice-unregistered':
      return `${worker}: provide proof that the apprentice is individually registered in a program registered with the DOL Office of Apprenticeship or a State Apprenticeship Agency, with the program's wage schedule, or pay the journeyworker rate.`;
    case 'full-ssn':
      return 'Show only an individual identifying number (for example the last four digits of the Social Security number), not full Social Security numbers.';
    case 'hours-arithmetic':
    case 'gross-arithmetic':
    case 'net-arithmetic':
    case 'gross-exceeds-all-work':
      return `${f.title}. ${f.detail} Correct the payroll figures.`;
    case 'duplicate-week':
      return `${f.title}. If one payroll corrects another, mark the correction as such and identify the payroll it replaces.`;
    case 'payroll-number-gap':
      return `${f.title}. Submit any payroll missing from the sequence, or explain the numbering.`;
    case 'late-submission':
      return `${f.title}. Certified payrolls are due weekly; submit future payrolls on time.`;
    default:
      return null;
  }
}

function correctionRequest(env: LetterEnv): Letter {
  const c = env.contractor;
  if (!c) throw new Error('A correction request needs the contractor it is addressed to.');
  const body = new Body();
  body.p(salutation(c));

  const ownFindings = env.ctx.findings.filter((f) => f.contractorId === c.id);
  const ownPayrolls = (env.ctx.payrolls ?? []).filter((p) => p.contractorId === c.id);
  const range = weekRange(
    ownPayrolls.length > 0
      ? ownPayrolls.map((p) => p.weekEnding)
      : ownFindings.filter((f) => f.payrollId !== null).map((f) => f.weekEnding ?? ''),
  );
  body.p(
    `We reviewed the certified payrolls ${c.name} submitted for ${projectLabel(env.project)}${range ? `, covering ${range},` : ''} against ${env.wd}. The review found the items described below, which must be corrected.`,
  );

  // Back wages, one row per worker per week.
  const ledger = env.ledgerRows.filter((r) => r.finding.contractorId === c.id);
  const due = ledger.filter((r) => r.balance > 0 && r.status !== 'waived' && r.status !== 'verified');
  interface Group {
    week: string;
    worker: string;
    payrollNumbers: Set<string>;
    reasons: string[];
    owed: number;
    paid: number;
    balance: number;
  }
  const groups = new Map<string, Group>();
  for (const r of due) {
    const week = r.finding.weekEnding ?? '';
    const worker = r.finding.workerName?.trim() || '(worker not named)';
    const key = `${week}\u0000${worker}`;
    const g = groups.get(key) ?? { week, worker, payrollNumbers: new Set(), reasons: [], owed: 0, paid: 0, balance: 0 };
    const payrollNumber = r.finding.payrollId ? env.payrollById.get(r.finding.payrollId)?.payrollNumber : undefined;
    if (payrollNumber) g.payrollNumbers.add(payrollNumber);
    const reason = UNDERPAYMENT_LABELS[r.finding.ruleId] ?? RULE_LABELS[r.finding.ruleId] ?? r.finding.title;
    if (!g.reasons.includes(reason)) g.reasons.push(reason);
    g.owed = cents(g.owed + r.amountOwed);
    g.paid = cents(g.paid + r.amountPaid);
    g.balance = cents(g.balance + r.balance);
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.week.localeCompare(b.week) || a.worker.localeCompare(b.worker));
  const totalDue = cents(sum(rows.map((g) => g.balance)));
  const workers = new Set(rows.map((g) => g.worker));

  if (rows.length > 0) {
    const anyPaid = rows.some((g) => g.paid > 0);
    const showPayroll = rows.some((g) => g.payrollNumbers.size > 0);
    const columns = ['Week ending', ...(showPayroll ? ['Payroll no.'] : []), 'Worker', 'Underpayment'];
    const lead = columns.length;
    body.p(
      `Workers were paid less than ${env.wd} requires. Back wages totaling ${formatMoney(totalDue)} are due to ${plural(workers.size, 'worker')}, as follows:`,
    );
    body.t({
      title: 'Back wages due',
      columns: anyPaid ? [...columns, 'Owed', 'Paid', 'Balance due'] : [...columns, 'Amount due'],
      rows: rows.map((g) => [
        formatDate(g.week),
        ...(showPayroll ? [[...g.payrollNumbers].join(', ') || '-'] : []),
        g.worker,
        g.reasons.join('; '),
        ...(anyPaid ? [formatMoney(g.owed), formatMoney(g.paid), formatMoney(g.balance)] : [formatMoney(g.balance)]),
      ]),
      footer: [
        'Total',
        ...Array.from({ length: lead - 1 }, () => ''),
        ...(anyPaid
          ? [
              formatMoney(cents(sum(rows.map((g) => g.owed)))),
              formatMoney(cents(sum(rows.map((g) => g.paid)))),
              formatMoney(totalDue),
            ]
          : [formatMoney(totalDue)]),
      ],
      numericColumns: anyPaid ? [lead, lead + 1, lead + 2] : [lead],
    });
    const perWorker = new Map<string, { weeks: number; amount: number }>();
    for (const g of rows) {
      const w = perWorker.get(g.worker) ?? { weeks: 0, amount: 0 };
      perWorker.set(g.worker, { weeks: w.weeks + 1, amount: cents(w.amount + g.balance) });
    }
    if ([...perWorker.values()].some((w) => w.weeks > 1)) {
      body.t({
        title: 'Total due to each worker',
        columns: ['Worker', 'Weeks', 'Amount due'],
        rows: [...perWorker.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([worker, w]) => [worker, String(w.weeks), formatMoney(w.amount)]),
        footer: ['Total', '', formatMoney(totalDue)],
        numericColumns: [1, 2],
      });
    }
    body.t({
      title: 'How the amounts were calculated',
      columns: ['Week ending', 'Worker', 'Calculation'],
      rows: due
        .slice()
        .sort(
          (a, b) =>
            (a.finding.weekEnding ?? '').localeCompare(b.finding.weekEnding ?? '') ||
            (a.finding.workerName ?? '').localeCompare(b.finding.workerName ?? ''),
        )
        .map((r) => [formatDate(r.finding.weekEnding), r.finding.workerName?.trim() || '-', r.finding.detail]),
      numericColumns: [],
    });
    body.p(`To correct the underpayments, within ${env.days} days of the date of this letter (by ${longDate(env.dueDate)}):`);
    body.p('1. Pay each worker listed the full amount due shown above.');
    body.p(
      '2. Submit a corrected certified payroll for each week listed, clearly marked as a correction, showing the corrected rates and the back wages paid, with a newly signed Statement of Compliance.',
    );
    body.p(
      '3. Provide proof of payment for each worker, such as copies of the cancelled checks (front and back) or receipts signed by each worker showing the gross amount, deductions and net amount paid.',
    );
    body.p('4. If a worker cannot be located, tell us in writing and describe the efforts made to find the worker.');
  }

  const unverified = ledger.filter((r) => r.status === 'paid' && r.amountPaid > 0);
  if (unverified.length > 0) {
    const amount = cents(sum(unverified.map((r) => r.amountPaid)));
    body.p(
      `Payments you reported for ${plural(new Set(unverified.map((r) => `${r.finding.weekEnding}|${r.finding.workerName}`)).size, 'underpayment')} (${formatMoney(amount)}) still need proof of payment, such as cancelled checks or signed receipts.`,
    );
  }

  // Items that need correcting but carry no back wages.
  const itemRows = new Map<string, { week: string; payroll: string; text: string; workers: Set<string> }>();
  for (const f of ownFindings) {
    if (f.supersededBy || f.amountOwed > 0 || f.severity === 'info') continue;
    const text = correctionItem(f);
    if (!text) continue;
    const week = f.weekEnding ?? '';
    const payroll = f.payrollId ? env.payrollById.get(f.payrollId)?.payrollNumber ?? '' : '';
    const key = `${week}\u0000${payroll}\u0000${f.ruleId === 'full-ssn' ? f.ruleId : text}`;
    const item = itemRows.get(key) ?? { week, payroll, text, workers: new Set<string>() };
    if (f.ruleId === 'full-ssn' && f.workerName) item.workers.add(f.workerName);
    itemRows.set(key, item);
  }
  if (itemRows.size > 0) {
    body.p(
      `The following items also need correction. Where a document is missing, provide it within the same ${env.days} days; otherwise correct future payrolls.`,
    );
    const items = [...itemRows.values()].sort((a, b) => a.week.localeCompare(b.week) || a.text.localeCompare(b.text));
    const showPayroll = items.some((i) => i.payroll);
    body.t({
      title: 'Other items requiring correction',
      columns: ['Week ending', ...(showPayroll ? ['Payroll no.'] : []), 'Item to correct'],
      rows: items.map((i) => [
        formatDate(i.week || null),
        ...(showPayroll ? [i.payroll || '-'] : []),
        i.workers.size ? `${i.text} Workers: ${[...i.workers].sort().join(', ')}.` : i.text,
      ]),
      numericColumns: [],
    });
  }

  const missing = env.missing.filter((m) => m.contractorId === c.id);
  if (missing.length > 0) {
    body.p(
      `Our records also show no payroll for the weeks listed below. For each week, submit the certified payroll with a signed Statement of Compliance or, if no work was performed on the project that week, a payroll marked "No work performed".`,
    );
    body.t(missingTable(env, missing));
  }

  if (rows.length === 0 && itemRows.size === 0 && missing.length === 0 && unverified.length === 0) {
    body.p('No items requiring correction were found. No action is needed at this time.');
  } else {
    body.p(
      `The amounts and items above are based on the payrolls as submitted and the rates in ${env.wd}. If you believe an item is in error, send supporting documentation within ${env.days} days.`,
    );
    if (totalDue > 0 || missing.length > 0) {
      body.p(
        'Until the corrections are received, payments under the contract may be withheld as provided in the contract labor standards provisions.',
      );
    }
  }
  body.p(contactSentence(env.reviewer));

  return {
    kind: 'correction-request',
    date: env.date,
    to: addressee(c),
    from: letterFrom(env.reviewer),
    subject: `Certified payroll corrections required - ${projectLabel(env.project)}`,
    paragraphs: body.paragraphs,
    tables: body.tables,
    closing: signature(env, ccFor(env, c)),
  };
}

function missingPayrolls(env: LetterEnv): Letter {
  const c = env.contractor;
  const body = new Body();
  body.p(salutation(c));
  const includesOthers = !c || c.tier === 'prime';
  const weeks = includesOthers ? env.missing : env.missing.filter((m) => m.contractorId === c.id);
  const others = c ? weeks.filter((m) => m.contractorId !== c.id) : [];

  if (weeks.length === 0) {
    body.p(
      `Our records for ${projectLabel(env.project)} show that all required certified payrolls${c ? ` from ${c.name}` : ''} have been received as of ${longDate(env.date)}. No action is needed.`,
    );
  } else {
    body.p(
      `Our records for ${projectLabel(env.project)} show that certified payrolls have not been received for the weeks listed below. A certified payroll is required for every week in which work is performed on the project, from the start of work until completion (29 CFR 5.5(a)(3)).`,
    );
    body.t(missingTable(env, weeks));
    if (c && others.length > 0) {
      body.p(
        `As prime contractor, ${c.name} is responsible for the submission of certified payrolls by all of its subcontractors, including those listed above.`,
      );
    }
    body.p(
      `Within ${env.days} days of the date of this letter (by ${longDate(env.dueDate)}), submit for each week listed either the certified payroll with a signed Statement of Compliance or, if no work was performed on the project that week, a payroll or signed statement marked "No work performed".`,
    );
    body.p('Payment under the contract may be withheld until the missing payrolls are received, as provided in the contract.');
  }
  body.p(contactSentence(env.reviewer));

  return {
    kind: 'missing-payrolls',
    date: env.date,
    to: c ? addressee(c) : ['All contractors', env.project.name],
    from: letterFrom(env.reviewer),
    subject: `Certified payrolls not received - ${projectLabel(env.project)}`,
    paragraphs: body.paragraphs,
    tables: body.tables,
    closing: signature(env, c ? ccFor(env, c) : []),
  };
}

const STATE_LABELS: Record<PayrollState, string> = {
  clean: 'No exceptions',
  warnings: 'Warnings',
  violations: 'Violations',
  superseded: 'Superseded by correction',
};

function reviewMemo(env: LetterEnv): Letter {
  const { project, reviewer } = env;
  const body = new Body();
  const payrolls = (env.ctx.payrolls ?? []).slice().sort(
    (a, b) =>
      env.nameOf(a.contractorId).localeCompare(env.nameOf(b.contractorId)) ||
      a.weekEnding.localeCompare(b.weekEnding) ||
      a.payrollNumber.localeCompare(b.payrollNumber),
  );
  const contractorCount = new Set(payrolls.map((p) => p.contractorId)).size;
  body.p(
    `This memo documents the review of certified payrolls for ${projectLabel(project)}${project.location.trim() ? `, ${project.location.trim()}` : ''}, funded by ${project.fundingSource}. Payrolls were compared with ${env.wd}${project.wdLockDate ? `, locked in on ${formatDate(project.wdLockDate)}` : ''}.`,
  );

  if (payrolls.length > 0) {
    const count = (state: PayrollState) => payrolls.filter((p) => p.state === state).length;
    const noWork = payrolls.filter((p) => p.noWork).length;
    const range = weekRange(payrolls.map((p) => p.weekEnding));
    body.p(
      `${plural(payrolls.length, 'payroll')} from ${plural(contractorCount, 'contractor')} ${payrolls.length === 1 ? 'was' : 'were'} reviewed${range ? `, covering ${range}` : ''}${noWork ? ` (${noWork} "no work" ${noWork === 1 ? 'payroll' : 'payrolls'})` : ''}. ${count('clean')} had no exceptions, ${count('warnings')} had warnings only, and ${count('violations')} had violations.${count('superseded') ? ` ${plural(count('superseded'), 'payroll')} ${count('superseded') === 1 ? 'was' : 'were'} superseded by corrected payrolls.` : ''}`,
    );
    body.t({
      title: 'Payrolls reviewed',
      columns: ['Contractor', 'Payroll no.', 'Week ending', 'Received', 'Result', 'Owed'],
      rows: payrolls.map((p) => [
        env.nameOf(p.contractorId),
        p.payrollNumber || '-',
        formatDate(p.weekEnding),
        formatDate(p.receivedDate),
        p.noWork
          ? `No work${p.state === 'clean' ? '' : `; ${STATE_LABELS[p.state].toLowerCase()}`}`
          : p.state === 'violations'
            ? `${plural(p.violations, 'violation')}${p.warnings ? `, ${plural(p.warnings, 'warning')}` : ''}`
            : p.state === 'warnings'
              ? plural(p.warnings, 'warning')
              : STATE_LABELS[p.state],
        p.owed > 0 ? formatMoney(p.owed) : '-',
      ]),
      numericColumns: [5],
    });
  } else {
    body.p('No payrolls have been reviewed yet.');
  }

  const open = env.ctx.findings.filter((f) => !f.supersededBy && f.severity !== 'info' && f.ruleId !== 'missing-week');
  const violations = open.filter((f) => f.severity === 'violation');
  const warnings = open.filter((f) => f.severity === 'warning');
  if (open.length === 0) {
    body.p('There are no open exceptions.');
  } else {
    body.p(`Open exceptions: ${plural(violations.length, 'violation')} and ${plural(warnings.length, 'warning')}.`);
    const sorted = [...violations, ...warnings].sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === 'violation' ? -1 : 1) ||
        env.nameOf(a.contractorId).localeCompare(env.nameOf(b.contractorId)) ||
        (a.weekEnding ?? '').localeCompare(b.weekEnding ?? ''),
    );
    body.t({
      title: 'Open exceptions',
      columns: ['Contractor', 'Week ending', 'Finding', 'Type', 'Amount owed'],
      rows: sorted.map((f) => [
        env.nameOf(f.contractorId),
        formatDate(f.weekEnding),
        f.title,
        f.severity === 'violation' ? 'Violation' : 'Warning',
        f.amountOwed > 0 ? formatMoney(f.amountOwed) : '-',
      ]),
      numericColumns: [4],
    });
  }

  const ledger = env.ledgerRows;
  if (ledger.length === 0) {
    body.p('No underpayments have been identified.');
  } else {
    const owed = cents(sum(ledger.map((r) => r.amountOwed)));
    const paid = cents(sum(ledger.map((r) => r.amountPaid)));
    const verified = cents(sum(ledger.filter((r) => r.status === 'verified').map((r) => r.amountOwed)));
    const waived = cents(sum(ledger.filter((r) => r.status === 'waived').map((r) => r.amountOwed)));
    const outstanding = cents(sum(ledger.map((r) => r.balance)));
    body.p(
      `Restitution: underpayments identified to date total ${formatMoney(owed)}. Contractors report paying ${formatMoney(paid)}; ${formatMoney(verified)} has been verified with proof of payment${waived > 0 ? `, ${formatMoney(waived)} was waived or found not owed` : ''}, and ${formatMoney(outstanding)} remains outstanding.`,
    );
    const byContractor = new Map<string, LedgerRow[]>();
    for (const r of ledger) byContractor.set(r.finding.contractorId, [...(byContractor.get(r.finding.contractorId) ?? []), r]);
    const rows = [...byContractor.entries()]
      .map(([id, list]) => {
        const statuses = new Map<string, number>();
        for (const r of list) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
        return [
          env.nameOf(id),
          formatMoney(cents(sum(list.map((r) => r.amountOwed)))),
          formatMoney(cents(sum(list.map((r) => r.amountPaid)))),
          formatMoney(cents(sum(list.filter((r) => r.status === 'verified').map((r) => r.amountOwed)))),
          formatMoney(cents(sum(list.map((r) => r.balance)))),
          [...statuses.entries()].map(([s, n]) => `${n} ${RESTITUTION_WORDS[s] ?? s}`).join(', '),
        ];
      })
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
    body.t({
      title: 'Restitution status',
      columns: ['Contractor', 'Owed', 'Reported paid', 'Verified', 'Outstanding', 'Items'],
      rows,
      footer: ['Total', formatMoney(owed), formatMoney(paid), formatMoney(verified), formatMoney(outstanding), ''],
      numericColumns: [1, 2, 3, 4],
    });
  }

  if (env.missing.length > 0) {
    body.p(`Payrolls have not been received for ${plural(env.missing.length, 'contractor-week')}:`);
    body.t(missingTable(env, env.missing));
  } else {
    body.p('No payrolls are outstanding.');
  }

  body.p(
    "This memo is the reviewer's working document, prepared with Wagebench, a review aid. The findings reflect the reviewer's comparison of the payrolls as submitted with the wage determination; they are not a legal determination of compliance.",
  );

  return {
    kind: 'review-memo',
    date: env.date,
    to: ['Project file', project.owner].filter(nonEmpty),
    from: [[reviewer.name, reviewer.title].filter(nonEmpty).join(', '), reviewer.organization].filter(nonEmpty),
    subject: `Certified payroll review summary - ${projectLabel(project)}`,
    paragraphs: body.paragraphs,
    tables: body.tables,
    closing: [[reviewer.name, reviewer.title].filter(nonEmpty).join(', '), reviewer.organization].filter(nonEmpty),
  };
}

const RESTITUTION_WORDS: Record<string, string> = {
  owed: 'owed',
  requested: 'requested',
  paid: 'paid (unverified)',
  verified: 'verified',
  waived: 'waived',
};

// ---------------------------------------------------------------------------
// Rendering helpers shared by the three formats

export type LetterBlock = { type: 'paragraph'; text: string } | { type: 'table'; table: LetterTable };

/** Paragraphs and tables in reading order. */
export function letterBlocks(letter: Letter): LetterBlock[] {
  const blocks: LetterBlock[] = [];
  const pending = letter.tables.map((table, index) => ({ table, index }));
  const place = (after: number) => {
    for (const { table } of pending.filter((p) => p.table.afterParagraph === after)) blocks.push({ type: 'table', table });
  };
  place(-1);
  letter.paragraphs.forEach((text, i) => {
    blocks.push({ type: 'paragraph', text });
    place(i);
  });
  const last = letter.paragraphs.length - 1;
  for (const { table } of pending) {
    const a = table.afterParagraph;
    if (a === undefined || !Number.isInteger(a) || a < -1 || a > last) blocks.push({ type: 'table', table });
  }
  return blocks;
}

const NUMERIC_CELL = /^\(?-?\$?[\d,]+(\.\d+)?\)?%?$/;

function numericColumns(table: LetterTable): Set<number> {
  if (table.numericColumns) return new Set(table.numericColumns);
  const set = new Set<number>();
  table.columns.forEach((_, col) => {
    const values = table.rows.map((r) => (r[col] ?? '').trim()).filter((v) => v !== '' && v !== '-');
    if (values.length > 0 && values.every((v) => NUMERIC_CELL.test(v))) set.add(col);
  });
  return set;
}

/**
 * Column widths in twips for Word, estimated from character counts (Word's fixed table
 * layout needs explicit widths, and fonts are not available here to measure).
 */
function docxColumnWidths(table: LetterTable, available: number): number[] {
  const TWIPS_PER_CHAR = 100;
  const CELL_MARGINS = 160;
  const natural: number[] = [];
  const minimum: number[] = [];
  table.columns.forEach((header, col) => {
    const cells = [header, ...table.rows.map((r) => r[col] ?? ''), table.footer?.[col] ?? ''];
    const lines = cells.flatMap((c) => c.split('\n'));
    natural.push(Math.max(...lines.map((l) => l.length)) * TWIPS_PER_CHAR + CELL_MARGINS);
    minimum.push(Math.max(...lines.flatMap((l) => l.split(/\s+/).map((w) => w.length))) * TWIPS_PER_CHAR + CELL_MARGINS);
  });
  const widths = fitColumnWidths(natural, minimum, available).map((w) => Math.floor(w));
  const slack = available - widths.reduce((a, b) => a + b, 0);
  if (widths.length > 0) widths[widths.length - 1]! += slack;
  return widths;
}

function rowCells(row: readonly string[] | undefined, width: number): string[] {
  return Array.from({ length: width }, (_, i) => row?.[i] ?? '');
}

/** Numbered or dashed list items, rendered with a hanging indent. */
const LIST_MARKER = /^(\d{1,2}\.|-)\s+/;

// ---------------------------------------------------------------------------
// Plain text

/** Plain text for an email body or a clipboard paste; tables are drawn with fixed-width columns. */
export function letterToText(letter: Letter): string {
  const out: string[] = [];
  if (letter.kind === 'review-memo') {
    out.push('MEMORANDUM', '');
    const field = (label: string, lines: string[]) => {
      const pad = ' '.repeat(9);
      (lines.length ? lines : ['']).forEach((line, i) => out.push(`${i === 0 ? `${label}:`.padEnd(9) : pad}${line}`.trimEnd()));
    };
    field('TO', letter.to);
    field('FROM', letter.from);
    field('DATE', [longDate(letter.date)]);
    field('SUBJECT', [letter.subject]);
    out.push('-'.repeat(72), '');
  } else {
    out.push(...letter.from, '', longDate(letter.date), '', ...letter.to, '', `Re: ${letter.subject}`, '');
  }
  for (const block of letterBlocks(letter)) {
    if (block.type === 'paragraph') out.push(block.text, '');
    else out.push(block.table.title.toUpperCase(), ...textTable(block.table), '');
  }
  out.push(...letter.closing);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > width) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!w) continue;
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else {
        lines.push(line);
        line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}

function textTable(table: LetterTable, maxWidth = 100): string[] {
  const n = table.columns.length;
  if (n === 0) return [];
  const numeric = numericColumns(table);
  const all = [table.columns, ...table.rows, ...(table.footer ? [table.footer] : [])].map((r) => rowCells(r, n));
  const widths = table.columns.map((_, col) => Math.max(3, ...all.map((r) => Math.max(...r[col]!.split('\n').map((l) => l.length)))));
  const budget = maxWidth - 3 * (n - 1);
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 8) break;
    widths[widest]! -= 1;
  }
  const render = (cells: string[]) => {
    const wrapped = cells.map((c, col) => wrapPlain(c, widths[col]!));
    const height = Math.max(...wrapped.map((w) => w.length));
    const lines: string[] = [];
    for (let i = 0; i < height; i++) {
      lines.push(
        wrapped
          .map((w, col) => {
            const text = w[i] ?? '';
            return numeric.has(col) ? text.padStart(widths[col]!) : text.padEnd(widths[col]!);
          })
          .join(' | ')
          .trimEnd(),
      );
    }
    return lines;
  };
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');
  const lines = [...render(all[0]!), separator];
  for (const row of all.slice(1, 1 + table.rows.length)) lines.push(...render(row));
  if (table.footer) lines.push(separator, ...render(all[all.length - 1]!));
  return lines;
}

// ---------------------------------------------------------------------------
// Word

/** Remove characters XML 1.0 cannot carry; third-party text occasionally contains them. */
function xmlSafe(text: string): string {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/**
 * A .docx the reviewer can open in Word and put on letterhead. The docx package is
 * loaded on demand so pages that never export Word do not pay for it.
 */
export async function letterToDocx(letter: Letter): Promise<Uint8Array> {
  const d = await import('docx');
  const TEXT_WIDTH = 9360; // 6.5 inches in twips (Letter with 1-inch margins)
  const runs = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
    xmlSafe(text)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line, i) => new d.TextRun({ text: line, bold: opts.bold, size: opts.size, color: opts.color, break: i > 0 ? 1 : undefined }));
  const para = (text: string, opts: { bold?: boolean; size?: number; after?: number; color?: string } = {}) =>
    new d.Paragraph({ spacing: { after: opts.after ?? 0 }, children: runs(text, opts) });

  const children: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [];
  if (letter.kind === 'review-memo') {
    children.push(para('MEMORANDUM', { bold: true, size: 32, after: 240 }));
    const field = (label: string, lines: string[]) =>
      new d.Paragraph({
        tabStops: [{ type: d.TabStopType.LEFT, position: 1260 }],
        indent: { left: 1260, hanging: 1260 },
        spacing: { after: 80 },
        children: [
          new d.TextRun({ text: `${label}:`, bold: true }),
          new d.TextRun({ children: [new d.Tab(), xmlSafe(lines[0] ?? '')] }),
          ...lines.slice(1).map((line) => new d.TextRun({ text: xmlSafe(line), break: 1 })),
        ],
      });
    children.push(field('TO', letter.to), field('FROM', letter.from), field('DATE', [longDate(letter.date)]), field('SUBJECT', [letter.subject]));
    children.push(
      new d.Paragraph({
        spacing: { after: 240 },
        border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: '808080', space: 1 } },
        children: [],
      }),
    );
  } else {
    letter.from.forEach((line, i) => children.push(para(line, { bold: i === 0, size: i === 0 ? 24 : 18, color: i === 0 ? undefined : '555555' })));
    children.push(para('', { after: 240 }), para(longDate(letter.date), { after: 240 }));
    letter.to.forEach((line) => children.push(para(line)));
    children.push(para('', { after: 120 }), para(`Re: ${letter.subject}`, { bold: true, after: 240 }));
  }

  for (const block of letterBlocks(letter)) {
    if (block.type === 'paragraph') {
      const marker = LIST_MARKER.exec(block.text);
      children.push(
        new d.Paragraph({
          spacing: { after: 160 },
          indent: marker ? { left: 360, hanging: 360 } : undefined,
          children: runs(block.text),
        }),
      );
      continue;
    }
    const t = block.table;
    const n = t.columns.length;
    if (n === 0) continue;
    const numeric = numericColumns(t);
    const widths = docxColumnWidths(t, TEXT_WIDTH);
    const cell = (text: string, col: number, kind: 'header' | 'body' | 'footer') =>
      new d.TableCell({
        width: { size: widths[col]!, type: d.WidthType.DXA },
        shading: kind === 'header' ? { type: d.ShadingType.CLEAR, color: 'auto', fill: 'E8EAEE' } : undefined,
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: [
          new d.Paragraph({
            alignment: numeric.has(col) && kind !== 'header' ? d.AlignmentType.RIGHT : d.AlignmentType.LEFT,
            children: runs(text, { bold: kind !== 'body', size: 18 }),
          }),
        ],
      });
    children.push(
      new d.Paragraph({ keepNext: true, spacing: { before: 120, after: 80 }, children: runs(t.title, { bold: true }) }),
    );
    children.push(
      new d.Table({
        width: { size: TEXT_WIDTH, type: d.WidthType.DXA },
        columnWidths: widths,
        layout: d.TableLayoutType.FIXED,
        rows: [
          new d.TableRow({ tableHeader: true, children: rowCells(t.columns, n).map((c, i) => cell(c, i, 'header')) }),
          ...t.rows.map((r) => new d.TableRow({ children: rowCells(r, n).map((c, i) => cell(c, i, 'body')) })),
          ...(t.footer ? [new d.TableRow({ children: rowCells(t.footer, n).map((c, i) => cell(c, i, 'footer')) })] : []),
        ],
      }),
    );
    children.push(para('', { after: 160 }));
  }

  children.push(para('', { after: 120 }));
  letter.closing.forEach((line) => children.push(para(line)));

  const doc = new d.Document({
    creator: 'Wagebench',
    title: xmlSafe(letter.subject),
    description: LETTER_KIND_LABELS[letter.kind],
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        footers: {
          default: new d.Footer({
            children: [
              new d.Paragraph({
                alignment: d.AlignmentType.RIGHT,
                children: [
                  new d.TextRun({
                    size: 16,
                    color: '666666',
                    children: [
                      letter.kind === 'review-memo' ? "Reviewer's working document - Page " : 'Page ',
                      d.PageNumber.CURRENT,
                      ' of ',
                      d.PageNumber.TOTAL_PAGES,
                    ],
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return new Uint8Array(await d.Packer.toArrayBuffer(doc));
}

// ---------------------------------------------------------------------------
// PDF

/** A Letter-size PDF ready to send, with wrapped text and tables that continue across pages. */
export async function letterToPdf(letter: Letter): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(letter.subject);
  doc.setSubject(LETTER_KIND_LABELS[letter.kind]);
  doc.setCreator('Wagebench');
  doc.setProducer('Wagebench');
  const fonts = await embedStandardFonts(doc);
  const flow = new PdfFlow(doc, fonts, {
    pageSize: [612, 792],
    margins: { top: 72, right: 72, bottom: 72, left: 72 },
  });
  flow.addPage();
  const size = 10.5;

  if (letter.kind === 'review-memo') {
    flow.text('MEMORANDUM', { size: 16, style: 'bold', after: 12 });
    flow.keyValues(
      [
        ['TO:', letter.to.join('\n')],
        ['FROM:', letter.from.join('\n')],
        ['DATE:', longDate(letter.date)],
        ['SUBJECT:', letter.subject],
      ],
      { labelWidth: 72, size },
    );
    flow.rule();
    flow.gap(8);
  } else {
    letter.from.forEach((line, i) =>
      flow.text(line, i === 0 ? { size: 12, style: 'bold', after: 2 } : { size: 9, color: MUTED, after: 1 }),
    );
    flow.rule();
    flow.gap(10);
    flow.text(longDate(letter.date), { size, after: 14 });
    letter.to.forEach((line) => flow.text(line, { size, after: 0 }));
    flow.gap(14);
    flow.text(`Re: ${letter.subject}`, { size, style: 'bold', after: 12 });
  }

  for (const block of letterBlocks(letter)) {
    if (block.type === 'paragraph') {
      const marker = LIST_MARKER.exec(block.text);
      const hanging = marker ? fonts.regular.widthOfTextAtSize(`${marker[1]} `, size) : 0;
      flow.text(block.text, { size, hanging, indent: 0, after: 8 });
      continue;
    }
    const t = block.table;
    if (t.columns.length === 0) continue;
    const numeric = numericColumns(t);
    flow.gap(2);
    flow.table({
      title: t.title,
      layout: 'auto',
      fontSize: 8.5,
      columns: t.columns.map((header, i) => ({ header, weight: 1, align: numeric.has(i) ? 'right' : 'left' })),
      rows: t.rows.map((r) => rowCells(r, t.columns.length)),
      footer: t.footer ? rowCells(t.footer, t.columns.length) : undefined,
    });
  }

  flow.gap(6);
  flow.ensure(Math.min(letter.closing.length * size * 1.3, 200));
  for (const line of letter.closing) {
    if (line.trim() === '') flow.gap(size * 1.1);
    else flow.text(line, { size, after: 1 });
  }
  flow.finish(letter.kind === 'review-memo' ? `Reviewer's working document - ${letter.subject}` : letter.subject);
  return doc.save();
}
