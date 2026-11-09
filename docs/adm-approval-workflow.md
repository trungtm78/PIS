# ADM: the approval workflow engine (ST-ADM-012, slice ADM-1)

A tenant writes and publishes a workflow per business type; a business module starts an approval in its own submit transaction; approvers decide the tasks; the end of the workflow calls the domain command of the owning
module (ADM 3.7, BR-ADM-02, BR-ADM-05, BR-ADM-07). The state lives in three tables (`workflow_version`, `workflow_instance`, `approval_task`, V002 with V1305 guards); the engine is `ApprovalStore`.

## No Temporal yet

The design runs the steps on Temporal. Temporal is not part of this repository yet (TODOS, "DONE_PENDING_ENV"), so the engine follows the definition **in the database**: each decision is one transaction that locks the task
and the instance (`FOR UPDATE`), moves the instance and opens the next step, so two decisions of one task are one 200 and one 409 (`TASK_ALREADY_DECIDED`) and nothing is written twice. `workflow_instance.temporal_workflow_id`
is filled as `appr:{tenant}:{instance}` so that a Temporal runner can take over without a migration. The SLA timers (reminder at 80%, `on_timeout` at 100%) are not run yet: `due_at` is set on every task and the
reminder/escalation job is an open item.

## The definition (BR-ADM-05)

```json
{ "steps": [ { "id": "review", "name": "…", "assignee_rule": { "type": "DOA" }, "min_approvals": 1, "sla_working_hours": 16, "on_timeout": "REMIND", "allow_return_to": "…" } ],
  "terminal": { "approved": "acceptReport", "returned": "returnReport", "rejected": "rejectReport" } }
```

`assignee_rule.type` is `DOA` (the approvers of the band of the matrix), `ROLE_IN_UNIT` (`role_code` and `unit_id`) or `SPECIFIC` (`membership_ids`). `on_timeout` is `REMIND`, `ESCALATE` (with `escalate_to`) or
`EXPIRE`. A step returns only to a step before it, so the only cycles are the returns. Every end maps to the command the business type registered (`report.accept`, `plan.publish`, `payment.approve`, `contract.change`,
`period.reopen`; `BUSINESS_TYPES` in the kernel). `validateDefinition` lists **every** defect with its JSON path and a stable code; the command answers 422 `WORKFLOW_DEFINITION_INVALID` with the first path in `detail` and the
whole list in `defects`, and stores nothing.

## Commands

| command | right | rule |
|---|---|---|
| `createWorkflowDraft` | `adm.workflow.manage` (whole tenant) | the definition is validated; revision = latest + 1 |
| `updateWorkflowDraft` | `adm.workflow.manage` | at the version read; only a draft (409 `WORKFLOW_NOT_DRAFT`); the business type does not change |
| `publishWorkflowVersion` | `adm.workflow.publish` | not by the author (403 `SELF_APPROVAL_DENIED`); the one in force is superseded; instances that run keep their version |
| `decideApprovalTask` | `approval.decide`, **aal2 within 15 minutes** (`x-step-up`, 403 `MFA_REQUIRED`) | below |

`ApprovalService.start(scope, …)` and `.cancel(scope, …)` are what a business module calls inside its transaction. `start` takes the published definition of the business type (422 `WORKFLOW_NOT_CONFIGURED`), resolves the
DoA band when a step uses it (422 `DOA_RULE_NOT_FOUND`: the submit rolls back and the record stays a draft), writes the instance Running pinned to the version and the matrix, opens the first step and writes the event
`adm.workflow_instance.started.v1`. A record has one running instance (409 `WORKFLOW_ALREADY_RUNNING`). A step with fewer eligible approvers than the approvals it needs is 422 `NO_ELIGIBLE_APPROVER`.

### Who gets a task, and who may decide

* DoA step: the members whose grants reach the approver role of the band (their rank at or above it, `approval.decide`, a scope that contains the unit), as `withinDelegation` judges for every other limited command; the people who
  approved an earlier step and the maker are left out. A band with two levels needs two distinct approvals (`requiredApprovals`).
* The assignee decides, or a person the assignee delegated `approval.decide` to (`delegation_grant`): the task then records `decided_by`, `on_behalf_of_id` and `delegation_id`, and the band is judged on the **delegator's** grants.
  Anyone else is 403 `APPROVER_NOT_AUTHORIZED`; the grants are read again at the moment of the decision.
* **The maker is not the checker (BR-ADM-02)**, judged on the user account and not on the membership. A maker who holds the task is refused with 403 `SELF_APPROVAL_DENIED`; the task goes to another eligible person (same `due_at`,
  `adm.approval_task.reassigned.v1`) and that is committed with the refusal (`refuseAfterCommit`). A maker who only tries to decide for someone else is refused and the assignee keeps the task.
