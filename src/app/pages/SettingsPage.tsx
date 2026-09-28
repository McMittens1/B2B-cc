import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { exportProjectBackup } from '../../db/backup';
import { DEFAULT_SETTINGS, deleteProject, logActivity, updateProject } from '../../db/repo';
import { formatDate, isIsoDate, todayIso } from '../../engine/dates';
import { formatMoney } from '../../engine/money';
import type { FundingSource, Project } from '../../engine/types';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { projectStore, type ProjectView } from '../store';
import { Alert, Badge, Button, EmptyState, Modal, PageHeader, Panel, downloadFile, safeFileName, useToast } from '../ui';
import { FUNDING_SOURCES } from './NewProjectPage';

/**
 * Project settings: contract details, the reviewer printed on letters and stamps, the review
 * rules the compliance checks use, backups and deletion, and the project's activity log.
 */

// ---------------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  projectNumber: string;
  owner: string;
  location: string;
  fundingSource: FundingSource;
  wdLockDate: string;
  reviewerName: string;
  reviewerTitle: string;
  reviewerOrganization: string;
  reviewerEmail: string;
  reviewerPhone: string;
  overtimeRuleApplies: boolean;
  lateAfterDays: string;
  tolerance: string;
  eoMinimum: string;
}

type FieldKey = keyof FormState;
type TextKey = Exclude<FieldKey, 'overtimeRuleApplies'>;
type Section = 'contract' | 'reviewer' | 'rules';
type Errors = Partial<Record<FieldKey, string>>;

