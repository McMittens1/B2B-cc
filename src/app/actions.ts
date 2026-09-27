// Placeholder: replaced when the review-docs module is integrated.
import type { Payroll } from '../engine/types';
import type { ProjectView } from './store';
export type LetterFormat = 'docx' | 'pdf' | 'text';
export async function downloadStampedPayroll(_view: ProjectView, _payroll: Payroll): Promise<void> {
  throw new Error('Not available yet');
}
export async function openStoredFile(_fileId: string): Promise<void> {
  throw new Error('Not available yet');
}
export async function downloadLetter(_view: ProjectView, _kind: string, _contractorId: string | null, _format: LetterFormat): Promise<void> {
  throw new Error('Not available yet');
}
