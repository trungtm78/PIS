# ADM_APPROVAL_OVERDUE

**Owner:** workflow-operations · **Severity:** warning · **Rule:** `alerts/rules/ADM_APPROVAL_OVERDUE.json`

## What it means

The job `approval-sla` (every 5 minutes, `docs/runbooks/jobs.md`) counts the approval tasks that are still pending after the deadline of their step. The gauge `approval_task_overdue_total` is that number over all tenants (`approval_task_open_total` is the number of pending tasks). At 80 percent of the working time to the deadline the approver is reminded; at the deadline the job does what the step says: remind every working day (REMIND), give the task also to the escalation target (ESCALATE) or expire it (EXPIRE, and the instance ends as `EXPIRED` when the step can no longer reach its approvals).

## What to do

1. Open ADM-18: the late tasks are red and come first, with the assignee and the version of the workflow they run by.
2. Ask the assignee to decide, or reassign the task to a person who can (`reassignApprovalTask`, with a reason); the new assignee must hold the authority the step asks for and cannot be the maker.
3. If the approval is no longer needed, cancel it (`cancelWorkflowInstance`, with a reason); the owning module is told by `adm.workflow_instance.cancelled.v1`.
4. If the gauge stays high with nobody late in ADM-18, check that the job runs (the alert `JOB_FAILED`).
