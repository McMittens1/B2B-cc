# Payroll spreadsheet fixtures

All files here are **demonstration data written for Wagebench**. Companies, workers,
identifying numbers and projects are fictional, and the arithmetic (gross, FICA,
deductions, net) is internally consistent so the compliance checks have something real
to verify. Never use them for a real project.

- `quickbooks-register.csv`: a payroll register with a company name, report title and
  date range above the header, "Last, First M" names, an apprentice written into the
  classification, deduction components plus a total, and a `Total` row.
- `gusto-payroll.csv`: first and last name in separate columns, a pay-period-end column,
  regular and overtime **earnings** but no rate columns (rates are derived), and
  employee taxes and deductions as two columns to be summed.
- `adp-export.csv`: `File #` identifiers with leading zeros, `O/T` wording, federal /
  Social Security / Medicare / state / local / union dues / 401(k) columns and no total
  deductions, a header row repeated mid-file (page break) and a `Company Totals` row.
- `wh347-2008-layout.csv`: the 2008 WH-347 typed into a spreadsheet: title lines with
  contractor, payroll number, week ending and project; a two-row header ("Gross amount
  earned" over "This project | All work", "Deductions" over "FICA | Withholding tax |
  Other | Total deductions"); daily hours by weekday and date; each worker on an "O" row
  and an "S" row (either order) with the identifying number on the second row; and an
  unlabeled totals row.
- `wh347-2025-layout.csv`: the Rev. January 2025 WH-347 fields in one row per worker:
  J/A column, straight-time and overtime hours for each weekday, 6A/6B/6C rates and
  fringes, 7A/7B gross amounts.

XLSX versions are generated from these files inside `tests/importers-files.test.ts` with
write-excel-file, so no binary workbooks are committed.
