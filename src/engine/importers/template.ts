import { DAY_NUMBERS, type ColumnMap, type PayrollField, type SingleColumnField } from './columns';

/**
 * The Wagebench payroll template: a spreadsheet layout reviewers can send to
 * subcontractors that carries everything on the WH-347 and maps 1:1 onto the
 * importer's fields, so no column mapping is needed when it comes back.
 */

export interface TemplateColumn {
  header: string;
  field: PayrollField;
  example: string;
  help: string;
}

const EXAMPLE_ST = ['0', '8', '8', '8', '8', '8', '0'];
const EXAMPLE_OT = ['0', '0', '0', '0', '2', '0', '0'];

export const TEMPLATE_COLUMNS: readonly TemplateColumn[] = [
  { header: 'Week Ending', field: 'weekEnding', example: '6/13/2026', help: 'Last day of the payroll week (m/d/yyyy).' },
  { header: 'Payroll No.', field: 'payrollNumber', example: '7', help: 'Payroll number; start at 1 and number each week in sequence.' },
  { header: 'Contractor', field: 'contractorName', example: 'Cedar Hollow Framing LLC', help: 'Your company name.' },
  { header: 'Project', field: 'projectName', example: 'Linden Street Senior Housing', help: 'Project name or number.' },
  { header: 'Worker Name', field: 'workerName', example: 'Rivera, Ana L', help: 'Last, First Middle.' },
  { header: 'ID (Last 4)', field: 'workerId', example: '0427', help: 'Last four digits of the SSN or an employee ID. Never the full SSN.' },
  { header: 'Classification', field: 'classification', example: 'Carpenter', help: 'Labor classification as listed on the wage determination.' },
  { header: 'J/A', field: 'apprenticeFlag', example: 'J', help: 'J for journeyworker, A for a registered apprentice.' },
  ...DAY_NUMBERS.map((n, i) => ({
    header: `ST Day ${n}`,
    field: `st${n}` as PayrollField,
    example: EXAMPLE_ST[i]!,
    help: n === 1 ? 'Straight-time hours worked each day; Day 1 is the first day of the workweek, Day 7 the week ending date.' : '',
  })),
  ...DAY_NUMBERS.map((n, i) => ({
    header: `OT Day ${n}`,
    field: `ot${n}` as PayrollField,
    example: EXAMPLE_OT[i]!,
    help: n === 1 ? 'Overtime hours worked each day.' : '',
  })),
  { header: 'Total ST Hours', field: 'totalST', example: '40', help: 'Straight-time hours for the week.' },
  { header: 'Total OT Hours', field: 'totalOT', example: '2', help: 'Overtime hours for the week.' },
  { header: 'ST Rate', field: 'rateST', example: '31.50', help: 'Basic hourly rate paid.' },
  { header: 'OT Rate', field: 'rateOT', example: '47.25', help: 'Overtime hourly rate paid.' },
  { header: 'Fringe to Plans per Hour', field: 'fringePlanHourly', example: '12.40', help: 'Hourly credit for contributions to bona fide fringe benefit plans.' },
  { header: 'Fringe in Cash per Hour', field: 'fringeCashHourly', example: '0.00', help: 'Hourly fringe benefits paid to the worker in cash.' },
  { header: 'Gross This Project', field: 'grossThisProject', example: '1354.50', help: 'Gross wages earned on this project.' },
  { header: 'Gross All Work', field: 'grossAllWork', example: '1354.50', help: 'Gross wages for all work this week, on every project.' },
  { header: 'FICA', field: 'dedFica', example: '103.62', help: 'Social Security and Medicare withheld.' },
  { header: 'Federal Withholding', field: 'dedFederal', example: '120.00', help: 'Federal income tax withheld.' },
  { header: 'State Withholding', field: 'dedState', example: '45.00', help: 'State income tax withheld.' },
  { header: 'Other Deductions', field: 'dedOther', example: '0.00', help: 'All other deductions (itemize them on the payroll if requested).' },
  { header: 'Total Deductions', field: 'deductionsTotal', example: '268.62', help: 'Sum of all deductions.' },
  { header: 'Net Pay', field: 'netPay', example: '1085.88', help: 'Net wages paid for the week.' },
];

/** The template as CSV: the header row and one example row. */
export function templateCsv(): string {
  const rows = [TEMPLATE_COLUMNS.map((c) => c.header), TEMPLATE_COLUMNS.map((c) => c.example)];
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** The column mapping for a file laid out exactly like the template. */
export function templateColumnMap(): ColumnMap {
  const map: ColumnMap = {};
  TEMPLATE_COLUMNS.forEach((c, i) => {
    if (c.field === 'dedOther') map.dedOther = [...(map.dedOther ?? []), i];
    else map[c.field as SingleColumnField] = i;
  });
  return map;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
