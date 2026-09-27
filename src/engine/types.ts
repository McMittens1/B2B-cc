/**
 * Core domain model for Wagebench.
 *
 * Everything in src/engine is pure TypeScript with no DOM or storage access, so
 * the same logic runs in the browser, in unit tests, and in scripts.
 */

export type ISODate = string; // YYYY-MM-DD

// ---------------------------------------------------------------------------
// Wage determinations
// ---------------------------------------------------------------------------

export type RateIdKind =
  | 'union' // e.g. ELEC0001-005
  | 'survey' // e.g. SUOH2021-005
  | 'union-average' // e.g. UAVG-OH-0010
  | 'state-adopted' // e.g. SAOH2023-001
  | 'interim' // e.g. IN-2024-001
  | 'other';

/** A fringe amount as written in the "Fringes" column, e.g. "3%+21.00" or "12.00+a". */
export interface FringeSpec {
  /** Fixed hourly amount in dollars. */
  fixed: number;
  /** Percentage of the basic hourly rate (e.g. 4 for "4%"). */
  percent: number;
  /** Footnote letters that modify the fringe (e.g. "a" for paid holidays). */
  footnotes: string[];
  /** The text exactly as it appeared in the wage determination. */
  raw: string;
}

export interface WDClassification {
  /** Stable key: `${rateId}#${ordinal}` — unique within one wage determination. */
  key: string;
  rateId: string;
  rateIdEffective: ISODate | null;
  kind: RateIdKind;
  /** Area or county qualifier inside the rate block, if any (e.g. "BOONE COUNTY", "AREA 1"). */
  scope: string | null;
  /** Parent heading, e.g. "LABORER" for "LABORER — GROUP 3". */
  parent: string | null;
  /** The classification's own label, e.g. "GROUP 3" or "ELECTRICIAN". */
  name: string;
  /** Full display label: parent + name. */
  label: string;
  /** Group definition text found in the block notes (e.g. which job titles belong to GROUP 3). */
  description: string | null;
  baseRate: number;
  fringe: FringeSpec;
  unit: 'hour' | 'day';
  /** "**" marker: workers may be entitled to a higher Executive Order minimum wage. */
  executiveOrderFlag: boolean;
  /** 1-based line number in the source text, for traceability. */
  line: number;
}

export interface WDRateBlock {
  rateId: string;
  effective: ISODate | null;
  kind: RateIdKind;
  notes: string;
  line: number;
}

export interface WDModification {
  number: number;
  publicationDate: ISODate | null;
}

