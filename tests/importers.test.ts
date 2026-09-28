import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  combineHeaderRows,
  detectColumns,
  detectHeaderCells,
  headerSignature,
  importPayrollTable,
  parseApprenticeFlag,
  parseCsvText,
  parsePersonName,
  displayName,
  splitNameAndId,
  stripApprentice,
  type ColumnMap,
  type ImportTableOptions,
} from '../src/engine/importers';
import { cellDate, findDates, parseNumberCell } from '../src/engine/importers/cells';
import type { PayrollLine } from '../src/engine/types';

function importCsv(csv: string, opts: ImportTableOptions = {}) {
  let n = 0;
  return importPayrollTable(parseCsvText(csv), { idFactory: () => `L${++n}`, ...opts });
}

function fixture(name: string) {
  return importCsv(fs.readFileSync(`fixtures/payrolls/${name}`, 'utf8'));
}

const byName = (lines: PayrollLine[], name: string) => {
  const line = lines.find((l) => l.workerName === name);
  if (!line) throw new Error(`no line for ${name}; have ${lines.map((l) => l.workerName).join(', ')}`);
  return line;
};

// ---------------------------------------------------------------------------

describe('detectColumns', () => {
  it('maps register-export wording (QuickBooks, Foundation, Sage)', () => {
    const d = detectColumns([
      'Employee', 'SSN (last 4)', 'Work Class', 'Regular Hours', 'Overtime Hours', 'Reg Rate', 'OT Rate',
      'Gross Pay', 'Fed W/H', 'Social Security', 'Medicare', 'State W/H', 'Total Deductions', 'Net Pay',
    ]);
    expect(d.columnMap).toEqual({
      workerName: 0, workerId: 1, classification: 2, totalST: 3, totalOT: 4, rateST: 5, rateOT: 6,
      grossPay: 7, dedFederal: 8, dedSocialSecurity: 9, dedMedicare: 10, dedState: 11, deductionsTotal: 12, netPay: 13,
    });
    for (const conf of Object.values(d.confidence)) expect(conf).toBe(1);
    expect(d.score).toBe(1);
  });

  it('maps ADP/Paychex wording including several other-deduction columns', () => {
    const d = detectColumns([
      'Co Code', 'File #', 'Employee Name', 'Craft', 'Pay Rate', 'Reg Hrs', 'O/T Hrs', 'Reg Earnings', 'O/T Earnings',
      'Gross Wages', 'Federal Income Tax', 'FICA', 'State Income Tax', 'Local Tax', 'Union Dues', '401(k)', 'Net Check',
      'Period End Date', 'Emp ID',
    ]);
    const m = d.columnMap;
    expect(m.workerId).toBe(1);
    expect(m.workerName).toBe(2);
    expect(m.classification).toBe(3);
    expect(m.rateST).toBe(4);
    expect(m.totalST).toBe(5);
    expect(m.totalOT).toBe(6);
    expect(m.stPay).toBe(7);
    expect(m.otPay).toBe(8);
    expect(m.grossPay).toBe(9);
    expect(m.dedFederal).toBe(10);
    expect(m.dedFica).toBe(11);
    expect(m.dedState).toBe(12);
    expect(m.dedOther).toEqual([13, 14, 15]);
    expect(m.netPay).toBe(16);
    expect(m.weekEnding).toBe(17);
    expect(m.contractorName).toBeUndefined();
  });

  it('maps the Rev. January 2025 WH-347 wording with daily ST and OT per weekday', () => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].flatMap((d) => [`${d} ST`, `${d} OT`]);
    const d = detectColumns([
      'Worker Name', 'Identifying Number', 'J/A', 'Labor Classification', ...days, 'Total ST Hours', 'Total OT Hours',
      '6A Hourly Base Rate', '6B Hourly Fringe Benefit Credit for Plans', '6C Hourly Fringe Benefits Paid in Cash',
      '7A Gross Amount Earned This Project', '7B Gross Amount Earned All Work', 'Tax Withholdings', 'FICA',
      'Other Deductions', 'Total Deductions', 'Net Wages Paid',
    ]);
    const m = d.columnMap;
    expect([m.st1, m.st2, m.st7]).toEqual([4, 6, 16]);
    expect([m.ot1, m.ot2, m.ot7]).toEqual([5, 7, 17]);
    expect(m.day1).toBeUndefined();
    expect(m.apprenticeFlag).toBe(2);
    expect([m.totalST, m.totalOT, m.rateST]).toEqual([18, 19, 20]);
    expect(m.fringePlanHourly).toBe(21);
    expect(m.fringeCashHourly).toBe(22);
    expect(m.grossThisProject).toBe(23);
    expect(m.grossAllWork).toBe(24);
    expect(m.dedFederal).toBe(25);
    expect(m.dedFica).toBe(26);
    expect(m.dedOther).toEqual([27]);
    expect(m.deductionsTotal).toBe(28);
    expect(m.netPay).toBe(29);
    expect(d.score).toBe(1);
    expect(d.days?.labels).toEqual(['Sun ST', 'Mon ST', 'Tue ST', 'Wed ST', 'Thu ST', 'Fri ST', 'Sat ST']);
  });

  it('maps the 2008 WH-347 two-row header (group labels over column labels)', () => {
    const top = [
      '(1) Name and individual identifying number of worker', '(2) No. of withholding exemptions', '(3) Work classification',
      '(4) OT. or ST.', '(5) Day and date', '', '', '', '', '', '', '(6) Total hours', '(7) Rate of pay',
      '(8) Gross amount earned', '', '(9) Deductions', '', '', '', '(10) Net wages paid for week',
    ];
    const sub = ['', '', '', '', 'M 6/8', 'T 6/9', 'W 6/10', 'TH 6/11', 'F 6/12', 'S 6/13', 'S 6/14', '', '', 'This project', 'All work', 'FICA', 'Withholding tax', 'Other', 'Total deductions', ''];
    const d = detectHeaderCells(combineHeaderRows(top, sub));
    expect(d.columnMap).toEqual({
      workerName: 0, classification: 2, rowType: 3,
      day1: 4, day2: 5, day3: 6, day4: 7, day5: 8, day6: 9, day7: 10,
      totalHours: 11, rateST: 12, grossThisProject: 13, grossAllWork: 14,
      dedFica: 15, dedFederal: 16, dedOther: [17], deductionsTotal: 18, netPay: 19,
    });
    expect(d.days?.labels).toEqual(sub.slice(4, 11));
    expect(d.days?.monthDays[0]).toEqual({ month: 6, day: 8 });
    // The withholding-exemptions column must not become a deduction.
    expect(Object.values(d.columnMap).flat()).not.toContain(1);
    // One header row alone is a weaker match than both together.
    expect(detectColumns(top).strength).toBeLessThan(d.strength);
  });

  it('recognizes day columns written as single letters, dates, or Day 1..7', () => {
    const letters = detectColumns(['Name', 'M', 'T', 'W', 'TH', 'F', 'S', 'S', 'Total', 'Rate']);
    expect([letters.columnMap.day1, letters.columnMap.day7, letters.columnMap.totalHours]).toEqual([1, 7, 8]);

    const dates = detectColumns(['Employee', '6/7/2026', '6/8/2026', '6/9/2026', '6/10/2026', '6/11/2026', '6/12/2026', '6/13/2026', 'Hours', 'Rate']);
    expect(dates.columnMap.day1).toBe(1);
    expect(dates.days?.dates).toEqual(['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13']);

    const across = detectColumns(['Employee', '12/28', '12/29', '12/30', '12/31', '1/1', '1/2', '1/3', 'Rate']);
    expect(across.columnMap.day7).toBe(7);

    const numbered = detectColumns(['Employee', 'Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Rate']);
    expect(numbered.columnMap.day1).toBe(1);

    const regOt = detectColumns(['Employee', ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].flatMap((d) => [`${d} Reg`, `${d} O/T`]), 'Rate']);
    expect([regOt.columnMap.st1, regOt.columnMap.ot1, regOt.columnMap.ot7]).toEqual([1, 2, 14]);
  });

  it('does not treat a partial or out-of-order week as daily hours', () => {
    const fiveDays = detectColumns(['Employee', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Hours', 'Rate']);
    expect(fiveDays.columnMap.day1).toBeUndefined();
    expect(fiveDays.notes.join(' ')).toMatch(/not seven consecutive days/);
    const shuffled = detectColumns(['Employee', 'Mon', 'Wed', 'Tue', 'Thu', 'Fri', 'Sat', 'Sun', 'Rate']);
    expect(shuffled.columnMap.day1).toBeUndefined();
  });

  it('ignores year-to-date, exemption and employer-side columns', () => {
    const d = detectColumns(['Employee', 'Hours', 'Rate', 'Gross YTD', 'Federal W/H YTD', 'Exemptions', 'Employer Medicare', 'ER Social Security', 'Net Pay']);
    expect(d.columnMap).toEqual({ workerName: 0, totalHours: 1, rateST: 2, netPay: 8 });
  });

  it('keeps first/last name columns apart from the full-name field', () => {
    const d = detectColumns(['Employee Last Name', 'Employee First Name', 'MI', 'Employee ID', 'Hours', 'Rate']);
    expect(d.columnMap).toMatchObject({ lastName: 0, firstName: 1, middleName: 2, workerId: 3 });
    expect(d.columnMap.workerName).toBeUndefined();
  });

  it('scores unrelated headers as zero', () => {
    expect(detectColumns(['Invoice', 'Customer', 'Amount Due', 'Terms']).score).toBe(0);
    expect(detectColumns([]).score).toBe(0);
    expect(detectColumns([null, undefined, 42, true, {}]).score).toBe(0);
    // Worker identity alone is not a payroll header.
    expect(detectColumns(['Employee', 'Address', 'Phone']).score).toBe(0);
  });
});

