import { useMemo, useState } from 'react';
import { newId, nowIso } from '../../db/db';
import { blankContractor, saveContractor, saveImportProfile, savePayroll } from '../../db/repo';
import { formatDate, isIsoDate, parseDateLoose, todayIso } from '../../engine/dates';
import {
  FIELD_INFO,
  importPayrollFile,
  templateCsv,
  type ColumnMap,
  type PayrollField,
  type PayrollFileImportResult,
} from '../../engine/importers';
import type { PayrollPdfImport } from '../../engine/pdf';
import { formatHours, formatMoney, sum } from '../../engine/money';
import type { Contractor, Payroll, PayrollLine, PayrollSourceKind } from '../../engine/types';
import { explainPdfError, fileBytes, isPdf, readPayrollPdf } from '../files';
import { PayrollEditor, type EditorValue } from '../PayrollEditor';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { projectStore, type ProjectView } from '../store';
import { Alert, Badge, Button, EmptyState, Field, FileDrop, Modal, PageHeader, Panel, downloadFile, useToast } from '../ui';

/**
 * The payroll inbox: every file a reviewer drops becomes a draft they confirm and save.
 * WH-347 PDFs are read from their text layer, spreadsheets through column detection
 * (remembered per contractor layout), and scans are keyed in with last week's crew
 * carried forward.
 */

type DraftKind = 'wh347-pdf' | 'csv' | 'xlsx' | 'keyed' | 'no-work';

interface Draft {
  id: string;
  file: File | null;
  fileName: string;
  kind: DraftKind;
  state: 'reading' | 'ready' | 'failed' | 'saved';
  /** Why a file could not be read automatically (scan, unrecognized layout…). */
  notice: string | null;
  error: string | null;
  warnings: string[];
  uncertain: string[];
  lines: PayrollLine[];
  detectedContractor: string | null;
  contractorId: string;
  weekEnding: string;
  payrollNumber: string;
  receivedDate: string;
  signed: boolean;
  noWork: boolean;
  isFinal: boolean;
  supersedesPayrollId: string | null;
  table: PayrollFileImportResult | null;
  savedPayrollId: string | null;
}

function emptyDraft(partial: Partial<Draft>): Draft {
  return {
    id: newId(),
    file: null,
    fileName: '',
    kind: 'keyed',
    state: 'ready',
    notice: null,
    error: null,
    warnings: [],
    uncertain: [],
    lines: [],
    detectedContractor: null,
    contractorId: '',
    weekEnding: '',
    payrollNumber: '',
    receivedDate: todayIso(),
    signed: true,
    noWork: false,
    isFinal: false,
    supersedesPayrollId: null,
    table: null,
    savedPayrollId: null,
    ...partial,
  };
}

const COMPANY_NOISE = new Set(['inc', 'incorporated', 'llc', 'l', 'c', 'co', 'company', 'corp', 'corporation', 'ltd', 'the', 'and', 'of']);

function companyTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/&/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t && !COMPANY_NOISE.has(t)),
  );
}

/** Best roster match for a business name read from a file, or null. */
export function matchContractor(name: string | null, contractors: readonly Contractor[]): Contractor | null {
  if (!name) return null;
  const q = companyTokens(name);
  if (q.size === 0) return null;
  let best: { c: Contractor; score: number } | null = null;
  for (const c of contractors) {
    const t = companyTokens(c.name);
    const inter = [...q].filter((x) => t.has(x)).length;
    const score = inter / Math.max(q.size, t.size);
    if (!best || score > best.score) best = { c, score };
  }
  return best && best.score >= 0.5 ? best.c : null;
}

/** "Kessler payroll 2026-09-12.csv" → 2026-09-12. */
function dateFromFileName(name: string): string | null {
  const m = /(\d{4}[-_.]\d{1,2}[-_.]\d{1,2})|(\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4})/.exec(name);
  if (!m) return null;
  return parseDateLoose((m[1] ?? m[2]!).replace(/[_.]/g, '-').replace(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/, '$1/$2/$3'));
}

