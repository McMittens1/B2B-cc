import writeXlsxFile from 'write-excel-file';
import sampleWdText from '../../fixtures/wd/sample-modern.txt?raw';
import { newId, nowIso } from '../db/db';
import {
  createProject,
  loadProjectData,
  saveContractor,
  saveImportProfile,
  savePayroll,
  saveWageDetermination,
  setMapping,
  setPayrollStatus,
  setRestitution,
} from '../db/repo';
import { evaluateProject } from '../engine/checks/evaluate';
import { addDays, formatDate, todayIso } from '../engine/dates';
import { importPayrollFile } from '../engine/importers';
import { fillWh347, wh347FromPayroll } from '../engine/pdf';
import { cents } from '../engine/money';
import { NOT_ON_WD, type Contractor, type Payroll, type PayrollLine, type Project } from '../engine/types';
import { readPayrollPdf } from '../app/files';
import { buildScenario, demoDeductions, demoGross, type DemoContractorKey, type DemoPayroll, type DemoWeekLine } from './scenario';

/**
 * Build the fictional demo project. Payrolls are not written straight into the
 * database: WH-347 PDFs are generated and read back through the PDF reader, CSV and
 * Excel files are generated and read back through the spreadsheet importer. If any
 * intake path breaks, building the demo fails loudly.
 */
