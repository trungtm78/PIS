# AUD-4: the ledger of the money recovered and the overview (ST-AUD-004)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/AUD.md` (sections 3.4, 3.6, 5, BR-AUD-05, BR-AUD-10, BR-AUD-11). Migration: `V1323__aud1_recovery_ledger.sql`. Screens AUD-08 (`/aud/aud-08?engagement=<id>`, the ledger and the reconciliation with PAY) and AUD-01 (`/aud/aud-01`, the overview).

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `linkAuditRecovery` | `POST /audit-recommendations/{id}/recovery-links` (If-Match) | `aud.recovery.record` over the scope of the engagement | Writes a line of the ledger by hand: a remittance of the Treasury or a manual evidence, with a document in force. |
| `reverseAuditRecovery` | `POST /audit-recovery-links/{id}/reversal` | `aud.recovery.record` | Writes a line of the opposite sign against a line; nothing is changed or deleted. |
| `getAuditRecoverySummary` | `GET /audit-engagements/{id}/recovery-summary` | `aud.read` | The money recommended, recovered and left, the two rates, the recommendations and the exceptions that wait. |
| `listAuditRecoveryLinks` | `GET /audit-engagements/{id}/recovery-links` | `aud.read` | The lines with what was recovered up to each and what was left after it. |
| `getAuditOverview` | `GET /audit-overview` | `aud.read` | The tiles of AUD-01 over the engagements in the scope of the caller and a watch list of the engagements, the most overdue first (at most 50). |

## The ledger (AC-ST-AUD-004-1, BR-AUD-05)

- `audit_recovery_link` is append-only: a trigger refuses UPDATE and DELETE (`23514`). A line of the opposite sign (`reversal_of_id`) reverses another; a line is reversed once (`409 RECOVERY_ALREADY_REVERSED`).
- `audit_recommendation.recovered_vnd` is kept by a trigger that runs after each insert, under the lock of the recommendation, so no code path can drift from the ledger. A line may only be written against a financial recommendation (`audit_recovery_link_financial_guard`).
- `recovered_vnd` never exceeds what was recommended (`409 RECOVERY_EXCEEDS_RECOMMENDATION`, with the amount, what was recovered, and what is left in the problem). The check is the kernel's `assertWithinRecommendation`; the database check stays as the last line.
- Amounts are decimal strings in dong; sums are bigint. The two rates are `numerator / denominator` of the money and of the recommendations closed; the percent is `null` (shown as "not applicable", never 0%) when the denominator is 0.

## The lines (AC-ST-AUD-004-2, BR-AUD-10)

- By hand only the sources `TREASURY_REMITTANCE` and `MANUAL_EVIDENCE` are accepted, and each needs a document that DOC holds in force (`422 EVIDENCE_REQUIRED`). The sources `PAY_RECOVERY` and `PAY_DEDUCTION` come only from PAY.
- A reversal copies the evidence of the line it reverses and needs a reason of at least 20 characters. When the engagement is in follow-up and the reversal takes a closed or fully recovered recommendation under what was recommended, the recommendation goes back to IN_PROGRESS (`reopened_at`, the verifier is cleared, `aud.recommendation_reopened` is audited). On a closed engagement the line is written and nothing is reopened.

## PAY (AC-ST-AUD-004-3)

`PayRecoveryConsumer` (`aud-pay-recovery`) reads `pay.recovery.recorded.v1` and `pay.recovery.reversed.v1` from the outbox of the platform. A recovery is linked when the event names a recommendation of the tenant; the same event twice is a duplicate and writes nothing. What the ledger cannot take is kept once for each event and kind in `audit_recovery_exception` (`OVER_RECOVERY`, `UNMATCHED_REVERSAL`, `NOT_APPLICABLE`) and shown on AUD-08; it is never lost and never forced in. A recommendation of another tenant is ignored.

The job `aud-recovery-reconcile` (hourly tick, run in the 02:00 hour of Vietnam) compares the sum of the lines with `recovered_vnd` of each recommendation, raises the gauge `aud_recovery_reconcile_mismatch_total` and the event `aud.recovery.reconcile_mismatch.v1` for any difference, and audits `aud.recovery_mismatch_detected`. Alerts: `AUD_RECOVERY_RECONCILE_MISMATCH` (critical) and `AUD_RECOMMENDATION_REOPENED` (warning); the runbooks are in `docs/runbooks/alerts`.

## Who sees what (AUD 2, BR-AUD-11)

The summary, the lines and the overview are read through the scope of the engagement; an engagement out of the scope is a `404` like one that does not exist, and the overview counts only what the caller reaches. The trail and the events keep ids, codes and amounts, never the words of the reason.

## The screens

- AUD-08 shows the money, what is left, and the two rates with their numerators and denominators; the recommendations with a button per row; the lines of the ledger (source, amount with sign, day, recovered up to it, left after it, a mark on a reversed line and on a reversal); and the exceptions of PAY in words. The dialogs refuse an amount above what is left before sending it and tell the refusals of the server in words.
- AUD-01 shows the tiles (engagements, recommendations open and overdue, the money, the rates), a note when recoveries of PAY wait for the accountant, and the watch list with links to AUD-03 and AUD-08.
- A button is shown only to the person it fits (`aud.recovery.record`, and a tenant that is not read only); the server decides again on every request.

## Tests

`packages/kernel/test/aud-recovery.test.ts`, `packages/db/test/aud-recovery-store.test.ts` (including the triggers, the PAY outcomes and the reconciliation job), `apps/api/test/aud/recovery.test.ts`, `apps/api/test/aud/pay-recovery.consumer.test.ts`, the authz negative matrix and the tenant-isolation suites, `apps/web/src/screens/aud/recovery/*.test.ts(x)`, and the browser flows `apps/web/e2e/aud-recovery-flows.spec.ts`.

## Decisions kept in `TODOS.md`

PAY must publish `pay.recovery.recorded.v1` and `pay.recovery.reversed.v1` with the recommendation id (cross-group assumption); the exceptions stay OPEN until a command to resolve them exists; the overview is an additive endpoint for AUD-01.
