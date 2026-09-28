import { addDays, daysBetween, formatDate, isIsoDate, nextWeekday, weekday } from '../dates';
import { resolveClassification } from '../mapping';
import { cents, extend, formatHours, formatMoney, formatRate, rate, sum } from '../money';
import type {
  ApprenticeProgram,
  ClassificationMapping,
  Contractor,
  Finding,
  ISODate,
  ParsedWageDetermination,
  Payroll,
  PayrollLine,
  Project,
  RuleId,
  Severity,
  WDClassification,
} from '../types';
import { NOT_ON_WD } from '../types';
import { requiredFringe } from '../wd/fringe';
import { normalizeLabel } from '../mapping';

export interface EvaluationInput {
  project: Project;
  wd: ParsedWageDetermination | null;
  contractors: readonly Contractor[];
  payrolls: readonly Payroll[];
  mappings: readonly ClassificationMapping[];
  /** "Today" for deciding which weeks are overdue. Injected for deterministic tests. */
  asOf: ISODate;
}

/** Per-line computation, shown in the review screen so the reviewer can see the math. */
export interface LineAnalysis {
  lineId: string;
  classification: WDClassification | null;
  mappingSource: 'mapping' | 'exact' | 'none' | 'not-on-wd';
  /** Required basic hourly rate after apprentice / Executive Order adjustments. */
  requiredBase: number | null;
  requiredFringe: number | null;
  paidBase: number;
  paidFringe: number;
  /** Overtime rate used for checks (reported, or derived from gross). */
  paidOT: number | null;
  owed: number;
  apprenticeProgram: ApprenticeProgram | null;
}

export type PayrollState = 'clean' | 'warnings' | 'violations' | 'superseded';

export interface PayrollSummary {
  payrollId: string;
  state: PayrollState;
  violations: number;
  warnings: number;
  owed: number;
}

export type WeekCellState = 'received' | 'no-work' | 'missing' | 'not-due' | 'violations' | 'warnings';

export interface WeekCell {
  weekEnding: ISODate;
  state: WeekCellState;
  payrollIds: string[];
}

export interface ContractorWeeks {
  contractorId: string;
  weekEndingDay: number;
  cells: WeekCell[];
}

export interface Evaluation {
  /** Findings on current payrolls and contractor-level checks. */
  findings: Finding[];
  /** Findings on payrolls that were replaced by a correction (see Finding.supersededBy). */
  historicalFindings: Finding[];
  lines: Map<string, LineAnalysis>;
  payrolls: Map<string, PayrollSummary>;
  weeks: ContractorWeeks[];
  totalOwed: number;
}

/** A twentieth of a cent per hour: WD rates carry up to three decimals, so $26.85 against $26.855 is short. */
const TOL_RATE = 0.0005;

/**
 * How one line's hours fall for the overtime rules. The 40-hour threshold applies to the
 * worker's week, so a worker on two lines (two classifications) is counted once.
 */
interface HourSplit {
  st: number;
  /** Overtime-column hours that are over 40 for the week: owed at 1.5 × the basic rate. */
  premiumOT: number;
  /** Overtime-column hours that are not over 40 (e.g. daily overtime): owed at least the WD rate. */
  plainOT: number;
  /** Hours over 40 for the week that were reported as straight time. */
  unreported: number;
  workerLines: number;
  workerHours: number;
  workerOT: number;
}

interface LineInfo {
  line: PayrollLine;
  analysis: LineAnalysis;
  split: HourSplit;
  worker: string;
}

