# Capital balances and the capital ledger (ST-CAP-003)

What the publication of a capital plan writes, and what every later story of the capital chain (reservation, commitment, payment, reallocation,
extension, year close) may rely on and must keep. It adds to `docs/money-integrity.md`, which holds the rules shared by every ledger.

## The three things that hold capital

| Thing | Table | Written by | Meaning |
|---|---|---|---|
| Appropriation | `appropriation` | ST-CAP-001 (register), ST-CAP-002 and ST-CAP-003 (the allocated total) | Capital assigned by a decision document. `allocated_total_vnd` is the ceiling already taken by live plans. |
| Plan line | `allocation_line` (in `plan_version`, in `capital_plan`) | ST-CAP-002 (drafting) | A project's share of one appropriation in one revision of a plan. Immutable once the plan leaves DRAFT. |
| Balance | `allocation_balance` | ST-CAP-003 (publication), then the later stories for `reserved`, `committed`, `disbursed` | The running state of the **line in force**: allocated, reserved, committed, disbursed. |
| Ledger | `capital_ledger_entry` | the commands that move capital | Append-only explanation of every move of a balance. |

## Life of a plan revision

```
DRAFT --submit--> IN_REVIEW --approve--> APPROVED --publish(+decision document)--> PUBLISHED --(next revision published)--> SUPERSEDED
                     |  \--return--> DRAFT (reason kept, submitter cleared)
                     \--reject--> REJECTED (final; its ceiling is given back)
```

- `capital_plan.status` and the status of every `plan_version` of the plan move together, so the database guard of the lines (a line is
  edited only while its version is DRAFT) holds from IN_REVIEW on.
- Four eyes: the person who created a plan or submitted it never decides it (`SELF_APPROVAL_DENIED`, judged before the state) and never
  publishes it. The approver may publish what they approved. `capital_plan_sod_chk` and the guard trigger (V1363) repeat it in the database.
- Every step judges the unit of the plan (`scope_unit_id`) against the grant that holds the permission (403 `SCOPE_DENIED`).

## Publication (`post_plans_id_publish`), in one transaction

1. Locks, always in this order: the plan row (and the published revision it replaces) by id, then the `appropriation` rows by id, then the
   `allocation_balance` rows in `lockLedgerRows` order. The drafting of ST-CAP-002 and the decision on an appropriation revision lock in the
   same order, so none of them deadlocks with a publication.
2. Judges: the plan is APPROVED (`PLAN_NOT_APPROVED`), the decision document stands (`DECISION_REQUIRED`), the years are open
   (`FISCAL_YEAR_LOCKED`), the national project code rule for the funded projects of the pipeline (`NATIONAL_CODE_REQUIRED`, CXN-01), the
   revision it replaces is still the one in force (`PLAN_CHANGED_SINCE_PROPOSAL`), and no line ends below what is committed and disbursed on it
   (`REVISED_BELOW_COMMITTED`, BR-CAP-05, every such line is listed).
3. Writes: the replaced revision becomes SUPERSEDED, the new one PUBLISHED with its document and `effective_at`; for every line a balance is
   **created** (no predecessor) or **moved** to the new line with the new `allocated_vnd`; one `ALLOCATE` or `REDUCE` entry is appended for the
   difference to the balance (nothing when it is unchanged; a dropped line is reduced to nothing). Entries carry
   `source_ref_kind = 'CAPITAL_PLAN'`, `source_ref_id = <plan id>`, so the dedupe key makes a second posting impossible.
4. Active `fund_reservation` rows of a line that moved follow the balance to the new line.
5. Emits `capital.plan_published.v1` once (`event_key = capital_plan:<id>:published`); the project register moves the funded projects of the
   pipeline to BUDGETED as the system actor.
6. Checks, inside the transaction, that ledger and balances agree for every touched project (`balanceDrift`); if not, nothing stays
   (`BalanceDriftError`, metric `cap_balance_drift_vnd`).

## Invariants a later story relies on

