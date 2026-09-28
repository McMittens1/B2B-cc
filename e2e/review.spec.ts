import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const WD_TEXT = fs.readFileSync(path.join(import.meta.dirname, '../fixtures/wd/sample-modern.txt'), 'utf8');

/** A payroll register for one electrician paid the fixed fringe but not the 3% part (3%+21.00). */
function registerCsv(weekEnding: string): string {
  return [
    'Test Electric LLC',
    'Payroll Register',
    `Week Ending: ${weekEnding}`,
    'Payroll No. 1',
    '',
    'Employee,SSN (last 4),Work Class,Regular Hours,Overtime Hours,Reg Rate,OT Rate,Hourly Fringe Credit,Gross Pay,Total Deductions,Net Pay',
    '"Quill, Avery",4410,Electrician,40,0,44.00,,21.00,1760.00,387.20,1372.80',
    '',
  ].join('\r\n');
}

async function newProjectWithWd(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /New project|Start a real project/ }).first().click();
  await page.getByPlaceholder('e.g. Main Street Water Line Replacement').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Wage determination', exact: true })).toBeVisible();
  await page.getByLabel('Wage determination text').fill(WD_TEXT);
  await expect(page.getByText('XX20260047 (3/6/2026)')).toBeVisible();
  await page.getByRole('button', { name: 'Save wage determination' }).click();
  await expect(page.getByText('XX20260047 · Modification 2 · 11 classifications', { exact: false })).toBeVisible();
}

