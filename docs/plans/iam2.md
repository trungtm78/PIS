# IAM-2 plan (permanent delegation, acting on behalf, period scope, Word export)

Lane branch `lane/iam2`, migration block 2460-2479 (V2460-V2464 used). Plan section "Dot 4 item 7".

## Decisions (owner rule 2026-11-08: deepest governance, no scope cut)

1. A permanent delegation is a `delegation_grant` of kind PERMANENT; `valid_until` is its review date, so every reader of delegations (approval engine, door, signing authority) honours it unchanged and a delegation not reviewed in time stops at once.
2. The delegator only requests; a second person (not delegator, not delegate, by person) approves; the approval makes the delegation.
3. Loops of delegations are refused between persons over overlapping permissions, in both kinds.
4. Acting on behalf is a request plus second approver, data entry only (no decision verbs, no iam/adm/system), at most 8 hours, selected by header `X-Acting-As`, judged on the person's access narrowed to the listed permissions; both identities in every audit row (`on_behalf_of_id` and `acting_as`).
5. Period scope: `role_grant_period_scope` for role grants, `period_codes` for delegations; the weekly report commands ask the gate; no limit means unchanged behaviour.
6. Word export: one converter `docxOf` over the same `ExportDocument` as CSV/XLSX/PDF, same permission, audit and caps (PDF cap); exporters extended: DIS, CTR analytics, home figures, appraisal, procurement workflow, MNE packages, BI. Not extended: S-curve (series of a chart), audit log export (raw log).

## Steps

- [x] kernel rules and tests; migrations V2460-V2464; stores and tests
- [x] contract, API controllers, guard and interceptor, authz matrix, isolation fixtures
- [x] web screens ADM-25..27 with tests; i18n; design rows
- [x] Word converter and exporters
- [x] Word tests, web format pickers
- [x] gate tests of the lane
- [x] Codex review and dispositions

## Codex review dispositions (model gpt-6-astra, review of main..HEAD)

- P1 acting grants could include `report.review` (a decision): valid. Fixed: the decision verbs now include review, verify, confirm, lock, publish, finalize (kernel, table check of V2462, web form); tests in kernel, db and API.
- P1 period check on a different grant than the project check: valid. Fixed: `accessForPeriod` removes the grants whose period limit does not cover the period, and the project scope is judged on that access (create, edit, submit, decide, import, export); regression test in dis/report-decision and kernel.
- P2 period-scope list cut before visibility filtering: valid. Fixed: batches are read on until a page and one more are visible, so the cursor and the end are true.

## Gate suites

Own suites run through the db lane: db iam2/delegation/jobs/rls/ranges (166 passed), API adm/iam2, dis/report-export, dis/report-decision, bi-exports. Shared suites (isolation, conformance, outbox consumers, negative matrix, workers) are run once by the lead on the merged tree; the entries (isolation fixtures and probes, authz fixtures, conformance counts 674/439) are added.