export function evaluateProject(input: EvaluationInput): Evaluation {
  const { project, wd, contractors, payrolls, mappings, asOf } = input;
  const findings: Finding[] = [];
  const lines = new Map<string, LineAnalysis>();
  const summaries = new Map<string, PayrollSummary>();
  const classifications = wd?.classifications ?? [];
  const byKey = new Map(classifications.map((c) => [c.key, c]));
  const contractorById = new Map(contractors.map((c) => [c.id, c]));

  const historicalFindings: Finding[] = [];
  const supersededBy = new Map<string, string>();
  for (const p of payrolls) if (p.supersedesPayrollId) supersededBy.set(p.supersedesPayrollId, p.id);
  const superseded = new Set(supersededBy.keys());

  for (const payroll of payrolls) {
    const replacedBy = supersededBy.get(payroll.id);
    const contractor = contractorById.get(payroll.contractorId);
    const pf: Finding[] = [];
    const add: AddFn = (f) => {
      const { keySuffix, keyRule, ...rest } = f;
      pf.push({
        ...rest,
        key: [keyRule ?? rest.ruleId, payroll.id, rest.lineId ?? '-', keySuffix ?? ''].join(':'),
        contractorId: payroll.contractorId,
        payrollId: payroll.id,
        weekEnding: isIsoDate(payroll.weekEnding) ? payroll.weekEnding : null,
      });
    };

    if (!payroll.noWork && !payroll.statementOfComplianceSigned) {
      add({
        ruleId: 'soc-missing',
        severity: 'violation',
        lineId: null,
        workerName: null,
        title: 'Statement of Compliance missing or unsigned',
        detail:
          'Each weekly payroll must be accompanied by a signed Statement of Compliance (page 2 of the WH-347 or a document with identical wording). Request a signed statement before accepting this payroll.',
        amountOwed: 0,
      });
    }
    if (payroll.noWork && !payroll.statementOfComplianceSigned) {
      add({
        ruleId: 'soc-missing',
        severity: 'warning',
        lineId: null,
        workerName: null,
        title: 'No-work payroll is not signed',
        detail: 'A "no work performed" payroll should still be signed by the contractor.',
        amountOwed: 0,
      });
    }

    if (!isIsoDate(payroll.weekEnding)) {
      add({
        ruleId: 'invalid-date',
        severity: 'warning',
        lineId: null,
        workerName: null,
        keySuffix: 'week-ending',
        title: 'Week ending date is missing or invalid',
        detail: 'Enter the week ending date so this payroll is placed in the right week. Late-submission and missing-week checks skip it until then.',
        amountOwed: 0,
      });
    } else if (payroll.receivedDate && !isIsoDate(payroll.receivedDate)) {
      add({
        ruleId: 'invalid-date',
        severity: 'warning',
        lineId: null,
        workerName: null,
        keySuffix: 'received',
        title: 'Date received is invalid',
        detail: 'Correct the date received so late submission can be checked.',
        amountOwed: 0,
      });
    } else if (payroll.receivedDate) {
      const days = daysBetween(payroll.weekEnding, payroll.receivedDate);
      if (days > project.settings.lateAfterDays) {
        add({
          ruleId: 'late-submission',
          severity: 'warning',
          lineId: null,
          workerName: null,
          title: `Received ${days} days after week ending`,
          detail: `Certified payrolls are due weekly, within seven days after the regular pay date. This project flags payrolls received more than ${project.settings.lateAfterDays} days after the week ending date.`,
          amountOwed: 0,
        });
      }
    }

    // Line-level checks.
    const splits = splitHours(payroll.lines, project.settings.overtimeRuleApplies);
    const lineInfos: LineInfo[] = [];
    for (const line of payroll.lines) {
      const split = splits.get(line.id)!;
      const analysis = analyzeLine(line, split, payroll, contractor, project, classifications, byKey, mappings, add);
      lines.set(line.id, analysis);
      lineInfos.push({ line, analysis, split, worker: workerKey(line) });
    }

    // Apprentice ratio per classification.
    checkApprenticeRatios(lineInfos, project, add);

    // Findings that repeat for every line of the same classification collapse to one per payroll.
    const footnoteSeen = new Set<string>();
    for (const { analysis } of lineInfos) {
      const c = analysis.classification;
      if (c && c.fringe.footnotes.length > 0 && !footnoteSeen.has(c.key)) {
        footnoteSeen.add(c.key);
        add({
          ruleId: 'fringe-footnote',
          severity: 'info',
          lineId: null,
          workerName: null,
          keySuffix: c.key,
          title: `Fringe for ${c.label} carries footnote ${c.fringe.footnotes.map((f) => `(${f})`).join(', ')}`,
          detail: `The WD fringe "${c.fringe.raw}" references footnotes (usually paid holidays or vacation). Confirm the contractor provides them; see the footnotes in the wage determination notes.`,
          amountOwed: 0,
        });
      }
    }

    const violations = pf.filter((f) => f.severity === 'violation').length;
    const warnings = pf.filter((f) => f.severity === 'warning').length;
    const owed = cents(sum(pf.map((f) => f.amountOwed)));
    summaries.set(payroll.id, {
      payrollId: payroll.id,
      state: replacedBy ? 'superseded' : violations > 0 ? 'violations' : warnings > 0 ? 'warnings' : 'clean',
      violations,
      warnings,
      owed,
    });
    if (replacedBy) historicalFindings.push(...pf.map((f) => ({ ...f, supersededBy: replacedBy })));
    else findings.push(...pf);
  }

  // Contractor-level: duplicates, numbering gaps, missing weeks. Payrolls without a usable
  // week ending cannot be placed in a week; they carry their own finding above.
  const weeks: ContractorWeeks[] = [];
  for (const contractor of contractors) {
    const own = payrolls
      .filter((p) => p.contractorId === contractor.id && !superseded.has(p.id) && isIsoDate(p.weekEnding))
      .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
    findings.push(...contractorFindings(contractor, own));
    const w = contractorWeeks(contractor, own, summaries, project, asOf);
    weeks.push(w);
    for (const cell of w.cells) {
      if (cell.state !== 'missing') continue;
      findings.push({
        key: ['missing-week', contractor.id, cell.weekEnding].join(':'),
        ruleId: 'missing-week',
        severity: 'violation',
        payrollId: null,
        contractorId: contractor.id,
        lineId: null,
        workerName: null,
        weekEnding: cell.weekEnding,
        title: `No payroll for week ending ${formatDate(cell.weekEnding)}`,
        detail: `${contractor.name} has not submitted a certified payroll (or a "no work" payroll) for the week ending ${formatDate(cell.weekEnding)}. Payrolls are required every week from the start of work until completion.`,
        amountOwed: 0,
      });
    }
  }

  const totalOwed = cents(sum(findings.map((f) => f.amountOwed)));
  return { findings, historicalFindings, lines, payrolls: summaries, weeks, totalOwed };
}

