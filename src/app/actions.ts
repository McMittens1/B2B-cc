import { PDFDocument } from 'pdf-lib';
import { getFile } from '../db/repo';
import { findingsToCsv, ledgerToXlsx } from '../engine/docs/exports';
import {
  LETTER_KIND_LABELS,
  composeLetter,
  letterPayrollSummaries,
  letterToDocx,
  letterToPdf,
  letterToText,
  type Letter,
  type LetterKind,
} from '../engine/docs/letters';
import { buildStampedPayroll, type StampedPayroll } from '../engine/docs/stamp';
import type { Finding, Payroll } from '../engine/types';
import type { ProjectView } from './store';
import { downloadFile, openBlob, safeFileName } from './ui';

export type LetterFormat = 'docx' | 'pdf' | 'text';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function isPdfFile(file: { name: string; type: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function wdOf(view: ProjectView) {
  const wd = view.data.wd?.parsed ?? null;
  return { wdNumber: wd?.decisionNumber ?? null, wdModification: wd?.currentModification ?? null };
}

/** Findings the reviewer has not dismissed, including those on payrolls replaced by a correction. */
function allOpenFindings(view: ProjectView): Finding[] {
  return [...view.openFindings, ...view.evaluation.historicalFindings.filter((f) => !view.dismissed.has(f.key))];
}

/** The reviewer's copy of a payroll: the original PDF stamped, plus the review worksheet. */
export async function stampPayroll(view: ProjectView, payroll: Payroll): Promise<StampedPayroll> {
  const contractor = view.contractorById.get(payroll.contractorId);
  if (!contractor) throw new Error('The contractor for this payroll no longer exists.');
  let original: Uint8Array | null = null;
  // Stamp the contractor's own PDF when there is one (including a scan that was keyed in by hand).
  if (payroll.source.fileId) {
    const file = await getFile(payroll.source.fileId);
    if (file && isPdfFile(file)) original = new Uint8Array(await file.data.arrayBuffer());
  }
  return buildStampedPayroll(original, {
    project: view.data.project,
    ...wdOf(view),
    contractor,
    payroll,
    findings: allOpenFindings(view),
    reviewer: view.data.project.reviewer,
    reviewedOn: payroll.reviewedAt?.slice(0, 10) ?? view.asOf,
    lineAnalyses: view.evaluation.lines,
  });
}

export function stampedFileName(view: ProjectView, payroll: Payroll): string {
  const contractor = view.contractorById.get(payroll.contractorId)?.name ?? 'Contractor';
  const number = payroll.payrollNumber ? ` no ${payroll.payrollNumber}` : '';
  return `${safeFileName(`${contractor} payroll${number} WE ${payroll.weekEnding} reviewed`)}.pdf`;
}

/** Download the stamped payroll. Returns a note when the original PDF could not be used. */
export async function downloadStampedPayroll(view: ProjectView, payroll: Payroll): Promise<string | null> {
  const stamped = await stampPayroll(view, payroll);
  downloadFile(stampedFileName(view, payroll), stamped.bytes, 'application/pdf');
  return stamped.originalProblem;
}

/**
 * Open a file the contractor submitted, as stored with the payroll. Only real PDFs (checked
 * by their first bytes) open in a tab, and always as a PDF; anything else is downloaded, so
 * a file can never be shown as a web page on the app's origin.
 */
export async function openStoredFile(fileId: string): Promise<void> {
  const file = await getFile(fileId);
  if (!file) throw new Error('The original file is not stored with this project.');
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') openBlob(bytes, 'application/pdf');
  else downloadFile(file.name, bytes, 'application/octet-stream');
}

/** Draft a letter or memo from the current review results. `contractorId` is null for the project memo. */
export function draftLetter(view: ProjectView, kind: LetterKind, contractorId: string | null): Letter {
  const { data, evaluation } = view;
  const contractor = contractorId ? (view.contractorById.get(contractorId) ?? null) : null;
  if (contractorId && !contractor) throw new Error('That contractor no longer exists.');
  const mine = (f: Finding) => !contractorId || f.contractorId === contractorId;
  return composeLetter(kind, {
    project: data.project,
    contractor,
    contractors: data.contractors,
    date: view.asOf,
    findings: allOpenFindings(view).filter(mine),
    ledgerRows: view.ledger.rows.filter((r) => mine(r.finding)),
    payrolls: letterPayrollSummaries(
      data.payrolls.filter((p) => !contractorId || p.contractorId === contractorId),
      evaluation.payrolls,
    ),
    ...wdOf(view),
  });
}

export function letterFileName(view: ProjectView, kind: LetterKind, contractorId: string | null, ext: string): string {
  const who = contractorId ? (view.contractorById.get(contractorId)?.name ?? 'Contractor') : view.data.project.name;
  return `${safeFileName(`${LETTER_KIND_LABELS[kind]} ${who} ${view.asOf}`)}.${ext}`;
}

export async function downloadLetter(view: ProjectView, kind: LetterKind, contractorId: string | null, format: LetterFormat): Promise<void> {
  const letter = draftLetter(view, kind, contractorId);
  if (format === 'docx') downloadFile(letterFileName(view, kind, contractorId, 'docx'), await letterToDocx(letter), DOCX_TYPE);
  else if (format === 'pdf') downloadFile(letterFileName(view, kind, contractorId, 'pdf'), await letterToPdf(letter), 'application/pdf');
  else downloadFile(letterFileName(view, kind, contractorId, 'txt'), letterToText(letter), 'text/plain;charset=utf-8');
}

export async function downloadLedgerWorkbook(view: ProjectView): Promise<void> {
  const bytes = await ledgerToXlsx(view.ledger.rows);
  downloadFile(`${safeFileName(`${view.data.project.name} restitution ledger ${view.asOf}`)}.xlsx`, bytes, XLSX_TYPE);
}

export function downloadFindingsCsv(view: ProjectView, includeDismissed: boolean): void {
  const findings = includeDismissed
    ? [...view.evaluation.findings, ...view.evaluation.historicalFindings]
    : allOpenFindings(view);
  const names = new Map(view.data.contractors.map((c) => [c.id, c.name]));
  downloadFile(`${safeFileName(`${view.data.project.name} findings ${view.asOf}`)}.csv`, findingsToCsv(findings, names), 'text/csv;charset=utf-8');
}

/** Several stamped payrolls as one PDF, in the order given. Returns notes for originals that could not be used. */
export async function downloadStampedBundle(view: ProjectView, payrolls: readonly Payroll[], label: string): Promise<string[]> {
  const bundle = await PDFDocument.create();
  const problems: string[] = [];
  for (const payroll of payrolls) {
    const stamped = await stampPayroll(view, payroll);
    if (stamped.originalProblem) problems.push(`${stampedFileName(view, payroll)}: ${stamped.originalProblem}`);
    const doc = await PDFDocument.load(stamped.bytes);
    for (const page of await bundle.copyPages(doc, doc.getPageIndices())) bundle.addPage(page);
  }
  bundle.setTitle(`Stamped payrolls: ${label}`);
  bundle.setCreator('Wagebench');
  bundle.setProducer('Wagebench');
  downloadFile(`${safeFileName(`${label} stamped payrolls ${view.asOf}`)}.pdf`, await bundle.save(), 'application/pdf');
  return problems;
}
