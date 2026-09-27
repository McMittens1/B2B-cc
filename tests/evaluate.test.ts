import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { evaluateProject, type EvaluationInput } from '../src/engine/checks/evaluate';
import { buildLedger } from '../src/engine/restitution';
import { suggestClassifications, normalizeLabel } from '../src/engine/mapping';
import { parseWageDetermination } from '../src/engine/wd/parse';
import type {
  ApprenticeProgram,
  ClassificationMapping,
  Contractor,
  Payroll,
  PayrollLine,
  Project,
  RuleId,
} from '../src/engine/types';
import { NOT_ON_WD } from '../src/engine/types';

const wd = parseWageDetermination(fs.readFileSync('fixtures/wd/sample-modern.txt', 'utf8'));
const key = (label: string) => {
  const c = wd.classifications.find((x) => x.label === label);
  if (!c) throw new Error(`no classification ${label}`);
  return c.key;
};

const project: Project = {
  id: 'p1',
  name: 'Water Main Replacement',
  projectNumber: 'B-26-DC-00-0001',
  location: 'Harlow',
  owner: 'Village of Harlow Creek (sample)',
  fundingSource: 'CDBG',
  wdLockDate: '2026-04-01',
  reviewer: { name: 'R', title: 'Labor Standards Officer', organization: 'O', email: '', phone: '' },
  settings: { overtimeRuleApplies: true, lateAfterDays: 14, arithmeticToleranceDollars: 1, executiveOrderMinimumWage: null },
  createdAt: '',
  updatedAt: '',
};

