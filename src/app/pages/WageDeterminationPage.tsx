import { useMemo, useRef, useState } from 'react';
import { saveWageDetermination, setMapping } from '../../db/repo';
import { formatDate } from '../../engine/dates';
import { normalizeLabel, resolveClassification, suggestClassifications } from '../../engine/mapping';
import { formatRate } from '../../engine/money';
import { NOT_ON_WD, type ParsedWageDetermination, type WDClassification } from '../../engine/types';
import { requiredFringe } from '../../engine/wd/fringe';
import { parseWageDetermination } from '../../engine/wd/parse';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { projectStore, type ProjectView } from '../store';
import { Alert, Badge, Button, EmptyState, Field, PageHeader, Panel, useToast } from '../ui';
import { readWageDeterminationFile } from '../files';

export function WageDeterminationPage({ view }: { view: ProjectView }) {
  const { data } = view;
  useDocumentTitle('Wage determination');
  const tab = window.location.hash.endsWith('/mappings') ? 'mappings' : 'wd';
  const [replacing, setReplacing] = useState(false);
  const wd = data.wd?.parsed ?? null;
  const unmappedCount = useUnmappedTitles(view).filter((t) => t.status === 'none').length;

  return (
    <div className="page">
      <PageHeader
        title="Wage determination"
        subtitle={
          wd
            ? `${wd.decisionNumber ?? 'Unnumbered decision'} · Modification ${wd.currentModification ?? '?'} · ${wd.classifications.length} classifications · loaded ${formatDate(data.wd!.importedAt.slice(0, 10))}`
            : 'Paste the general wage determination incorporated into the contract.'
        }
        actions={wd && !replacing ? <Button onClick={() => setReplacing(true)}>Replace or update</Button> : undefined}
      />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'wd'} className={`tab ${tab === 'wd' ? 'active' : ''}`} onClick={() => navigate(projectPath(data.project.id, 'wd'), { replace: true })}>
          Classifications and rates
        </button>
        <button role="tab" aria-selected={tab === 'mappings'} className={`tab ${tab === 'mappings' ? 'active' : ''}`} onClick={() => navigate(projectPath(data.project.id, 'wd', 'mappings'), { replace: true })}>
          Job title matching
          {unmappedCount > 0 && <span className="count" style={{ color: 'var(--warn)', fontWeight: 600 }}>{unmappedCount} to match</span>}
        </button>
      </div>
      {tab === 'mappings' ? (
        <MappingsTab view={view} />
      ) : !wd || replacing ? (
        <WdInput view={view} onDone={() => setReplacing(false)} onCancel={wd ? () => setReplacing(false) : undefined} />
      ) : (
        <WdDetail view={view} wd={wd} />
      )}
    </div>
  );
}

