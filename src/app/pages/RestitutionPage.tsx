import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { logActivity, setRestitution } from '../../db/repo';
import { formatDate, todayIso } from '../../engine/dates';
import { cents, formatMoney, parseAmount, sum } from '../../engine/money';
import { RESTITUTION_STATUS_LABELS, type LedgerRow } from '../../engine/restitution';
import type { PayrollLine, RestitutionStatus } from '../../engine/types';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { projectStore, type ProjectView } from '../store';
import {
  Alert,
  Button,
  ConfirmModal,
  EmptyState,
  Field,
  Modal,
  Money,
  PageHeader,
  Panel,
  RULE_LABELS,
  downloadFile,
  safeFileName,
  useToast,
} from '../ui';
import { neutralizeFormula } from '../../engine/docs/exports';

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const STATUSES: RestitutionStatus[] = ['owed', 'requested', 'paid', 'verified', 'waived'];
/** Statuses that close an item: nothing more is expected from the contractor. */
const CLOSED: ReadonlySet<RestitutionStatus> = new Set<RestitutionStatus>(['verified', 'waived']);
const STATUS_DOT: Record<RestitutionStatus, 'bad' | 'warn' | 'info' | 'good' | 'neutral'> = {
  owed: 'bad',
  requested: 'warn',
  paid: 'info',
  verified: 'good',
  waived: 'neutral',
};

interface Entry {
  status: RestitutionStatus;
  amountPaid: number;
  note: string;
}

/** A ledger row plus the payroll context needed to display and search it. */
interface Item {
  key: string;
  row: LedgerRow;
  line: PayrollLine | null;
  payrollId: string | null;
  payrollNumber: string | null;
  title: string;
  haystack: string;
}

interface ContractorGroup {
  id: string;
  name: string;
  items: number;
  open: number;
  owed: number;
  paid: number;
  verified: number;
  outstanding: number;
}

type PendingChange = { row: LedgerRow; next: Entry; reason: 'reopen' | 'partial-verify' };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "6/14/2026" → "6/14" for compact log lines. */
const shortDate = (iso: string | null) => (iso ? formatDate(iso).replace(/\/\d{4}$/, '') : '');

const fmtPaid = (n: number) => (n > 0 ? n.toFixed(2) : '');

/** Local calendar date of an ISO timestamp. */
const localDay = (ts: string) => todayIso(new Date(ts));