- **I1 line identity.** A line is the same line in two revisions when project, appropriation, bucket and source year are equal
  (`lineKey`). The balance row follows it: its `id` is stable, its `allocation_line_id` is the line of the revision in force. To find the
  balance of a project, read the line of the PUBLISHED plan and join `allocation_balance` on it, then lock the balance by `id`.
  A line of a SUPERSEDED plan has no balance (except a dropped line, whose balance stays on it with `allocated_vnd = 0`).
- **I2 floor.** `allocated_vnd >= committed_vnd + disbursed_vnd` at all times (CHECK `allocation_balance_revised_ge_committed_chk`).
  Reserved is not in the floor (AVC judges it).
- **I3 ledger equals balance.** Per (project, appropriation of the line): the net of `ALLOCATE (+)`, `REDUCE (-)`, `TRANSFER_IN/OUT`,
  `EXTEND_IN/OUT` entries, a `REVERSAL` undoing the entry it names, equals the sum of `allocated_vnd` of the balances of those lines.
  `CapPlanPublicationStore.balanceDrift` is that check (empty list = `cap_balance_drift_vnd` 0); the nightly reconcile job (`capital.balance-reconcile`) is to call it.
  A story that adds an entry type that moves `allocated_vnd` adds it to `ALLOCATED_EFFECT_SQL`.
- **I4 append-only.** The application role cannot UPDATE, DELETE or TRUNCATE `capital_ledger_entry` or DELETE or TRUNCATE
  `allocation_balance`. A correction is a `REVERSAL` entry (once per entry, unique index on `reversal_of_id`). `ALLOCATE`/`REDUCE` entries
  name their line and project (CHECK).
- **I5 one writer per column.** `allocated_vnd` of a balance is written only by publication (and by the reallocation and extension stories
  through the same locks). `reserved/committed/disbursed` are written only with the balance row locked (`lockLedgerRows`,
  `debitBalance`/`creditBalance`), in the same transaction as the entry that explains them.
- **I6 allocated total.** `appropriation.allocated_total_vnd` is the sum of the lines of the live plans (DRAFT, IN_REVIEW, APPROVED,
  PUBLISHED), and changes only with `app.cap_allocation_write = 'on'`. A revision (ST-CAP-004) counts **only its difference** to the
  revision it replaces (`supersedes_id`): drafting adds the difference, REJECT gives the difference back, publication writes nothing because
  the difference is already counted and the replaced lines drop out of the live set. A plan with no `supersedes_id` counts all its lines.
- **I7 publication is the only creator of a balance.** Reservation, commitment and payment never create one.

## Revision contract for ST-CAP-004

`createCapitalPlanRevision` must: copy the lines of the PUBLISHED revision (`previous_line_id` = the line copied), set `supersedes_id` to the
published revision, take revision = max + 1, and add only the difference to `allocated_total_vnd` (rule I6). Publication refuses a revision whose
`supersedes_id` is not the revision in force (409 `PLAN_CHANGED_SINCE_PROPOSAL`). `previous_line_id` is provenance for the comparison screens;
the balance moves by line identity (I1), not by `previous_line_id`.

## The revision command and the plan as of a date (ST-CAP-004)

`createCapitalPlanRevision` (`CapPlanRevisionStore.create`) follows the contract above in one transaction and one lock order (the source plan
`FOR UPDATE`, no appropriation is touched): it refuses a plan that is not PUBLISHED (409 `PLAN_NOT_PUBLISHED`), a stale `If-Match`
(409 `VERSION_CONFLICT`), a year that is LOCKED (409 `FISCAL_YEAR_LOCKED`) and a plan code that already has a revision in work (DRAFT,
IN_REVIEW or APPROVED, 409 `REVISION_PENDING_EXISTS`; the check is repeated by the unique index and a violation is turned into the same
answer, so two racing requests give one revision and one 409). The plan versions and the lines are copied in one statement with
`previous_line_id`, so a revision is never half copied. The allocated total of the appropriation is not touched by the copy: the difference
is zero until the lines are edited, and the drafting command adds the difference (rule I6).