describe('headerSignature', () => {
  const base = ['Employee', 'SSN (last 4)', 'Regular Hours', 'OT Hours', 'Rate'];

  it('ignores case, spacing, punctuation and trailing blank columns', () => {
    const sig = headerSignature(base);
    expect(headerSignature(['EMPLOYEE', ' SSN  last 4 ', 'regular   hours', 'OT hours', 'rate', '', null])).toBe(sig);
    expect(sig).toMatch(/^h1-5-[0-9a-f]{8}$/);
  });

  it('is unchanged when the dates in daily headers move to the next week', () => {
    const week1 = ['Name', 'Mon 6/8', 'Tue 6/9', 'Wed 6/10', 'Thu 6/11', 'Fri 6/12', 'Sat 6/13', 'Sun 6/14', 'Rate'];
    const week2 = ['Name', 'Mon 6/15', 'Tue 6/16', 'Wed 6/17', 'Thu 6/18', 'Fri 6/19', 'Sat 6/20', 'Sun 6/21', 'Rate'];
    expect(headerSignature(week1)).toBe(headerSignature(week2));
    expect(headerSignature(['Name', new Date(Date.UTC(2026, 5, 8)), 46181])).toBe(headerSignature(['Name', new Date(Date.UTC(2026, 5, 15)), 46188]));
  });

  it('changes when columns are added, removed or reordered', () => {
    const sig = headerSignature(base);
    expect(headerSignature([...base, 'Net Pay'])).not.toBe(sig);
    expect(headerSignature(base.slice(1))).not.toBe(sig);
    expect(headerSignature([base[1], base[0], ...base.slice(2)])).not.toBe(sig);
  });
});

