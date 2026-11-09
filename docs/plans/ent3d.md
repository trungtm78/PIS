# Plan of lane ENT-3d (enterprise edition: the PVFCCo configuration pack)

Branch `lane/ent3d`, worktree `D:\PIS-ent3d`. Sources: the customer spec HSKT v0.3 (HT.02, HT.03, MD.03, QT.01; the spec file itself is not committed), plan section ENT-3 and the engineering review R24 (the organisation matrix is TEMPLATE data in ONE tenant, never real names or accounts, loaded only through a command that has a dry run).

## Goal

A PVFCCo template pack that an administrator loads through the real import path (ADM migration batch: register, dry run, apply by a different person), that materialises into the existing tables (organisation units, scoped roles, the staged approval rule, delegation defaults, the matrix of authority, master data entries for MD.03), that can be verified at any time, and that shows the organisation and the roles of the edition read-only on one screen.

## Decisions (owner rule 2026-11-08: deepest governance, best extensibility, no scope cut)

1. One tenant. The 9 input points are organisation units below one root; the roles are scoped, not tenants: entry and unit approval `UNIT_ONLY`, planning review and close `TENANT`, leadership view `TENANT`, administration `TENANT`. The aggregating Ban KHDT is a unit of its own, not one of the 9 input points (the spec: 7 Ban/Don vi + 2 To du an = 9 input points, KHDT aggregates). The two project teams are placeholders `[ten 02 To du an]` until the customer names them.
2. The pack is DATA (rows of one table file) with a pure kernel module that parses it into a model, judges it (tree, roles, seats, segregation of duties, workflow, catalogue keys) and plans the difference with the tenant. Nothing in the kernel names the customer; the enterprise package carries the template and its Vietnamese words (`src/messages/org-pack-texts.ts`).
3. The loader is the ADM migration batch: a new mapping `ORG-PACK-1` (registered by the enterprise seam; its judge adds the pack rules to the generic row rules), target entity `ORG_PACK`, source system `PVFCCO-TEMPLATE`. Dry run, apply by someone other than the registrar, control totals, rollback of the staged rows: all existing behaviour. A new operation `materialiseEnterpriseOrgPack` turns an APPLIED batch into the real objects, idempotent by code, and answers with a report (created, unchanged, drift, blocked).
4. Maker-checker everywhere a policy is touched: units and roles are structural and take effect with the approved batch; the staged approval rule and the absence (delegation) policy are written as governance rule versions submitted by the materialiser and approved by somebody else; the matrix of authority is a submitted draft approved by somebody else; the catalogue entries (MD.03) are master data proposals submitted for review (maker is the materialiser, the checker publishes with the decision document). Nothing is silently activated.
5. No person, no account, no grant is created. A role seat says who may be given the role where; the directory groups (`MACHVON-PVFCCO-<UNIT>-<ROLE>`) are derived from the seats and written to `ad-group-role-map.json` (`tenantMappings`), checked by `npm run infra:check` and by a test that regenerates them from the pack.
6. Drift is reported, never overwritten: a unit or role that exists with other content is `DRIFT`; changing it is an ordinary edit with a reason.
7. No migration: every object has a table already. The report of a materialisation lives in the audit row (ADM-11); the verification report is computed live.
8. MD.03 catalogues: new tenant-owned master types `REPORT_TYPE`, `RECEIVING_AGENCY`, `REPORTING_PERIOD_KIND`, `CAPITAL_SOURCE`, `REPORT_UNIT` in `master-types.ts` (the funding classes carry the code of the class of the FND enterprise pack, a test holds them equal); the delay causes are entries of the existing tree `ISSUE_CATEGORY` (MDM-17) under the root `DELAY_CAUSE`.

## Steps (tick as done)

- [ ] 1. Kernel `org-pack.ts`: model, rows <-> model, judge, plan, directory group names, verification; tests in `packages/kernel/test/org-pack.test.ts`.
- [ ] 2. Master types of MD.03 in `packages/db/src/master-types.ts` + dictionary doc + tests.
- [ ] 3. Enterprise pack: template data, Vietnamese texts, rows file, mapping registration, AD map generation; tests in `packages/edition-enterprise/test`.
- [ ] 4. Store `OrgPackStore` (materialise, read state, verify) in `packages/edition-enterprise/src/org-pack`; db test file (run after the gate).
- [ ] 5. Directory map: `ad-group-role-map.json` `tenantMappings`, checker `scripts/infra-artefacts.mjs` and its test.
- [ ] 6. API: controller in `apps/api/src/editions/enterprise`, contract by `scripts/contract-patch.mjs`, error codes, authz matrix, command surface, tests (run after the gate).
- [ ] 7. Web: read-only overview screen with the verification report and the four-step loader guide, i18n part `ent3d`, vitest.
- [ ] 8. Design pack: module text, story, backlog, traceability, test cases; shared suite entries (isolation, authz); docs `docs/enterprise-org-pack.md`.
- [ ] 9. Independent review (Codex when available, otherwise a read-only subagent), triage, fixes, `git merge main`, final report.

## Tests per layer

- kernel (pure): tree depth and cycles, 9 input points, one entry and one approver seat each, scopes per role kind, segregation of duties (entry vs approve vs administer), read-only leadership, workflow order and deadlines through `reportWorkflowDefect`, group names unique and inside the directory filter, plan classification, verification (vacant, over-filled, drift).
- edition package: the template validates; counts; no person data; deterministic digest; catalogue entries pass `validateMasterContent`; AD map equals the pack; permissions exist in the contract catalogue.
- db / api (real database, after the gate): dry run rejects a broken pack with row numbers; apply by the registrar is refused; materialise twice changes nothing the second time; drift reported; a unit user sees only its unit's projects, Ban KHDT sees all, leadership reads all and writes nothing.

## Risks

- DB and API suites cannot run while the pre-push gate is running; they are written and registered, then run once it is done (recorded in the report).
- The Vietnamese names of the units are the spec's; the two project team names are placeholders by design.
- The directory map has no runtime consumer yet; the overview screen and the grant plan are the consumer until directory sync exists.
