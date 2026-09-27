# Research record: how Wagebench was chosen

**Research dates:** September 27, 2026 (single intensive session).
**Method:** 16 parallel discovery sweeps across B2B domains → 8-candidate adversarial validation (a competitor kill-hunt, an evidence-and-money researcher and a skeptical judge per candidate) → targeted searches by the lead → a 5-angle novelty sweep plus a completeness critic on the winner → a feasibility spike on real wage determinations and the official WH-347.

This file records the evidence that changed decisions. It does not list every query.

## Limits of this research (read first)

- **Network policy.** The environment could not open Reddit, G2, Capterra, TrustRadius, most industry forums, vendor websites, dol.gov, sam.gov or ecfr.gov directly. Evidence from those sites comes from **search-engine result excerpts**, not full pages. GitHub, npm and PyPI could be read directly. Reddit is not indexed by the search tool at all.
- **Search budget.** The session hit its hard cap of 200 web searches (`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`). Some later validation agents therefore relied on GitHub, npm and PyPI plus prior knowledge. Every such claim is marked *unverified* below.
- **No customer interviews.** Nobody was contacted. Willingness to pay is inferred from what buyers already spend: consultant RFPs, portal contracts and staff roles.

---

## 1. The problem Wagebench solves

On federally funded construction (CDBG, CDBG-DR, HOME, EPA SRF, some USDA RD, FHWA, FAA and others), every contractor and subcontractor must submit a **certified payroll every week**. Someone on the owner's side must **review each one against the Davis-Bacon wage determination (WD)**. That reviewer might be a city or county grant administrator, a Labor Standards Officer (LSO), a consulting engineer, a grant-administration firm, a regional council of governments, or a prime contractor, which is now liable for its subcontractors' back wages. They must:

- check every worker line against the WD rate and fringe for that classification
- catch overtime, arithmetic, apprentice and signature problems
- track missing weeks
- compute and chase restitution
- document the review for monitoring and reimbursement

When the owner has not bought an enterprise portal such as LCPtracker, Elation, eMars or B2Gnow and forced every subcontractor into it, payrolls arrive **by email as PDFs and spreadsheets**. They are then reviewed **by eye against a WD that can run 60 pages**, with the results kept in Excel and Word.

### Evidence that the obligation and the pain are real