* `return` and `reject` need a reason of 10 characters (the schema of the table says so too).

### What a decision does

`advance` (kernel) is the rule: an approval that does not reach the number the step needs leaves the step open; the one that does opens the next step (the other open tasks of the step are cancelled), or completes the instance
as APPROVED after the last. A `return` with `return_to_step` (which must be the step the current one allows) goes back to that step and asks its approvers again; without it the instance ends RETURNED. A `reject` ends it
REJECTED. At an end the final command of the business type is called **in the same transaction** with the key `wf:{instance}:final:{seq}`. If the domain refuses (its transition table is the guard, BR-ADM-07) the instance
completes as `GUARD_REJECTED`, nothing of the record changes, and `adm.workflow_guard_rejected.v1` is written for the operators.

## Business modules register their commands

`FinalCommandRegistry.register(businessType, handler)` (provider `APPROVAL_FINAL_COMMANDS`) replaces the test double that accepts; the handler runs the domain command with the transaction and the key it is given and answers
`APPLIED` or `GUARD_REJECTED`. Until each owning module registers its own, the five business types are bound to the double (cross-module request XM-ADM-01).

## Reads

`get_resources_workflow_version(_id)` (definitions), `get_resources_workflow_instance(_id)` and `get_resources_approval_task(_id)`. Instances and tasks are those of the whole tenant for who holds `adm.workflow.operate`
(or manage), otherwise the ones the person started or has a task in (404 for another).

## ADM-06

`WorkflowScreen`: the business type, the versions with their state, the steps of the chosen one beside what changed from the previous revision (steps added, removed, changed and which fields), the step builder (it
starts from the workflow in force), and the publication with a reason. A refused definition shows the message and the list of JSON paths with a sentence for each code, and keeps the form.

## Operations on a running approval (ST-ADM-013)

`cancelWorkflowInstance` (202) and `reassignApprovalTask` (200) need `adm.workflow.operate` through a grant on the whole tenant (a grant on a unit subtree is 403 `SCOPE_DENIED`), a reason of 10 characters and the `If-Match` of the record read (the instance for the cancellation, the task for the reassignment).

* **Cancel**: only a running instance (409 `WORKFLOW_STATE_INVALID` otherwise). Its pending tasks become Cancelled, the instance Cancelled with the outcome `CANCELLED`, the audit row `workflow.instance_cancelled` carries the reason and `adm.workflow_instance.cancelled.v1` says `by: OPERATOR`. The record in the owning module is **not** touched: the module reads the event (the module that withdraws its own record calls `ApprovalService.cancel`, which ends the instance the same way with `by: MODULE`).
* **Reassign**: only a pending task (409 `TASK_ALREADY_DECIDED`). The new assignee has to be able to decide the task as the step asks, with the grants as they are now: the right `approval.decide` over the place of the approval and, by the rule of the step, the role in the unit, the DoA band, or a place in the list of members. Otherwise 403 `APPROVER_NOT_AUTHORIZED` with the cause (`NOT_AUTHORISED`, `IN_STEP` for a person who has a task or an approval in the step already, `APPROVED_EARLIER` for a person who approved a step before a DoA step); the maker, judged on the person, is 403 `SELF_APPROVAL_DENIED`; the same person or an unknown member is 422. The old task is Reassigned (with the reason), the new one is Pending with the **same deadline and reminder point**, and `adm.approval_task.reassigned.v1` has `reason: OPERATOR`.

### The SLA of a task

A task gets `due_at` and `remind_at` when it is created: the deadline is the working time of the step on the calendar `WORKDAY_VN` and the reminder point is 80 percent of that working time (with no calendar published the deadline is counted in days of 8 hours and the reminder is 80 percent of the elapsed time). The job `approval-sla` (every 5 minutes, `ApprovalStore.sweepSla`, at most 500 tasks per tenant and pass, the oldest deadline first) judges each pending task under the lock of its instance (an instance a command holds is left to the next pass) by the pure rule `slaAction` of the kernel:

| time | `on_timeout` | what happens |
| --- | --- | --- |
| from `remind_at`, before the deadline | any | one reminder `adm.approval_task.reminded.v1` (`kind: BEFORE_DUE`) |
| from the deadline | REMIND | an overdue reminder (`kind: OVERDUE`), repeated every working day |
| from the deadline | ESCALATE | the task is also given to the member `escalate_to` (a new Pending task, `escalated_from_task_id`, its own deadline), once, then reminders as REMIND; `adm.approval_task.escalated.v1`, audit `approval.escalated`. A target who cannot hold the task (the maker, already in the step, no right to decide) is said: audit `approval.escalation_failed` and an overdue reminder with `escalation_failed`; the escalation is not tried again |
| from the deadline | EXPIRE | the task becomes Expired (`adm.approval_task.expired.v1`); when the approvals given and the tasks still open cannot reach the number the step needs, the instance ends `Completed` with the outcome `EXPIRED` (`adm.workflow_instance.completed.v1`, `command: null`) and the other open tasks are Cancelled |

