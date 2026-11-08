# Plan of lane BAN-1 (committee workspace)

Branch `lane/ban1`, worktree `D:\PIS-ban1`, migration block 2520-2539. Design record: `docs/committee-workspace.md`.

| Step | State | Where |
|---|---|---|
| Block registered, roles, policy rule, KPI definitions, alert types, pure rules, kernel tests | done | `packages/kernel/src/committee*.ts`, `packages/db/src/system-roles.ts` |
| Migrations V2520 to V2523, stores, port and core reader | done | `db/migrations`, `packages/db/src/committee-*.ts`, `province-facts.ts` |
| Contract (13 operations, schemas, 2 error codes, screens BAN-01 to BAN-07) | done | through `scripts/contract-patch.mjs`, generated contracts |
| API module, report-engine form `BAN-MEETING-PACK` with read guard | done | `apps/api/src/modules/committee`, `reports/form-registry.ts` |
| API tests (db lane), authz matrix, isolation | written, run through the db lane | `apps/api/test/committee`, `test/isolation`, `test/authz` |
| Spec BAN.md, story ST-BAN-001, traceability, backlog, test cases, navigation | done | `Design/MACHVON_Design` |
| Web screens BAN-01 to BAN-07, PWA card | done | `apps/web/src/screens/ban`, `apps/web/src/pwa/screens` |
| Phone card | done | `apps/mobile/lib/features/dashboard` |
| Lint chain, typecheck of all workspaces | done, green | |
| Codex review (model gpt-6-astra) with triage | done, see below | |

## Codex review dispositions

1. P1 meeting pack reachable through the report engine with report permissions only: valid. Fixed: the provider refuses a caller without `committee.read` over the whole tenant, and the form registry carries a read guard (`REPORT_FORMS.guard`) applied to drafts, copies, files, lists and the check, approve, issue, deliver and answer steps. Regression test in `apps/api/test/committee/committee.test.ts`.
2. P2 prior-year line with an unknown amount turned into zero: valid. Fixed (`has(key)` distinguishes an absent line, zero, from a null amount, unknown). Regression test: the coverage of last year drops to 2 of 3 and the figure is withheld.
3. P2 age of reports judged on the snapshot day: valid. Fixed with `evaluatedOn` on the facts (the day asked for), used by the reporting rules; kernel regression test.
4. P2 audit cursor lost microseconds: valid. Fixed (cursor in microseconds). Regression test pages three rows that share a millisecond.
5. P2 pack generated for the snapshot day instead of the day shown: valid. Fixed (the pack answer names the requested day for generation, the screen uses it). Regression test on `generation.period.day`.

Owner decisions applied: real core first, no simulation label; decide by governance criteria; no scope cut.

Left for other lanes: the alert centre of HOME does not read `committee_alert` yet; the assurance level of the session (SSO, MFA) is a hook (`COMMITTEE_ASSURANCE`); the HTML pages of the design (`build-cli.mjs --pages`) need the `marked` package that is not installed in the worktree and are rebuilt by the lead.
