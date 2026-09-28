import { useMemo, useState } from 'react';
import { addDays, formatDate, weekday } from '../../engine/dates';
import { formatMoney } from '../../engine/money';
import type { ContractorWeeks, WeekCellState } from '../../engine/checks/evaluate';
import type { Finding } from '../../engine/types';
import { navigate, projectPath, useDocumentTitle } from '../router';
import type { ProjectView } from '../store';
import { Alert, Badge, Button, EmptyState, Money, Panel, PageHeader, RULE_LABELS, SeverityBadge } from '../ui';

/** Align week-ending dates from contractors with different pay weeks into shared columns (Fri–Sun → that Saturday). */
function weekBucket(date: string): string {
  const d = weekday(date);
  return d === 0 ? addDays(date, -1) : addDays(date, 6 - d);
}

const CELL_GLYPH: Record<WeekCellState, string> = {
  received: '✓',
  warnings: '!',
  violations: '✕',
  missing: '?',
  'no-work': '–',
  'not-due': '',
};

const CELL_TEXT: Record<WeekCellState, string> = {
  received: 'received, no exceptions',
  warnings: 'received with warnings',
  violations: 'received with violations',
  missing: 'missing — no payroll received',
  'no-work': '"no work performed" payroll',
  'not-due': 'not yet due',
};