The task that the step escalates to decides it whatever the rule of the step says about the first assignee (the definition names them and a second administrator published it); they still need `approval.decide` over the place. Reminders do not change the version of a task, so an operator's `If-Match` is not spoiled by a reminder.

Telemetry: the counter `approval_sla_breach_total` (once for each task found past its deadline), the gauges `approval_task_open_total` and `approval_task_overdue_total` (alert `ADM_APPROVAL_OVERDUE`), and the counter `workflow_guard_rejected_total` (alert `ADM_WORKFLOW_GUARD_REJECTED`, any increase). No personal data in any of them.

## ADM-18

`ApprovalMonitorScreen`: the pending tasks of the tenant (the record, the type, the amount, the current step, the assignee, the SLA deadline, the version of the workflow, the state) with a filter by type and by late; the late rows are red and come first. Each row offers "reassign" (a member chosen from the active staff and a reason) and "cancel the approval" (a reason) only where the server says the viewer may (`actions.reassign`, `actions.cancel` of `get_resources_approval_task`), and nothing while read-only. The server judges again and the screen says in words why it refused (not authorised, the maker, already decided, not running, changed meanwhile).

`get_resources_approval_task(_id)` now also answers, for the monitor, `step_name`, `instance` (id, version, status, amount, document type, unit, workflow revision), `overdue`, `overdue_reminders`, `escalated_at`, `escalated_from_id`, `reassigned_from_id` and `actions`.

## The staged approval for three owners and the PUSH step that waits for the receipt (ENT-3c)

The steps unit approver, planning review, period close and push (rule type `APPROVAL_WORKFLOW_DEFINITION`) run for three owners, each with its business type and rule code (`STAGED_APPROVALS` of the kernel):

| owner | business type | rule code | record | final command |
|---|---|---|---|---|
| DIS weekly report | `report.accept` (on by default) | `REPORT_ACCEPT` | `report_revision` | accept, return |
| FND figure batch | `fnd.figures.accept` | `FND_FIGURE_ACCEPT` | `plan_figure_batch` (the batch id) | accept, send back |
| IND entry batch | `ind.entry.accept` | `IND_ENTRY_ACCEPT` | `ind_entry_batch` | write the figures, return |

The two new types are enabled by `MACHVON_APPROVAL_BUSINESS_TYPES`; the boot guard (R14) then needs the real handlers that the FND and IND bindings register (`FndFigureApprovalBinding`, `IndEntryApprovalBinding`), so a production process never boots with an enabled type that ends in nothing. A tenant that never approves a rule keeps the single decision for every owner. For FND the commands `submitFundingFigures`, `acceptFundingFigures` and `returnFundingFigures` are the same; a staged tenant starts an instance at the hand-in and the acceptance becomes the decision of the task of the person who decides. For IND a staged tenant's `enterIndicatorFigures` judges the figures like any entry and keeps them as a batch (`ind_entry_batch`, V2701) with the warnings of the entry rules; the register gets the figures, under the name of the person who entered them, when the last step approves (the rules and the period are judged again then). A return of an IND batch carries the warnings and the reason to the person who entered it and to the approver (`ind.entry_batch.returned.v1`, BBH 43). The deadlines and the reminders are the steps' own (`approval-sla`).

### The PUSH step waits (R22)

Where the process has a receiver (`APPROVAL_PUSH_PORT`, provided by the HPM module of the enterprise edition) the approval that would complete the PUSH step first hands the package of the record to the receiver. The owner says what is handed over (`ApprovalPushSource`: the project, the period, the revision, the facts); the push is keyed by organisation | layout | period | revision (R8), a revision older than the newest is refused `REPORT_OUT_OF_DATE` (R17) and nothing is held. The task stays `Pending`, the instance `Running`, and `approval_step_hold` (V2700) says why: `AWAITING_RECEIPT` (written), `PUSH_FAILED` (approve the step again: the same key, the next attempt), `PUSHED` (receipt accepted: the decision of the person who held the step is finished as theirs and the final command runs once), `REJECTED` (the receiver refused: the record goes back by the usual return), `CANCELLED` (the instance ended). The receipt is recorded on HPM-01 (`recordHpmReceipt`, never by the pusher) and releases the hold in the same transaction. The SLA job skips a task whose step awaits the receipt; the alerts `HPM_PUSH_FAILED` and `HPM_PUSH_STALE` speak for it. `getReportWorkflow` shows the step as `AWAITING_RECEIPT` (or `PUSH_FAILED`) with a `receipt` object and the screen offers the way to HPM-01. Without a receiver the PUSH step is a person's step, as it has always been.
