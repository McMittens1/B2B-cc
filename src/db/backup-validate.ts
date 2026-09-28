import { isIsoDate } from '../engine/dates';
import type {
  ApprenticeProgram,
  ClassificationMapping,
  Contractor,
  FindingDisposition,
  FundingSource,
  Payroll,
  PayrollLine,
  Project,
  RestitutionRecord,
  StoredWageDetermination,
} from '../engine/types';
import { parseWageDetermination } from '../engine/wd/parse';
import type { ActivityEntry, ImportProfile } from './db';

/**
 * Backups are files a reviewer may receive from someone else, so nothing in one is trusted.
 * Every record is rebuilt field by field: required values must be present and well formed,
 * optional ones fall back to defaults, and anything else is dropped. A record that cannot be
 * rebuilt rejects the whole backup.
 */

export class BackupShapeError extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BackupShapeError(`${what} is missing or damaged.`);
  return v as Obj;
}

function reqStr(o: Obj, k: string, what: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v === '' || v.length > 500) throw new BackupShapeError(`${what} has no valid ${k}.`);
  return v;
}

const str = (v: unknown, fallback = '', max = 20_000): string => (typeof v === 'string' ? v.slice(0, max) : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const date = (v: unknown): string | null => (isIsoDate(v) ? v : null);

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BackupShapeError(`${what} is not a number.`);
  return v;
}

function numOrNull(v: unknown, what: string): number | null {
  return v === null || v === undefined ? null : num(v, what);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new BackupShapeError(`${what} is missing or damaged.`);
  return v;
}

const FUNDING: readonly FundingSource[] = ['CDBG', 'CDBG-DR', 'HOME', 'EPA SRF', 'USDA RD', 'FHWA', 'FAA', 'Other federal'];

export function normalizeProject(v: unknown, defaults: Project['settings']): Project {
  const o = obj(v, 'The project');
  const reviewer = o.reviewer && typeof o.reviewer === 'object' ? (o.reviewer as Obj) : {};
  const settings = o.settings && typeof o.settings === 'object' ? (o.settings as Obj) : {};
  const positive = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : fallback);
  const now = new Date().toISOString();
  return {
    id: reqStr(o, 'id', 'The project'),
    name: reqStr(o, 'name', 'The project').slice(0, 300),
    projectNumber: str(o.projectNumber, '', 200),
    location: str(o.location, '', 300),
    owner: str(o.owner, '', 300),
    fundingSource: oneOf(o.fundingSource, FUNDING, 'Other federal'),
    wdLockDate: date(o.wdLockDate),
    reviewer: {
      name: str(reviewer.name, '', 200),
      title: str(reviewer.title, '', 200),
      organization: str(reviewer.organization, '', 300),
      email: str(reviewer.email, '', 300),
      phone: str(reviewer.phone, '', 100),
    },
    settings: {
      overtimeRuleApplies: bool(settings.overtimeRuleApplies, defaults.overtimeRuleApplies),
      lateAfterDays: positive(settings.lateAfterDays, defaults.lateAfterDays),
      arithmeticToleranceDollars: positive(settings.arithmeticToleranceDollars, defaults.arithmeticToleranceDollars),
      executiveOrderMinimumWage:
        typeof settings.executiveOrderMinimumWage === 'number' && Number.isFinite(settings.executiveOrderMinimumWage)
          ? settings.executiveOrderMinimumWage
          : null,
    },
    createdAt: str(o.createdAt, now, 40),
    updatedAt: str(o.updatedAt, now, 40),
  };
}

/** The stored WD is re-read from its text, so a backup cannot plant classifications the text does not contain. */
export function normalizeWd(v: unknown, projectId: string): StoredWageDetermination {
  const o = obj(v, 'A wage determination');
  const rawText = str(o.rawText, '', 2_000_000);
  if (!rawText.trim()) throw new BackupShapeError('A wage determination has no text.');
  return { id: reqStr(o, 'id', 'A wage determination'), projectId, rawText, parsed: parseWageDetermination(rawText), importedAt: str(o.importedAt, '', 40) };
}

