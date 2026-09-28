import type { Table } from 'dexie';
import { db, type ActivityEntry, type ImportProfile, type StoredFile } from './db';
import { DEFAULT_SETTINGS, logActivity } from './repo';
import type {
  ClassificationMapping,
  Contractor,
  FindingDisposition,
  Payroll,
  Project,
  RestitutionRecord,
  StoredWageDetermination,
} from '../engine/types';
import {
  BackupShapeError,
  fileTypeFor,
  normalizeActivity,
  normalizeContractor,
  normalizeDisposition,
  normalizeImportProfile,
  normalizeMapping,
  normalizePayroll,
  normalizeProject,
  normalizeRestitution,
  normalizeWd,
} from './backup-validate';

/**
 * Project backups. Everything Wagebench knows lives in this browser's IndexedDB, so a
 * reviewer must be able to take a complete, portable copy (including the original
 * payroll files) and restore it on another machine.
 */

export const BACKUP_FORMAT = 'wagebench-backup';
export const BACKUP_VERSION = 1;

interface BackupFile extends Omit<StoredFile, 'data'> {
  dataBase64: string;
}

export interface BackupDocument {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  project: Project;
  tables: {
    wds: unknown[];
    contractors: unknown[];
    payrolls: unknown[];
    mappings: unknown[];
    restitution: unknown[];
    dispositions: unknown[];
    importProfiles: unknown[];
    activity: unknown[];
  };
  files: BackupFile[];
}

export async function exportProjectBackup(projectId: string): Promise<BackupDocument> {
  const d = db();
  const project = await d.projects.get(projectId);
  if (!project) throw new Error('Project not found');
  const by = <T>(t: { where(i: string): { equals(v: string): { toArray(): Promise<T[]> } } }) =>
    t.where('projectId').equals(projectId).toArray();
  const [wds, contractors, payrolls, mappings, restitution, dispositions, importProfiles, activity, files] = await Promise.all([
    by(d.wds),
    by(d.contractors),
    by(d.payrolls),
    by(d.mappings),
    by(d.restitution),
    by(d.dispositions),
    by(d.importProfiles),
    by(d.activity),
    by<StoredFile>(d.files),
  ]);
  const encoded: BackupFile[] = [];
  for (const f of files) {
    const { data, ...meta } = f;
    encoded.push({ ...meta, dataBase64: bytesToBase64(new Uint8Array(await data.arrayBuffer())) });
  }
  await logActivity(projectId, 'Backup exported', `${payrolls.length} payrolls, ${files.length} files`);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    project,
    tables: { wds, contractors, payrolls, mappings, restitution, dispositions, importProfiles, activity },
    files: encoded,
  };
}

export class BackupError extends Error {}

/**
 * The backup as one Blob, written piece by piece: a single JSON string of a large project
 * (hundreds of PDFs) would exceed the browser's maximum string length.
 */
