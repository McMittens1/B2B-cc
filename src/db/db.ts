import Dexie, { type Table } from 'dexie';
import type {
  ClassificationMapping,
  Contractor,
  FindingDisposition,
  Payroll,
  Project,
  RestitutionRecord,
  StoredWageDetermination,
} from '../engine/types';

/** An original file a contractor sent (PDF, CSV, XLSX), kept so the review can be stamped and audited. */
export interface StoredFile {
  id: string;
  projectId: string;
  name: string;
  type: string;
  size: number;
  data: Blob;
  addedAt: string;
}

/** Remembered column mapping for a contractor's spreadsheet layout. */
export interface ImportProfile {
  id: string;
  projectId: string;
  contractorId: string;
  headerSignature: string;
  columnMap: Record<string, number>;
  updatedAt: string;
}

export interface ActivityEntry {
  id: string;
  projectId: string;
  at: string;
  action: string;
  detail: string;
}

export class WagebenchDB extends Dexie {
  projects!: Table<Project, string>;
  wds!: Table<StoredWageDetermination, string>;
  contractors!: Table<Contractor, string>;
  payrolls!: Table<Payroll, string>;
  mappings!: Table<ClassificationMapping, string>;
  restitution!: Table<RestitutionRecord, string>;
  dispositions!: Table<FindingDisposition, string>;
  files!: Table<StoredFile, string>;
  importProfiles!: Table<ImportProfile, string>;
  activity!: Table<ActivityEntry, string>;

  constructor(name = 'wagebench') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt',
      wds: 'id, projectId',
      contractors: 'id, projectId',
      payrolls: 'id, projectId, contractorId, weekEnding',
      mappings: 'id, projectId, contractorId',
      restitution: 'findingKey, projectId',
      dispositions: 'findingKey, projectId',
      files: 'id, projectId',
      importProfiles: 'id, projectId, [contractorId+headerSignature]',
      activity: 'id, projectId, at',
    });
  }
}

let instance: WagebenchDB | null = null;

export function db(): WagebenchDB {
  if (!instance) instance = new WagebenchDB();
  return instance;
}

/** For tests: swap in a database backed by fake-indexeddb. */
export function setDb(next: WagebenchDB): void {
  instance = next;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
