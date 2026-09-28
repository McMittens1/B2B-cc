import { useEffect, useRef, useState } from 'react';
import { listProjects, projectCounts } from '../../db/repo';
import { BackupError, MAX_BACKUP_BYTES, existingCopy, readBackup, restoreProjectBackup, type ValidatedBackup } from '../../db/backup';
import { formatDate } from '../../engine/dates';
import type { Project } from '../../engine/types';
import { navigate, projectPath, useDocumentTitle } from '../router';
import { Button, ConfirmModal, EmptyState, PageHeader, Panel, Spinner, useToast } from '../ui';
import { createDemoProject } from '../../sample/demo';

interface Row {
  project: Project;
  payrolls: number;
  contractors: number;
}

export function ProjectsPage() {
  useDocumentTitle('Projects');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const restoreInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ backup: ValidatedBackup; local: Project } | null>(null);

  const load = async () => {
    const projects = await listProjects();
    const counts = await Promise.all(projects.map((p) => projectCounts(p.id)));
    setRows(projects.map((project, i) => ({ project, ...counts[i]! })));
  };

  useEffect(() => {
    void load();
  }, []);

  const openDemo = async () => {
    setBusy('demo');
    try {
      const project = await createDemoProject();
      navigate(projectPath(project.id));
    } catch (e) {
      toast(`Could not create the demo project: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const write = async (backup: ValidatedBackup) => {
    const project = await restoreProjectBackup(backup);
    toast(`Restored "${project.name}"`);
    navigate(projectPath(project.id));
  };

  const restore = async (file: File) => {
    setBusy('restore');
    try {
      if (file.size > MAX_BACKUP_BYTES) {
        throw new BackupError('This backup is too large for the browser to read back (over 400 MB). Split the project, or keep the original payroll files outside Wagebench.');
      }
      const backup = readBackup(await file.text());
      const local = await existingCopy(backup);
      // Replacing a project already in this browser discards anything done since the backup: ask first.
      if (local) setPending({ backup, local });
      else await write(backup);
    } catch (e) {
      toast(e instanceof BackupError ? e.message : `Restore failed: ${(e as Error).message}`, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const actions = (
    <>
      <Button icon="upload" onClick={() => restoreInput.current?.click()} disabled={busy !== null}>
        Restore backup
      </Button>
      <input
        ref={restoreInput}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="restore-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void restore(f);
        }}
      />
      <Button variant="primary" icon="plus" onClick={() => navigate('/new')}>
        New project
      </Button>
    </>
  );

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Each project is one federally funded or prevailing-wage contract you review payrolls for."
        actions={actions}
      />
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            title="Review certified payrolls without the spreadsheet"
            actions={
              <>
                <Button variant="primary" onClick={openDemo} disabled={busy !== null}>
                  {busy === 'demo' ? 'Building demo…' : 'Open the demo project'}
                </Button>
                <Button onClick={() => navigate('/new')}>Start a real project</Button>
              </>
            }
          >
            <ol style={{ textAlign: 'left', maxWidth: 560, margin: '12px auto 0', lineHeight: 1.7 }}>
              <li>Paste the project's wage determination from SAM.gov. Wagebench reads every classification, rate and fringe.</li>
              <li>Drop in the weekly payrolls your contractors email you: WH-347 PDFs, spreadsheets or payroll exports.</li>
              <li>Every worker line is checked against the wage determination. You get the underpayments in dollars, missing weeks, correction letters and a review stamp for the file.</li>
            </ol>
            <p className="small" style={{ marginTop: 12 }}>
              Everything stays in this browser. Nothing is uploaded to any server.
            </p>
          </EmptyState>
        </Panel>
      ) : (
        <Panel bodyClass="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Owner / grantee</th>
                <th>Funding</th>
                <th className="num">Contractors</th>
                <th className="num">Payrolls</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ project, payrolls, contractors }) => (
                <tr key={project.id} className="clickable" onClick={() => navigate(projectPath(project.id))}>
                  <td>
                    <a href={`#${projectPath(project.id)}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{project.name}</strong>
                    </a>
                    {project.projectNumber && <div className="sub">{project.projectNumber}</div>}
                  </td>
                  <td>{project.owner || <span className="faint">—</span>}</td>
                  <td>{project.fundingSource}</td>
                  <td className="num">{contractors}</td>
                  <td className="num">{payrolls}</td>
                  <td className="nowrap">{formatDate(project.updatedAt.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="panel-footer" style={{ justifyContent: 'flex-start' }}>
            <Button size="sm" variant="ghost" onClick={openDemo} disabled={busy !== null}>
              {busy === 'demo' ? 'Building demo…' : 'Add another demo project'}
            </Button>
          </div>
        </Panel>
      )}
      <ConfirmModal
        open={pending !== null}
        title="Replace the project in this browser?"
        danger
        confirmLabel="Replace with the backup"
        message={
          pending && (
            <>
              <p style={{ marginTop: 0 }}>
                <strong>{pending.local.name}</strong> is already in this browser. Restoring replaces it with the backup, and
                anything done here since the backup was made is lost.
              </p>
              <dl className="kv">
                <dt>Copy in this browser</dt>
                <dd>last changed {formatWhen(pending.local.updatedAt)}</dd>
                <dt>Backup</dt>
                <dd>made {formatWhen(pending.backup.exportedAt)} · {pending.backup.payrolls.length} payrolls</dd>
              </dl>
              <p className="small muted">To keep both, open the project and download its backup first.</p>
            </>
          )
        }
        onConfirm={async () => {
          if (!pending) return;
          try {
            await write(pending.backup);
          } catch (e) {
            toast(e instanceof BackupError ? e.message : `Restore failed: ${(e as Error).message}`, 'bad');
          }
        }}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'at an unknown time' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
