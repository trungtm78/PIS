# Plan of lane BAN-1 (committee workspace)

Branch `lane/ban1`, worktree `D:\PIS-ban1`, migration block 2520-2539. Design record: `docs/committee-workspace.md`.

| Step | State | Where |
|---|---|---|
| Block registered, roles, policy rule, KPI definitions, alert types, pure rules, kernel tests | done (commit cd6e185e) | `packages/kernel/src/committee*.ts`, `packages/db/src/system-roles.ts` |
| Migrations V2520 to V2523, stores, port and core reader | done | `db/migrations`, `packages/db/src/committee-*.ts`, `province-facts.ts` |
| Contract (13 operations, schemas, 2 error codes, screens BAN-01 to BAN-07) | done | through `scripts/contract-patch.mjs`, generated contracts |
| API module, report-engine form `BAN-MEETING-PACK` | done | `apps/api/src/modules/committee` |
| API tests (db lane), authz matrix, isolation, conformance counts | in progress | `apps/api/test/committee` |
| Spec text BAN.md, story, traceability, backlog, test cases | to do | `Design/MACHVON_Design` |
| Web screens (dashboard, attention, pack, tracker, alerts, roster, view audit), i18n parts, states matrix | to do | `apps/web/src/screens/ban` |
| PWA card, phone card | to do | `apps/web/src/pwa`, `apps/mobile/lib/features/dashboard` |
| Gates, Codex review with triage | to do | |

Owner decisions applied: real core first, no simulation label; decide by governance criteria; no scope cut.
