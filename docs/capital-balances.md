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

## Evidence

- `packages/db/test/cap-plan-publication.test.ts`: stores, ledger, drift, 12-loop race of two publications of one plan, 8-loop race of
  two revisions of one plan code, 15-loop race of a lowering revision against a commitment on the last of a line, opposite-order
  deadlock check.
- `apps/api/test/cap/plan-publication.test.ts`: HTTP flows, four eyes, events, PRJ consumer chain, cancel with open obligations.
- `apps/api/test/cap/plan-approval-workflow.test.ts`: the approval as a workflow under the signed tenant context (NFR-TENANCY-08).
- `packages/db/test/cap-plan-revision-store.test.ts` and `apps/api/test/cap/plan-revision.test.ts` (ST-CAP-004): the copy, the pending-revision race (6 loops of 4 racers), the difference-only ceiling, the as-of reads on both sides of a revision, the scope and the HTTP refusals.