export function OverviewPage({ view }: { view: ProjectView }) {
  const { data, evaluation, openFindings, ledger } = view;
  const { project } = data;
  useDocumentTitle(project.name);
  const [showAllWeeks, setShowAllWeeks] = useState(false);

  const violations = openFindings.filter((f) => f.severity === 'violation');
  const missing = openFindings.filter((f) => f.ruleId === 'missing-week');
  const unmapped = new Set(openFindings.filter((f) => f.ruleId === 'classification-unmapped').map((f) => f.title));
  const toReview = data.payrolls.filter((p) => p.status === 'received');
  const wd = data.wd?.parsed;

  const setupSteps = [
    { done: Boolean(wd), label: 'Add the wage determination', go: projectPath(project.id, 'wd') },
    { done: data.contractors.length > 0, label: 'List the prime and subcontractors', go: projectPath(project.id, 'contractors') },
    { done: data.payrolls.length > 0, label: 'Add the first certified payrolls', go: projectPath(project.id, 'import') },
  ];
  const setupIncomplete = setupSteps.some((s) => !s.done);

  const topFindings = useMemo(
    () =>
      [...violations]
        .filter((f) => f.ruleId !== 'missing-week')
        .sort((a, b) => b.amountOwed - a.amountOwed || (b.weekEnding ?? '').localeCompare(a.weekEnding ?? ''))
        .slice(0, 8),
    [violations],
  );

  return (
    <div className="page">
      <PageHeader
        title={project.name}
        subtitle={
          <>
            {[project.projectNumber, project.owner, project.fundingSource].filter(Boolean).join(' · ')}
            {wd && (
              <>
                {' · '}WD {wd.decisionNumber ?? '(unnumbered)'}
                {wd.currentModification !== null && ` Mod ${wd.currentModification}`}
              </>
            )}
          </>
        }
        actions={
          <>
            <Button icon="doc" onClick={() => navigate(projectPath(project.id, 'documents'))}>Letters & documents</Button>
            <Button variant="primary" icon="import" onClick={() => navigate(projectPath(project.id, 'import'))}>Add payrolls</Button>
          </>
        }
      />

      {setupIncomplete && (
        <Panel title="Set up this project" className="no-print">
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
            {setupSteps.map((s) => (
              <li key={s.label}>
                {s.done ? (
                  <span className="muted" style={{ textDecoration: 'line-through' }}>{s.label}</span>
                ) : (
                  <a href={`#${s.go}`}>{s.label}</a>
                )}
                {s.done && <span style={{ color: 'var(--good)', marginLeft: 6 }}>✓</span>}
              </li>
            ))}
          </ol>
        </Panel>
      )}

      <div className="kpis" style={{ marginTop: setupIncomplete ? 16 : 0 }}>
        <a className="kpi" href={`#${projectPath(project.id, 'exceptions')}`}>
          <div className="label">Open violations</div>
          <div className={`value ${violations.length ? 'bad' : ''}`}>{violations.length}</div>
          <div className="sub">{openFindings.length - violations.length} warnings and notes</div>
        </a>
        <a className="kpi" href={`#${projectPath(project.id, 'restitution')}`}>
          <div className="label">Wages owed, not yet verified paid</div>
          <div className={`value ${ledger.totals.outstanding ? 'bad' : ''}`}>{formatMoney(ledger.totals.outstanding)}</div>
          <div className="sub">
            {formatMoney(ledger.totals.owed)} found · {ledger.rows.length} line items
          </div>
        </a>
        <a
          className="kpi"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById('matrix')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          <div className="label">Missing weekly payrolls</div>
          <div className={`value ${missing.length ? 'bad' : ''}`}>{missing.length}</div>
          <div className="sub">
            {new Set(missing.map((f) => f.contractorId)).size} contractor(s) behind
          </div>
        </a>
        <a className="kpi" href={`#${projectPath(project.id, 'payrolls')}`}>
          <div className="label">Payrolls not yet reviewed</div>
          <div className={`value ${toReview.length ? 'warn' : ''}`}>{toReview.length}</div>
          <div className="sub">{data.payrolls.length} received in total</div>
        </a>
      </div>

      {!wd && data.payrolls.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="bad">
            Rates cannot be checked until the wage determination is added. <a href={`#${projectPath(project.id, 'wd')}`}>Add it now</a>.
          </Alert>
        </div>
      )}
      {unmapped.size > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warn">
            {unmapped.size} job title{unmapped.size === 1 ? '' : 's'} on submitted payrolls {unmapped.size === 1 ? 'is' : 'are'} not matched to a wage determination classification yet, so those lines are not rate-checked.{' '}
            <a href={`#${projectPath(project.id, 'wd', 'mappings')}`}>Match job titles</a>
          </Alert>
        </div>
      )}

      <Panel
        title={<h2 id="matrix">Weekly payrolls by contractor</h2>}
        actions={
          <div className="legend">
            <span><i className="cell-received" />Received</span>
            <span><i className="cell-warnings" />Warnings</span>
            <span><i className="cell-violations" />Violations</span>
            <span><i className="cell-missing" />Missing</span>
            <span><i className="cell-no-work" />No work</span>
            <span><i className="cell-not-due" />Not yet due</span>
          </div>
        }
        bodyClass="panel-body table-wrap"
      >
        <ComplianceMatrix view={view} showAll={showAllWeeks} onToggle={() => setShowAllWeeks((s) => !s)} />
      </Panel>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <Panel
          title="Largest open violations"
          actions={<a className="small" href={`#${projectPath(project.id, 'exceptions')}`}>All exceptions</a>}
          bodyClass=""
        >
          {topFindings.length === 0 ? (
            <EmptyState title={data.payrolls.length ? 'No wage violations found' : 'No payrolls yet'}>
              {data.payrolls.length ? 'Every checked line meets the wage determination.' : 'Add payrolls to start the review.'}
            </EmptyState>
          ) : (
            topFindings.map((f) => <FindingRow key={f.key} finding={f} view={view} />)
          )}
        </Panel>
        <Panel title="Recent activity" bodyClass="">
          {data.activity.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <table className="data">
              <tbody>
                {data.activity.slice(0, 10).map((a) => (
                  <tr key={a.id}>
                    <td className="tight muted small">{new Date(a.at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td>
                      <strong>{a.action}</strong>
                      <div className="sub">{a.detail}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function FindingRow({ finding: f, view }: { finding: Finding; view: ProjectView }) {
  const payroll = f.payrollId ? view.payrollById.get(f.payrollId) : null;
  const contractor = view.contractorById.get(f.contractorId);
  return (
    <div
      className="finding"
      style={{ cursor: payroll ? 'pointer' : 'default' }}
      onClick={() => payroll && navigate(projectPath(view.data.project.id, 'payrolls', payroll.id))}
    >
      <SeverityBadge severity={f.severity} />
      <div>
        <div className="title">{f.title}</div>
        <div className="sub small muted">
          {contractor?.name} · {RULE_LABELS[f.ruleId]}
          {f.weekEnding && ` · week ending ${formatDate(f.weekEnding)}`}
        </div>
      </div>
      <div className="amount">{f.amountOwed > 0 ? <Money value={f.amountOwed} /> : null}</div>
    </div>
  );
}

function ComplianceMatrix({ view, showAll, onToggle }: { view: ProjectView; showAll: boolean; onToggle: () => void }) {
  const { evaluation, data } = view;
  const rows = evaluation.weeks;
  const buckets = useMemo(() => {
    const set = new Set<string>();
    for (const w of evaluation.weeks) for (const c of w.cells) set.add(weekBucket(c.weekEnding));
    return [...set].sort();
  }, [evaluation.weeks]);
  const visible = showAll ? buckets : buckets.slice(-12);

  if (data.contractors.length === 0) {
    return (
      <EmptyState title="No contractors yet" actions={<Button onClick={() => navigate(projectPath(data.project.id, 'contractors'))}>Add contractors</Button>}>
        Add the prime contractor and each subcontractor with their start date. Wagebench then expects a payroll from each of them every week.
      </EmptyState>
    );
  }
  if (buckets.length === 0) {
    return <p className="muted">Weeks appear here once a contractor has a start date or a first payroll.</p>;
  }

  return (
    <>
      <table className="matrix" aria-label="Weekly payroll status by contractor">
        <thead>
          <tr>
            <th className="contractor">Week ending</th>
            {visible.map((b) => (
              <th key={b} scope="col">{formatDate(b).replace(/\/\d{4}$/, '')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <MatrixRow key={w.contractorId} weeks={w} buckets={visible} view={view} />
          ))}
        </tbody>
      </table>
      {buckets.length > 12 && (
        <Button size="sm" variant="ghost" onClick={onToggle} style={{ marginTop: 8 }}>
          {showAll ? 'Show last 12 weeks' : `Show all ${buckets.length} weeks`}
        </Button>
      )}
    </>
  );
}

function MatrixRow({ weeks, buckets, view }: { weeks: ContractorWeeks; buckets: string[]; view: ProjectView }) {
  const contractor = view.contractorById.get(weeks.contractorId);
  const byBucket = new Map(weeks.cells.map((c) => [weekBucket(c.weekEnding), c]));
  const pid = view.data.project.id;
  return (
    <tr>
      <th className="contractor" scope="row" title={contractor?.name}>
        {contractor?.name}
        {contractor?.tier === 'prime' && <> <Badge tone="neutral">Prime</Badge></>}
      </th>
      {buckets.map((b) => {
        const cell = byBucket.get(b);
        if (!cell) return <td key={b} />;
        const summary = cell.payrollIds.length ? view.evaluation.payrolls.get(cell.payrollIds[cell.payrollIds.length - 1]!) : null;
        const glyph = cell.state === 'violations' && summary ? String(summary.violations) : CELL_GLYPH[cell.state];
        const label = `${contractor?.name}, week ending ${formatDate(cell.weekEnding)}: ${CELL_TEXT[cell.state]}`;
        const target =
          cell.payrollIds.length > 0
            ? projectPath(pid, 'payrolls', cell.payrollIds[cell.payrollIds.length - 1]!)
            : cell.state === 'missing'
              ? projectPath(pid, 'import', `${weeks.contractorId}~${cell.weekEnding}`)
              : null;
        return (
          <td
            key={b}
            className={`cell cell-${cell.state} ${target ? 'clickable' : ''}`}
            title={label}
            aria-label={label}
            tabIndex={target ? 0 : undefined}
            onClick={() => target && navigate(target)}
            onKeyDown={(e) => {
              if (target && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                navigate(target);
              }
            }}
          >
            {glyph}
          </td>
        );
      })}
    </tr>
  );
}
