import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { newId } from '../../db/db';
import { blankContractor, deleteContractor, saveContractor } from '../../db/repo';
import { formatDate, isIsoDate } from '../../engine/dates';
import { cents, formatMoney } from '../../engine/money';
import type { ApprenticeProgram, Contractor, ContractorTier } from '../../engine/types';
import { useDocumentTitle } from '../router';
import { projectStore, type ProjectView } from '../store';
import { Alert, Badge, Button, ConfirmModal, EmptyState, Modal, Money, PageHeader, Panel, useToast } from '../ui';

/**
 * Contractors: the prime and subcontractor roster. Each contractor's start and end dates set
 * which weeks a certified payroll is expected (missing-week detection), and their registered
 * apprenticeship programs set the apprentice rates, fringe and ratio the payrolls are checked
 * against.
 */

const TIERS: ContractorTier[] = ['prime', 'subcontractor', 'lower-tier'];

const TIER_BADGE: Record<ContractorTier, string> = {
  prime: 'Prime',
  subcontractor: 'Subcontractor',
  'lower-tier': 'Lower-tier',
};

const TIER_OPTION: Record<ContractorTier, string> = {
  prime: 'Prime contractor',
  subcontractor: 'Subcontractor',
  'lower-tier': 'Lower-tier subcontractor',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Lets a long numeric column header wrap onto two lines. */
const WRAP: CSSProperties = { whiteSpace: 'normal' };
/** Validation text under a control in a narrow table cell. */
const CELL_MSG: CSSProperties = { whiteSpace: 'normal', maxWidth: 160 };
const NUM_FIELD: CSSProperties = { alignItems: 'flex-end' };
const ELLIPSIS: CSSProperties = { maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

// ---------------------------------------------------------------------------
// Per-contractor figures for the roster
// ---------------------------------------------------------------------------

interface ContractorStats {
  payrolls: number;
  firstWeek: string | null;
  finalWeek: string | null;
  weeksExpected: number;
  missingWeeks: number;
  violations: number;
  warnings: number;
  outstanding: number;
  unverifiedApprentices: number;
}

const ZERO: ContractorStats = {
  payrolls: 0,
  firstWeek: null,
  finalWeek: null,
  weeksExpected: 0,
  missingWeeks: 0,
  violations: 0,
  warnings: 0,
  outstanding: 0,
  unverifiedApprentices: 0,
};

function useContractorStats(view: ProjectView): Map<string, ContractorStats> {
  const { data, evaluation, openFindings, ledger } = view;
  return useMemo(() => {
    const map = new Map<string, ContractorStats>();
    const get = (id: string) => {
      let s = map.get(id);
      if (!s) {
        s = { ...ZERO };
        map.set(id, s);
      }
      return s;
    };
    for (const c of data.contractors) get(c.id);
    for (const p of data.payrolls) {
      const s = get(p.contractorId);
      s.payrolls++;
      if (!s.firstWeek || p.weekEnding < s.firstWeek) s.firstWeek = p.weekEnding;
      if (p.isFinal && (!s.finalWeek || p.weekEnding > s.finalWeek)) s.finalWeek = p.weekEnding;
    }
    for (const w of evaluation.weeks) {
      get(w.contractorId).weeksExpected = w.cells.filter((cell) => cell.state !== 'not-due').length;
    }
    for (const f of openFindings) {
      const s = get(f.contractorId);
      if (f.severity === 'violation') s.violations++;
      else if (f.severity === 'warning') s.warnings++;
      if (f.ruleId === 'missing-week') s.missingWeeks++;
      if (f.ruleId === 'apprentice-unregistered') s.unverifiedApprentices++;
    }
    for (const r of ledger.rows) {
      const s = get(r.finding.contractorId);
      s.outstanding = cents(s.outstanding + r.balance);
    }
    return map;
  }, [data.contractors, data.payrolls, evaluation.weeks, openFindings, ledger.rows]);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface EditTarget {
  contractor: Contractor;
  isNew: boolean;
}

export function ContractorsPage({ view }: { view: ProjectView }) {
  useDocumentTitle('Contractors');
  const { data } = view;
  const toast = useToast();
  const stats = useContractorStats(view);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [deleting, setDeleting] = useState<Contractor | null>(null);

  const openAdd = () => setEditing({ contractor: blankContractor(data.project.id), isNew: true });
  const openEdit = (c: Contractor) => setEditing({ contractor: c, isNew: false });

  const statsFor = (id: string) => stats.get(id) ?? ZERO;
  const totals = data.contractors.reduce(
    (t, c) => {
      const s = statsFor(c.id);
      return {
        payrolls: t.payrolls + s.payrolls,
        violations: t.violations + s.violations,
        outstanding: cents(t.outstanding + s.outstanding),
        programs: t.programs + c.apprenticePrograms.length,
      };
    },
    { payrolls: 0, violations: 0, outstanding: 0, programs: 0 },
  );

  const tierCounts = TIERS.map((tier) => ({ tier, n: data.contractors.filter((c) => c.tier === tier).length })).filter((x) => x.n > 0);
  const subtitle =
    data.contractors.length === 0
      ? 'The prime contractor and every subcontractor expected to submit weekly certified payrolls.'
      : `${tierCounts
          .map(({ tier, n }) =>
            tier === 'prime' ? plural(n, 'prime contractor') : tier === 'subcontractor' ? plural(n, 'subcontractor') : `${n} lower-tier`,
          )
          .join(', ')} · a payroll is expected every week from each start date`;

  const remove = async (c: Contractor) => {
    const n = statsFor(c.id).payrolls;
    try {
      await projectStore.mutate(() => deleteContractor(c));
      toast(n > 0 ? `Deleted ${c.name} and ${plural(n, 'payroll')}` : `Deleted ${c.name}`);
    } catch (e) {
      toast(`Could not delete the contractor: ${(e as Error).message}`, 'bad');
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Contractors"
        subtitle={subtitle}
        actions={
          data.contractors.length > 0 ? (
            <Button variant="primary" icon="plus" onClick={openAdd}>Add contractor</Button>
          ) : undefined
        }
      />

      {data.contractors.length === 0 ? (
        <Panel>
          <EmptyState title="No contractors yet" actions={<Button variant="primary" icon="plus" onClick={openAdd}>Add contractor</Button>}>
            <p style={{ maxWidth: 600, margin: '0 auto' }}>
              Add the prime contractor and each subcontractor that will work on site. Their start and end dates tell Wagebench which weeks a certified
              payroll is due, so a week with no payroll is flagged as missing once it is overdue. Imported payrolls are filed under the contractor who
              submitted them, and their registered apprenticeship programs are used to check apprentice rates and ratios.
            </p>
          </EmptyState>
        </Panel>
      ) : (
        <Panel bodyClass="table-wrap">
          <table className="data">
            <thead style={{ verticalAlign: 'bottom' }}>
              <tr>
                <th style={{ minWidth: 130 }}>Contractor</th>
                <th>Trade</th>
                <th>Payroll weeks</th>
                <th>Contact</th>
                <th className="num">Payrolls</th>
                <th className="num" style={WRAP}>Open violations</th>
                <th className="num" style={WRAP}>Restitution outstanding</th>
                <th className="num" style={WRAP}>Apprentice programs</th>
                <th className="tight"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {data.contractors.map((c) => {
                const s = statsFor(c.id);
                return (
                  <tr key={c.id} className={s.violations > 0 ? 'row-bad' : ''}>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <strong>{c.name || <em className="faint">Unnamed</em>}</strong>
                        <Badge tone={c.tier === 'prime' ? 'accent' : 'neutral'}>{TIER_BADGE[c.tier]}</Badge>
                      </div>
                    </td>
                    <td>{c.trade || <span className="faint">—</span>}</td>
                    <td><WeeksCell contractor={c} stats={s} /></td>
                    <td>
                      {c.contactName || (!c.contactEmail && <span className="faint">—</span>)}
                      {c.contactEmail && (
                        <div className={c.contactName ? 'sub' : undefined} style={ELLIPSIS}>
                          <a href={`mailto:${c.contactEmail}`} title={c.contactEmail}>{c.contactEmail}</a>
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {s.payrolls === 0 ? <span className="faint">0</span> : s.payrolls}
                      {s.missingWeeks > 0 && (
                        <div className="sub">
                          <span className="cell-bad">{s.missingWeeks} missing</span>
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {s.violations > 0 ? <span className="cell-bad">{s.violations}</span> : <span className="faint">0</span>}
                      {s.warnings > 0 && <div className="sub">{plural(s.warnings, 'warning')}</div>}
                    </td>
                    <td className={`num ${s.outstanding > 0 ? 'cell-bad' : ''}`}>
                      <Money value={s.outstanding} />
                    </td>
                    <td className="num">
                      {c.apprenticePrograms.length === 0 ? (
                        <span className="faint">0</span>
                      ) : (
                        <span title={c.apprenticePrograms.map((p) => p.name || 'Unnamed program').join('\n')}>{c.apprenticePrograms.length}</span>
                      )}
                      {s.unverifiedApprentices > 0 && (
                        <div className="sub" title="Apprentice lines that can't be checked until a registered program with a wage percentage is recorded">
                          <span className="cell-warn">{s.unverifiedApprentices} unverified</span>
                        </div>
                      )}
                    </td>
                    <td className="tight">
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        <Button size="sm" variant="ghost" icon="edit" onClick={() => openEdit(c)} aria-label={`Edit ${c.name}`} title="Edit contractor" />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          onClick={() => setDeleting(c)}
                          aria-label={`Delete ${c.name}`}
                          title="Delete contractor"
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {data.contractors.length > 1 && (
              <tfoot>
                <tr>
                  <td colSpan={4}>Total</td>
                  <td className="num">{totals.payrolls}</td>
                  <td className={`num ${totals.violations > 0 ? 'cell-bad' : ''}`}>{totals.violations}</td>
                  <td className={`num ${totals.outstanding > 0 ? 'cell-bad' : ''}`}><Money value={totals.outstanding} /></td>
                  <td className="num">{totals.programs}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </Panel>
      )}

      <ContractorEditor view={view} target={editing} onClose={() => setEditing(null)} />

      <ConfirmModal
        open={deleting !== null}
        danger
        title="Delete this contractor?"
        confirmLabel="Delete contractor"
        message={deleting ? <DeleteMessage contractor={deleting} stats={statsFor(deleting.id)} /> : null}
        onClose={() => setDeleting(null)}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </div>
  );
}

function WeeksCell({ contractor: c, stats: s }: { contractor: Contractor; stats: ContractorStats }) {
  const start = c.startDate ?? s.firstWeek;
  if (!start) {
    return (
      <>
        <span className="cell-warn">No start date</span>
        <div className="sub">Missing weeks not tracked</div>
      </>
    );
  }
  const notes = [
    c.startDate ? null : 'from first payroll',
    s.weeksExpected > 0 ? `${plural(s.weeksExpected, 'week')} expected` : 'none due yet',
    s.finalWeek ? `final received ${formatDate(s.finalWeek)}` : null,
  ].filter(Boolean);
  return (
    <>
      <span className="nowrap">
        {formatDate(start)} – {c.endDate ? formatDate(c.endDate) : 'ongoing'}
      </span>
      <div className="sub">{capitalize(notes.join(' · '))}</div>
    </>
  );
}

function DeleteMessage({ contractor, stats }: { contractor: Contractor; stats: ContractorStats }) {
  return (
    <>
      <p>
        Delete <strong>{contractor.name || 'this contractor'}</strong> from the project?
      </p>
      <p>
        {stats.payrolls > 0
          ? `This also deletes their ${plural(stats.payrolls, 'certified payroll')} and saved job title matches. Findings and restitution tracking tied to those payrolls will no longer appear.`
          : 'They have no payrolls on file. Any job title matches saved for them are deleted too.'}{' '}
        This cannot be undone.
      </p>
      {stats.outstanding > 0 && (
        <Alert tone="warn">
          {formatMoney(stats.outstanding)} in restitution is still outstanding for this contractor and will drop out of the restitution ledger.
        </Alert>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Add / edit modal
// ---------------------------------------------------------------------------

interface ProgramDraft {
  id: string;
  name: string;
  registeredWith: ApprenticeProgram['registeredWith'];
  classification: string;
  wagePercent: string;
  fringePercent: string;
  ratio: string;
}

interface Draft {
  name: string;
  tier: ContractorTier;
  trade: string;
  startDate: string;
  endDate: string;
  contactName: string;
  contactEmail: string;
  address: string;
  programs: ProgramDraft[];
}

type ProgramField = 'name' | 'classification' | 'wagePercent' | 'fringePercent' | 'ratio';
type Errors = Record<string, string>;

const numText = (n: number | null) => (n === null ? '' : String(n));

function toDraft(c: Contractor): Draft {
  return {
    name: c.name,
    tier: c.tier,
    trade: c.trade,
    startDate: c.startDate ?? '',
    endDate: c.endDate ?? '',
    contactName: c.contactName,
    contactEmail: c.contactEmail,
    address: c.address,
    programs: c.apprenticePrograms.map((p) => ({
      id: p.id,
      name: p.name,
      registeredWith: p.registeredWith,
      classification: p.classification,
      wagePercent: numText(p.wagePercent),
      fringePercent: numText(p.fringePercent),
      ratio: numText(p.maxApprenticesPerJourneyworker),
    })),
  };
}

/** Blank → null; "60", "60%", "0.5" → number; anything else → NaN. */
function readNumber(s: string): number | null {
  const t = s.trim().replace(/\s*%$/, '');
  if (t === '') return null;
  return /^\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}

function fromDraft(base: Contractor, d: Draft): Contractor {
  return {
    ...base,
    name: d.name.trim(),
    tier: d.tier,
    trade: d.trade.trim(),
    startDate: d.startDate || null,
    endDate: d.endDate || null,
    contactName: d.contactName.trim(),
    contactEmail: d.contactEmail.trim(),
    address: d.address.trim(),
    apprenticePrograms: d.programs.map((p) => ({
      id: p.id,
      name: p.name.trim(),
      registeredWith: p.registeredWith,
      classification: p.classification.trim(),
      wagePercent: readNumber(p.wagePercent),
      fringePercent: readNumber(p.fringePercent),
      maxApprenticesPerJourneyworker: readNumber(p.ratio),
    })),
  };
}

const programKey = (id: string, field: ProgramField) => `program:${id}:${field}`;
const normName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function validate(d: Draft, others: readonly Contractor[], selfId: string): Errors {
  const e: Errors = {};
  const name = normName(d.name);
  if (!name) e.name = 'Enter the contractor’s name.';
  else if (others.some((c) => c.id !== selfId && normName(c.name) === name)) e.name = 'Another contractor on this project already has this name.';
  if (d.startDate && !isIsoDate(d.startDate)) e.startDate = 'Enter a valid date.';
  if (d.endDate && !isIsoDate(d.endDate)) e.endDate = 'Enter a valid date.';
  else if (d.endDate && d.startDate && isIsoDate(d.startDate) && d.endDate < d.startDate) e.endDate = 'The end date is before the start date.';
  if (d.contactEmail.trim() && !EMAIL.test(d.contactEmail.trim())) e.contactEmail = 'Enter an email address like name@company.com.';

  for (const p of d.programs) {
    if (!p.name.trim()) e[programKey(p.id, 'name')] = 'Name the program.';
    if (d.programs.length > 1 && !p.classification.trim()) {
      e[programKey(p.id, 'classification')] = 'Required when there is more than one program.';
    }
    const wage = readNumber(p.wagePercent);
    if (wage !== null && !(wage > 0 && wage <= 100)) e[programKey(p.id, 'wagePercent')] = 'Enter more than 0, up to 100.';
    const fringe = readNumber(p.fringePercent);
    if (fringe !== null && !(fringe >= 0 && fringe <= 100)) e[programKey(p.id, 'fringePercent')] = 'Enter 0 to 100.';
    const ratio = readNumber(p.ratio);
    if (ratio !== null && !(ratio > 0)) e[programKey(p.id, 'ratio')] = 'Enter a number above 0.';
  }
  return e;
}

function ContractorEditor({ view, target, onClose }: { view: ProjectView; target: EditTarget | null; onClose: () => void }) {
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const isNew = target?.isNew ?? true;
  return (
    <Modal
      open={target !== null}
      wide
      title={isNew ? 'Add contractor' : `Edit ${target?.contractor.name ?? 'contractor'}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {isNew ? 'Add contractor' : 'Save changes'}
          </Button>
        </>
      }
    >
      {target && (
        <ContractorForm
          key={target.contractor.id}
          formId={formId}
          view={view}
          contractor={target.contractor}
          isNew={target.isNew}
          onBusy={setBusy}
          onSaved={onClose}
        />
      )}
    </Modal>
  );
}

function ContractorForm({
  formId,
  view,
  contractor,
  isNew,
  onBusy,
  onSaved,
}: {
  formId: string;
  view: ProjectView;
  contractor: Contractor;
  isNew: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(contractor));
  const [attempted, setAttempted] = useState(false);

  // The dialog focuses its first control when it opens; move focus to the name field after that.
  useEffect(() => {
    const t = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, []);

  const allErrors = useMemo(() => validate(draft, view.data.contractors, contractor.id), [draft, view.data.contractors, contractor.id]);
  const errors: Errors = attempted ? allErrors : {};

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setProgram = (id: string, patch: Partial<ProgramDraft>) =>
    setDraft((d) => ({ ...d, programs: d.programs.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  const addProgram = () => {
    const id = newId();
    setDraft((d) => ({
      ...d,
      programs: [...d.programs, { id, name: '', registeredWith: 'OA', classification: '', wagePercent: '', fringePercent: '', ratio: '' }],
    }));
    window.setTimeout(() => document.getElementById(`${uid}-${id}-name`)?.focus(), 0);
  };
  const removeProgram = (id: string) => setDraft((d) => ({ ...d, programs: d.programs.filter((p) => p.id !== id) }));

  // Suggestions for "classification covered": apprentice job titles this contractor has used, then WD classifications.
  const classificationOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (s: string | null | undefined) => {
      const v = (s ?? '').trim();
      if (!v || seen.has(v.toLowerCase())) return;
      seen.add(v.toLowerCase());
      out.push(v);
    };
    for (const p of view.data.payrolls) {
      if (p.contractorId !== contractor.id) continue;
      for (const l of p.lines) if (l.apprentice) push(l.classification);
    }
    for (const c of view.data.wd?.parsed.classifications ?? []) {
      push(c.parent);
      push(c.label);
    }
    return out;
  }, [view.data.payrolls, view.data.wd, contractor.id]);

  // Apprentice lines on this contractor's payrolls that can't be checked yet.
  const unverified = useMemo(() => {
    const titles = new Set<string>();
    let count = 0;
    for (const f of view.openFindings) {
      if (f.contractorId !== contractor.id || f.ruleId !== 'apprentice-unregistered') continue;
      count++;
      const line = f.payrollId && f.lineId ? view.payrollById.get(f.payrollId)?.lines.find((l) => l.id === f.lineId) : undefined;
      if (line?.classification.trim()) titles.add(line.classification.trim());
    }
    return { count, titles: [...titles] };
  }, [view.openFindings, view.payrollById, contractor.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (Object.keys(allErrors).length > 0) {
      setAttempted(true);
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    const next = fromDraft(contractor, draft);
    onBusy(true);
    try {
      await projectStore.mutate(() => saveContractor(next));
      toast(isNew ? `Added ${next.name}` : `Saved changes to ${next.name}`);
      onSaved();
    } catch (err) {
      toast(`Could not save the contractor: ${(err as Error).message}`, 'bad');
    } finally {
      onBusy(false);
    }
  };

  const id = (field: string) => `${uid}-${field}`;
  const a11y = (field: string, hasHint = false) => ({
    id: id(field),
    'aria-invalid': Boolean(errors[field]),
    'aria-describedby': errors[field] || hasHint ? `${id(field)}-msg` : undefined,
  });
  const cls = (base: string, field: string) => `${base}${errors[field] ? ' invalid' : ''}`;

  return (
    <form id={formId} ref={formRef} onSubmit={submit} noValidate>
      <div className="form-grid">
        <FormField id={id('name')} label="Contractor name" error={errors.name} className="span-2">
          <input
            ref={nameRef}
            className={cls('input', 'name')}
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Legal name as it appears on the payroll"
            autoComplete="off"
            required
            {...a11y('name')}
          />
        </FormField>
        <FormField id={id('tier')} label="Tier">
          <select id={id('tier')} className="select" value={draft.tier} onChange={(e) => set('tier', e.target.value as ContractorTier)}>
            {TIERS.map((t) => (
              <option key={t} value={t}>{TIER_OPTION[t]}</option>
            ))}
          </select>
        </FormField>
        <FormField id={id('trade')} label="Trade or scope">
          <input id={id('trade')} className="input" value={draft.trade} onChange={(e) => set('trade', e.target.value)} placeholder="e.g. Electrical, site work" autoComplete="off" />
        </FormField>
      </div>

      <h3 style={{ margin: '20px 0 10px' }}>Payroll schedule</h3>
      <div className="form-grid">
        <FormField id={id('startDate')} label="Start date" hint="First week of work on site." error={errors.startDate}>
          <input type="date" className={cls('input', 'startDate')} value={draft.startDate} onChange={(e) => set('startDate', e.target.value)} {...a11y('startDate', true)} />
        </FormField>
        <FormField id={id('endDate')} label="End date (optional)" hint="Leave blank while work is ongoing." error={errors.endDate}>
          <input type="date" className={cls('input', 'endDate')} value={draft.endDate} onChange={(e) => set('endDate', e.target.value)} {...a11y('endDate', true)} />
        </FormField>
        <p className="muted small span-2" style={{ margin: 0, alignSelf: 'center' }}>
          These dates drive missing-week detection. A certified payroll, or a signed “no work performed” payroll, is expected for every week from the
          start date through the end date (or through today while work is ongoing); a week with neither is flagged as a missing payroll once it is
          overdue. Without a start date, tracking begins at the first payroll received.
        </p>
      </div>

      <h3 style={{ margin: '20px 0 10px' }}>Contact</h3>
      <div className="form-grid">
        <FormField id={id('contactName')} label="Contact name">
          <input id={id('contactName')} className="input" value={draft.contactName} onChange={(e) => set('contactName', e.target.value)} placeholder="Payroll or project contact" autoComplete="off" />
        </FormField>
        <FormField id={id('contactEmail')} label="Contact email" error={errors.contactEmail}>
          <input
            type="email"
            inputMode="email"
            className={cls('input', 'contactEmail')}
            value={draft.contactEmail}
            onChange={(e) => set('contactEmail', e.target.value)}
            placeholder="name@company.com"
            autoComplete="off"
            {...a11y('contactEmail')}
          />
        </FormField>
        <FormField id={id('address')} label="Address" className="span-2">
          <textarea
            id={id('address')}
            className="input"
            rows={3}
            style={{ minHeight: 64 }}
            value={draft.address}
            onChange={(e) => set('address', e.target.value)}
            placeholder="Street, city, state, ZIP"
          />
        </FormField>
      </div>

      <div className="row spread" style={{ margin: '24px 0 6px' }}>
        <h3>Registered apprenticeship programs</h3>
        <Button size="sm" icon="plus" onClick={addProgram}>Add program</Button>
      </div>
      <p className="muted small">
        Apprentices may be paid less than the journeyworker rate only while registered in a program registered with the U.S. DOL Office of
        Apprenticeship (OA) or a recognized State Apprenticeship Agency (SAA). Take each value from the program’s registered standards: the wage
        progression, the fringe provision and the allowed ratio. Leave fringe % blank when the standards don’t specify fringe benefits; the full WD
        fringe is then owed (29 CFR 5.5(a)(4)(i)). Apprentices are matched to a program by classification; a single program covers all of this
        contractor’s apprentices.
      </p>
      {unverified.count > 0 && (
        <div style={{ marginBottom: 10 }}>
          <Alert tone="warn">
            {plural(unverified.count, 'apprentice line')} on this contractor’s payrolls can’t be checked until a program with a wage percentage is
            recorded{unverified.titles.length > 0 ? ` (${unverified.titles.join(', ')})` : ''}.
          </Alert>
        </div>
      )}

      {draft.programs.length === 0 ? (
        <div className="muted small" style={{ padding: '12px 14px', border: '1px dashed var(--line-strong)', borderRadius: 'var(--radius-sm)' }}>
          No programs recorded. Apprentices on this contractor’s payrolls are flagged as unverified, and their rates are not checked until a program is
          added.
        </div>
      ) : (
        <div className="table-wrap" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
          <table className="data">
            <thead style={{ verticalAlign: 'bottom' }}>
              <tr>
                <th>Program name</th>
                <th>Registered with</th>
                <th>Classification covered</th>
                <th className="num" style={WRAP}>Wage %<div className="sub">of journeyworker rate</div></th>
                <th className="num" style={WRAP}>Fringe %<div className="sub">of WD fringe</div></th>
                <th className="num" style={WRAP}>Max apprentices<div className="sub">per journeyworker</div></th>
                <th className="tight"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {draft.programs.map((p, i) => {
                const label = p.name.trim() || `program ${i + 1}`;
                const err = (f: ProgramField) => errors[programKey(p.id, f)];
                const pid = (f: ProgramField) => `${uid}-${p.id}-${f}`;
                const described = (f: ProgramField, extra = false) => ({
                  id: pid(f),
                  'aria-invalid': Boolean(err(f)),
                  'aria-describedby': err(f) || extra ? `${pid(f)}-msg` : undefined,
                });
                const ratio = readNumber(p.ratio);
                const ratioHint = ratio !== null && ratio > 0 ? ratioText(ratio) : null;
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="field">
                        <input
                          className={`input sm${err('name') ? ' invalid' : ''}`}
                          style={{ minWidth: 160 }}
                          value={p.name}
                          onChange={(e) => setProgram(p.id, { name: e.target.value })}
                          placeholder="e.g. IBEW Local 1 JATC"
                          aria-label={`Program ${i + 1} name`}
                          autoComplete="off"
                          {...described('name')}
                        />
                        {err('name') && <div className="error" style={CELL_MSG} id={`${pid('name')}-msg`}>{err('name')}</div>}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select sm"
                        style={{ minWidth: 124 }}
                        title={p.registeredWith === 'OA' ? 'U.S. DOL Office of Apprenticeship' : 'State Apprenticeship Agency'}
                        value={p.registeredWith}
                        onChange={(e) => setProgram(p.id, { registeredWith: e.target.value as ApprenticeProgram['registeredWith'] })}
                        aria-label={`Registration agency for ${label}`}
                      >
                        <option value="OA">OA (U.S. DOL)</option>
                        <option value="SAA">SAA (State)</option>
                      </select>
                    </td>
                    <td>
                      <div className="field">
                        <input
                          className={`input sm${err('classification') ? ' invalid' : ''}`}
                          style={{ minWidth: 150 }}
                          list={`${uid}-classes`}
                          value={p.classification}
                          onChange={(e) => setProgram(p.id, { classification: e.target.value })}
                          placeholder="e.g. Electrician"
                          aria-label={`Classification covered by ${label}`}
                          autoComplete="off"
                          {...described('classification')}
                        />
                        {err('classification') && <div className="error" style={CELL_MSG} id={`${pid('classification')}-msg`}>{err('classification')}</div>}
                      </div>
                    </td>
                    <td className="num">
                      <div className="field" style={NUM_FIELD}>
                        <input
                          className={`input sm num${err('wagePercent') ? ' invalid' : ''}`}
                          style={{ width: 72 }}
                          inputMode="decimal"
                          value={p.wagePercent}
                          onChange={(e) => setProgram(p.id, { wagePercent: e.target.value })}
                          placeholder="e.g. 60"
                          aria-label={`Apprentice wage percent of journeyworker rate, ${label}`}
                          {...described('wagePercent')}
                        />
                        {err('wagePercent') && <div className="error" style={CELL_MSG} id={`${pid('wagePercent')}-msg`}>{err('wagePercent')}</div>}
                      </div>
                    </td>
                    <td className="num">
                      <div className="field" style={NUM_FIELD}>
                        <input
                          className={`input sm num${err('fringePercent') ? ' invalid' : ''}`}
                          style={{ width: 72 }}
                          inputMode="decimal"
                          value={p.fringePercent}
                          onChange={(e) => setProgram(p.id, { fringePercent: e.target.value })}
                          placeholder="Full"
                          aria-label={`Apprentice fringe percent of WD fringe, ${label}. Blank means the full WD fringe is owed.`}
                          {...described('fringePercent')}
                        />
                        {err('fringePercent') && <div className="error" style={CELL_MSG} id={`${pid('fringePercent')}-msg`}>{err('fringePercent')}</div>}
                      </div>
                    </td>
                    <td className="num">
                      <div className="field" style={NUM_FIELD}>
                        <input
                          className={`input sm num${err('ratio') ? ' invalid' : ''}`}
                          style={{ width: 72 }}
                          inputMode="decimal"
                          value={p.ratio}
                          onChange={(e) => setProgram(p.id, { ratio: e.target.value })}
                          placeholder="e.g. 1"
                          aria-label={`Maximum apprentices per journeyworker, ${label}`}
                          {...described('ratio', Boolean(ratioHint))}
                        />
                        {err('ratio') ? (
                          <div className="error" style={CELL_MSG} id={`${pid('ratio')}-msg`}>{err('ratio')}</div>
                        ) : ratioHint ? (
                          <div className="hint" id={`${pid('ratio')}-msg`}>{ratioHint}</div>
                        ) : null}
                      </div>
                    </td>
                    <td className="tight">
                      <Button size="sm" variant="ghost" icon="x" onClick={() => removeProgram(p.id)} aria-label={`Remove ${label}`} title="Remove program" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {draft.programs.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Wage % blank: apprentice rates for this program are not checked. Max apprentices blank: the ratio is not checked. Apprentices over the ratio
          are owed the journeyworker rate.
        </p>
      )}
      <datalist id={`${uid}-classes`}>
        {classificationOptions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </form>
  );
}

/** Form field with a label bound to its control and the hint/error linked for screen readers. */
function FormField({ id, label, hint, error, className = '', children }: { id: string; label: string; hint?: ReactNode; error?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <div className="error" id={`${id}-msg`}>{error}</div>
      ) : hint ? (
        <div className="hint" id={`${id}-msg`}>{hint}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** 1 → "1:1 ratio", 0.5 → "1:2 ratio", 3 → "3:1 ratio" (apprentices : journeyworkers). */
function ratioText(r: number): string {
  const fmt = (x: number) => String(Math.round(x * 100) / 100);
  return r >= 1 ? `${fmt(r)}:1 ratio` : `1:${fmt(1 / r)} ratio`;
}
