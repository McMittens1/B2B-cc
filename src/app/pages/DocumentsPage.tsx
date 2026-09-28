import { useMemo, useState } from 'react';
import { formatDate } from '../../engine/dates';
import { LETTER_KIND_LABELS, letterBlocks, letterToText, type Letter, type LetterKind } from '../../engine/docs/letters';
import { cents, formatMoney, sum } from '../../engine/money';
import type { Contractor, Payroll } from '../../engine/types';
import {
  downloadFindingsCsv,
  downloadLedgerWorkbook,
  downloadLetter,
  downloadStampedBundle,
  downloadStampedPayroll,
  draftLetter,
  type LetterFormat,
} from '../actions';
import { projectPath, useDocumentTitle } from '../router';
import type { ProjectView } from '../store';
import { Alert, Button, EmptyState, Modal, Money, PageHeader, Panel, PayrollStatusBadge, useToast } from '../ui';

/**
 * Documents: the paperwork that follows a review. Letters and memos are drafted from the
 * current findings and ledger, previewed here, and downloaded as Word, PDF or text.
 */

interface ContractorRow {
  contractor: Contractor;
  violations: number;
  warnings: number;
  balance: number;
  missing: string[];
}

interface Preview {
  kind: LetterKind;
  contractorId: string | null;
  letter: Letter;
}

