import { addDays, daysBetween, formatDate, nextWeekday, weekday } from '../dates';
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

const TOL_RATE = 0.005; // half a cent per hour

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
    const add = (f: Omit<Finding, 'key' | 'contractorId' | 'payrollId' | 'weekEnding'> & { keySuffix?: string }) => {
      const { keySuffix, ...rest } = f;
      pf.push({
        ...rest,
        key: [rest.ruleId, payroll.id, rest.lineId ?? '-', keySuffix ?? ''].join(':'),
        contractorId: payroll.contractorId,
        payrollId: payroll.id,
        weekEnding: payroll.weekEnding,
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

    if (payroll.receivedDate) {
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
    const lineInfos: { line: PayrollLine; analysis: LineAnalysis }[] = [];
    for (const line of payroll.lines) {
      const analysis = analyzeLine(line, payroll, contractor, project, classifications, byKey, mappings, add);
      lines.set(line.id, analysis);
      lineInfos.push({ line, analysis });
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

  // Contractor-level: duplicates, numbering gaps, missing weeks.
  const weeks: ContractorWeeks[] = [];
  for (const contractor of contractors) {
    const own = payrolls
      .filter((p) => p.contractorId === contractor.id && !superseded.has(p.id))
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
  f: Omit<Finding, 'key' | 'contractorId' | 'payrollId' | 'weekEnding'> & { keySuffix?: string },
) => void;

function analyzeLine(
  line: PayrollLine,
  payroll: Payroll,
  contractor: Contractor | undefined,
  project: Project,
  classifications: readonly WDClassification[],
  byKey: Map<string, WDClassification>,
  mappings: readonly ClassificationMapping[],
  add: AddFn,
): LineAnalysis {
  const worker = line.workerName || '(unnamed worker)';
  const hoursST = line.totalST;
  const hoursOT = line.totalOT;
  const hours = hoursST + hoursOT;
  const paidBase = rate(line.rateST);
  const paidFringe = rate(line.fringePlanHourly + line.fringeCashHourly);
  const tol = project.settings.arithmeticToleranceDollars;

  const analysis: LineAnalysis = {
    lineId: line.id,
    classification: null,
    mappingSource: 'none',
    requiredBase: null,
    requiredFringe: null,
    paidBase,
    paidFringe,
    paidOT: line.rateOT,
    owed: 0,
    apprenticeProgram: null,
  };

  // Identifying number: the Rev. 2025 WH-347 asks for an identifying number, not a full SSN.
  const digits = line.workerId.replace(/\D/g, '');
  if (digits.length === 9 && /^\d{3}-?\d{2}-?\d{4}$/.test(line.workerId.trim())) {
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
  checkArithmetic(line, worker, tol, add, analysis);

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
    return analysis;
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
    return analysis;
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
      detail: `The wage determination lists ${formatRate(c.baseRate)} per day for this classification. Hourly checks are skipped; compare the daily amount manually.`,
      amountOwed: 0,
    });
    return analysis;
  }

  // Required rates.
  let requiredBase = c.baseRate;
  let requiredF = requiredFringe(c.fringe, c.baseRate);
  let baseRule: RuleId = 'base-rate-below-wd';
  let program: ApprenticeProgram | null = null;
  if (line.apprentice) {
    program = findProgram(contractor, c, line.classification);
    analysis.apprenticeProgram = program;
    if (!program || program.wagePercent === null) {
      add({
        ruleId: 'apprentice-unregistered',
        severity: 'warning',
        lineId: line.id,
        workerName: worker,
        title: program ? 'Apprentice wage percentage not recorded' : 'Apprentice registration not on file',
        detail: program
          ? `Enter the wage percentage for the "${program.name}" program so the apprentice rate can be checked.`
          : 'Apprentices may be paid less than the journeyworker rate only if they are individually registered in a program registered with the DOL Office of Apprenticeship or a recognized State Apprenticeship Agency. Record the program for this contractor, or treat the worker as a journeyworker. Until then the apprentice rate is not checked.',
        amountOwed: 0,
      });
      analysis.requiredBase = null;
      analysis.requiredFringe = null;
      return analysis;
    }
    requiredBase = rate((c.baseRate * program.wagePercent) / 100);
    requiredF = program.fringePercent === null ? requiredF : rate((requiredF * program.fringePercent) / 100);
    baseRule = 'apprentice-rate';
  }
  const eoMin = project.settings.executiveOrderMinimumWage;
  if (c.executiveOrderFlag && eoMin !== null && eoMin > requiredBase) {
    requiredBase = eoMin;
    baseRule = 'eo-minimum-wage';
  }
  analysis.requiredBase = requiredBase;
  analysis.requiredFringe = requiredF;

  // Straight-time base and fringe.
  const baseShort = Math.max(0, rate(requiredBase - paidBase));
  const excessBase = Math.max(0, rate(paidBase - requiredBase));
  const fringeShort = Math.max(0, rate(requiredF - paidFringe - excessBase));
  let owed = 0;

  if (baseShort > TOL_RATE && hoursST > 0) {
    const amount = extend(hoursST, baseShort);
    owed += amount;
    add({
      ruleId: baseRule,
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: basic rate ${formatRate(paidBase)} is below ${formatRate(requiredBase)}`,
      detail: `${describeRequired(c, program, baseRule)} Paid ${formatRate(paidBase)}/hr. Short ${formatRate(baseShort)}/hr × ${formatHours(hoursST)} straight-time hrs = ${formatMoney(amount)}.`,
      amountOwed: amount,
    });
  }

  if (fringeShort > TOL_RATE && hours > 0) {
    const amount = extend(hours, fringeShort);
    owed += amount;
    add({
      ruleId: 'fringe-shortfall',
      severity: 'violation',
      lineId: line.id,
      workerName: worker,
      title: `${worker}: fringe short ${formatRate(fringeShort)}/hr`,
      detail: `Required fringe ${formatRate(requiredF)}/hr (WD "${c.fringe.raw || '0'}"${program ? `, apprentice program ${program.fringePercent ?? 100}%` : ''}). Credited ${formatRate(line.fringePlanHourly)} plan + ${formatRate(line.fringeCashHourly)} cash${excessBase > 0 ? ` + ${formatRate(excessBase)} basic rate paid above the minimum` : ''}. Fringe is owed on all hours worked: ${formatRate(fringeShort)} × ${formatHours(hours)} hrs = ${formatMoney(amount)}.`,
      amountOwed: amount,
    });
  }

  // Overtime (Contract Work Hours and Safety Standards Act: over 40 hours in the workweek).
  if (project.settings.overtimeRuleApplies) {
    const regular = Math.max(paidBase, requiredBase);
    const requiredOT = rate(regular * 1.5);
    let paidOT = line.rateOT;
    if (paidOT === null && hoursOT > 0 && line.grossThisProject !== null) {
      const derived = (line.grossThisProject - extend(hoursST, paidBase) - extend(hours, line.fringeCashHourly)) / hoursOT;
      if (Number.isFinite(derived) && derived > 0) paidOT = rate(derived);
    }
    analysis.paidOT = paidOT;
    if (hoursOT > 0 && paidOT !== null && requiredOT - paidOT > TOL_RATE) {
      const short = rate(requiredOT - paidOT);
      const amount = extend(hoursOT, short);
      owed += amount;
      add({
        ruleId: 'overtime-rate',
        severity: 'violation',
        lineId: line.id,
        workerName: worker,
        title: `${worker}: overtime paid at ${formatRate(paidOT)} instead of ${formatRate(requiredOT)}`,
        detail: `Hours over 40 in the workweek must be paid at least 1.5 × the basic rate (${formatRate(regular)} × 1.5 = ${formatRate(requiredOT)}). Short ${formatRate(short)}/hr × ${formatHours(hoursOT)} OT hrs = ${formatMoney(amount)}.`,
        amountOwed: amount,
      });
    }
    const unreported = Math.round((hours - 40 - hoursOT) * 100) / 100;
    if (unreported > 0.001) {
      const amount = extend(unreported, rate(regular * 0.5));
      owed += amount;
      add({
        ruleId: 'overtime-unreported',
        severity: 'violation',
        lineId: line.id,
        workerName: worker,
        title: `${worker}: ${formatHours(hours)} hours with only ${formatHours(hoursOT)} paid as overtime`,
        detail: `${formatHours(unreported)} hours over 40 were paid at straight time. The overtime premium owed is 0.5 × ${formatRate(regular)} × ${formatHours(unreported)} hrs = ${formatMoney(amount)}.`,
        amountOwed: amount,
      });
    }
  }

  analysis.owed = cents(owed);
  return analysis;
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
  return match ?? (programs.length === 1 ? programs[0]! : null);
}

function checkArithmetic(line: PayrollLine, worker: string, tol: number, add: AddFn, analysis: LineAnalysis) {
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
  void analysis;
}

function checkApprenticeRatios(
  lineInfos: { line: PayrollLine; analysis: LineAnalysis }[],
  project: Project,
  add: AddFn,
) {
  const groups = new Map<string, { line: PayrollLine; analysis: LineAnalysis }[]>();
  for (const li of lineInfos) {
    const c = li.analysis.classification;
    if (!c) continue;
    const list = groups.get(c.key) ?? [];
    list.push(li);
    groups.set(c.key, list);
  }
  for (const [, list] of groups) {
    const apprentices = list.filter((li) => li.line.apprentice && li.analysis.apprenticeProgram);
    if (apprentices.length === 0) continue;
    const journey = list.filter((li) => !li.line.apprentice).length;
    const ratio = apprentices[0]!.analysis.apprenticeProgram!.maxApprenticesPerJourneyworker;
    if (ratio === null) continue;
    const allowed = Math.floor(journey * ratio + 1e-9);
    const excess = apprentices.slice(allowed);
    for (const li of excess) {
      const c = li.analysis.classification!;
      const hours = li.line.totalST + li.line.totalOT;
      const journeyBase = c.baseRate;
      const journeyFringe = requiredFringe(c.fringe, c.baseRate);
      const baseShort = Math.max(0, rate(journeyBase - li.line.rateST));
      const excessBase = Math.max(0, rate(li.line.rateST - journeyBase));
      const fringeShort = Math.max(
        0,
        rate(journeyFringe - li.line.fringePlanHourly - li.line.fringeCashHourly - excessBase),
      );
      // Subtract what the apprentice-rate checks already counted for this line.
      const already = li.analysis.owed;
      let amount = cents(extend(li.line.totalST, baseShort) + extend(hours, fringeShort));
      if (project.settings.overtimeRuleApplies && li.line.totalOT > 0) {
        const paidOT = li.analysis.paidOT ?? li.line.rateST * 1.5;
        amount = cents(amount + extend(li.line.totalOT, Math.max(0, rate(journeyBase * 1.5 - paidOT))));
      }
      amount = Math.max(0, cents(amount - already));
      li.analysis.owed = cents(li.analysis.owed + amount);
      add({
        ruleId: 'apprentice-ratio',
        severity: 'violation',
        lineId: li.line.id,
        workerName: li.line.workerName,
        title: `${li.line.workerName}: apprentice exceeds the ${ratio}:1 ratio for ${c.label}`,
        detail: `${apprentices.length} apprentice(s) and ${journey} journeyworker(s) in ${c.label} this week; the program allows ${allowed}. Apprentices over the ratio must be paid the journeyworker rate (${formatRate(journeyBase)} + ${formatRate(journeyFringe)} fringe). Additional amount owed: ${formatMoney(amount)}.`,
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
