import { formatDate, isIsoDate } from '../dates';
import type { ContractorTier, Finding, ISODate, PayrollSourceKind, RuleId, Severity } from '../types';

/** Shared wording for review documents, so the stamp, worksheet, letters and exports agree. */

export const REVIEW_AID_NOTICE =
  "Reviewer's working document prepared with Wagebench, a review aid. Findings reflect the reviewer's comparison of the payroll as submitted with the wage determination; they are not a legal determination of compliance.";

export const SEVERITY_LABELS: Record<Severity, string> = {
  violation: 'Violation',
  warning: 'Warning',
  info: 'Note',
};

export const SEVERITY_GROUP_LABELS: Record<Severity, string> = {
  violation: 'Violations',
  warning: 'Warnings',
  info: 'Notes',
};

export const TIER_LABELS: Record<ContractorTier, string> = {
  prime: 'Prime contractor',
  subcontractor: 'Subcontractor',
  'lower-tier': 'Lower-tier subcontractor',
};

export const SOURCE_LABELS: Record<PayrollSourceKind, string> = {
  csv: 'CSV file',
  xlsx: 'Excel workbook',
  'wh347-pdf': 'WH-347 PDF',
  manual: 'Entered by the reviewer',
};

/** Short names for each check, used in tables and exports. */
export const RULE_LABELS: Record<RuleId, string> = {
  'classification-unmapped': 'Classification not matched',
  'classification-not-on-wd': 'Classification not on WD',
  'base-rate-below-wd': 'Basic rate below WD',
  'fringe-shortfall': 'Fringe shortfall',
  'overtime-rate': 'Overtime rate below 1.5x',
  'overtime-unreported': 'Hours over 40 paid at straight time',
  'eo-minimum-wage': 'Below Executive Order minimum wage',
  'apprentice-unregistered': 'Apprentice registration not on file',
  'apprentice-rate': 'Apprentice rate below program schedule',
  'apprentice-ratio': 'Apprentice over ratio',
  'hours-arithmetic': 'Daily hours do not add up',
  'gross-arithmetic': 'Gross pay arithmetic',
  'net-arithmetic': 'Net pay arithmetic',
  'gross-exceeds-all-work': 'Project gross exceeds gross for all work',
  'full-ssn': 'Full SSN on payroll',
  'soc-missing': 'Statement of Compliance missing',
  'late-submission': 'Late submission',
  'duplicate-week': 'Duplicate week',
  'payroll-number-gap': 'Payroll numbering gap',
  'per-day-rate': 'Per-day rate',
  'fringe-footnote': 'Fringe footnote',
  'missing-week': 'Payroll not received',
  'invalid-date': 'Date missing or invalid',
};

const SEVERITY_ORDER: Record<Severity, number> = { violation: 0, warning: 1, info: 2 };

export function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "WD OH20260047 Mod 2", for compact notations. */
export function wdShort(wdNumber: string | null | undefined, modification: number | null | undefined): string | null {
  const number = wdNumber?.trim();
  if (!number) return null;
  return modification === null || modification === undefined ? `WD ${number}` : `WD ${number} Mod ${modification}`;
}

/** "wage determination OH20260047, Modification 2", for sentences. */
export function wdLong(wdNumber: string | null | undefined, modification: number | null | undefined): string {
  const number = wdNumber?.trim();
  if (!number) return 'the applicable wage determination';
  return modification === null || modification === undefined
    ? `wage determination ${number}`
    : `wage determination ${number}, Modification ${modification}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "September 28, 2026" — the date style used in letters. */
export function longDate(date: ISODate | null | undefined): string {
  if (!date || !isIsoDate(date)) return formatDate(date);
  const [y, m, d] = date.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

/**
 * Mask an identifying number that looks like a full SSN down to its last four digits.
 * Payrolls sometimes carry full SSNs; the reviewer's documents should not copy them.
 */
export function maskIdentifier(id: string): string {
  const trimmed = id.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 9 && /^\d{3}[-\s]?\d{2}[-\s]?\d{4}$/.test(trimmed)) return `***-**-${digits.slice(5)}`;
  return trimmed;
}

/** Split a free-text address into lines (newlines, or semicolons used as separators). */
export function addressLines(address: string): string[] {
  return address
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
}