export async function createDemoProject(): Promise<Project> {
  const today = todayIso();
  const sc = buildScenario(today);
  const project = await createProject({
    name: 'Harlow Creek Water Main Replacement, Phase 2 (demo)',
    projectNumber: 'B-26-DC-XX-0047 (sample)',
    owner: 'Village of Harlow Creek (fictional)',
    location: 'Harlow, Sample State',
    fundingSource: 'CDBG',
    wdLockDate: '2026-04-01',
    reviewer: {
      name: 'Dana Whitfield',
      title: 'Labor Standards Officer',
      organization: 'Pinecrest Regional Planning Commission (fictional)',
      email: 'dwhitfield@pinecrest.example',
      phone: '(555) 010-0147',
    },
  });
  await saveWageDetermination(project.id, sampleWdText);

  const contractors = new Map<DemoContractorKey, Contractor>();
  for (const c of sc.contractors) {
    const contractor: Contractor = {
      id: newId(),
      projectId: project.id,
      name: c.name,
      tier: c.tier,
      trade: c.trade,
      startDate: c.startDate,
      endDate: null,
      contactName: c.contactName,
      contactEmail: c.contactEmail,
      address: c.address,
      apprenticePrograms: c.apprenticePrograms.map((p) => ({ ...p, id: newId() })),
    };
    await saveContractor(contractor);
    contractors.set(c.key, contractor);
  }

  const data = await loadProjectData(project.id);
  const wd = data!.wd!.parsed;
  for (const m of sc.mappings) {
    const key = m.wdLabel === 'NOT_ON_WD' ? NOT_ON_WD : wd.classifications.find((c) => c.label === m.wdLabel)?.key;
    if (!key) throw new Error(`Demo mapping target not on the sample WD: ${m.wdLabel}`);
    await setMapping(project.id, contractors.get(m.contractorKey)!.id, m.payrollLabel, key);
  }

  const template = new Uint8Array(await (await fetch(new URL('forms/wh347-rev2025.pdf', document.baseURI))).arrayBuffer());
  const saved = new Map<DemoPayroll, Payroll>();
  for (const dp of sc.payrolls) {
    const contractor = contractors.get(dp.contractorKey)!;
    const channel = sc.contractors.find((c) => c.key === dp.contractorKey)!.channel;
    const base = basePayroll(project, contractor, dp);
    let payroll: Payroll;
    if (channel === 'manual') {
      payroll = await savePayroll(base);
    } else if (channel === 'wh347-pdf') {
      const pdf = await fillWh347(
        template,
        wh347FromPayroll({
          project,
          contractor,
          payroll: base,
          wdNumber: wd.decisionNumber ?? '',
          certifyingOfficial: { name: contractor.contactName, title: 'Office Manager', email: contractor.contactEmail },
          fringePlans: [{ name: 'Sample Trades Health & Pension Fund', type: 'Health/Pension', planNumber: 'TR-2291', funded: true }],
        }),
      );
      const parsed = await readPayrollPdf(pdf);
      expectLines(parsed.lines.length, base.lines.length, `WH-347 PDF for ${contractor.name}`);
      const name = `${contractor.name} WH-347 payroll ${dp.payrollNumber} (${formatDate(dp.weekEnding).replace(/\//g, '-')}).pdf`;
      payroll = await savePayroll(
        {
          ...base,
          source: { kind: 'wh347-pdf', fileName: name, fileId: null },
          statementOfComplianceSigned: parsed.meta.signed ?? false,
          lines: parsed.lines.map(({ entryNo: _e, lastName: _l, firstName: _f, middleInitial: _m, deductionDetail: _d, source: _s, ...rest }) => ({ ...rest, id: newId() })),
        },
        { name, type: 'application/pdf', data: new Blob([pdf as BlobPart], { type: 'application/pdf' }) },
      );
    } else {
      const isCsv = channel === 'csv';
      const name = isCsv
        ? `Kessler payroll register ${dp.weekEnding}.csv`
        : `Northfork certified payroll ${dp.payrollNumber}.xlsx`;
      const bytes = isCsv ? new TextEncoder().encode(registerCsv(contractor, dp)) : await wh347Workbook(contractor, dp);
      const result = await importPayrollFile(name, bytes, { idFactory: newId });
      if (result.status !== 'ok') throw new Error(`Demo ${name} did not import: ${result.message}`);
      expectLines(result.lines.length, base.lines.length, name);
      payroll = await savePayroll(
        { ...base, source: { kind: isCsv ? 'csv' : 'xlsx', fileName: name, fileId: null }, lines: result.lines },
        { name, type: isCsv ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: new Blob([bytes as BlobPart]) },
      );
      await saveImportProfile(project.id, contractor.id, result.headerSignature, result.columnMap);
    }
    saved.set(dp, payroll);
  }

  // Ridgeline sent a corrected payroll for its second week after paying Ruiz's back wages.
  const concrete = contractors.get('concrete')!;
  const originalDemo = sc.payrolls.find((p) => p.contractorKey === 'concrete' && p.payrollNumber === '2');
  const original = originalDemo ? saved.get(originalDemo) : undefined;
  if (original && original.receivedDate && addDays(original.receivedDate, 9) <= today) {
    await savePayroll({
      ...original,
      id: newId(),
      supersedesPayrollId: original.id,
      receivedDate: addDays(original.receivedDate, 9),
      source: { kind: 'manual', fileName: null, fileId: null },
      lines: original.lines.map((l) => (l.rateST === 24.1 ? fixedRuizLine(l) : { ...l, id: newId() })),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  await applyReviewHistory(project.id, today, concrete.id, contractors.get('electric')!.id);
  return project;
}

function expectLines(got: number, want: number, what: string) {
  if (got !== want) throw new Error(`${what}: read ${got} worker lines, expected ${want}`);
}

function workerName(l: DemoWeekLine): string {
  const w = l.worker;
  return `${w.first} ${w.mi ? `${w.mi}. ` : ''}${w.last}`;
}

/** Demo hours are Monday-first; WH-347 columns run Sunday → Saturday for a Saturday week ending. */
function sundayFirst(h: number[]): number[] {
  return [h[6] ?? 0, ...h.slice(0, 6)];
}

function toLine(l: DemoWeekLine): PayrollLine {
  const gross = demoGross(l);
  const deductions = demoDeductions(gross);
  return {
    id: newId(),
    workerName: workerName(l),
    workerId: l.worker.id,
    classification: l.worker.classification,
    apprentice: Boolean(l.worker.apprentice),
    dailyST: sundayFirst(l.st),
    dailyOT: sundayFirst(l.ot),
    totalST: l.st.reduce((a, b) => a + b, 0),
    totalOT: l.ot.reduce((a, b) => a + b, 0),
    rateST: l.worker.rateST,
    rateOT: l.rateOT,
    fringePlanHourly: l.worker.fringePlan,
    fringeCashHourly: l.worker.fringeCash,
    grossThisProject: gross,
    grossAllWork: gross,
    deductions,
    netPay: cents(gross - deductions),
  };
}

function basePayroll(project: Project, contractor: Contractor, dp: DemoPayroll): Payroll {
  const now = nowIso();
  return {
    id: newId(),
    projectId: project.id,
    contractorId: contractor.id,
    payrollNumber: dp.payrollNumber,
    weekEnding: dp.weekEnding,
    receivedDate: dp.receivedDate,
    noWork: Boolean(dp.noWork),
    isFinal: false,
    supersedesPayrollId: null,
    statementOfComplianceSigned: dp.signed,
    source: { kind: 'manual', fileName: null, fileId: null },
    lines: dp.lines.map(toLine),
    status: 'received',
    reviewNote: '',
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fixedRuizLine(l: PayrollLine): PayrollLine {
  const gross = cents(l.totalST * 26.85);
  const deductions = demoDeductions(gross);
  return { ...l, id: newId(), rateST: 26.85, grossThisProject: gross, grossAllWork: gross, deductions, netPay: cents(gross - deductions) };
}

const csvCell = (v: string | number) => (typeof v === 'number' ? v.toFixed(2) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A QuickBooks-style payroll register export, title lines and all. */
function registerCsv(contractor: Contractor, dp: DemoPayroll): string {
  const rows: (string | number)[][] = [
    [contractor.name],
    ['Payroll Register - Harlow Creek Water Main Phase 2'],
    [`Week Ending: ${formatDate(dp.weekEnding)}`],
    [`Payroll No. ${dp.payrollNumber}`],
    [],
    ['Employee', 'SSN (last 4)', 'Work Class', 'Regular Hours', 'Overtime Hours', 'Reg Rate', 'OT Rate', 'Hourly Fringe Credit', 'Gross Pay', 'Total Deductions', 'Net Pay'],
  ];
  for (const l of dp.lines) {
    const line = toLine(l);
    rows.push([
      `${l.worker.last}, ${l.worker.first}${l.worker.mi ? ` ${l.worker.mi}` : ''}`,
      l.worker.id,
      l.worker.apprentice ? `${l.worker.classification} Apprentice` : l.worker.classification,
      line.totalST,
      line.totalOT,
      line.rateST,
      line.rateOT ?? '',
      line.fringePlanHourly,
      line.grossThisProject ?? 0,
      line.deductions ?? 0,
      line.netPay ?? 0,
    ]);
  }
  return rows.map((r) => r.map((c) => (c === '' ? '' : csvCell(c))).join(',')).join('\r\n') + '\r\n';
}

/** A spreadsheet in the WH-347 layout, as some contractors keep their certified payrolls. */
async function wh347Workbook(contractor: Contractor, dp: DemoPayroll): Promise<Uint8Array> {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const header = [
    'Worker Name', 'Identifying Number', 'J/A', 'Labor Classification',
    ...days.flatMap((d) => [`${d} ST`, `${d} OT`]),
    'Total ST Hours', 'Total OT Hours', '6A Hourly Base Rate', '6B Hourly Fringe Benefit Credit for Plans',
    '6C Hourly Fringe Benefits Paid in Cash', '7A Gross Amount Earned This Project', '7B Gross Amount Earned All Work',
    'Total Deductions', 'Net Wages Paid',
  ];
  const text = (value: string) => ({ value, type: String });
  const num = (value: number | null) => (value === null ? null : { value, type: Number });
  const data: unknown[][] = [
    [text(`Contractor: ${contractor.name}`)],
    [text('Project: Harlow Creek Water Main Replacement, Phase 2')],
    [text(`Payroll No. ${dp.payrollNumber}`)],
    [text(`Week Ending: ${formatDate(dp.weekEnding)}`)],
    header.map((h) => ({ value: h, type: String, fontWeight: 'bold' })),
  ];
  for (const l of dp.lines) {
    const line = toLine(l);
    data.push([
      text(`${l.worker.last}, ${l.worker.first}`),
      text(line.workerId),
      text(line.apprentice ? 'A' : 'J'),
      text(line.classification),
      ...line.dailyST.flatMap((st, i) => [num(st), num(line.dailyOT[i] ?? 0)]),
      num(line.totalST), num(line.totalOT), num(line.rateST), num(line.fringePlanHourly), num(line.fringeCashHourly),
      num(line.grossThisProject), num(line.grossAllWork), num(line.deductions), num(line.netPay),
    ]);
  }
  const blob = (await writeXlsxFile(data as never, {})) as unknown as Blob;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Give the demo a realistic history: older payrolls reviewed, some restitution in progress. */
async function applyReviewHistory(projectId: string, today: string, concreteId: string, electricId: string) {
  const data = (await loadProjectData(projectId))!;
  const ev = evaluateProject({ project: data.project, wd: data.wd!.parsed, contractors: data.contractors, payrolls: data.payrolls, mappings: data.mappings, asOf: today });
  const cutoff = addDays(today, -24);
  for (const p of data.payrolls) {
    const s = ev.payrolls.get(p.id);
    if (!s || s.state === 'superseded' || p.weekEnding > cutoff) continue;
    await setPayrollStatus(p, s.state === 'violations' ? 'correction-requested' : 'accepted', s.state === 'violations' ? 'Correction letter sent.' : '');
  }
  const ruiz = ev.findings
    .filter((f) => f.contractorId === concreteId && f.ruleId === 'base-rate-below-wd')
    .sort((a, b) => (a.weekEnding ?? '').localeCompare(b.weekEnding ?? ''));
  if (ruiz[0]) {
    await setRestitution({ findingKey: ruiz[0].key, projectId, status: 'verified', amountPaid: ruiz[0].amountOwed, note: 'Check #4471; signed receipt on file.' });
  }
  if (ruiz[1]) {
    await setRestitution({ findingKey: ruiz[1].key, projectId, status: 'paid', amountPaid: ruiz[1].amountOwed, note: 'Contractor reports check #4502; awaiting receipt.' });
  }
  for (const f of ruiz.slice(2, 3)) {
    await setRestitution({ findingKey: f.key, projectId, status: 'requested', amountPaid: 0, note: 'Requested in correction letter.' });
  }
  const fringe = ev.findings.filter((f) => f.contractorId === electricId && f.ruleId === 'fringe-shortfall').sort((a, b) => (a.weekEnding ?? '').localeCompare(b.weekEnding ?? ''));
  for (const f of fringe.slice(0, 2)) {
    await setRestitution({ findingKey: f.key, projectId, status: 'requested', amountPaid: 0, note: 'Requested: 3% fringe portion missing.' });
  }
}
