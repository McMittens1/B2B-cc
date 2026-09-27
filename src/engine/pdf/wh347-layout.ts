/**
 * Geometry of the official WH-347 (Rev. January 2025) form, measured from the
 * ruled lines and labels of public/forms/wh347-rev2025.pdf. All values are PDF
 * points on the 792 × 612 landscape page with the origin at the bottom-left.
 *
 * The filler draws into these boxes directly. The parser maps them onto each
 * page it reads through the label anchors below, so payrolls printed with a
 * small offset or scale still line up.
 */

export interface Range {
  x0: number;
  x1: number;
}

export interface Box extends Range {
  /** Bottom edge. */
  y0: number;
  /** Top edge. */
  y1: number;
}

/** A checkbox glyph printed on the form: its left edge, baseline and glyph size. */
export interface CheckboxSpot {
  x: number;
  y: number;
  size: number;
}

/** A label printed on the form and where it sits on the blank form. */
export interface Anchor {
  label: string;
  x: number;
  y: number;
}

export const FORM_WIDTH = 792;
export const FORM_HEIGHT = 612;

const box = (x0: number, x1: number, y0: number, y1: number): Box => ({ x0, x1, y0, y1 });

// ---------------------------------------------------------------------------
// Page 1: payroll sheet

export const PAGE1_HEADER = {
  projectName: box(41.8, 194.9, 460.7, 479.2),
  projectNumber: box(196.3, 340.7, 460.7, 479.2),
  payrollNumber: box(342.1, 438.8, 460.7, 479.2),
  businessName: box(440.3, 751.3, 460.7, 479.2),
  projectLocation: box(41.8, 194.9, 428.4, 447.7),
  wdNumber: box(196.3, 340.7, 428.4, 447.7),
  weekEnding: box(342.1, 438.8, 428.4, 447.7),
  businessAddress: box(440.3, 751.3, 428.4, 447.7),
} as const;

export type Page1HeaderField = keyof typeof PAGE1_HEADER;

export const PAGE1_CHECKBOXES = {
  final: { x: 40.4, y: 503.4, size: 9 },
  prime: { x: 432.0, y: 503.4, size: 9 },
  subcontractor: { x: 576.0, y: 503.4, size: 9 },
} as const satisfies Record<string, CheckboxSpot>;

/** Data columns of the worker table. Names follow PayrollLine where one exists. */
export const PAGE1_COLUMNS = {
  entryNo: { x0: 40.3, x1: 65.6 },
  lastName: { x0: 65.6, x1: 115.7 },
  firstName: { x0: 115.7, x1: 165.4 },
  middleInitial: { x0: 165.4, x1: 191.0 },
  workerId: { x0: 191.0, x1: 221.0 },
  journeyApprentice: { x0: 221.0, x1: 256.0 },
  classification: { x0: 256.0, x1: 300.4 },
  day0: { x0: 341.2, x1: 355.3 },
  day1: { x0: 355.3, x1: 367.6 },
  day2: { x0: 367.6, x1: 379.9 },
  day3: { x0: 379.9, x1: 392.3 },
  day4: { x0: 392.3, x1: 404.6 },
  day5: { x0: 404.6, x1: 417.0 },
  day6: { x0: 417.0, x1: 430.2 },
  totalHours: { x0: 430.2, x1: 457.0 },
  rate: { x0: 469.3, x1: 497.9 },
  fringePlanHourly: { x0: 497.9, x1: 524.2 },
  fringeCashHourly: { x0: 524.2, x1: 550.6 },
  grossThisProject: { x0: 550.6, x1: 577.0 },
  grossAllWork: { x0: 577.0, x1: 604.4 },
  taxWithholdings: { x0: 604.4, x1: 631.3 },
  fica: { x0: 631.3, x1: 658.2 },
  otherDeductions: { x0: 658.2, x1: 689.2 },
  deductions: { x0: 689.2, x1: 712.6 },
  netPay: { x0: 712.6, x1: 751.3 },
} as const satisfies Record<string, Range>;

export type Page1Column = keyof typeof PAGE1_COLUMNS;

export const DAY_COLUMNS = ['day0', 'day1', 'day2', 'day3', 'day4', 'day5', 'day6'] as const satisfies readonly Page1Column[];

/** Columns split into a straight-time (upper) and overtime (lower) row; the rest span the worker's slot. */
export const SPLIT_COLUMNS: ReadonlySet<Page1Column> = new Set<Page1Column>([...DAY_COLUMNS, 'totalHours', 'rate']);

/** Header rows of column (4): day of week above, date below. */
export const DAY_HEADER_ROWS = {
  names: { y0: 376.2, y1: 389.6 },
  dates: { y0: 362.2, y1: 375.7 },
} as const;

