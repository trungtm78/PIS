# Lane GOV-12 plan

Items of docs/governance-roadmap-10of10.md: G4-6 (period reports of the Ministry of Finance with digital signature and locked periods, on the RPT-1 report engine), G4-8 (community monitoring file with a notice deadline of 45 days, feedback and responses), G4-9 (read-only public portal with an allowed field set and OC4IDS export), G4-10 (audit recommendations in the ranking and in the investor profile), G4-11 (document transmittal with review deadlines and states WIP / Shared / Published / Archive), and the should-have part of G4-12 (anonymous report channel, gifts register, site photo checks across projects). G4-7 belongs to MR-1.

Migration block GOV-12 2600-2619 (registered in db/migrations/blocks.json); V2600-V2608 are used (see docs/gov12.md for the map of files).

## Decisions (owner standing rule: decide by deepest governance, never cut scope)
- No new API module code: G4-6 lives in RPT, G4-8 and G4-9 in PRJ (the public portal controller is in the control-plane part of PRJ because it needs the control database), G4-10 and the anonymous channel and the gifts register in AUD, G4-11 in DOC, the photo findings in QMS.
- Every deadline and threshold is a governance rule (registered in `registerGov12Rules`, kernel `gov12-rule-types.ts`), with formula, source, as-of and legal status UNVERIFIED: the 45 days of the monitoring notice, the response time of a feedback, the review time of a transmittal, the acknowledgement and resolution time of a whistle report, the gift declaration time and value line, the pHash distance of the photo check, the portal rate limit and page size, the period lock policy.
- The public portal never reads source tables. A command of the publisher writes rows of `portal_record` that were cut by the allow-list of fields (kernel `portal-fields.ts`); the public controller calls a SECURITY DEFINER function that reads only `portal_record` of a directory entry that is enabled. The allow-list is applied at publish and again on output (defence in depth), there is a rate limit per portal and client (in memory, the client key is never stored or logged), and the response carries no tenant or user id.
- OC4IDS: a pure mapper of published records to the OC4IDS project package and a validator of the required project fields of the standard; the test validates the export against the list of required fields offline (no network). The list is held as data with its source and flagged unverified until diffed with the schema file of the standard.
- Anonymous channel: the submission stores no IP, no user agent, no identity; the reporter gets a random access code (shown once, only its hash is kept) to read the status and answer questions; the rate limit works on an in-memory client key that is not persisted; handling needs the auditor right, and the involved people are excluded the way red flags do it (the subject is a free text).
- Digital signature of a period report: detached CMS over the package digest of the issued copy through the existing `SigningPort` (DOC); a MOCK signature is recorded as TEST and never counts for delivery to the Ministry (R18 style); the Ministry forms are registered PENDING_EXTERNAL (layout structure only, no official template), so they cannot be issued until the official file is supplied and a NEW layout version is made READY.
- Period lock: after the issued copy is signed and accepted, the period of a form is locked; a new revision is refused (`PERIOD_LOCKED`) until two different people unlock it with a reason; every lock and unlock is audited.
- Audit standing (G4-10): pure ranking of investor units by the state of their audit recommendations (open, overdue, disputed, money outstanding), joined to the latest disbursement ranking position as a context column. It never changes the disbursement ranking order and never shows a red flag (confidential).
- Not done on purpose (hooks): alert sources for the new overdue lists (`ALERT_TYPE` seeds) are left to the alert-centre lane; contractor portal, Monte Carlo, deep benefit measurement and direct national system connections of G4-12 are NICE and outside the should-have part.

## Layers and status
- [x] Kernel: gov12 rules and screens constants, monitoring, transmittal, portal fields and OC4IDS, whistle and gift rules, photo findings, audit standing, period lock and report signature, MOF forms (unit tests: packages/kernel/test/gov12-*.test.ts).
- [x] DB: migrations V2600-V2608, stores, DB tests (RLS, append-only, indexes, directory function): packages/db/test/gov12-stores.test.ts, rls-catalog.
- [x] API: controllers, contract-patch (operations, schemas, error codes, screens), authz matrix, command registry, API tests (apps/api/test/gov12), isolation entries (written, not run: the lead runs the shared suites).
- [x] Web: 12 screens with the kit, states matrix, i18n parts gov12-prj, gov12-docaud, gov12-rpt (not folded: the lead folds), vitest.
- [x] Docs and design rows: module specs, implementation_plan stories, traceability, backlog, test cases, navigation (docs/gov12.md).
- [ ] Gates: lint, typecheck, tests of what I touched, Codex review, triage.

## Steps and tests
1. Plan and block (this file). Test: `npm run migrations:check`.
2. Kernel rules (`gov12-rule-types.ts`, registration). Test: governance-check, kernel unit tests.
3. G4-10 audit standing: kernel + read store + controller + screen.
4. G4-11 transmittal: kernel state machine and review clock, migration, store, controller, screens.
5. G4-8 monitoring file: kernel clock, migrations, store, controller, screens.
6. G4-9 portal and OC4IDS: kernel allow-list, mapper, validator; migrations (setting, record, directory, function); store; publish commands; public controller with rate limit; isolation tests; screens.
7. G4-12: whistle channel, gifts register, photo findings.
8. G4-6: MOF forms (PENDING_EXTERNAL), period lock, signature.
9. Gates, Codex review, fixes, final report.

## Risks
- The shared files (openapi, error codes, screen catalogue, generated contract and client files, authz matrix, conformance count) are edited only through contract-patch and the generators; the lead cherry-picks.
- The OC4IDS required fields are written from the standard as known offline; flagged unverified.
- DB suites queue on the shared lock; each run is one at a time through the heavy lane.
