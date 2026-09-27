import { db, newId, nowIso, type ActivityEntry, type ImportProfile, type StoredFile } from './db';
import type {
  ClassificationMapping,
  Contractor,
  FindingDisposition,
  Payroll,
  Project,
  ProjectSettings,
  RestitutionRecord,
  StoredWageDetermination,
} from '../engine/types';
import { parseWageDetermination } from '../engine/wd/parse';
import { normalizeLabel } from '../engine/mapping';

export interface ProjectData {
  project: Project;
  wd: StoredWageDetermination | null;
  contractors: Contractor[];
  payrolls: Payroll[];
  mappings: ClassificationMapping[];
  restitution: RestitutionRecord[];
  dispositions: FindingDisposition[];
  files: Omit<StoredFile, 'data'>[];
  importProfiles: ImportProfile[];
  activity: ActivityEntry[];
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  overtimeRuleApplies: true,
  lateAfterDays: 14,
  arithmeticToleranceDollars: 1,
  executiveOrderMinimumWage: null,
};

export async function listProjects(): Promise<Project[]> {
  const all = await db().projects.toArray();
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function projectCounts(projectId: string) {
  const [payrolls, contractors] = await Promise.all([
    db().payrolls.where('projectId').equals(projectId).count(),
    db().contractors.where('projectId').equals(projectId).count(),
  ]);
  return { payrolls, contractors };
}

export type NewProject = Pick<Project, 'name' | 'projectNumber' | 'location' | 'owner' | 'fundingSource' | 'wdLockDate'> &
  Partial<Pick<Project, 'reviewer' | 'settings'>>;

export async function createProject(input: NewProject): Promise<Project> {
  const now = nowIso();
  const project: Project = {
    id: newId(),
    name: input.name.trim() || 'Untitled project',
    projectNumber: input.projectNumber.trim(),
    location: input.location.trim(),
    owner: input.owner.trim(),
    fundingSource: input.fundingSource,
    wdLockDate: input.wdLockDate,
    reviewer: input.reviewer ?? { name: '', title: '', organization: '', email: '', phone: '' },
    settings: { ...DEFAULT_SETTINGS, ...input.settings },
    createdAt: now,
    updatedAt: now,
  };
  await db().projects.add(project);
  await logActivity(project.id, 'Project created', project.name);
  return project;
}

export async function updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): Promise<void> {
  await db().projects.update(id, { ...patch, updatedAt: nowIso() });
}

async function touch(projectId: string) {
  await db().projects.update(projectId, { updatedAt: nowIso() });
}

export async function deleteProject(id: string): Promise<void> {
  const d = db();
  await d.transaction('rw', [d.projects, d.wds, d.contractors, d.payrolls, d.mappings, d.restitution, d.dispositions, d.files, d.importProfiles, d.activity], async () => {
    await d.projects.delete(id);
    for (const t of [d.wds, d.contractors, d.payrolls, d.mappings, d.files, d.importProfiles, d.activity] as const) {
      await t.where('projectId').equals(id).delete();
    }
    await d.restitution.where('projectId').equals(id).delete();
    await d.dispositions.where('projectId').equals(id).delete();
  });
}

export async function loadProjectData(projectId: string): Promise<ProjectData | null> {
  const d = db();
  const project = await d.projects.get(projectId);
  if (!project) return null;
  const [wds, contractors, payrolls, mappings, restitution, dispositions, files, importProfiles, activity] = await Promise.all([
    d.wds.where('projectId').equals(projectId).toArray(),
    d.contractors.where('projectId').equals(projectId).toArray(),
    d.payrolls.where('projectId').equals(projectId).toArray(),
    d.mappings.where('projectId').equals(projectId).toArray(),
    d.restitution.where('projectId').equals(projectId).toArray(),
    d.dispositions.where('projectId').equals(projectId).toArray(),
    d.files.where('projectId').equals(projectId).toArray(),
    d.importProfiles.where('projectId').equals(projectId).toArray(),
    d.activity.where('projectId').equals(projectId).toArray(),
  ]);
  wds.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  contractors.sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || a.name.localeCompare(b.name));
  payrolls.sort((a, b) => b.weekEnding.localeCompare(a.weekEnding) || a.createdAt.localeCompare(b.createdAt));
  activity.sort((a, b) => b.at.localeCompare(a.at));
  return {
    project,
    wd: wds[0] ?? null,
    contractors,
    payrolls,
    mappings,
    restitution,
    dispositions,
    files: files.map(({ data: _data, ...meta }) => meta),
    importProfiles,
    activity,
  };
}

function tierOrder(t: Contractor['tier']): number {
  return t === 'prime' ? 0 : t === 'subcontractor' ? 1 : 2;
}

// --- Wage determination ------------------------------------------------------

export async function saveWageDetermination(projectId: string, rawText: string): Promise<StoredWageDetermination> {
  const parsed = parseWageDetermination(rawText);
  const d = db();
  const record: StoredWageDetermination = { id: newId(), projectId, rawText, parsed, importedAt: nowIso() };
  await d.transaction('rw', d.wds, d.projects, d.activity, async () => {
    await d.wds.where('projectId').equals(projectId).delete();
    await d.wds.add(record);
    await touch(projectId);
    await logActivity(
      projectId,
      'Wage determination loaded',
      `${parsed.decisionNumber ?? 'Unknown decision'} mod ${parsed.currentModification ?? '?'} — ${parsed.classifications.length} classifications`,
    );
  });
  return record;
}

// --- Contractors ---------------------------------------------------------------

