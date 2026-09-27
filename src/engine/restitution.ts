import { cents, sum } from './money';
import type { Contractor, Finding, RestitutionRecord, RestitutionStatus } from './types';

export interface LedgerRow {
  finding: Finding;
  contractorName: string;
  status: RestitutionStatus;
  amountOwed: number;
  amountPaid: number;
  balance: number;
  note: string;
  updatedAt: string | null;
}

export interface LedgerTotals {
  owed: number;
  paid: number;
  outstanding: number;
  byStatus: Record<RestitutionStatus, number>;
}

/**
 * Join computed underpayment findings with the reviewer's restitution tracking.
 * Findings are recomputed from payroll data every time, so records are keyed by
 * finding key. Underpayments on payrolls that a correction replaced stay in the ledger
 * (pass them in with `supersededBy` set); unless the reviewer recorded otherwise they
 * count as paid through the corrected payroll, pending verification.
 */
export function buildLedger(
  findings: readonly Finding[],
  records: readonly RestitutionRecord[],
  contractors: readonly Contractor[],
): { rows: LedgerRow[]; totals: LedgerTotals } {
  const byKey = new Map(records.map((r) => [r.findingKey, r]));
  const names = new Map(contractors.map((c) => [c.id, c.name]));
  const rows: LedgerRow[] = [];
  for (const f of findings) {
    if (f.amountOwed <= 0) continue;
    const r = byKey.get(f.key);
    const corrected = Boolean(f.supersededBy);
    const status: RestitutionStatus = r?.status ?? (corrected ? 'paid' : 'owed');
    const amountPaid =
      status === 'waived'
        ? 0
        : r
          ? cents(Math.min(Math.max(0, r.amountPaid), f.amountOwed))
          : corrected
            ? f.amountOwed
            : 0;
    const balance = status === 'waived' || status === 'verified' ? 0 : cents(f.amountOwed - amountPaid);
    rows.push({
      finding: f,
      contractorName: names.get(f.contractorId) ?? 'Unknown contractor',
      status,
      amountOwed: f.amountOwed,
      amountPaid,
      balance,
      note: r?.note ?? (corrected ? 'Corrected payroll received; verify proof of payment.' : ''),
      updatedAt: r?.updatedAt ?? null,
    });
  }
  rows.sort(
    (a, b) =>
      a.contractorName.localeCompare(b.contractorName) ||
      (a.finding.weekEnding ?? '').localeCompare(b.finding.weekEnding ?? '') ||
      (a.finding.workerName ?? '').localeCompare(b.finding.workerName ?? ''),
  );
  const byStatus: Record<RestitutionStatus, number> = { owed: 0, requested: 0, paid: 0, verified: 0, waived: 0 };
  for (const r of rows) byStatus[r.status] = cents(byStatus[r.status] + r.amountOwed);
  const totals: LedgerTotals = {
    owed: cents(sum(rows.map((r) => r.amountOwed))),
    paid: cents(sum(rows.map((r) => r.amountPaid))),
    outstanding: cents(sum(rows.map((r) => r.balance))),
    byStatus,
  };
  return { rows, totals };
}

export const RESTITUTION_STATUS_LABELS: Record<RestitutionStatus, string> = {
  owed: 'Owed',
  requested: 'Requested',
  paid: 'Paid (unverified)',
  verified: 'Verified',
  waived: 'Waived / not owed',
};
