import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { WagebenchDB, db, setDb } from '../src/db/db';
import { backupToBlob, exportProjectBackup, readBackup, restoreProjectBackup, BackupError } from '../src/db/backup';
import { blankContractor, createProject, saveContractor, savePayroll, saveWageDetermination } from '../src/db/repo';
import type { Payroll } from '../src/engine/types';

let n = 0;
beforeEach(() => {
  setDb(new WagebenchDB(`backup-test-${++n}`));
});

async function seedProject(name: string) {
  const project = await createProject({ name, projectNumber: '', location: '', owner: '', fundingSource: 'CDBG', wdLockDate: null });
  await saveWageDetermination(project.id, fs.readFileSync('fixtures/wd/sample-modern.txt', 'utf8'));
  const c = { ...blankContractor(project.id), name: 'Ridgeline Concrete LLC' };
  await saveContractor(c);
  const payroll: Payroll = {
    id: `pay-${name}`,
    projectId: project.id,
    contractorId: c.id,
    payrollNumber: '1',
    weekEnding: '2026-07-11',
    receivedDate: '2026-07-15',
    noWork: false,
    isFinal: false,
    supersedesPayrollId: null,
    statementOfComplianceSigned: true,
    source: { kind: 'wh347-pdf', fileName: 'p.pdf', fileId: null },
    lines: [
      {
        id: `line-${name}`,
        workerName: 'Javier Ruiz',
        workerId: '3021',
        classification: 'Laborer',
        apprentice: false,
        dailyST: [0, 8, 8, 8, 8, 8, 0],
        dailyOT: [0, 0, 0, 0, 0, 0, 0],
        totalST: 40,
        totalOT: 0,
        rateST: 24.1,
        rateOT: null,
        fringePlanHourly: 12.4,
        fringeCashHourly: 0,
        grossThisProject: 964,
        grossAllWork: 964,
        deductions: 200,
        netPay: 764,
      },
    ],
    status: 'received',
    reviewNote: '',
    reviewedAt: null,
    createdAt: '',
    updatedAt: '',
  };
  await savePayroll(payroll, { name: 'p.pdf', type: 'application/pdf', data: new Blob([new TextEncoder().encode('%PDF-1.7\n%fake\n')]) });
  return project;
}

async function backupText(projectId: string): Promise<string> {
  return backupToBlob(await exportProjectBackup(projectId)).text();
}

describe('project backups', () => {
  it('round-trips a project, including its stored files, through the streamed JSON', async () => {
    const project = await seedProject('A');
    const text = await backupText(project.id);
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe('wagebench-backup');
    expect(parsed.files).toHaveLength(1);

    await db().payrolls.clear();
    await db().files.clear();
    await restoreProjectBackup(text);
    const payrolls = await db().payrolls.where('projectId').equals(project.id).toArray();
    expect(payrolls).toHaveLength(1);
    expect(payrolls[0]!.lines[0]!.rateST).toBe(24.1);
    const files = await db().files.where('projectId').equals(project.id).toArray();
    expect(files).toHaveLength(1);
    expect(files[0]!.type).toBe('application/pdf');
  });

  it('refuses a backup whose records would overwrite another project', async () => {
    const victim = await seedProject('Victim');
    const attacker = await seedProject('Attacker');
    const doc = JSON.parse(await backupText(attacker.id));
    // Reuse the victim's payroll id under the attacker's project.
    doc.tables.payrolls[0].id = 'pay-Victim';
    await expect(restoreProjectBackup(JSON.stringify(doc))).rejects.toThrow(/belong to another project/);
    const victims = await db().payrolls.where('projectId').equals(victim.id).toArray();
    expect(victims.map((p) => p.id)).toEqual(['pay-Victim']);
  });

  it('fills in missing optional project fields instead of storing a broken project', async () => {
    const project = await seedProject('B');
    const doc = JSON.parse(await backupText(project.id));
    doc.project = { id: project.id, name: 'Bare project' };
    const restored = await restoreProjectBackup(JSON.stringify(doc));
    expect(restored.settings.lateAfterDays).toBeGreaterThan(0);
    expect(restored.reviewer.name).toBe('');
    expect(typeof restored.updatedAt).toBe('string');
  });

  it('rejects damaged records with a readable reason and writes nothing', async () => {
    const project = await seedProject('C');
    const doc = JSON.parse(await backupText(project.id));
    doc.tables.payrolls[0].lines[0].rateST = 'lots';
    await db().payrolls.clear();
    expect(() => readBackup(JSON.stringify(doc))).toThrow(BackupError);
    await expect(restoreProjectBackup(JSON.stringify(doc))).rejects.toThrow(/damaged: A payroll line is not a number/);
    expect(await db().payrolls.count()).toBe(0);
  });

  it('decides a stored file type from its bytes, never from the backup', async () => {
    const project = await seedProject('D');
    const doc = JSON.parse(await backupText(project.id));
    doc.files[0].type = 'text/html';
    doc.files[0].dataBase64 = btoa('<html><script>alert(1)</script></html>');
    const b = readBackup(JSON.stringify(doc));
    expect(b.files[0]!.type).toBe('application/octet-stream');
  });

  it('re-reads the wage determination from its text', async () => {
    const project = await seedProject('E');
    const doc = JSON.parse(await backupText(project.id));
    doc.tables.wds[0].parsed.classifications = [{ key: 'FAKE#1', baseRate: 1 }];
    const b = readBackup(JSON.stringify(doc));
    expect(b.wds[0]!.parsed.classifications.length).toBeGreaterThan(5);
  });
});