function WdInput({ view, onDone, onCancel }: { view: ProjectView; onDone: () => void; onCancel?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const preview = useMemo(() => (text.trim().length > 40 ? parseWageDetermination(text) : null), [text]);

  const save = async () => {
    setBusy(true);
    try {
      await projectStore.mutate(() => saveWageDetermination(view.data.project.id, text));
      toast(`Wage determination saved: ${preview?.classifications.length ?? 0} classifications`);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File) => {
    setFileError(null);
    try {
      setText(await readWageDeterminationFile(file));
    } catch (e) {
      setFileError((e as Error).message);
    }
  };

  return (
    <div className="grid-2">
      <Panel
        title="Paste the wage determination"
        footer={
          <>
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button variant="primary" onClick={save} disabled={busy || !preview || preview.classifications.length === 0}>
              Save wage determination
            </Button>
          </>
        }
      >
        <p className="muted small">
          Open the general decision on SAM.gov (or the one attached to the contract), select all of its text and paste it here, or load the .txt or .pdf file.
          Keep the original spacing; indentation tells Wagebench which classifications belong to which group.
        </p>
        <textarea
          className="input code"
          style={{ minHeight: 360 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'General Decision Number: XX20260001 01/02/2026\n\n...\n\n ELEC0001-005 06/01/2025\n                                  Rates          Fringes\nELECTRICIAN......................$ 44.00          3%+21.00'}
          aria-label="Wage determination text"
          spellCheck={false}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <Button size="sm" icon="upload" onClick={() => fileInput.current?.click()}>Load .txt or .pdf</Button>
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.pdf,text/plain,application/pdf"
            hidden
            data-testid="wd-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void loadFile(f);
            }}
          />
          {fileError && <span className="small" style={{ color: 'var(--bad)' }}>{fileError}</span>}
        </div>
      </Panel>
      <Panel title="What Wagebench read">
        {!preview ? (
          <p className="muted">The decision number, modifications and every classification will appear here as you paste.</p>
        ) : (
          <>
            <dl className="kv" style={{ marginBottom: 12 }}>
              <dt>Decision</dt>
              <dd>{preview.decisionNumber ?? <span className="cell-bad">not found</span>} {preview.decisionDate && `(${formatDate(preview.decisionDate)})`}</dd>
              <dt>Modification</dt>
              <dd>{preview.currentModification ?? '—'}</dd>
              <dt>State</dt>
              <dd>{preview.state ?? '—'}</dd>
              <dt>Construction type</dt>
              <dd>{preview.constructionTypes ?? '—'}</dd>
              <dt>Counties</dt>
              <dd>{preview.counties ?? '—'}</dd>
              <dt>Classifications</dt>
              <dd><strong>{preview.classifications.length}</strong> in {preview.blocks.length} rate blocks</dd>
            </dl>
            {preview.warnings.map((w) => (
              <Alert key={w} tone="warn">{w}</Alert>
            ))}
            {preview.classifications.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}>
                <ClassificationTable classifications={preview.classifications.slice(0, 60)} compact />
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

function WdDetail({ view, wd }: { view: ProjectView; wd: ParsedWageDetermination }) {
  const [q, setQ] = useState('');
  const lock = view.data.project.wdLockDate;
  const modsAfterLock = lock ? wd.modifications.filter((m) => m.publicationDate && m.publicationDate > lock) : [];
  const filtered = useMemo(() => {
    const n = normalizeLabel(q);
    if (!n) return wd.classifications;
    return wd.classifications.filter((c) =>
      normalizeLabel(`${c.label} ${c.scope ?? ''} ${c.description ?? ''} ${c.rateId}`).includes(n),
    );
  }, [q, wd]);

  return (
    <div className="stack">
      {wd.warnings.map((w) => (
        <Alert key={w} tone="warn">{w}</Alert>
      ))}
      {modsAfterLock.length > 0 && (
        <Alert tone="warn">
          The project's wage determination lock date is {formatDate(lock)}, but this text includes modification
          {modsAfterLock.length > 1 ? 's' : ''} {modsAfterLock.map((m) => `${m.number} (${formatDate(m.publicationDate)})`).join(', ')} published after it.
          Rates must come from the modification in effect when the contract was locked in. Confirm you pasted the correct version.
        </Alert>
      )}
      <Panel
        title="Classifications"
        actions={<input className="input sm" style={{ width: 260 }} placeholder="Search classification, group, county…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search classifications" />}
        bodyClass="table-wrap"
      >
        <ClassificationTable classifications={filtered} />
        {filtered.length === 0 && <EmptyState title="No classification matches your search" />}
      </Panel>
      <div className="grid-2">
        <Panel title="Decision">
          <dl className="kv">
            <dt>General decision</dt>
            <dd>{wd.decisionNumber ?? '—'} {wd.decisionDate && `(${formatDate(wd.decisionDate)})`}</dd>
            <dt>Supersedes</dt>
            <dd>{wd.supersededDecision ?? '—'}</dd>
            <dt>State</dt>
            <dd>{wd.state ?? '—'}</dd>
            <dt>Construction type</dt>
            <dd>{wd.constructionTypes ?? '—'}</dd>
            <dt>Counties</dt>
            <dd>{wd.counties ?? '—'}</dd>
            <dt>Modifications</dt>
            <dd>{wd.modifications.map((m) => `${m.number} (${formatDate(m.publicationDate)})`).join(', ') || '—'}</dd>
          </dl>
        </Panel>
        <Panel title="Notes in the wage determination">
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 260, overflowY: 'auto' }}>{wd.generalNotes || 'None'}</pre>
        </Panel>
      </div>
    </div>
  );
}

export function ClassificationTable({ classifications, compact = false }: { classifications: WDClassification[]; compact?: boolean }) {
  return (
    <table className="data">
      <thead>
        <tr>
          {!compact && <th>Rate ID</th>}
          <th>Classification</th>
          <th className="num">Basic rate</th>
          <th className="num">Fringe</th>
          {!compact && <th className="num">Total package</th>}
        </tr>
      </thead>
      <tbody>
        {classifications.map((c) => (
          <tr key={c.key}>
            {!compact && (
              <td className="tight">
                <span className="mono">{c.rateId}</span>
                <div className="sub">{c.kind === 'survey' ? 'Survey rate' : c.kind === 'union' ? 'Union rate' : c.kind === 'union-average' ? 'Weighted union avg.' : c.kind === 'state-adopted' ? 'State adopted' : ''}</div>
              </td>
            )}
            <td>
              {c.label}
              {c.scope && <div className="sub">{c.scope}</div>}
              {c.description && !compact && <div className="sub" title={c.description}>{c.description.length > 160 ? `${c.description.slice(0, 160)}…` : c.description}</div>}
            </td>
            <td className="num">
              {formatRate(c.baseRate)}
              {c.unit === 'day' && <div className="sub">per day</div>}
              {c.executiveOrderFlag && <div><Badge tone="info" title="Workers may be entitled to a higher Executive Order minimum wage">** EO</Badge></div>}
            </td>
            <td className="num">
              {c.fringe.raw || <span className="faint">0</span>}
              {c.fringe.percent > 0 && <div className="sub">= {formatRate(requiredFringe(c.fringe, c.baseRate))}</div>}
            </td>
            {!compact && <td className="num">{c.unit === 'hour' ? formatRate(c.baseRate + requiredFringe(c.fringe, c.baseRate)) : '—'}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Job title matching
// ---------------------------------------------------------------------------

interface TitleRow {
  contractorId: string;
  label: string;
  lines: number;
  status: 'mapping' | 'exact' | 'none' | 'not-on-wd';
  key: string | null;
}

function useUnmappedTitles(view: ProjectView): TitleRow[] {
  const { data } = view;
  return useMemo(() => {
    const classifications = data.wd?.parsed.classifications ?? [];
    const map = new Map<string, TitleRow>();
    for (const p of data.payrolls) {
      for (const l of p.lines) {
        const norm = normalizeLabel(l.classification);
        const k = `${p.contractorId}|${norm}`;
        const existing = map.get(k);
        if (existing) {
          existing.lines++;
          continue;
        }
        const r = resolveClassification(l.classification, p.contractorId, data.mappings, classifications);
        map.set(k, {
          contractorId: p.contractorId,
          label: l.classification,
          lines: 1,
          status: r.key === NOT_ON_WD ? 'not-on-wd' : r.source,
          key: r.key,
        });
      }
    }
    return [...map.values()].sort((a, b) => (a.status === 'none' ? 0 : 1) - (b.status === 'none' ? 0 : 1) || a.label.localeCompare(b.label));
  }, [data]);
}

function MappingsTab({ view }: { view: ProjectView }) {
  const rows = useUnmappedTitles(view);
  const wd = view.data.wd?.parsed;
  const toast = useToast();
  if (!wd) {
    return <EmptyState title="Add the wage determination first" actions={<Button onClick={() => navigate(projectPath(view.data.project.id, 'wd'), { replace: true })}>Add it</Button>} />;
  }
  if (rows.length === 0) {
    return <Panel><EmptyState title="No job titles yet">Job titles appear here as payrolls come in. Each contractor's titles are matched once and remembered.</EmptyState></Panel>;
  }
  const byContractor = new Map<string, TitleRow[]>();
  for (const r of rows) byContractor.set(r.contractorId, [...(byContractor.get(r.contractorId) ?? []), r]);

  const choose = async (row: TitleRow, value: string) => {
    await projectStore.mutate(() => setMapping(view.data.project.id, row.contractorId, row.label, value === '' ? null : value));
    toast(value === NOT_ON_WD ? `"${row.label}" marked as not on the wage determination` : value === '' ? 'Match cleared' : `"${row.label}" matched`);
  };

  return (
    <div className="stack">
      <Alert tone="info">
        Contractors write job titles their own way ("Pipe Layer", "Laborer II", "Oper."). Match each one to the wage determination classification for the work performed.
        Matches are remembered per contractor, and every past and future payroll is rechecked instantly.
      </Alert>
      {[...byContractor.entries()].map(([cid, list]) => (
        <Panel key={cid} title={view.contractorById.get(cid)?.name ?? 'Unknown contractor'} bodyClass="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Job title on payroll</th>
                <th className="num">Lines</th>
                <th>Wage determination classification</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <MappingRow key={row.label} row={row} wd={wd} onChoose={(v) => void choose(row, v)} />
              ))}
            </tbody>
          </table>
        </Panel>
      ))}
    </div>
  );
}

function MappingRow({ row, wd, onChoose }: { row: TitleRow; wd: ParsedWageDetermination; onChoose: (value: string) => void }) {
  const suggestions = useMemo(() => suggestClassifications(row.label, wd.classifications, 5), [row.label, wd]);
  const suggestedKeys = new Set(suggestions.map((s) => s.classification.key));
  const current = row.key ?? '';
  const optionLabel = (c: WDClassification) => `${c.label}${c.scope ? ` — ${c.scope.slice(0, 40)}` : ''} (${formatRate(c.baseRate)} + ${c.fringe.raw || '0'})`;
  return (
    <tr className={row.status === 'none' ? 'row-warn' : ''}>
      <td><strong>{row.label || <em className="faint">blank</em>}</strong></td>
      <td className="num">{row.lines}</td>
      <td style={{ minWidth: 380 }}>
        <select className="select sm" value={current} onChange={(e) => onChoose(e.target.value)} aria-label={`Classification for ${row.label}`}>
          <option value="">— Choose a classification —</option>
          {suggestions.length > 0 && (
            <optgroup label="Suggested">
              {suggestions.map((s) => (
                <option key={`s-${s.classification.key}`} value={s.classification.key}>
                  {optionLabel(s.classification)}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="All classifications">
            {wd.classifications
              .filter((c) => !suggestedKeys.has(c.key))
              .map((c) => (
                <option key={c.key} value={c.key}>{optionLabel(c)}</option>
              ))}
          </optgroup>
          <optgroup label="Other">
            <option value={NOT_ON_WD}>Not on the wage determination (conformance needed)</option>
          </optgroup>
        </select>
        {row.status === 'none' && suggestions[0] && (
          <div className="sub" style={{ marginTop: 4 }}>
            Best guess: {suggestions[0].classification.label} ({suggestions[0].reason}){' '}
            <Button size="sm" variant="ghost" onClick={() => onChoose(suggestions[0]!.classification.key)}>Use it</Button>
          </div>
        )}
      </td>
      <td>
        {row.status === 'mapping' && <Badge tone="good">Matched</Badge>}
        {row.status === 'exact' && <Badge tone="good" title="The job title is identical to a classification on the WD">Same as WD</Badge>}
        {row.status === 'none' && <Badge tone="warn">Needs a match</Badge>}
        {row.status === 'not-on-wd' && <Badge tone="bad">Needs conformance</Badge>}
      </td>
    </tr>
  );
}