/** Worker slots, top to bottom: slot top, ST/OT dividing line, slot bottom. */
export const PAGE1_SLOTS: readonly { top: number; mid: number; bottom: number }[] = [
  { top: 329.7, mid: 316.3, bottom: 301.2 },
  { top: 301.2, mid: 287.8, bottom: 273.2 },
  { top: 273.2, mid: 260.3, bottom: 245.3 },
  { top: 245.3, mid: 231.4, bottom: 216.4 },
  { top: 216.4, mid: 202.4, bottom: 187.4 },
  { top: 187.4, mid: 173.5, bottom: 159.6 },
  { top: 159.6, mid: 145.7, bottom: 131.8 },
  { top: 131.8, mid: 117.7, bottom: 102.8 },
];

export const WORKERS_PER_SHEET = PAGE1_SLOTS.length;

/** The ST/OT row labels printed in each slot (x of the labels, baselines of ST and OT). */
export const STOT_LABEL_X = 316.7;
export const STOT_LABEL_BASELINES: readonly { st: number; ot: number }[] = [
  { st: 321.0, ot: 307.7 },
  { st: 292.7, ot: 279.2 },
  { st: 264.7, ot: 251.6 },
  { st: 236.8, ot: 222.7 },
  { st: 207.8, ot: 193.8 },
  { st: 178.9, ot: 165.0 },
  { st: 151.0, ot: 137.0 },
  { st: 123.1, ot: 109.2 },
];

export const PAGE1_ANCHORS: readonly Anchor[] = [
  { label: 'PROJECT NAME', x: 46.4, y: 482.0 },
  { label: 'PROJECT NO. or CONTRACT NO.', x: 201.0, y: 482.0 },
  { label: 'CERTIFIED PAYROLL NO.', x: 346.8, y: 482.0 },
  { label: "PRIME CONTRACTOR'S/SUBCONTRACTOR'S BUSINESS NAME", x: 444.8, y: 482.0 },
  { label: 'PROJECT LOCATION', x: 46.4, y: 450.6 },
  { label: 'WAGE DETERMINATION NO.', x: 201.0, y: 450.6 },
  { label: 'WEEK ENDING DATE', x: 346.8, y: 450.6 },
  { label: "PRIME CONTRACTOR'S/SUBCONTRACTOR'S BUSINESS ADDRESS", x: 444.8, y: 450.6 },
  { label: '(1A)', x: 46.7, y: 419.4 },
  { label: '(1B)', x: 84.2, y: 419.4 },
  { label: '(1C)', x: 134.2, y: 419.4 },
  { label: '(1D)', x: 171.5, y: 419.4 },
  { label: '(1E)', x: 199.8, y: 419.4 },
  { label: '(2)', x: 234.4, y: 419.4 },
  { label: '(3)', x: 274.0, y: 419.4 },
  { label: '(4)', x: 367.0, y: 419.4 },
  { label: '(5)', x: 439.2, y: 419.4 },
  { label: '(6A)', x: 477.0, y: 419.4 },
  { label: '(6B)', x: 504.7, y: 419.4 },
  { label: '(6C)', x: 531.0, y: 419.4 },
  { label: '(7A)', x: 557.3, y: 419.4 },
  { label: '(7B)', x: 584.3, y: 419.4 },
  { label: '(8)', x: 654.2, y: 419.4 },
  { label: '(9)', x: 727.8, y: 419.4 },
];

// ---------------------------------------------------------------------------
// Page 2: Statement of Compliance

export const PAGE2_HEADER = {
  projectName: box(32.2, 237.8, 547.7, 567.5),
  projectNumber: box(237.8, 377.3, 547.7, 567.5),
  payrollNumber: box(377.3, 471.8, 547.7, 567.5),
  businessName: box(471.8, 759.8, 547.7, 567.5),
  projectLocation: box(32.2, 377.3, 515.4, 536.2),
  weekEnding: box(377.3, 471.8, 515.4, 536.2),
  certifyingOfficial: box(471.8, 759.8, 515.4, 536.2),
} as const;

export type Page2HeaderField = keyof typeof PAGE2_HEADER;

export const STATEMENT_KEYS = [
  'correctAndComplete',
  'recordsComplete',
  'classificationsAccurate',
  'apprenticesRegistered',
  'fringeBenefitsPaid',
  'fullWagesPaid',
] as const;

export type StatementKey = (typeof STATEMENT_KEYS)[number];

export const STATEMENT_CHECKBOXES: Record<StatementKey, CheckboxSpot> = {
  correctAndComplete: { x: 38.2, y: 479.6, size: 9 },
  recordsComplete: { x: 38.2, y: 448.8, size: 9 },
  classificationsAccurate: { x: 38.2, y: 428.6, size: 9 },
  apprenticesRegistered: { x: 38.2, y: 405.0, size: 9 },
  fringeBenefitsPaid: { x: 38.2, y: 320.2, size: 9 },
  fullWagesPaid: { x: 38.2, y: 132.5, size: 9 },
};

