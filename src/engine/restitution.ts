import { cents, sum } from './money';
import type { Contractor, Finding, RestitutionRecord, RestitutionStatus, RuleId } from './types';

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

/** Underpayment rules that describe the same money, grouped so a correction can be matched to the original. */
function ruleFamily(ruleId: RuleId): string {
  return ruleId === 'base-rate-below-wd' || ruleId === 'apprentice-rate' || ruleId === 'eo-minimum-wage' ? 'base' : ruleId;
}

function matchKey(payrollId: string, f: Finding): string {
  return [payrollId, ruleFamily(f.ruleId), (f.workerName ?? '').trim().toLowerCase().replace(/\s+/g, ' ')].join('|');
}

/**
 * How much of each superseded finding the correction actually resolved: the original amount
 * less what the correcting payroll still shows owed for the same worker and rule. A correction
 * that is still $110 short of a $274 underpayment resolves $164, not $274.
 */
function resolvedBySupersession(findings: readonly Finding[]): Map<string, number> {
  const owedBy = new Map<string, number>();
  for (const f of findings) {
    if (!f.payrollId || f.amountOwed <= 0) continue;
    const k = matchKey(f.payrollId, f);
    owedBy.set(k, cents((owedBy.get(k) ?? 0) + f.amountOwed));
  }
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.supersededBy || !f.payrollId || f.amountOwed <= 0) continue;
    const k = matchKey(f.payrollId, f);
    const list = groups.get(k) ?? [];
    list.push(f);
    groups.set(k, list);
  }
  const out = new Map<string, number>();
  for (const [k, list] of groups) {
    const original = owedBy.get(k) ?? 0;
    const stillOwed = owedBy.get(matchKey(list[0]!.supersededBy!, list[0]!)) ?? 0;
    const resolved = cents(Math.max(0, original - stillOwed));
    let allocated = 0;
    list.forEach((f, i) => {
      const share = i === list.length - 1 ? cents(resolved - allocated) : cents((f.amountOwed / original) * resolved);
      allocated = cents(allocated + share);
      out.set(f.key, Math.max(0, share));
    });
  }
  return out;
}

/**
 * Join computed underpayment findings with the reviewer's restitution tracking.
 * Findings are recomputed from payroll data every time, so records are keyed by
 * finding key. Underpayments on payrolls that a correction replaced stay in the ledger
 * (pass them in with `supersededBy` set) for the part the correction resolved; unless the
 * reviewer recorded otherwise, that part counts as paid through the corrected payroll,
 * pending verification. What the correction still leaves unpaid is carried by its own findings.
 */
export function buildLedger(
  findings: readonly Finding[],
  records: readonly RestitutionRecord[],
  contractors: readonly Contractor[],
): { rows: LedgerRow[]; totals: LedgerTotals } {
  const byKey = new Map(records.map((r) => [r.findingKey, r]));
  const names = new Map(contractors.map((c) => [c.id, c.name]));
  const resolved = resolvedBySupersession(findings);
  const rows: LedgerRow[] = [];
  for (const f of findings) {
    if (f.amountOwed <= 0) continue;
    const corrected = Boolean(f.supersededBy);
    const amountOwed = corrected ? (resolved.get(f.key) ?? 0) : f.amountOwed;
    if (amountOwed <= 0) continue;
    const r = byKey.get(f.key);
    const status: RestitutionStatus = r?.status ?? (corrected ? 'paid' : 'owed');
    const amountPaid =
      status === 'waived'
        ? 0
        : r
          ? cents(Math.min(Math.max(0, r.amountPaid), amountOwed))
          : corrected
            ? amountOwed
            : 0;
    // "Verified" records that payment was checked; a shortfall or a later increase in the amount still shows.
    const balance = status === 'waived' ? 0 : cents(amountOwed - amountPaid);
    rows.push({
      finding: f,
      contractorName: names.get(f.contractorId) ?? 'Unknown contractor',
      status,
      amountOwed,
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
