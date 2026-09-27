import { useMemo, useSyncExternalStore } from 'react';
import { loadProjectData, type ProjectData } from '../db/repo';
import { evaluateProject, type Evaluation } from '../engine/checks/evaluate';
import { buildLedger, type LedgerRow, type LedgerTotals } from '../engine/restitution';
import { todayIso } from '../engine/dates';
import type { Contractor, Finding, Payroll } from '../engine/types';

/**
 * The open project, loaded fully into memory. A project is small (hundreds of payrolls at
 * most), so every mutation simply writes to IndexedDB and reloads the project; the whole
 * compliance evaluation is then recomputed from source data. That keeps findings and
 * restitution consistent with whatever the reviewer just changed.
 */

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'missing';

interface Snapshot {
  status: StoreStatus;
  projectId: string | null;
  data: ProjectData | null;
  version: number;
}

type Listener = () => void;

class ProjectStore {
  private snapshot: Snapshot = { status: 'idle', projectId: null, data: null, version: 0 };
  private listeners = new Set<Listener>();
  private loadToken = 0;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private set(next: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...next, version: this.snapshot.version + 1 };
    for (const l of this.listeners) l();
  }

  async open(projectId: string): Promise<void> {
    if (this.snapshot.projectId === projectId && this.snapshot.status === 'ready') return;
    const token = ++this.loadToken;
    this.set({ status: 'loading', projectId, data: null });
    const data = await loadProjectData(projectId);
    if (token !== this.loadToken) return;
    this.set({ status: data ? 'ready' : 'missing', data });
  }

  close(): void {
    this.loadToken++;
    this.set({ status: 'idle', projectId: null, data: null });
  }

  async refresh(): Promise<void> {
    const id = this.snapshot.projectId;
    if (!id) return;
    const token = ++this.loadToken;
    const data = await loadProjectData(id);
    if (token !== this.loadToken) return;
    this.set({ status: data ? 'ready' : 'missing', data });
  }

  /** Run a write, then reload the project so every view reflects it. */
  async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = await fn();
    await this.refresh();
    return result;
  }
}

export const projectStore = new ProjectStore();

export function useProjectSnapshot(): Snapshot {
  return useSyncExternalStore(projectStore.subscribe, projectStore.getSnapshot);
}

export interface ProjectView {
  data: ProjectData;
  evaluation: Evaluation;
  /** Findings the reviewer has not dismissed. */
  openFindings: Finding[];
  dismissed: Set<string>;
  ledger: { rows: LedgerRow[]; totals: LedgerTotals };
  contractorById: Map<string, Contractor>;
  payrollById: Map<string, Payroll>;
  asOf: string;
}

/** Derived, memoized view of the open project: evaluation, ledger and lookup maps. */
export function useProjectView(): ProjectView | null {
  const snap = useProjectSnapshot();
  const data = snap.status === 'ready' ? snap.data : null;
  const asOf = todayIso();
  return useMemo(() => {
    if (!data) return null;
    const evaluation = evaluateProject({
      project: data.project,
      wd: data.wd?.parsed ?? null,
      contractors: data.contractors,
      payrolls: data.payrolls,
      mappings: data.mappings,
      asOf,
    });
    const dismissed = new Set(data.dispositions.map((d) => d.findingKey));
    const openFindings = evaluation.findings.filter((f) => !dismissed.has(f.key));
    const ledger = buildLedger([...evaluation.findings, ...evaluation.historicalFindings], data.restitution, data.contractors);
    return {
      data,
      evaluation,
      openFindings,
      dismissed,
      ledger,
      contractorById: new Map(data.contractors.map((c) => [c.id, c])),
      payrollById: new Map(data.payrolls.map((p) => [p.id, p])),
      asOf,
    };
  }, [data, asOf]);
}