`getCapitalPlanAsOf` (`CapPlanRevisionStore.asOf`) names a plan by any of its revisions and answers the revision of the same plan code with the
largest `effective_at` up to the moment, among PUBLISHED and SUPERSEDED ones (BR-CAP-10). The moment is `at`: an ISO instant, or a date that
means the **end of that day in Vietnam (UTC+7)**, so "30/6" includes everything in force during 30 June; no `at` means now. A moment before the
first revision in force is 404. Each line carries what the first revision gave the line (`initial_vnd`, found by project, appropriation,
bucket and source year), the difference to the revision in force (`adjustment_vnd`, signed) and what had been paid by the moment
(`as_of_disbursed_vnd`: the DISBURSE entries of the ledger posted up to the moment, less their reversals, not the running balance). Lines are
shown in the scope of the caller (the same scope as `listCapitalPlanLines`), up to a bound with `truncated: true` beyond it.

## Availability control (ST-CAP-005)

`avc_policy` (V002, V1365) holds the thresholds; `CapAvcPolicyStore` drafts, publishes and resolves them, `evaluateAvc` (`cap-avc.ts`) is the rule, `CapAvailabilityStore` reads the figures and commits.

- **I8 one door for a commitment.** A module that commits capital calls `CapitalCommitments.checkAndCommit` (or the store inside its own transaction); it never writes `committed_vnd` itself. The call locks the balance of the line (and all the balances of the appropriation when a policy controls the appropriation) with `lockLedgerRows`, reads under the lock, judges, and moves the balance with its COMMIT entry (`source_ref_kind` CONTRACT for the activation of a contract; a new fact adds its kind to the CHECK and to `COMMITMENT_SOURCE_KINDS`).
- **I9 the rule is judged on whole numbers.** used = reserved (when the policy counts it) + committed + disbursed + the amount asked for; OK below warn, WARN from warn up to and including block, BLOCK above block; an allocation of nothing is BLOCK with ZERO_ALLOCATION. `consumption_pct` is shown rounded down to two decimals and never decides.
- **I10 which policy.** The published policy in force on the Vietnam day of the object, the most specific scope winning (project group, unit, fund source, tenant). A line with no policy is judged by 90 and 100; an appropriation with no policy is not controlled. Two published policies of one scope and object never overlap (database trigger), so the answer never depends on an order.
- **I11 the warning is a fact.** A WARN needs the caller to accept it; the acceptance is written on the ledger entry, in the audit row and in `capital.commitment_posted.v1`.

## Carrying capital over to the next year (ST-CAP-007)

`allocation_extension` (V002, V1366) holds the request; `CapAllocationExtensionStore` asks, decides and applies. An approval is one transaction: the capital leaves the line of the plan year and enters a new line of the next year, and the ledger and the balances are compared before it ends.

- **I12 carried over, not created.** An approved extension appends `EXTEND_OUT` (against the line and the appropriation of the plan year, plan year Y) and `EXTEND_IN` (against the new CARRYOVER line and appropriation, plan year Y+1) with the same amount and the same source (`EXTENSION`, the extension id). The allocated amount of the line of Y falls by the amount; the appropriation of Y keeps its amount and its allocated total, so the capital of Y is not increased and cannot be allocated again. `balanceDrift` counts both entry types (`EXTEND_IN` +, `EXTEND_OUT` -) and must stay empty.
- **I13 what may be carried over.** allocated less committed and disbursed (a reservation is not a commitment; BR-CAP-06 judges it) less what the other open requests of the line already ask for, whole VND; asked at the request and judged again under the balance lock at the decision (422 `AMOUNT_EXCEEDS_UNDISBURSED`). The last day of disbursement is entered from the document and lies in Y+1 (the rule of the day awaits CXN-31).
- **I14 the new line.** Bucket `CARRYOVER`, `is_extended`, `extended_to`, `source_year` = Y, the extension document, in the published plan `CARRYOVER-<Y+1>-<unit>` of the unit of the source plan (created by the first approval that needs it); it draws on an appropriation of origin CARRYOVER whose decision is the approving document. A second approval under the same decision, source year, fund source and level revises that appropriation (amount and allocated total grow) instead of registering another; a project has one carried-over line per such appropriation.
- **I15 a revision of the plan does not put it back.** `CapPlanPublicationStore` judges a line of a new revision against its amount less what `EXTEND_OUT` took off it, and refuses a line below that (`REVISED_BELOW_COMMITTED`); the carried-over capital is never allocated twice.
- **I16 the table is a record.** What was asked for never changes, a request moves forward only, a decision is final and nothing is deleted (trigger and grants of V1366). Requests nobody decided lapse after their last day (`allocation-extension-lapse`, hourly); the capital an approved extension left unused after its last day lapses with the closing of the year (ST-CAP-008).
## Closing a fiscal year (ST-CAP-008)

