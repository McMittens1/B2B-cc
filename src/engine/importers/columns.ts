import { parseDateLoose } from '../dates';
import type { ISODate } from '../types';
import { cellDate, cellText } from './cells';

/**
 * The fields a payroll spreadsheet column can map to, and header detection.
 *
 * Contractors send registers exported from QuickBooks, Gusto, ADP, Paychex or
 * construction accounting systems, and spreadsheets typed into the WH-347 layout
 * (the 2008 form and the Rev. January 2025 form). Each names its columns
 * differently, so detection scores every header against synonym lists and assigns
 * columns greedily, best match first. A confirmed mapping can be remembered per
 * contractor under `headerSignature()` so the next week's file needs no review.
 */

export type DayNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const DAY_NUMBERS: readonly DayNumber[] = [1, 2, 3, 4, 5, 6, 7];

/** Daily hours: `day` columns follow the row's ST/OT marker; `st`/`ot` columns are typed by their header. */
export type DayField = `day${DayNumber}` | `st${DayNumber}` | `ot${DayNumber}`;

export type LineField =
  | 'workerName'
  | 'lastName'
  | 'firstName'
  | 'middleName'
  | 'workerId'
  | 'classification'
  | 'apprenticeFlag'
  | 'rowType'
  | 'totalST'
  | 'totalOT'
  | 'totalDT'
  | 'totalHours'
  | 'rateST'
  | 'rateOT'
  | 'stPay'
  | 'otPay'
  | 'fringePlanHourly'
  | 'fringeCashHourly'
  | 'fringePlanAmount'
  | 'fringeCashAmount'
  | 'grossPay'
  | 'grossThisProject'
  | 'grossAllWork'
  | 'deductionsTotal'
  | 'dedFica'
  | 'dedSocialSecurity'
  | 'dedMedicare'
  | 'dedFederal'
  | 'dedState'
  | 'dedOther'
  | 'netPay';

export type PayrollLevelField = 'weekEnding' | 'payrollNumber' | 'contractorName' | 'projectName';

export type PayrollField = LineField | DayField | PayrollLevelField;

export type SingleColumnField = Exclude<PayrollField, 'dedOther'>;

/**
 * Zero-based column index per field. `dedOther` takes several columns (union dues,
 * 401(k), local tax…) that are summed into total deductions when no total column exists.
 */
export type ColumnMap = { [F in SingleColumnField]?: number } & { dedOther?: number[] };

/** 0..1 per mapped field: 1 is an exact header match, ~0.6 a weak partial match. */
export type FieldConfidence = Partial<Record<PayrollField, number>>;

export type FieldKind = 'text' | 'hours' | 'rate' | 'money' | 'flag' | 'marker' | 'date';

export interface FieldInfo {
  field: PayrollField;
  label: string;
  kind: FieldKind;
  level: 'line' | 'payroll';
  /** Several columns may map to this field. */
  multiple?: boolean;
}

const dayInfo = (prefix: 'day' | 'st' | 'ot', label: string): FieldInfo[] =>
  DAY_NUMBERS.map((n) => ({ field: `${prefix}${n}` as DayField, label: `${label} day ${n}`, kind: 'hours', level: 'line' }));

/** Every mappable field with a label, for a column-mapping editor. */
export const FIELD_INFO: readonly FieldInfo[] = [
  { field: 'workerName', label: 'Worker name (full)', kind: 'text', level: 'line' },
  { field: 'lastName', label: 'Last name', kind: 'text', level: 'line' },
  { field: 'firstName', label: 'First name', kind: 'text', level: 'line' },
  { field: 'middleName', label: 'Middle name or initial', kind: 'text', level: 'line' },
  { field: 'workerId', label: 'Identifying number', kind: 'text', level: 'line' },
  { field: 'classification', label: 'Work classification', kind: 'text', level: 'line' },
  { field: 'apprenticeFlag', label: 'Journeyworker (J) or apprentice (A)', kind: 'flag', level: 'line' },
  { field: 'rowType', label: 'ST / OT row marker', kind: 'marker', level: 'line' },
  ...dayInfo('day', 'Hours'),
  ...dayInfo('st', 'Straight-time hours'),
  ...dayInfo('ot', 'Overtime hours'),
  { field: 'totalST', label: 'Total straight-time hours', kind: 'hours', level: 'line' },
  { field: 'totalOT', label: 'Total overtime hours', kind: 'hours', level: 'line' },
  { field: 'totalDT', label: 'Total double-time hours (added to overtime)', kind: 'hours', level: 'line' },
  { field: 'totalHours', label: 'Total hours (ST + OT, or per ST/OT row)', kind: 'hours', level: 'line' },
  { field: 'rateST', label: 'Straight-time hourly rate', kind: 'rate', level: 'line' },
  { field: 'rateOT', label: 'Overtime hourly rate', kind: 'rate', level: 'line' },
  { field: 'stPay', label: 'Straight-time pay amount', kind: 'money', level: 'line' },
  { field: 'otPay', label: 'Overtime pay amount', kind: 'money', level: 'line' },
  { field: 'fringePlanHourly', label: 'Fringe credit to plans, per hour (6B)', kind: 'rate', level: 'line' },
  { field: 'fringeCashHourly', label: 'Fringe paid in cash, per hour (6C)', kind: 'rate', level: 'line' },
  { field: 'fringePlanAmount', label: 'Fringe paid to plans, dollars for the week', kind: 'money', level: 'line' },
  { field: 'fringeCashAmount', label: 'Fringe paid in cash, dollars for the week', kind: 'money', level: 'line' },
  { field: 'grossPay', label: 'Gross pay (single gross column)', kind: 'money', level: 'line' },
  { field: 'grossThisProject', label: 'Gross earned, this project (7A)', kind: 'money', level: 'line' },
  { field: 'grossAllWork', label: 'Gross earned, all work (7B)', kind: 'money', level: 'line' },
  { field: 'deductionsTotal', label: 'Total deductions', kind: 'money', level: 'line' },
  { field: 'dedFica', label: 'FICA (Social Security + Medicare)', kind: 'money', level: 'line' },
  { field: 'dedSocialSecurity', label: 'Social Security', kind: 'money', level: 'line' },
  { field: 'dedMedicare', label: 'Medicare', kind: 'money', level: 'line' },
  { field: 'dedFederal', label: 'Federal withholding', kind: 'money', level: 'line' },
  { field: 'dedState', label: 'State withholding', kind: 'money', level: 'line' },
  { field: 'dedOther', label: 'Other deduction', kind: 'money', level: 'line', multiple: true },
  { field: 'netPay', label: 'Net pay', kind: 'money', level: 'line' },
  { field: 'weekEnding', label: 'Week ending', kind: 'date', level: 'payroll' },
  { field: 'payrollNumber', label: 'Payroll number', kind: 'text', level: 'payroll' },
  { field: 'contractorName', label: 'Contractor name', kind: 'text', level: 'payroll' },
  { field: 'projectName', label: 'Project', kind: 'text', level: 'payroll' },
];

