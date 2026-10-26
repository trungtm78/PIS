# AUD-1: the inspection and audit engagements (ST-AUD-001)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/AUD.md` (section 3.1, BR-AUD-10). Migration: `V1320__aud1_engagement_legal_hold.sql`. Screens AUD-02 (list) and AUD-03 (file).

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `createAuditEngagement` | `POST /audit-engagements` | `aud.engagement.manage` | Registers an engagement under the decision of an authority, with a period, a coordinator and a scope of units, projects and contracts. It starts PLANNED. |
| `startAuditEngagement` | `POST /audit-engagements/{id}/start` (If-Match) | `aud.engagement.manage` | PLANNED to ONGOING on the given day, and places the legal hold on the scope. |
| `endAuditFieldwork` | `POST /audit-engagements/{id}/fieldwork-end` (If-Match) | `aud.engagement.manage` | ONGOING to AWAITING_CONCLUSION on the given day. The hold stays. |
| `cancelAuditEngagement` | `POST /audit-engagements/{id}/cancellation` (If-Match) | `aud.engagement.manage` | Cancels it with a reason of at least 10 characters, and releases the hold. |
| `listAuditEngagements` | `GET /audit-engagements` | `aud.read` and the scope of the reader | The engagements the reader reaches, keyset paged. |
| `getAuditEngagement` | `GET /audit-engagements/{id}` | `aud.read` and the scope of the reader | The file of one engagement; `404` outside the scope of the reader. |

## The state machine (AC-ST-AUD-001-3)

`ENGAGEMENT_EDGES` in `packages/kernel/src/aud-engagement.ts` is the only place that names the edges: PLANNED to ONGOING or CANCELLED, ONGOING to AWAITING_CONCLUSION or CANCELLED, AWAITING_CONCLUSION to CONCLUDED or CANCELLED, CONCLUDED to CLOSED. Any other step is `409 ENGAGEMENT_STATE_INVALID`. The conclusion and the closure belong to later stories of AUD; the machine already refuses them from PLANNED, and the table keeps the dates that fit each state (`audit_engagement_started_chk`, `_fieldwork_chk`, `_dates_chk`, `_cancel_reason_chk`).

A cancellation after a conclusion exists is `409 CONCLUSION_EXISTS`.

## The decision and the coordinator (AC-ST-AUD-001-1)

- The decision document is an INCOMING or REFERENCE document that is EFFECTIVE; anything else is `422 DECISION_DOCUMENT_NOT_EFFECTIVE`.
- The coordinator is an Active membership of the tenant (`coordinator_user_id` stores the membership id).
- The code of the engagement is unique in the tenant: `409 ENGAGEMENT_CODE_DUPLICATE`.

## The scope and the legal hold (AC-ST-AUD-001-2, BR-AUD-10)

- A scope item is a unit, a project or a contract, once (`audit_scope_item_scope_uq`, NULLS NOT DISTINCT). A target that does not exist or belongs to another tenant is `404 RESOURCE_NOT_FOUND`, the same answer for both, so the tenant boundary is not probed (BR-IAM-01); the registry's `422 SCOPE_OUT_OF_TENANT` is deliberately not used.
- Starting places one `legal_hold` over the whole scope in the same transaction. Its kind is the kind of the engagement (INSPECTION or AUDIT) and RESOURCE when the scope mixes kinds.
- `machvon.legal_hold_blocks(type, id)` was replaced in V1320: the ids of a hold are matched by what they are, a contract is held with its project, a unit with the units above it, a project and a contract with the units above their owner, and a dossier with its subject or its unit. The purge guard (`assertNotOnHold`) therefore stops the disposal of anything under an engagement; DOC-013 must call it for the disposal of a dossier.
- Cancelling releases the hold in the same transaction, by the system (`WORKER_MEMBERSHIP_ID`) so the four-eyes rule of the table (`released_by <> placed_by`) holds.

## Who sees what

- Reads and writes check the permission over the unit of every scope item (`reaches`); an engagement is listed only when the reader reaches its whole scope (`engagementScope`, which later AUD stories must reuse).
- The data are CONFIDENTIAL. The audit trail and the events (`aud.engagement.created.v1`, `.started.v1`, `.fieldwork_ended.v1`, `.cancelled.v1`) carry codes and ids, never the title, the authority or the reason.

## The screens

- AUD-02 lists the engagements with their status and hold and offers the registration dialog (code, type, authority, decision, title, period, coordinator, scope picker) to whoever holds `aud.engagement.manage`.
- AUD-03 shows the decision, the period and milestones, the hold and the scope, and offers the commands that fit the status. A missing engagement and one outside the scope read the same.
- The scope items of the contract stay open in the OpenAPI (a tightened schema was a breaking change for `contracts:compat`), so the client casts them in `hooks.ts`.

## Tests

`packages/kernel/test/aud-engagement.test.ts`, `packages/db/test/aud-engagement-store.test.ts`, `apps/api/test/aud/engagement.test.ts`, the authz negative matrix and the tenant-isolation suite (all four commands and both reads), `apps/web/src/screens/aud/*.test.*`, and `apps/web/e2e/aud-engagement-flows.spec.ts` with the visual regions of AUD-02 and AUD-03.