export interface ParsedWageDetermination {
  decisionNumber: string | null;
  decisionDate: ISODate | null;
  supersededDecision: string | null;
  state: string | null;
  constructionTypes: string | null;
  counties: string | null;
  modifications: WDModification[];
  /** Highest modification number found. */
  currentModification: number | null;
  classifications: WDClassification[];
  blocks: WDRateBlock[];
  /** General notes (Executive Order minimums, welders note, etc.). */
  generalNotes: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Projects, contractors, payrolls
// ---------------------------------------------------------------------------

export type FundingSource =
  | 'CDBG'
  | 'CDBG-DR'
  | 'HOME'
  | 'EPA SRF'
  | 'USDA RD'
  | 'FHWA'
  | 'FAA'
  | 'Other federal'
  | 'State prevailing wage';

export interface ProjectSettings {
  /** Contract Work Hours and Safety Standards Act overtime applies (contracts over $100,000). */
  overtimeRuleApplies: boolean;
  /** Payroll considered late if received more than this many days after week ending. */
  lateAfterDays: number;
  /** Tolerance in dollars for arithmetic checks (rounding by payroll systems). */
  arithmeticToleranceDollars: number;
  /** Executive Order minimum wage to enforce on "**" classifications; null = not applicable. */
  executiveOrderMinimumWage: number | null;
}

export interface Project {
  id: string;
  name: string;
  projectNumber: string;
  location: string;
  /** Grantee, owner or awarding agency. */
  owner: string;
  fundingSource: FundingSource;
  /** Date the wage determination was locked in (bid opening or award). */
  wdLockDate: ISODate | null;
  reviewer: { name: string; title: string; organization: string; email: string; phone: string };
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

export interface StoredWageDetermination {
  id: string;
  projectId: string;
  rawText: string;
  parsed: ParsedWageDetermination;
  importedAt: string;
}

export type ContractorTier = 'prime' | 'subcontractor' | 'lower-tier';

export interface Contractor {
  id: string;
  projectId: string;
  name: string;
  tier: ContractorTier;
  trade: string;
  /** First week the contractor is expected to submit payrolls. */
  startDate: ISODate | null;
  /** Last week the contractor is expected to submit payrolls (null = ongoing). */
  endDate: ISODate | null;
  contactName: string;
  contactEmail: string;
  address: string;
  /** Registered apprenticeship programs this contractor uses. */
  apprenticePrograms: ApprenticeProgram[];
}

export interface ApprenticeProgram {
  id: string;
  name: string;
  registeredWith: 'OA' | 'SAA';
  classification: string;
  /** Apprentice wage as a percent of the journeyworker basic rate (e.g. 60 for 60%). */
  wagePercent: number | null;
  /**
   * Apprentice fringe as a percent of the WD fringe. null means the program does not
   * specify, in which case the full WD fringe is owed (29 CFR 5.5(a)(4)(i)).
   */
  fringePercent: number | null;
  /** Maximum apprentices per journeyworker (e.g. 1 means 1:1). */
  maxApprenticesPerJourneyworker: number | null;
}

export type PayrollSourceKind = 'csv' | 'xlsx' | 'wh347-pdf' | 'manual';

export interface PayrollLine {
  id: string;
  workerName: string;
  /** Identifying number as written (last four of SSN or an employee ID). */
  workerId: string;
  /** Classification exactly as written by the contractor. */
  classification: string;
  apprentice: boolean;
  /** Straight-time hours per day, index 0..6 (optional detail). */
  dailyST: number[];
  /** Overtime hours per day, index 0..6 (optional detail). */
  dailyOT: number[];
  totalST: number;
  totalOT: number;
  rateST: number;
  /** Overtime rate actually paid; null if the payroll does not show one. */
  rateOT: number | null;
  /** Hourly credit claimed for bona fide fringe benefit plans (WH-347 column 6B). */
  fringePlanHourly: number;
  /** Fringe paid in cash, per hour (WH-347 column 6C). */
  fringeCashHourly: number;
  grossThisProject: number | null;
  grossAllWork: number | null;
  deductions: number | null;
  netPay: number | null;
}

export type PayrollStatus = 'received' | 'reviewed' | 'correction-requested' | 'accepted';

export interface Payroll {
  id: string;
  projectId: string;
  contractorId: string;
  payrollNumber: string;
  weekEnding: ISODate;
  receivedDate: ISODate | null;
  /** "No work performed" payroll. */
  noWork: boolean;
  isFinal: boolean;
  /** If this payroll amends an earlier one, the id of the payroll it replaces. */
  supersedesPayrollId: string | null;
  statementOfComplianceSigned: boolean;
  source: { kind: PayrollSourceKind; fileName: string | null; fileId: string | null };
  lines: PayrollLine[];
  status: PayrollStatus;
  reviewNote: string;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** How a contractor's own job title maps onto a wage determination classification. */
export interface ClassificationMapping {
  id: string;
  projectId: string;
  contractorId: string;
  /** Normalized payroll classification text. */
  payrollLabel: string;
  /** WDClassification.key, or the sentinel NOT_ON_WD when the work has no listed classification. */
  classificationKey: string;
}

export const NOT_ON_WD = '__not_on_wd__';

// ---------------------------------------------------------------------------
// Findings and restitution
// ---------------------------------------------------------------------------

export type Severity = 'violation' | 'warning' | 'info';

export type RuleId =
  | 'classification-unmapped'
  | 'classification-not-on-wd'
  | 'base-rate-below-wd'
  | 'fringe-shortfall'
  | 'overtime-rate'
  | 'overtime-unreported'
  | 'eo-minimum-wage'
  | 'apprentice-unregistered'
  | 'apprentice-rate'
  | 'apprentice-ratio'
  | 'hours-arithmetic'
  | 'gross-arithmetic'
  | 'net-arithmetic'
  | 'gross-exceeds-all-work'
  | 'full-ssn'
  | 'soc-missing'
  | 'late-submission'
  | 'duplicate-week'
  | 'payroll-number-gap'
  | 'per-day-rate'
  | 'fringe-footnote'
  | 'missing-week';

export interface Finding {
  /** Deterministic key so review decisions and restitution survive recomputation. */
  key: string;
  ruleId: RuleId;
  severity: Severity;
  payrollId: string | null;
  contractorId: string;
  lineId: string | null;
  workerName: string | null;
  weekEnding: ISODate | null;
  title: string;
  detail: string;
  /** Wages owed to the worker, in dollars, when the finding is an underpayment. */
  amountOwed: number;
}

export type RestitutionStatus = 'owed' | 'requested' | 'paid' | 'verified' | 'waived';

export interface RestitutionRecord {
  /** Finding.key this record tracks. */
  findingKey: string;
  projectId: string;
  status: RestitutionStatus;
  /** Amount the contractor reports paying. */
  amountPaid: number;
  note: string;
  updatedAt: string;
}

/** A reviewer's decision to dismiss a warning/info finding as not applicable. */
export interface FindingDisposition {
  findingKey: string;
  projectId: string;
  disposition: 'dismissed';
  note: string;
  updatedAt: string;
}
