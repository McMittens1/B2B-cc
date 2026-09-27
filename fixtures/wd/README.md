# Wage determination fixtures

- `wd0.txt` … `wd9.txt` are real Davis-Bacon general wage determinations (2010–2017) in the
  SAM.gov / WDOL text layout. They are U.S. government works (public domain). They were taken
  from the test fixtures of the MIT-licensed
  [NuAxis/wage-determinations-text-parser](https://github.com/NuAxis/wage-determinations-text-parser)
  project and are used here only to exercise the parser against real-world layouts
  (nested headings, multi-line classification names, group definitions, per-day rates,
  percentage and footnoted fringes, single-dot leaders). `wd2.txt` is a fragment with no
  header and is used as a negative case; `wd5.txt` duplicates `wd1.txt`.
- `sample-modern.txt` is **demonstration data written for Wagebench**. It follows the current
  SAM.gov layout but its decision number (`XX20260047`), rates and counties are fictional.
  Never use it for a real project.