let seq = 0;
function line(p: Partial<PayrollLine>): PayrollLine {
  return {
    id: `L${++seq}`,
    workerName: 'Worker',
    workerId: '1234',
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

function payroll(p: Partial<Payroll> & { lines: PayrollLine[] }): Payroll {
  return {
    id: `P${++seq}`,
    projectId: 'p1',
    contractorId: 'c1',
    payrollNumber: '1',
    weekEnding: '2026-07-11',
    receivedDate: '2026-07-15',
    noWork: false,
    isFinal: false,
    supersedesPayrollId: null,
    statementOfComplianceSigned: true,
    source: { kind: 'manual', fileName: null, fileId: null },
    status: 'received',
    reviewNote: '',
    reviewedAt: null,
    createdAt: '',
    updatedAt: '',
    ...p,
  };
}

function contractor(p: Partial<Contractor> = {}): Contractor {
  return {
    id: 'c1',
    projectId: 'p1',
    name: 'Ridgeline Concrete LLC',
    tier: 'subcontractor',
    trade: 'Concrete',
    startDate: null,
    endDate: null,
    contactName: '',
    contactEmail: '',
    address: '',
    apprenticePrograms: [],
    ...p,
  };
}

const mapping = (payrollLabel: string, classificationKey: string, contractorId = 'c1'): ClassificationMapping => ({
  id: `m-${payrollLabel}`,
  projectId: 'p1',
  contractorId,
  payrollLabel: normalizeLabel(payrollLabel),
  classificationKey,
});

const baseMappings = [
  mapping('Laborer Group 1', key('LABORER — GROUP 1')),
  mapping('Electrician', key('ELECTRICIAN')),
  mapping('Cement Mason', key('CEMENT MASON/CONCRETE FINISHER')),
  mapping('Diver', key('DIVER (Commercial)')),
  mapping('Welder', NOT_ON_WD),
];

function run(payrolls: Payroll[], opts: Partial<EvaluationInput> = {}) {
  return evaluateProject({
    project,
    wd,
    contractors: [contractor()],
    payrolls,
    mappings: baseMappings,
    asOf: '2026-07-20',
    ...opts,
  });
}

const rules = (e: ReturnType<typeof run>) => e.findings.map((f) => f.ruleId).sort();
const only = (e: ReturnType<typeof run>, rule: RuleId) => e.findings.filter((f) => f.ruleId === rule);

describe('rate checks against the wage determination', () => {
  it('accepts a laborer paid exactly the WD rate and fringe', () => {
    const e = run([payroll({ lines: [line({})] })]);
    expect(e.findings).toEqual([]);
    expect(e.totalOwed).toBe(0);
  });

  it('computes the base-rate shortfall on straight-time hours', () => {
    // WD LABORER GROUP 1 = $26.85; paid $24.10 → $2.75 × 40 = $110.00
    const e = run([payroll({ lines: [line({ rateST: 24.1 })] })]);
    expect(rules(e)).toEqual(['base-rate-below-wd']);
    expect(e.totalOwed).toBe(110);
  });

  it('lets cash paid above the basic rate satisfy the fringe (cash in lieu)', () => {
    const e = run([payroll({ lines: [line({ rateST: 39.25, fringePlanHourly: 0 })] })]);
    expect(e.findings).toEqual([]);
  });

  it('does not let extra fringe make up for a low basic rate', () => {
    const e = run([payroll({ lines: [line({ rateST: 25, fringePlanHourly: 14.25 })] })]);
    expect(rules(e)).toEqual(['base-rate-below-wd']);
    expect(e.totalOwed).toBe(74); // $1.85 × 40
  });

  it('computes the fringe shortfall on all hours worked, including overtime', () => {
    // Fringe $12.40 required, $10.00 credited → $2.40 × 45 hrs = $108.00; OT paid correctly at 1.5×.
    const e = run([payroll({ lines: [line({ fringePlanHourly: 10, totalOT: 5, rateOT: 40.275 })] })]);
    expect(rules(e)).toEqual(['fringe-shortfall']);
    expect(e.totalOwed).toBe(108);
  });

  it('applies percentage fringes to the basic rate (ELECTRICIAN 3%+21.00)', () => {
    // Required fringe = 1.32 + 21.00 = 22.32; credited 21.00 → 1.32 × 40 = 52.80
    const e = run([
      payroll({ lines: [line({ classification: 'Electrician', rateST: 44, fringePlanHourly: 21 })] }),
    ]);
    expect(rules(e)).toEqual(['fringe-shortfall']);
    expect(e.totalOwed).toBe(52.8);
  });

  it('flags overtime paid below 1.5 × the basic rate', () => {
    // Required OT = 26.85 × 1.5 = 40.275; paid 30.00 → 10.275 × 5 = 51.375 → $51.38
    const e = run([payroll({ lines: [line({ totalOT: 5, rateOT: 30 })] })]);
    expect(rules(e)).toEqual(['overtime-rate']);
    expect(e.totalOwed).toBe(51.38);
  });

  it('flags hours over 40 paid as straight time', () => {
    // 45 ST hrs: 5 hrs × 0.5 × 26.85 = 67.125 → $67.13
    const e = run([payroll({ lines: [line({ totalST: 45 })] })]);
    expect(rules(e)).toEqual(['overtime-unreported']);
    expect(e.totalOwed).toBe(67.13);
  });

  it('skips overtime rules when the project is not covered by CWHSSA', () => {
    const e = run([payroll({ lines: [line({ totalST: 45 })] })], {
      project: { ...project, settings: { ...project.settings, overtimeRuleApplies: false } },
    });
    expect(e.findings).toEqual([]);
  });

  it('derives the overtime rate from gross when the payroll omits it', () => {
    // gross = 40×26.85 + 5×35.00 = 1074 + 175 = 1249 → derived OT 35.00 < 40.275 → 5.275×5 = 26.375 → $26.38
    const e = run([payroll({ lines: [line({ totalOT: 5, grossThisProject: 1249 })] })]);
    expect(rules(e)).toEqual(['overtime-rate']);
    expect(e.totalOwed).toBe(26.38);
    expect([...e.lines.values()][0]!.paidOT).toBe(35);
  });

  it('applies the Executive Order minimum to ** classifications when the project opts in', () => {
    const lines = [line({ classification: 'Cement Mason', rateST: 24.18, fringePlanHourly: 6.12 })];
    expect(run([payroll({ lines })]).findings).toEqual([]);
    const e = run([payroll({ lines })], {
      project: { ...project, settings: { ...project.settings, executiveOrderMinimumWage: 25 } },
    });
    expect(rules(e)).toEqual(['eo-minimum-wage']);
    expect(e.totalOwed).toBe(32.8); // 0.82 × 40
  });

  it('skips hourly checks for per-day classifications with an info note', () => {
    const e = run([payroll({ lines: [line({ classification: 'Diver', rateST: 50, fringePlanHourly: 0 })] })]);
    expect(rules(e)).toEqual(['per-day-rate']);
    expect(e.totalOwed).toBe(0);
  });
});

describe('classifications', () => {
  it('requires a mapping for unknown job titles and remembers exact WD labels', () => {
    const e = run([
      payroll({
        lines: [
          line({ classification: 'Ditch Digger' }),
          line({ classification: 'laborer — group 1' }), // exact WD label → auto-mapped
        ],
      }),
    ]);
    expect(rules(e)).toEqual(['classification-unmapped']);
  });

  it('treats work mapped as "not on WD" as a conformance violation', () => {
    const e = run([payroll({ lines: [line({ classification: 'Welder' })] })]);
    expect(rules(e)).toEqual(['classification-not-on-wd']);
    expect(only(e, 'classification-not-on-wd')[0]!.severity).toBe('violation');
  });

  it('suggests classifications using group definitions', () => {
    expect(suggestClassifications('Backhoe Operator', wd.classifications)[0]!.classification.label).toBe(
      'POWER EQUIPMENT OPERATOR — GROUP 2',
    );
    expect(suggestClassifications('Common Laborer', wd.classifications)[0]!.classification.label).toBe(
      'LABORER — GROUP 1',
    );
    expect(suggestClassifications('Electrician (Journeyman)', wd.classifications)[0]!.classification.label).toBe(
      'ELECTRICIAN',
    );
    expect(suggestClassifications('Roller operator', wd.classifications)[0]!.classification.label).toBe(
      'POWER EQUIPMENT OPERATOR — GROUP 3',
    );
    expect(suggestClassifications('zzz', wd.classifications)).toEqual([]);
  });
});

describe('apprentices', () => {
  const program: ApprenticeProgram = {
    id: 'ap1',
    name: 'IBEW-NECA JATC',
    registeredWith: 'OA',
    classification: 'Electrician',
    wagePercent: 60,
    fringePercent: null,
    maxApprenticesPerJourneyworker: 1,
  };
  const elecContractor = contractor({ apprenticePrograms: [program] });
  const journey = () => line({ classification: 'Electrician', rateST: 44, fringePlanHourly: 22.32 });
  const apprentice = (p: Partial<PayrollLine> = {}) =>
    line({ classification: 'Electrician', apprentice: true, rateST: 26.4, fringePlanHourly: 22.32, ...p });

  it('checks a registered apprentice at the program percentage with full fringe', () => {
    const e = run([payroll({ lines: [journey(), apprentice()] })], { contractors: [elecContractor] });
    expect(e.findings).toEqual([]);
  });

  it('flags an apprentice paid below the program percentage', () => {
    const e = run([payroll({ lines: [journey(), apprentice({ rateST: 25 })] })], { contractors: [elecContractor] });
    expect(rules(e)).toEqual(['apprentice-rate']);
    expect(e.totalOwed).toBe(56); // (26.40 − 25.00) × 40
  });

  it('warns when no registered program is on file', () => {
    const e = run([payroll({ lines: [journey(), apprentice()] })]);
    expect(rules(e)).toEqual(['apprentice-unregistered']);
    expect(e.totalOwed).toBe(0);
  });

  it('requires the journeyworker rate for apprentices over the ratio', () => {
    // 1 journeyworker allows 1 apprentice at 1:1; the second is owed (44.00 − 26.40) × 40 = $704.00
    const e = run([payroll({ lines: [journey(), apprentice(), apprentice({ workerName: 'Second' })] })], {
      contractors: [elecContractor],
    });
    expect(rules(e)).toEqual(['apprentice-ratio']);
    expect(only(e, 'apprentice-ratio')[0]!.workerName).toBe('Second');
    expect(e.totalOwed).toBe(704);
  });
});

describe('payroll-level checks', () => {
  it('requires a signed Statement of Compliance', () => {
    const e = run([payroll({ statementOfComplianceSigned: false, lines: [line({})] })]);
    expect(rules(e)).toEqual(['soc-missing']);
  });

  it('flags late submissions, full SSNs and arithmetic errors as warnings', () => {
    const e = run([
      payroll({
        receivedDate: '2026-07-31',
        lines: [
          line({ workerId: '123-45-6789', grossThisProject: 1000, grossAllWork: 1200, deductions: 200, netPay: 950 }),
          line({ dailyST: [8, 8, 8, 8, 6, 0, 0] }),
        ],
      }),
    ]);
    expect(rules(e)).toEqual(['full-ssn', 'gross-arithmetic', 'hours-arithmetic', 'late-submission', 'net-arithmetic']);
    expect(e.findings.every((f) => f.severity === 'warning')).toBe(true);
    expect(e.payrolls.get(e.findings[0]!.payrollId!)!.state).toBe('warnings');
  });

  it('keeps findings on a superseded payroll as history, not open findings', () => {
    const original = payroll({ lines: [line({ rateST: 20 })] });
    const corrected = payroll({ supersedesPayrollId: original.id, lines: [line({})] });
    const e = run([original, corrected]);
    expect(e.findings).toEqual([]);
    expect(e.payrolls.get(original.id)!.state).toBe('superseded');
    expect(e.historicalFindings.map((f) => [f.ruleId, f.amountOwed, f.supersededBy])).toEqual([
      ['base-rate-below-wd', 274, corrected.id], // (26.85 − 20.00) × 40
    ]);
    // The underpayment stays in the ledger, paid through the correction unless recorded otherwise.
    const { rows, totals } = buildLedger([...e.findings, ...e.historicalFindings], [], [contractor()]);
    expect(rows[0]!.status).toBe('paid');
    expect(totals.owed).toBe(274);
    expect(totals.outstanding).toBe(0);
  });

  it('flags duplicate weeks and payroll-number gaps', () => {
    const e = run([
      payroll({ payrollNumber: '1', weekEnding: '2026-07-04', lines: [line({})] }),
      payroll({ payrollNumber: '3', weekEnding: '2026-07-11', lines: [line({})] }),
      payroll({ payrollNumber: '3', weekEnding: '2026-07-11', lines: [line({})] }),
    ]);
    expect(rules(e)).toEqual(['duplicate-week', 'payroll-number-gap']);
  });
});

describe('missing weeks', () => {
  it('finds weeks with no payroll once they are overdue', () => {
    const e = run(
      [
        payroll({ payrollNumber: '1', weekEnding: '2026-07-11', lines: [line({})] }),
        payroll({ payrollNumber: '3', weekEnding: '2026-07-25', lines: [line({})] }),
      ],
      { contractors: [contractor({ startDate: '2026-07-06' })], asOf: '2026-08-10' },
    );
    const cells = e.weeks[0]!.cells.map((c) => `${c.weekEnding}:${c.state}`);
    expect(cells).toEqual([
      '2026-07-11:received',
      '2026-07-18:missing',
      '2026-07-25:received',
      '2026-08-01:not-due',
      '2026-08-08:not-due',
    ]);
    expect(only(e, 'missing-week').map((f) => f.weekEnding)).toEqual(['2026-07-18']);
  });

  it('counts "no work" payrolls and stops after the final payroll', () => {
    const e = run(
      [
        payroll({ weekEnding: '2026-07-11', lines: [line({})] }),
        payroll({ weekEnding: '2026-07-18', noWork: true, lines: [] }),
        payroll({ weekEnding: '2026-07-25', isFinal: true, lines: [line({})] }),
      ],
      { contractors: [contractor({ startDate: '2026-07-06' })], asOf: '2026-09-30' },
    );
    expect(e.weeks[0]!.cells.map((c) => c.state)).toEqual(['received', 'no-work', 'received']);
    expect(only(e, 'missing-week')).toEqual([]);
  });

  it('expects weeks from the start date even before the first payroll arrives', () => {
    // Start Monday 7/6 with no payroll yet: a 7-day workweek from the start date ends Sunday 7/12.
    const e = run([], { contractors: [contractor({ startDate: '2026-07-06' })], asOf: '2026-08-01' });
    expect(e.weeks[0]!.weekEndingDay).toBe(0);
    expect(only(e, 'missing-week').map((f) => f.weekEnding)).toEqual(['2026-07-12']);
  });
});

describe('restitution ledger', () => {
  it('tracks status, partial payments and outstanding balances', () => {
    const e = run([payroll({ lines: [line({ rateST: 24.1 }), line({ totalST: 45, workerName: 'B' })] })]);
    const [base, ot] = e.findings;
    const { rows, totals } = buildLedger(
      e.findings,
      [
        { findingKey: base!.key, projectId: 'p1', status: 'paid', amountPaid: 50, note: 'check 1041', updatedAt: 'x' },
        { findingKey: ot!.key, projectId: 'p1', status: 'verified', amountPaid: 67.13, note: '', updatedAt: 'x' },
        { findingKey: 'stale', projectId: 'p1', status: 'paid', amountPaid: 999, note: '', updatedAt: 'x' },
      ],
      [contractor()],
    );
    expect(rows).toHaveLength(2);
    expect(totals.owed).toBe(177.13);
    expect(totals.paid).toBe(117.13);
    expect(totals.outstanding).toBe(60);
    expect(rows.find((r) => r.finding.key === base!.key)!.balance).toBe(60);
  });
});
