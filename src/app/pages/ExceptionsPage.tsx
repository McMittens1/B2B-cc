import { useMemo, useState, type CSSProperties } from 'react';
import { setDisposition } from '../../db/repo';
import { formatDate } from '../../engine/dates';
import { cents, formatMoney, sum } from '../../engine/money';
import type { Finding, FindingDisposition, RuleId, Severity } from '../../engine/types';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { projectStore, type ProjectView } from '../store';
import {
  Alert,
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Money,
  PageHeader,
  Panel,
  RULE_LABELS,
  SEVERITY_LABEL,
  SeverityBadge,
  downloadFile,
  safeFileName,
  useToast,
} from '../ui';

/**
 * Exceptions: every finding across the project in one triage list. Violations stay open until
 * the underlying payroll is corrected; warnings and notes can be dismissed as not applicable.
 */

type Tab = Severity | 'dismissed' | 'all';
type SortKey = 'severity' | 'rule' | 'contractor' | 'week' | 'worker' | 'amount';
interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

interface Row {
  f: Finding;
  contractorName: string;
  payrollNumber: string | null;
  dismissed: boolean;
  disposition: FindingDisposition | null;
  target: string;
  search: string;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'violation', label: 'Violations' },
  { id: 'warning', label: 'Warnings' },
  { id: 'info', label: 'Notes' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'all', label: 'All' },
];

const SEVERITY_RANK: Record<Severity, number> = { violation: 0, warning: 1, info: 2 };

/** Direction a column sorts in when first clicked. */
const DEFAULT_DIR: Record<SortKey, 1 | -1> = { severity: 1, rule: 1, contractor: 1, week: -1, worker: 1, amount: -1 };

const VIOLATION_LOCK =
  "Violations can't be dismissed. A violation clears when the contractor's corrected (or missing) payroll is recorded.";

const CLAMP_2: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  maxWidth: 620,
};

