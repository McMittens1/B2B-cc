import { useMemo, useState } from 'react';
import { daysBetween, formatDate } from '../../engine/dates';
import type { PayrollStatus } from '../../engine/types';
import { navigate, projectPath, useDocumentTitle } from '../router';
import type { ProjectView } from '../store';
import { Badge, Button, EmptyState, Money, PageHeader, Panel, PayrollStatusBadge, PAYROLL_STATUS_LABEL } from '../ui';

type ResultFilter = 'all' | 'violations' | 'warnings' | 'clean';

export function PayrollsPage({ view }: { view: ProjectView }) {
  useDocumentTitle('Payrolls');
  const { data, evaluation, contractorById } = view;
  const [contractor, setContractor] = useState('');
  const [status, setStatus] = useState<'' | PayrollStatus>('');
  const [result, setResult] = useState<ResultFilter>('all');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.payrolls.filter((p) => {
      const s = evaluation.payrolls.get(p.id);
      if (contractor && p.contractorId !== contractor) return false;
      if (status && p.status !== status) return false;
      if (result !== 'all' && s?.state !== result) return false;
      if (needle) {
        const hay = `${contractorById.get(p.contractorId)?.name ?? ''} ${p.payrollNumber} ${p.source.fileName ?? ''} ${p.lines.map((l) => l.workerName).join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [data.payrolls, evaluation.payrolls, contractor, status, result, q, contractorById]);

  const pid = data.project.id;
  return (
    <div className="page">
      <PageHeader
        title="Payrolls"
        subtitle={`${data.payrolls.length} certified payrolls received from ${data.contractors.length} contractors`}
        actions={<Button variant="primary" icon="import" onClick={() => navigate(projectPath(pid, 'import'))}>Add payrolls</Button>}
      />
      {data.payrolls.length === 0 ? (
        <Panel>
          <EmptyState title="No payrolls yet" actions={<Button variant="primary" onClick={() => navigate(projectPath(pid, 'import'))}>Add the first payrolls</Button>}>
            Drop in WH-347 PDFs, spreadsheets or payroll exports exactly as contractors send them.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <div className="toolbar">
            <input className="input grow" placeholder="Search contractor, payroll no., worker, file…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search payrolls" />
            <select className="select" value={contractor} onChange={(e) => setContractor(e.target.value)} aria-label="Filter by contractor">
              <option value="">All contractors</option>
              {data.contractors.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select className="select" value={result} onChange={(e) => setResult(e.target.value as ResultFilter)} aria-label="Filter by result">
              <option value="all">Any result</option>
              <option value="violations">With violations</option>
              <option value="warnings">Warnings only</option>
              <option value="clean">No exceptions</option>
            </select>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as PayrollStatus | '')} aria-label="Filter by review status">
              <option value="">Any review status</option>
              {(Object.keys(PAYROLL_STATUS_LABEL) as PayrollStatus[]).map((s) => (
                <option key={s} value={s}>{PAYROLL_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <Panel bodyClass="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Week ending</th>
                  <th>Contractor</th>
                  <th>Payroll no.</th>
                  <th>Received</th>
                  <th className="num">Workers</th>
                  <th>Source</th>
                  <th>Result</th>
                  <th className="num">Owed</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const s = evaluation.payrolls.get(p.id);
                  const late = p.receivedDate ? daysBetween(p.weekEnding, p.receivedDate) : null;
                  return (
                    <tr
                      key={p.id}
                      className={`clickable ${s?.state === 'violations' ? 'row-bad' : s?.state === 'warnings' ? 'row-warn' : ''}`}
                      onClick={() => navigate(projectPath(pid, 'payrolls', p.id))}
                    >
                      <td className="nowrap">
                        <a href={`#${projectPath(pid, 'payrolls', p.id)}`} onClick={(e) => e.stopPropagation()}>{formatDate(p.weekEnding)}</a>
                      </td>
                      <td>{contractorById.get(p.contractorId)?.name ?? 'Unknown'}</td>
                      <td>
                        {p.payrollNumber || <span className="faint">—</span>}
                        {p.isFinal && <> <Badge tone="neutral">Final</Badge></>}
                        {p.supersedesPayrollId && <> <Badge tone="accent">Correction</Badge></>}
                      </td>
                      <td className="nowrap">
                        {formatDate(p.receivedDate)}
                        {late !== null && late > data.project.settings.lateAfterDays && <div className="sub cell-warn">{late} days after week end</div>}
                      </td>
                      <td className="num">{p.noWork ? <span className="faint">no work</span> : p.lines.length}</td>
                      <td className="small">{sourceLabel(p.source.kind)}{p.source.fileName && <div className="sub" title={p.source.fileName}>{truncate(p.source.fileName, 28)}</div>}</td>
                      <td>
                        {s?.state === 'superseded' ? (
                          <Badge tone="neutral">Superseded</Badge>
                        ) : s?.state === 'violations' ? (
                          <Badge tone="bad">{s.violations} violation{s.violations === 1 ? '' : 's'}</Badge>
                        ) : s?.state === 'warnings' ? (
                          <Badge tone="warn">{s.warnings} warning{s.warnings === 1 ? '' : 's'}</Badge>
                        ) : (
                          <Badge tone="good">No exceptions</Badge>
                        )}
                      </td>
                      <td className="num cell-bad"><Money value={s?.owed ?? 0} /></td>
                      <td><PayrollStatusBadge status={p.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <EmptyState title="No payrolls match these filters" />}
          </Panel>
        </>
      )}
    </div>
  );
}

function sourceLabel(kind: string): string {
  return kind === 'wh347-pdf' ? 'WH-347 PDF' : kind === 'csv' ? 'CSV' : kind === 'xlsx' ? 'Excel' : 'Keyed in';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