function carryForward(view: ProjectView, contractorId: string): PayrollLine[] {
  const last = view.data.payrolls.find((p) => p.contractorId === contractorId && !p.noWork && p.lines.length > 0);
  if (!last) return [];
  return last.lines.map((l) => ({
    ...l,
    id: newId(),
    dailyST: [],
    dailyOT: [],
    totalST: 0,
    totalOT: 0,
    grossThisProject: null,
    grossAllWork: null,
    deductions: null,
    netPay: null,
  }));
}

const MAPPABLE: PayrollField[] = [
  'workerName', 'lastName', 'firstName', 'workerId', 'classification', 'apprenticeFlag',
  'totalST', 'totalOT', 'totalHours', 'rateST', 'rateOT', 'otPay',
  'fringePlanHourly', 'fringeCashHourly', 'grossPay', 'grossThisProject', 'grossAllWork',
  'deductionsTotal', 'netPay', 'weekEnding', 'payrollNumber',
];

export function ImportPage({ view }: { view: ProjectView }) {
  useDocumentTitle('Add payrolls');
  const { data } = view;
  const pid = data.project.id;
  const toast = useToast();
  const route = window.location.hash.split('/import/')[1];
  const [presetContractor, presetWeek] = route ? decodeURIComponent(route).split('~') : [undefined, undefined];
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);

  const update = (id: string, patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d)));

  const withPresets = (d: Partial<Draft>): Partial<Draft> => ({
    contractorId: presetContractor && view.contractorById.has(presetContractor) ? presetContractor : '',
    weekEnding: presetWeek && isIsoDate(presetWeek) ? presetWeek : '',
    ...d,
  });

  const addFiles = (files: File[]) => {
    for (const file of files) {
      const draft = emptyDraft(withPresets({ file, fileName: file.name, state: 'reading', kind: isPdf(file) ? 'wh347-pdf' : /\.xlsx?$/i.test(file.name) ? 'xlsx' : 'csv' }));
      setDrafts((ds) => [...ds, draft]);
      void readDraft(draft, file);
    }
  };

  const readDraft = async (draft: Draft, file: File) => {
    try {
      const bytes = await fileBytes(file);
      if (isPdf(file)) {
        let parsed: PayrollPdfImport;
        try {
          parsed = await readPayrollPdf(bytes);
        } catch (e) {
          update(draft.id, { state: 'failed', error: explainPdfError(e) });
          return;
        }
        if (!parsed.recognized || (parsed.lines.length === 0 && !parsed.meta.noWork)) {
          const cid = draft.contractorId;
          update(draft.id, {
            state: 'ready',
            kind: 'keyed',
            notice: parsed.hasText
              ? 'This PDF is not the Rev. January 2025 WH-347 layout, so its lines cannot be read automatically. Key them in below; the PDF is kept on file.'
              : 'This PDF is a scan or image with no text layer. Key the lines in below; the PDF is kept on file.',
            warnings: parsed.warnings,
            lines: cid ? carryForward(view, cid) : [],
            weekEnding: draft.weekEnding || dateFromFileName(file.name) || '',
          });
          return;
        }
        const m = parsed.meta;
        const contractor = matchContractor(m.businessName, data.contractors);
        update(draft.id, (d) => ({
          state: 'ready',
          kind: 'wh347-pdf',
          detectedContractor: m.businessName,
          contractorId: d.contractorId || contractor?.id || '',
          weekEnding: m.weekEnding ?? d.weekEnding,
          payrollNumber: m.payrollNumber ?? '',
          signed: m.signed ?? false,
          isFinal: m.isFinal,
          noWork: m.noWork,
          warnings: parsed.warnings,
          uncertain: parsed.lowConfidence.map((u) => `Worker ${u.row + 1} (${parsed.lines[u.row]?.workerName || 'row'}): ${u.field} — ${u.reason}`),
          lines: parsed.lines.map(({ entryNo: _e, lastName: _l, firstName: _f, middleInitial: _m, deductionDetail: _d, source: _s, ...rest }) => ({ ...rest, id: newId() })),
        }));
        return;
      }
      await readSpreadsheetDraft(draft, file, bytes);
    } catch (e) {
      update(draft.id, { state: 'failed', error: (e as Error).message });
    }
  };

  const readSpreadsheetDraft = async (draft: Draft, file: File, bytes: Uint8Array, columnMap?: ColumnMap) => {
    let result = await importPayrollFile(file.name, bytes, { idFactory: newId, columnMap });
    // A layout seen before (same header signature) reuses the mapping the reviewer confirmed.
    let rememberedFor: string | null = null;
    if (!columnMap && result.headerSignature) {
      const profile = data.importProfiles.find((p) => p.headerSignature === result.headerSignature);
      if (profile) {
        result = await importPayrollFile(file.name, bytes, { idFactory: newId, columnMap: profile.columnMap });
        rememberedFor = profile.contractorId;
      }
    }
    if (result.status !== 'ok') {
      update(draft.id, { state: result.status === 'no-header' ? 'ready' : 'failed', error: result.message, table: result, warnings: result.warnings, kind: result.sourceKind ?? 'csv' });
      if (result.status === 'no-header') setMapping(draft.id);
      return;
    }
    const contractor =
      (rememberedFor && view.contractorById.get(rememberedFor)) || matchContractor(result.meta.contractorName ?? file.name.replace(/\.[a-z]+$/i, ''), data.contractors);
    update(draft.id, (d) => ({
      state: 'ready',
      error: null,
      kind: result.sourceKind ?? 'csv',
      table: result,
      detectedContractor: result.meta.contractorName,
      contractorId: d.contractorId || contractor?.id || '',
      weekEnding: result.meta.weekEnding || d.weekEnding || dateFromFileName(file.name) || '',
      payrollNumber: result.meta.payrollNumber ?? d.payrollNumber,
      warnings: [
        ...(rememberedFor ? [`Columns matched using the mapping saved for ${view.contractorById.get(rememberedFor)?.name ?? 'this layout'}.`] : []),
        ...(result.meta.weekEndings.length > 1 ? [`The file covers ${result.meta.weekEndings.length} different weeks (${result.meta.weekEndings.map(formatDate).join(', ')}). Import one week per payroll.`] : []),
        ...result.warnings,
      ],
      lines: result.lines,
      signed: d.signed,
    }));
  };

  const remap = async (draft: Draft, columnMap: ColumnMap) => {
    if (!draft.file) return;
    update(draft.id, { state: 'reading' });
    await readSpreadsheetDraft(draft, draft.file, await fileBytes(draft.file), columnMap);
  };

  const duplicateOf = (d: Draft): Payroll | null =>
    (d.contractorId && isIsoDate(d.weekEnding) && data.payrolls.find((p) => p.contractorId === d.contractorId && p.weekEnding === d.weekEnding && !data.payrolls.some((q) => q.supersedesPayrollId === p.id))) || null;

  const problems = (d: Draft): string[] => {
    const out: string[] = [];
    if (!d.contractorId) out.push('Choose the contractor.');
    if (!isIsoDate(d.weekEnding)) out.push('Enter the week ending date.');
    if (!d.noWork && d.lines.length === 0) out.push('No worker lines yet. Use "Edit lines" to key them in.');
    if (!d.noWork && d.lines.some((l) => !l.workerName.trim())) out.push('A worker line has no name.');
    return out;
  };

  const save = async (d: Draft): Promise<boolean> => {
    if (problems(d).length) return false;
    const now = nowIso();
    const sourceKind: PayrollSourceKind = d.kind === 'no-work' || d.kind === 'keyed' ? 'manual' : d.kind;
    const payroll: Payroll = {
      id: newId(),
      projectId: pid,
      contractorId: d.contractorId,
      payrollNumber: d.payrollNumber.trim(),
      weekEnding: d.weekEnding,
      receivedDate: d.receivedDate || null,
      noWork: d.noWork,
      isFinal: d.isFinal,
      supersedesPayrollId: d.supersedesPayrollId,
      statementOfComplianceSigned: d.signed,
      source: { kind: sourceKind, fileName: d.file?.name ?? null, fileId: null },
      lines: d.noWork ? [] : d.lines,
      status: 'received',
      reviewNote: '',
      reviewedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await projectStore.mutate(async () => {
      const p = await savePayroll(payroll, d.file ? { name: d.file.name, type: d.file.type || 'application/octet-stream', data: d.file } : undefined);
      if (d.table && d.table.headerSignature && (d.kind === 'csv' || d.kind === 'xlsx')) {
        await saveImportProfile(pid, d.contractorId, d.table.headerSignature, d.table.columnMap);
      }
      return p;
    });
    update(d.id, { state: 'saved', savedPayrollId: saved.id });
    return true;
  };

  const saveOne = async (d: Draft) => {
    try {
      if (await save(d)) toast(`Saved payroll for ${view.contractorById.get(d.contractorId)?.name}, week ending ${formatDate(d.weekEnding)}`);
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`, 'bad');
    }
  };

  const saveAll = async () => {
    let n = 0;
    for (const d of drafts) {
      if (d.state === 'ready' && problems(d).length === 0) {
        try {
          if (await save(d)) n++;
        } catch (e) {
          toast(`Could not save ${d.fileName || 'a payroll'}: ${(e as Error).message}`, 'bad');
        }
      }
    }
    if (n) toast(`Saved ${n} payroll${n === 1 ? '' : 's'}`);
  };

  const addContractorFromDraft = async (d: Draft) => {
    const name = (d.detectedContractor ?? '').trim();
    if (!name) return;
    const c = { ...blankContractor(pid), name, startDate: null };
    await projectStore.mutate(() => saveContractor(c));
    update(d.id, (cur) => ({ contractorId: c.id, lines: cur.kind === 'keyed' && cur.lines.length === 0 ? carryForward(view, c.id) : cur.lines }));
    toast(`Added contractor ${name}. Set its start date on the Contractors page so missing weeks are tracked.`);
  };

  const editingDraft = drafts.find((d) => d.id === editing) ?? null;
  const mappingDraft = drafts.find((d) => d.id === mapping) ?? null;
  const readyCount = drafts.filter((d) => d.state === 'ready' && problems(d).length === 0).length;
  const presetName = presetContractor ? view.contractorById.get(presetContractor)?.name : null;

  return (
    <div className="page">
      <PageHeader
        title="Add payrolls"
        subtitle="Drop in payrolls exactly as contractors send them. Nothing leaves this computer."
        actions={
          <>
            <Button icon="download" onClick={() => downloadFile('Wagebench payroll template.csv', templateCsv(), 'text/csv;charset=utf-8')} title="A spreadsheet layout you can ask contractors to send; it maps one-to-one">
              Spreadsheet template
            </Button>
            {readyCount > 1 && <Button variant="primary" onClick={saveAll}>Save {readyCount} ready payrolls</Button>}
          </>
        }
      />
      {presetName && presetWeek && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="info">Adding the payroll for <strong>{presetName}</strong>, week ending <strong>{formatDate(presetWeek)}</strong>.</Alert>
        </div>
      )}
      {data.contractors.length === 0 && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="warn">
            No contractors yet. You can add one from a payroll's business name below, but adding them on the <a href={`#${projectPath(pid, 'contractors')}`}>Contractors</a> page with start dates lets Wagebench detect missing weeks.
          </Alert>
        </div>
      )}
      <FileDrop onFiles={addFiles} accept=".pdf,.csv,.tsv,.txt,.xlsx,.xlsm,application/pdf,text/csv">
        <strong>Drop WH-347 PDFs, CSV or Excel payroll exports here</strong>
        <div className="small" style={{ marginTop: 4 }}>Several files at once is fine. Scanned PDFs are kept on file and keyed in with last week's crew filled in.</div>
      </FileDrop>
      <div className="row" style={{ margin: '12px 0 16px' }}>
        <Button icon="edit" onClick={() => { const d = emptyDraft(withPresets({ kind: 'keyed' })); if (d.contractorId) d.lines = carryForward(view, d.contractorId); setDrafts((ds) => [...ds, d]); setEditing(d.id); }}>
          Key in a payroll
        </Button>
        <Button onClick={() => setDrafts((ds) => [...ds, emptyDraft(withPresets({ kind: 'no-work', noWork: true }))])}>Record a "no work" week</Button>
      </div>

      {drafts.length === 0 ? (
        <Panel>
          <EmptyState title="Nothing added yet">
            WH-347 PDFs (Rev. January 2025) are read automatically. Spreadsheets are matched column by column, and the mapping is remembered for that contractor. Every line is then checked against the wage determination.
          </EmptyState>
        </Panel>
      ) : (
        <div className="stack">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              view={view}
              problems={problems(d)}
              duplicate={duplicateOf(d)}
              onChange={(patch) => update(d.id, patch)}
              onContractor={(cid) => update(d.id, (cur) => ({ contractorId: cid, lines: cur.kind === 'keyed' && cur.lines.length === 0 && cid ? carryForward(view, cid) : cur.lines }))}
              onEdit={() => setEditing(d.id)}
              onMap={() => setMapping(d.id)}
              onSave={() => void saveOne(d)}
              onDiscard={() => setDrafts((ds) => ds.filter((x) => x.id !== d.id))}
              onAddContractor={() => void addContractorFromDraft(d)}
            />
          ))}
        </div>
      )}

      <Modal open={editingDraft !== null} wide title="Payroll lines" onClose={() => setEditing(null)}>
        {editingDraft && (
          <PayrollEditor
            key={editingDraft.id}
            contractors={data.contractors}
            value={{
              header: {
                contractorId: editingDraft.contractorId,
                payrollNumber: editingDraft.payrollNumber,
                weekEnding: editingDraft.weekEnding,
                receivedDate: editingDraft.receivedDate || null,
                noWork: editingDraft.noWork,
                isFinal: editingDraft.isFinal,
                statementOfComplianceSigned: editingDraft.signed,
              },
              lines: editingDraft.lines,
            }}
            saveLabel="Use these lines"
            onCancel={() => setEditing(null)}
            onSave={(v: EditorValue) => {
              update(editingDraft.id, {
                contractorId: v.header.contractorId,
                payrollNumber: v.header.payrollNumber,
                weekEnding: v.header.weekEnding,
                receivedDate: v.header.receivedDate ?? '',
                noWork: v.header.noWork,
                isFinal: v.header.isFinal,
                signed: v.header.statementOfComplianceSigned,
                lines: v.lines,
                uncertain: [],
              });
              setEditing(null);
            }}
          />
        )}
      </Modal>
      <Modal open={mappingDraft !== null} wide title="Match spreadsheet columns" onClose={() => setMapping(null)}>
        {mappingDraft?.table && (
          <ColumnMapper
            result={mappingDraft.table}
            onCancel={() => setMapping(null)}
            onApply={(map) => {
              setMapping(null);
              void remap(mappingDraft, map);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function DraftCard({
  draft: d,
  view,
  problems,
  duplicate,
  onChange,
  onContractor,
  onEdit,
  onMap,
  onSave,
  onDiscard,
  onAddContractor,
}: {
  draft: Draft;
  view: ProjectView;
  problems: string[];
  duplicate: Payroll | null;
  onChange: (patch: Partial<Draft>) => void;
  onContractor: (id: string) => void;
  onEdit: () => void;
  onMap: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onAddContractor: () => void;
}) {
  const pid = view.data.project.id;
  const kindLabel: Record<DraftKind, string> = { 'wh347-pdf': 'WH-347 PDF', csv: 'CSV', xlsx: 'Excel', keyed: 'Keyed in', 'no-work': 'No work week' };
  const hours = useMemo(() => ({ st: sum(d.lines.map((l) => l.totalST)), ot: sum(d.lines.map((l) => l.totalOT)) }), [d.lines]);
  const gross = sum(d.lines.map((l) => l.grossThisProject ?? 0));
  const title = d.fileName || (d.kind === 'no-work' ? '"No work performed" payroll' : 'Keyed-in payroll');

  if (d.state === 'saved') {
    return (
      <Panel>
        <div className="row spread">
          <span>
            <Badge tone="good">Saved</Badge> <strong>{title}</strong> — {view.contractorById.get(d.contractorId)?.name}, week ending {formatDate(d.weekEnding)}
          </span>
          {d.savedPayrollId && <Button size="sm" variant="primary" onClick={() => navigate(projectPath(pid, 'payrolls', d.savedPayrollId!))}>Review it →</Button>}
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title={
        <div style={{ flex: 1 }}>
          <h3 style={{ display: 'inline' }}>{title}</h3> <Badge tone="neutral">{kindLabel[d.kind]}</Badge>
          {d.state === 'reading' && <span className="muted small"> reading…</span>}
        </div>
      }
      actions={<Button size="sm" variant="ghost" icon="x" onClick={onDiscard} aria-label={`Discard ${title}`}>Discard</Button>}
      footer={
        d.state === 'failed' ? undefined : (
          <>
            {(d.kind === 'csv' || d.kind === 'xlsx') && d.table && <Button onClick={onMap}>Match columns…</Button>}
            {!d.noWork && <Button icon="edit" onClick={onEdit} disabled={d.state !== 'ready'}>{d.lines.length ? 'Check / edit lines' : 'Key in lines'}</Button>}
            <Button variant="primary" onClick={onSave} disabled={d.state !== 'ready' || problems.length > 0}>
              {d.supersedesPayrollId ? 'Save correction' : 'Save payroll'}
            </Button>
          </>
        )
      }
    >
      {d.state === 'failed' ? (
        <Alert tone="bad">{d.error ?? 'The file could not be read.'}</Alert>
      ) : d.state === 'reading' ? (
        <p className="muted">Reading the file…</p>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {d.notice && <Alert tone="info">{d.notice}</Alert>}
          {d.error && <Alert tone="warn">{d.error}</Alert>}
          <div className="form-grid">
            <Field label="Contractor" hint={d.detectedContractor ? `Business name on the payroll: ${d.detectedContractor}` : undefined}>
              <select className="select" value={d.contractorId} onChange={(e) => onContractor(e.target.value)}>
                <option value="">— Choose —</option>
                {view.data.contractors.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Week ending">
              <input className="input" type="date" value={d.weekEnding} onChange={(e) => onChange({ weekEnding: e.target.value })} />
            </Field>
            <Field label="Payroll no.">
              <input className="input" value={d.payrollNumber} onChange={(e) => onChange({ payrollNumber: e.target.value })} />
            </Field>
            <Field label="Date received">
              <input className="input" type="date" value={d.receivedDate} onChange={(e) => onChange({ receivedDate: e.target.value })} />
            </Field>
          </div>
          {!d.contractorId && d.detectedContractor && (
            <div>
              <Button size="sm" icon="plus" onClick={onAddContractor}>Add "{d.detectedContractor}" as a contractor</Button>
            </div>
          )}
          <div className="row" style={{ gap: 18 }}>
            <label className="check"><input type="checkbox" checked={d.signed} onChange={(e) => onChange({ signed: e.target.checked })} /> Statement of Compliance signed</label>
            <label className="check"><input type="checkbox" checked={d.isFinal} onChange={(e) => onChange({ isFinal: e.target.checked })} /> Final payroll</label>
            {d.kind === 'wh347-pdf' && !d.signed && <span className="small cell-warn">No signature was found on page 2 of the PDF.</span>}
          </div>
          {duplicate && (
            <Alert tone="warn">
              A payroll for this contractor and week is already on file (payroll {duplicate.payrollNumber || 'without a number'}, received {formatDate(duplicate.receivedDate)}).{' '}
              <label className="check" style={{ marginLeft: 6 }}>
                <input type="checkbox" checked={d.supersedesPayrollId === duplicate.id} onChange={(e) => onChange({ supersedesPayrollId: e.target.checked ? duplicate.id : null })} />
                This is a corrected payroll that replaces it
              </label>
            </Alert>
          )}
          {!d.noWork && (
            <p className="small" style={{ margin: 0 }}>
              <strong>{d.lines.length}</strong> worker line{d.lines.length === 1 ? '' : 's'} · {formatHours(hours.st)} ST / {formatHours(hours.ot)} OT hours
              {gross > 0 && <> · gross {formatMoney(gross)}</>}
              {d.lines.length > 0 && <span className="muted"> · {[...new Set(d.lines.map((l) => l.classification || '(blank)'))].slice(0, 5).join(', ')}</span>}
            </p>
          )}
          {d.uncertain.length > 0 && (
            <Alert tone="warn">
              <strong>Check these values against the PDF</strong> (open "Check / edit lines"):
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {d.uncertain.slice(0, 6).map((u) => <li key={u}>{u}</li>)}
                {d.uncertain.length > 6 && <li>…and {d.uncertain.length - 6} more</li>}
              </ul>
            </Alert>
          )}
          {d.warnings.length > 0 && (
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>{d.warnings.length} note{d.warnings.length === 1 ? '' : 's'} from reading the file</summary>
              <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {d.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}
          {problems.length > 0 && <div className="small cell-warn">{problems.join(' ')}</div>}
        </div>
      )}
    </Panel>
  );
}

function ColumnMapper({ result, onApply, onCancel }: { result: PayrollFileImportResult; onApply: (m: ColumnMap) => void; onCancel: () => void }) {
  const [map, setMap] = useState<ColumnMap>(() => ({ ...result.columnMap }));
  const labels = new Map(FIELD_INFO.map((f) => [f.field, f.label]));
  const headers = result.headers;
  const set = (field: PayrollField, col: number | undefined) =>
    setMap((m) => {
      const next = { ...m } as Record<string, unknown>;
      if (col === undefined) delete next[field];
      else next[field] = col;
      return next as ColumnMap;
    });
  if (headers.length === 0) {
    return <EmptyState title="No header row found">Save the file with one row of column names above the worker rows, then import it again.</EmptyState>;
  }
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Tell Wagebench which column holds each value. Only worker name (or last and first name), hours and the hourly rate are required. The mapping is remembered for this contractor's layout.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Value</th><th>Column in the file</th><th className="num">Detected</th></tr>
          </thead>
          <tbody>
            {MAPPABLE.map((field) => {
              const current = (map as Record<string, unknown>)[field];
              const conf = result.confidence[field];
              return (
                <tr key={field}>
                  <td>{labels.get(field) ?? field}</td>
                  <td>
                    <select className="select sm" value={typeof current === 'number' ? String(current) : ''} onChange={(e) => set(field, e.target.value === '' ? undefined : Number(e.target.value))} aria-label={`Column for ${labels.get(field) ?? field}`}>
                      <option value="">— none —</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>{`${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}: ${h || '(blank header)'}`}</option>
                      ))}
                    </select>
                  </td>
                  <td className="num small">{conf === undefined ? '' : conf >= 0.9 ? <Badge tone="good">sure</Badge> : <Badge tone="warn">guess</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => onApply(map)}>Re-read the file</Button>
      </div>
    </div>
  );
}