| Evidence | Source |
|---|---|
| Montana CDBG: payrolls submitted with a reimbursement request "must include notations demonstrating that the Grantee checked them against the applicable Davis-Bacon wage determination." | [MT CDBG Grant Administration Manual, Ch. 5](https://commerce.mt.gov/_shared/comdev/CDBG/docs/Grants/7CDBGGAM/GAM/Chapter-5.pdf) |
| HUD guidance: payrolls "must be reviewed by the grantee upon receipt… and payroll forms must be initialed by the grantee to indicate that they have been reviewed." (search excerpt) | [Basically CDBG (State), Ch. 12](https://www.hudexchange.info/sites/onecpd/assets/File/Basically-CDBG-State-Chapter-12-Labor.pdf), [HUD-4743 monitoring guide](https://www.hud.gov/sites/dfiles/OCHCO/documents/4743.pdf) |
| Michigan: the local government must complete a Payroll Review Worksheet (form 10-L) for all payroll documentation. | [MI CDBG GAM Ch. 10](https://www.miplace.org/4a526d/globalassets/documents/cdbg/gam/chapter-10/reading/10-construction-management-and-labor-standards) |
| Texas GLO CDBG-DR: the LSO must sign a Payroll Certification with every payment request that includes Davis-Bacon-covered costs. | [GLO Implementation Manual Ch. 9](https://www.glo.texas.gov/sites/default/files/2025-03/ch9-labor-standards%20(1).pdf) |
| Texas TDHCA publishes a free Excel "WH-347 Davis-Bacon Payroll Review" workbook. States hand reviewers spreadsheets because no tool exists for them. | [TDHCA Ex09-PayrollReviewTool.xls](https://www.tdhca.texas.gov/sites/default/files/program-services/docs/Ex09-PayrollReviewTool.xls) |
| A common CDBG audit finding: "the grantee may not document the review of contractors' wage reports." (search excerpt) | [CLA](https://www.claconnect.com/en/resources/articles/24/mitigate-common-audit-findings-of-the-community-development-block-grant) |
| Brunswick, GA FY2025 single-audit finding for missing subcontractor certified payrolls on a CDBG-DR grant. | [Citizen Portal summary](https://citizenportal.ai/articles/9905390/Georgia/Glynn-County/Brunswick/Independent-auditors-issue-clean-opinion-for-city-finances-flag-late-filing-and-singleaudit-payroll-finding) |
| HUD OIG: HUD could not document its analysis of certified payrolls. Another grantee "lacked adequate procedures and controls" to monitor contractors. | [OIG 2021-PH-0001](https://www.hudoig.gov/open-recommendation/2021-ph-0001-001-hud-did-not-always-implement-correct-davis-bacon-wage), [OIG audit](https://hudoig.gov/sites/default/files/documents/audit-reports/ig1151018.pdf) |
| HUD built a training module because Local Contracting Agencies struggle with payroll analysis. DOL runs a seminar titled *"What Am I Supposed to Do With All of These Certified Payrolls?"* | [HUD Exchange](https://www.hudexchange.info/news/new-module-on-davis-bacon-payroll-analysis/), [DOL WHD](https://www.dol.gov/sites/dolgov/files/WHD/prevailing-wage-presentations/dbra-seminars/What-Am-I-Supposed-to-Do-With-All-of-These-Certified-Payrolls.pdf) |
| Small governments pay consultants to do this review: Fayetteville NC RFP (on-call labor compliance, CDBG/HOME), Azusa CA 2025 RFP, Grant County OR RFQ, and NY HTFC (monitoring up to 49 subgrantees). Saginaw County's engineer/grant-administrator scope includes "checking weekly payrolls and completing Payroll Review Worksheets." | [Fayetteville](https://www.fayettevillenc.gov/files/sharedassets/main/v/1/finance/purchasing/bids/2025/september/rfp-on-call-labor-compliance-consulting-services.pdf), [Azusa](https://www.azusaca.gov/DocumentCenter/View/48852/2025-RFP-for-CDBG-Labor-and-Complianace), [Grant County](https://grantcountyoregon.net/DocumentCenter/View/787/Grant-County-RFQ-Labor-Standards-CDBG---Deadline-Extended?bidId=), [NY HTFC](https://hcr.ny.gov/system/files/documents/2026/01/260109_htfc_davis-bacon_sustainability_discretionary_final_rev2.pdf), [Saginaw](https://www.saginawcountymi.gov/media/lrrdfadg/rfq-engineer-grant-administrator-2024-09-19.pdf) |
| Consultants sell "line-by-line audits of subcontractor certified payroll reports." | [Labor Compliance Services](https://labor-compliance.com/davis-bacon-prevailing-wage-compliance/), [CPWIS](https://contractorsprevailingwage.com/prevailing-wage-labor-compliance-and-consulting-services-overview/) |
| Employers hire for the role: "Construction Billing Compliance Coordinator" (collects and reviews subcontractor certified payrolls); "Disaster Recovery Labor Compliance Specialist" (USVI). | [Glassdoor listing](https://www.glassdoor.com/job-listing/construction-billing-compliance-coordinator-abc-construction-contracting-inc-JV_IC1132172_KO0,43_KE44,76.htm?jl=1010177294285), [governmentjobs.com](https://www.governmentjobs.com/careers/dopusvi/jobs/3829227/disaster-recovery-labor-compliance-specialist) |
| Under the 2023 DBRA final rule, primes are responsible for subcontractors' back wages regardless of intent. (Law-firm and vendor summaries; not verified against eCFR from this environment.) | [Schwabe](https://www.schwabe.com/publication/davis-bacon-act-regulation-updates-subcontractor-flow-down-requirements/), [myconstructionpayroll](https://www.myconstructionpayroll.com/post/are-you-liable-for-your-subcontractor-s-certified-payroll-mistakes-new-davis-bacon-rules-say-yes) |
| Owners withhold payment over late payrolls; for example WSDOT withholds when a certified payroll is more than 90 days late. | [WSDOT Bulletin 2025-03](https://wsdot.wa.gov/sites/default/files/2025-04/ConstructionBulletin2025-03.pdf) |
| WDs are hard to use: one developer calls SAM.gov WD PDFs "close to unusable in practice" (60-page documents; 4,009 active determinations, 114,283 classifications). | [RE-coder376/davis-bacon-rates](https://github.com/RE-coder376/davis-bacon-rates) |

### How the work is done today

1. A subcontractor emails a WH-347 PDF (old or Rev. Jan 2025 form), a payroll-system printout, a spreadsheet or a phone scan.
2. The reviewer logs it in a spreadsheet by subcontractor and week.
3. They open the WD and, for every worker line, check the classification, the basic rate, the fringe (plan or cash), overtime at 1.5×, the arithmetic, apprentice registration and ratio, and the signed Statement of Compliance.
4. They email the contractor for corrections, compute restitution by hand, and track payment in Excel.
5. They initial or annotate the payroll, or fill in a state review worksheet, before the pay request goes out.
6. For monitoring, they assemble the labor standards file.

The reviewer is either on staff (a city or county LSO) or a consultant billing a capped administration fee. Either way, **time saved is money**, and an underpayment or undocumented review that is missed becomes an **audit finding, a withheld draw or a clawback**.

---

## 2. Competitive landscape (the "try to kill it" pass)

| Product | What it actually does | Why it does not cover this job |
|---|---|---|
| **LCPtracker** (Pro, LCPcertified; free single-project tier for subs) | Agency- or prime-licensed portal. Subcontractors submit data into it and it checks against the WD. | It only works when every subcontractor is required to submit through it. Michigan's statewide contract runs about **$137.7k in the first year** ([MI contract](https://www.michigan.gov/dtmb/-/media/Project/Websites/dtmb/Procurement/Contracts/MiDEAL-Media/002/230000000005.pdf)). A small grantee receiving emailed PDFs cannot use it. It reported a data breach in Aug 2024 ([VCDB issue](https://github.com/vz-risk/VCDB/issues/21382)). |
| **eMars Compliant Client** | The most feature-similar agency tool: 30+ Davis-Bacon checks, flags misclassification, shortfalls and missing weeks. | Contractors must enter or import into eMars. Quoted per project and bought by the receiving entity ([eMars](https://emarsinc.com/), [comparison](https://certiwage.com/emars-alternative)). |
| **Elation Systems** | Agency portal; free for contractors when the agency licenses it. Oklahoma's SRF provides it to borrowers at no charge. | Same portal model. Where a program already provides Elation (e.g. [OWRB](https://oklahoma.gov/content/dam/ok/en/owrb/documents/financing/forms-and-guidance/Davis_Bacon_Compliance_Software_language.pdf)), Wagebench is not needed. |
| **B2Gnow eComply**, **PRISM**, **SkillSmart InSight IQ** | Agency and prime labor-compliance portals. SkillSmart shows "who's submitting, who's behind" and comes with a dedicated setup specialist. | Portals with sales-led pricing and 2–4 week implementations. No evidence they ingest emailed PDFs or produce restitution letters or review stamps. |
| **Dili** (Prevailing Wage & Apprenticeship) | AI platform that "ingests certified payroll reports from any format (PDF, Excel, CSV)" and checks them against SAM.gov WDs; offers managed service. | **The closest functional match.** It targets IRA tax-credit project owners and EPCs, is cloud-only and sales-led, and there is no evidence of CDBG/grantee targeting, a restitution ledger, letters or review stamps. (Known only from search excerpts; its site could not be opened.) |
| **PrevailAudit** (indie, GitHub) | Browser-local audit of **CSV** exports against a hand-built wage-table CSV. Pilot at $299; "$499/mo prime oversight". | No WD parsing, no PDF reading, and its sample report says underpayment amounts are "not calculated". No evidence of customers. |
| **Contractor-side tools** (CertifiedPayrollPro, WeeklyCertified, eCPR Express, filed347, FormFriday, PrevWage/HCC, Points North, eBacon, Foundation, Trayd, Lumber, Hammr, DOL's own online fillable WH-347) | Help a contractor **produce** its own WH-347 and state XML. | They serve the other side of the transaction. At least 12 appeared in 2025–26, so that side is crowded and it was **deliberately not built**. |
| **State spreadsheets and forms** (TDHCA workbook, MI 10-L, GLO certification, MT LSO toolkit) | Manual review aids. | Everything is still typed by hand: no WD parsing, no carry-forward, no ledger, no letters. |
| **Kaster** (kaster.app) | Prime-contractor compliance platform advertising "AI-guided auto-populated CPR entries" (search excerpt). | Not verified. If it extracts data from PDFs that subcontractors email, it competes for the small-prime user. This must be checked before a pilot with primes. |
| **Labor Compliance Solutions** ([robvilla14](https://github.com/robvilla14)) | A practitioner building free, offline HUD labor-standards tools (HUD-11 interviews, Section 3, WD dates). | Not a competitor today. Its README says payroll examination is still done by hand. This is **independent confirmation of the pain from exactly our user**, and a possible partner. |
| **Consultants** | Do the review as a service. | Evidence of willingness to pay, and a channel: consultants are a natural buyer, with one workspace per client. |
| **PDF stamps** (Bluebeam, Acrobat) | Reviewers stamp or initial PDFs by hand today. | Stamping alone is not novel. The value is a notation **generated from the check results**: WD number and modification, exceptions and amounts, reviewer and date. |

Open-source: [NuAxis/wage-determinations-text-parser](https://github.com/NuAxis/wage-determinations-text-parser) (old WDOL-era parser, abandoned), [Osketh-Labs/certified-payroll-formats](https://github.com/Osketh-Labs/certified-payroll-formats) (format specs and validators), [forge-dev-studio/wh347-pdf](https://github.com/forge-dev-studio/wh347-pdf) (contractor-side form filler), [FishRaposo/WCP-Compliance-Agent-V5](https://github.com/FishRaposo/WCP-Compliance-Agent-V5) (reviewer-framed **portfolio demo** with a hard-coded fake WD), [grey-flannel/usdol-wage-determination-model](https://pypi.org/pypi/usdol-wage-determination-model/json) (early data model). None is a usable reviewer product.

### Novelty conclusion (stated carefully)

We searched commercial software directories and comparison pages (via search excerpts), government and grant-program tools, GitHub, npm and PyPI, and incumbents' features. We found **portals that require every subcontractor to submit through them, contractor-side generators, one enterprise AI platform aimed at tax-credit projects (Dili), one CSV-only indie audit tool, state spreadsheets and consultants.**

We did **not** find a maintained product that lets an owner-side reviewer with no portal mandate do all of the following:

- parse the SAM.gov WD text
- ingest the payrolls contractors actually email
- remember job-title matches per contractor
- compute dollar underpayments deterministically
- track missing weeks and restitution
- produce the correction letters and the review notation on the payroll

The completeness critic's verdict was: *"No product exists that does the whole planned workflow. The engine can be copied and the whitespace is narrow, but it is real."* Individual pieces exist: WD parsing libraries, contractor-side check rules, and portal-side missing-week views. The combination for this buyer does not.

Coverage has gaps. Several incumbents' help documentation could not be opened (see Limits), and Dili's feature depth is known only from excerpts. We therefore claim a specific unserved combination for a specific buyer, not global uniqueness.

**Open competitive questions to settle before a paid pilot:**
1. **Dili:** can an owner or consultant drop in subcontractors' emailed PDFs without the subcontractors logging in? What is its minimum deal size?
2. **Kaster:** does it extract data from emailed PDFs?
3. **LCPtracker, eMars and Elation:** can an agency user key in or upload payrolls on a subcontractor's behalf cheaply?
4. **Which state programs already mandate a portal?** Known mandates: DOE BIL (LCPtracker), HUD FHA multifamily (Elation), Oklahoma SRF (Elation). Possibly state DOT local-agency federal-aid work. The addressable market has to be scoped program by program.

---

## 3. Buyer, economics and adoption

- **Users:** city and county grant administrators and LSOs, grant-administration consulting firms, regional councils of government, consulting engineers doing construction administration on federally funded water and sewer work, labor-compliance consultants, and compliance staff at small and mid-size primes.
- **Buyers:** a consulting firm owner (one tool across many client projects; its fee is capped, so hours saved are margin), a city or county finance or community-development director (avoiding findings and withheld draws), or a prime contractor's controller (flow-down liability).
- **What they pay today (anchors, not our prices):**
  - consultant labor-compliance contracts (RFPs above)
  - state or agency portals at about $137.7k per year (Michigan)
  - contractor-side indie tools at $19–$249 per month
  - PrevailAudit's stated $499/month "prime oversight"
- **Plausible pricing (estimate, untested):** per reviewer seat per month ($150–$400), or per project with a consultant multi-project plan. A pilot is simple because the product needs no integration: one active project, its WD, and the last 4–8 weeks of emailed payrolls.
- **Why it hasn't been solved:**
  - Incumbents make money on agency contracts that force everyone onto a portal.
  - The reviewer market is fragmented and project-based.
  - Indie builders chased the SEO-visible contractor side ("wh 347 form").
  - WDs and payroll PDFs are messy.
  - Honest risk: some reviewers only spot-check, and some programs already hand out a portal (Oklahoma SRF with Elation, DOE with LCPtracker). That shrinks the market.

## 4. Feasibility findings

- **WD parsing works deterministically.** The parser reads 10 real WDs (2010–2017, CA/IL/NM/VA/CO) with zero misparsed rates, as well as the current SAM.gov layout. It handles nested headings, multi-line classifications, group definitions, per-day rates, percentage fringes ("3%+21.00"), footnoted fringes ("7.455+A&B") and single-dot leaders. Every unparsed "$" line in the corpus was verified to be a note, not a rate.
- **The official Rev. Jan 2025 WH-347 has no fillable fields.** DOL publishes it flattened, and it is labeled "For Contractor's Optional Use." Software prints text onto it, so text-layer PDFs can be read by position. **Scanned** payrolls cannot be read reliably without OCR or LLM help; one builder measured **42–67% cross-model agreement** on real scans ([FormFriday](https://github.com/gustavofjordao021/certified-payroll-landing)). Wagebench therefore offers fast keyed entry with week-to-week carry-forward for scans instead of claiming automated extraction.
- **Form transition (unresolved conflict):** vendor and blog sources ([Points North](https://www.points-north.com/trends-and-insights/still-using-the-old-wh-347-deadline-is-september-2026), Lumberfi) say the pre-2025 WH-347 is not accepted after **September 30, 2026**. The form itself says it is optional-use, and one open dataset says prior forms remain acceptable. We could not open dol.gov to settle it. Either way, reviewers are currently receiving a mix of old and new forms.
- **Privacy:** payrolls carry worker names, identifiers and wages. Wagebench runs entirely in the browser with no server. The production build ships a Content-Security-Policy that blocks any outbound connection, and data lives in IndexedDB with explicit backups.

---

## 5. How the winner was chosen (and what lost)

**Discovery.** 16 sweeps produced 65 candidates and about 110 rejected pains. Most rejections were saturated markets: COI tracking, lien waivers, AIA pay apps, submittals, bid leveling, security questionnaires, access reviews, freight audit, carrier vetting, IFTA, credentialing, bank-statement conversion, lease abstraction and rent-roll normalization.

**Validation.** Eight shortlisted candidates each got a competitor hunter, an evidence researcher and a skeptical judge.

| Candidate | Verdict | Why |
|---|---|---|
| Benefits carrier invoice vs enrollment vs payroll-deduction reconciliation | **Killed** | The exact product exists and is cheap: Tabulera Starter is self-serve at $319–399/month with a 30-day trial. Also AdminaHealth, Beneration, UpSwing and ebm on the Employee Navigator marketplace, and ben-admin suites. |
| HVAC/plumbing warranty registration and parts-credit recovery | **Killed** | The valuable part (registering in each manufacturer's portal) needs credentials and automation of third-party portals. Evidence was weak, and ServiceTitan partly covers it. |
| Build America, Buy America certificate tracking | **Killed** (for now) | Obligation is real, but no buyer voice was found. Distributors give certificates away free; policy risk. |
| Certified payroll *generation* for small subcontractors | **Killed** | 9+ live tools at $0–$249, MIT libraries, and heavy indie crowding. |
| **Certified payroll *review* for owner-side reviewers** | **Pursued** | Legally required weekly work; documented audit and monitoring consequences; consultants paid to do it by hand; portals that don't fit small grantees; deep deterministic domain logic; strong demo; local processing is an advantage. |
| Vendor price-file / cost-change intake for distributors | Pivot, not chosen | Real (15–30 hours per week per pricing analyst per [MHEDA/MDM](https://www.mheda.org/blog/your-supplier-costs-went-up-how-long-did-your-pricing-lag-behind/)), but a named software category already covers it (Pricefx, PROS, Zilliant, BlueLink, Mindharbor for P21, Distro), and US distributor evidence was thin. |
| Vendor statement vs AP ledger reconciliation | Pivot, not chosen | Served for enterprise (Xelix, Pyracloud) and reportedly by Lightyear and Ottimate. Low urgency at SMBs. |
| Mill test report / cert-pack assembly | Pivot, not chosen | A free local tool already covers the core (King-Wuda/material-certs); shop ERPs build packs. |
| Insurance commission statement reconciliation | Pivot, not chosen | CommissionSight shipped mid-2026; AMS and AgencyBloc cover most agencies. |

Every rejection is backed by the discovery and validation outputs. The strongest runner-up was the distributor price-change desk. It lost because "pricing software for distributors" is already a category with funded players, while the reviewer side of certified payroll has no affordable product.