function normalizeProgram(v: unknown): ApprenticeProgram {
  const o = obj(v, 'An apprenticeship program');
  const pct = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
  return {
    id: reqStr(o, 'id', 'An apprenticeship program'),
    name: str(o.name, '', 300),
    registeredWith: oneOf(o.registeredWith, ['OA', 'SAA'] as const, 'OA'),
    classification: str(o.classification, '', 300),
    wagePercent: pct(o.wagePercent),
    fringePercent: pct(o.fringePercent),
    maxApprenticesPerJourneyworker: pct(o.maxApprenticesPerJourneyworker),
  };
}

export function normalizeContractor(v: unknown, projectId: string): Contractor {
  const o = obj(v, 'A contractor');
  return {
    id: reqStr(o, 'id', 'A contractor'),
    projectId,
    name: reqStr(o, 'name', 'A contractor').slice(0, 300),
    tier: oneOf(o.tier, ['prime', 'subcontractor', 'lower-tier'] as const, 'subcontractor'),
    trade: str(o.trade, '', 300),
    startDate: date(o.startDate),
    endDate: date(o.endDate),
    contactName: str(o.contactName, '', 300),
    contactEmail: str(o.contactEmail, '', 300),
    address: str(o.address, '', 1000),
    apprenticePrograms: (Array.isArray(o.apprenticePrograms) ? o.apprenticePrograms : []).map(normalizeProgram),
  };
}

function hoursArray(v: unknown, what: string): number[] {
  if (!Array.isArray(v)) return [];
  if (v.length > 14) throw new BackupShapeError(`${what} has too many days.`);
  return v.map((h) => num(h, what));
}

function normalizeLine(v: unknown): PayrollLine {
  const o = obj(v, 'A payroll line');
  const what = 'A payroll line';
  return {
    id: reqStr(o, 'id', what),
    workerName: str(o.workerName, '', 300),
    workerId: str(o.workerId, '', 100),
    classification: str(o.classification, '', 300),
    apprentice: bool(o.apprentice),
    dailyST: hoursArray(o.dailyST, what),
    dailyOT: hoursArray(o.dailyOT, what),
    totalST: num(o.totalST, what),
    totalOT: num(o.totalOT, what),
    rateST: num(o.rateST, what),
    rateOT: numOrNull(o.rateOT, what),
    fringePlanHourly: num(o.fringePlanHourly ?? 0, what),
    fringeCashHourly: num(o.fringeCashHourly ?? 0, what),
    grossThisProject: numOrNull(o.grossThisProject, what),
    grossAllWork: numOrNull(o.grossAllWork, what),
    deductions: numOrNull(o.deductions, what),
    netPay: numOrNull(o.netPay, what),
  };
}

export function normalizePayroll(v: unknown, projectId: string): Payroll {
  const o = obj(v, 'A payroll');
  const what = 'A payroll';
  const weekEnding = o.weekEnding;
  if (!isIsoDate(weekEnding)) throw new BackupShapeError('A payroll has no valid week ending date.');
  const source = o.source && typeof o.source === 'object' ? (o.source as Obj) : {};
  const lines = list(o.lines ?? [], 'A payroll’s lines');
  if (lines.length > 2000) throw new BackupShapeError('A payroll has too many lines.');
  return {
    id: reqStr(o, 'id', what),
    projectId,
    contractorId: reqStr(o, 'contractorId', what),
    payrollNumber: str(o.payrollNumber, '', 100),
    weekEnding,
    receivedDate: date(o.receivedDate),
    noWork: bool(o.noWork),
    isFinal: bool(o.isFinal),
    supersedesPayrollId: typeof o.supersedesPayrollId === 'string' && o.supersedesPayrollId ? o.supersedesPayrollId : null,
    statementOfComplianceSigned: bool(o.statementOfComplianceSigned),
    source: {
      kind: oneOf(source.kind, ['csv', 'xlsx', 'wh347-pdf', 'manual'] as const, 'manual'),
      fileName: typeof source.fileName === 'string' ? source.fileName.slice(0, 300) : null,
      fileId: typeof source.fileId === 'string' && source.fileId ? source.fileId : null,
    },
    lines: lines.map(normalizeLine),
    status: oneOf(o.status, ['received', 'reviewed', 'correction-requested', 'accepted'] as const, 'received'),
    reviewNote: str(o.reviewNote, '', 5000),
    reviewedAt: typeof o.reviewedAt === 'string' ? o.reviewedAt.slice(0, 40) : null,
    createdAt: str(o.createdAt, '', 40),
    updatedAt: str(o.updatedAt, '', 40),
  };
}

