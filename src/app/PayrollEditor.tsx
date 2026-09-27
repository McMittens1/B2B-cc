import { useMemo, useState } from 'react';
import { newId } from '../db/db';
import { addDays, formatDate, isIsoDate, WEEKDAY_NAMES, weekday } from '../engine/dates';
import { parseAmount, sum } from '../engine/money';
import type { Contractor, Payroll, PayrollLine } from '../engine/types';
import { Alert, Button, Field } from './ui';

/**
 * Spreadsheet-like editor for a payroll's header and worker lines. Used to key in scanned
 * payrolls, to fix values read from files, and to enter corrected payrolls. Numbers are
 * kept as text while editing so partial input like "26." is not destroyed.
 */

export interface EditorValue {
  header: Pick<Payroll, 'contractorId' | 'payrollNumber' | 'weekEnding' | 'receivedDate' | 'noWork' | 'isFinal' | 'statementOfComplianceSigned'>;
  lines: PayrollLine[];
}

type NumField = 'totalST' | 'totalOT' | 'rateST' | 'rateOT' | 'fringePlanHourly' | 'fringeCashHourly' | 'grossThisProject' | 'grossAllWork' | 'deductions' | 'netPay';

const NUM_COLUMNS: { field: NumField; label: string; title: string; width: number }[] = [
  { field: 'totalST', label: 'ST hrs', title: 'Straight-time hours this week', width: 62 },
  { field: 'totalOT', label: 'OT hrs', title: 'Overtime hours this week', width: 62 },
  { field: 'rateST', label: 'ST rate', title: 'Basic hourly rate paid (6A)', width: 72 },
  { field: 'rateOT', label: 'OT rate', title: 'Overtime rate paid (6A)', width: 72 },
  { field: 'fringePlanHourly', label: 'Plan fringe', title: 'Hourly credit for bona fide fringe plans (6B)', width: 76 },
  { field: 'fringeCashHourly', label: 'Cash fringe', title: 'Fringe paid in cash, per hour (6C)', width: 76 },
  { field: 'grossThisProject', label: 'Gross proj.', title: 'Gross earned on this project (7A)', width: 86 },
  { field: 'grossAllWork', label: 'Gross all', title: 'Gross earned for all work (7B)', width: 86 },
  { field: 'deductions', label: 'Deductions', title: 'Total deductions (8)', width: 86 },
  { field: 'netPay', label: 'Net pay', title: 'Net wages paid (9)', width: 86 },
];

const OPTIONAL = new Set<NumField>(['rateOT', 'grossThisProject', 'grossAllWork', 'deductions', 'netPay']);

export function blankLine(): PayrollLine {
  return {
    id: newId(),
    workerName: '',
    workerId: '',
    classification: '',
    apprentice: false,
    dailyST: [],
    dailyOT: [],
    totalST: 0,
    totalOT: 0,
    rateST: 0,
    rateOT: null,
    fringePlanHourly: 0,
    fringeCashHourly: 0,
    grossThisProject: null,
    grossAllWork: null,
    deductions: null,
    netPay: null,
  };
}

function toText(v: number | null): string {
  return v === null || v === undefined ? '' : String(v);
}

interface DraftLine {
  line: PayrollLine;
  text: Partial<Record<NumField, string>>;
}

