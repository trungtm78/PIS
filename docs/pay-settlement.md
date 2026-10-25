# The settlement of a project, a year or a contract (ST-PAY-009)

PAY 3.5, UAT-AC339, UAT-AC66, UAT-PLAN-21. Screen PAY-15 (the workspace: the list of settlements, the figures, the deadline and the commands). The forms of the settlement (`generateSettlementForms`, PAY-16) are another story.

## The life of a settlement (`settlement_revision`)

```
DRAFT ─submit→ SUBMITTED ─take up→ VERIFYING ─verify→ VERIFIED ─close→ CLOSED ─next revision→ SUPERSEDED
                   └──────── return ───────┴──→ RETURNED ─refresh→ DRAFT   (a returned settlement can also be sent again)
```

| Command | Operation | Permission | What it does |
|---|---|---|---|
| open | `openSettlement` `POST /settlements` | `settlement.open` | A draft for a project, a scope (ANNUAL needs `fiscal_year`, CONTRACT needs a `contract_id` of the project, PROJECT neither) with the figures read from the ledgers. The whole project is settled when it is COMPLETED; a year or a contract while it is IMPLEMENTATION, SUSPENDED or COMPLETED (422 `PROJECT_STAGE_INVALID`). One settlement is worked on for a project, scope, contract and year (409 `SETTLEMENT_OPEN_EXISTS`); a CLOSED one gives way to the next revision, which names it in `supersedes_id` and makes it SUPERSEDED. |
| refresh | `refreshSettlementFigures` | `settlement.open` | Reads the figures again while the settlement is DRAFT or RETURNED (a returned one becomes DRAFT and loses its submission, so the deadline is given again). |
| submit | `submitSettlement` | `settlement.submit` | `submitted_on` (a real day, not after today in Vietnam) fixes the group of the project and the deadline (below). |
| verify | `recordSettlementVerification` | `settlement.verify` | `VERIFYING` (taken up, from SUBMITTED), `VERIFIED` (from VERIFYING) or `RETURNED` (from either), with the findings and the references to the conclusions of AUD. Whoever sent the settlement does not verify it (403 `SELF_APPROVAL_DENIED`). |
| exception | `approveSettlementException` | `settlement.exception.approve` | On a VERIFIED settlement that owes (422 `NO_OUTSTANDING_TO_EXCEPT`), once, with a reason and a clean document; not by who opened or sent the settlement. |
| close | `post_settlements_id_close` | `settlement.close` | On a VERIFIED settlement, with `decision: "approve"`, a decision document of the tenant (422 `DECISION_DOCUMENT_REQUIRED`), nothing owed or the exception approved (422 `SETTLEMENT_HAS_OUTSTANDING`), by someone other than who opened or sent it. The figures are never changed: the exception is what lets it close, not a zero. |

Reads: `get_resources_settlement_revision` (list, newest first, filters `status` and `project_id`, keyset cursor on the creation time) and `get_resources_settlement_revision_id`, in the scope of the project (`settlement_revision.read`). Each settlement says what the caller may do with it now (`actions`); `audit_finding_refs` is null for who does not hold `aud.read`.

## The figures (UAT-PLAN-21)

From the ledgers of the contracts in scope (all the contracts of the project, or the one contract): `settled_amount_vnd` is the gross that was paid (a reversal takes its own back), `outstanding_vnd` is the accepted work not paid plus the retention still held, `unrecovered_advance_vnd` is the advance disbursed less the advance recovered (the journal of the advance, reversals counted). A figure below nothing is a defect of the ledger and is refused. A settlement of a **year** reads what was paid in that year (Vietnam time) as settled, and what was owed and unrecovered at the end of it.

## The verification deadline (BR-PAY-15, CXN-09, UAT-AC339)

`verification_due_on = submitted_on + days(group)`, the group being that of the project on the day of the submission and the days those of the rule `PAY_SETTLEMENT_DEADLINE` (key `VERIFY_DEADLINE`, master data, platform only) in force on that day. A project with no group is 422 `PROJECT_GROUP_MISSING` (the table lets a project past its concept have none only after it was stopped); no rule in force, or one with no row for the group, is 422 `DEADLINE_RULE_UNCONFIRMED`. The days, the group and the version of the rule are kept on the settlement: changing the rule afterwards does not move a deadline that was given. The baseline ships the fixture of the acceptance tests (QTQG and A 270, B 180, C 120 days) flagged `awaiting_confirmation` with `cxn: CXN-09`: it is not a regulation and the screen says so until the owner publishes the confirmed rule.

## What the database holds (V1569)

Who sent it, who verified it, the exception and the close are on the row; a settlement that was sent has its group, its deadline and the rule it came from; one settlement is worked on for a project, scope, contract and year (partial unique index); the status moves along the edges above (a trigger); the figures change only in DRAFT or RETURNED; the deadline of a sent settlement and an approved exception are not changed; the person who verifies is not who sent it, and the one who approves the exception or closes is neither who opened it nor who sent it (checks); `settlement_revision_close_chk` (V002) keeps a settlement that owes from closing without the exception; a settlement is never deleted.

## Events and the job

Audit rows `settlement_revision.opened`, `.figures_refreshed`, `.submitted`, `.verification_verifying|verified|returned`, `.exception_approved`, `.closed` (the words of the person are in the audit row, never in an event) and events `pay.settlement.opened.v1`, `.submitted.v1`, `.verified.v1`, `.returned.v1`, `.closed.v1` (ids, scope, figures, deadline). The job `settlement-deadline` (06:00 Vietnam time) reminds a settlement that is waiting for its verification 30 and 7 days before its last day (`pay.settlement.deadline_approaching.v1`) and reports it once when the day has passed (`pay.settlement.overdue.v1`, which the issue intake of ISS answers by opening one issue); each stage is remembered on the row. Gauge `pay_settlement_overdue`, alert `PAY_SETTLEMENT_OVERDUE` (`docs/runbooks/alerts/PAY_SETTLEMENT_OVERDUE.md`).

Browser flow: `apps/web/e2e/pay-settlement-flows.spec.ts`; visual region PAY-15 (title alone above the workspace).