// ---------------------------------------------------------------------------

type AddFn = (
  f: Omit<Finding, 'key' | 'contractorId' | 'payrollId' | 'weekEnding'> & {
    keySuffix?: string;
    /** Key segment used instead of the rule id, so a key survives a change of rule variant. */
    keyRule?: string;
  },
) => void;

/**
 * Base-rate findings use one key whichever variant applies (WD rate, apprentice rate, Executive
 * Order minimum), so recorded restitution is not orphaned when a setting or the apprentice flag changes.
 */
const BASE_KEY = 'base-rate';

/** Identifies a worker within one payroll: name and identifying number. */
function workerKey(line: PayrollLine): string {
  const name = normalizeLabel(line.workerName);
  const id = line.workerId.replace(/\s+/g, '').toLowerCase();
  return name || id ? `${name}|${id}` : `line:${line.id}`;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const finite = (x: number) => (Number.isFinite(x) ? x : 0);

/** Split `total` over `weights` in proportion, in hundredths; the rounding remainder goes to the last weighted item. */
function allocate(weights: readonly number[], total: number): number[] {
  const w = sum(weights);
  if (!(total > 0) || !(w > 0)) return weights.map(() => 0);
  const out = weights.map((x) => (x > 0 ? Math.floor((x / w) * total * 100 + 1e-6) / 100 : 0));
  let last = -1;
  weights.forEach((x, i) => {
    if (x > 0) last = i;
  });
  out[last] = round2(out[last]! + total - sum(out));
  return out;
}

function splitHours(lines: readonly PayrollLine[], overtimeApplies: boolean): Map<string, HourSplit> {
  const groups = new Map<string, PayrollLine[]>();
  for (const line of lines) {
    const k = workerKey(line);
    const list = groups.get(k) ?? [];
    list.push(line);
    groups.set(k, list);
  }
  const out = new Map<string, HourSplit>();
  for (const group of groups.values()) {
    const st = group.map((l) => Math.max(0, finite(l.totalST)));
    const ot = group.map((l) => Math.max(0, finite(l.totalOT)));
    const totalST = sum(st);
    const totalOT = sum(ot);
    const workerHours = round2(totalST + totalOT);
    const over40 = overtimeApplies ? Math.max(0, round2(workerHours - 40)) : 0;
    const premium = allocate(ot, Math.min(totalOT, over40));
    const unreported = allocate(st, round2(Math.max(0, over40 - totalOT)));
    group.forEach((l, i) =>
      out.set(l.id, {
        st: st[i]!,
        premiumOT: premium[i]!,
        plainOT: round2(ot[i]! - premium[i]!),
        unreported: unreported[i]!,
        workerLines: group.length,
        workerHours,
        workerOT: round2(totalOT),
      }),
    );
  }
  return out;
}

/** Amounts owed on one line against a required basic rate and fringe. */
interface Obligation {
  /** Basic rate for overtime: the rate paid, less any part of it that is cash in lieu of fringe, never below the WD rate. */
  regular: number;
  requiredOT: number;
  baseShortST: number;
  baseST: number;
  plainShort: number;
  basePlainOT: number;
  otShort: number;
  otPremium: number;
  unreportedPremium: number;
  fringe: number;
  fringeParts: { hours: number; perHour: number; kind: 'straight time' | 'overtime' | 'overtime (not over 40)' }[];
  total: number;
}

function obligations(requiredBase: number, requiredF: number, line: PayrollLine, paidOT: number | null, split: HourSplit): Obligation {
  const paidBase = rate(finite(line.rateST));
  const credit = rate(finite(line.fringePlanHourly) + finite(line.fringeCashHourly));
  const over = (short: number) => (short > TOL_RATE ? short : 0);

  const excessST = Math.max(0, rate(paidBase - requiredBase));
  const baseShortST = over(Math.max(0, rate(requiredBase - paidBase)));
  const fringeShortST = over(Math.max(0, rate(requiredF - credit - excessST)));
  const regular = Math.max(requiredBase, rate(paidBase - Math.max(0, requiredF - credit)));
  const requiredOT = rate(regular * 1.5);

  let otShort = 0;
  let plainShort = 0;
  let fringeShortOT = fringeShortST;
  let fringeShortPlain = fringeShortST;
  if (paidOT !== null) {
    otShort = over(Math.max(0, rate(requiredOT - paidOT)));
    fringeShortOT = over(Math.max(0, rate(requiredF - credit - Math.max(0, paidOT - requiredOT))));
    plainShort = over(Math.max(0, rate(requiredBase - paidOT)));
    fringeShortPlain = over(Math.max(0, rate(requiredF - credit - Math.max(0, paidOT - requiredBase))));
  }

  const parts: Obligation['fringeParts'] = [];
  const addPart = (hours: number, perHour: number, kind: Obligation['fringeParts'][number]['kind']) => {
    if (hours <= 0 || perHour <= 0) return;
    const same = parts.find((p) => p.perHour === perHour);
    if (same) same.hours = round2(same.hours + hours);
    else parts.push({ hours, perHour, kind });
  };
  addPart(split.st, fringeShortST, 'straight time');
  addPart(split.premiumOT, fringeShortOT, 'overtime');
  addPart(split.plainOT, fringeShortPlain, 'overtime (not over 40)');

  const baseST = extend(split.st, baseShortST);
  const basePlainOT = extend(split.plainOT, plainShort);
  const otPremium = extend(split.premiumOT, otShort);
  const unreportedPremium = extend(split.unreported, rate(regular * 0.5));
  const fringe = cents(sum(parts.map((p) => extend(p.hours, p.perHour))));
  return {
    regular,
    requiredOT,
    baseShortST,
    baseST,
    plainShort,
    basePlainOT,
    otShort,
    otPremium,
    unreportedPremium,
    fringe,
    fringeParts: parts,
    total: cents(baseST + basePlainOT + otPremium + unreportedPremium + fringe),
  };
}

/** Overtime rate reported on the line, or derived from gross pay when only the gross is given. */
function overtimeRate(line: PayrollLine, split: HourSplit): number | null {
  if (line.rateOT !== null && Number.isFinite(line.rateOT)) return line.rateOT;
  const hoursOT = finite(line.totalOT);
  if (hoursOT <= 0 || line.grossThisProject === null || !Number.isFinite(line.grossThisProject)) return null;
  const hours = split.st + hoursOT;
  const derived = (line.grossThisProject - extend(split.st, finite(line.rateST)) - extend(hours, finite(line.fringeCashHourly))) / hoursOT;
  return Number.isFinite(derived) ? rate(Math.max(0, derived)) : null;
}

function analyzeLine(
  line: PayrollLine,
  split: HourSplit,
  payroll: Payroll,
  contractor: Contractor | undefined,
  project: Project,
  classifications: readonly WDClassification[],
  byKey: Map<string, WDClassification>,
  mappings: readonly ClassificationMapping[],
  add: AddFn,
): LineAnalysis {
  const worker = line.workerName || '(unnamed worker)';
  const paidBase = rate(finite(line.rateST));
  const paidFringe = rate(finite(line.fringePlanHourly) + finite(line.fringeCashHourly));
  const tol = project.settings.arithmeticToleranceDollars;
  const paidOT = overtimeRate(line, split);

  const analysis: LineAnalysis = {
    lineId: line.id,
    classification: null,
    mappingSource: 'none',
    requiredBase: null,
    requiredFringe: null,
    paidBase,
    paidFringe,
    paidOT,
    owed: 0,
    apprenticeProgram: null,
  };

  // Identifying number: the Rev. 2025 WH-347 asks for an identifying number, not a full SSN.
  if (/^\d{3}[-\s.]?\d{2}[-\s.]?\d{4}$/.test(line.workerId.trim())) {
    add({
      ruleId: 'full-ssn',
      severity: 'warning',
      lineId: line.id,
      workerName: worker,
      title: 'Full Social Security number on payroll',
      detail:
        'The identifying number looks like a full SSN. Weekly certified payrolls should show only an individual identifying number (for example the last four digits). Ask the contractor to redact future payrolls, and restrict access to this file.',
      amountOwed: 0,
    });
  }

  // Arithmetic checks that do not depend on the wage determination.
  checkArithmetic(line, worker, tol, add);

  // Overtime still applies when the rates cannot be checked against the WD: measured against the rate paid.
  const overtimeOnly = () => {
    analysis.owed = reportOvertime(obligations(0, 0, line, paidOT, split), line, split, paidOT, worker, project, add);
    return analysis;
  };

  // Classification.
  const resolved = resolveClassification(line.classification, payroll.contractorId, mappings, classifications);
  if (resolved.key === NOT_ON_WD) {
    analysis.mappingSource = 'not-on-wd';
    add({
      ruleId: 'classification-not-on-wd',
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `"${line.classification}" is not a classification on the wage determination`,
      detail:
        'Work in a classification that is not listed on the wage determination requires an approved conformance (SF-1444 request through the contracting agency) before the rate can be accepted. Otherwise the worker may be misclassified and owed the rate for the listed classification that matches the work performed.',
      amountOwed: 0,
    });
    return overtimeOnly();
  }
  const c = resolved.key ? byKey.get(resolved.key) ?? null : null;
  if (!c) {
    add({
      ruleId: 'classification-unmapped',
      severity: 'warning',
      lineId: line.id,
      workerName: worker,
      keySuffix: normalizeLabel(line.classification),
      title: line.classification
        ? `Map "${line.classification}" to a wage determination classification`
        : 'Classification is blank',
      detail:
        'Rates cannot be checked until this job title is matched to a classification on the wage determination. The mapping is remembered for this contractor.',
      amountOwed: 0,
    });
    return overtimeOnly();
  }
  analysis.classification = c;
  analysis.mappingSource = resolved.source;

  if (c.unit === 'day') {
    add({
      ruleId: 'per-day-rate',
      severity: 'info',
      lineId: line.id,
      workerName: worker,
      title: `${c.label} is paid per day on the wage determination`,
      detail: `The wage determination lists ${formatRate(c.baseRate)} per day for this classification. Hourly rate checks are skipped; compare the daily amount manually. Overtime over 40 hours is still checked against the rate paid.`,
      amountOwed: 0,
    });
    return overtimeOnly();
  }

  // Required rates.
  let requiredBase = c.baseRate;
  let requiredF = requiredFringe(c.fringe, c.baseRate);
  let baseRule: RuleId = 'base-rate-below-wd';
  let program: ApprenticeProgram | null = null;
  let unregistered = false;
  if (line.apprentice) {
    program = findProgram(contractor, c, line.classification);
    analysis.apprenticeProgram = program;
    if (!program) {
      // 29 CFR 5.5(a)(4)(i): a worker paid as an apprentice who is not registered is owed the journeyworker rate.
      unregistered = true;
      add({
        ruleId: 'apprentice-unregistered',
        severity: 'violation',
        lineId: line.id,
        workerName: worker,
        title: `${worker}: apprentice registration not on file`,
        detail:
          'Apprentices may be paid less than the journeyworker rate only if they are individually registered in a program registered with the DOL Office of Apprenticeship or a recognized State Apprenticeship Agency. No program for this classification is recorded for the contractor, so the line is checked at the journeyworker rate. If the apprentice is registered, add the program under Contractors and the line is rechecked.',
        amountOwed: 0,
      });
    } else if (program.wagePercent === null) {
      add({
        ruleId: 'apprentice-unregistered',
        severity: 'warning',
        lineId: line.id,
        workerName: worker,
        title: 'Apprentice wage percentage not recorded',
        detail: `Enter the wage percentage for the "${program.name}" program so the apprentice rate can be checked.`,
        amountOwed: 0,
      });
      return overtimeOnly();
    } else {
      requiredBase = rate((c.baseRate * program.wagePercent) / 100);
      requiredF = program.fringePercent === null ? requiredF : rate((requiredF * program.fringePercent) / 100);
      baseRule = 'apprentice-rate';
    }
  }
  const eoMin = project.settings.executiveOrderMinimumWage;
  if (c.executiveOrderFlag && eoMin !== null && eoMin > requiredBase) {
    requiredBase = eoMin;
    baseRule = 'eo-minimum-wage';
  }
  analysis.requiredBase = requiredBase;
  analysis.requiredFringe = requiredF;

  const o = obligations(requiredBase, requiredF, line, paidOT, split);
  const required = `${describeRequired(c, program, baseRule)}${unregistered ? ' Apprentice not registered: the journeyworker rate applies.' : ''}`;

  if (o.baseST > 0) {
    add({
      ruleId: baseRule,
      keyRule: BASE_KEY,
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: basic rate ${formatRate(paidBase)} is below ${formatRate(requiredBase)}`,
      detail: `${required} Paid ${formatRate(paidBase)}/hr. Short ${formatRate(o.baseShortST)}/hr × ${formatHours(split.st)} straight-time hrs = ${formatMoney(o.baseST)}.`,
      amountOwed: o.baseST,
    });
  }
  if (o.basePlainOT > 0 && paidOT !== null) {
    add({
      ruleId: baseRule,
      keyRule: BASE_KEY,
      keySuffix: 'ot',
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: overtime-column hours paid ${formatRate(paidOT)}, below ${formatRate(requiredBase)}`,
      detail: `${required} ${formatHours(split.plainOT)} hrs reported as overtime (not over 40 for the week) were paid ${formatRate(paidOT)}/hr. Short ${formatRate(o.plainShort)}/hr × ${formatHours(split.plainOT)} hrs = ${formatMoney(o.basePlainOT)}.`,
      amountOwed: o.basePlainOT,
    });
  }
  if (o.fringe > 0) {
    const hours = round2(sum(o.fringeParts.map((p) => p.hours)));
    const math =
      o.fringeParts.length === 1
        ? `Fringe is owed on all hours worked: ${formatRate(o.fringeParts[0]!.perHour)} × ${formatHours(hours)} hrs = ${formatMoney(o.fringe)}.`
        : `Fringe is owed on all hours worked: ${o.fringeParts.map((p) => `${formatRate(p.perHour)} × ${formatHours(p.hours)} ${p.kind} hrs`).join(' + ')} = ${formatMoney(o.fringe)}.`;
    const excessST = Math.max(0, rate(paidBase - requiredBase));
    add({
      ruleId: 'fringe-shortfall',
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: fringe short ${formatRate(o.fringeParts[0]!.perHour)}/hr`,
      detail: `Required fringe ${formatRate(requiredF)}/hr (WD "${c.fringe.raw || '0'}"${program ? `, apprentice program ${program.fringePercent ?? 100}%` : ''}). Credited ${formatRate(line.fringePlanHourly)} plan + ${formatRate(line.fringeCashHourly)} cash${excessST > 0 ? ` + ${formatRate(excessST)} basic rate paid above the minimum` : ''}. ${math}`,
      amountOwed: o.fringe,
    });
  }
  const overtimeOwed = reportOvertime(o, line, split, paidOT, worker, project, add);
  analysis.owed = cents(o.baseST + o.basePlainOT + o.fringe + overtimeOwed);
  return analysis;
}

/** Overtime findings (CWHSSA: hours over 40 in the workweek at 1.5 × the basic rate). Returns the amount owed. */
function reportOvertime(o: Obligation, line: PayrollLine, split: HourSplit, paidOT: number | null, worker: string, project: Project, add: AddFn): number {
  if (!project.settings.overtimeRuleApplies) return 0;
  const lineOT = finite(line.totalOT);
  const acrossLines =
    split.workerLines > 1 ? ` ${worker} worked ${formatHours(split.workerHours)} hrs this week across ${split.workerLines} payroll lines.` : '';
  let owed = 0;
  if (split.premiumOT > 0 && paidOT === null) {
    add({
      ruleId: 'overtime-rate',
      keySuffix: 'unknown',
      severity: 'warning',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: overtime rate not shown`,
      detail: `The payroll shows ${formatHours(lineOT)} overtime hrs but no overtime rate, and no gross pay to work it out from. Ask for the rate; this overtime cannot be checked until then.`,
      amountOwed: 0,
    });
  }
  if (o.otPremium > 0 && paidOT !== null) {
    owed += o.otPremium;
    const partial = split.premiumOT < lineOT ? ` (${formatHours(split.premiumOT)} of the ${formatHours(lineOT)} overtime hrs on this line are over 40 for the week)` : '';
    add({
      ruleId: 'overtime-rate',
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: overtime paid at ${formatRate(paidOT)} instead of ${formatRate(o.requiredOT)}`,
      detail: `Hours over 40 in the workweek must be paid at least 1.5 × the basic rate (${formatRate(o.regular)} × 1.5 = ${formatRate(o.requiredOT)}).${acrossLines} Short ${formatRate(o.otShort)}/hr × ${formatHours(split.premiumOT)} OT hrs${partial} = ${formatMoney(o.otPremium)}.`,
      amountOwed: o.otPremium,
    });
  }
  if (o.unreportedPremium > 0) {
    owed += o.unreportedPremium;
    add({
      ruleId: 'overtime-unreported',
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: ${formatHours(split.workerHours)} hours with only ${formatHours(split.workerOT)} paid as overtime`,
      detail: `${formatHours(split.unreported)} hours over 40 were paid at straight time.${acrossLines} The overtime premium owed is 0.5 × ${formatRate(o.regular)} × ${formatHours(split.unreported)} hrs = ${formatMoney(o.unreportedPremium)}.`,
      amountOwed: o.unreportedPremium,
    });
  }
  return cents(owed);
}

function describeRequired(c: WDClassification, program: ApprenticeProgram | null, rule: RuleId): string {
  const scope = c.scope ? ` (${c.scope})` : '';
  const wd = `${c.label}${scope}: WD ${formatRate(c.baseRate)} + ${c.fringe.raw || '0'} fringe [${c.rateId}].`;
  if (rule === 'apprentice-rate' && program) {
    return `${wd} Apprentice in "${program.name}" at ${program.wagePercent}% of the journeyworker rate.`;
  }
  if (rule === 'eo-minimum-wage') {
    return `${wd} Classification is marked ** and the project applies the Executive Order minimum wage.`;
  }
  return wd;
}

/** The contractor's registered program for this classification; never another trade's program. */
function findProgram(
  contractor: Contractor | undefined,
  c: WDClassification,
  payrollLabel: string,
): ApprenticeProgram | null {
  const programs = contractor?.apprenticePrograms ?? [];
  if (programs.length === 0) return null;
  const targets = [c.label, c.name, c.parent ?? '', payrollLabel].map(normalizeLabel).filter(Boolean);
  const match = programs.find((p) => {
    const pc = normalizeLabel(p.classification);
    return pc !== '' && targets.some((t) => t.includes(pc) || pc.includes(t));
  });
  return match ?? null;
}

function checkArithmetic(line: PayrollLine, worker: string, tol: number, add: AddFn) {
  const dailyST = sum(line.dailyST);
  const dailyOT = sum(line.dailyOT);
  const hasDaily = line.dailyST.some((h) => h !== 0) || line.dailyOT.some((h) => h !== 0);
  if (hasDaily && (Math.abs(dailyST - line.totalST) > 0.01 || Math.abs(dailyOT - line.totalOT) > 0.01)) {
    add({
      ruleId: 'hours-arithmetic',
      severity: 'warning',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: daily hours do not add up to the total`,
      detail: `Daily hours sum to ${formatHours(dailyST)} ST / ${formatHours(dailyOT)} OT, but the totals show ${formatHours(line.totalST)} ST / ${formatHours(line.totalOT)} OT.`,
      amountOwed: 0,
    });
  }
  if (line.grossThisProject !== null && (line.rateOT !== null || line.totalOT === 0)) {
    const expected = cents(
      extend(line.totalST, line.rateST) +
        extend(line.totalOT, line.rateOT ?? 0) +
        extend(line.totalST + line.totalOT, line.fringeCashHourly),
    );
    const diff = cents(line.grossThisProject - expected);
    if (Math.abs(diff) > tol) {
      add({
        ruleId: 'gross-arithmetic',
        severity: 'warning',
        lineId: line.id,
        workerName: worker,
        title: `${worker}: gross for this project is ${diff > 0 ? 'more' : 'less'} than hours × rates`,
        detail: `Hours × rates${line.fringeCashHourly > 0 ? ' + cash fringe' : ''} = ${formatMoney(expected)}; the payroll reports ${formatMoney(line.grossThisProject)} (difference ${formatMoney(diff)}).`,
        amountOwed: 0,
      });
    }
  }
  if (line.grossAllWork !== null && line.deductions !== null && line.netPay !== null) {
    const expectedNet = cents(line.grossAllWork - line.deductions);
    const diff = cents(line.netPay - expectedNet);
    if (Math.abs(diff) > tol) {
      add({
        ruleId: 'net-arithmetic',
        severity: 'warning',
        lineId: line.id,
        workerName: worker,
        title: `${worker}: net pay does not equal gross minus deductions`,
        detail: `Gross (all work) ${formatMoney(line.grossAllWork)} − deductions ${formatMoney(line.deductions)} = ${formatMoney(expectedNet)}; the payroll shows net ${formatMoney(line.netPay)}.`,
        amountOwed: 0,
      });
    }
  }
  if (line.grossThisProject !== null && line.grossAllWork !== null && line.grossThisProject - line.grossAllWork > tol) {
    add({
      ruleId: 'gross-exceeds-all-work',
      severity: 'warning',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: gross for this project exceeds gross for all work`,
      detail: `This project ${formatMoney(line.grossThisProject)} > all work ${formatMoney(line.grossAllWork)}.`,
      amountOwed: 0,
    });
  }
}

/** How many apprentices a ratio allows. Below 1 it is read as "1 apprentice per N journeyworkers" (0.33 → 1 per 3). */
function allowedApprentices(journeyworkers: number, ratio: number): number {
  if (ratio >= 1) return Math.floor(journeyworkers * ratio + 1e-9);
  return Math.floor(journeyworkers / Math.round(1 / ratio));
}

function ratioLabel(ratio: number): string {
  if (ratio >= 1) return `${Math.round(ratio * 100) / 100} apprentice${ratio === 1 ? '' : 's'} per journeyworker`;
  return `1 apprentice per ${Math.round(1 / ratio)} journeyworkers`;
}

function checkApprenticeRatios(lineInfos: readonly LineInfo[], project: Project, add: AddFn) {
  const groups = new Map<string, LineInfo[]>();
  for (const li of lineInfos) {
    const c = li.analysis.classification;
    if (!c) continue;
    const list = groups.get(c.key) ?? [];
    list.push(li);
    groups.set(c.key, list);
  }
  for (const [, list] of groups) {
    // Registered apprentices at a program rate; unregistered ones are already checked at the journeyworker rate.
    const apprenticeLines = list.filter((li) => li.line.apprentice && li.analysis.apprenticeProgram?.wagePercent != null);
    if (apprenticeLines.length === 0) continue;
    const ratio = apprenticeLines[0]!.analysis.apprenticeProgram!.maxApprenticesPerJourneyworker;
    if (ratio === null || !(ratio > 0)) continue;
    // Count people, not lines: a worker split over two lines is one journeyworker or apprentice.
    const journeyworkers = new Set(list.filter((li) => !li.line.apprentice).map((li) => li.worker)).size;
    const apprentices = [...new Set(apprenticeLines.map((li) => li.worker))];
    const allowed = allowedApprentices(journeyworkers, ratio);
    const excess = new Set(apprentices.slice(allowed));
    for (const li of apprenticeLines) {
      if (!excess.has(li.worker)) continue;
      const c = li.analysis.classification!;
      const journeyBase = c.baseRate;
      const journeyFringe = requiredFringe(c.fringe, c.baseRate);
      const atJourneyRate = obligations(journeyBase, journeyFringe, li.line, li.analysis.paidOT, li.split);
      const overtime = project.settings.overtimeRuleApplies ? atJourneyRate.otPremium + atJourneyRate.unreportedPremium : 0;
      const full = cents(atJourneyRate.baseST + atJourneyRate.basePlainOT + atJourneyRate.fringe + overtime);
      // Subtract what the apprentice-rate checks already counted for this line.
      const amount = Math.max(0, cents(full - li.analysis.owed));
      li.analysis.owed = cents(li.analysis.owed + amount);
      add({
        ruleId: 'apprentice-ratio',
        severity: 'violation',
        lineId: li.line.id,
        workerName: li.line.workerName,
        title: `${li.line.workerName}: apprentice over the allowed ratio for ${c.label}`,
        detail: `${apprentices.length} apprentice(s) and ${journeyworkers} journeyworker(s) in ${c.label} this week; the program allows ${ratioLabel(ratio)}, so ${allowed}. Apprentices over the ratio must be paid the journeyworker rate (${formatRate(journeyBase)} + ${formatRate(journeyFringe)} fringe). Additional amount owed: ${formatMoney(amount)}.`,
        amountOwed: amount,
      });
    }
  }
}

function contractorFindings(contractor: Contractor, own: Payroll[]): Finding[] {
  const out: Finding[] = [];
  const byWeek = new Map<string, Payroll[]>();
  for (const p of own) {
    const list = byWeek.get(p.weekEnding) ?? [];
    list.push(p);
    byWeek.set(p.weekEnding, list);
  }
  for (const [week, list] of byWeek) {
    if (list.length < 2) continue;
    out.push({
      key: ['duplicate-week', contractor.id, week].join(':'),
      ruleId: 'duplicate-week',
      severity: 'warning',
      payrollId: list[list.length - 1]!.id,
      contractorId: contractor.id,
      lineId: null,
      workerName: null,
      weekEnding: week,
      title: `${list.length} payrolls for week ending ${formatDate(week)}`,
      detail:
        'More than one payroll covers the same week. If one corrects another, mark it as a correction ("supersedes") so only the latest version is reviewed.',
      amountOwed: 0,
    });
  }
  // Payroll numbering: numeric payroll numbers should step by one week to week.
  const numbered = own
    .filter((p) => /^\d+$/.test(p.payrollNumber.trim()))
    .map((p) => ({ p, n: Number(p.payrollNumber.trim()) }));
  for (let i = 1; i < numbered.length; i++) {
    const prev = numbered[i - 1]!;
    const cur = numbered[i]!;
    const weeksApart = Math.round(daysBetween(prev.p.weekEnding, cur.p.weekEnding) / 7);
    if (weeksApart >= 1 && cur.n - prev.n > weeksApart) {
      out.push({
        key: ['payroll-number-gap', contractor.id, cur.p.id].join(':'),
        ruleId: 'payroll-number-gap',
        severity: 'warning',
        payrollId: cur.p.id,
        contractorId: contractor.id,
        lineId: null,
        workerName: null,
        weekEnding: cur.p.weekEnding,
        title: `Payroll numbers jump from ${prev.n} to ${cur.n}`,
        detail: `Payroll no. ${prev.n} (week ending ${formatDate(prev.p.weekEnding)}) is followed by no. ${cur.n} (week ending ${formatDate(cur.p.weekEnding)}). A payroll may be missing from your file.`,
        amountOwed: 0,
      });
    }
  }
  return out;
}

function contractorWeeks(
  contractor: Contractor,
  own: Payroll[],
  summaries: Map<string, PayrollSummary>,
  project: Project,
  asOf: ISODate,
): ContractorWeeks {
  const first = own[0];
  const anchorDay = first
    ? weekday(first.weekEnding)
    : contractor.startDate
      ? weekday(addDays(contractor.startDate, 6))
      : 6;
  const startCandidates = [contractor.startDate, first?.weekEnding].filter((d): d is string => Boolean(d));
  if (startCandidates.length === 0) return { contractorId: contractor.id, weekEndingDay: anchorDay, cells: [] };
  const start = startCandidates.sort()[0]!;
  const firstWeek = nextWeekday(start, anchorDay);
  const finalPayroll = own.find((p) => p.isFinal);
  const lastWeekCandidates = [asOf];
  if (contractor.endDate) lastWeekCandidates.push(nextWeekday(contractor.endDate, anchorDay));
  if (finalPayroll) lastWeekCandidates.push(finalPayroll.weekEnding);
  const lastPayroll = own[own.length - 1];
  let last = lastWeekCandidates.sort()[0]!;
  if (lastPayroll && lastPayroll.weekEnding > last) last = lastPayroll.weekEnding;

  const byWeek = new Map<string, Payroll[]>();
  for (const p of own) {
    const list = byWeek.get(p.weekEnding) ?? [];
    list.push(p);
    byWeek.set(p.weekEnding, list);
  }

  const cells: WeekCell[] = [];
  // Off-cycle payrolls (week ending on a different weekday) still count for their week.
  const offCycle = own.filter((p) => weekday(p.weekEnding) !== anchorDay);
  for (let week = firstWeek, guard = 0; week <= last && guard < 520; week = addDays(week, 7), guard++) {
    const list = [...(byWeek.get(week) ?? [])];
    for (const p of offCycle) {
      const d = daysBetween(p.weekEnding, week);
      if (d >= 0 && d < 7) list.push(p);
    }
    let state: WeekCellState;
    if (list.length > 0) {
      const live = list.map((p) => summaries.get(p.id)).filter(Boolean) as PayrollSummary[];
      if (list.every((p) => p.noWork)) state = 'no-work';
      else if (live.some((s) => s.state === 'violations')) state = 'violations';
      else if (live.some((s) => s.state === 'warnings')) state = 'warnings';
      else state = 'received';
    } else {
      const due = addDays(week, project.settings.lateAfterDays);
      state = due < asOf ? 'missing' : 'not-due';
    }
    cells.push({ weekEnding: week, state, payrollIds: list.map((p) => p.id) });
  }
  return { contractorId: contractor.id, weekEndingDay: anchorDay, cells };
}