export function PayrollEditor({
  value,
  contractors,
  onSave,
  onCancel,
  saveLabel = 'Save payroll',
  lockContractor = false,
}: {
  value: EditorValue;
  contractors: Contractor[];
  onSave: (v: EditorValue) => void | Promise<void>;
  onCancel?: () => void;
  saveLabel?: string;
  lockContractor?: boolean;
}) {
  const [header, setHeader] = useState(value.header);
  const [drafts, setDrafts] = useState<DraftLine[]>(() =>
    (value.lines.length ? value.lines : [blankLine()]).map((line) => ({
      line,
      text: Object.fromEntries(NUM_COLUMNS.map((c) => [c.field, toText(line[c.field] as number | null)])),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const errors = useMemo(() => {
    const out: string[] = [];
    if (!header.contractorId) out.push('Choose the contractor.');
    if (!isIsoDate(header.weekEnding)) out.push('Enter the week ending date.');
    if (!header.noWork) {
      drafts.forEach((d, i) => {
        const n = i + 1;
        if (!d.line.workerName.trim()) out.push(`Line ${n}: worker name is missing.`);
        for (const c of NUM_COLUMNS) {
          const t = (d.text[c.field] ?? '').trim();
          if (t === '') {
            if (!OPTIONAL.has(c.field) && c.field !== 'totalOT' && c.field !== 'fringePlanHourly' && c.field !== 'fringeCashHourly') out.push(`Line ${n}: ${c.label} is required.`);
          } else if (parseAmount(t) === null) out.push(`Line ${n}: ${c.label} "${t}" is not a number.`);
          else if ((parseAmount(t) ?? 0) < 0 && c.field !== 'deductions') out.push(`Line ${n}: ${c.label} cannot be negative.`);
        }
      });
    }
    return out;
  }, [header, drafts]);

  const updateLine = (i: number, patch: Partial<PayrollLine>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, line: { ...d.line, ...patch } } : d)));
  const updateNum = (i: number, field: NumField, text: string) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, text: { ...d.text, [field]: text } } : d)));

  const build = (): EditorValue => ({
    header,
    lines: header.noWork
      ? []
      : drafts.map(({ line, text }) => {
          const out: PayrollLine = { ...line, workerName: line.workerName.trim(), classification: line.classification.trim(), workerId: line.workerId.trim() };
          for (const c of NUM_COLUMNS) {
            const v = parseAmount(text[c.field] ?? '');
            if (OPTIONAL.has(c.field)) (out[c.field] as number | null) = v;
            else (out[c.field] as number) = v ?? 0;
          }
          // Daily detail no longer matches once totals are edited by hand.
          if (sum(out.dailyST) !== out.totalST || sum(out.dailyOT) !== out.totalOT) {
            out.dailyST = [];
            out.dailyOT = [];
          }
          return out;
        }),
  });

  const save = async () => {
    setShowErrors(true);
    if (errors.length) return;
    setBusy(true);
    try {
      await onSave(build());
    } finally {
      setBusy(false);
    }
  };

  const copyPreviousWeek = () => {
    // Crews rarely change week to week: duplicate names/titles/rates, clear hours.
    setDrafts((ds) =>
      ds.map((d) => ({
        line: { ...d.line, id: newId(), dailyST: [], dailyOT: [] },
        text: { ...d.text, totalST: '', totalOT: '', grossThisProject: '', grossAllWork: '', deductions: '', netPay: '' },
      })),
    );
  };

  const we = isIsoDate(header.weekEnding) ? header.weekEnding : null;

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Contractor">
          <select className="select" value={header.contractorId} disabled={lockContractor} onChange={(e) => setHeader({ ...header, contractorId: e.target.value })}>
            <option value="">— Choose —</option>
            {contractors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Week ending" hint={we ? `${WEEKDAY_NAMES[weekday(we)]}; week of ${formatDate(addDays(we, -6))} – ${formatDate(we)}` : undefined}>
          <input className="input" type="date" value={header.weekEnding} onChange={(e) => setHeader({ ...header, weekEnding: e.target.value })} />
        </Field>
        <Field label="Payroll no.">
          <input className="input" value={header.payrollNumber} onChange={(e) => setHeader({ ...header, payrollNumber: e.target.value })} />
        </Field>
        <Field label="Date received">
          <input className="input" type="date" value={header.receivedDate ?? ''} onChange={(e) => setHeader({ ...header, receivedDate: e.target.value || null })} />
        </Field>
      </div>
      <div className="row" style={{ gap: 18 }}>
        <label className="check"><input type="checkbox" checked={header.statementOfComplianceSigned} onChange={(e) => setHeader({ ...header, statementOfComplianceSigned: e.target.checked })} /> Statement of Compliance is signed</label>
        <label className="check"><input type="checkbox" checked={header.noWork} onChange={(e) => setHeader({ ...header, noWork: e.target.checked })} /> "No work performed" this week</label>
        <label className="check"><input type="checkbox" checked={header.isFinal} onChange={(e) => setHeader({ ...header, isFinal: e.target.checked })} /> Final payroll</label>
      </div>

      {!header.noWork && (
        <div className="table-wrap" style={{ border: '1px solid var(--line)', borderRadius: 6 }}>
          <table className="data editor-table">
            <thead>
              <tr>
                <th style={{ minWidth: 170 }}>Worker</th>
                <th style={{ width: 70 }} title="Identifying number (last four of SSN or employee ID)">ID</th>
                <th style={{ minWidth: 170 }}>Classification (as written)</th>
                <th title="Apprentice">Appr.</th>
                {NUM_COLUMNS.map((c) => (
                  <th key={c.field} className="num" title={c.title}>{c.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((d, i) => (
                <tr key={d.line.id}>
                  <td><input className="input sm" value={d.line.workerName} onChange={(e) => updateLine(i, { workerName: e.target.value })} aria-label={`Line ${i + 1} worker name`} /></td>
                  <td><input className="input sm" value={d.line.workerId} onChange={(e) => updateLine(i, { workerId: e.target.value })} aria-label={`Line ${i + 1} identifying number`} /></td>
                  <td><input className="input sm" value={d.line.classification} onChange={(e) => updateLine(i, { classification: e.target.value })} aria-label={`Line ${i + 1} classification`} /></td>
                  <td style={{ textAlign: 'center' }}><input type="checkbox" checked={d.line.apprentice} onChange={(e) => updateLine(i, { apprentice: e.target.checked })} aria-label={`Line ${i + 1} apprentice`} /></td>
                  {NUM_COLUMNS.map((c) => {
                    const t = d.text[c.field] ?? '';
                    const bad = showErrors && t.trim() !== '' && parseAmount(t) === null;
                    return (
                      <td key={c.field} style={{ width: c.width }}>
                        <input
                          className={`input sm num ${bad ? 'invalid' : ''}`}
                          inputMode="decimal"
                          value={t}
                          onChange={(e) => updateNum(i, c.field, e.target.value)}
                          aria-label={`Line ${i + 1} ${c.title}`}
                        />
                      </td>
                    );
                  })}
                  <td className="tight">
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove line ${i + 1}`} onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))} disabled={drafts.length === 1} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!header.noWork && (
        <div className="row">
          <Button size="sm" icon="plus" onClick={() => setDrafts((ds) => [...ds, { line: blankLine(), text: {} }])}>Add worker</Button>
          <Button size="sm" variant="ghost" onClick={copyPreviousWeek} title="Keep workers, titles and rates; clear this week's hours and pay">Clear hours, keep crew</Button>
        </div>
      )}
      {showErrors && errors.length > 0 && (
        <Alert tone="bad">
          <strong>Fix before saving:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {errors.slice(0, 8).map((e) => (
              <li key={e}>{e}</li>
            ))}
            {errors.length > 8 && <li>…and {errors.length - 8} more</li>}
          </ul>
        </Alert>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <Button onClick={onCancel} disabled={busy}>Cancel</Button>}
        <Button variant="primary" onClick={save} disabled={busy}>{saveLabel}</Button>
      </div>
    </div>
  );
}