test('first run shows how to start, and the demo project is fully populated', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Review certified payrolls without the spreadsheet' })).toBeVisible();
  await expect(page.getByText('Local only — nothing is uploaded')).toBeVisible();

  await page.getByRole('button', { name: 'Open the demo project' }).click();
  await expect(page).toHaveURL(/#\/p\/.+\/overview/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: /Harlow Creek Water Main/ })).toBeVisible();

  // Every intake path produced payrolls, and the checks found the planted problems.
  const violations = page.locator('.kpi').filter({ hasText: 'Open violations' }).locator('.value');
  expect(Number(await violations.textContent())).toBeGreaterThan(5);
  await expect(page.locator('.kpi').filter({ hasText: 'Wages owed' }).locator('.value')).toHaveText(/^\$[\d,]+\.\d\d$/);
  await expect(page.getByRole('table', { name: 'Weekly payroll status by contractor' })).toBeVisible();
  await expect(page.locator('td.cell-missing').first()).toBeVisible();
  await expect(page.getByText(/job titles? on submitted payrolls/)).toBeVisible();

  await page.getByRole('link', { name: /Payrolls/ }).first().click();
  await expect(page.getByRole('cell', { name: 'WH-347 PDF' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /^CSV/ }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /^Excel/ }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('a reviewer imports a payroll register and finds the percentage-fringe shortfall', async ({ page }) => {
  await newProjectWithWd(page, 'E2E Pump Station');

  // Add the contractor.
  await page.getByRole('link', { name: /Contractors/ }).click();
  await page.getByRole('button', { name: /Add contractor/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Contractor name').fill('Test Electric LLC');
  await dialog.getByRole('button', { name: /Save|Add contractor/ }).last().click();
  await expect(page.getByRole('cell', { name: /Test Electric LLC/ }).first()).toBeVisible();

  // Import the CSV exactly as a contractor would email it.
  await page.getByRole('button', { name: 'Add payrolls' }).first().click();
  await page.getByTestId('file-input').setInputFiles({ name: 'Test Electric payroll.csv', mimeType: 'text/csv', buffer: Buffer.from(registerCsv('9/12/2026')) });
  const card = page.locator('.panel').filter({ hasText: 'Test Electric payroll.csv' });
  await expect(card.getByText('1 worker line')).toBeVisible();
  await expect(card.getByLabel('Contractor')).toHaveValue(/.+/); // matched from the business name in the file
  await expect(card.getByLabel('Week ending')).toHaveValue('2026-09-12');
  await card.getByRole('button', { name: 'Save payroll' }).click();
  await card.getByRole('button', { name: /Review it/ }).click();

  // "Electrician" is identical to the WD label, so it is matched automatically.
  await expect(page.getByRole('heading', { name: /Week ending 9\/12\/2026/ })).toBeVisible();
  await expect(page.getByText('fringe short $1.32/hr')).toBeVisible();
  await expect(page.locator('.kpi').filter({ hasText: 'Wages owed on this payroll' }).locator('.value')).toHaveText('$52.80');
  await expect(page.getByText('Fringe is owed on all hours worked: $1.32 × 40 hrs = $52.80.')).toBeVisible();

  // Survives a reload (IndexedDB), and the restitution ledger carries it.
  await page.reload();
  await expect(page.locator('.kpi').filter({ hasText: 'Wages owed on this payroll' }).locator('.value')).toHaveText('$52.80');
  await page.getByRole('link', { name: /Restitution/ }).click();
  await expect(page.locator('.kpi').filter({ hasText: 'Outstanding' }).locator('.value')).toHaveText('$52.80');
});

test('job titles that differ from the WD are matched once and rechecked', async ({ page }) => {
  await newProjectWithWd(page, 'E2E Matching');
  await page.getByRole('button', { name: 'Add payrolls' }).first().click();
  const csv = registerCsv('9/12/2026').replace('4410,Electrician,', '4410,Wireman,');
  await page.getByTestId('file-input').setInputFiles({ name: 'wireman.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const card = page.locator('.panel').filter({ hasText: 'wireman.csv' });
  await card.getByRole('button', { name: /Add "Test Electric LLC" as a contractor/ }).click();
  await card.getByRole('button', { name: 'Save payroll' }).click();
  await card.getByRole('button', { name: /Review it/ }).click();
  await expect(page.getByText('Map "Wireman" to a wage determination classification')).toBeVisible();

  await page.getByLabel('Match Wireman to a WD classification').selectOption({ label: 'ELECTRICIAN ($44.00)' });
  await expect(page.locator('.kpi').filter({ hasText: 'Wages owed on this payroll' }).locator('.value')).toHaveText('$52.80');
});

test('backup, delete and restore round-trips a project', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /demo project/ }).first().click();
  await expect(page).toHaveURL(/overview/, { timeout: 60_000 });
  const owed = await page.locator('.kpi').filter({ hasText: 'Wages owed' }).locator('.value').textContent();
  const violations = await page.locator('.kpi').filter({ hasText: 'Open violations' }).locator('.value').textContent();

  await page.getByRole('link', { name: /Project settings/ }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download backup/ }).click();
  const file = await (await download).path();
  const backup = fs.readFileSync(file!, 'utf8');
  expect(JSON.parse(backup).format).toBe('wagebench-backup');

  // Delete the project (type-to-confirm), then restore it from the file.
  await page.getByRole('button', { name: /Delete project/ }).first().click();
  const name = await page.getByRole('dialog').locator('strong').first().textContent();
  await page.getByRole('dialog').getByRole('textbox').fill(name!.replace(/^"|"$/g, ''));
  await page.getByRole('dialog').getByRole('button', { name: /Delete/ }).last().click();
  await expect(page).toHaveURL(/#\/$/);
  await page.getByTestId('restore-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page).toHaveURL(/overview/);
  await expect(page.locator('.kpi').filter({ hasText: 'Wages owed' }).locator('.value')).toHaveText(owed!);
  await expect(page.locator('.kpi').filter({ hasText: 'Open violations' }).locator('.value')).toHaveText(violations!);
  await page.getByRole('link', { name: /Payrolls/ }).first().click();
  await page.locator('tr.row-bad').filter({ hasText: 'Ridgeline' }).first().click();
  await expect(page.getByRole('link', { name: /\.pdf$/ })).toBeVisible(); // original PDF restored with the backup
});

test('letters, stamped payrolls and exports are generated from the review', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /demo project/ }).first().click();
  await expect(page).toHaveURL(/overview/, { timeout: 60_000 });
  await page.getByRole('link', { name: /Letters & documents/ }).click();
  await expect(page.getByRole('heading', { name: 'Letters & documents' })).toBeVisible();

  // Correction request: preview shows the back-wage table, and both formats download.
  await page.getByRole('row').filter({ hasText: 'Kessler Electric' }).getByRole('button', { name: 'Correction request' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Back wages due', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('cell', { name: '$1,011.92' }).first()).toBeVisible();
  for (const [button, ext, magic] of [['Word', '.docx', 'PK'], ['PDF', '.pdf', '%PDF']] as const) {
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: button, exact: true }).click();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(new RegExp(`Kessler Electric.*\\${ext}$`));
    expect(fs.readFileSync((await d.path())!).subarray(0, magic.length).toString('latin1')).toBe(magic);
  }
  await page.keyboard.press('Escape');

  // A contractor with nothing overdue cannot be sent a missing-payroll letter.
  await expect(page.getByRole('row').filter({ hasText: 'Kessler Electric' }).getByRole('button', { name: 'Missing payrolls' })).toBeDisabled();

  // One stamped payroll, from the contractor's own PDF.
  const stampRow = page.getByRole('table', { name: 'Stamped payrolls' }).getByRole('row').filter({ hasText: 'Ridgeline' }).first();
  const stamped = page.waitForEvent('download');
  await stampRow.getByRole('button', { name: 'PDF' }).click();
  const file = await stamped;
  expect(file.suggestedFilename()).toMatch(/Ridgeline Concrete LLC payroll .* reviewed\.pdf$/);
  const bytes = fs.readFileSync((await file.path())!);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  expect(bytes.length).toBeGreaterThan(50_000); // the original form pages are carried through

  // Restitution ledger as a workbook.
  const ledger = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  expect((await ledger).suggestedFilename()).toMatch(/restitution ledger .*\.xlsx$/);
});

test('bad input is explained, not crashed on', async ({ page }) => {
  await newProjectWithWd(page, 'E2E Bad Files');
  await page.getByRole('button', { name: 'Add payrolls' }).first().click();
  await page.getByTestId('file-input').setInputFiles([
    { name: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('hello,world\nthis,is not a payroll\n') },
    { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n garbage garbage') },
    { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('') },
  ]);
  await expect(page.locator('.panel').filter({ hasText: 'empty.csv' }).getByText('The file is empty.')).toBeVisible();
  await expect(page.locator('.panel').filter({ hasText: 'broken.pdf' }).locator('.alert')).toBeVisible();
  await expect(page.locator('.panel').filter({ hasText: 'notes.csv' }).locator('.alert').first()).toBeVisible();

  // A WD fragment with no rate identifiers is reported instead of saved.
  await page.getByRole('link', { name: /Wage determination/ }).click();
  await page.getByRole('button', { name: 'Replace or update' }).click();
  await page.getByLabel('Wage determination text').fill('This is not a wage determination, just some pasted words about rates and fringes.');
  await expect(page.getByText(/No rate identifiers/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save wage determination' })).toBeDisabled();
});

test('overview fits a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /demo project/ }).first().click();
  await expect(page).toHaveURL(/overview/, { timeout: 60_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('navigation', { name: 'Project sections' })).toBeVisible();
});