/** Finding titles start with the worker's name, which has its own column here. */
function stripWorker(title: string, worker: string | null): string {
  if (!worker || !title.startsWith(`${worker}: `)) return title;
  const rest = title.slice(worker.length + 2);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function who(row: LedgerRow): string {
  const f = row.finding;
  const name = f.workerName || row.contractorName;
  return f.weekEnding ? `${name} wk ${shortDate(f.weekEnding)}` : name;
}

/** Activity-log line, e.g. "J. Ruiz wk 6/14: paid $601.20 (check 1041)". */
function describe(row: LedgerRow, next: Entry, withNote = true): string {
  const owed = formatMoney(row.amountOwed);
  const paid = formatMoney(next.amountPaid);
  const what =
    next.status === 'paid'
      ? `paid ${paid}${next.amountPaid < row.amountOwed ? ` of ${owed}` : ''}`
      : next.status === 'verified'
        ? `payment of ${paid} verified`
        : next.status === 'requested'
          ? `back wages of ${owed} requested`
          : next.status === 'waived'
            ? `${owed} waived`
            : `set to owed (${owed})`;
  const note = next.note.trim();
  const suffix = withNote && note ? ` (${note.length > 80 ? `${note.slice(0, 79)}…` : note})` : '';
  return `${who(row)}: ${what}${suffix}`;
}

function appendNote(existing: string, extra: string): string {
  if (!extra) return existing;
  if (!existing.trim()) return extra;
  return `${existing.trim()}; ${extra}`;
}

// --- CSV ---------------------------------------------------------------------

/** One CSV field. Text that a spreadsheet would run as a formula is prefixed with an apostrophe. */
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(2) : '';
  const s = neutralizeFormula(v); // same guard as the document exports (leading spaces, full-width signs)
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(items: readonly Item[]): string {
  const header = [
    'Contractor',
    'Week ending',
    'Payroll no.',
    'Worker',
    'Worker ID',
    'Classification (as reported)',
    'Finding',
    'Rule',
    'Amount owed',
    'Status',
    'Amount paid',
    'Balance',
    'Note',
    'Last updated',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const { row, line, payrollNumber, title } of items) {
    const f = row.finding;
    lines.push(
      [
        csvCell(row.contractorName),
        csvCell(f.weekEnding ?? ''),
        csvCell(payrollNumber ?? ''),
        csvCell(f.workerName ?? ''),
        csvCell(line?.workerId ?? ''),
        csvCell(line?.classification ?? ''),
        csvCell(title),
        csvCell(RULE_LABELS[f.ruleId]),
        csvCell(row.amountOwed),
        csvCell(RESTITUTION_STATUS_LABELS[row.status]),
        csvCell(row.amountPaid),
        csvCell(row.balance),
        csvCell(row.note),
        csvCell(row.updatedAt ? localDay(row.updatedAt) : ''),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function RestitutionPage({ view }: { view: ProjectView }) {
  useDocumentTitle('Restitution');
  const { data, ledger, payrollById, openFindings } = view;
  const pid = data.project.id;
  const toast = useToast();

  const [contractor, setContractor] = useState('');
  const [status, setStatus] = useState<'' | RestitutionStatus>('');
  const [outstandingOnly, setOutstandingOnly] = useState(true);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkNote, setBulkNote] = useState('');
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [waive, setWaive] = useState<{ row: LedgerRow; amountPaid: number } | null>(null);
  const [waiveReason, setWaiveReason] = useState('');
  const [waiveBusy, setWaiveBusy] = useState(false);
  const ledgerRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(
    () =>
      ledger.rows.map((row) => {
        const f = row.finding;
        const payroll = f.payrollId ? payrollById.get(f.payrollId) ?? null : null;
        const line = payroll && f.lineId ? payroll.lines.find((l) => l.id === f.lineId) ?? null : null;
        const title = stripWorker(f.title, f.workerName);
        const haystack = [
          row.contractorName,
          f.workerName,
          line?.workerId,
          line?.classification,
          title,
          RULE_LABELS[f.ruleId],
          row.note,
          formatDate(f.weekEnding),
          payroll?.payrollNumber,
          RESTITUTION_STATUS_LABELS[row.status],
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return { key: f.key, row, line, payrollId: payroll?.id ?? null, payrollNumber: payroll?.payrollNumber ?? null, title, haystack };
      }),
    [ledger.rows, payrollById],
  );

  const groups = useMemo<ContractorGroup[]>(() => {
    const m = new Map<string, ContractorGroup>();
    for (const { row } of items) {
      const id = row.finding.contractorId;
      const g = m.get(id) ?? { id, name: row.contractorName, items: 0, open: 0, owed: 0, paid: 0, verified: 0, outstanding: 0 };
      g.items += 1;
      if (!CLOSED.has(row.status)) g.open += 1;
      g.owed = cents(g.owed + row.amountOwed);
      g.paid = cents(g.paid + row.amountPaid);
      if (row.status === 'verified') g.verified = cents(g.verified + row.amountPaid);
      g.outstanding = cents(g.outstanding + row.balance);
      m.set(id, g);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const statusCounts = useMemo(() => {
    const c: Record<RestitutionStatus, number> = { owed: 0, requested: 0, paid: 0, verified: 0, waived: 0 };
    for (const { row } of items) c[row.status] += 1;
    return c;
  }, [items]);

  const { visible, closedHidden } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matching = items.filter(({ row, haystack }) => {
      if (contractor && row.finding.contractorId !== contractor) return false;
      if (status && row.status !== status) return false;
      if (needle && !haystack.includes(needle)) return false;
      return true;
    });
    if (!outstandingOnly) return { visible: matching, closedHidden: 0 };
    const open = matching.filter((i) => !CLOSED.has(i.row.status));
    return { visible: open, closedHidden: matching.length - open.length };
  }, [items, contractor, status, outstandingOnly, q]);

  const selectedVisible = visible.filter((i) => selected.has(i.key));
  const eligible = selectedVisible.filter((i) => i.row.status === 'owed').map((i) => i.row);
  const eligibleOwed = cents(sum(eligible.map((r) => r.amountOwed)));
  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const eligibleNames = [...new Set(eligible.map((r) => r.contractorName))];

  // Lines that could not be rate-checked, so any underpayment on them is not in these totals.
  const uncheckedLines = openFindings.filter((f) => f.ruleId === 'classification-unmapped' || f.ruleId === 'classification-not-on-wd').length;

  // --- Writes ------------------------------------------------------------------

  const save = async (row: LedgerRow, next: Entry): Promise<void> => {
    const note = next.note.trim();
    const amountPaid = cents(Math.max(0, next.amountPaid));
    const statusChanged = next.status !== row.status;
    const paidChanged = amountPaid !== row.amountPaid;
    const noteChanged = note !== row.note;
    if (!statusChanged && !paidChanged && !noteChanged) return;
    const entry: Entry = { status: next.status, amountPaid, note };
    const detail = statusChanged || paidChanged ? describe(row, entry) : undefined;
    try {
      await projectStore.mutate(() =>
        setRestitution({ findingKey: row.finding.key, projectId: pid, status: entry.status, amountPaid, note }, detail),
      );
      toast(statusChanged || paidChanged ? describe(row, entry, false) : `Note saved for ${who(row)}`);
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`, 'bad');
    }
  };

  /** Status picked in a row's select. Some changes need a reason or a confirmation first. */
  const requestStatus = (row: LedgerRow, next: RestitutionStatus, drafts: { amountPaid: number; note: string }) => {
    if (next === row.status) return;
    let amountPaid = drafts.amountPaid;
    if ((next === 'paid' || next === 'verified') && amountPaid <= 0) amountPaid = row.amountOwed;
    if (next === 'waived') {
      setWaiveReason(drafts.note);
      setWaive({ row, amountPaid });
      return;
    }
    const entry: Entry = { status: next, amountPaid, note: drafts.note };
    if (CLOSED.has(row.status) && !CLOSED.has(next)) {
      setPending({ row, next: entry, reason: 'reopen' });
      return;
    }
    if (next === 'verified' && amountPaid < row.amountOwed) {
      setPending({ row, next: entry, reason: 'partial-verify' });
      return;
    }
    void save(row, entry);
  };

  const confirmWaive = async () => {
    if (!waive || !waiveReason.trim()) return;
    setWaiveBusy(true);
    try {
      await save(waive.row, { status: 'waived', amountPaid: waive.amountPaid, note: waiveReason });
      setWaive(null);
    } finally {
      setWaiveBusy(false);
    }
  };

  const applyBulk = async () => {
    const targets = eligible;
    const extra = bulkNote.trim();
    if (targets.length === 0) return;
    const total = cents(sum(targets.map((r) => r.amountOwed)));
    const names = [...new Set(targets.map((r) => r.contractorName))];
    try {
      await projectStore.mutate(async () => {
        for (const r of targets) {
          await setRestitution({
            findingKey: r.finding.key,
            projectId: pid,
            status: 'requested',
            amountPaid: r.amountPaid,
            note: appendNote(r.note, extra),
          });
        }
        await logActivity(
          pid,
          'Restitution requested',
          `${plural(targets.length, 'item')} totaling ${formatMoney(total)} — ${names.join(', ')}${extra ? ` (${extra})` : ''}`,
        );
      });
      toast(`${plural(targets.length, 'item')} (${formatMoney(total)}) marked Requested`);
      setSelected(new Set());
      setBulkNote('');
    } catch (e) {
      toast(`Could not update: ${(e as Error).message}`, 'bad');
    }
  };

  const exportCsv = () => {
    const name = `${safeFileName(`${data.project.name} restitution ledger ${view.asOf}`)}.csv`;
    downloadFile(name, buildCsv(items), 'text/csv;charset=utf-8');
    toast(`Exported ${plural(items.length, 'ledger item')}`);
  };

  // --- Selection and filters -----------------------------------------------------

  const toggleOne = (key: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  const toggleAllVisible = (on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const i of visible) {
        if (on) n.add(i.key);
        else n.delete(i.key);
      }
      return n;
    });

  const changeStatusFilter = (v: '' | RestitutionStatus) => {
    setStatus(v);
    if (v && CLOSED.has(v)) setOutstandingOnly(false);
  };

  const changeOutstanding = (on: boolean) => {
    setOutstandingOnly(on);
    if (on && status && CLOSED.has(status)) setStatus('');
  };

  const clearFilters = () => {
    setContractor('');
    setStatus('');
    setOutstandingOnly(false);
    setQ('');
  };

  const focusContractor = (id: string) => {
    setContractor((c) => (c === id ? '' : id));
    ledgerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // --- Render ------------------------------------------------------------------------

  const subtitle = (
    <>
      Back wages computed from the wage determination and payroll data. Track each item through Owed → Requested → Paid → Verified,
      or mark it Waived with a reason.
    </>
  );

  if (items.length === 0) {
    const noPayrolls = data.payrolls.length === 0;
    const noWd = !data.wd;
    return (
      <div className="page">
        <PageHeader title="Restitution" subtitle={subtitle} />
        {!noPayrolls && uncheckedLines > 0 && (
          <div style={{ marginBottom: 16 }}>
            <UncheckedAlert count={uncheckedLines} pid={pid} />
          </div>
        )}
        <Panel>
          {noPayrolls ? (
            <EmptyState
              title="No payrolls yet"
              actions={<Button variant="primary" icon="import" onClick={() => navigate(projectPath(pid, 'import'))}>Add payrolls</Button>}
            >
              Back wages appear here when a certified payroll line is paid less than the wage determination requires.
            </EmptyState>
          ) : noWd ? (
            <EmptyState
              title="Rates are not checked yet"
              actions={<Button variant="primary" icon="book" onClick={() => navigate(projectPath(pid, 'wd'))}>Add the wage determination</Button>}
            >
              Add the wage determination so Wagebench can compare each payroll line with the required rates and compute any back wages.
            </EmptyState>
          ) : (
            <EmptyState title="No underpayments found">
              Every checked payroll line meets the wage determination for basic rate, fringe and overtime. When a line is paid short,
              the amount owed appears here so you can track it until the contractor pays.
            </EmptyState>
          )}
        </Panel>
      </div>
    );
  }

  const t = ledger.totals;
  const awaitingProof = cents(sum(items.filter((i) => i.row.status === 'paid').map((i) => i.row.amountPaid)));
  const verifiedPaid = cents(sum(items.filter((i) => i.row.status === 'verified').map((i) => i.row.amountPaid)));
  const openCount = statusCounts.owed + statusCounts.requested + statusCounts.paid;
  const workerCount = new Set(items.map((i) => `${i.row.finding.contractorId}|${i.line?.workerId || i.row.finding.workerName || ''}`)).size;
  const showContractor = !contractor;
  const filtersActive = Boolean(contractor || status || q.trim());
  const visOwed = cents(sum(visible.map((i) => i.row.amountOwed)));
  const visPaid = cents(sum(visible.map((i) => i.row.amountPaid)));
  const visBalance = cents(sum(visible.map((i) => i.row.balance)));
  const reopenBalance = pending ? cents(pending.row.amountOwed - Math.min(pending.next.amountPaid, pending.row.amountOwed)) : 0;

  return (
    <div className="page">
      <PageHeader
        title="Restitution"
        subtitle={subtitle}
        actions={
          <>
            <Button icon="doc" onClick={() => navigate(projectPath(pid, 'documents'))}>Letters & documents</Button>
            <Button icon="download" onClick={exportCsv} title={`All ${plural(items.length, 'item')}, including verified and waived`}>
              Export ledger CSV
            </Button>
          </>
        }
      />

      <div className="kpis">
        <div className="kpi">
          <div className="label">Total back wages found</div>
          <div className="value">{formatMoney(t.owed)}</div>
          <div className="sub">
            {plural(items.length, 'item')} · {plural(workerCount, 'worker')} · {plural(groups.length, 'contractor')}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Paid (reported by contractors)</div>
          <div className="value">{formatMoney(t.paid)}</div>
          <div className="sub">{awaitingProof > 0 ? `${formatMoney(awaitingProof)} awaiting proof of payment` : 'None awaiting proof of payment'}</div>
        </div>
        <div className="kpi">
          <div className="label" title="Amounts owed less payments the contractor reports, on items not yet verified or waived">
            Outstanding balance (not verified)
          </div>
          <div className={`value ${t.outstanding > 0 ? 'bad' : ''}`}>{formatMoney(t.outstanding)}</div>
          <div className="sub">
            {plural(openCount, 'open item')}
            {t.byStatus.owed > 0 && ` · ${formatMoney(t.byStatus.owed)} not yet requested`}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Verified paid</div>
          <div className="value">{formatMoney(verifiedPaid)}</div>
          <div className="sub">
            {statusCounts.verified} of {plural(items.length, 'item')}
            {t.byStatus.waived > 0 && ` · ${formatMoney(t.byStatus.waived)} waived`}
          </div>
        </div>
      </div>

      {uncheckedLines > 0 && (
        <div style={{ marginBottom: 16 }}>
          <UncheckedAlert count={uncheckedLines} pid={pid} />
        </div>
      )}

      {groups.length > 1 && (
        <Panel title="By contractor" bodyClass="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Contractor</th>
                <th className="num">Items</th>
                <th className="num">Open</th>
                <th className="num">Found</th>
                <th className="num">Paid (reported)</th>
                <th className="num">Verified</th>
                <th className="num">Outstanding</th>
                <th className="tight"><span className="sr-only">Filter the ledger</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id} className={contractor === g.id ? 'selected' : ''}>
                  <td>{g.name}</td>
                  <td className="num">{g.items}</td>
                  <td className="num">{g.open || <span className="faint">0</span>}</td>
                  <td className="num"><Money value={g.owed} /></td>
                  <td className="num"><Money value={g.paid} /></td>
                  <td className="num"><Money value={g.verified} /></td>
                  <td className={`num ${g.outstanding > 0 ? 'cell-bad' : ''}`}><Money value={g.outstanding} /></td>
                  <td className="tight">
                    <Button size="sm" variant="ghost" onClick={() => focusContractor(g.id)} aria-label={contractor === g.id ? 'Show all contractors in the ledger' : `Show ${g.name} items in the ledger`}>
                      {contractor === g.id ? 'Show all' : 'Show items'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{items.length}</td>
                <td className="num">{openCount}</td>
                <td className="num"><Money value={t.owed} zero="$0.00" /></td>
                <td className="num"><Money value={t.paid} zero="$0.00" /></td>
                <td className="num"><Money value={verifiedPaid} zero="$0.00" /></td>
                <td className="num"><Money value={t.outstanding} zero="$0.00" /></td>
                <td />
              </tr>
            </tfoot>
          </table>
        </Panel>
      )}

      <div ref={ledgerRef} style={{ marginTop: groups.length > 1 ? 16 : 0, scrollMarginTop: 16 }}>
        <div className="toolbar">
          <input
            className="input grow"
            type="search"
            placeholder="Search worker, finding, note, payroll no.…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search the ledger"
          />
          <select className="select" value={contractor} onChange={(e) => setContractor(e.target.value)} aria-label="Filter by contractor">
            <option value="">All contractors</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <select className="select" value={status} onChange={(e) => changeStatusFilter(e.target.value as '' | RestitutionStatus)} aria-label="Filter by status">
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{`${RESTITUTION_STATUS_LABELS[s]} (${statusCounts[s]})`}</option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={outstandingOnly} onChange={(e) => changeOutstanding(e.target.checked)} />
            Outstanding only
          </label>
        </div>

        <Panel
          title={
            <h2>
              Ledger{' '}
              <span className="muted small" style={{ fontWeight: 400 }}>
                {visible.length === items.length ? plural(items.length, 'item') : `${visible.length} of ${plural(items.length, 'item')}`}
                {closedHidden > 0 && ` · ${closedHidden} verified or waived hidden`}
              </span>
            </h2>
          }
          actions={
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              {selectedVisible.length > 0 && (
                <>
                  <span className="small muted nowrap" aria-live="polite">
                    {selectedVisible.length} selected
                    {eligible.length > 0 ? ` · ${eligible.length} owed (${formatMoney(eligibleOwed)})` : ' · none with status Owed'}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
                </>
              )}
              <Button
                size="sm"
                variant="primary"
                icon="mail"
                disabled={eligible.length === 0}
                title={eligible.length === 0 ? 'Select items with status Owed to mark them Requested' : undefined}
                onClick={() => setBulkOpen(true)}
              >
                Mark requested
              </Button>
            </div>
          }
          bodyClass="table-wrap"
        >
          {visible.length === 0 ? (
            outstandingOnly && !filtersActive ? (
              <EmptyState title="All back wages are verified or waived" actions={<Button onClick={() => changeOutstanding(false)}>Show verified and waived items</Button>}>
                Nothing is outstanding. {formatMoney(verifiedPaid)} verified paid
                {t.byStatus.waived > 0 ? `, ${formatMoney(t.byStatus.waived)} waived` : ''}.
              </EmptyState>
            ) : (
              <EmptyState title="No items match these filters" actions={<Button onClick={clearFilters}>Clear filters</Button>} />
            )
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th className="tight">
                    <SelectAll
                      checked={allVisibleSelected}
                      indeterminate={selectedVisible.length > 0 && !allVisibleSelected}
                      onChange={toggleAllVisible}
                    />
                  </th>
                  {showContractor && <th>Contractor</th>}
                  <th>Week ending</th>
                  <th>Worker</th>
                  <th>Finding</th>
                  <th className="num">Owed</th>
                  <th>Status</th>
                  <th className="num">Amount paid</th>
                  <th className="num">Balance</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <LedgerLine
                    key={item.key}
                    item={item}
                    pid={pid}
                    showContractor={showContractor}
                    selected={selected.has(item.key)}
                    onSelect={toggleOne}
                    onSave={save}
                    onStatus={requestStatus}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={showContractor ? 5 : 4}>
                    Total{visible.length !== items.length ? ` of ${plural(visible.length, 'item')} shown` : ''}
                  </td>
                  <td className="num"><Money value={visOwed} zero="$0.00" /></td>
                  <td />
                  <td className="num"><Money value={visPaid} zero="$0.00" /></td>
                  <td className={`num ${visBalance > 0 ? 'cell-bad' : ''}`}><Money value={visBalance} zero="$0.00" /></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </Panel>
      </div>

      <div style={{ marginTop: 16 }}>
        <Panel title="Closing out back wages">
          <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, color: 'var(--ink-2)' }}>
            <li>
              Proof of payment normally means copies of cancelled checks or receipts signed by each worker. Mark an item Verified only after
              you have seen that proof.
            </li>
            <li>The contractor should also submit corrected (or supplemental) certified payrolls that show the back wages paid to each worker.</li>
            <li>
              If underpayments are not resolved, the contracting agency may withhold enough from contract payments to cover the back wages
              (29 CFR 5.5(a)(2)).
            </li>
            <li>Use Waived only when an amount turns out not to be owed, and record why.</li>
          </ul>
        </Panel>
      </div>

      <ConfirmModal
        open={bulkOpen}
        title="Mark back wages as requested"
        confirmLabel={`Mark ${plural(eligible.length, 'item')} requested`}
        message={
          <>
            <p>
              Mark {plural(eligible.length, 'item')} totaling <strong>{formatMoney(eligibleOwed)}</strong> as Requested
              {eligibleNames.length > 0 && eligibleNames.length <= 3 ? ` (${eligibleNames.join(', ')})` : ''}. Use this once the contractor
              has been asked in writing to pay them.
            </p>
            {selectedVisible.length > eligible.length && (
              <p className="muted small">
                {plural(selectedVisible.length - eligible.length, 'selected item')} already requested, paid, verified or waived will be left as{' '}
                {selectedVisible.length - eligible.length === 1 ? 'it is' : 'they are'}.
              </p>
            )}
            <Field label="Add to each item's note (optional)" hint="For example, the date and reference of the correction letter.">
              <input
                className="input"
                value={bulkNote}
                onChange={(e) => setBulkNote(e.target.value)}
                placeholder={`Correction letter sent ${formatDate(view.asOf)}`}
                maxLength={200}
                aria-label="Add to each item's note (optional)"
              />
            </Field>
          </>
        }
        onConfirm={applyBulk}
        onClose={() => setBulkOpen(false)}
      />

      <ConfirmModal
        open={pending !== null}
        title={pending?.reason === 'partial-verify' ? 'Verify a partial payment?' : 'Reopen this item?'}
        confirmLabel={pending?.reason === 'partial-verify' ? 'Mark verified' : `Set to ${pending ? RESTITUTION_STATUS_LABELS[pending.next.status] : ''}`}
        message={
          pending &&
          (pending.reason === 'partial-verify' ? (
            <p>
              Only {formatMoney(pending.next.amountPaid)} of the {formatMoney(pending.row.amountOwed)} owed to {pending.row.finding.workerName ?? 'this worker'} is
              recorded as paid. Marking it Verified closes the item and drops the remaining{' '}
              <strong>{formatMoney(cents(pending.row.amountOwed - pending.next.amountPaid))}</strong> from the outstanding balance. To record a
              full payment, enter the amount paid first.
            </p>
          ) : (
            <p>
              {who(pending.row)} is currently <strong>{RESTITUTION_STATUS_LABELS[pending.row.status]}</strong>. Setting it to{' '}
              {RESTITUTION_STATUS_LABELS[pending.next.status]} reopens it
              {reopenBalance > 0 ? (
                <>
                  {' '}and puts <strong>{formatMoney(reopenBalance)}</strong> back in the outstanding balance.
                </>
              ) : (
                '. No balance is outstanding at the recorded amount paid.'
              )}
            </p>
          ))
        }
        onConfirm={async () => {
          if (pending) await save(pending.row, pending.next);
        }}
        onClose={() => setPending(null)}
      />

      <Modal
        open={waive !== null}
        title="Waive back wages"
        onClose={() => setWaive(null)}
        footer={
          <>
            <Button onClick={() => setWaive(null)} disabled={waiveBusy}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmWaive()} disabled={waiveBusy || !waiveReason.trim()}>
              Mark waived
            </Button>
          </>
        }
      >
        {waive && (
          <>
            <dl className="kv" style={{ marginBottom: 12 }}>
              <dt>Worker</dt>
              <dd>{waive.row.finding.workerName ?? '—'} · {waive.row.contractorName}</dd>
              <dt>Week ending</dt>
              <dd>{formatDate(waive.row.finding.weekEnding)}</dd>
              <dt>Finding</dt>
              <dd>{stripWorker(waive.row.finding.title, waive.row.finding.workerName)}</dd>
              <dt>Amount</dt>
              <dd><strong>{formatMoney(waive.row.amountOwed)}</strong></dd>
            </dl>
            <p className="small muted">
              Waiving removes this amount from the outstanding balance. Use it only when the amount is not owed after all, for example when the
              contracting agency has confirmed the classification the contractor used. The reason is kept in the item's note and the activity log.
            </p>
            <div className="field">
              <label htmlFor="waive-reason">Reason</label>
              <textarea
                id="waive-reason"
                className="input"
                style={{ minHeight: 70 }}
                value={waiveReason}
                maxLength={500}
                onChange={(e) => setWaiveReason(e.target.value)}
                placeholder="e.g. Agency confirmed Laborer Group 2 applies (email from the program officer, 9/24)"
              />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function UncheckedAlert({ count, pid }: { count: number; pid: string }) {
  return (
    <Alert tone="warn">
      {plural(count, 'payroll line')} {count === 1 ? 'is' : 'are'} not rate-checked yet because the job title is not matched to a wage
      determination classification or is not on the WD. Any back wages on {count === 1 ? 'it are' : 'them are'} not included here.{' '}
      <a href={`#${projectPath(pid, 'wd', 'mappings')}`}>Match job titles</a>
    </Alert>
  );
}

function SelectAll({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label="Select all items shown" />;
}

function LedgerLine({
  item,
  pid,
  showContractor,
  selected,
  onSelect,
  onSave,
  onStatus,
}: {
  item: Item;
  pid: string;
  showContractor: boolean;
  selected: boolean;
  onSelect: (key: string, on: boolean) => void;
  onSave: (row: LedgerRow, next: Entry) => Promise<void>;
  onStatus: (row: LedgerRow, next: RestitutionStatus, drafts: { amountPaid: number; note: string }) => void;
}) {
  const { row, line } = item;
  const f = row.finding;
  const toast = useToast();
  const [paid, setPaid] = useState(fmtPaid(row.amountPaid));
  const [paidInvalid, setPaidInvalid] = useState(false);
  const [note, setNote] = useState(row.note);
  /** Set when Escape reverts a draft, so the blur that follows does not save it. */
  const skipBlur = useRef(false);

  // Take the saved values after each reload.
  useEffect(() => {
    setPaid(fmtPaid(row.amountPaid));
    setPaidInvalid(false);
  }, [row.amountPaid]);
  useEffect(() => setNote(row.note), [row.note]);

  const label = `${f.workerName ?? 'worker'}, week ending ${formatDate(f.weekEnding)}`;

  /** Parse the amount-paid draft; null when it is not a usable amount. */
  const parsePaid = (): number | null => {
    const raw = paid.trim();
    if (raw === '') return 0;
    const n = parseAmount(raw);
    if (n === null || n < 0 || cents(n) > row.amountOwed) return null;
    return cents(n);
  };

  const commitPaid = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    const amount = parsePaid();
    if (amount === null) {
      setPaidInvalid(true);
      toast(`Enter an amount from $0.00 to ${formatMoney(row.amountOwed)} (the amount owed). Note any overpayment in the note.`, 'bad');
      return;
    }
    setPaidInvalid(false);
    if (amount === row.amountPaid) {
      setPaid(fmtPaid(row.amountPaid));
      return;
    }
    // Entering a payment on an item that is still owed or requested means the contractor reports paying it.
    const status: RestitutionStatus = amount > 0 && (row.status === 'owed' || row.status === 'requested') ? 'paid' : row.status;
    void onSave(row, { status, amountPaid: amount, note });
  };

  const commitNote = () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    if (note.trim() === row.note) return;
    void onSave(row, { status: row.status, amountPaid: parsePaid() ?? row.amountPaid, note });
  };

  /** Enter saves (via blur); Escape restores the saved value. */
  const keys = (revert: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      skipBlur.current = true;
      revert();
      e.currentTarget.blur();
    }
  };

  const open = !(row.status === 'verified' || row.status === 'waived');
  const payrollHref = item.payrollId ? `#${projectPath(pid, 'payrolls', item.payrollId)}` : null;
  const workerSub = [line?.workerId ? `ID ${line.workerId}` : '', line?.classification ?? ''].filter(Boolean).join(' · ');

  return (
    <tr className={selected ? 'selected' : ''}>
      <td className="tight">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(item.key, e.target.checked)} aria-label={`Select ${label}`} />
      </td>
      {showContractor && <td style={{ minWidth: 140 }}>{row.contractorName}</td>}
      <td className="nowrap">
        {payrollHref ? (
          <a href={payrollHref} aria-label={`Open payroll ${item.payrollNumber || ''} for week ending ${formatDate(f.weekEnding)}`}>
            {formatDate(f.weekEnding)}
          </a>
        ) : (
          formatDate(f.weekEnding)
        )}
        {item.payrollId && <div className="sub">Payroll {item.payrollNumber || '(no no.)'}</div>}
      </td>
      <td style={{ minWidth: 130 }}>
        <strong>{f.workerName || <span className="faint">—</span>}</strong>
        {workerSub && <div className="sub">{workerSub}</div>}
      </td>
      <td style={{ minWidth: 220 }}>
        <div title={f.detail}>{item.title}</div>
        <div className="sub">{RULE_LABELS[f.ruleId]}</div>
      </td>
      <td className="num"><Money value={row.amountOwed} /></td>
      <td className="nowrap">
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <span className={`dot ${STATUS_DOT[row.status]}`} aria-hidden="true" />
          <select
            className="select sm"
            style={{ width: 'auto', minWidth: 140 }}
            value={row.status}
            onChange={(e) => onStatus(row, e.target.value as RestitutionStatus, { amountPaid: parsePaid() ?? row.amountPaid, note })}
            aria-label={`Status for ${label}`}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{RESTITUTION_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        {row.updatedAt && <div className="sub" style={{ marginLeft: 14 }}>Updated {formatDate(localDay(row.updatedAt))}</div>}
      </td>
      <td className="num">
        {row.status === 'waived' ? (
          <span className="faint">—</span>
        ) : (
          <input
            className={`input sm num ${paidInvalid ? 'invalid' : ''}`}
            style={{ width: 100 }}
            inputMode="decimal"
            autoComplete="off"
            value={paid}
            placeholder="0.00"
            onChange={(e) => setPaid(e.target.value)}
            onBlur={commitPaid}
            onKeyDown={keys(() => {
              setPaid(fmtPaid(row.amountPaid));
              setPaidInvalid(false);
            })}
            aria-label={`Amount paid to ${label}`}
            aria-invalid={paidInvalid || undefined}
          />
        )}
      </td>
      <td className={`num ${open && row.balance > 0 ? 'cell-bad' : ''}`}><Money value={row.balance} /></td>
      <td style={{ minWidth: 180 }}>
        <input
          className="input sm"
          value={note}
          maxLength={500}
          placeholder="Check no., date, contact…"
          onChange={(e) => setNote(e.target.value)}
          onBlur={commitNote}
          onKeyDown={keys(() => setNote(row.note))}
          aria-label={`Note for ${label}`}
          title={note || undefined}
        />
      </td>
    </tr>
  );
}