export const APPRENTICE_ROWS: readonly {
  name: Box;
  classification: Box;
  oa: CheckboxSpot;
  saa: CheckboxSpot;
}[] = [
  { y0: 361.3, y1: 373.9, base: 365.2 },
  { y0: 349.8, y1: 361.3, base: 353.2 },
  { y0: 338.3, y1: 349.8, base: 341.6 },
].map((r) => ({
  name: box(54.2, 377.8, r.y0, r.y1),
  classification: box(472.3, 759.8, r.y0, r.y1),
  oa: { x: 383.4, y: r.base, size: 8 },
  saa: { x: 432.8, y: r.base, size: 8 },
}));

/** Left edge of each of the six fringe benefit plan column groups. */
const PLAN_STARTS = [143.5, 238.1, 332.5, 427.1, 521.5, 616.1] as const;

export const FRINGE_PLAN_COUNT = PLAN_STARTS.length;

export const FRINGE_PLAN_COLUMNS: readonly {
  name: Box;
  type: Box;
  planNumber: Box;
  funded: CheckboxSpot;
  unfunded: CheckboxSpot;
  /** Hourly credit cell, right of the printed "$". */
  credit: Range;
}[] = PLAN_STARTS.map((s) => ({
  name: box(s + 40.6, s + 94.6, 273.6, 284.9),
  type: box(s + 40.6, s + 94.6, 261.1, 273.1),
  planNumber: box(s + 40.6, s + 94.6, 249.2, 261.1),
  funded: { x: s + 5.9, y: 242.5, size: 7 },
  unfunded: { x: s + 50.9, y: 242.5, size: 7 },
  credit: { x0: s + 56.5, x1: s + 94.6 },
}));

export const FRINGE_WORKER_NAME: Range = { x0: 54.2, x1: 143.5 };
export const FRINGE_TOTAL_CREDIT: Range = { x0: 722.0, x1: 759.8 };

/** Worker rows of the fringe benefit table, top to bottom. */
export const FRINGE_ROWS: readonly { y0: number; y1: number }[] = [
  { y0: 228.1, y1: 239.6 },
  { y0: 216.6, y1: 228.1 },
  { y0: 205.2, y1: 216.6 },
  { y0: 193.7, y1: 205.2 },
  { y0: 182.2, y1: 193.7 },
  { y0: 170.8, y1: 182.2 },
  { y0: 159.2, y1: 170.8 },
  { y0: 147.7, y1: 159.2 },
];

export const FRINGE_ROWS_PER_PAGE = FRINGE_ROWS.length;

export const PAGE2_REMARKS = box(32.2, 759.8, 84.2, 108.2);

export const PAGE2_SIGNATURE_ROW = {
  signature: box(32.2, 377.3, 54.6, 71.5),
  date: box(377.3, 471.8, 54.6, 71.5),
  phone: box(471.8, 615.8, 54.6, 71.5),
  email: box(615.8, 759.8, 54.6, 71.5),
} as const;

export const PAGE2_ANCHORS: readonly Anchor[] = [
  { label: 'PROJECT NAME', x: 36.8, y: 570.4 },
  { label: 'PROJECT NO. or CONTRACT NO.', x: 243.8, y: 570.4 },
  { label: 'PAYROLL NO.', x: 383.4, y: 570.4 },
  { label: "PRIME CONTRACTOR'S/SUBCONTRACTOR'S BUSINESS NAME", x: 477.8, y: 570.4 },
  { label: 'PROJECT LOCATION', x: 36.8, y: 539.0 },
  { label: 'WEEK ENDING DATE', x: 383.4, y: 539.0 },
  { label: "CERTIFYING OFFICIAL'S NAME AND TITLE", x: 477.8, y: 539.0 },
  { label: 'APPRENTICESHIP PROGRAM NAME', x: 59.4, y: 376.8 },
  { label: 'NAME OF LABOR CLASSIFICATION', x: 477.8, y: 376.8 },
  { label: 'HOURLY CREDIT FOR FRINGE BENEFITS', x: 335.6, y: 301.1 },
  { label: 'NAME OF WORKER', x: 67.9, y: 260.0 },
  { label: 'ADDITIONAL REMARKS', x: 36.8, y: 112.0 },
  { label: 'SIGNATURE OF CERTIFYING OFFICIAL', x: 36.8, y: 75.0 },
  { label: 'DATE', x: 383.4, y: 75.0 },
  { label: 'TELEPHONE NUMBER', x: 477.8, y: 75.0 },
  { label: 'EMAIL ADDRESS', x: 621.8, y: 75.0 },
];

/** Where the vertical middle of a checkbox glyph sits relative to its baseline, as a fraction of its size. */
export const CHECKBOX_CENTER_RISE = 0.37;