`fiscal_year_control` (V002, V1367) holds the state of a year; `CapFiscalYearStore` closes, locks, reopens and locks again; `cap-fiscal-year-guard.ts` is the one place the commands ask whether a year takes them.

- **I17 a closed year takes nothing new.** A soft-closed or locked year refuses the plan commands, the appropriation register and the commitment of capital (409 `FISCAL_YEAR_LOCKED`, `state` says which); a soft-closed year still lets capital be carried out of it and paid (`assertYearsNotLocked`), and the year capital is carried into must be open.
- **I18 lapse is a ledger fact.** Locking a year posts one `LAPSE` entry per line in force (source `YEAR_CLOSE`, reference `lock_ref_id`) for allocated less committed and disbursed, and takes the same amount off the balance; `balanceDrift` counts `LAPSE` as -1 and must stay empty. Committed and disbursed capital never lapses. The ceiling of the appropriation is untouched, so lapsed capital cannot be allocated again, and a revision of the plan is judged against the line amount less `EXTEND_OUT` and `LAPSE`.
- **I19 a locked year is reopened, not edited.** Only a reopening (reason of 20 characters, window of at most 168 hours, an approver other than the person who locked it) takes a locked year to OPEN, and the job locks it again when the window ends, lapsing what came back; the control is never deleted and moves only along the closing (trigger of V1367).
## Evidence

- `packages/kernel/test/fiscal-year.test.ts`, `packages/db/test/cap-fiscal-year-store.test.ts`, `apps/api/test/cap/fiscal-year.test.ts` and `apps/web/e2e/cap-year-flows.spec.ts` (ST-CAP-008): the moves of a year, what a soft-closed and a locked year refuse, the pending plans and the active reservations that stop a close, the LAPSE entries and the balances after the lock, the reopening by someone else, the lock again by the job, the revision that does not bring lapsed capital back and the guards of the table.
- `packages/kernel/test/allocation-extension.test.ts`, `packages/db/test/cap-allocation-extension-store.test.ts`, `apps/api/test/cap/allocation-extension.test.ts` and `apps/web/e2e/cap-extension-flows.spec.ts` (ST-CAP-007): the rules of the request, the undisbursed check at the request and at the decision, the carry-over line with its source year and last day, the two entries of one extension, the unchanged capital of the plan year, the revision of the appropriation, the revision of the plan that does not put the capital back, the four-eyes rule, the guards of the table and the lapse.
- `packages/db/test/cap-avc.test.ts`, `cap-avc-policy-store.test.ts`, `cap-availability-store.test.ts` and `apps/api/test/cap/avc-policy.test.ts` (ST-CAP-005): the rule at the edges (a threshold of 100 lets exactly the allocation through), the policy versions and their guards, the resolution by specificity, the commitment through the port with its audit row and event, ZERO_ALLOCATION, the warning and its acknowledgement, the replay, and the races of two requests on one line (25 loops) and of two lines of one appropriation (15 loops).
- `packages/db/test/cap-plan-publication.test.ts`: stores, ledger, drift, 12-loop race of two publications of one plan, 8-loop race of
  two revisions of one plan code, 15-loop race of a lowering revision against a commitment on the last of a line, opposite-order
  deadlock check.
- `apps/api/test/cap/plan-publication.test.ts`: HTTP flows, four eyes, events, PRJ consumer chain, cancel with open obligations.
- `apps/api/test/cap/plan-approval-workflow.test.ts`: the approval as a workflow under the signed tenant context (NFR-TENANCY-08).
- `packages/db/test/cap-plan-revision-store.test.ts` and `apps/api/test/cap/plan-revision.test.ts` (ST-CAP-004): the copy, the pending-revision race (6 loops of 4 racers), the difference-only ceiling, the as-of reads on both sides of a revision, the scope and the HTTP refusals.