export function backupToBlob(doc: BackupDocument): Blob {
  const { files, ...rest } = doc;
  const head = JSON.stringify({ ...rest, files: [] });
  // `head` ends with "files":[]} (files is the last key); reopen the array and stream the files into it.
  const parts: BlobPart[] = [head.slice(0, -2)];
  files.forEach((f, i) => parts.push(i === 0 ? '' : ',', JSON.stringify(f)));
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

/** Largest backup file that can be read back (the browser must hold it as one string). */
export const MAX_BACKUP_BYTES = 400 * 1024 * 1024;

/** A backup that has been parsed and checked, ready to write. */
export interface ValidatedBackup {
  exportedAt: string;
  project: Project;
  wds: StoredWageDetermination[];
  contractors: Contractor[];
  payrolls: Payroll[];
  mappings: ClassificationMapping[];
  restitution: RestitutionRecord[];
  dispositions: FindingDisposition[];
  importProfiles: ImportProfile[];
  activity: ActivityEntry[];
  files: StoredFile[];
}

/** Parse and check a backup file without writing anything. Throws BackupError with a reviewer-readable reason. */
export function readBackup(json: string): ValidatedBackup {
  let doc: BackupDocument;
  try {
    doc = JSON.parse(json) as BackupDocument;
  } catch {
    throw new BackupError('This file is not a Wagebench backup (it is not valid JSON).');
  }
  if (!doc || typeof doc !== 'object' || doc.format !== BACKUP_FORMAT || typeof doc.version !== 'number' || !doc.project || typeof doc.project !== 'object') {
    throw new BackupError('This file is not a Wagebench backup.');
  }
  if (doc.version > BACKUP_VERSION) {
    throw new BackupError('This backup was made by a newer version of Wagebench.');
  }
  const t = doc.tables;
  if (!t || typeof t !== 'object') throw new BackupError('The backup is incomplete or damaged.');
  const arrays = [t.wds, t.contractors, t.payrolls, t.mappings, t.restitution, t.dispositions, t.importProfiles, t.activity, doc.files];
  if (!arrays.every(Array.isArray)) throw new BackupError('The backup is incomplete or damaged.');
  const projectId = (doc.project as { id?: unknown }).id;
  const belongs = (rows: unknown[]) => rows.every((r) => !!r && typeof r === 'object' && (r as { projectId?: unknown }).projectId === projectId);
  if (typeof projectId !== 'string' || !arrays.every(belongs)) throw new BackupError('The backup contains records from another project.');

  try {
    const project = normalizeProject(doc.project, DEFAULT_SETTINGS);
    const files: StoredFile[] = doc.files.map((raw) => {
      const f = raw as Partial<BackupFile>;
      if (typeof f.id !== 'string' || !f.id || typeof f.dataBase64 !== 'string') throw new BackupShapeError('A stored file is damaged.');
      const name = typeof f.name === 'string' ? f.name.slice(0, 300) : 'file';
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(f.dataBase64);
      } catch {
        throw new BackupShapeError(`The stored file "${name}" is damaged.`);
      }
      const type = fileTypeFor(name, bytes);
      return { id: f.id, projectId, name, type, size: bytes.length, data: new Blob([bytes as BlobPart], { type }), addedAt: typeof f.addedAt === 'string' ? f.addedAt : '' };
    });
    return {
      exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : '',
      project,
      wds: t.wds.map((r) => normalizeWd(r, projectId)),
      contractors: t.contractors.map((r) => normalizeContractor(r, projectId)),
      payrolls: t.payrolls.map((r) => normalizePayroll(r, projectId)),
      mappings: t.mappings.map((r) => normalizeMapping(r, projectId)),
      restitution: t.restitution.map((r) => normalizeRestitution(r, projectId)),
      dispositions: t.dispositions.map((r) => normalizeDisposition(r, projectId)),
      importProfiles: t.importProfiles.map((r) => normalizeImportProfile(r, projectId)),
      activity: t.activity.map((r) => normalizeActivity(r, projectId)),
      files,
    };
  } catch (e) {
    if (e instanceof BackupShapeError) throw new BackupError(`The backup is damaged: ${e.message}`);
    throw e;
  }
}

/** The project in this browser that a backup would replace, if any. */
export async function existingCopy(backup: ValidatedBackup): Promise<Project | null> {
  return (await db().projects.get(backup.project.id)) ?? null;
}

/**
 * Restore a backup, replacing any existing copy of the same project. Returns the project.
 * Nothing is written if any record would overwrite a record that belongs to another project.
 */
export async function restoreProjectBackup(input: string | ValidatedBackup): Promise<Project> {
  const b = typeof input === 'string' ? readBackup(input) : input;
  const projectId = b.project.id;
  const d = db();
  await d.transaction('rw', [d.projects, d.wds, d.contractors, d.payrolls, d.mappings, d.restitution, d.dispositions, d.files, d.importProfiles, d.activity], async () => {
    const guard = async <T extends { projectId: string }>(table: Table<T, string>, keys: string[]) => {
      if (new Set(keys).size !== keys.length) throw new BackupError('The backup is damaged: it contains duplicate records.');
      const existing = await table.bulkGet(keys);
      if (existing.some((row) => row && row.projectId !== projectId)) {
        throw new BackupError('The backup contains records that belong to another project in this browser. Nothing was restored.');
      }
    };
    await guard(d.wds, b.wds.map((r) => r.id));
    await guard(d.contractors, b.contractors.map((r) => r.id));
    await guard(d.payrolls, b.payrolls.map((r) => r.id));
    await guard(d.mappings, b.mappings.map((r) => r.id));
    await guard(d.restitution, b.restitution.map((r) => r.findingKey));
    await guard(d.dispositions, b.dispositions.map((r) => r.findingKey));
    await guard(d.importProfiles, b.importProfiles.map((r) => r.id));
    await guard(d.activity, b.activity.map((r) => r.id));
    await guard(d.files, b.files.map((r) => r.id));

    for (const table of [d.wds, d.contractors, d.payrolls, d.mappings, d.files, d.importProfiles, d.activity, d.restitution, d.dispositions] as const) {
      await table.where('projectId').equals(projectId).delete();
    }
    await d.projects.put(b.project);
    await d.wds.bulkPut(b.wds);
    await d.contractors.bulkPut(b.contractors);
    await d.payrolls.bulkPut(b.payrolls);
    await d.mappings.bulkPut(b.mappings);
    await d.restitution.bulkPut(b.restitution);
    await d.dispositions.bulkPut(b.dispositions);
    await d.importProfiles.bulkPut(b.importProfiles);
    await d.activity.bulkPut(b.activity);
    await d.files.bulkPut(b.files);
  });
  await logActivity(projectId, 'Backup restored', b.exportedAt ? `Backup from ${b.exportedAt}` : 'Backup restored');
  return b.project;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