export function blankContractor(projectId: string): Contractor {
  return {
    id: newId(),
    projectId,
    name: '',
    tier: 'subcontractor',
    trade: '',
    startDate: null,
    endDate: null,
    contactName: '',
    contactEmail: '',
    address: '',
    apprenticePrograms: [],
  };
}

export async function saveContractor(c: Contractor): Promise<void> {
  const existing = await db().contractors.get(c.id);
  await db().contractors.put(c);
  await touch(c.projectId);
  await logActivity(c.projectId, existing ? 'Contractor updated' : 'Contractor added', c.name);
}

export async function deleteContractor(c: Contractor): Promise<void> {
  const d = db();
  await d.transaction('rw', [d.contractors, d.payrolls, d.mappings, d.importProfiles, d.projects, d.activity], async () => {
    await d.contractors.delete(c.id);
    await d.payrolls.where('contractorId').equals(c.id).delete();
    await d.mappings.where('contractorId').equals(c.id).delete();
    await d.importProfiles.where('projectId').equals(c.projectId).filter((p) => p.contractorId === c.id).delete();
    await touch(c.projectId);
    await logActivity(c.projectId, 'Contractor removed', c.name);
  });
}

// --- Payrolls -------------------------------------------------------------------

export async function savePayroll(payroll: Payroll, file?: { name: string; type: string; data: Blob }): Promise<Payroll> {
  const d = db();
  let toSave = { ...payroll, updatedAt: nowIso() };
  await d.transaction('rw', [d.payrolls, d.files, d.projects, d.activity], async () => {
    if (file) {
      const stored: StoredFile = {
        id: newId(),
        projectId: payroll.projectId,
        name: file.name,
        type: file.type,
        size: file.data.size,
        data: file.data,
        addedAt: nowIso(),
      };
      await d.files.add(stored);
      toSave = { ...toSave, source: { ...toSave.source, fileId: stored.id, fileName: file.name } };
    }
    const existing = await d.payrolls.get(payroll.id);
    await d.payrolls.put(toSave);
    await touch(payroll.projectId);
    if (!existing) {
      await logActivity(
        payroll.projectId,
        'Payroll added',
        `Payroll ${toSave.payrollNumber || '(no number)'} week ending ${toSave.weekEnding}${file ? ` from ${file.name}` : ''}`,
      );
    }
  });
  return toSave;
}

export async function setPayrollStatus(payroll: Payroll, status: Payroll['status'], note?: string): Promise<void> {
  const patch: Partial<Payroll> = { status, updatedAt: nowIso() };
  if (status === 'reviewed' || status === 'accepted' || status === 'correction-requested') patch.reviewedAt = nowIso();
  if (note !== undefined) patch.reviewNote = note;
  await db().payrolls.update(payroll.id, patch);
  await touch(payroll.projectId);
  await logActivity(payroll.projectId, `Payroll marked ${status.replace('-', ' ')}`, `Payroll ${payroll.payrollNumber || '(no number)'} week ending ${payroll.weekEnding}`);
}

export async function deletePayroll(payroll: Payroll): Promise<void> {
  const d = db();
  await d.transaction('rw', [d.payrolls, d.files, d.projects, d.activity], async () => {
    await d.payrolls.delete(payroll.id);
    if (payroll.source.fileId) {
      const stillUsed = await d.payrolls.filter((p) => p.source.fileId === payroll.source.fileId).count();
      if (stillUsed === 0) await d.files.delete(payroll.source.fileId);
    }
    await touch(payroll.projectId);
    await logActivity(payroll.projectId, 'Payroll deleted', `Payroll ${payroll.payrollNumber || '(no number)'} week ending ${payroll.weekEnding}`);
  });
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  return db().files.get(id);
}

// --- Mappings, restitution, dispositions ---------------------------------------------

export async function setMapping(projectId: string, contractorId: string, payrollLabel: string, classificationKey: string | null): Promise<void> {
  const d = db();
  const label = normalizeLabel(payrollLabel);
  const existing = await d.mappings.where('contractorId').equals(contractorId).filter((m) => m.payrollLabel === label).first();
  if (classificationKey === null) {
    if (existing) await d.mappings.delete(existing.id);
  } else {
    await d.mappings.put({ id: existing?.id ?? newId(), projectId, contractorId, payrollLabel: label, classificationKey });
  }
  await touch(projectId);
}

export async function setRestitution(record: Omit<RestitutionRecord, 'updatedAt'>, logDetail?: string): Promise<void> {
  await db().restitution.put({ ...record, updatedAt: nowIso() });
  await touch(record.projectId);
  if (logDetail) await logActivity(record.projectId, `Restitution ${record.status}`, logDetail);
}

export async function setDisposition(projectId: string, findingKey: string, dismissed: boolean, note = ''): Promise<void> {
  if (dismissed) {
    await db().dispositions.put({ findingKey, projectId, disposition: 'dismissed', note, updatedAt: nowIso() });
  } else {
    await db().dispositions.delete(findingKey);
  }
  await touch(projectId);
}

export async function saveImportProfile(projectId: string, contractorId: string, headerSignature: string, columnMap: Record<string, number>): Promise<void> {
  const d = db();
  const existing = await d.importProfiles.where('[contractorId+headerSignature]').equals([contractorId, headerSignature]).first();
  await d.importProfiles.put({ id: existing?.id ?? newId(), projectId, contractorId, headerSignature, columnMap, updatedAt: nowIso() });
}

export async function logActivity(projectId: string, action: string, detail: string): Promise<void> {
  await db().activity.add({ id: newId(), projectId, at: nowIso(), action, detail });
}
