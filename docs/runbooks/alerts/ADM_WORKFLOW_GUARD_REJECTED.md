# ADM_WORKFLOW_GUARD_REJECTED

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/ADM_WORKFLOW_GUARD_REJECTED.json`

## What it means

The last decision of an approval was made, and the command of the owning module that carries it out (`acceptReport`, `publishPlan`, `approvePaymentRequest`, ...) refused it through its own transition table (BR-ADM-07, ADM 3.7 item 6). The instance ended as `Completed` with the outcome `GUARD_REJECTED`; the record in the module was **not** changed. The counter `workflow_guard_rejected_total` (label `business_type`) rises once for each such instance, and the event `adm.workflow_guard_rejected.v1` carries the instance, the record and the command that refused.

The usual cause is a record that moved while the approval ran: it was withdrawn, or changed by another path, so the state the approval was about is no longer there.

## What to do

1. Find the instance with the event or in ADM-18 (outcome `GUARD_REJECTED`); its `resource_type` and `resource_id` name the record.
2. Open the record in its module and see what state it is in. If it was withdrawn, nothing more is needed. If it should have been approved, the owner submits it again: a new approval starts by the workflow in force.
3. If the same business type keeps being rejected, the command bound to it in `FinalCommandRegistry` or the transition table of the module is wrong; open a defect for the owning module with the instance id.
4. Do not edit `workflow_instance` in the database: the guard trigger refuses it.
