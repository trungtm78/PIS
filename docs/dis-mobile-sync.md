# The weekly report on the phone: parity, sync rules and the queue (ST-DIS-017)

Module documents: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (MOB-13..21), `MOB.md`, `04_Thiet_ke_co_ban.md` (PowerSync, A1). Contract pack for the mobile group: `docs/dis-mobile-contract.md` (generated). Sync rules (a reference, not yet deployable): `infra/powersync/sync-rules.reference.yaml` (generated). Runbook: `docs/runbooks/infra/powersync.md`.

## What is done here (the server side)

- **Parity of the commands.** The phone files the weekly report with the same commands, DTO (`ReportDraft`) and validation as the web, plus `client_operation_id` on the creation and `Idempotency-Key` and `If-Match` on every command. The test `report-decision.test.ts` ("web and mobile file the same report") files FX-DIS-001 from both, compares the structure of the two reports, accepts both and checks the total of 420 million and the 300 million registered for next month.
- **The registration for next month.** When a report is accepted, the job `dis.registration` (consumer of `report.accepted.v1`) turns the next-month cells into the REGISTERED rows of the month after the period, a new revision of each key, with the CTMTQG subset and the report as source (CAP task TK-CAP-009-2, which ST-DIS-004 left to the decision). A closed year or a project that no longer reports skips the registration and says so in the audit row; the acceptance stands.
- **Sync rules and their proof.** The rules are a reference of what may sync, written as data (`dis-sync.ts`) and the same queries run on PostgreSQL in `mobile-sync.test.ts`: a member gets the projects of their scope (a subtree or a project), the periods that take a report, their own drafts and the last revision handed in, and nothing else; no line of a snapshot, no amount of the investment; the money columns are marked read only; the token of another tenant reaches nothing; a revoked scope row empties every bucket.
- **Replay of the queue.** A draft made offline and sent twice is one revision (`client_operation_id`); a save written against a version the server has moved past is 409 `VERSION_CONFLICT`, which leaves the server as it was; a command queued under one tenant and sent under another finds nothing (404) and changes nothing.

## What waits for the mobile group and the environment (DONE_PENDING_ENV)

- The Flutter queue, the conflict screen and MOB-13..21: AC-ST-DIS-017-2 and AC-ST-DIS-017-3 on the device (the phone itself must not send under the new tenant, remove the local data and block the switch while the queue is not empty) and AC-ST-DIS-017-5 (`UI-MOB-13..21`).
- PowerSync itself: the publication, the `machvon_sync` grants and the proof on a real service (AC-ST-DIS-017-4 end to end, `UAT-NFR-TENANCY-07` on the device) wait for the spike ST-KERNEL-002. No claim about sync isolation is made beyond what PostgreSQL proves for the queries.
- The projection of the grants into `sync_membership_scope` (MOB owns the table, ADM updates it by event) is not built: the tests insert the rows. Until it exists no phone gets a scope.

## Assumptions

- The token of the phone carries `sub`, `tenant_id`, `membership_id` and `scope_version`; the parameter query reads `membership_id` from it. A revoked scope is a row with `effective_until` set (the table has no `revoked` column).
- The reports of a locked period do not sync, so a phone that is offline over a lock finds its queued commands refused with 409 `PERIOD_LOCKED` when it reconnects.
- The registration for next month is made at acceptance, not at submission: a registration is a plan only once a reviewer has accepted the report.
