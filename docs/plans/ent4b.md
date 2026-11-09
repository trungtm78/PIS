# Plan of lane ENT-4b (PDF for the report forms, Ministry/Department form, layout configuration without code)

Branch `lane/ent4b`, worktree `D:\PIS-ent4b`, migration block ENT4B-1 2760-2779 (registered). Sources: plan section ENT-3 gap G5 (BC.01), eng review R23 (layout configuration through the rule store), R26 (one document model, three writers), customer spec BC.01.

## Decisions (owner rule 2026-11-08: deepest governance, extensibility, no scope cut)
- **One document model (R26).** `ReportDocument` (kernel `report-document.ts`) holds the filled grid (the XLSX model, template-keeping) and the filled narrative (the DOCX model) for the same layout and data, plus the layout hash. `documentSheetOf` resolves it to a table of display cells (formulas evaluated by the kernel's small evaluator `report-formula.ts`, numbers formatted by the one formatter). The three writers read only this: XLSX (`xlsx-template.ts`, unchanged), DOCX (`docx-render.ts`, unchanged), PDF (new `report-pdf.ts`, which reuses the primitives of `dis/export-pdf.ts`: fonts, `fitted`, `wrapped`, `broken`, the page constants, footer).
- **PDF is a rendition, not a new source.** The package digest of a copy stays the hash over XLSX and DOCX (so a repeat of a report that was generated before this lane is still a DUPLICATE); the PDF hash is recorded next to it (`pdf_sha256`, `pdf_name` on the draft and the issued copy), the file name follows `file-name.ts` (`.pdf`), the store keeps the bytes once per sha256 and the read of a file checks the hash.
- **Layout hash (R23).** `layout_sha256` (sha256 of the canonical JSON of layout + narrative) is recorded on every draft and issued copy, so a copy keeps which layout version produced it; the issue trigger checks it equals the draft's.
- **Layout configuration is a governance rule (R23).** Rule type `REPORT_LAYOUT`, code `CFG_*` = the layout code, params = a closed config: kind (INTERNAL or AGENCY_REQUEST), title, subtitle, period kind, money scale, demo flag, the indicators (code from the register, title, basis), the project columns (from a fixed catalogue, title, order), the project groups (key, title), totals, signatures, and for an agency form the requesting agency (name, request reference, receiver). NOT free cell design. Versions, maker != submitter != approver and ADM-11 audit come from the existing rule store and controller (`governance_rule.*` actions). Official forms of PVN, HPM, the Ministry stay code-owned: the code prefix `CFG_` is reserved for configured forms, `ReportFormRegistry.register` refuses it, and a configured form cannot name a protected receiver (PVN, HPM, MOF...).
- **Compile, do not store cells.** `compileLayoutConfig` (kernel, pure) turns the params into a `ReportLayout` (+ optional narrative) with status READY (or DEMO + illustrative data when the demo flag is on, R18). The API resolves a configured form per tenant and day (`ConfiguredForms`), registers it as `report_layout` version `v<rule version>`, builds a blank template, and uses a provider (default `DIS_HOME`) for figures; project groups read the dataset `projects_<group key>` from the provider (the enterprise provider of ENT-3a fills it; until then the cells stay empty with `DATASET_MISSING`, never invented, unless the form is DEMO).
- **Sở/Ban/Ngành form.** A built-in default code `CFG_AGENCY_REQUEST` (kind AGENCY_REQUEST, demo on, UNVERIFIED) is a starting layout "theo mẫu của đơn vị yêu cầu"; a tenant drafts a new version for the layout the requesting body asked for.
- **Live preview.** `previewReportLayout` (read, POST-free GET is impossible with a body: modelled as a command-less query `POST /report-engine/layout-preview`) compiles the posted params and fills them with deterministic illustrative data (labelled), returning the cell preview like a draft; the screen shows it as the user edits.
- **Screens.** RPT-07 (configured layouts: list, versions, state, submit/approve/retire through the existing governance operations) and RPT-08 (editor: pick indicators, columns, groups, order, titles; live preview). i18n part `ent4b`.

## Steps (tick as done)
- [ ] 1. Plan + block (this file, `blocks.json`).
- [ ] 2. Kernel `report-formula.ts` + `report-document.ts` (document model, sheet, layout hash): tests.
- [ ] 3. API `report-pdf.ts` (PDF writer from the document) + golden tests (cell map, text, page count equal across XLSX / DOCX / PDF for the same data).
- [ ] 4. DB: migration V2760 (PDF format, `pdf_sha256`/`pdf_name`, `layout_sha256`, trigger updates), store, controller (generate/issue/file reads), contract patch (schemas, parameter enums), file name `.pdf`, perf budget row `PB-R016`.
- [ ] 5. Kernel `report-layout-config.ts`: rule type `REPORT_LAYOUT`, schema, compiler, illustrative data, protected receivers; tests.
- [ ] 6. API: `ConfiguredForms` resolver (catalogue, generate, issue), preview operation, reserved prefix; tests (unit lane) + DB-lane tests written, not run.
- [ ] 7. Contract: operations/schemas/screens through `scripts/contract-patch.mjs`; regenerate; authz matrix; commands registry.
- [ ] 8. Web: RPT-07, RPT-08 screens, hooks, model, i18n `ent4b.{vi,en}.json` unfolded; vitest.
- [ ] 9. Docs (`docs/report-engine.md`, module spec RPT), shared suites entries (added, not run), merge main, lint/typecheck, independent read-only review, report.

## Tests per step
Kernel: `report-formula.test.ts`, `report-document.test.ts`, `report-layout-config.test.ts`. API (unit lane): `report-pdf.test.ts`, `report-document.golden.test.ts` (six enterprise forms, the weekly form, a configured form), `configured-forms.test.ts`. API (DB lane, written not run): `report-engine.pdf.test.ts`. Web: `screens/rpt/LayoutScreens.test.tsx`, `model.test.ts`.

## Risks
- ExcelJS formulas have no cached values, so the XLSX cell map holds formulas; the golden test evaluates them with the kernel evaluator and compares to the PDF text. The evaluator supports what the forms use (SUM, IF, ROUND, + - * /, comparison); an unknown function makes the cell empty and an issue, never a wrong number.
- Resources are tight (gate running): single-file tests, no DB runs until no `verify-cli` process exists.
