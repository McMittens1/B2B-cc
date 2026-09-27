import { addDays, nextWeekday } from '../engine/dates';
import { cents, extend } from '../engine/money';
import type { ApprenticeProgram, ContractorTier, ISODate } from '../engine/types';

/**
 * The demonstration project: a fictional CDBG-funded water main replacement with a prime
 * and three subcontractors. Payroll weeks are placed relative to "today" so the demo
 * always shows current, overdue and not-yet-due weeks. Every name, company and number is
 * invented. Mistakes are planted deliberately so each Wagebench check has something to find.
 */

export interface DemoWorker {
  last: string;
  first: string;
  mi: string;
  id: string;
  classification: string;
  apprentice?: boolean;
  rateST: number;
  fringePlan: number;
  fringeCash: number;
}

export interface DemoWeekLine {
  worker: DemoWorker;
  /** Straight-time hours Monday..Sunday (index 0 = Monday). */
  st: number[];
  ot: number[];
  rateOT: number | null;
  /** Override the computed gross (to plant arithmetic errors). */
  grossOverride?: number;
}

export interface DemoPayroll {
  contractorKey: DemoContractorKey;
  payrollNumber: string;
  weekEnding: ISODate;
  receivedDate: ISODate;
  signed: boolean;
  noWork?: boolean;
  lines: DemoWeekLine[];
}

export type DemoContractorKey = 'prime' | 'concrete' | 'electric' | 'paving';

export interface DemoContractor {
  key: DemoContractorKey;
  name: string;
  tier: ContractorTier;
  trade: string;
  startDate: ISODate;
  contactName: string;
  contactEmail: string;
  address: string;
  /** How this contractor sends payrolls in the demo. */
  channel: 'manual' | 'wh347-pdf' | 'csv' | 'xlsx';
  apprenticePrograms: Omit<ApprenticeProgram, 'id'>[];
}

export interface DemoScenario {
  today: ISODate;
  weeks: ISODate[];
  contractors: DemoContractor[];
  payrolls: DemoPayroll[];
  /** Job titles pre-matched to WD classification labels (others are left for the reviewer). */
  mappings: { contractorKey: DemoContractorKey; payrollLabel: string; wdLabel: string | 'NOT_ON_WD' }[];
}

const FULL_WEEK = [8, 8, 8, 8, 8, 0, 0];
const hours = (...h: number[]) => [...h, 0, 0, 0, 0, 0, 0, 0].slice(0, 7);