// ---------------------------------------------------------------------------
// Header normalization
// ---------------------------------------------------------------------------

const NUMBERING = /^\s*(?:\(\s*\d{1,2}\s*[a-d]?\s*\)\s*|\d{1,2}\s*[a-d]?\s*[.:)-]\s*|\d{1,2}[a-d]?\s+(?=[a-z]))/;
const STOPWORDS = new Set(['of', 'the', 'and', 'for', 'to', 'in', 'on', 'or', 'by', 'at', 'per']);

/**
 * Lowercase words of a header with form numbering ("(9)", "6B.") removed and
 * shorthand folded ("O/T" → "ot", "Fed W/H" → "fed wh", "Emp #" → "emp no").
 */
export function normalizeHeaderText(value: unknown): string {
  let s = cellText(value).toLowerCase().replace(NUMBERING, '');
  s = s.replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ''));
  s = s.replace(/\b([a-z])\s*\/\s*([a-z])\b/g, '$1$2');
  s = s.replace(/#/g, ' no ').replace(/&/g, ' and ').replace(/%/g, ' pct ');
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

interface Words {
  tokens: string[];
  content: string[];
  contentSet: Set<string>;
  key: string;
}

function words(normalized: string): Words {
  const tokens = normalized.split(' ').filter(Boolean);
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  return { tokens, content, contentSet: new Set(content), key: content.join(' ') };
}

function hasPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Synonyms
// ---------------------------------------------------------------------------

type SynonymField = Exclude<PayrollField, DayField>;

interface FieldSpec {
  field: SynonymField;
  /** Wording that identifies the field, alone or inside a longer header. */
  names: string[];
  /** Short or generic wording accepted only as the entire header. */
  exact?: string[];
  /** Words or phrases that rule out a partial match. */
  not?: string[];
}

const MONEY_WORDS = ['rate', 'pay', 'earnings', 'earned', 'amount', 'wage', 'wages', 'gross', 'dollars', 'fringe'];
const DAILY_WORDS = ['day', 'daily', 'each'];
const TAX_BASE_WORDS = ['wages', 'taxable', 'employer', 'er', 'company', 'ytd'];

const SPECS: FieldSpec[] = [
  {
    field: 'workerName',
    names: [
      'employee name', 'worker name', 'name of worker', 'name of employee', 'employee full name', 'full name',
      'emp name', 'workers name', 'employees name', 'worker', 'employee', 'name', 'laborer or mechanic',
      'name and individual identifying number of worker', 'name and individual identifying number',
      'name and identifying number', 'name and identifying number of worker', 'name address and social security number of employee',
      'name and individual identifying number e g last four digits of social security number of worker',
      'name and address of worker',
    ],
    exact: ['employee last first', 'name last first', 'last first', 'last name first name', 'employee name last first', 'ee name', 'emp'],
    not: ['last', 'first', 'middle', 'id', 'no', 'code', 'ssn', 'company', 'contractor', 'employer', 'project', 'job', 'file', 'type', 'count', 'rate', 'hours', 'pay', 'class', 'classification', 'title', 'status', 'department'],
  },
  {
    field: 'lastName',
    names: ['last name', 'surname', 'family name', 'employee last name', 'worker last name', 'last nm', 'lname'],
    exact: ['last'],
    not: ['first', 'ssn', 'digits', '4', 'four', 'date', 'day'],
  },
  {
    field: 'firstName',
    names: ['first name', 'given name', 'employee first name', 'worker first name', 'first nm', 'fname'],
    exact: ['first'],
    not: ['last', 'date', 'day'],
  },
  {
    field: 'middleName',
    names: ['middle name', 'middle initial', 'employee middle name', 'employee middle initial'],
    exact: ['mi', 'middle', 'm i', 'init', 'initial'],
    not: ['date'],
  },
  {
    field: 'workerId',
    names: [
      'employee id', 'emp id', 'employee no', 'employee number', 'emp no', 'emp number', 'emp num', 'employee num',
      'worker id', 'worker no', 'worker number', 'identifying number', 'individual identifying number', 'id number',
      'id no', 'ssn', 'ssn last 4', 'last 4 ssn', 'last 4 of ssn', 'ssn last four', 'last four of ssn',
      'last four digits of ssn', 'last 4 digits of ssn', 'last four digits of social security number',
      'last 4 digits of social security number', 'social security number', 'social security no', 'ss no', 'ssn no',
      'ssn 4', 'badge no', 'badge number', 'badge', 'file no', 'file number', 'clock no', 'clock number',
      'employee code', 'emp code', 'ee id', 'id last 4', 'last 4',
    ],
    exact: ['id', 'no', 'ssn4', 'emp id no', 'employee id no'],
    not: ['name', 'job', 'project', 'contract', 'check', 'batch', 'tax', 'employer', 'fein', 'ein', 'company', 'co', 'department', 'dept', 'wages', 'withheld', 'withholding', 'medicare', 'payroll'],
  },
  {
    field: 'classification',
    names: [
      'classification', 'work classification', 'labor classification', 'job classification', 'craft',
      'craft classification', 'craft class', 'trade', 'trade classification', 'work class', 'labor class',
      'job class', 'wage class', 'wage classification', 'occupation', 'job title', 'position', 'title',
      'craft level', 'union class', 'class code', 'classification code', 'wd classification', 'labor category',
      'job category', 'employee classification', 'craft code', 'classification title', 'craft description',
      'work classification title',
    ],
    exact: ['class', 'craft trade'],
    not: ['rate', 'hours', 'pay', 'amount', 'fringe', 'apprentice', 'ot', 'st', 'ja'],
  },
  {
    field: 'apprenticeFlag',
    names: [
      'journeyworker or apprentice', 'journeyman or apprentice', 'journeyworker apprentice', 'journeyman apprentice',
      'journeyworker j or apprentice a', 'journeyman j or apprentice a', 'j or a', 'apprentice', 'apprentice yn',
      'apprentice status', 'apprentice flag', 'is apprentice', 'apprentice level', 'apprentice period',
      'apprentice pct', 'apprentice percent', 'appr level', 'skill level', 'journey level', 'jw or app',
      'status j a', 'j a status',
    ],
    exact: ['ja', 'app', 'appr', 'level', 'j a'],
    not: ['rate', 'hours', 'program', 'registration', 'ratio', 'number', 'no', 'wage', 'id'],
  },
  {
    field: 'rowType',
    names: [
      'ot or st', 'st or ot', 'o or s', 's or o', 'st ot', 'ot st', 'hours type', 'hour type', 'pay type',
      'earning type', 'earnings type', 'earnings code', 'earning code', 'pay code', 'time type', 'earning',
      'earnings description', 'earning description', 'pay item', 'payroll item', 'type of hours', 'type of pay',
      'straight or overtime', 'straight time or overtime',
    ],
    exact: ['type', 'so', 'os', 'code', 'item'],
    not: ['rate', 'worked', 'amount', 'total', 'ytd'],
  },
  {
    field: 'totalST',
    names: [
      'st hours', 'st hrs', 'straight time hours', 'straight time hrs', 'straight time', 'straight hours',
      'regular hours', 'regular hrs', 'reg hours', 'reg hrs', 'regular time', 'reg time', 'regular',
      'total st hours', 'total st', 'total straight time', 'total straight time hours', 'total regular hours',
      'total reg hours', 'hours st', 'hours regular', 'st total', 'regular hours worked', 'straight time hours worked',
      'total hours worked straight time', 'hours worked straight time', 'rt hours', 'reg hours worked',
    ],
    exact: ['st', 'reg', 'rt', 'straight'],
    not: [...MONEY_WORDS, ...DAILY_WORDS, 'ot', 'overtime', 'double', 'dt', 'type', 'code'],
  },
  {
    field: 'totalOT',
    names: [
      'ot hours', 'ot hrs', 'overtime hours', 'overtime hrs', 'overtime', 'hours ot', 'hours overtime', 'total ot',
      'total ot hours', 'total overtime', 'total overtime hours', 'ot time', 'overtime time', 'overtime hours worked',
      'ot hours worked', 'hours worked overtime', 'total hours worked overtime', '1 5 hours', 'time and a half hours',
      'time and one half hours',
    ],
    exact: ['ot'],
    not: [...MONEY_WORDS, ...DAILY_WORDS, 'st', 'straight', 'regular', 'reg', 'double', 'dt', 'type', 'code'],
  },
  {
    field: 'totalDT',
    names: [
      'dt hours', 'dt hrs', 'double time hours', 'double time hrs', 'double time', 'doubletime', 'doubletime hours',
      'double overtime hours', 'double ot hours', 'double overtime', 'total dt hours', 'total double time hours',
    ],
    exact: ['dt'],
    not: [...MONEY_WORDS, ...DAILY_WORDS],
  },
  {
    field: 'totalHours',
    names: [
      'total hours', 'total hrs', 'hours', 'hours worked', 'total hours worked', 'hours worked this project',
      'total hours this project', 'hours this project', 'total hours worked this project', 'project hours',
      'total project hours',
    ],
    exact: ['total', 'hrs'],
    not: [...MONEY_WORDS, ...DAILY_WORDS, 'st', 'straight', 'regular', 'reg', 'ot', 'overtime', 'double', 'dt', 'all', 'type', 'ytd', 'code'],
  },
  {
    field: 'rateST',
    names: [
      'rate', 'rate of pay', 'hourly rate', 'hourly rate of pay', 'base rate', 'base hourly rate', 'basic hourly rate',
      'basic hourly rate of pay', 'hourly base rate', 'hourly base rate of pay', 'reg rate', 'regular rate',
      'regular pay rate', 'regular hourly rate', 'st rate', 'straight time rate', 'straight time hourly rate',
      'pay rate', 'wage rate', 'hourly wage', 'hourly wage rate', 'rate per hour', 'base pay rate', 'rate st',
      'rate regular', 'rate of pay st', 'rate of pay straight time', 'hourly pay rate', 'rt rate', 'wage',
    ],
    not: ['ot', 'overtime', 'double', 'dt', 'fringe', 'benefit', 'benefits', 'cash', '1 5', 'premium', 'total', 'gross', 'amount', 'apprentice', 'pct', 'percent', 'tax', 'withholding', 'class', 'classification'],
  },
  {
    field: 'rateOT',
    names: [
      'ot rate', 'overtime rate', 'rate ot', 'rate overtime', 'ot pay rate', 'overtime pay rate', 'ot hourly rate',
      'overtime hourly rate', 'rate of pay ot', 'rate of pay overtime', 'time and a half rate', '1 5 rate',
      'ot wage rate', 'overtime wage rate',
    ],
    not: ['fringe', 'amount', 'total', 'gross', 'double', 'dt'],
  },
  {
    field: 'stPay',
    names: [
      'regular pay', 'reg pay', 'regular earnings', 'reg earnings', 'regular wages', 'reg wages', 'regular amount',
      'reg amount', 'regular gross', 'st pay', 'st earnings', 'st amount', 'st wages', 'straight time pay',
      'straight time earnings', 'straight time amount', 'straight time wages', 'regular pay amount',
      'regular dollars', 'reg dollars', 'regular earnings amount',
    ],
    not: ['rate', 'hours', 'hrs', 'ytd'],
  },
  {
    field: 'otPay',
    names: [
      'ot pay', 'overtime pay', 'ot earnings', 'overtime earnings', 'ot amount', 'overtime amount', 'ot wages',
      'overtime wages', 'ot gross', 'overtime gross', 'ot pay amount', 'overtime pay amount', 'ot dollars',
      'overtime dollars', 'overtime earnings amount',
    ],
    not: ['rate', 'hours', 'hrs', 'ytd'],
  },
  {
    field: 'fringePlanHourly',
    names: [
      'fringe', 'fringes', 'fringe rate', 'fringe benefits', 'fringe benefit', 'hourly fringe', 'fringe hourly',
      'fringe per hour', 'fringe benefit rate', 'fringe benefits per hour', 'hourly fringe benefit credit',
      'hourly fringe benefit credit for plans', 'fringe benefit credit', 'fringe credit', 'hourly fringe credit',
      'fringe benefits paid to plans', 'fringe benefits paid to approved plans',
      'fringe benefits paid to approved plans funds or programs', 'fringe paid to plans', 'fringes paid to plans',
      'benefits paid to plans', 'fringe to plans', 'plan fringe', 'fringe plan', 'fringe plans',
      'fringe benefit plans', 'fringe benefit contributions per hour', 'hourly fringe benefit',
      'fringe benefits hourly', 'hourly plan contributions', 'benefit rate', 'fringe to plans per hour',
    ],
    not: ['cash', 'amount', 'total', 'dollars', 'weekly', 'week', 'lieu'],
  },
  {
    field: 'fringeCashHourly',
    names: [
      'cash fringe', 'fringe cash', 'fringe paid in cash', 'fringes paid in cash', 'fringe benefits paid in cash',
      'hourly fringe benefits paid in cash', 'cash in lieu', 'cash in lieu of fringe', 'cash in lieu of fringes',
      'cash in lieu of fringe benefits', 'fringe in cash', 'fringe benefits in cash', 'cash fringe rate',
      'hourly cash fringe', 'cash fringe per hour', 'fringe cash per hour', 'hourly cash in lieu',
      'fringe in cash per hour',
    ],
    not: ['amount', 'total', 'dollars', 'weekly', 'week'],
  },
  {
    field: 'fringePlanAmount',
    names: [
      'fringe amount', 'fringe total', 'total fringe', 'total fringes', 'fringe dollars', 'fringe benefit amount',
      'fringe benefits amount', 'total fringe benefits', 'fringe benefits total', 'fringe benefit total',
      'weekly fringe', 'fringe contributions', 'fringe benefit contributions', 'plan contributions', 'fringe paid',
      'fringe benefit dollars', 'total fringe benefit contributions', 'total plan contributions',
      'fringe contribution amount',
    ],
    not: ['cash', 'rate', 'hourly', 'per hour', 'hr', 'lieu'],
  },
  {
    field: 'fringeCashAmount',
    names: [
      'cash fringe amount', 'fringe cash amount', 'total cash fringe', 'cash fringe total', 'cash in lieu amount',
      'cash in lieu total', 'cash fringe paid', 'total cash in lieu', 'cash fringe dollars',
    ],
    not: ['rate', 'hourly', 'per hour', 'hr'],
  },
  {
    field: 'grossPay',
    names: [
      'gross', 'gross pay', 'gross wages', 'gross earnings', 'gross amount', 'gross amount earned', 'total gross',
      'total gross pay', 'total earnings', 'total pay', 'total wages', 'gross wages paid', 'current gross',
      'gross total', 'total gross wages', 'gross earned',
    ],
    exact: ['earnings', 'wages', 'amount', 'total amount', 'pay'],
    not: ['project', 'job', 'contract', 'all', 'ytd', 'rate', 'hours', 'deduction', 'deductions', 'net', 'ot', 'overtime', 'regular', 'reg', 'st', 'straight', 'fringe', 'taxable', 'employer', 'double', 'dt'],
  },
  {
    field: 'grossThisProject',
    names: [
      'gross this project', 'gross amount earned this project', 'gross amount earned on this project',
      'gross earned this project', 'gross wages this project', 'gross pay this project', 'gross earnings this project',
      'this project', 'project gross', 'gross project', 'gross this job', 'job gross', 'gross this contract',
      'amount earned this project', 'earnings this project', 'wages this project', 'total this project',
      'gross wages paid this project', 'gross for this project',
    ],
    not: ['all work', 'all projects', 'hours', 'hrs', 'rate', 'ytd', 'net'],
  },
  {
    field: 'grossAllWork',
    names: [
      'gross all work', 'gross amount earned all work', 'gross amount earned for all work', 'gross earned all work',
      'gross wages all work', 'gross pay all work', 'gross earnings all work', 'all work', 'total all work',
      'gross all projects', 'all projects', 'gross all jobs', 'total gross all projects', 'total gross all work',
      'total earnings all work', 'gross wages all projects', 'total all projects', 'gross for all work',
    ],
    not: ['hours', 'hrs', 'rate', 'ytd', 'net'],
  },
  {
    field: 'deductionsTotal',
    names: [
      'total deductions', 'total deduction', 'deductions', 'deductions total', 'deduction total', 'total ded',
      'ded total', 'total withholdings', 'total withheld', 'total deductions withheld', 'total taxes and deductions',
      'deductions and taxes', 'total deductions and taxes', 'taxes and deductions', 'total taxes deductions',
    ],
    exact: ['deds'],
    not: ['fica', 'federal', 'fed', 'state', 'local', 'other', 'withholding', 'social', 'medicare', 'employer', 'er', 'ytd', 'misc', 'union', 'insurance', 'employee', 'exemptions'],
  },
  {
    field: 'dedFica',
    names: [
      'fica', 'fica tax', 'fica withheld', 'fica ss and medicare', 'fica social security and medicare',
      'social security and medicare', 'ss and medicare', 'ss medicare', 'social security medicare', 'fica ss med',
      'oasdi medicare', 'fica total',
    ],
    not: [...TAX_BASE_WORDS],
  },
  {
    field: 'dedSocialSecurity',
    names: [
      'social security', 'social security tax', 'social security withheld', 'soc sec', 'soc sec tax', 'ss tax',
      'ss withheld', 'oasdi', 'oasdi tax', 'fica ss', 'fica oasdi', 'fica social security', 'ee social security',
      'social security ee', 'employee social security', 'ss ee',
    ],
    exact: ['ss'],
    not: [...TAX_BASE_WORDS, 'number', 'no', 'ssn', 'last', 'gross', 'medicare', 'id', 'digits', 'four', '4'],
  },
  {
    field: 'dedMedicare',
    names: ['medicare', 'medicare tax', 'medicare withheld', 'fica medicare', 'fica med', 'ee medicare', 'medicare ee', 'employee medicare', 'med tax'],
    exact: ['med'],
    not: [...TAX_BASE_WORDS, 'gross', 'social'],
  },
  {
    field: 'dedFederal',
    names: [
      'federal', 'federal withholding', 'federal withholding tax', 'federal income tax', 'federal income tax withheld',
      'federal tax', 'federal tax withheld', 'fed wh', 'fed withholding', 'fed tax', 'fed income tax', 'fed inc tax',
      'fed it', 'fit', 'fwt', 'fitw', 'withholding tax', 'withholding', 'income tax', 'income tax withheld',
      'tax withholdings', 'federal wh', 'fed w holding', 'us withholding',
    ],
    exact: ['fed'],
    not: [...TAX_BASE_WORDS, 'state', 'local', 'city', 'county', 'exemptions', 'allowances', 'total', 'fica', 'social', 'medicare', 'no'],
  },
  {
    field: 'dedState',
    names: [
      'state', 'state withholding', 'state withholding tax', 'state wh', 'state tax', 'state income tax',
      'state income tax withheld', 'state tax withheld', 'state inc tax', 'sit', 'swt', 'sitw', 'state it',
      'state w holding',
    ],
    not: [...TAX_BASE_WORDS, 'federal', 'unemployment', 'sui', 'disability', 'sdi', 'id', 'no', 'exemptions', 'allowances'],
  },
  {
    field: 'dedOther',
    names: [
      'other', 'other deductions', 'other deduction', 'deductions other', 'misc deductions', 'miscellaneous deductions',
      'misc', 'other ded', 'other withholding', 'local tax', 'local income tax', 'city tax', 'county tax',
      'school district tax', 'sdi', 'state disability', 'state disability insurance', 'pfml', 'paid family leave',
      'fli', 'sui ee', 'ee sui', 'union dues', 'dues', '401 k', '401k', '403 b', 'retirement', 'pension', 'roth',
      'health insurance', 'health', 'medical', 'dental', 'vision', 'insurance', 'garnishment', 'wage garnishment',
      'child support', 'levy', 'loan', 'loan repayment', 'advance', 'uniform', 'uniforms', 'tools', 'savings',
      'charity', 'fsa', 'hsa', 'employee deductions', 'employee taxes', 'taxes', 'total taxes', 'employee tax',
      'total employee taxes', 'voluntary deductions', 'pre tax deductions', 'post tax deductions', 'vacation fund',
      'deduction',
    ],
    not: [...TAX_BASE_WORDS, 'match', 'hours', 'rate', 'fringe', 'exemptions', 'allowances', 'number', 'no', 'id'],
  },
  {
    field: 'netPay',
    names: [
      'net pay', 'net', 'net wages', 'net wages paid', 'net wages paid for week', 'net wages paid for all work',
      'net amount', 'net amount paid', 'net check', 'net check amount', 'check amount', 'net paid', 'take home',
      'take home pay', 'net earnings', 'net pay amount', 'net wages for week', 'net payment', 'total net pay',
      'net total',
    ],
    not: ['ytd', 'rate', 'hours'],
  },
  {
    field: 'weekEnding',
    names: [
      'week ending', 'week ending date', 'week ended', 'we date', 'week end', 'week end date', 'wk ending', 'wk end',
      'period ending', 'period end', 'period end date', 'period ending date', 'pay period end', 'pay period ending',
      'pay period end date', 'pay period ending date', 'for week ending', 'payroll week ending', 'workweek ending',
      'work week ending', 'pay end date', 'end date',
    ],
    exact: ['we', 'pe date', 'ped', 'week'],
    not: ['start', 'begin', 'beginning', 'check', 'hire', 'term', 'birth', 'net', 'wages', 'pay rate', 'hours'],
  },
  {
    field: 'payrollNumber',
    names: ['payroll no', 'payroll number', 'payroll num', 'certified payroll no', 'certified payroll number', 'cpr no', 'report no', 'report number'],
    exact: ['payroll'],
    not: ['date', 'item', 'type', 'week', 'period', 'tax', 'company', 'employee'],
  },
  {
    field: 'contractorName',
    names: [
      'contractor', 'contractor name', 'name of contractor', 'name of contractor or subcontractor',
      'contractor or subcontractor', 'subcontractor', 'subcontractor name', 'company name', 'employer name',
      'firm name', 'business name', 'prime contractor',
    ],
    exact: ['company', 'employer', 'firm'],
    not: ['code', 'id', 'no', 'number', 'address', 'phone', 'license', 'fein', 'ein', 'tax', 'taxes'],
  },
  {
    field: 'projectName',
    names: [
      'project', 'project name', 'project and location', 'project or contract', 'project location', 'job name',
      'job description', 'project description', 'contract name', 'project title', 'project and location of work',
    ],
    exact: ['job', 'job no', 'project no', 'project number', 'job number', 'contract no', 'contract number', 'job id', 'project id'],
    not: ['title', 'class', 'classification', 'hours', 'gross', 'rate', 'this project', 'cost', 'earnings', 'wages'],
  },
];

interface CompiledSpec {
  field: SynonymField;
  order: number;
  names: Words[];
  exact: Set<string>;
  not: string[][];
}

const COMPILED: CompiledSpec[] = SPECS.map((s, order) => ({
  field: s.field,
  order,
  names: s.names.map((n) => words(normalizeHeaderText(n))),
  exact: new Set((s.exact ?? []).map((n) => words(normalizeHeaderText(n)).key)),
  not: (s.not ?? []).map((n) => normalizeHeaderText(n).split(' ').filter(Boolean)),
}));

/** Headers that describe year-to-date totals or tax setup, never this week's pay. */
const IGNORED_PHRASES = ['ytd', 'year to date', 'qtd', 'quarter to date', 'exemptions', 'allowances'].map((p) => p.split(' '));

const ACCEPT = 0.6;

function scoreField(spec: CompiledSpec, header: Words): number {
  if (!header.key) return 0;
  let best = 0;
  for (const n of spec.names) if (n.key === header.key) return 1;
  if (spec.exact.has(header.key)) best = 0.85;
  if (spec.not.some((p) => hasPhrase(header.tokens, p))) return best;
  for (const n of spec.names) {
    if (n.content.length === 0 || !n.content.every((t) => header.contentSet.has(t))) continue;
    best = Math.max(best, Math.min(0.95, 0.5 + 0.45 * (n.content.length / header.content.length)));
  }
  return best;
}

// ---------------------------------------------------------------------------
// Header cells (one or two header rows)
// ---------------------------------------------------------------------------

export interface HeaderCell {
  /** Header wording as displayed; a two-row header joins group and column text. */
  text: string;
  /** Raw cell values that make up the header, top row first (dates stay Date objects). */
  parts: unknown[];
}

export function headerCellsFromRow(row: readonly unknown[]): HeaderCell[] {
  return Array.from(row, (v) => ({ text: cellText(v), parts: cellText(v) ? [v] : [] }));
}

/**
 * Combine a group-header row with the column-header row below it, as in the
 * WH-347 ("Deductions" over "FICA | Withholding tax | Other | Total"). A group
 * label carries right across merged (blank) cells while the lower row continues.
 */
export function combineHeaderRows(top: readonly unknown[], sub: readonly unknown[]): HeaderCell[] {
  const width = Math.max(top.length, sub.length);
  const cells: HeaderCell[] = [];
  let carry: unknown = null;
  for (let c = 0; c < width; c++) {
    const t = top[c];
    const s = sub[c];
    const hasT = cellText(t) !== '';
    const hasS = cellText(s) !== '';
    if (hasT) carry = hasS ? t : null;
    else if (!hasS) carry = null;
    const parts = hasT ? (hasS ? [t, s] : [t]) : hasS ? (carry !== null ? [carry, s] : [s]) : [];
    cells.push({ text: parts.map(cellText).join(' '), parts });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Daily hours columns
// ---------------------------------------------------------------------------

export interface DayColumns {
  /** Header text of each of the seven day columns, in order. */
  labels: string[];
  /** Calendar date of each day when the headers carry full dates. */
  dates: (ISODate | null)[];
}

type Qualifier = 'st' | 'ot' | null;

interface DayHeader {
  col: number;
  qualifier: Qualifier;
  dows: number[] | null;
  date: { y: number | null; m: number; d: number } | null;
  index: number | null;
  dom: number | null;
  label: string;
}

const WEEKDAY_TOKENS: Record<string, number[]> = {
  su: [0], sun: [0], sunday: [0],
  m: [1], mo: [1], mon: [1], monday: [1],
  t: [2, 4], tu: [2], tue: [2], tues: [2], tuesday: [2],
  w: [3], we: [3], wed: [3], weds: [3], wednesday: [3],
  th: [4], r: [4], thu: [4], thur: [4], thurs: [4], thursday: [4],
  f: [5], fr: [5], fri: [5], friday: [5],
  s: [6, 0], sa: [6], sat: [6], saturday: [6],
};
const DAY_FILLER = new Set(['hours', 'hrs', 'hour', 'hr', 'day', 'days', 'date', 'dates', 'worked', 'each', 'and', 'daily', 'of', 'the', 'time', 'on', 'in', 'for']);
const ST_WORDS = new Set(['st', 'reg', 'regular', 'straight']);
const OT_WORDS = new Set(['ot', 'overtime', 'over']);
const DATE_IN_TEXT = /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/;

function classifyDayHeader(cell: HeaderCell, col: number): DayHeader | null {
  if (!cell.text) return null;
  let date: DayHeader['date'] = null;
  const texts: string[] = [];
  for (const part of cell.parts) {
    if (part instanceof Date || (typeof part === 'number' && part > 20000 && part < 80000)) {
      const iso = part instanceof Date ? cellDate(part) : parseDateLoose(part);
      if (iso) date = { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
      continue;
    }
    let s = cellText(part);
    const m = DATE_IN_TEXT.exec(s);
    if (m) {
      if (m[1]) date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
      else {
        let y: number | null = m[6] ? Number(m[6]) : null;
        if (y !== null && y < 100) y += 2000;
        date = { y, m: Number(m[4]), d: Number(m[5]) };
      }
      if (date.m < 1 || date.m > 12 || date.d < 1 || date.d > 31) return null;
      s = s.replace(m[0], ' ');
    }
    texts.push(s);
  }
  const normalized = texts.map((t) => normalizeHeaderText(t)).join(' ');
  let index: number | null = null;
  const idx = /\b(?:day\s*|d)([1-7])\b/.exec(normalized);
  let rest = normalized;
  if (idx) {
    index = Number(idx[1]);
    rest = rest.replace(idx[0], ' ');
  }
  let tokens = rest.split(' ').filter(Boolean);
  const hasST = tokens.some((t) => ST_WORDS.has(t));
  const hasOT = tokens.some((t) => OT_WORDS.has(t));
  if (hasST && hasOT) return null;
  const qualifier: Qualifier = hasST ? 'st' : hasOT ? 'ot' : null;
  tokens = tokens.filter((t) => !ST_WORDS.has(t) && !OT_WORDS.has(t) && !DAY_FILLER.has(t));
  const weekdayTokens = tokens.filter((t) => t in WEEKDAY_TOKENS);
  const numbers = tokens.filter((t) => /^\d{1,2}$/.test(t));
  if (tokens.length !== weekdayTokens.length + numbers.length || weekdayTokens.length > 1 || numbers.length > 1) return null;
  const dows = weekdayTokens[0] ? WEEKDAY_TOKENS[weekdayTokens[0]]! : null;
  const n = numbers[0] !== undefined ? Number(numbers[0]) : null;
  const dom = n !== null && n >= 1 && n <= 31 ? n : null;
  if (n !== null && dom === null) return null;
  if (!dows && !date && index === null && dom === null) return null;
  return { col, qualifier, dows, date, index, dom, label: cell.text };
}

function isDaySequence(run: readonly DayHeader[]): boolean {
  if (run.every((h) => h.dows)) {
    for (let start = 0; start < 7; start++) {
      if (run.every((h, i) => h.dows!.includes((start + i) % 7))) return true;
    }
  }
  if (run.every((h) => h.date)) {
    let prev: number | null = null;
    let ok = true;
    for (const h of run) {
      const y = h.date!.y ?? 2024;
      let t = Date.UTC(y, h.date!.m - 1, h.date!.d);
      if (prev !== null && h.date!.y === null && t < prev) t = Date.UTC(y + 1, h.date!.m - 1, h.date!.d);
      if (prev !== null && t - prev !== 86_400_000) ok = false;
      prev = t;
    }
    if (ok) return true;
  }
  if (run.every((h, i) => h.index === i + 1)) return true;
  if (run.every((h) => h.dom !== null)) {
    return run.every((h, i) => i === 0 || h.dom === run[i - 1]!.dom! + 1 || (h.dom === 1 && run[i - 1]!.dom! >= 28));
  }
  return false;
}

function findDayRuns(headers: readonly DayHeader[]): DayHeader[][] {
  const runs: DayHeader[][] = [];
  let i = 0;
  while (i + 7 <= headers.length) {
    const run = headers.slice(i, i + 7);
    const compact = run.every((h, k) => k === 0 || h.col - run[k - 1]!.col <= 3);
    if (compact && isDaySequence(run)) {
      runs.push(run);
      i += 7;
    } else i++;
  }
  return runs;
}

function dayConfidence(run: readonly DayHeader[]): number {
  if (run.every((h) => h.index !== null)) return 0.95;
  if (run.every((h) => h.dows && h.dows.length === 1)) return 0.95;
  if (run.every((h) => h.dows || h.date)) return 0.9;
  return 0.7;
}

function isoOf(h: DayHeader): ISODate | null {
  if (!h.date || h.date.y === null) return null;
  return parseDateLoose(`${h.date.y}-${h.date.m}-${h.date.d}`);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface ColumnDetection {
  columnMap: ColumnMap;
  confidence: FieldConfidence;
  /** 0..1: how much the row reads like a payroll header. 0 without worker identity and hours or pay columns. */
  score: number;
  /** Unbounded version of `score`, for comparing candidate header rows. */
  strength: number;
  /** Header text per column. */
  headers: string[];
  days: DayColumns | null;
  /** Observations about the layout worth showing the reviewer. */
  notes: string[];
}

const WEIGHTS: Partial<Record<PayrollField, number>> = {
  workerName: 3, lastName: 2, firstName: 1, workerId: 1.5, classification: 2, apprenticeFlag: 1, rowType: 1,
  totalST: 2, totalOT: 1, totalDT: 0.5, totalHours: 2, rateST: 2, rateOT: 1, stPay: 1, otPay: 1,
  fringePlanHourly: 1, fringeCashHourly: 1, fringePlanAmount: 0.5, fringeCashAmount: 0.5,
  grossPay: 1.5, grossThisProject: 1.5, grossAllWork: 1, deductionsTotal: 1, netPay: 1,
  dedFica: 0.5, dedSocialSecurity: 0.5, dedMedicare: 0.5, dedFederal: 0.5, dedState: 0.5, dedOther: 0.3,
  weekEnding: 0.25, payrollNumber: 0.25, contractorName: 0.25, projectName: 0.25,
};
const DAY_WEIGHT = 0.3;
const IDEAL_STRENGTH = 12;

/** Detect the column mapping for a single header row. */
export function detectColumns(headers: readonly unknown[]): ColumnDetection {
  return detectHeaderCells(headerCellsFromRow(headers));
}

/** Detect the column mapping for header cells (one row, or two rows combined with `combineHeaderRows`). */
export function detectHeaderCells(cells: readonly HeaderCell[]): ColumnDetection {
  const columnMap: ColumnMap = {};
  const confidence: FieldConfidence = {};
  const notes: string[] = [];
  const taken = new Set<number>();
  const assign = (field: SingleColumnField, col: number, conf: number) => {
    columnMap[field] = col;
    confidence[field] = Math.round(conf * 100) / 100;
    taken.add(col);
  };

  // Daily hours first: their headers are weekday names, dates or "Day 1".
  const dayHeaders = cells.map((c, i) => classifyDayHeader(c, i)).filter((h): h is DayHeader => h !== null);
  const runsBy = (q: Qualifier) => findDayRuns(dayHeaders.filter((h) => h.qualifier === q));
  const plain = runsBy(null);
  const st = runsBy('st');
  const ot = runsBy('ot');
  const place = (prefix: 'day' | 'st' | 'ot', run: DayHeader[], conf: number) =>
    run.forEach((h, i) => assign(`${prefix}${(i + 1) as DayNumber}`, h.col, conf));
  if (plain[0]) place('day', plain[0], dayConfidence(plain[0]));
  if (st[0]) place('st', st[0], dayConfidence(st[0]));
  if (ot[0]) place('ot', ot[0], dayConfidence(ot[0]));
  else if (plain[1]) {
    place('ot', plain[1], 0.6);
    notes.push('Two blocks of daily hours were found; the second block was read as overtime hours.');
  }
  if (plain.length > (ot[0] ? 1 : 2) || st.length > 1 || ot.length > 1) {
    notes.push('More than seven days of daily hours were found; only the first week was mapped. Certified payrolls cover one workweek each.');
  }
  const primary = plain[0] ?? st[0] ?? ot[0] ?? null;
  const days: DayColumns | null = primary ? { labels: primary.map((h) => h.label), dates: primary.map(isoOf) } : null;

  // Everything else: best-scoring (field, column) pairs first.
  const headerWords = cells.map((c) => words(c.parts.map((p) => normalizeHeaderText(p)).join(' ')));
  const candidates: { field: SynonymField; col: number; score: number; order: number }[] = [];
  headerWords.forEach((w, col) => {
    if (taken.has(col) || !w.key || IGNORED_PHRASES.some((p) => hasPhrase(w.tokens, p))) return;
    for (const spec of COMPILED) {
      const score = scoreField(spec, w);
      if (score >= ACCEPT) candidates.push({ field: spec.field, col, score, order: spec.order });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.order - b.order || a.col - b.col);
  for (const c of candidates) {
    if (taken.has(c.col)) continue;
    if (c.field === 'dedOther') {
      columnMap.dedOther = [...(columnMap.dedOther ?? []), c.col];
      confidence.dedOther = Math.min(confidence.dedOther ?? 1, Math.round(c.score * 100) / 100);
      taken.add(c.col);
      continue;
    }
    if (columnMap[c.field] !== undefined) continue;
    assign(c.field, c.col, c.score);
  }
  columnMap.dedOther?.sort((a, b) => a - b);

  const strength = computeStrength(columnMap, confidence);
  return {
    columnMap,
    confidence,
    score: Math.round(Math.min(1, strength / IDEAL_STRENGTH) * 100) / 100,
    strength,
    headers: cells.map((c) => c.text),
    days,
    notes,
  };
}

function computeStrength(map: ColumnMap, confidence: FieldConfidence): number {
  const has = (f: PayrollField) => (f === 'dedOther' ? (map.dedOther?.length ?? 0) > 0 : map[f as SingleColumnField] !== undefined);
  const identity = has('workerName') || has('lastName') || has('workerId');
  const dayMapped = DAY_NUMBERS.some((n) => has(`day${n}`) || has(`st${n}`) || has(`ot${n}`));
  const work = dayMapped || (['totalST', 'totalOT', 'totalHours', 'rateST', 'stPay', 'grossPay', 'grossThisProject'] as const).some(has);
  if (!identity || !work) return 0;
  let total = 0;
  for (const [field, conf] of Object.entries(confidence) as [PayrollField, number][]) {
    total += (WEIGHTS[field] ?? DAY_WEIGHT) * conf;
  }
  return Math.round(total * 100) / 100;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * A stable key for a header layout, so a reviewer's confirmed mapping can be reused
 * for the same contractor's next file. Case, spacing, punctuation and the dates in
 * daily-hours headers (which change every week) do not affect it.
 */
export function headerSignature(headers: readonly unknown[]): string {
  const keys = headers.map(signatureToken);
  while (keys.length > 0 && keys[keys.length - 1] === '') keys.pop();
  return `h1-${keys.length}-${fnv1a(keys.join('|'))}`;
}

function signatureToken(value: unknown): string {
  if (value instanceof Date) return 'date';
  if (typeof value === 'number') return value > 20000 && value < 80000 ? 'date' : 'num';
  const text = cellText(value).replace(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?/g, ' date ');
  const normalized = normalizeHeaderText(text);
  return /^\d+$/.test(normalized) ? 'num' : normalized;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
