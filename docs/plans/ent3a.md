# Plan of lane ENT-3a (enterprise period snapshot, one reader, report provider)

Branch `lane/ent3a`, worktree `D:\PIS-ent3a`, migration block 2660-2679 (registered as slice `ENT-3`, because the registry accepts `<LETTERS>-<digits>` only). Requirements DL.03 and BC.01 of the customer spec "HSKT Phan mem quan ly DTXD v0.3" (plan section ENT-3, review decisions R21 to R27). Model: `docs/fnd-funding-model.md` (sections 5, 6.5, 13), report engine: `docs/report-engine.md`.

Goal: make the enterprise data path real. One frozen, hashed `period_snapshot` of the ENTERPRISE pack is built from `plan_figure_revision` (and the CAP year plans) and `ind_figure`; one pure reader (`EnterpriseFigureReader`) is the only way forms, HOME/BAN and the HPM push read it (R21).

## Decisions (owner rule 2026-11-08: deepest governance, no scope cut)

1. **Figures in the existing long table, indicators in a new one.** The funding figures use `period_snapshot_figure` with hash schema 2 (`figureRowsOf`, unchanged). The indicators of the dictionary (`ind_figure`) are not funding figures, so they are frozen in a new table `period_snapshot_indicator` (V2660) and covered by the same hash through an optional `indicators` member of the schema 2 extras. With no indicator the hash of a snapshot is byte-identical to what `snapshotHashFor(2, ...)` gave before, so the golden test stays green. Two rows are appended by the builder on top of `figureRowsOf`: `PLAN_TO_DATE` per cell and `TMDT_IN_FORCE` per project (class `TOTAL`), because the since-start and phased rates need them.
2. **Completeness before building.** The input points are the owner units of the projects that have an ENTERPRISE plan for the year. A period is complete when every planned (project, class, measure) cell has an accepted actual for every month of the period. A build on an incomplete period is refused (422 `ENTERPRISE_SNAPSHOT_INCOMPLETE`) with the list of missing units, their projects and cells, and the batches that wait for acceptance. A kind `ADHOC` build is the same figures for review and is never read by a report.
3. **Immutable after close, revision with lineage (R17).** Building `PERIOD_CLOSE` needs the period not OPEN. When a frozen `PERIOD_CLOSE` snapshot exists, a new build is accepted only if a period reopening of that period was approved (existing `period_reopen`: reason, requester is not the approver) after the freeze; the new snapshot has `revision` + 1 and the freeze marks the old one SUPERSEDED with `supersedes_id`. The old hash never changes.
4. **Maker is not checker.** The person who freezes is not the person who built (403 `SELF_APPROVAL_DENIED`); freezing needs the permission over the whole tenant.
5. **One reader.** `EnterpriseFigureReader` (kernel, pure) takes the frozen rows and answers cells, sums by project, unit, class and tenant, and every ratio with its numerator and denominator (sum over sum). The report provider, HOME/BAN and the HPM push call only this reader. HPM push is ENT-3c: the hook is `loadFrozenEnterpriseSnapshot` plus the reader, documented in `docs/ent-snapshot.md`.
6. **Forms stay DEMO.** `ReportFormBundle.snapshotProvider` names a provider; the bundle remains `ILLUSTRATIVE` (so layout status DEMO and the stamp stay). When a frozen snapshot of the period exists, the draft is filled from it (`data_source` LIVE, snapshot id and revision in `snapshot_ref`); when none exists the illustrative data is used exactly as before.
7. **Permissions** reuse the existing `funding.` prefix: `funding.snapshot.build`, `funding.snapshot.freeze`, `funding.snapshot.read`.

## Steps and tests

- [ ] 1. Plan and block (this file, `blocks.json`). Test: `npm run migrations:check`.
- [ ] 2. Kernel: `enterprise-figure-reader.ts` (+ `snapshotHashFor` optional indicators, completeness rule `enterprise-snapshot-checks.ts`, messages not needed). Tests: `packages/kernel/test/enterprise-figure-reader.test.ts` (cells, sums, rates, null never zero, additive sums, hash with and without indicators, completeness list); regression `fnd-public-golden.test.ts` untouched.
- [ ] 3. Database: `V2660__ent3a_snapshot_indicator.sql` (table, guard, RLS, index), `packages/db/src/enterprise-snapshot-store.ts` (completeness, build, freeze, reopen rule, revision, load for reading, verify hash). Tests: `packages/db/test/enterprise-snapshot-store.test.ts` (build, stable hash, refuse incomplete with units, frozen immutable, reopen rule, revision lineage, self-freeze refused, indicators carried).
- [ ] 4. API: module `fnd` gets `enterprise-snapshot.controller.ts`: `buildEnterpriseSnapshot`, `freezeEnterpriseSnapshot`, `listEnterpriseSnapshots`, `getEnterpriseSnapshot` (through `scripts/contract-patch.mjs`, then `npm run contracts:generate`); audit, outbox, idempotency, versioned freeze; error codes. Tests: `apps/api/test/fnd/enterprise-snapshot.test.ts`.
- [ ] 5. Report engine: `ReportFormBundle.snapshotProvider`, generate path, `EnterpriseSnapshotProvider` in the API reports module (registered by the enterprise seam), bundles name it. Tests: report-engine enterprise test (snapshot present gives LIVE data with revision, none keeps illustrative and the DEMO stamp), provider unit test.
- [ ] 6. Web: DIS screens `DIS-30` (build and review the enterprise period), `DIS-31` (snapshot detail and freeze) in `apps/web/src/screens/dis/enterprise/`, i18n parts `ent3a.{vi,en}.json`; RPT shows the snapshot used by a draft. Tests: vitest of the screens.
- [ ] 7. Shared suites (entries only, not run until the gate is free): isolation, reachability, command conformance counts, outbox consumers, workers and jobs (none added), negative authz matrix; design rows (implementation plan, traceability, backlog).
- [ ] 8. Docs: `docs/ent-snapshot.md` (what is built, the hook for HOME/BAN/HPM), `docs/fnd-funding-model.md` section 13 update, `docs/report-engine.md` note.
- [ ] 9. Verify: tsc per package, lint, i18n lint, scan-files, then the heavy suites once the gate is free.
- [ ] 10. Codex review (or the independent read-only subagent review when Codex is rate limited), triage, fixes.

## Risks

- The pre-push gate runs on another checkout until about 75 minutes after the start of this lane: no DB jest, no whole suites. DB and API tests are written first and run through the serialized lane once the gate is free.
- `period_snapshot_figure` has no class CHECK per pack, so the two appended kinds rely on the reader to treat class `TOTAL` apart; the reader excludes it from every class sum.
- Hash compatibility: only an optional member is added; `fnd-public-golden` and DIS snapshot hashes (schema 1) are untouched.
