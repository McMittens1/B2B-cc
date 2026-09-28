import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/node';
import { buildLedger } from '../src/engine/restitution';
import type { Contractor, Finding, RestitutionRecord } from '../src/engine/types';
import { csvField, findingsToCsv, ledgerToCsv, ledgerToXlsx, neutralizeFormula } from '../src/engine/docs/exports';

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

const contractors: Contractor[] = [
  {
    id: 'c1',
    projectId: 'p1',
    name: 'Ridgeline Concrete, LLC',
    tier: 'subcontractor',
    trade: 'Concrete',
    startDate: null,
    endDate: null,
    contactName: '',
    contactEmail: '',
    address: '',
    apprenticePrograms: [],
  },
  {
    id: 'c2',
    projectId: 'p1',
    name: '=HYPERLINK("http://attacker.example","Click")',
    tier: 'subcontractor',
    trade: '',
    startDate: null,
    endDate: null,
    contactName: '',
    contactEmail: '',
    address: '',
    apprenticePrograms: [],
  },
];

function finding(p: Partial<Finding> & Pick<Finding, 'key'>): Finding {
  return {
    ruleId: 'base-rate-below-wd',
    severity: 'violation',
    payrollId: 'P1',
    contractorId: 'c1',
    lineId: 'L1',
    workerName: 'Maria Delgado',
    weekEnding: '2026-09-12',
    title: 'Maria Delgado: basic rate $24.10 is below $26.85',
    detail: 'Short $2.75/hr x 40 straight-time hrs = $110.00.',
    amountOwed: 110,
    ...p,
  };
}

const findings: Finding[] = [
  finding({ key: 'f1' }),
  finding({
    key: 'f2',
    ruleId: 'fringe-shortfall',
    workerName: 'Tomás "Tommy" Ñúñez',
    title: 'Fringe short, see detail',
    detail: 'Line one,\nline two with "quotes"',
    amountOwed: 60.45,
    weekEnding: '2026-09-19',
  }),
  finding({ key: 'f3', contractorId: 'c2', workerName: '+1 (555) 0100', title: '-2+3', amountOwed: 12.5 }),
  finding({ key: 'f4', workerName: '@SUM(A1:A9)', title: `${cp(9)}=cmd|' /C calc'!A0`, amountOwed: 5, supersededBy: 'P9' }),
  finding({ key: 'f5', ruleId: 'soc-missing', workerName: null, lineId: null, amountOwed: 0, title: 'Statement of Compliance missing', severity: 'violation' }),
];

const records: RestitutionRecord[] = [
  { findingKey: 'f1', projectId: 'p1', status: 'paid', amountPaid: 50, note: '=1+1 check #1043', updatedAt: '2026-09-27T15:04:00Z' },
  { findingKey: 'f2', projectId: 'p1', status: 'verified', amountPaid: 60.45, note: 'Receipt, signed', updatedAt: '2026-09-28T10:00:00Z' },
];

const ledger = buildLedger(findings, records, contractors);