export function buildScenario(today: ISODate): DemoScenario {
  // Weeks end on Saturday. The latest week is the one that ended before today.
  const lastSaturday = addDays(nextWeekday(addDays(today, -7), 6), 0);
  const weeks: ISODate[] = [];
  for (let i = 9; i >= 0; i--) weeks.push(addDays(lastSaturday, -7 * i));
  const w = (i: number) => weeks[i]!;
  const monday = (i: number) => addDays(w(i), -5);

  const contractors: DemoContractor[] = [
    {
      key: 'prime',
      name: 'Brightwater Utility Constructors, Inc.',
      tier: 'prime',
      trade: 'Water main installation (prime)',
      startDate: monday(0),
      contactName: 'Elena Marsh',
      contactEmail: 'payroll@brightwater.example',
      address: '410 Foundry Road, Harlow, Sample State',
      channel: 'manual',
      apprenticePrograms: [],
    },
    {
      key: 'concrete',
      name: 'Ridgeline Concrete LLC',
      tier: 'subcontractor',
      trade: 'Vaults, thrust blocks, flatwork',
      startDate: monday(2),
      contactName: 'Tom Okafor',
      contactEmail: 'office@ridgelineconcrete.example',
      address: '88 Quarry Lane, Pine City, Sample State',
      channel: 'wh347-pdf',
      apprenticePrograms: [],
    },
    {
      key: 'electric',
      name: 'Kessler Electric Co.',
      tier: 'subcontractor',
      trade: 'Pump station electrical',
      startDate: monday(4),
      contactName: 'Priya Natarajan',
      contactEmail: 'accounting@kesslerelectric.example',
      address: '1200 Commerce Pkwy, Harlow, Sample State',
      channel: 'csv',
      apprenticePrograms: [
        {
          name: 'Sample Area Electrical JATC',
          registeredWith: 'OA',
          classification: 'Electrician',
          wagePercent: 60,
          fringePercent: null,
          maxApprenticesPerJourneyworker: 1,
        },
      ],
    },
    {
      key: 'paving',
      name: 'Northfork Paving & Grading',
      tier: 'subcontractor',
      trade: 'Trench restoration and paving',
      startDate: monday(6),
      contactName: 'Gus Lindqvist',
      contactEmail: 'gus@northforkpaving.example',
      address: 'PO Box 51, Northfork, Sample State',
      channel: 'xlsx',
      apprenticePrograms: [],
    },
  ];

  // --- Workers -----------------------------------------------------------------
  const prime = {
    operator: { last: 'Dunmore', first: 'Wade', mi: 'R', id: '4417', classification: 'Operator - Excavator', rateST: 39.65, fringePlan: 25.1, fringeCash: 0 },
    pipelayer: { last: 'Castellanos', first: 'Luis', mi: '', id: '2290', classification: 'Pipelayer', rateST: 27.6, fringePlan: 12.4, fringeCash: 0 },
    laborer: { last: 'Abernathy', first: 'Cole', mi: 'J', id: '7302', classification: 'Laborer Group 1', rateST: 26.85, fringePlan: 12.4, fringeCash: 0 },
    laborer2: { last: 'Kim', first: 'Daniel', mi: '', id: '5561', classification: 'Laborer Group 1', rateST: 26.85, fringePlan: 12.4, fringeCash: 0 },
  } satisfies Record<string, DemoWorker>;
  const concrete = {
    mason: { last: 'Whitaker', first: 'June', mi: 'A', id: '1188', classification: 'Concrete Finisher', rateST: 26.5, fringePlan: 6.12, fringeCash: 0 },
    ruiz: { last: 'Ruiz', first: 'Javier', mi: '', id: '3021', classification: 'Laborer', rateST: 24.1, fringePlan: 12.4, fringeCash: 0 },
    carpenter: { last: 'Lindgren', first: 'Ola', mi: '', id: '6650', classification: 'Carpenter', rateST: 31.4, fringePlan: 18.65, fringeCash: 0 },
    cash: { last: 'Boateng', first: 'Kwame', mi: '', id: '9034', classification: 'Laborer', rateST: 39.25, fringePlan: 0, fringeCash: 0 },
  } satisfies Record<string, DemoWorker>;
  const electric = {
    journey: { last: 'Halvorsen', first: 'Erik', mi: 'T', id: '2201', classification: 'Electrician', rateST: 44, fringePlan: 21, fringeCash: 0 },
    appr1: { last: 'Osei', first: 'Ama', mi: '', id: '8812', classification: 'Electrician', apprentice: true, rateST: 26.4, fringePlan: 22.32, fringeCash: 0 },
    appr2: { last: 'Brandt', first: 'Nico', mi: '', id: '8840', classification: 'Electrician', apprentice: true, rateST: 26.4, fringePlan: 22.32, fringeCash: 0 },
  } satisfies Record<string, DemoWorker>;
  const paving = {
    backhoe: { last: 'Pruitt', first: 'Dale', mi: '', id: '3310', classification: 'Backhoe Operator', rateST: 39.65, fringePlan: 25.1, fringeCash: 0 },
    roller: { last: 'Sato', first: 'Ken', mi: '', id: '3312', classification: 'Roller Operator', rateST: 36.9, fringePlan: 25.1, fringeCash: 0 },
    driver: { last: 'McBride', first: 'Rosa', mi: 'L', id: '3399', classification: 'Truck Driver', rateST: 22.75, fringePlan: 5.8, fringeCash: 0 },
    welder: { last: 'Vance', first: 'Trey', mi: '', id: '3340', classification: 'Welder', rateST: 30, fringePlan: 10, fringeCash: 0 },
  } satisfies Record<string, DemoWorker>;

  const line = (worker: DemoWorker, st = FULL_WEEK, ot = hours(), rateOT: number | null = null, extra: Partial<DemoWeekLine> = {}): DemoWeekLine => ({
    worker,
    st,
    ot,
    rateOT: rateOT ?? (ot.some((h) => h > 0) ? cents(worker.rateST * 1.5) : null),
    ...extra,
  });

  const payrolls: DemoPayroll[] = [];

  // Prime: weeks 0..9, keyed in by the reviewer. Week 5's statement was not signed.
  for (let i = 0; i < 10; i++) {
    const heavy = i >= 3 && i <= 6;
    payrolls.push({
      contractorKey: 'prime',
      payrollNumber: String(i + 1),
      weekEnding: w(i),
      receivedDate: addDays(w(i), 5),
      signed: i !== 5,
      lines: [
        line(prime.operator, FULL_WEEK, heavy ? hours(2, 2, 0, 2, 0, 0) : hours()),
        line(prime.pipelayer),
        line(prime.laborer, i === 8 ? hours(8, 8, 8, 0, 8) : FULL_WEEK),
        ...(i >= 2 ? [line(prime.laborer2)] : []),
      ],
    });
  }

  // Concrete sub: weeks 2..9 on WH-347 PDFs. Week 6 missing; Ruiz underpaid until a raise in week 8;
  // week 7 Whitaker worked 46 hours all paid as straight time.
  for (let i = 2; i < 10; i++) {
    if (i === 6) continue;
    const ruiz = i >= 8 ? { ...concrete.ruiz, rateST: 26.85 } : concrete.ruiz;
    payrolls.push({
      contractorKey: 'concrete',
      payrollNumber: String(i - 1),
      weekEnding: w(i),
      receivedDate: addDays(w(i), 6),
      signed: true,
      lines: [
        line(concrete.mason, i === 7 ? hours(10, 10, 10, 8, 8) : FULL_WEEK),
        line(ruiz),
        line(concrete.carpenter, i % 2 === 0 ? FULL_WEEK : hours(8, 8, 8, 0, 0)),
        ...(i >= 4 ? [line(concrete.cash, hours(8, 8, 8, 8, 0))] : []),
      ],
    });
  }

  // Electrical sub: weeks 4..9 as CSV exports. Journeyworker's fringe misses the 3% portion every week;
  // week 7 had two apprentices with one journeyworker (1:1 ratio allows one).
  for (let i = 4; i < 10; i++) {
    payrolls.push({
      contractorKey: 'electric',
      payrollNumber: String(i - 3),
      weekEnding: w(i),
      receivedDate: addDays(w(i), 4),
      signed: true,
      lines: [
        line(electric.journey, FULL_WEEK, i === 5 ? hours(0, 3, 0, 3, 0) : hours(), i === 5 ? 60 : null),
        line(electric.appr1),
        ...(i === 7 ? [line(electric.appr2)] : []),
      ],
    });
  }

  // Paving sub: weeks 6..9 as spreadsheets. Week 7 received late and shows a full SSN;
  // "Welder" is not on the WD; job titles need matching.
  for (let i = 6; i < 10; i++) {
    const driver = i === 7 ? { ...paving.driver, id: '512-44-3399' } : paving.driver;
    payrolls.push({
      contractorKey: 'paving',
      payrollNumber: String(i - 5),
      weekEnding: w(i),
      receivedDate: addDays(w(i), i === 7 ? 19 : 5),
      signed: true,
      lines: [
        line(paving.backhoe),
        line(paving.roller, hours(8, 8, 8, 0, 0)),
        line(driver, FULL_WEEK, hours(), null, i === 6 ? { grossOverride: 1180 } : {}),
        ...(i === 8 ? [line(paving.welder, hours(8, 8, 0, 0, 0))] : []),
      ],
    });
  }

  return {
    today,
    weeks,
    contractors,
    // A payroll that would arrive after today has not been received yet.
    payrolls: payrolls.filter((p) => p.receivedDate <= today),
    mappings: [
      { contractorKey: 'prime', payrollLabel: 'Operator - Excavator', wdLabel: 'POWER EQUIPMENT OPERATOR — GROUP 2' },
      { contractorKey: 'prime', payrollLabel: 'Pipelayer', wdLabel: 'LABORER — GROUP 2' },
      { contractorKey: 'prime', payrollLabel: 'Laborer Group 1', wdLabel: 'LABORER — GROUP 1' },
      { contractorKey: 'concrete', payrollLabel: 'Concrete Finisher', wdLabel: 'CEMENT MASON/CONCRETE FINISHER' },
      { contractorKey: 'concrete', payrollLabel: 'Laborer', wdLabel: 'LABORER — GROUP 1' },
      { contractorKey: 'concrete', payrollLabel: 'Carpenter', wdLabel: 'CARPENTER (Including Form Work)' },
      { contractorKey: 'electric', payrollLabel: 'Electrician', wdLabel: 'ELECTRICIAN' },
      { contractorKey: 'paving', payrollLabel: 'Welder', wdLabel: 'NOT_ON_WD' },
      // Backhoe Operator, Roller Operator and Truck Driver are left for the reviewer to match.
    ],
  };
}

/** Gross for a demo line: hours × rates + cash fringe, unless overridden. */
export function demoGross(l: DemoWeekLine): number {
  if (l.grossOverride !== undefined) return l.grossOverride;
  const st = l.st.reduce((a, b) => a + b, 0);
  const ot = l.ot.reduce((a, b) => a + b, 0);
  return cents(extend(st, l.worker.rateST) + extend(ot, l.rateOT ?? 0) + extend(st + ot, l.worker.fringeCash));
}

/** Simple, plausible deductions (22% of gross) so net pay reconciles. */
export function demoDeductions(gross: number): number {
  return cents(gross * 0.22);
}