const SECTIONS: Section[] = ['contract', 'reviewer', 'rules'];
const SECTION_LABEL: Record<Section, string> = { contract: 'Contract', reviewer: 'Reviewer', rules: 'Review rules' };
const SECTION_FIELDS: Record<Section, FieldKey[]> = {
  contract: ['name', 'projectNumber', 'owner', 'location', 'fundingSource', 'wdLockDate'],
  reviewer: ['reviewerName', 'reviewerTitle', 'reviewerOrganization', 'reviewerEmail', 'reviewerPhone'],
  rules: ['overtimeRuleApplies', 'lateAfterDays', 'tolerance', 'eoMinimum'],
};
/** Field order used to focus the first invalid field on save. */
const FIELD_ORDER: FieldKey[] = SECTIONS.flatMap((s) => SECTION_FIELDS[s]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVITY_LIMIT = 50;

const fieldId = (k: FieldKey) => `settings-${k}`;

function toForm(project: Project): FormState {
  const reviewer = project.reviewer ?? { name: '', title: '', organization: '', email: '', phone: '' };
  const settings = { ...DEFAULT_SETTINGS, ...project.settings };
  return {
    name: project.name,
    projectNumber: project.projectNumber ?? '',
    owner: project.owner ?? '',
    location: project.location ?? '',
    fundingSource: project.fundingSource,
    wdLockDate: project.wdLockDate ?? '',
    reviewerName: reviewer.name ?? '',
    reviewerTitle: reviewer.title ?? '',
    reviewerOrganization: reviewer.organization ?? '',
    reviewerEmail: reviewer.email ?? '',
    reviewerPhone: reviewer.phone ?? '',
    overtimeRuleApplies: settings.overtimeRuleApplies,
    lateAfterDays: String(settings.lateAfterDays),
    tolerance: settings.arithmeticToleranceDollars.toFixed(2),
    eoMinimum: settings.executiveOrderMinimumWage === null ? '' : settings.executiveOrderMinimumWage.toFixed(2),
  };
}

/** Whole days, 1–60. */
function parseDays(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 60 ? n : null;
}

/** A dollar amount with at most two decimals ("1", "1.5", "$17.75"). */
function parseDollars(s: string): number | null {
  const t = s.trim().replace(/^\$\s*/, '');
  if (!/^(\d{1,6}(\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  return Number(t);
}

function validate(f: FormState): Errors {
  const e: Errors = {};
  if (!f.name.trim()) e.name = 'Enter the project name.';
  if (f.wdLockDate && !isIsoDate(f.wdLockDate)) e.wdLockDate = 'Enter a valid date, or leave it blank.';
  if (f.reviewerEmail.trim() && !EMAIL.test(f.reviewerEmail.trim())) e.reviewerEmail = 'Enter a valid email address, e.g. name@agency.gov.';
  if (parseDays(f.lateAfterDays) === null) e.lateAfterDays = 'Enter a whole number of days from 1 to 60.';
  const tol = parseDollars(f.tolerance);
  if (tol === null || tol > 50) e.tolerance = 'Enter an amount from $0.00 to $50.00.';
  if (f.eoMinimum.trim()) {
    const eo = parseDollars(f.eoMinimum);
    if (eo === null || eo < 1 || eo > 100) e.eoMinimum = 'Enter an hourly rate from $1.00 to $100.00, or leave it blank.';
  }
  return e;
}

/** Comparable value for dirty tracking: ignores surrounding spaces and "14" vs "14.0". */
function canon(f: FormState, k: FieldKey): string {
  const v = f[k];
  if (typeof v === 'boolean') return String(v);
  if (k === 'lateAfterDays') {
    const n = parseDays(v);
    return n === null ? `raw:${v.trim()}` : String(n);
  }
  if (k === 'tolerance' || k === 'eoMinimum') {
    if (!v.trim()) return '';
    const n = parseDollars(v);
    return n === null ? `raw:${v.trim()}` : String(n);
  }
  return v.trim();
}

function sameForm(a: FormState, b: FormState): boolean {
  return FIELD_ORDER.every((k) => canon(a, k) === canon(b, k));
}

type ProjectPatch = Pick<Project, 'name' | 'projectNumber' | 'owner' | 'location' | 'fundingSource' | 'wdLockDate' | 'reviewer' | 'settings'>;

/** Only called with a validated form. */
function toPatch(project: Project, f: FormState): ProjectPatch {
  const eo = f.eoMinimum.trim() ? parseDollars(f.eoMinimum) : null;
  return {
    name: f.name.trim(),
    projectNumber: f.projectNumber.trim(),
    owner: f.owner.trim(),
    location: f.location.trim(),
    fundingSource: f.fundingSource,
    wdLockDate: f.wdLockDate || null,
    reviewer: {
      ...project.reviewer,
      name: f.reviewerName.trim(),
      title: f.reviewerTitle.trim(),
      organization: f.reviewerOrganization.trim(),
      email: f.reviewerEmail.trim(),
      phone: f.reviewerPhone.trim(),
    },
    settings: {
      ...DEFAULT_SETTINGS,
      ...project.settings,
      overtimeRuleApplies: f.overtimeRuleApplies,
      lateAfterDays: parseDays(f.lateAfterDays) ?? DEFAULT_SETTINGS.lateAfterDays,
      arithmeticToleranceDollars: parseDollars(f.tolerance) ?? DEFAULT_SETTINGS.arithmeticToleranceDollars,
      executiveOrderMinimumWage: eo,
    },
  };
}

interface Change {
  section: Section;
  action: string;
  detail: string;
}

/** Audit-trail entries for a save: one per section that changed, listing old → new values. */
function describeChanges(before: Project, after: ProjectPatch): Change[] {
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);
  const text = (v: string) => (v ? `"${clip(v)}"` : '(blank)');
  const diff = (list: string[], label: string, a: string, b: string, fmt: (v: string) => string = text) => {
    if (a !== b) list.push(`${label}: ${fmt(a)} → ${fmt(b)}`);
  };
  const out: Change[] = [];

  const contract: string[] = [];
  diff(contract, 'Name', before.name, after.name);
  diff(contract, 'Project / contract no.', before.projectNumber ?? '', after.projectNumber);
  diff(contract, 'Owner / grantee', before.owner ?? '', after.owner);
  diff(contract, 'Location', before.location ?? '', after.location);
  diff(contract, 'Funding source', before.fundingSource, after.fundingSource, (v) => v);
  diff(contract, 'WD lock date', before.wdLockDate ?? '', after.wdLockDate ?? '', (v) => (v ? formatDate(v) : 'none'));
  if (contract.length) out.push({ section: 'contract', action: 'Contract details updated', detail: contract.join('; ') });

  const r0 = before.reviewer ?? { name: '', title: '', organization: '', email: '', phone: '' };
  const r1 = after.reviewer;
  const reviewer: string[] = [];
  diff(reviewer, 'Name', r0.name ?? '', r1.name);
  diff(reviewer, 'Title', r0.title ?? '', r1.title);
  diff(reviewer, 'Organization', r0.organization ?? '', r1.organization);
  diff(reviewer, 'Email', r0.email ?? '', r1.email);
  diff(reviewer, 'Phone', r0.phone ?? '', r1.phone);
  if (reviewer.length) out.push({ section: 'reviewer', action: 'Reviewer details updated', detail: reviewer.join('; ') });

  const s0 = { ...DEFAULT_SETTINGS, ...before.settings };
  const s1 = after.settings;
  const rules: string[] = [];
  const applies = (v: boolean) => (v ? 'applies' : 'does not apply');
  const eo = (v: number | null) => (v === null ? 'not applied' : `${formatMoney(v)}/hr`);
  if (s0.overtimeRuleApplies !== s1.overtimeRuleApplies) rules.push(`CWHSSA overtime: ${applies(s0.overtimeRuleApplies)} → ${applies(s1.overtimeRuleApplies)}`);
  if (s0.lateAfterDays !== s1.lateAfterDays) rules.push(`Late after: ${s0.lateAfterDays} → ${s1.lateAfterDays} days`);
  if (s0.arithmeticToleranceDollars !== s1.arithmeticToleranceDollars) {
    rules.push(`Arithmetic tolerance: ${formatMoney(s0.arithmeticToleranceDollars)} → ${formatMoney(s1.arithmeticToleranceDollars)}`);
  }
  if (s0.executiveOrderMinimumWage !== s1.executiveOrderMinimumWage) {
    rules.push(`EO minimum wage: ${eo(s0.executiveOrderMinimumWage)} → ${eo(s1.executiveOrderMinimumWage)}`);
  }
  if (rules.length) out.push({ section: 'rules', action: 'Review rules changed', detail: rules.join('; ') });

  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Local date and time of an ISO timestamp, e.g. { date: "9/27/2026", time: "2:14 PM" }. */
function formatWhen(at: string): { date: string; time: string } {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return { date: '—', time: '' };
  return { date: formatDate(todayIso(d)), time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) };
}

function lastBackupEntry(view: ProjectView) {
  let latest: ProjectView['data']['activity'][number] | null = null;
  for (const a of view.data.activity) {
    if (a.action === 'Backup exported' && (!latest || a.at > latest.at)) latest = a;
  }
  return latest;
}

/** Download a complete backup of the project as "<project> backup <date>.json". */
function useBackup(view: ProjectView) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { project } = view.data;
  const run = async () => {
    setBusy(true);
    try {
      const doc = await projectStore.mutate(() => exportProjectBackup(project.id));
      const base = safeFileName(project.name).slice(0, 60).trim() || 'Project';
      const fileName = `${base} backup ${todayIso()}.json`;
      downloadFile(fileName, JSON.stringify(doc), 'application/json');
      toast(`Backup downloaded: ${fileName}`);
    } catch (e) {
      toast(`Backup failed: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SettingsPage({ view }: { view: ProjectView }) {
  useDocumentTitle('Project settings');
  const backup = useBackup(view);
  return (
    <div className="page page-narrow">
      <PageHeader
        title="Project settings"
        subtitle="Contract details, the reviewer shown on letters and review stamps, the rules payrolls are checked against, and this project's data."
      />
      <div className="stack">
        <SettingsForm view={view} />
        <DataPanel view={view} backup={backup} />
        <ActivityLog view={view} />
        <DangerZone view={view} backup={backup} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contract, reviewer and review rules (one form, dirty tracking per section)
// ---------------------------------------------------------------------------

function SettingsForm({ view }: { view: ProjectView }) {
  const { project } = view.data;
  const toast = useToast();
  const baseline = useMemo(() => toForm(project), [project]);
  const [form, setForm] = useState<FormState>(baseline);
  const [touched, setTouched] = useState<Set<FieldKey>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  // Pick up changes saved elsewhere (another section of the app, a restored backup) unless the
  // reviewer is in the middle of editing.
  const prev = useRef({ baseline, id: project.id });
  useEffect(() => {
    const p = prev.current;
    if (p.baseline === baseline) return;
    setForm((f) => (p.id !== project.id || sameForm(f, p.baseline) ? baseline : f));
    prev.current = { baseline, id: project.id };
  }, [baseline, project.id]);

  const errors = useMemo(() => validate(form), [form]);
  const errorCount = Object.keys(errors).length;
  const dirtySections = SECTIONS.filter((s) => SECTION_FIELDS[s].some((k) => canon(form, k) !== canon(baseline, k)));
  const dirty = dirtySections.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const shownError = (k: FieldKey): string | undefined => (attempted || touched.has(k) ? errors[k] : undefined);

  const bind = (k: TextKey) => ({
    id: fieldId(k),
    value: form[k],
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value })),
    onBlur: () => setTouched((t) => (t.has(k) ? t : new Set(t).add(k))),
    'aria-invalid': shownError(k) ? true : undefined,
    'aria-describedby': `${fieldId(k)}-msg`,
  });
  const inputClass = (k: FieldKey, extra = '') => ['input', extra, shownError(k) ? 'invalid' : ''].filter(Boolean).join(' ');

  const discard = () => {
    setForm(baseline);
    setTouched(new Set());
    setAttempted(false);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || busy) return;
    if (errorCount > 0) {
      setAttempted(true);
      const first = FIELD_ORDER.find((k) => errors[k]);
      if (first) document.getElementById(fieldId(first))?.focus();
      return;
    }
    const patch = toPatch(project, form);
    const changes = describeChanges(project, patch);
    setBusy(true);
    try {
      await projectStore.mutate(async () => {
        await updateProject(project.id, patch);
        for (const c of changes) await logActivity(project.id, c.action, c.detail);
      });
      setForm(toForm({ ...project, ...patch }));
      setTouched(new Set());
      setAttempted(false);
      toast(
        changes.some((c) => c.section === 'rules')
          ? 'Settings saved. Every payroll was re-checked under the new review rules.'
          : 'Settings saved',
      );
    } catch (err) {
      toast(`Could not save the settings: ${(err as Error).message}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const wd = view.data.wd?.parsed ?? null;
  const eoFlagged = wd ? wd.classifications.filter((c) => c.executiveOrderFlag).length : 0;
  const eoValue = form.eoMinimum.trim() ? parseDollars(form.eoMinimum) : null;
  const fundingOptions = FUNDING_SOURCES.includes(form.fundingSource) ? FUNDING_SOURCES : [form.fundingSource, ...FUNDING_SOURCES];

  return (
    <form onSubmit={save} noValidate aria-label="Project settings">
      <Panel title={<SectionTitle title="Contract" dirty={dirtySections.includes('contract')} />}>
        <div className="form-grid">
          <FormField id={fieldId('name')} label="Project name" className="span-2" error={shownError('name')}>
            <input {...bind('name')} className={inputClass('name')} maxLength={200} required autoComplete="off" />
          </FormField>
          <FormField id={fieldId('projectNumber')} label="Project / contract no.">
            <input {...bind('projectNumber')} className={inputClass('projectNumber')} maxLength={100} placeholder="Grant or contract number" autoComplete="off" />
          </FormField>
          <FormField id={fieldId('owner')} label="Owner / grantee / awarding agency">
            <input {...bind('owner')} className={inputClass('owner')} maxLength={200} autoComplete="off" />
          </FormField>
          <FormField id={fieldId('location')} label="Project location">
            <input {...bind('location')} className={inputClass('location')} maxLength={200} placeholder="City, county" autoComplete="off" />
          </FormField>
          <FormField id={fieldId('fundingSource')} label="Funding source">
            <select {...bind('fundingSource')} className="select">
              {fundingOptions.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </FormField>
          <FormField
            id={fieldId('wdLockDate')}
            label="Wage determination lock date"
            className="span-2"
            error={shownError('wdLockDate')}
            hint="Bid opening or award date. It decides which WD modification applies to this contract."
          >
            <input {...bind('wdLockDate')} type="date" className={inputClass('wdLockDate')} style={{ maxWidth: 200 }} />
          </FormField>
        </div>
      </Panel>

      <Panel title={<SectionTitle title="Reviewer" dirty={dirtySections.includes('reviewer')} />}>
        <p className="muted small">Shown on correction letters and review stamps generated from this project.</p>
        <div className="form-grid">
          <FormField
            id={fieldId('reviewerName')}
            label="Name"
            hint={!form.reviewerName.trim() ? 'Letters and stamps show a blank reviewer until this is filled in.' : undefined}
          >
            <input {...bind('reviewerName')} className={inputClass('reviewerName')} maxLength={120} autoComplete="name" />
          </FormField>
          <FormField id={fieldId('reviewerTitle')} label="Title">
            <input {...bind('reviewerTitle')} className={inputClass('reviewerTitle')} maxLength={120} placeholder="Labor Standards Officer" autoComplete="organization-title" />
          </FormField>
          <FormField id={fieldId('reviewerOrganization')} label="Organization">
            <input {...bind('reviewerOrganization')} className={inputClass('reviewerOrganization')} maxLength={200} autoComplete="organization" />
          </FormField>
          <FormField id={fieldId('reviewerEmail')} label="Email" error={shownError('reviewerEmail')}>
            <input {...bind('reviewerEmail')} type="email" className={inputClass('reviewerEmail')} maxLength={200} autoComplete="email" spellCheck={false} />
          </FormField>
          <FormField id={fieldId('reviewerPhone')} label="Phone">
            <input {...bind('reviewerPhone')} type="tel" className={inputClass('reviewerPhone')} maxLength={40} autoComplete="tel" />
          </FormField>
        </div>
      </Panel>

      <Panel title={<SectionTitle title="Review rules" dirty={dirtySections.includes('rules')} />} bodyClass="">
        <p className="muted small" style={{ padding: '12px 14px', margin: 0 }}>
          These rules decide what Wagebench flags on this project. Saving a change re-checks every payroll immediately.
        </p>

        <RuleRow
          title="Overtime (CWHSSA)"
          explanation={
            <>
              The Contract Work Hours and Safety Standards Act applies to contracts over $100,000: laborers and mechanics must be paid at least
              one and one-half times the basic rate for hours over 40 in a workweek. When this is on, Wagebench flags overtime paid below 1.5 × the
              basic rate and hours over 40 paid at straight time, and adds the premium owed to restitution. Turn it off only if the contract is
              $100,000 or less.
            </>
          }
          control={
            <label className="check" htmlFor={fieldId('overtimeRuleApplies')}>
              <input
                id={fieldId('overtimeRuleApplies')}
                type="checkbox"
                checked={form.overtimeRuleApplies}
                onChange={(e) => setForm((f) => ({ ...f, overtimeRuleApplies: e.target.checked }))}
              />
              Applies to this contract
            </label>
          }
        />

        <RuleRow
          title="Late payroll threshold"
          htmlFor={fieldId('lateAfterDays')}
          error={shownError('lateAfterDays')}
          errorId={`${fieldId('lateAfterDays')}-msg`}
          explanation={
            <>
              A payroll received more than this many days after its week ending date is flagged as late, and a week with no payroll counts as
              missing once this many days have passed. Payrolls are due weekly, within seven days after the regular pay date, so allow for the
              contractor's pay schedule. Whole days, 1 to 60.
            </>
          }
          control={
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input {...bind('lateAfterDays')} className={inputClass('lateAfterDays', 'num')} style={{ width: 72 }} inputMode="numeric" maxLength={3} />
              <span className="muted small">days after week ending</span>
            </div>
          }
        />

        <RuleRow
          title="Arithmetic tolerance"
          htmlFor={fieldId('tolerance')}
          error={shownError('tolerance')}
          errorId={`${fieldId('tolerance')}-msg`}
          explanation={
            <>
              Differences up to this amount between reported gross pay and hours × rates, between net pay and gross minus deductions, and between
              gross for this project and gross for all work are treated as payroll-system rounding and not flagged. Wage rate shortfalls are
              always checked to the cent. $0.00 to $50.00.
            </>
          }
          control={
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <span className="muted">$</span>
              <input {...bind('tolerance')} className={inputClass('tolerance', 'num')} style={{ width: 88 }} inputMode="decimal" maxLength={8} />
              <span className="muted small">per line</span>
            </div>
          }
        />

        <RuleRow
          title='Executive Order minimum wage for "**" classifications'
          htmlFor={fieldId('eoMinimum')}
          error={shownError('eoMinimum')}
          errorId={`${fieldId('eoMinimum')}-msg`}
          explanation={
            <>
              <p>
                Wage determinations mark some classifications with "**": workers in them may be owed a higher minimum wage under an Executive
                Order. Only certain direct federal contracts are covered, depending on when the contract was awarded, renewed or extended and on
                which orders are in effect. Confirm with the contracting agency that an order applies to this contract, and confirm the rate
                currently in effect (the WD's general notes show the rates when it was published). When set, any "**" classification with a
                lower basic rate is checked at this rate instead. Leave blank to not apply it.
              </p>
              <p style={{ margin: 0 }}>
                {wd ? (
                  eoFlagged > 0 ? (
                    <>
                      {plural(eoFlagged, 'classification')} of {wd.classifications.length} on the current wage determination{' '}
                      {eoFlagged === 1 ? 'is' : 'are'} marked "**".{' '}
                      <a href={`#${projectPath(project.id, 'wd')}`}>Review the WD notes</a>
                    </>
                  ) : (
                    'No classification on the current wage determination is marked "**", so this setting has no effect.'
                  )
                ) : (
                  <>
                    No wage determination loaded yet. <a href={`#${projectPath(project.id, 'wd')}`}>Add it</a>
                  </>
                )}
              </p>
              {eoValue !== null && form.fundingSource !== 'Other federal' && (
                <div style={{ marginTop: 8 }}>
                  <Alert tone="warn">
                    Executive Order minimum wages generally cover direct federal contracts, not projects assisted by federal grants or loans or
                    state prevailing wage work. This project's funding source is {form.fundingSource}. Confirm coverage before applying it.
                  </Alert>
                </div>
              )}
            </>
          }
          control={
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <span className="muted">$</span>
              <input {...bind('eoMinimum')} className={inputClass('eoMinimum', 'num')} style={{ width: 88 }} inputMode="decimal" maxLength={8} placeholder="Not applied" />
              <span className="muted small">per hour</span>
            </div>
          }
        />
      </Panel>

      <div
        className="panel"
        style={dirty ? { position: 'sticky', bottom: 12, zIndex: 5, boxShadow: 'var(--shadow-lg)' } : undefined}
      >
        <div className="row spread" style={{ padding: '10px 14px' }}>
          <div className="small" role="status" aria-live="polite">
            {dirty ? (
              attempted && errorCount > 0 ? (
                <span style={{ color: 'var(--bad)', fontWeight: 600 }}>
                  Fix {errorCount === 1 ? 'the highlighted field' : `${errorCount} highlighted fields`} before saving
                </span>
              ) : (
                <span className="row" style={{ gap: 6 }}>
                  <span className="dot warn" aria-hidden />
                  <strong>Unsaved changes</strong>
                  <span className="muted">in {dirtySections.map((s) => SECTION_LABEL[s]).join(', ')}</span>
                </span>
              )
            ) : (
              <span className="muted">All changes saved</span>
            )}
          </div>
          <div className="row">
            <Button onClick={discard} disabled={!dirty || busy}>Discard changes</Button>
            <Button type="submit" variant="primary" disabled={!dirty || busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function SectionTitle({ title, dirty }: { title: string; dirty: boolean }) {
  return (
    <h2 className="row" style={{ gap: 8 }}>
      {title}
      {dirty && <Badge tone="warn">Unsaved</Badge>}
    </h2>
  );
}

/** Same markup as ui's Field, with the label tied to its control and the message referenced by id. */
function FormField({ id, label, hint, error, className = '', children }: { id: string; label: string; hint?: ReactNode; error?: string; className?: string; children: ReactNode }) {
  const message = error ?? hint;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {message ? (
        <div id={`${id}-msg`} className={error ? 'error' : 'hint'}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

function RuleRow({
  title,
  htmlFor,
  explanation,
  control,
  error,
  errorId,
}: {
  title: string;
  htmlFor?: string;
  explanation: ReactNode;
  control: ReactNode;
  error?: string;
  errorId?: string;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px', padding: '14px', borderTop: '1px solid var(--line)' }}>
      <div style={{ flex: '1 1 360px', minWidth: 0 }}>
        {htmlFor ? (
          <label htmlFor={htmlFor} style={{ fontWeight: 600 }}>{title}</label>
        ) : (
          <div style={{ fontWeight: 600 }}>{title}</div>
        )}
        <div className="muted small" style={{ marginTop: 4 }}>{explanation}</div>
      </div>
      <div className="field" style={{ flex: '0 0 240px' }}>
        {control}
        {error && <div id={errorId} className="error">{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data and backups
// ---------------------------------------------------------------------------

function DataPanel({ view, backup }: { view: ProjectView; backup: ReturnType<typeof useBackup> }) {
  const { data } = view;
  const lines = data.payrolls.reduce((n, p) => n + p.lines.length, 0);
  const fileBytes = data.files.reduce((n, f) => n + (f.size ?? 0), 0);
  const last = lastBackupEntry(view);
  const lastWhen = last ? formatWhen(last.at) : null;
  const changedSince = last ? data.project.updatedAt > last.at : false;

  return (
    <Panel title="Data and backups">
      <p>
        Wagebench has no server. This project is stored only in this browser's local database (IndexedDB) on this computer and is never
        uploaded. It is not available in other browsers or on other computers, and clearing this browser's site data deletes it.
      </p>
      <dl className="kv" style={{ margin: '12px 0' }}>
        <dt>Stored in this browser</dt>
        <dd>
          {[
            data.wd ? 'Wage determination' : 'No wage determination',
            plural(data.contractors.length, 'contractor'),
            `${plural(data.payrolls.length, 'payroll')}${lines ? ` (${plural(lines, 'worker line')})` : ''}`,
            `${plural(data.files.length, 'original file')}${data.files.length ? `, ${formatBytes(fileBytes)}` : ''}`,
            plural(data.activity.length, 'activity entry', 'activity entries'),
          ].join(' · ')}
        </dd>
        <dt>Last backup downloaded</dt>
        <dd>
          {lastWhen ? (
            <>
              {lastWhen.date} {lastWhen.time}
              {changedSince && <span className="cell-warn"> · the project has changed since</span>}
            </>
          ) : (
            <span className="cell-warn">None yet</span>
          )}
        </dd>
      </dl>
      <Alert tone="warn">
        Backups contain workers' names, identifying numbers and pay, including any full Social Security numbers a contractor submitted. Store
        backup files as securely as the payrolls themselves, and do not send them by unencrypted email.
      </Alert>
      <div className="row" style={{ marginTop: 12 }}>
        <Button icon="download" onClick={() => void backup.run()} disabled={backup.busy}>
          {backup.busy ? 'Preparing backup…' : 'Download backup'}
        </Button>
        <span className="muted small">
          One .json file with everything above, including the original payroll files. Restore it from the <a href="#/">Projects</a> page, in this or
          another browser.
        </span>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function ActivityLog({ view }: { view: ProjectView }) {
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const entries = useMemo(() => [...view.data.activity].sort((a, b) => b.at.localeCompare(a.at)), [view.data.activity]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? entries.filter((a) => `${a.action} ${a.detail}`.toLowerCase().includes(needle)) : entries;
  }, [entries, q]);
  const shown = showAll ? filtered : filtered.slice(0, ACTIVITY_LIMIT);

  const total = plural(entries.length, 'entry', 'entries');
  const count = filtered.length === entries.length ? total : `${filtered.length.toLocaleString('en-US')} of ${total}`;

  return (
    <Panel
      title={
        <h2>
          Activity log{' '}
          <span className="muted small" style={{ fontWeight: 400 }}>{count}</span>
        </h2>
      }
      actions={
        entries.length > 0 ? (
          <input
            className="input sm"
            style={{ width: 220 }}
            type="search"
            placeholder="Filter by action or detail…"
            aria-label="Filter the activity log"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        ) : undefined
      }
      bodyClass="table-wrap"
      footer={
        filtered.length > ACTIVITY_LIMIT ? (
          <>
            <span className="muted small" style={{ marginRight: 'auto', alignSelf: 'center' }}>
              Showing {shown.length} of {filtered.length}
            </span>
            <Button size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Show latest ${ACTIVITY_LIMIT}` : `Show all ${filtered.length}`}
            </Button>
          </>
        ) : undefined
      }
    >
      <p className="muted small" style={{ padding: '10px 14px', margin: 0, borderBottom: '1px solid var(--line)' }}>
        The audit trail for this project, newest first. Entries are recorded automatically as the project changes and are included in backups.
      </p>
      {entries.length === 0 ? (
        <EmptyState title="No activity recorded yet">Imports, review decisions, settings changes and backups will be listed here.</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState title="No activity matches this filter" actions={<Button size="sm" onClick={() => setQ('')}>Clear filter</Button>} />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th className="tight">When</th>
              <th className="tight">Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const when = formatWhen(a.at);
              return (
                <tr key={a.id}>
                  <td className="tight">
                    {when.date}
                    <div className="sub">{when.time}</div>
                  </td>
                  <td className="tight">{a.action}</td>
                  <td>{a.detail || <span className="faint">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Delete project
// ---------------------------------------------------------------------------

function DangerZone({ view, backup }: { view: ProjectView; backup: ReturnType<typeof useBackup> }) {
  const { data } = view;
  const [open, setOpen] = useState(false);
  return (
    <section className="panel" style={{ borderColor: 'var(--bad-line)' }} aria-labelledby="settings-danger-title">
      <div className="panel-header">
        <h2 id="settings-danger-title" style={{ color: 'var(--bad)' }}>Delete project</h2>
      </div>
      <div className="panel-body">
        <div className="row spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <p style={{ flex: '1 1 420px', margin: 0 }}>
            Permanently removes this project from this browser: {data.wd ? 'the wage determination, ' : ''}
            {plural(data.contractors.length, 'contractor')},{' '}
            {plural(data.payrolls.length, 'payroll')} with their original files, review decisions, restitution records and the activity log. This
            cannot be undone. Payroll review records are usually subject to record-retention requirements, so download a backup first.
          </p>
          <Button variant="danger" icon="trash" onClick={() => setOpen(true)}>
            Delete project…
          </Button>
        </div>
      </div>
      <DeleteProjectModal open={open} view={view} backup={backup} onClose={() => setOpen(false)} />
    </section>
  );
}

function DeleteProjectModal({ open, view, backup, onClose }: { open: boolean; view: ProjectView; backup: ReturnType<typeof useBackup>; onClose: () => void }) {
  const { project } = view.data;
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const matches = typed.trim() === project.name.trim();
  const last = lastBackupEntry(view);
  const lastWhen = last ? formatWhen(last.at) : null;
  const backupStale = !last || project.updatedAt > last.at;

  useEffect(() => {
    // Runs after Modal's showModal(), so focus lands on the confirmation field rather than the Close button.
    if (open) input.current?.focus();
    else setTyped('');
  }, [open]);

  const close = () => {
    if (!busy) onClose();
  };

  const confirm = async () => {
    if (!matches || busy) return;
    setBusy(true);
    const name = project.name;
    try {
      await projectStore.mutate(async () => {
        await deleteProject(project.id);
        // Leave the project before the store reloads it, so the "project missing" screen never flashes.
        navigate('/', { replace: true });
      });
      toast(`Deleted "${name}" from this browser`);
    } catch (e) {
      toast(`Could not delete the project: ${(e as Error).message}`, 'bad');
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Delete this project?"
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="danger" icon="trash" onClick={() => void confirm()} disabled={busy || !matches}>
            {busy ? 'Deleting…' : 'Delete project permanently'}
          </Button>
        </>
      }
    >
      <p>
        This permanently deletes <strong>{project.name}</strong> and all of its payrolls, original files, review decisions, restitution records and
        activity from this browser. It cannot be undone.
      </p>
      {/* The button stays mounted when the message changes, so keyboard focus is kept after a download. */}
      <div style={{ margin: '12px 0' }}>
        <Alert tone={backupStale ? 'warn' : 'info'}>
          <div>
            {!lastWhen
              ? 'No backup of this project has been downloaded yet.'
              : backupStale
                ? `The project has changed since the last backup was downloaded (${lastWhen.date} ${lastWhen.time}).`
                : `A current backup was downloaded ${lastWhen.date} ${lastWhen.time}.`}
          </div>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" icon="download" onClick={() => void backup.run()} disabled={backup.busy || busy}>
              {backup.busy ? 'Preparing backup…' : backupStale ? 'Download backup first' : 'Download another backup'}
            </Button>
          </div>
        </Alert>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="settings-confirm-delete">
          Type the project name <span className="mono">{project.name}</span> to confirm
        </label>
        <input
          ref={input}
          id="settings-confirm-delete"
          className="input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void confirm();
            }
          }}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </div>
    </Modal>
  );
}