describe('csvField', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('one\ntwo')).toBe('"one\ntwo"');
    expect(csvField('one\r\ntwo')).toBe('"one\r\ntwo"');
    expect(csvField('')).toBe('');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('neutralizes text a spreadsheet would run as a formula', () => {
    for (const dangerous of ['=SUM(A1:A2)', '+1', '-1+2', '@SUM(A1)', `${cp(9)}=1`, `${cp(13)}=1`, '  =1+1', `${cp(0xff1d)}1+1`]) {
      expect(csvField(dangerous).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvField('=A1,B1')).toBe(`"'=A1,B1"`);
    expect(neutralizeFormula('Laborer - Group 1')).toBe('Laborer - Group 1');
    expect(neutralizeFormula('a=b')).toBe('a=b');
  });

  it('writes numbers as numbers, including negatives', () => {
    expect(csvField(-12.5)).toBe('-12.5');
    expect(csvField(0)).toBe('0');
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('ledgerToCsv', () => {
  const text = ledgerToCsv(ledger.rows);

  it('starts with a BOM, uses CRLF and has one row per underpayment', () => {
    expect(text.startsWith('﻿Contractor,Week ending,Worker,')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(ledgerToCsv(ledger.rows, { bom: false }).startsWith('Contractor,')).toBe(true);
    const parsed = Papa.parse<string[]>(text.slice(1), { skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toHaveLength(1 + 4);
    expect(parsed.data.every((r) => r.length === 13)).toBe(true);
  });

  it('round-trips awkward values and neutralizes formulas', () => {
    const rows = Papa.parse<Record<string, string>>(text.slice(1), { header: true, skipEmptyLines: true }).data;
    const byKey = new Map(rows.map((r) => [r['Finding key'], r]));
    expect(byKey.get('f1')).toMatchObject({
      Contractor: 'Ridgeline Concrete, LLC',
      'Week ending': '2026-09-12',
      Worker: 'Maria Delgado',
      Issue: 'Basic rate below WD',
      'Amount owed': '110.00',
      'Amount paid': '50.00',
      Balance: '60.00',
      Status: 'Paid (unverified)',
      Note: "'=1+1 check #1043",
      'Last updated': '2026-09-27T15:04:00Z',
      'Corrected payroll received': 'No',
    });
    expect(byKey.get('f2')).toMatchObject({
      Worker: 'Tomás "Tommy" Ñúñez',
      Finding: 'Fringe short, see detail',
      'Amount owed': '60.45',
      Balance: '0.00',
      Status: 'Verified',
      Note: 'Receipt, signed',
    });
    expect(byKey.get('f3')).toMatchObject({
      Contractor: `'=HYPERLINK("http://attacker.example","Click")`,
      Worker: "'+1 (555) 0100",
      Finding: "'-2+3",
      'Amount owed': '12.50',
    });
    expect(byKey.get('f4')).toMatchObject({
      Worker: "'@SUM(A1:A9)",
      Finding: `'${cp(9)}=cmd|' /C calc'!A0`,
      'Corrected payroll received': 'Yes',
    });
    for (const row of rows) {
      for (const value of Object.values(row)) expect(/^[=+\-@\t\r]/.test(value)).toBe(false);
    }
  });

  it('writes just the header for an empty ledger', () => {
    expect(ledgerToCsv([], { bom: false }).split('\r\n')).toEqual([expect.stringContaining('Finding key'), '']);
  });
});

describe('findingsToCsv', () => {
  it('names contractors and keeps multi-line detail in one field', () => {
    const names = new Map(contractors.map((c) => [c.id, c.name]));
    const text = findingsToCsv([...findings, finding({ key: 'f6', contractorId: 'gone', amountOwed: -3 })], names, { bom: false });
    const rows = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
    expect(rows).toHaveLength(6);
    expect(Object.keys(rows[0]!)).toEqual([
      'Contractor',
      'Week ending',
      'Severity',
      'Check',
      'Worker',
      'Title',
      'Detail',
      'Amount owed',
      'Superseded',
      'Finding key',
    ]);
    expect(rows[1]).toMatchObject({ Detail: 'Line one,\nline two with "quotes"', Severity: 'Violation', Check: 'Fringe short' + 'fall' });
    expect(rows[2]!.Contractor.startsWith("'=")).toBe(true);
    expect(rows[4]).toMatchObject({ Worker: '', 'Amount owed': '0.00', Check: 'Statement of Compliance missing' });
    expect(rows[5]).toMatchObject({ Contractor: 'Unknown contractor', 'Amount owed': '-3.00' });
  });
});

describe('ledgerToXlsx', () => {
  it('writes a workbook with dates, money formats and a totals row', async () => {
    const bytes = await ledgerToXlsx(ledger.rows);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK');

    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const styles = await zip.file('xl/styles.xml')!.async('string');
    const workbook = await zip.file('xl/workbook.xml')!.async('string');
    expect(workbook).toContain('Restitution ledger');
    expect(styles).toContain('$#,##0.00');
    expect(styles).toContain('mm/dd/yyyy');
    expect(sheet).not.toContain('<f>');

    const rows = await readXlsxFile(Buffer.from(bytes));
    expect(rows).toHaveLength(1 + 4 + 1);
    expect(rows[0]!.slice(0, 3)).toEqual(['Contractor', 'Week ending', 'Worker']);
    const maria = rows.find((r) => r[2] === 'Maria Delgado')!;
    expect(maria[0]).toBe('Ridgeline Concrete, LLC');
    expect(maria[1]).toBeInstanceOf(Date);
    expect((maria[1] as unknown as Date).toISOString().slice(0, 10)).toBe('2026-09-12');
    expect(maria.slice(5, 8)).toEqual([110, 50, 60]);
    expect(maria[8]).toBe('Paid (unverified)');
    expect(maria[9]).toBe('=1+1 check #1043');
    const attacker = rows.find((r) => r[2] === '+1 (555) 0100')!;
    expect(attacker[0]).toBe('=HYPERLINK("http://attacker.example","Click")');
    const totals = rows[rows.length - 1]!;
    expect(totals[0]).toBe('Total (4 items)');
    expect(totals.slice(5, 8)).toEqual([ledger.totals.owed, ledger.totals.paid, ledger.totals.outstanding]);
  });

  it('writes an empty ledger and survives control characters in text', async () => {
    const empty = await readXlsxFile(Buffer.from(await ledgerToXlsx([])));
    expect(empty).toHaveLength(2);
    const odd = buildLedger([finding({ key: 'x', workerName: `Bad${cp(1)}Name${cp(0xfffe)}`, weekEnding: null })], [], contractors);
    const rows = await readXlsxFile(Buffer.from(await ledgerToXlsx(odd.rows)));
    expect(String(rows[1]![2])).toContain('Bad');
    expect(rows[1]![1]).toBeNull();
  });
});