export function normalizeMapping(v: unknown, projectId: string): ClassificationMapping {
  const o = obj(v, 'A job-title match');
  return {
    id: reqStr(o, 'id', 'A job-title match'),
    projectId,
    contractorId: reqStr(o, 'contractorId', 'A job-title match'),
    payrollLabel: str(o.payrollLabel, '', 300),
    classificationKey: reqStr(o, 'classificationKey', 'A job-title match'),
  };
}

export function normalizeRestitution(v: unknown, projectId: string): RestitutionRecord {
  const o = obj(v, 'A restitution record');
  return {
    findingKey: reqStr(o, 'findingKey', 'A restitution record'),
    projectId,
    status: oneOf(o.status, ['owed', 'requested', 'paid', 'verified', 'waived'] as const, 'owed'),
    amountPaid: Math.max(0, num(o.amountPaid ?? 0, 'A restitution record')),
    note: str(o.note, '', 5000),
    updatedAt: str(o.updatedAt, '', 40),
  };
}

export function normalizeDisposition(v: unknown, projectId: string): FindingDisposition {
  const o = obj(v, 'A dismissed finding');
  return {
    findingKey: reqStr(o, 'findingKey', 'A dismissed finding'),
    projectId,
    disposition: 'dismissed',
    note: str(o.note, '', 5000),
    updatedAt: str(o.updatedAt, '', 40),
  };
}

export function normalizeImportProfile(v: unknown, projectId: string): ImportProfile {
  const o = obj(v, 'A spreadsheet layout');
  const map = obj(o.columnMap, 'A spreadsheet layout');
  const columnMap: Record<string, number | number[]> = {};
  for (const [k, value] of Object.entries(map)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000) columnMap[k] = value;
    else if (Array.isArray(value) && value.every((x) => Number.isInteger(x) && x >= 0 && x < 1000)) columnMap[k] = value as number[];
  }
  return {
    id: reqStr(o, 'id', 'A spreadsheet layout'),
    projectId,
    contractorId: reqStr(o, 'contractorId', 'A spreadsheet layout'),
    headerSignature: reqStr(o, 'headerSignature', 'A spreadsheet layout'),
    columnMap: columnMap as ImportProfile['columnMap'],
    updatedAt: str(o.updatedAt, '', 40),
  };
}

export function normalizeActivity(v: unknown, projectId: string): ActivityEntry {
  const o = obj(v, 'An activity entry');
  return {
    id: reqStr(o, 'id', 'An activity entry'),
    projectId,
    at: str(o.at, '', 40),
    action: str(o.action, '', 300),
    detail: str(o.detail, '', 2000),
  };
}

/** A stored file's type is decided from its bytes and name, never taken from the backup. */
export function fileTypeFor(name: string, bytes: Uint8Array): string {
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head === '%PDF-') return 'application/pdf';
  if (/\.xlsx$/i.test(name) && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.(csv|tsv|txt)$/i.test(name)) return 'text/plain';
  return 'application/octet-stream';
}
