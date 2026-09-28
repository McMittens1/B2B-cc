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
  const n = ++seq;
  return {
    id: `L${n}`,
    workerName: `Worker ${n}`, // distinct people unless a test says otherwise
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

  it('checks an apprentice with no registered program at the journeyworker rate', () => {
    // 29 CFR 5.5(a)(4)(i): (44.00 − 26.40) × 40 = $704.00
    const e = run([payroll({ lines: [journey(), apprentice()] })]);
    expect(rules(e)).toEqual(['apprentice-unregistered', 'base-rate-below-wd']);
    expect(e.totalOwed).toBe(704);
  });

  it("never uses another trade's program for an apprentice", () => {
    const laborer = line({ classification: 'Laborer Group 1', apprentice: true, rateST: 16.11 });
    const e = run([payroll({ lines: [laborer] })], { contractors: [elecContractor] });
    expect(rules(e)).toEqual(['apprentice-unregistered', 'base-rate-below-wd']);
    expect(e.totalOwed).toBe(429.6); // (26.85 − 16.11) × 40
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

describe('review regressions: overtime', () => {
  const g2 = [...baseMappings, mapping('Laborer Group 2', key('LABORER — GROUP 2'))];

  it('treats overtime hours with nothing paid for them as unpaid, not unchecked', () => {
    // Gross covers the 40 straight-time hours only: the 5 OT hours were paid $0.
    const e = run([payroll({ lines: [line({ totalOT: 5, grossThisProject: 1074 })] })]);
    expect(rules(e)).toEqual(['overtime-rate']);
    expect(e.totalOwed).toBe(201.38); // 1.5 × 26.85 = 40.275 × 5 hrs
  });

  it('warns when overtime hours have no rate and no gross to derive one from', () => {
    const e = run([payroll({ lines: [line({ totalOT: 5 })] })]);
    expect(only(e, 'overtime-rate').map((f) => f.severity)).toEqual(['warning']);
    expect(e.totalOwed).toBe(0);
  });

  it('counts the 40 hours per worker, across classifications', () => {
    const same = { workerName: 'Dana Cruz', workerId: '5501' };
    const e = run(
      [payroll({ lines: [line({ ...same, totalST: 24 }), line({ ...same, classification: 'Laborer Group 2', totalST: 24, rateST: 27.6 })] })],
      { mappings: g2 },
    );
    expect(rules(e)).toEqual(['overtime-unreported', 'overtime-unreported']);
    expect(e.totalOwed).toBe(108.9); // 4 hrs × 0.5 × 26.85 + 4 hrs × 0.5 × 27.60
  });

  it('leaves cash paid in lieu of fringe out of the overtime rate', () => {
    // $39.25 = $26.85 basic + $12.40 fringe in cash. OT is owed at 1.5 × 26.85 + 12.40 = $52.675.
    const cash = { rateST: 39.25, fringePlanHourly: 0, totalOT: 5 };
    expect(run([payroll({ lines: [line({ ...cash, rateOT: 52.675 })] })]).findings).toEqual([]);
    // Paying 1.5 × the basic rate but no fringe on the overtime hours leaves the fringe owed on them.
    const e = run([payroll({ lines: [line({ ...cash, rateOT: 40.275 })] })]);
    expect(rules(e)).toEqual(['fringe-shortfall']);
    expect(e.totalOwed).toBe(62);
  });

  it('requires 1.5x only on hours over 40 for the week', () => {
    // Daily overtime at 1.25x in a 40-hour week is above the WD rate and owes nothing more.
    const e = run([payroll({ lines: [line({ totalST: 32, totalOT: 8, rateOT: 33.5625 })] })]);
    expect(e.findings).toEqual([]);
  });

  it('checks overtime-column hours against the WD rate when the overtime rule is off', () => {
    const off = { ...project, settings: { ...project.settings, overtimeRuleApplies: false } };
    const e = run([payroll({ lines: [line({ totalOT: 5, rateOT: 20 })] })], { project: off });
    expect(rules(e)).toEqual(['base-rate-below-wd']);
    expect(e.totalOwed).toBe(34.25); // (26.85 − 20.00) × 5
  });

  it('checks overtime on lines whose rate cannot be checked against the WD', () => {
    const e = run([
      payroll({ lines: [line({ classification: 'Welder', totalST: 50, rateST: 30 }), line({ classification: 'Diver', totalST: 50, rateST: 80 })] }),
    ]);
    expect(only(e, 'overtime-unreported').map((f) => f.amountOwed)).toEqual([150, 400]);
  });
});

describe('review regressions: apprentices', () => {
  const program: ApprenticeProgram = {
    id: 'ap1',
    name: 'IBEW-NECA JATC',
    registeredWith: 'OA',
    classification: 'Electrician',
    wagePercent: 60,
    fringePercent: null,
    maxApprenticesPerJourneyworker: 1,
  };
  const journey = (p: Partial<PayrollLine> = {}) => line({ classification: 'Electrician', rateST: 44, fringePlanHourly: 22.32, ...p });
  const apprentice = (p: Partial<PayrollLine> = {}) =>
    line({ classification: 'Electrician', apprentice: true, rateST: 26.4, fringePlanHourly: 22.32, ...p });

  it('includes the journeyworker overtime premium for an apprentice over the ratio', () => {
    const e = run([payroll({ lines: [journey(), apprentice(), apprentice({ totalST: 45 })] })], {
      contractors: [contractor({ apprenticePrograms: [program] })],
    });
    // At the journeyworker rate: 17.60 × 45 = 792 + 0.5 × 44 × 5 = 110.
    expect(e.totalOwed).toBe(902);
  });

  it('counts journeyworkers as people, not payroll lines', () => {
    const j = { workerName: 'Sam Ortiz', workerId: '7001', totalST: 20 };
    const e = run([payroll({ lines: [journey(j), journey(j), apprentice(), apprentice()] })], {
      contractors: [contractor({ apprenticePrograms: [program] })],
    });
    expect(only(e, 'apprentice-ratio')).toHaveLength(1);
  });

  it('reads a ratio below 1 as one apprentice per N journeyworkers', () => {
    const oneInThree = { ...program, maxApprenticesPerJourneyworker: 0.33 };
    const e = run([payroll({ lines: [journey(), journey(), journey(), apprentice()] })], {
      contractors: [contractor({ apprenticePrograms: [oneInThree] })],
    });
    expect(e.findings).toEqual([]);
  });
});

describe('review regressions: keys, dates and identifiers', () => {
  it('keeps the same finding key when the base-rate rule variant changes', () => {
    const lines = [line({ classification: 'Cement Mason', rateST: 24, fringePlanHourly: 6.12 })];
    const plain = run([payroll({ id: 'PX', lines })]);
    const eo = run([payroll({ id: 'PX', lines })], {
      project: { ...project, settings: { ...project.settings, executiveOrderMinimumWage: 25 } },
    });
    expect(plain.findings.map((f) => [f.ruleId, f.amountOwed])).toEqual([['base-rate-below-wd', 7.2]]);
    expect(eo.findings.map((f) => [f.ruleId, f.amountOwed])).toEqual([['eo-minimum-wage', 40]]);
    expect(eo.findings[0]!.key).toBe(plain.findings[0]!.key);
  });

  it('flags full SSNs written with spaces or dots', () => {
    for (const workerId of ['123 45 6789', '123.45.6789', '123456789']) {
      expect(rules(run([payroll({ lines: [line({ workerId })] })]))).toEqual(['full-ssn']);
    }
  });

  it('reports a bad date instead of failing the whole evaluation', () => {
    const e = run([payroll({ weekEnding: '' as never, lines: [line({})] }), payroll({ receivedDate: '7/15/2026' as never, lines: [line({})] })]);
    expect(only(e, 'invalid-date')).toHaveLength(2);
  });

  it('keeps job-title matches pointing at the same classification when the WD gains a line', () => {
    const text = fs.readFileSync('fixtures/wd/sample-modern.txt', 'utf8');
    const added = parseWageDetermination(
      text.replace('     GROUP 2.....................$ 27.60', '     GROUP 1A....................$ 26.95            12.40\n     GROUP 2.....................$ 27.60'),
    );
    const before = wd.classifications.find((c) => c.label === 'LABORER — GROUP 2')!;
    expect(added.classifications.find((c) => c.key === before.key)!.baseRate).toBe(27.6);
  });

  it('carries a job-title match forward when a modification renumbers the rate identifier', () => {
    const renumbered = parseWageDetermination(fs.readFileSync('fixtures/wd/sample-modern.txt', 'utf8').replace('LABO0265-006', 'LABO0265-007'));
    const e = run([payroll({ lines: [line({})] })], { wd: renumbered });
    expect(e.findings).toEqual([]);
    expect([...e.lines.values()][0]!.classification!.rateId).toBe('LABO0265-007');
  });
});

describe('review regressions: restitution ledger', () => {
  it('counts only what a correction actually paid', () => {
    const who = { workerName: 'Javier Ruiz', workerId: '3021' };
    const original = payroll({ id: 'ORIG', lines: [line({ ...who, rateST: 20 })] }); // short 6.85 × 40 = 274
    const corrected = payroll({ id: 'CORR', supersedesPayrollId: 'ORIG', lines: [line({ ...who, rateST: 24.1 })] }); // still short 110
    const e = run([original, corrected]);
    const { totals } = buildLedger([...e.findings, ...e.historicalFindings], [], [contractor()]);
    expect(totals).toMatchObject({ owed: 274, paid: 164, outstanding: 110 });
  });

  it('still shows a balance on a verified row that was only partly paid', () => {
    const e = run([payroll({ lines: [line({ rateST: 24.1 })] })]);
    const f = e.findings[0]!;
    const { totals } = buildLedger(e.findings, [{ findingKey: f.key, projectId: 'p1', status: 'verified', amountPaid: 10, note: '', updatedAt: 'x' }], [contractor()]);
    expect(totals).toMatchObject({ owed: 110, paid: 10, outstanding: 100 });
  });
});
