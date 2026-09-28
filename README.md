# Wagebench

**A review desk for Davis-Bacon certified payrolls.** Paste the project's wage determination, drop in the weekly payrolls your contractors email you, and Wagebench checks every worker line against the wage determination. You get:

- the underpayments in dollars
- the weeks that are missing
- a restitution ledger
- correction letters
- a review notation stamped on the payroll for your file

It is built for the people who **review** other companies' payrolls on federally funded construction: grant administrators and Labor Standards Officers (CDBG, CDBG-DR, HOME, EPA SRF, USDA RD, EDA…), grant-administration and labor-compliance consultants, consulting engineers doing construction administration, and prime contractors responsible for their subcontractors.

It needs no portal and asks nothing of your contractors. They keep emailing what they already produce.

> Everything runs in your browser. There is no server and no account, and nothing is uploaded. Payroll data stays in the browser's local database on your machine, and the production build blocks all outbound network connections.

## Quick start

Requirements: Node.js 22.13 or newer, and npm. (`.nvmrc` pins 22.)

```bash
git clone <this repository>
cd <repository folder>
npm install
npm run dev
```

Open http://localhost:5173 and click **Open the demo project**. It builds a fictional water-main project (a prime and three subcontractors, ten weeks) by pushing real WH-347 PDFs, CSV exports and spreadsheets through the same importers you would use. It contains planted problems for Wagebench to find.

To run the production build (what you would host or hand to colleagues):

```bash
npm run build
npm run preview        # serves dist/ at http://localhost:4173
```

`dist/` is a static site. It can be served from any web server or internal file host. Each browser keeps its own projects, so use **Project settings → Download backup** to move or share one.

## The review workflow

1. **New project** → enter the contract, funding source and the date the wage determination was locked in.
2. **Wage determination** → paste the general decision text from SAM.gov, or load the .txt or .pdf. Wagebench reads every classification, basic rate and fringe, including grouped classifications ("LABORER — GROUP 2" with its group definitions), percentage fringes ("3%+21.00"), footnotes, per-day rates, "**" Executive Order markers and county scopes. It warns if a modification was published after your lock date.
3. **Contractors** → the prime and each subcontractor, with start dates (so missing weeks are detected) and any registered apprenticeship programs (wage %, fringe %, ratio).
4. **Add payrolls** → drop in files as received:
   - **WH-347 PDFs** (Rev. January 2025) produced by payroll software or DOL's online form. They are read automatically; anything uncertain is flagged for you to confirm.
   - **CSV or Excel (.xlsx)** exports from payroll systems (QuickBooks-, Gusto-, ADP-style registers, or the WH-347 layout). Columns are detected; once you confirm a layout, later files with the same header row reuse it and pre-select the contractor. Old Excel 97-2003 (.xls) files must be re-saved as .xlsx or CSV.
   - **Scanned or photographed payrolls** → keyed in on a fast grid that carries last week's crew forward.
5. **Match job titles** once per contractor ("Backhoe Operator" → *POWER EQUIPMENT OPERATOR — GROUP 2*). Suggestions use the WD's own group definitions. From then on, every payroll from that contractor is checked automatically.
6. **Review** each payroll: paid versus required for every worker line, with the math shown. Mark it reviewed, accepted, or correction requested.
7. **Follow up** (*Exceptions* and *Restitution*): triage every finding across the project, track each underpayment from *owed* → *requested* → *paid* → *verified* (or *waived*, with a note), and record corrected payrolls. The original is kept but no longer counted.
8. **Document** (*Letters & documents*):
   - a **correction request** per contractor (back wages by worker and week, with the arithmetic, and the other items to fix) and a **missing payrolls** letter, previewed first and downloaded as Word (to put on letterhead), PDF or plain text;
   - a **review memo to file** summarizing the whole project for the monitoring file or the funding agency;
   - **stamped payrolls**: the contractor's own PDF with a review notation on page 1 ("REVIEWED against WD … · date · reviewer" and the result), followed by a Payroll Review Worksheet. Download one, or all of a contractor's payrolls as a single PDF;
   - the restitution ledger as an Excel workbook and all findings as CSV.

## What is checked

