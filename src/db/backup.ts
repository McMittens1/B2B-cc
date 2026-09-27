import { db, type StoredFile } from './db';
import { logActivity } from './repo';
import type { Project } from '../engine/types';

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

/** Restore a backup, replacing any existing copy of the same project. Returns the project. */
export async function restoreProjectBackup(json: string): Promise<Project> {
  let doc: BackupDocument;
  try {
    doc = JSON.parse(json) as BackupDocument;
  } catch {
    throw new BackupError('This file is not a Wagebench backup (it is not valid JSON).');
  }
  if (doc?.format !== BACKUP_FORMAT || typeof doc.version !== 'number' || !doc.project?.id) {
    throw new BackupError('This file is not a Wagebench backup.');
  }
  if (doc.version > BACKUP_VERSION) {
    throw new BackupError('This backup was made by a newer version of Wagebench.');
  }
  const t = doc.tables;
  const arrays = [t.wds, t.contractors, t.payrolls, t.mappings, t.restitution, t.dispositions, t.importProfiles, t.activity, doc.files];
  if (!arrays.every(Array.isArray)) throw new BackupError('The backup is incomplete or damaged.');
  const projectId = doc.project.id;
  const belongs = (rows: unknown[]) => rows.every((r) => (r as { projectId?: string }).projectId === projectId);
  if (!arrays.every(belongs)) throw new BackupError('The backup contains records from another project.');

  const d = db();
  await d.transaction('rw', [d.projects, d.wds, d.contractors, d.payrolls, d.mappings, d.restitution, d.dispositions, d.files, d.importProfiles, d.activity], async () => {
    for (const table of [d.wds, d.contractors, d.payrolls, d.mappings, d.files, d.importProfiles, d.activity, d.restitution, d.dispositions] as const) {
      await table.where('projectId').equals(projectId).delete();
    }
    await d.projects.put(doc.project);
    await d.wds.bulkPut(t.wds as never[]);
    await d.contractors.bulkPut(t.contractors as never[]);
    await d.payrolls.bulkPut(t.payrolls as never[]);
    await d.mappings.bulkPut(t.mappings as never[]);
    await d.restitution.bulkPut(t.restitution as never[]);
    await d.dispositions.bulkPut(t.dispositions as never[]);
    await d.importProfiles.bulkPut(t.importProfiles as never[]);
    await d.activity.bulkPut(t.activity as never[]);
    for (const f of doc.files) {
      const { dataBase64, ...meta } = f;
      const bytes = base64ToBytes(dataBase64);
      await d.files.put({ ...meta, data: new Blob([bytes as BlobPart], { type: meta.type }) });
    }
  });
  await logActivity(projectId, 'Backup restored', `Backup from ${doc.exportedAt}`);
  return doc.project;
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
