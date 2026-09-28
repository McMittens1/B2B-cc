import { useMemo, useState } from 'react';
import { deletePayroll, savePayroll, setDisposition, setMapping, setPayrollStatus } from '../../db/repo';
import { newId, nowIso } from '../../db/db';
import { daysBetween, formatDate } from '../../engine/dates';
import { suggestClassifications } from '../../engine/mapping';
import { formatHours, formatMoney, formatRate } from '../../engine/money';
import { NOT_ON_WD, type Finding, type Payroll, type PayrollLine, type Severity } from '../../engine/types';
import type { LineAnalysis } from '../../engine/checks/evaluate';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { projectStore, type ProjectView } from '../store';
import { PayrollEditor, type EditorValue } from '../PayrollEditor';
import {
  Alert,
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Modal,
  Money,
  PageHeader,
  Panel,
  PayrollStatusBadge,
  RULE_LABELS,
  SeverityBadge,
  useToast,
} from '../ui';
import { downloadStampedPayroll, openStoredFile, downloadLetter } from '../actions';

const SEVERITY_ORDER: Severity[] = ['violation', 'warning', 'info'];

export function PayrollReviewPage({ view, payrollId }: { view: ProjectView; payrollId: string }) {
  const { data, evaluation, contractorById, dismissed } = view;
  const payroll = view.payrollById.get(payrollId);
  const contractor = payroll ? contractorById.get(payroll.contractorId) : undefined;
  useDocumentTitle(payroll ? `Payroll ${payroll.payrollNumber} — ${contractor?.name ?? ''}` : 'Payroll');
  const toast = useToast();
  const [editing, setEditing] = useState<'edit' | 'correction' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState(payroll?.reviewNote ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const pid = data.project.id;

  const findings = useMemo(
    () => [...evaluation.findings, ...evaluation.historicalFindings].filter((f) => f.payrollId === payrollId),
    [evaluation.findings, evaluation.historicalFindings, payrollId],
  );
  const byLine = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of findings) if (f.lineId) m.set(f.lineId, [...(m.get(f.lineId) ?? []), f]);
    return m;
  }, [findings]);

  if (!payroll) {
    return (
      <div className="page">
        <EmptyState title="Payroll not found" actions={<Button onClick={() => navigate(projectPath(pid, 'payrolls'))}>Back to payrolls</Button>} />
      </div>
    );
  }

  const summary = evaluation.payrolls.get(payroll.id);
  const open = findings.filter((f) => !dismissed.has(f.key));
  const late = payroll.receivedDate ? daysBetween(payroll.weekEnding, payroll.receivedDate) : null;
  const superseding = data.payrolls.find((p) => p.supersedesPayrollId === payroll.id);
  const supersedes = payroll.supersedesPayrollId ? view.payrollById.get(payroll.supersedesPayrollId) : null;
  const wd = data.wd?.parsed ?? null;

  const setStatus = async (status: Payroll['status']) => {
    setBusy(status);
    try {
      await projectStore.mutate(() => setPayrollStatus(payroll, status, note));
      toast(status === 'correction-requested' ? 'Marked as correction requested' : `Marked ${status}`);
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async (v: EditorValue) => {
    if (editing === 'correction') {
      const corrected: Payroll = {
        ...payroll,
        ...v.header,
        id: newId(),
        lines: v.lines.map((l) => ({ ...l, id: newId() })),
        supersedesPayrollId: payroll.id,
        source: { kind: 'manual', fileName: null, fileId: null },
        status: 'received',
        reviewNote: '',
        reviewedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await projectStore.mutate(() => savePayroll(corrected));
      toast('Corrected payroll recorded. The original is kept but no longer counted.');
      setEditing(null);
      navigate(projectPath(pid, 'payrolls', corrected.id));
    } else {
      await projectStore.mutate(() => savePayroll({ ...payroll, ...v.header, lines: v.lines }));
      toast('Payroll updated');
      setEditing(null);
    }
  };

  const dismiss = async (f: Finding, yes: boolean) => {
    await projectStore.mutate(() => setDisposition(pid, f.key, yes));
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(`${label} failed: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        crumbs={
          <>
            <a href={`#${projectPath(pid, 'payrolls')}`}>Payrolls</a> / {contractor?.name ?? 'Unknown contractor'}
          </>
        }
        title={
          <>
            Week ending {formatDate(payroll.weekEnding)}{' '}
            <span className="muted" style={{ fontWeight: 400 }}>· Payroll {payroll.payrollNumber || '(no number)'}</span>
          </>
        }
        subtitle={contractor?.name}
        actions={
          <>
            <Button icon="stamp" disabled={busy !== null} onClick={() =>
                run('Stamped PDF', async () => {
                  const problem = await downloadStampedPayroll(view, payroll);
                  toast(problem ? `Stamped PDF downloaded without the original: ${problem}` : 'Stamped PDF downloaded', problem ? 'bad' : undefined);
                })
              }
            >
              Stamped PDF
            </Button>
            {open.some((f) => f.severity === 'violation') && (
              <Button icon="mail" disabled={busy !== null} onClick={() => run('Letter', () => downloadLetter(view, 'correction-request', payroll.contractorId, 'docx'))}>
                Correction letter
              </Button>
            )}
            <Button icon="edit" onClick={() => setEditing('edit')}>Edit</Button>
          </>
        }
      />

      {superseding && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="info">
            This payroll was replaced by a correction received {formatDate(superseding.receivedDate)}. Its findings are kept for the record but no longer counted as open; any underpayments stay in the restitution ledger.{' '}
            <a href={`#${projectPath(pid, 'payrolls', superseding.id)}`}>Open the corrected payroll</a>
          </Alert>
        </div>
      )}
      {supersedes && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="info">
            This is a correction of payroll {supersedes.payrollNumber || ''} received {formatDate(supersedes.receivedDate)}.{' '}
            <a href={`#${projectPath(pid, 'payrolls', supersedes.id)}`}>Open the original</a>
          </Alert>
        </div>
      )}
      {!wd && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="bad">No wage determination on this project yet, so rates are not checked. <a href={`#${projectPath(pid, 'wd')}`}>Add it</a>.</Alert>
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <div className="label">Result</div>
          <div className="value" style={{ fontSize: 17, marginTop: 6 }}>
            {summary?.state === 'superseded' ? (
              <Badge tone="neutral">Superseded</Badge>
            ) : summary?.state === 'violations' ? (
              <Badge tone="bad">{summary.violations} violation{summary.violations === 1 ? '' : 's'}</Badge>
            ) : summary?.state === 'warnings' ? (
              <Badge tone="warn">{summary.warnings} warning{summary.warnings === 1 ? '' : 's'}</Badge>
            ) : (
              <Badge tone="good">No exceptions</Badge>
            )}
          </div>
          <div className="sub">{payroll.noWork ? 'No work performed' : `${payroll.lines.length} worker lines checked`}</div>
        </div>
        <div className="kpi">
          <div className="label">Wages owed on this payroll</div>
          <div className={`value ${summary?.owed ? 'bad' : ''}`}>{formatMoney(summary?.owed ?? 0)}</div>
          <div className="sub">Computed from the WD, hours and rates shown</div>
        </div>
        <div className="kpi">
          <div className="label">Received</div>
          <div className="value" style={{ fontSize: 17, marginTop: 6 }}>{formatDate(payroll.receivedDate)}</div>
          <div className={`sub ${late !== null && late > data.project.settings.lateAfterDays ? 'cell-warn' : ''}`}>
            {late !== null ? `${late} days after the week ended` : 'Date received not recorded'}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Source</div>
          <div className="value" style={{ fontSize: 14, marginTop: 6, fontWeight: 500 }}>
            {payroll.source.fileId ? (
              <a href="#" onClick={(e) => { e.preventDefault(); void run('Open file', () => openStoredFile(payroll.source.fileId!)); }}>
                {payroll.source.fileName}
              </a>
            ) : (
              'Keyed in'
            )}
          </div>
          <div className="sub">
            Statement of Compliance: {payroll.statementOfComplianceSigned ? 'signed' : <span className="cell-bad">not signed</span>}
          </div>
        </div>
      </div>

      {payroll.noWork ? (
        <Panel><EmptyState title='"No work performed" payroll'>The contractor reported no work on the project this week.</EmptyState></Panel>
      ) : (
        <Panel title="Workers" bodyClass="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Classification</th>
                <th className="num">ST / OT hrs</th>
                <th className="num">Rate paid</th>
                <th className="num">WD rate</th>
                <th className="num">Fringe paid</th>
                <th className="num">WD fringe</th>
                <th className="num">OT rate</th>
                <th className="num">Owed</th>
              </tr>
            </thead>
            <tbody>
              {payroll.lines.map((line) => (
                <WorkerRow key={line.id} view={view} line={line} analysis={evaluation.lines.get(line.id)} findings={byLine.get(line.id) ?? []} contractorId={payroll.contractorId} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td className="num">
                  {formatHours(payroll.lines.reduce((s, l) => s + l.totalST, 0))} / {formatHours(payroll.lines.reduce((s, l) => s + l.totalOT, 0))}
                </td>
                <td colSpan={5} />
                <td className="num cell-bad"><Money value={summary?.owed ?? 0} /></td>
              </tr>
            </tfoot>
          </table>
        </Panel>
      )}

      <div className="grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <Panel title={`Findings (${open.length})`} bodyClass="">
          {findings.length === 0 ? (
            <EmptyState title="No exceptions">Every line meets the wage determination and the payroll is complete.</EmptyState>
          ) : (
            SEVERITY_ORDER.flatMap((sev) =>
              findings
                .filter((f) => f.severity === sev)
                .map((f) => {
                  const isDismissed = dismissed.has(f.key);
                  return (
                    <div key={f.key} className={`finding ${isDismissed ? 'dismissed' : ''}`}>
                      <SeverityBadge severity={f.severity} />
                      <div>
                        <div className="title">{f.title}</div>
                        <div className="small muted">{RULE_LABELS[f.ruleId]}</div>
                      </div>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {f.amountOwed > 0 && <span className="amount">{formatMoney(f.amountOwed)}</span>}
                        {f.severity !== 'violation' && (
                          <Button size="sm" variant="ghost" onClick={() => void dismiss(f, !isDismissed)}>
                            {isDismissed ? 'Restore' : 'Dismiss'}
                          </Button>
                        )}
                      </div>
                      <div className="detail">{f.detail}</div>
                    </div>
                  );
                }),
            )
          )}
        </Panel>
        <Panel
          title="Review"
          footer={
            <>
              <Button disabled={busy !== null} onClick={() => setStatus('correction-requested')}>Correction requested</Button>
              <Button disabled={busy !== null} onClick={() => setStatus('reviewed')}>Mark reviewed</Button>
              <Button variant="primary" disabled={busy !== null} onClick={() => setStatus('accepted')}>Accept payroll</Button>
            </>
          }
        >
          <div className="row spread" style={{ marginBottom: 10 }}>
            <span>Status: <PayrollStatusBadge status={payroll.status} /></span>
            {payroll.reviewedAt && <span className="small muted">Last reviewed {new Date(payroll.reviewedAt).toLocaleString()}</span>}
          </div>
          <label className="small muted" htmlFor="review-note">Reviewer note (appears on the review worksheet)</label>
          <textarea id="review-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called Ridgeline 9/22 re: fringe; corrected payroll promised by 9/29." />
          <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <Button size="sm" onClick={() => setEditing('correction')}>Record a corrected payroll…</Button>
            <Button size="sm" variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>Delete payroll</Button>
          </div>
        </Panel>
      </div>

      <Modal open={editing !== null} wide title={editing === 'correction' ? 'Corrected payroll' : 'Edit payroll'} onClose={() => setEditing(null)}>
        {editing === 'correction' && (
          <div style={{ marginBottom: 12 }}>
            <Alert tone="info">Enter the payroll as corrected by the contractor. The original stays on file, marked as superseded, and only the correction is counted.</Alert>
          </div>
        )}
        {editing && (
          <PayrollEditor
            key={editing}
            contractors={data.contractors}
            lockContractor
            value={{
              header: {
                contractorId: payroll.contractorId,
                payrollNumber: payroll.payrollNumber,
                weekEnding: payroll.weekEnding,
                receivedDate: editing === 'correction' ? new Date().toISOString().slice(0, 10) : payroll.receivedDate,
                noWork: payroll.noWork,
                isFinal: payroll.isFinal,
                statementOfComplianceSigned: payroll.statementOfComplianceSigned,
              },
              lines: payroll.lines,
            }}
            saveLabel={editing === 'correction' ? 'Save corrected payroll' : 'Save changes'}
            onSave={saveEdit}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
      <ConfirmModal
        open={confirmDelete}
        danger
        title="Delete this payroll?"
        confirmLabel="Delete payroll"
        message={<p>This removes payroll {payroll.payrollNumber || ''} for the week ending {formatDate(payroll.weekEnding)} and its original file. Restitution notes tied to its findings will no longer appear. This cannot be undone.</p>}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await projectStore.mutate(() => deletePayroll(payroll));
          toast('Payroll deleted');
          navigate(projectPath(pid, 'payrolls'), { replace: true });
        }}
      />
    </div>
  );
}

function WorkerRow({ view, line, analysis, findings, contractorId }: { view: ProjectView; line: PayrollLine; analysis: LineAnalysis | undefined; findings: Finding[]; contractorId: string }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const worst = findings.some((f) => f.severity === 'violation') ? 'bad' : findings.some((f) => f.severity === 'warning') ? 'warn' : '';
  const c = analysis?.classification;
  const wd = view.data.wd?.parsed;
  const needsMap = !c && analysis?.mappingSource === 'none' && wd;
  const suggestions = useMemo(() => (needsMap && wd ? suggestClassifications(line.classification, wd.classifications, 5) : []), [needsMap, wd, line.classification]);
  const baseShort = analysis?.requiredBase !== null && analysis?.requiredBase !== undefined && line.rateST + 0.005 < analysis.requiredBase;
  const fringeShort =
    analysis?.requiredFringe !== null && analysis?.requiredFringe !== undefined &&
    line.fringePlanHourly + line.fringeCashHourly + Math.max(0, line.rateST - (analysis.requiredBase ?? 0)) + 0.005 < analysis.requiredFringe;

  const map = async (key: string) => {
    await projectStore.mutate(() => setMapping(view.data.project.id, contractorId, line.classification, key || null));
    toast(`"${line.classification}" matched for this contractor`);
  };

  return (
    <>
      <tr className={`${worst ? `row-${worst}` : ''} ${findings.length ? 'clickable' : ''}`} onClick={() => findings.length && setOpen((o) => !o)}>
        <td>
          <strong>{line.workerName || <em className="faint">unnamed</em>}</strong>
          {line.apprentice && <> <Badge tone="info">Apprentice</Badge></>}
          <div className="sub">ID {line.workerId || '—'}{findings.length > 0 && ` · ${findings.length} finding${findings.length === 1 ? '' : 's'} ${open ? '▾' : '▸'}`}</div>
        </td>
        <td style={{ minWidth: 200 }}>
          {line.classification || <em className="faint">blank</em>}
          {c ? (
            <div className="sub">→ {c.label}{c.scope ? ` (${c.scope})` : ''}</div>
          ) : analysis?.mappingSource === 'not-on-wd' ? (
            <div className="sub cell-bad">Not on WD — conformance needed</div>
          ) : needsMap ? (
            <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 4 }}>
              <select className="select sm" defaultValue="" onChange={(e) => void map(e.target.value)} aria-label={`Match ${line.classification} to a WD classification`}>
                <option value="">Match to WD classification…</option>
                {suggestions.map((s) => (
                  <option key={s.classification.key} value={s.classification.key}>{s.classification.label} ({formatRate(s.classification.baseRate)})</option>
                ))}
                <option value={NOT_ON_WD}>Not on the WD (conformance needed)</option>
              </select>
              <div className="sub"><a href={`#${projectPath(view.data.project.id, 'wd', 'mappings')}`}>See all classifications</a></div>
            </div>
          ) : null}
        </td>
        <td className="num">{formatHours(line.totalST)} / {formatHours(line.totalOT)}</td>
        <td className={`num ${baseShort ? 'cell-bad' : ''}`}>{formatRate(line.rateST)}</td>
        <td className="num">{analysis?.requiredBase != null ? formatRate(analysis.requiredBase) : <span className="faint">—</span>}</td>
        <td className={`num ${fringeShort ? 'cell-bad' : ''}`}>
          {formatRate(line.fringePlanHourly + line.fringeCashHourly)}
          {line.fringeCashHourly > 0 && <div className="sub">{formatRate(line.fringeCashHourly)} cash</div>}
        </td>
        <td className="num">{analysis?.requiredFringe != null ? formatRate(analysis.requiredFringe) : <span className="faint">—</span>}</td>
        <td className="num">{line.totalOT > 0 ? (analysis?.paidOT != null ? formatRate(analysis.paidOT) : <span className="faint">not shown</span>) : <span className="faint">—</span>}</td>
        <td className="num cell-bad"><Money value={analysis?.owed ?? 0} /></td>
      </tr>
      {open &&
        findings.map((f) => (
          <tr key={f.key} className="finding-detail">
            <td />
            <td colSpan={8} style={{ background: 'var(--surface-2)' }}>
              <SeverityBadge severity={f.severity} /> <strong>{RULE_LABELS[f.ruleId]}</strong>
              {f.amountOwed > 0 && <strong className="cell-bad"> · {formatMoney(f.amountOwed)}</strong>}
              <div className="small" style={{ marginTop: 4 }}>{f.detail}</div>
            </td>
          </tr>
        ))}
    </>
  );
}