/** Header sort button: keeps the global focus ring (unlike `all: unset`). */
const SORT_BUTTON: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export function ExceptionsPage({ view }: { view: ProjectView }) {
  useDocumentTitle('Exceptions');
  const { data, evaluation, dismissed, contractorById, payrollById, openFindings } = view;
  const pid = data.project.id;
  const wd = data.wd?.parsed ?? null;
  const toast = useToast();

  // ---- Source rows ---------------------------------------------------------------
  const all = useMemo<Row[]>(() => {
    const dispositions = new Map(data.dispositions.map((d) => [d.findingKey, d]));
    return evaluation.findings.map((f) => {
      const contractorName = contractorById.get(f.contractorId)?.name ?? 'Unknown contractor';
      const payrollNumber = f.payrollId ? (payrollById.get(f.payrollId)?.payrollNumber ?? null) : null;
      const target = f.payrollId
        ? projectPath(pid, 'payrolls', f.payrollId)
        : f.weekEnding
          ? projectPath(pid, 'import', `${f.contractorId}~${f.weekEnding}`)
          : projectPath(pid, 'import');
      return {
        f,
        contractorName,
        payrollNumber,
        dismissed: dismissed.has(f.key),
        disposition: dispositions.get(f.key) ?? null,
        target,
        search: [f.workerName, f.title, f.detail, contractorName, payrollNumber, RULE_LABELS[f.ruleId]]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      };
    });
  }, [evaluation.findings, data.dispositions, dismissed, contractorById, payrollById, pid]);

  const counts = useMemo(() => countByTab(all), [all]);

  // ---- Filters ---------------------------------------------------------------------
  const [tab, setTab] = useState<Tab>(() =>
    counts.violation ? 'violation' : counts.warning ? 'warning' : counts.info ? 'info' : 'all',
  );
  const [contractor, setContractor] = useState('');
  const [rule, setRule] = useState<'' | RuleId>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'severity', dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  /** Keys captured when the bulk-dismiss dialog opens, so a store refresh can't change what is confirmed. */
  const [bulkKeys, setBulkKeys] = useState<string[] | null>(null);
  const [bulkNote, setBulkNote] = useState('');

  const filtersActive = Boolean(contractor || rule || from || to || q.trim());

  const contractorOptions = useMemo(() => {
    const present = new Set(all.map((r) => r.f.contractorId));
    const known = data.contractors.filter((c) => present.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
    const unknown = [...present].filter((id) => !contractorById.has(id)).map((id) => ({ id, name: 'Unknown contractor' }));
    return [...known, ...unknown];
  }, [all, data.contractors, contractorById]);

  const ruleOptions = useMemo(() => {
    const n = new Map<RuleId, number>();
    for (const r of all) n.set(r.f.ruleId, (n.get(r.f.ruleId) ?? 0) + 1);
    return [...n.entries()]
      .map(([id, count]) => ({ id, count, label: RULE_LABELS[id] }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [all]);

  const weeks = useMemo(() => {
    const set = new Set<string>();
    for (const r of all) if (r.f.weekEnding) set.add(r.f.weekEnding);
    return [...set].sort().reverse();
  }, [all]);

  /** Rows passing the toolbar filters (before the severity tab). */
  const base = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (contractor && r.f.contractorId !== contractor) return false;
      if (rule && r.f.ruleId !== rule) return false;
      if (from && (!r.f.weekEnding || r.f.weekEnding < from)) return false;
      if (to && (!r.f.weekEnding || r.f.weekEnding > to)) return false;
      if (needle && !r.search.includes(needle)) return false;
      return true;
    });
  }, [all, contractor, rule, from, to, q]);

  const tabCounts = useMemo(() => countByTab(base), [base]);

  const rows = useMemo(() => {
    const inTab = base.filter((r) =>
      tab === 'all' ? true : tab === 'dismissed' ? r.dismissed : !r.dismissed && r.f.severity === tab,
    );
    return inTab.sort((a, b) => compareRows(a, b, sort));
  }, [base, tab, sort]);

  const rowsOwed = useMemo(() => cents(sum(rows.map((r) => r.f.amountOwed))), [rows]);

  // ---- Selection (warnings and notes, or anything already dismissed) ---------------------
  const selectable = rows.filter(canSelect);
  const selectedRows = selectable.filter((r) => selected.has(r.f.key));
  const toDismiss = selectedRows.filter((r) => !r.dismissed);
  const toRestore = selectedRows.filter((r) => r.dismissed);
  const allSelected = selectable.length > 0 && selectedRows.length === selectable.length;
  const someSelected = selectedRows.length > 0;
  const showSelect = selectable.length > 0;

  const toggleSelected = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const toggleAll = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of selectable) {
        if (on) next.add(r.f.key);
        else next.delete(r.f.key);
      }
      return next;
    });

  // ---- Project-wide summary (open findings only) -------------------------------------------
  const summary = useMemo(() => {
    const violations = openFindings.filter((f) => f.severity === 'violation');
    const missing = violations.filter((f) => f.ruleId === 'missing-week');
    return {
      violations: violations.length,
      owed: cents(sum(violations.map((f) => f.amountOwed))),
      underpayments: violations.filter((f) => f.amountOwed > 0).length,
      contractors: new Set(violations.map((f) => f.contractorId)).size,
      missing: missing.length,
      contractorsBehind: new Set(missing.map((f) => f.contractorId)).size,
    };
  }, [openFindings]);

  // ---- Writes -----------------------------------------------------------------------
  const writeDispositions = (keys: string[], dismiss: boolean, note = '') =>
    projectStore.mutate(async () => {
      for (const key of keys) await setDisposition(pid, key, dismiss, note);
    });

  const toggleOne = async (r: Row) => {
    const dismiss = !r.dismissed;
    setBusy(true);
    try {
      await writeDispositions([r.f.key], dismiss);
      toggleSelected(r.f.key, false);
      toast(`${dismiss ? 'Dismissed' : 'Restored'}: ${truncate(r.f.title, 70)}`);
    } catch (e) {
      toast(`Could not update the finding: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const restoreSelected = async () => {
    const keys = toRestore.map((r) => r.f.key);
    setBusy(true);
    try {
      await writeDispositions(keys, false);
      setSelected(new Set());
      toast(`Restored ${plural(keys.length, 'finding')}`);
    } catch (e) {
      toast(`Could not restore: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const dismissSelected = async () => {
    const keys = bulkKeys ?? [];
    if (keys.length === 0) return;
    try {
      await writeDispositions(keys, true, bulkNote.trim());
      setSelected(new Set());
      setBulkNote('');
      toast(`Dismissed ${plural(keys.length, 'finding')}`);
    } catch (e) {
      toast(`Could not dismiss: ${(e as Error).message}`, 'bad');
    }
  };

  const exportCsv = () => {
    const lines = [CSV_HEADERS.map(csvCell).join(',')];
    for (const r of rows) {
      const f = r.f;
      lines.push(
        [
          SEVERITY_LABEL[f.severity],
          r.dismissed ? 'Dismissed' : 'Open',
          RULE_LABELS[f.ruleId],
          r.contractorName,
          f.weekEnding ? formatDate(f.weekEnding) : '',
          r.payrollNumber ?? (f.ruleId === 'missing-week' ? 'Not received' : ''),
          f.workerName ?? '',
          f.title,
          f.detail,
          f.amountOwed > 0 ? f.amountOwed : '',
          r.disposition?.note ?? '',
          f.key,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const name = `${safeFileName(data.project.name).slice(0, 60)} exceptions ${view.asOf}.csv`;
    downloadFile(name, `﻿${lines.join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
    toast(`Exported ${plural(rows.length, 'finding')} to CSV`);
  };

  const clearFilters = () => {
    setContractor('');
    setRule('');
    setFrom('');
    setTo('');
    setQ('');
  };

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: DEFAULT_DIR[key] }));

  // ---- Render -----------------------------------------------------------------------
  const hasFindings = all.length > 0;
  const noPayrolls = data.payrolls.length === 0;
  const wdAlert = !wd && !noPayrolls && (
    <div style={{ marginBottom: 16 }}>
      <Alert tone="bad">
        There is no wage determination on this project, so basic rates, fringes and overtime are not checked and
        underpayments will not appear here. <a href={`#${projectPath(pid, 'wd')}`}>Add the wage determination</a>.
      </Alert>
    </div>
  );

  return (
    <div className="page">
      <PageHeader
        title="Exceptions"
        subtitle={
          hasFindings
            ? `${plural(counts.violation, 'open violation')} · ${plural(counts.warning, 'warning')} · ${plural(counts.info, 'note')} · ${counts.dismissed} dismissed`
            : 'Every finding from every payroll check, in one place for triage.'
        }
        actions={
          hasFindings ? (
            <Button icon="download" onClick={exportCsv} disabled={rows.length === 0} title="Download the findings listed below as a CSV file">
              Export CSV
            </Button>
          ) : undefined
        }
      />

      {!hasFindings && noPayrolls ? (
        <Panel>
          <EmptyState
            title="No payrolls yet"
            actions={<Button variant="primary" icon="import" onClick={() => navigate(projectPath(pid, 'import'))}>Add payrolls</Button>}
          >
            Exceptions appear here once certified payrolls are added and checked against the wage determination.
          </EmptyState>
        </Panel>
      ) : !hasFindings ? (
        <>
          {wdAlert}
          <Panel>
            <EmptyState
              title="No exceptions"
              actions={!wd ? <Button variant="primary" onClick={() => navigate(projectPath(pid, 'wd'))}>Add the wage determination</Button> : undefined}
            >
              {wd
                ? 'Every checked line meets the WD, and every expected weekly payroll is in.'
                : 'Paperwork and arithmetic checks found nothing, but wage rates are not checked until the wage determination is added.'}
            </EmptyState>
          </Panel>
        </>
      ) : (
        <>
          {wdAlert}

          <div className="kpis">
            <div className="kpi">
              <div className="label">Open violations</div>
              <div className={`value ${summary.violations ? 'bad' : ''}`}>{summary.violations}</div>
              <div className="sub">
                {plural(counts.warning, 'warning')} · {plural(counts.info, 'note')} open
              </div>
            </div>
            <div className="kpi">
              <div className="label">Wages owed on open violations</div>
              <div className={`value ${summary.owed ? 'bad' : ''}`}>{formatMoney(summary.owed)}</div>
              <div className="sub">{plural(summary.underpayments, 'underpayment finding')}</div>
            </div>
            <div className="kpi">
              <div className="label">Contractors with violations</div>
              <div className={`value ${summary.contractors ? 'bad' : ''}`}>{summary.contractors}</div>
              <div className="sub">of {plural(data.contractors.length, 'contractor')} on the project</div>
            </div>
            <div className="kpi">
              <div className="label">Missing weekly payrolls</div>
              <div className={`value ${summary.missing ? 'bad' : ''}`}>{summary.missing}</div>
              <div className="sub">
                {summary.contractorsBehind ? `${plural(summary.contractorsBehind, 'contractor')} behind` : 'All expected weeks received'}
              </div>
            </div>
          </div>

          <div className="tabs" role="tablist" aria-label="Filter by severity">
            {TABS.map((t) => {
              const n = t.id === 'all' ? tabCounts.all : tabCounts[t.id];
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  <span className="count" style={t.id === 'violation' && n > 0 ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>
                    {n}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="toolbar" role="search">
            <input
              className="input grow"
              type="search"
              placeholder="Search worker, finding or detail…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search findings"
            />
            <select className="select" value={contractor} onChange={(e) => setContractor(e.target.value)} aria-label="Filter by contractor">
              <option value="">All contractors</option>
              {contractorOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select className="select" value={rule} onChange={(e) => setRule(e.target.value as RuleId | '')} aria-label="Filter by rule">
              <option value="">All rules</option>
              {ruleOptions.map((r) => (
                <option key={r.id} value={r.id}>{r.label} ({r.count})</option>
              ))}
            </select>
            <select className="select" style={{ minWidth: 150 }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Week ending from">
              <option value="">From: any week</option>
              {weeks.map((w) => (
                <option key={w} value={w}>From {formatDate(w)}</option>
              ))}
            </select>
            <select className="select" style={{ minWidth: 150 }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Week ending to">
              <option value="">To: any week</option>
              {weeks.map((w) => (
                <option key={w} value={w}>To {formatDate(w)}</option>
              ))}
            </select>
            {filtersActive && (
              <Button variant="ghost" size="sm" icon="x" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>

          <Panel
            bodyClass="table-wrap"
            title={
              <h2>
                {plural(rows.length, 'finding')}
                {filtersActive && <span className="muted" style={{ fontWeight: 400 }}> match the filters</span>}
              </h2>
            }
            actions={
              someSelected ? (
                <div className="row">
                  <span className="small muted">{selectedRows.length} selected</span>
                  {toDismiss.length > 0 && (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => setBulkKeys(toDismiss.map((r) => r.f.key))}>
                      Dismiss {toDismiss.length}
                    </Button>
                  )}
                  {toRestore.length > 0 && (
                    <Button size="sm" disabled={busy} onClick={() => void restoreSelected()}>
                      Restore {toRestore.length}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear selection
                  </Button>
                </div>
              ) : showSelect ? (
                <span className="small muted">Select warnings or notes to dismiss or restore them together</span>
              ) : undefined
            }
          >
            {rows.length === 0 ? (
              filtersActive ? (
                <EmptyState title="No findings match these filters" actions={<Button onClick={clearFilters}>Clear filters</Button>}>
                  {tab !== 'all' && tabCounts.all > 0
                    ? `${plural(tabCounts.all, 'finding')} match in other tabs.`
                    : 'Try a different contractor, rule, week range or search.'}
                </EmptyState>
              ) : (
                <TabEmpty tab={tab} hasWd={Boolean(wd)} />
              )
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    {showSelect && (
                      <th className="tight">
                        <input
                          type="checkbox"
                          aria-label="Select all listed warnings and notes"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected && !allSelected;
                          }}
                          onChange={(e) => toggleAll(e.target.checked)}
                        />
                      </th>
                    )}
                    <SortTh label="Severity" k="severity" sort={sort} onSort={onSort} />
                    <SortTh label="Rule" k="rule" sort={sort} onSort={onSort} />
                    <SortTh label="Contractor" k="contractor" sort={sort} onSort={onSort} />
                    <SortTh label="Week ending" k="week" sort={sort} onSort={onSort} />
                    <SortTh label="Worker" k="worker" sort={sort} onSort={onSort} />
                    <th>Finding</th>
                    <SortTh label="Owed" k="amount" sort={sort} onSort={onSort} className="num" />
                    <th className="tight"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <FindingRow
                      key={r.f.key}
                      row={r}
                      showSelect={showSelect}
                      selected={selected.has(r.f.key)}
                      busy={busy}
                      onSelect={(on) => toggleSelected(r.f.key, on)}
                      onToggleDismiss={() => void toggleOne(r)}
                    />
                  ))}
                </tbody>
                {rowsOwed > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={showSelect ? 7 : 6}>Total owed on listed findings</td>
                      <td className="num cell-bad">{formatMoney(rowsOwed)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </Panel>
        </>
      )}

      <ConfirmModal
        open={bulkKeys !== null}
        title={`Dismiss ${plural(bulkKeys?.length ?? 0, 'finding')}?`}
        confirmLabel={`Dismiss ${bulkKeys?.length ?? 0}`}
        message={
          <div className="stack" style={{ gap: 12 }}>
            <p style={{ margin: 0 }}>
              The selected warnings and notes will be marked not applicable and moved to the Dismissed tab. They no
              longer count as open, and you can restore them at any time.
            </p>
            <div className="field">
              <label htmlFor="bulk-dismiss-note">Reason (optional, saved with each dismissal)</label>
              <textarea
                id="bulk-dismiss-note"
                className="input"
                value={bulkNote}
                onChange={(e) => setBulkNote(e.target.value)}
                placeholder="e.g. Contractor confirmed payroll numbers restart each calendar year."
              />
            </div>
          </div>
        }
        onConfirm={dismissSelected}
        onClose={() => setBulkKeys(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function FindingRow({
  row: r,
  showSelect,
  selected,
  busy,
  onSelect,
  onToggleDismiss,
}: {
  row: Row;
  showSelect: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: (on: boolean) => void;
  onToggleDismiss: () => void;
}) {
  const f = r.f;
  const tone = r.dismissed ? '' : f.severity === 'violation' ? 'row-bad' : f.severity === 'warning' ? 'row-warn' : '';
  return (
    <tr
      className={`clickable ${tone} ${selected ? 'selected' : ''}`}
      style={r.dismissed ? { color: 'var(--muted)' } : undefined}
      onClick={() => navigate(r.target)}
    >
      {showSelect && (
        <td className="tight" onClick={(e) => e.stopPropagation()}>
          {canSelect(r) && (
            <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select: ${f.title}`} />
          )}
        </td>
      )}
      <td className="tight">
        <SeverityBadge severity={f.severity} />
        {r.dismissed && (
          <div style={{ marginTop: 4 }}>
            <Badge tone="neutral">Dismissed</Badge>
          </div>
        )}
      </td>
      <td className="small" style={{ minWidth: 120 }}>{RULE_LABELS[f.ruleId]}</td>
      <td style={{ minWidth: 120 }}>{r.contractorName}</td>
      <td className="nowrap">
        {formatDate(f.weekEnding)}
        <div className="sub">
          {r.payrollNumber ? `Payroll ${r.payrollNumber}` : f.ruleId === 'missing-week' ? 'Not received' : f.payrollId ? 'No payroll no.' : ''}
        </div>
      </td>
      <td style={{ minWidth: 110 }}>{f.workerName || <span className="faint">—</span>}</td>
      <td style={{ minWidth: 260 }}>
        <a href={`#${r.target}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 500, color: r.dismissed ? 'inherit' : undefined }}>
          {f.title}
        </a>
        <div className="sub" style={CLAMP_2} title={f.detail}>
          {f.detail}
        </div>
        {r.dismissed && r.disposition && (
          <div className="sub" style={{ marginTop: 2, fontStyle: 'italic' }}>
            Dismissed {formatDate(r.disposition.updatedAt.slice(0, 10))}
            {r.disposition.note ? ` — ${r.disposition.note}` : ''}
          </div>
        )}
      </td>
      <td className="num cell-bad">
        <Money value={f.amountOwed} />
      </td>
      <td className="tight" onClick={(e) => e.stopPropagation()}>
        {r.dismissed ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onToggleDismiss} aria-label={`Restore: ${f.title}`}>
            Restore
          </Button>
        ) : f.severity === 'violation' ? (
          <span title={VIOLATION_LOCK} style={{ display: 'inline-block', cursor: 'not-allowed' }}>
            <Button size="sm" variant="ghost" disabled aria-label={`Dismiss (not available): ${VIOLATION_LOCK}`} style={{ pointerEvents: 'none' }}>
              Dismiss
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onToggleDismiss} aria-label={`Dismiss: ${f.title}`}>
            Dismiss
          </Button>
        )}
      </td>
    </tr>
  );
}

function SortTh({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: SortState; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort.key === k;
  return (
    <th className={className} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" style={{ ...SORT_BUTTON, color: active ? 'var(--ink)' : 'inherit' }} onClick={() => onSort(k)}>
        {label}
        <span aria-hidden="true" style={{ marginLeft: 4, fontSize: 10, visibility: active ? 'visible' : 'hidden' }}>
          {sort.dir === 1 ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

function TabEmpty({ tab, hasWd }: { tab: Tab; hasWd: boolean }) {
  switch (tab) {
    case 'violation':
      return (
        <EmptyState title="No open violations">
          {hasWd
            ? 'Every checked line meets the WD, and every expected weekly payroll is in.'
            : 'No paperwork violations found. Wage rates are not checked until the wage determination is added.'}
        </EmptyState>
      );
    case 'warning':
      return <EmptyState title="No open warnings">Nothing needs a closer look right now.</EmptyState>;
    case 'info':
      return <EmptyState title="No open notes" />;
    case 'dismissed':
      return (
        <EmptyState title="Nothing dismissed">
          Warnings and notes you dismiss as not applicable are kept here and can be restored at any time.
        </EmptyState>
      );
    default:
      return <EmptyState title="No exceptions">Every checked line meets the WD.</EmptyState>;
  }
}

// ---------------------------------------------------------------------------------------

function canSelect(r: Row): boolean {
  return r.dismissed || r.f.severity !== 'violation';
}

function countByTab(rows: readonly Row[]): Record<Severity | 'dismissed' | 'all', number> {
  const c = { violation: 0, warning: 0, info: 0, dismissed: 0, all: rows.length };
  for (const r of rows) {
    if (r.dismissed) c.dismissed++;
    else c[r.f.severity]++;
  }
  return c;
}

/** Text compare that keeps blanks last when ascending. */
function compareText(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

function compareRows(a: Row, b: Row, sort: SortState): number {
  let primary = 0;
  switch (sort.key) {
    case 'severity':
      primary = SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity];
      break;
    case 'rule':
      primary = RULE_LABELS[a.f.ruleId].localeCompare(RULE_LABELS[b.f.ruleId]);
      break;
    case 'contractor':
      primary = compareText(a.contractorName, b.contractorName);
      break;
    case 'week':
      primary = compareText(a.f.weekEnding, b.f.weekEnding);
      break;
    case 'worker':
      primary = compareText(a.f.workerName, b.f.workerName);
      break;
    case 'amount':
      primary = a.f.amountOwed - b.f.amountOwed;
      break;
  }
  if (primary !== 0) return primary * sort.dir;
  return (
    SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] ||
    b.f.amountOwed - a.f.amountOwed ||
    compareText(b.f.weekEnding, a.f.weekEnding) ||
    compareText(a.contractorName, b.contractorName) ||
    compareText(a.f.workerName, b.f.workerName) ||
    a.f.title.localeCompare(b.f.title)
  );
}

const CSV_HEADERS = [
  'Severity',
  'Status',
  'Rule',
  'Contractor',
  'Week ending',
  'Payroll no.',
  'Worker',
  'Finding',
  'Detail',
  'Amount owed',
  'Dismissal note',
  'Finding ID',
];

/** One CSV cell: numbers as plain decimals; text quoted when needed and guarded against formula injection. */
function csvCell(value: string | number): string {
  if (typeof value === 'number') return value.toFixed(2);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