| Check | Basis |
|---|---|
| Basic hourly rate ≥ WD rate for the classification | 29 CFR 5.5(a)(1) |
| Fringe paid to plans or in cash ≥ WD fringe (cash above the basic rate counts toward fringe, but extra fringe never offsets a low basic rate; percentage fringes are computed on the basic rate; fringe is owed on every hour, including overtime, with each hour's own credit) | 29 CFR 5.5(a)(1), 5.24–5.32 |
| Overtime at ≥ 1.5 × the basic rate for hours over 40 in the worker's week, counted across all of the worker's lines (classifications), including hours over 40 paid at straight time and overtime paid at \$0. Cash paid in lieu of fringe is left out of the basic rate. Overtime-column hours that are not over 40 must still meet the WD rate. Switchable per project | Contract Work Hours and Safety Standards Act; 29 CFR 5.32 |
| Apprentices: wage ≥ program % and full WD fringe unless the program says otherwise; an apprentice with no registered program on file for that classification is checked at the journeyworker rate; apprentices over the ratio (counted by person) owe the journeyworker rate, including overtime | 29 CFR 5.5(a)(4) |
| Classification not on the WD (conformance needed) or not yet matched | 29 CFR 5.5(a)(1)(iii) |
| Executive Order minimum for "**" classifications (only when you enable it for the project) | EO 13658 / WD notes |
| Statement of Compliance signed | Copeland Act, 29 CFR 5.5(a)(3) |
| Missing weeks (from the start date to the final payroll), late submissions, duplicate weeks, payroll-number gaps | 29 CFR 5.5(a)(3) |
| Arithmetic: daily hours vs totals, gross vs hours × rates, net vs gross − deductions, project gross vs all-work gross | Form WH-347 instructions |
| Full Social Security numbers on the payroll | Rev. 2025 WH-347 (identifying number only) |
| Missing or invalid dates (reported, never fatal) | — |

Underpayments are computed exactly, in cents, per worker per week, and every amount shows its arithmetic.

**Wagebench is a review aid, not a legal determination.** The reviewer decides what is owed, and the contracting agency and DOL have final authority.

## Tests

```bash
npm test          # unit tests: WD parser, checks, importers, PDF reading/filling, documents
npm run e2e       # browser tests against the production build (Playwright + Chromium)
npm run check     # typecheck + unit tests + production build
```

The unit tests use hand-computed amounts (for example, a 3%+$21.00 fringe paid as $21.00 flat on a $44.00 electrician is $1.32/hr short, $52.80 for 40 hours) and the real wage determinations in `fixtures/wd/`. The browser tests need Chromium: `npx playwright install chromium` if you do not have it.

## Project layout

```
src/engine/        Pure TypeScript domain logic (no DOM): runs in the browser and in tests
  wd/              Wage determination parser and fringe rules
  checks/          The compliance evaluation (findings, underpayments, missing weeks)
  importers/       CSV / Excel payroll import with column detection
  pdf/             PDF text extraction, WH-347 reader and filler, WD-from-PDF
  docs/            Review stamp and worksheet, letters (DOCX/PDF/text), exports
  restitution.ts   Restitution ledger
src/db/            IndexedDB storage (Dexie), backups
src/app/           React UI (pages, editor, store, router)
src/sample/        The fictional demo project
fixtures/wd/       Real wage determinations used to test the parser, plus the sample
public/forms/      The official WH-347 (public domain)
docs/RESEARCH.md   Why this product: the evidence, competitors and rejected alternatives
e2e/               Browser tests
```

## Privacy and security

- No backend, no accounts, no analytics, no third-party requests. The production build includes a Content-Security-Policy limiting network access to the app's own origin.
- Data is stored in IndexedDB in the reviewer's browser profile. Clearing site data deletes it, so **download backups**. Backups contain workers' names and pay; store them like any payroll record.
- Payroll files from third parties are treated as hostile:
  - PDFs are parsed with pdf.js with script evaluation disabled, and a stored "PDF" opens in a tab only if its bytes are a PDF.
  - Workbooks are size-checked before they are unpacked (zip bombs, huge declared ranges, XML entity tricks), and CSV files are capped at 20,000 rows.
  - Stamped copies have scripts, launch actions and XFA removed.
  - Spreadsheet exports neutralize formula injection.
- A backup file is treated as untrusted too. Every record is rebuilt field by field, and the wage determination is re-read from its text. A restore that would touch another project's records is refused, and replacing an existing project asks first.
- When hosting `dist/`, also send the CSP as an HTTP header. A `<meta>` CSP cannot set `frame-ancestors`, so add `frame-ancestors 'none'` in the header to prevent framing.

## Limitations

See the end of [docs/RESEARCH.md](docs/RESEARCH.md) and the report accompanying this build. The main ones:

- Scanned payrolls are keyed in; there is no OCR.
- Only the Rev. January 2025 WH-347 layout is read automatically from PDF.
- State prevailing-wage rules (for example daily overtime) are not modeled.
- The tool is single-user per browser.