export function DocumentsPage({ view }: { view: ProjectView }) {
  const { data, evaluation } = view;
  const pid = data.project.id;
  useDocumentTitle(`Letters & documents · ${data.project.name}`);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stampFilter, setStampFilter] = useState<string>('');
  const [includeDismissed, setIncludeDismissed] = useState(false);

  const rows: ContractorRow[] = useMemo(
    () =>
      data.contractors.map((c) => {
        const own = view.openFindings.filter((f) => f.contractorId === c.id);
        return {
          contractor: c,
          violations: own.filter((f) => f.severity === 'violation' && f.ruleId !== 'missing-week').length,
          warnings: own.filter((f) => f.severity === 'warning' && f.ruleId !== 'missing-week').length,
          balance: cents(sum(view.ledger.rows.filter((r) => r.finding.contractorId === c.id).map((r) => r.balance))),
          missing: own.filter((f) => f.ruleId === 'missing-week' && f.weekEnding).map((f) => f.weekEnding!),
        };
      }),
    [data.contractors, view.openFindings, view.ledger.rows],
  );

  const current = useMemo(() => {
    const superseded = new Set(data.payrolls.map((p) => p.supersedesPayrollId).filter(Boolean));
    return data.payrolls
      .filter((p) => !superseded.has(p.id))
      .sort((a, b) => b.weekEnding.localeCompare(a.weekEnding) || (view.contractorById.get(a.contractorId)?.name ?? '').localeCompare(view.contractorById.get(b.contractorId)?.name ?? ''));
  }, [data.payrolls, view.contractorById]);
  const stampList = stampFilter ? current.filter((p) => p.contractorId === stampFilter) : current;

  const run = async (label: string, fn: () => Promise<void> | void) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(`${label} failed: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const open = (kind: LetterKind, contractorId: string | null) =>
    run('Letter', () => setPreview({ kind, contractorId, letter: draftLetter(view, kind, contractorId) }));

  const reviewerMissing = !data.project.reviewer.name.trim();

  return (
    <div className="page">
      <PageHeader
        title="Letters & documents"
        subtitle="Letters, memos, stamped payrolls and exports, drafted from the review as it stands today. Files are generated in this browser."
      />

      {reviewerMissing && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warn">
            Letters and stamps are signed with the reviewer named in project settings, and none is set.{' '}
            <a href={`#${projectPath(pid, 'settings')}`}>Add your name and title</a>.
          </Alert>
        </div>
      )}

      <div className="stack">
        <Panel title="Letters to contractors" bodyClass="">
          {rows.length === 0 ? (
            <EmptyState title="No contractors yet">Letters are addressed to the contractors on this project.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data" aria-label="Letters to contractors">
                <thead>
                  <tr>
                    <th>Contractor</th>
                    <th className="num">Violations</th>
                    <th className="num">Warnings</th>
                    <th className="num">Back wages due</th>
                    <th>Missing weeks</th>
                    <th>Draft</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.contractor.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.contractor.name}</div>
                        {r.contractor.contactEmail && <div className="small muted">{r.contractor.contactEmail}</div>}
                      </td>
                      <td className="num">{r.violations || <span className="faint">0</span>}</td>
                      <td className="num">{r.warnings || <span className="faint">0</span>}</td>
                      <td className="num">{r.balance > 0 ? <Money value={r.balance} /> : <span className="faint">—</span>}</td>
                      <td className="small">
                        {r.missing.length ? r.missing.map((w) => formatDate(w)).join(', ') : <span className="faint">None</span>}
                      </td>
                      <td>
                        <div className="row">
                          <Button
                            size="sm"
                            icon="mail"
                            disabled={busy !== null || (r.violations === 0 && r.warnings === 0 && r.balance <= 0)}
                            title={r.violations === 0 && r.warnings === 0 && r.balance <= 0 ? 'Nothing open to correct' : undefined}
                            onClick={() => open('correction-request', r.contractor.id)}
                          >
                            Correction request
                          </Button>
                          <Button
                            size="sm"
                            icon="mail"
                            disabled={busy !== null || r.missing.length === 0}
                            title={r.missing.length === 0 ? 'No overdue weeks' : undefined}
                            onClick={() => open('missing-payrolls', r.contractor.id)}
                          >
                            Missing payrolls
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="grid-2">
          <Panel title="Review memo to file">
            <p className="muted" style={{ marginTop: 0 }}>
              A summary of the project for the file or the funding agency: payrolls received and missing, exceptions by
              contractor, back wages and restitution status.
            </p>
            <Button icon="doc" disabled={busy !== null} onClick={() => open('review-memo', null)}>
              Preview memo
            </Button>
          </Panel>

          <Panel title="Exports">
            <div className="stack" style={{ gap: 10 }}>
              <div className="row spread">
                <div>
                  <div style={{ fontWeight: 600 }}>Restitution ledger</div>
                  <div className="small muted">{view.ledger.rows.length} items · Excel with totals</div>
                </div>
                <Button size="sm" icon="download" disabled={busy !== null || view.ledger.rows.length === 0} onClick={() => run('Ledger export', () => downloadLedgerWorkbook(view))}>
                  Excel
                </Button>
              </div>
              <div className="row spread">
                <div>
                  <div style={{ fontWeight: 600 }}>All findings</div>
                  <label className="check small">
                    <input type="checkbox" checked={includeDismissed} onChange={(e) => setIncludeDismissed(e.target.checked)} /> Include dismissed
                  </label>
                </div>
                <Button size="sm" icon="download" disabled={busy !== null} onClick={() => run('Findings export', () => downloadFindingsCsv(view, includeDismissed))}>
                  CSV
                </Button>
              </div>
              <div className="small muted">
                For a copy of everything, including the original files, use the backup in{' '}
                <a href={`#${projectPath(pid, 'settings')}`}>project settings</a>.
              </div>
            </div>
          </Panel>
        </div>

        <Panel
          title="Stamped payrolls"
          bodyClass=""
          actions={
            current.length > 0 && (
              <div className="row">
                <select className="select" aria-label="Contractor for stamped payrolls" value={stampFilter} onChange={(e) => setStampFilter(e.target.value)}>
                  <option value="">All contractors</option>
                  {data.contractors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  icon="stamp"
                  disabled={busy !== null || stampList.length === 0}
                  onClick={() =>
                    run('Stamped payrolls', async () => {
                      const label = stampFilter ? (view.contractorById.get(stampFilter)?.name ?? 'Contractor') : data.project.name;
                      const ordered = [...stampList].sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
                      const problems = await downloadStampedBundle(view, ordered, label);
                      toast(
                        problems.length
                          ? `Downloaded. ${problems.length} original ${problems.length === 1 ? 'file' : 'files'} could not be stamped and were replaced by a generated copy.`
                          : `${ordered.length} stamped ${ordered.length === 1 ? 'payroll' : 'payrolls'} downloaded as one PDF`,
                        problems.length ? 'bad' : undefined,
                      );
                    })
                  }
                >
                  {busy === 'Stamped payrolls' ? 'Preparing…' : `Download ${stampList.length} as one PDF`}
                </Button>
              </div>
            )
          }
        >
          <p className="small muted" style={{ margin: '12px 14px' }}>
            Each payroll carries a review notation on its first page (wage determination, date, reviewer and result) with a
            Payroll Review Worksheet appended. PDFs the contractor sent are stamped as received; payrolls from spreadsheets or
            keyed in get a generated copy of the lines.
          </p>
          {stampList.length === 0 ? (
            <EmptyState title="No payrolls yet">Payrolls appear here once they are added.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data" aria-label="Stamped payrolls">
                <thead>
                  <tr>
                    <th>Week ending</th>
                    <th>Contractor</th>
                    <th>Payroll</th>
                    <th>Status</th>
                    <th>Result</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {stampList.map((p) => (
                    <StampRow key={p.id} payroll={p} view={view} busy={busy} run={run} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {preview && (
        <LetterPreview
          preview={preview}
          view={view}
          busy={busy}
          onClose={() => setPreview(null)}
          onDownload={(format) => run('Letter', () => downloadLetter(view, preview.kind, preview.contractorId, format))}
          onCopy={() =>
            run('Copy', async () => {
              await navigator.clipboard.writeText(letterToText(preview.letter));
              toast('Letter copied as plain text');
            })
          }
        />
      )}
    </div>
  );
}

function StampRow({
  payroll,
  view,
  busy,
  run,
}: {
  payroll: Payroll;
  view: ProjectView;
  busy: string | null;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const toast = useToast();
  const s = view.evaluation.payrolls.get(payroll.id);
  const result = !s
    ? '—'
    : s.violations > 0
      ? `${s.violations} ${s.violations === 1 ? 'violation' : 'violations'}${s.owed > 0 ? `, ${formatMoney(s.owed)} owed` : ''}`
      : s.warnings > 0
        ? `${s.warnings} ${s.warnings === 1 ? 'warning' : 'warnings'}`
        : 'No exceptions';
  return (
    <tr>
      <td className="nowrap">
        <a href={`#${projectPath(view.data.project.id, 'payrolls', payroll.id)}`}>{formatDate(payroll.weekEnding)}</a>
      </td>
      <td>{view.contractorById.get(payroll.contractorId)?.name ?? 'Unknown contractor'}</td>
      <td className="nowrap">{payroll.noWork ? 'No work' : payroll.payrollNumber || '—'}</td>
      <td>
        <PayrollStatusBadge status={payroll.status} />
      </td>
      <td className={s && s.violations > 0 ? 'small' : 'small muted'} style={s && s.violations > 0 ? { color: 'var(--bad)' } : undefined}>
        {result}
      </td>
      <td className="num">
        <Button
          size="sm"
          variant="ghost"
          icon="stamp"
          disabled={busy !== null}
          onClick={() =>
            run('Stamped PDF', async () => {
              const problem = await downloadStampedPayroll(view, payroll);
              if (problem) toast(`Downloaded a generated copy: ${problem}`, 'bad');
            })
          }
        >
          PDF
        </Button>
      </td>
    </tr>
  );
}

function LetterPreview({
  preview,
  view,
  busy,
  onClose,
  onDownload,
  onCopy,
}: {
  preview: Preview;
  view: ProjectView;
  busy: string | null;
  onClose: () => void;
  onDownload: (format: LetterFormat) => void;
  onCopy: () => void;
}) {
  const { letter } = preview;
  const who = preview.contractorId ? view.contractorById.get(preview.contractorId)?.name : null;
  const memo = letter.kind === 'review-memo';
  return (
    <Modal
      open
      wide
      title={`${LETTER_KIND_LABELS[preview.kind]}${who ? ` · ${who}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <span className="small muted" style={{ marginRight: 'auto', alignSelf: 'center' }}>
            Edit the Word version to put it on letterhead.
          </span>
          <Button onClick={onCopy} disabled={busy !== null}>
            Copy text
          </Button>
          <Button icon="download" onClick={() => onDownload('pdf')} disabled={busy !== null}>
            PDF
          </Button>
          <Button variant="primary" icon="download" onClick={() => onDownload('docx')} disabled={busy !== null}>
            Word
          </Button>
        </>
      }
    >
      <article className="letter" aria-label="Letter preview">
        {memo ? (
          <>
            <div className="letter-title">Memorandum</div>
            <dl className="kv">
              <dt>To</dt>
              <dd>{letter.to.join(', ') || '—'}</dd>
              <dt>From</dt>
              <dd>{letter.from.join(', ') || '—'}</dd>
              <dt>Date</dt>
              <dd>{formatDate(letter.date)}</dd>
              <dt>Subject</dt>
              <dd>{letter.subject}</dd>
            </dl>
          </>
        ) : (
          <>
            <div className="letter-lines">{letter.from.join('\n')}</div>
            <div className="letter-lines">{formatDate(letter.date)}</div>
            <div className="letter-lines">{letter.to.join('\n')}</div>
            <p>
              <strong>Re: {letter.subject}</strong>
            </p>
          </>
        )}
        {letterBlocks(letter).map((b, i) =>
          b.type === 'paragraph' ? (
            <p key={i}>{b.text}</p>
          ) : (
            <div key={i} className="table-wrap letter-table">
              <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
                {b.table.title}
              </div>
              <table className="data">
                <thead>
                  <tr>
                    {b.table.columns.map((c, j) => (
                      <th key={j} className={b.table.numericColumns?.includes(j) ? 'num' : undefined}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.table.rows.map((r, k) => (
                    <tr key={k}>
                      {b.table.columns.map((_, j) => (
                        <td key={j} className={b.table.numericColumns?.includes(j) ? 'num' : undefined}>
                          {r[j] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {b.table.footer && (
                    <tr className="total">
                      {b.table.columns.map((_, j) => (
                        <td key={j} className={b.table.numericColumns?.includes(j) ? 'num' : undefined}>
                          {b.table.footer?.[j] ?? ''}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ),
        )}
        {letter.closing.length > 0 && <div className="letter-lines">{letter.closing.join('\n')}</div>}
      </article>
    </Modal>
  );
}