// ---------------------------------------------------------------------------

describe('fixture layouts', () => {
  it('QuickBooks-style register: title lines above the header and a totals row', () => {
    const r = fixture('quickbooks-register.csv');
    expect(r.headerRowIndex).toBe(4);
    expect(r.headerRowCount).toBe(1);
    expect(r.lines).toHaveLength(3);
    expect(r.meta).toMatchObject({ contractorName: 'Ridgeline Concrete LLC', weekEnding: '2026-06-13', payrollNumber: null });

    expect(byName(r.lines, 'Marco T Alvarez')).toEqual({
      id: 'L1',
      workerName: 'Marco T Alvarez',
      workerId: '4821',
      classification: 'Cement Mason',
      apprentice: false,
      dailyST: [],
      dailyOT: [],
      totalST: 40,
      totalOT: 4,
      rateST: 31.25,
      rateOT: 46.88,
      fringePlanHourly: 0,
      fringeCashHourly: 0,
      grossThisProject: 1437.52,
      grossAllWork: 1437.52,
      deductions: 304.07,
      netPay: 1133.45,
    });
    const brennan = byName(r.lines, 'Sofia Brennan');
    expect(brennan.workerId).toBe('0317');
    expect(brennan.totalST).toBe(38.5);
    expect(brennan.totalOT).toBe(0);
    expect(brennan.rateOT).toBeNull();

    const okafor = byName(r.lines, 'Daniel Okafor');
    expect(okafor.apprentice).toBe(true);
    expect(okafor.classification).toBe('Cement Mason');

    expect(r.lineRows).toEqual({ L1: [6], L2: [7], L3: [8] });
    expect(r.warnings.some((w) => /single gross pay column/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /Row 9/.test(w))).toBe(false);
  });

  it('Gusto-style export: first/last name columns, OT pay instead of an OT rate', () => {
    const r = fixture('gusto-payroll.csv');
    expect(r.lines.map((l) => l.workerName)).toEqual(['Hanna Lindqvist', 'Thabo Mbeki', 'Rafael Castellanos']);
    const hanna = byName(r.lines, 'Hanna Lindqvist');
    expect(hanna).toMatchObject({ totalST: 40, totalOT: 5, rateST: 44, rateOT: 66, grossThisProject: 2090, deductions: 476.55, netPay: 1613.45 });
    const thabo = byName(r.lines, 'Thabo Mbeki');
    expect(thabo).toMatchObject({ apprentice: true, classification: 'Electrician', rateST: 26.4, rateOT: null, totalOT: 0 });
    expect(r.meta.weekEnding).toBe('2026-06-13');
    expect(r.meta.weekEndings).toEqual(['2026-06-13']);
    expect(r.warnings).toContain('Straight-time rates were calculated as straight-time pay ÷ straight-time hours (the file has no rate column) for rows 2, 3, 4.');
    expect(r.warnings).toContain('Overtime rates were calculated as overtime pay ÷ overtime hours (the file has no overtime rate column) for rows 2, 4.');
  });

  it('ADP-style export: deduction components, a repeated page header and a company totals row', () => {
    const r = fixture('adp-export.csv');
    expect(r.lines).toHaveLength(3);
    const amelie = byName(r.lines, 'Amelie R Delacroix');
    expect(amelie).toMatchObject({
      workerId: '004512',
      classification: 'Operating Engineer Group 2',
      totalST: 40,
      totalOT: 6,
      rateST: 38.6,
      rateOT: 57.9,
      grossThisProject: 1891.4,
      deductions: 564.84,
      netPay: 1326.56,
    });
    expect(byName(r.lines, 'Kenji Nakamura').deductions).toBe(238.86);
    expect(byName(r.lines, 'Grace Whitfield')).toMatchObject({ totalST: 36, deductions: 255.95, netPay: 791.65 });
    // Net pay = gross − the summed components for every worker.
    for (const l of r.lines) expect(Math.round((l.grossAllWork! - l.deductions!) * 100) / 100).toBe(l.netPay);
    expect(r.lineRows).toEqual({ L1: [2], L2: [3], L3: [5] });
    expect(r.meta.weekEnding).toBe('2026-06-13');
  });

  it('2008 WH-347 layout: O and S rows per worker, ID on the second row, daily hours by weekday', () => {
    const r = fixture('wh347-2008-layout.csv');
    expect(r.headerRowIndex).toBe(5);
    expect(r.headerRowCount).toBe(2);
    expect(r.meta).toMatchObject({
      contractorName: 'Bluewater Pipe & Grading Inc.',
      payrollNumber: '7',
      weekEnding: '2026-06-13',
      projectName: 'Harlow Creek Water Main Phase 2 - Harlow',
      dayLabels: ['Sun 6/7', 'Mon 6/8', 'Tue 6/9', 'Wed 6/10', 'Thu 6/11', 'Fri 6/12', 'Sat 6/13'],
      dayDates: ['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'],
    });
    expect(r.lines).toHaveLength(3);

    expect(byName(r.lines, 'Owen P Haldane')).toEqual({
      id: 'L1',
      workerName: 'Owen P Haldane',
      workerId: 'XXX-XX-4417',
      classification: 'Pipelayer',
      apprentice: false,
      dailyST: [0, 8, 8, 8, 8, 8, 0],
      dailyOT: [0, 0, 0, 2, 0, 0, 0],
      totalST: 40,
      totalOT: 2,
      rateST: 31,
      rateOT: 46.5,
      fringePlanHourly: 0,
      fringeCashHourly: 0,
      grossThisProject: 1333,
      grossAllWork: 1333,
      deductions: 199.97,
      netPay: 1133.03,
    });
    const lucia = byName(r.lines, 'Lucia Quispe');
    expect(lucia).toMatchObject({ workerId: 'XXX-XX-2290', totalST: 38, totalOT: 0, rateOT: null, dailyOT: [0, 0, 0, 0, 0, 0, 0] });
    const idris = byName(r.lines, 'Idris Farrow');
    expect(idris).toMatchObject({ dailyOT: [0, 0, 1, 0, 1, 0, 0], totalOT: 2, rateOT: 57.9, grossThisProject: 1659.8, grossAllWork: 1720, deductions: 338.58 });
    expect(r.lineRows).toEqual({ L1: [8, 9], L2: [10, 11], L3: [12, 13] });
    expect(r.warnings).toContain(
      'Row 14 has no worker, classification or ST/OT marker and its figures equal the sum of the rows above, so it was read as a totals row and skipped.',
    );
  });

  it('Rev. 2025 WH-347 layout: J/A column, fringe credit (6B) and cash (6C), gross 7A/7B', () => {
    const r = fixture('wh347-2025-layout.csv');
    expect(r.meta).toMatchObject({ contractorName: 'Cedar Hollow Framing LLC', projectName: 'Linden Street Senior Housing', payrollNumber: '12', weekEnding: '2026-06-13' });
    expect(byName(r.lines, 'Minh Tran')).toMatchObject({
      apprentice: false,
      dailyST: [0, 8, 8, 8, 8, 8, 0],
      dailyOT: [0, 0, 0, 2, 0, 0, 0],
      totalST: 40,
      totalOT: 2,
      rateST: 33.1,
      rateOT: null,
      fringePlanHourly: 14.25,
      grossThisProject: 1423.3,
      deductions: 258.88,
    });
    expect(byName(r.lines, 'June Ellery')).toMatchObject({ apprentice: true, classification: 'Carpenter', rateST: 19.86 });
    expect(byName(r.lines, 'Klaus Bauer')).toMatchObject({ fringePlanHourly: 10, fringeCashHourly: 4.25, deductions: 299.29 });
    expect(r.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('importPayrollTable layouts', () => {
  it('merges one row per earning type and skips pay types that are not ST or OT', () => {
    const r = importCsv(`Employee,Emp ID,Craft,Earning,Hours,Rate,Amount
"Pike, Nora",1101,Carpenter,Regular,40,30.00,1200.00
"Pike, Nora",1101,Carpenter,Overtime,3,45.00,135.00
"Ames, Lev",1102,Carpenter,Regular,40,30.00,1200.00
"Ames, Lev",1102,Carpenter,Vacation,8,30.00,240.00
`);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ workerName: 'Nora Pike', totalST: 40, totalOT: 3, rateST: 30, rateOT: 45, grossThisProject: 1335 });
    expect(r.lines[1]).toMatchObject({ workerName: 'Lev Ames', totalST: 40, totalOT: 0, grossThisProject: 1200 });
    expect(r.lineRows.L1).toEqual([2, 3]);
    expect(r.warnings).toContain('Row 5 (Lev Ames): pay type "Vacation" is not straight time or overtime; the row was skipped.');
    expect(r.warnings.some((w) => /added together \(rows 2\+3\)/.test(w))).toBe(true);
  });

  it('attaches detail rows to a name-only row above them', () => {
    const r = importCsv(`Employee,Pay Type,Hours,Rate,Gross
"Pike, Nora",,,,
,Regular,40,30.00,1200.00
,Overtime,3,45.00,135.00
"Ames, Lev",,,,
,Regular,32,30.00,960.00
`);
    expect(r.lines.map((l) => [l.workerName, l.totalST, l.totalOT, l.rateOT])).toEqual([
      ['Nora Pike', 40, 3, 45],
      ['Lev Ames', 32, 0, null],
    ]);
    expect(r.lineRows).toEqual({ L1: [2, 3, 4], L2: [5, 6] });
  });

  it('reads a nameless second row as overtime, or as a second classification for the same worker', () => {
    const r = importCsv(`Name,Classification,Hours,Rate,Gross
"Pike, Nora",Carpenter,40,30.00,1335.00
,,3,45.00,
"Ames, Lev",Carpenter,40,30.00,1200.00
,Laborer Group 1,8,22.00,176.00
`);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ workerName: 'Nora Pike', totalST: 40, totalOT: 3, rateOT: 45, grossThisProject: 1335 });
    expect(r.lines[2]).toMatchObject({ workerName: 'Lev Ames', classification: 'Laborer Group 1', totalST: 8, rateST: 22 });
    expect(r.warnings).toContain('Row 3 has no worker name or ST/OT marker; it was read as the overtime row for Nora Pike (row 2).');
    expect(r.warnings).toContain('Row 5 has no worker name; it was listed as another line for Lev Ames (row 4).');
  });

  it('does not merge a nameless row paid at the straight-time rate as overtime', () => {
    const r = importCsv(`Name,Hours,Rate
"Pike, Nora",40,30.00
,6,30.00
`);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toMatchObject({ workerName: 'Nora Pike', totalST: 6, totalOT: 0 });
  });

  it('merges S and O rows in either order, with ST/OT spelled out', () => {
    const r = importCsv(`Name,ST/OT,Hours,Rate
"Pike, Nora",ST,40,30.00
,OT,2,45.00
"Ames, Lev",Overtime,1,45.00
"Ames, Lev",Straight Time,38,30.00
`);
    expect(r.lines.map((l) => [l.workerName, l.totalST, l.totalOT, l.rateST, l.rateOT])).toEqual([
      ['Nora Pike', 40, 2, 30, 45],
      ['Lev Ames', 38, 1, 30, 45],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('derives straight time from total minus overtime and adds double time to overtime', () => {
    const r = importCsv(`Employee,Total Hours,OT Hours,DT Hours,Rate
"Pike, Nora",44,4,,30
"Ames, Lev",42,0,2,30
`);
    expect(r.lines[0]).toMatchObject({ totalST: 40, totalOT: 4 });
    expect(r.lines[1]).toMatchObject({ totalST: 40, totalOT: 2 });
    expect(r.warnings).toContain('Row 3 (Lev Ames): 2 double-time hours were added to the overtime hours.');
  });

  it('flags totals that disagree with ST + OT', () => {
    const r = importCsv(`Employee,Regular Hours,OT Hours,Total Hours,Rate
"Pike, Nora",40,4,40,30
`);
    expect(r.lines[0]).toMatchObject({ totalST: 40, totalOT: 4 });
    expect(r.warnings).toContain('Row 2 (Nora Pike): total hours 40 do not equal 40 ST + 4 OT.');
  });

  it('converts weekly fringe dollars to an hourly credit, with a warning', () => {
    const r = importCsv(`Employee,Hours,Rate,Fringe Amount,Cash Fringe Amount
"Pike, Nora",40,30,496.00,40.00
"Ames, Lev",0,30,100.00,
`);
    expect(r.lines[0]).toMatchObject({ fringePlanHourly: 12.4, fringeCashHourly: 1 });
    expect(r.lines[1]).toMatchObject({ fringePlanHourly: 0 });
    expect(r.warnings).toContain('Row 2 (Nora Pike): fringe paid to plans of $496.00 for the week was converted to $12.40/hr over 40 hours.');
    expect(r.warnings).toContain(
      'Row 3 (Lev Ames): fringe paid to plans of $100.00 could not be converted to an hourly amount because no hours were reported; it was left at $0.00/hr.',
    );
  });

  it('prefers an hourly fringe column over a dollar amount', () => {
    const r = importCsv(`Employee,Hours,Rate,Fringe Rate,Total Fringe
"Pike, Nora",40,30,12.40,496
`);
    expect(r.lines[0]!.fringePlanHourly).toBe(12.4);
    expect(r.warnings.filter((w) => /converted/.test(w))).toEqual([]);
  });

  it('takes classifications from section headings when there is no classification column', () => {
    const r = importCsv(`Name,Hours,Rate
CARPENTERS
"Pike, Nora",40,30
"Ames, Lev",40,30
Carpenters Total,80,
LABORERS
"Cole, Rae",40,22
`);
    expect(r.lines.map((l) => [l.workerName, l.classification])).toEqual([
      ['Nora Pike', 'CARPENTERS'],
      ['Lev Ames', 'CARPENTERS'],
      ['Rae Cole', 'LABORERS'],
    ]);
    expect(r.warnings).toContain('The file has no classification column; classifications were taken from the section headings above rows 3, 4, 7.');
  });

  it('splits an identifying number out of the name cell', () => {
    const r = importCsv(`Name and identifying number,Classification,Hours,Rate
"Doe, Jane  XXX-XX-1234",Laborer,40,22
Jordan Reyes (4821),Laborer,40,22
`);
    expect(r.lines.map((l) => [l.workerName, l.workerId])).toEqual([
      ['Jane Doe', 'XXX-XX-1234'],
      ['Jordan Reyes', '4821'],
    ]);
  });

  it('uses a supplied column mapping and ignores entries that are not column numbers', () => {
    const rows = parseCsvText(`Col A,Col B,Col C,Col D
"Pike, Nora",Carpenter,40,30
`);
    const columnMap = { workerName: 0, classification: 1, totalST: 2, rateST: 3, netPay: -1, grossPay: 'x' } as unknown as ColumnMap;
    const r = importPayrollTable(rows, { columnMap, headerRowIndex: 0, idFactory: () => 'id' });
    expect(r.columnMap).toEqual({ workerName: 0, classification: 1, totalST: 2, rateST: 3 });
    expect(r.confidence).toEqual({ workerName: 1, classification: 1, totalST: 1, rateST: 1 });
    expect(r.score).toBe(1);
    expect(r.lines).toEqual([expect.objectContaining({ id: 'id', workerName: 'Nora Pike', totalST: 40, rateST: 30 })]);
    expect(r.warnings.filter((w) => /not a valid column number/.test(w))).toHaveLength(2);
  });

  it('applies a remembered mapping to the next file with the same layout', () => {
    const first = importCsv(`Emp,Trade,Reg,OT,Rate
"Pike, Nora",Carpenter,40,2,30
`);
    const next = importCsv(`Emp,Trade,Reg,OT,Rate
"Ames, Lev",Carpenter,38,0,30
`, { columnMap: first.columnMap });
    expect(next.headerSignature).toBe(first.headerSignature);
    expect(next.lines[0]).toMatchObject({ workerName: 'Lev Ames', classification: 'Carpenter', totalST: 38 });
  });

  it('warns when the J/A column and the classification disagree or the J/A value is unknown', () => {
    const r = importCsv(`Name,J/A,Classification,Hours,Rate
"Pike, Nora",J,Carpenter Apprentice,40,20
"Ames, Lev",Q,Carpenter,40,30
"Cole, Rae",A-2,Carpenter,40,18
`);
    expect(r.lines.map((l) => l.apprentice)).toEqual([true, false, true]);
    expect(r.warnings).toContain('Row 2 (Nora Pike): the classification says apprentice but the J/A column says journeyworker; the worker was treated as an apprentice.');
    expect(r.warnings).toContain('Row 3: journeyworker/apprentice value "Q" was not recognized; the worker was treated as a journeyworker.');
  });

  it('warns about a missing rate and leaves it at zero', () => {
    const r = importCsv(`Employee,Hours,Gross
"Pike, Nora",40,1200
`);
    expect(r.lines[0]!.rateST).toBe(0);
    expect(r.warnings).toContain('Row 2 (Nora Pike): no straight-time rate of pay was found; it was set to $0.00. Enter the rate before reviewing this line.');
  });

  it('reports a file that spans several weeks', () => {
    const r = importCsv(`Week Ending,Employee,Hours,Rate
6/6/2026,"Pike, Nora",40,30
6/13/2026,"Pike, Nora",38,30
`);
    expect(r.meta.weekEndings).toEqual(['2026-06-06', '2026-06-13']);
    expect(r.meta.weekEnding).toBe('2026-06-13');
    expect(r.warnings.some((w) => /2 different week ending dates \(2026-06-06, 2026-06-13\)/.test(w))).toBe(true);
  });

  it('reports daily-hours dates that do not end on the week ending date', () => {
    const r = importCsv(`Week Ending: 6/20/2026
Name,Sun 6/7,Mon 6/8,Tue 6/9,Wed 6/10,Thu 6/11,Fri 6/12,Sat 6/13,Rate
"Pike, Nora",0,8,8,8,8,8,0,30
`);
    expect(r.lines[0]!.totalST).toBe(40);
    expect(r.warnings).toContain('The daily-hours columns end on 2026-06-13, but the week ending date is 2026-06-20.');
  });

  it('does not mistake names containing report words for page titles', () => {
    const r = importCsv(`Weekley Masonry Inc
Name,OT or ST,Hours,Rate
"Page, Jimmy",S,,
,O,4,45
"Period, Ana",S,40,30
`);
    expect(r.meta.contractorName).toBe('Weekley Masonry Inc');
    expect(r.lines.map((l) => [l.workerName, l.totalST, l.totalOT, l.rateOT])).toEqual([
      ['Jimmy Page', 0, 4, 45],
      ['Ana Period', 40, 0, null],
    ]);
    expect(r.lineRows.L1).toEqual([3, 4]);
  });

  it('reads the week ending from a pay period line and labels in the next cell', () => {
    const r = importCsv(`Company:,Tamarack Electric Co.
Pay Period:,06/07/2026 - 06/13/2026
Payroll Number,15
Employee,Hours,Rate
"Pike, Nora",40,30
`);
    expect(r.meta).toMatchObject({ contractorName: 'Tamarack Electric Co.', weekEnding: '2026-06-13', payrollNumber: '15' });
  });
});

// ---------------------------------------------------------------------------

describe('malformed input', () => {
  it('handles no rows and blank rows', () => {
    expect(importPayrollTable([]).warnings).toEqual(['The file is empty.']);
    const blank = importPayrollTable([[], ['', '  ', null], [undefined]]);
    expect(blank.headerRowIndex).toBe(-1);
    expect(blank.lines).toEqual([]);
    expect(blank.warnings).toEqual(['The file is empty.']);
  });

  it('reports a file with no recognizable header', () => {
    const r = importCsv(`hello,world
1,2
3,4
`);
    expect(r.headerRowIndex).toBe(-1);
    expect(r.lines).toEqual([]);
    expect(r.warnings[0]).toMatch(/^No header row with recognizable payroll columns/);
  });

  it('treats text in number cells as blank and says where it was', () => {
    const r = importCsv(`Employee,Hours,Rate,Net Pay
"Pike, Nora",forty,30.00,abc
"Ames, Lev",40,n/a,--
`);
    expect(r.lines[0]).toMatchObject({ totalST: 0, rateST: 30, netPay: null });
    expect(r.lines[1]).toMatchObject({ totalST: 40, rateST: 0, netPay: null });
    expect(r.warnings).toContain('Row 2 (Nora Pike): "forty" in column "Hours" is not a number; it was treated as blank.');
    expect(r.warnings).toContain('Row 2 (Nora Pike): "abc" in column "Net Pay" is not a number; it was treated as blank.');
    expect(r.warnings.some((w) => /"n\/a"|"--"/.test(w))).toBe(false);
  });

  it('skips repeated header rows, page titles and labeled totals', () => {
    const r = importCsv(`Employee,Hours,Rate
"Pike, Nora",40,30
Employee,Hours,Rate
EMPLOYEE,HOURS,RATE
Page 2 of 2
"Ames, Lev",40,30
Sub-Total,80,
Grand Total,80,
`);
    expect(r.lines.map((l) => l.workerName)).toEqual(['Nora Pike', 'Lev Ames']);
    expect(r.warnings).toEqual([]);
  });

  it('reports a header with no worker rows below it', () => {
    const r = importCsv('Employee,Hours,Rate\n');
    expect(r.headerRowIndex).toBe(0);
    expect(r.lines).toEqual([]);
    expect(r.warnings).toContain('No worker lines were found below the header row.');
  });

  it('survives ragged rows, non-array rows and odd cell values', () => {
    const rows = [
      ['Employee', 'Hours', 'Rate', 'Gross'],
      ['Pike, Nora'],
      'not a row',
      ['Ames, Lev', 40, 30, { toString: () => 'x' }, 'extra', 'cells'],
      [42, true, Number.NaN, Number.POSITIVE_INFINITY],
      null,
    ] as unknown as unknown[][];
    let r: ReturnType<typeof importPayrollTable> | undefined;
    expect(() => {
      r = importPayrollTable(rows, { idFactory: () => 'x' });
    }).not.toThrow();
    expect(r!.lines.map((l) => l.workerName)).toContain('Lev Ames');
    expect(r!.lines.every((l) => Number.isFinite(l.totalST) && Number.isFinite(l.rateST))).toBe(true);
  });

  it('flags a nameless row with pay and no worker', () => {
    const r = importCsv(`Employee,Hours,Rate
,40,30
`);
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain('Row 2 has hours or pay but no worker name or identifying number.');
  });

  it('caps the number of warnings', () => {
    const body = Array.from({ length: 300 }, (_, i) => `"Worker ${i}",x,30`).join('\n');
    const r = importCsv(`Employee,Hours,Rate\n${body}\n`);
    expect(r.warnings).toHaveLength(201);
    expect(r.warnings.at(-1)).toMatch(/^… and \d+ more warnings\.$/);
  });

  it('assigns unique ids by default', () => {
    const r = importPayrollTable(parseCsvText('Employee,Hours,Rate\nA B,1,2\nC D,1,2\n'));
    expect(new Set(r.lines.map((l) => l.id)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('names, apprentices and cells', () => {
  it('parses worker names', () => {
    expect(parsePersonName('Doe, Jane M')).toEqual({ first: 'Jane', middle: 'M', last: 'Doe', suffix: '' });
    expect(displayName('DOE, JANE')).toBe('JANE DOE');
    expect(displayName('Smith, Jr., John')).toBe('John Smith Jr.');
    expect(displayName('John Smith, Jr.')).toBe('John Smith Jr.');
    expect(displayName('Maria de la Cruz')).toBe('Maria de la Cruz');
    expect(displayName('  Cher  ')).toBe('Cher');
    expect(displayName('')).toBe('');
    expect(splitNameAndId('Doe, Jane ***-**-1234')).toEqual({ name: 'Doe, Jane', id: '***-**-1234' });
    expect(splitNameAndId('1234 Jane Doe')).toEqual({ name: 'Jane Doe', id: '1234' });
    expect(splitNameAndId('Jane Doe III')).toEqual({ name: 'Jane Doe III', id: '' });
  });

  it('strips apprentice wording from classifications', () => {
    expect(stripApprentice('Electrician Apprentice')).toEqual({ classification: 'Electrician', apprentice: true });
    expect(stripApprentice('Apprentice Electrician')).toEqual({ classification: 'Electrician', apprentice: true });
    expect(stripApprentice('Carpenter (Apprentice)')).toEqual({ classification: 'Carpenter', apprentice: true });
    expect(stripApprentice('Electrician - Appr 2nd yr')).toEqual({ classification: 'Electrician', apprentice: true });
    expect(stripApprentice('2nd Year Apprentice Plumber')).toEqual({ classification: 'Plumber', apprentice: true });
    expect(stripApprentice('Appr. Carpenter')).toEqual({ classification: 'Carpenter', apprentice: true });
    expect(stripApprentice('Pipefitter/Apprentice')).toEqual({ classification: 'Pipefitter', apprentice: true });
    expect(stripApprentice('Application Engineer')).toEqual({ classification: 'Application Engineer', apprentice: false });
    expect(stripApprentice('  Laborer  ')).toEqual({ classification: 'Laborer', apprentice: false });
  });

  it('reads J/A values', () => {
    for (const yes of ['A', 'a', 'Y', 'Yes', 'Apprentice', 'Appr', 'A-2', '60%', '3rd period', 'Level 2']) expect(parseApprenticeFlag(yes)).toBe(true);
    for (const no of ['J', 'JW', 'Journeyman', 'Journeyworker', 'N', 'no', '', '0']) expect(parseApprenticeFlag(no)).toBe(false);
    expect(parseApprenticeFlag('Q')).toBeNull();
  });

  it('parses hours and money cells', () => {
    expect(parseNumberCell('$1,234.50')).toEqual({ value: 1234.5, invalid: false });
    expect(parseNumberCell('(12.00)')).toEqual({ value: -12, invalid: false });
    expect(parseNumberCell('8:30')).toEqual({ value: 8.5, invalid: false });
    expect(parseNumberCell('40 hrs')).toEqual({ value: 40, invalid: false });
    expect(parseNumberCell('$26.85/hr')).toEqual({ value: 26.85, invalid: false });
    expect(parseNumberCell('26,85')).toEqual({ value: 26.85, invalid: false });
    expect(parseNumberCell('1.220,50')).toEqual({ value: 1220.5, invalid: false });
    expect(parseNumberCell('1,220')).toEqual({ value: 1220, invalid: false });
    expect(parseNumberCell('N/A')).toEqual({ value: null, invalid: false });
    expect(parseNumberCell('abc')).toEqual({ value: null, invalid: true });
    expect(parseNumberCell(true)).toEqual({ value: null, invalid: true });
    expect(parseNumberCell(Number.NaN)).toEqual({ value: null, invalid: true });
  });

  it('finds dates and date ranges in title text', () => {
    expect(findDates('June 7 - 13, 2026')).toEqual(['2026-06-07', '2026-06-13']);
    expect(findDates('May 31 - June 6, 2026')).toEqual(['2026-05-31', '2026-06-06']);
    expect(findDates('Pay period 06/07/2026 through 06/13/2026')).toEqual(['2026-06-07', '2026-06-13']);
    expect(findDates('Week ending Jun 13, 2026')).toEqual(['2026-06-13']);
    expect(findDates('Payroll No. 7')).toEqual([]);
  });

  it('reads spreadsheet dates in UTC so the day never shifts', () => {
    expect(cellDate(new Date(Date.UTC(2026, 5, 13)))).toBe('2026-06-13');
    expect(cellDate(new Date(Date.UTC(2026, 5, 13) - 1))).toBe('2026-06-13');
    expect(cellDate(46186)).toBe('2026-06-13');
    expect(cellDate('Week of 6/13/2026')).toBe('2026-06-13');
    expect(cellDate(new Date(Number.NaN))).toBeNull();
  });
});
