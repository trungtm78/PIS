# Time-boxed delegation of approval authority (ST-ADM-014, ADM 3.5, BR-ADM-06)

A leader hands business permissions they hold to another active member of the staff for at most 90 days, over a unit (or a unit and the ones below it), so that approvals do not wait while they are away. The delegate decides the tasks of the delegator with the permission of the delegation alone; every such decision records on whose behalf it was made (`approval_task.on_behalf_of_id`, `delegation_id`, ST-ADM-012).

## Commands

* `createDelegation` (`POST /delegations`, 201, `iam.delegation.create`): the **caller is the delegator** (the contract has no field for another one, so the administrator acting for an absent delegator with a document, ADM 3.5, is not offered). In this order:
  1. the delegate is not the caller (403 `SELF_GRANT_DENIED`);
  2. the request is well formed (422 `DELEGATION_INVALID`, the first field in `detail` and every defect in `defects[{field, code}]`): the window runs forward, lasts **at most 90 days**, has not ended and does not start more than 5 minutes in the past; the permissions are among the ones something reads a delegation for (**`approval.decide`** for the approval engine and the door of the decision, **`doc.outgoing.sign`** for the signing authority check; any other is 422 `UNSUPPORTED`), **never `iam.*`, `adm.*`, a bare `*`** nor repeated; the scope kind is `UNIT_SUBTREE` or `UNIT_ONLY` with distinct ids (a project scope is refused, 422 `scope_kind`: the approval engine and the signing check match a delegation against the unit of the approval only);
  3. the delegate exists in the tenant (404 otherwise, as a member of another tenant), is not a guest contractor (422) and is active (403 `MEMBERSHIP_INACTIVE`);
  4. the scope resolves (422 `scope_ref_ids`);
  5. **the delegator holds every permission they pass on, over the scope, with their own grants** (kernel `delegatorHolds`: active grants whose scope covers the scope delegated; a pattern is covered only by an equal or broader one). Otherwise 403 `ROLE_ESCALATION_DENIED`, or 403 `DELEGATION_CHAIN_DENIED` when what is missing is something the delegator holds only through a delegation they received (no chain).
  The delegation is Active at once when it starts now and Scheduled when it starts later. The audit row `delegation.created` carries the reason; the events are `iam.delegation.created.v1` and `iam.access.changed.v1`, and the **scope version of the delegate is raised** so their next request reads their access again.
* `revokeDelegation` (`POST /delegations/{id}/revoke`, 200, `If-Match`, a reason of 10 characters): by the delegator, or by whoever holds `iam.delegation.create` **and** `iam.delegation.read` on the whole tenant. A Scheduled or Active delegation becomes Revoked (409 `DELEGATION_STATE_INVALID` for one that is over, 409 `VERSION_CONFLICT` when stale). Audit `delegation.revoked`; events `iam.delegation.revoked.v1` and `iam.access.changed.v1`; the scope version of the delegate is raised. What the delegate decided stays.
* Reads (CR-ADM-15, new in `openapi.json`): `get_resources_delegation_grant` (`role=given|received`, `status`) and `get_resources_delegation_grant_id`, permission `iam.delegation.read`: the delegations the person gave or received, or all of them for who holds the right on the whole tenant (404 on one of someone else's). Items carry the names of both sides, the scope, the window, the reason, the state, `end_reason`, `revoke_reason`, `version` and `actions.revoke`.

## The table

`delegation_grant` (V002, V1307): the window is at most 90 days and the two sides differ (checks of V002); V1307 adds that the permissions are business permissions (`delegation_permissions_chk`), the columns `ended_at`, `end_reason` (`EXPIRED`, `SOURCE_ENDED`) and `revoke_reason`, a guard trigger (what a delegation grants never changes; the state only moves forward: Scheduled to Active, Ended or Revoked, Active to Ended or Revoked; one that is over is final) and takes away DELETE from the application role.

## The job `delegation-lifecycle` (every minute)

`DelegationStore.sweep` (see `docs/runbooks/jobs.md`), per tenant, at most 500 delegations, those whose window is over first and then the ones looked at longest ago (`checked_at`), so that a tenant with more delegations than a pass takes is covered in turns; a delegation a command holds is left to the next pass: a window that has ended is **Ended (EXPIRED)**; a delegation whose delegator no longer holds what it passed on (the source grant was revoked or lapsed, or the membership is no longer active; judged by `delegatorStillHolds`, the same test as the command) is **Ended (SOURCE_ENDED)**, in force or still waiting; a Scheduled one whose first instant has come becomes **Active**. Each change raises the scope version of the delegate and is announced (`iam.delegation.ended.v1`, `iam.delegation.activated.v1`, audit `delegation.ended`). Telemetry: the gauge `delegation_active_total`, the counter `delegation_source_ended_total`; no personal data.

The approval engine never depends on the job for correctness: `decideApprovalTask` reads the delegation live (status Active, inside its window, carrying `approval.decide`, scope reaching the unit of the approval) and judges the band on the delegator's grants as they are at the moment of the decision. The job keeps the records, the lists and the scope versions true, and puts a Scheduled delegation in force.

## What is not done here

The document prefix "TUQ." of a text issued by a delegate waits for CXN-DOC-01 (DOC); only `on_behalf_of` is persisted. See TODOS (ST-ADM-014).

## ADM-04

`DelegationScreen`: two tabs, "I delegated" and "Delegated to me"; the list shows the other party, the permissions, the scope, the window with a bar, the reason, the state (and why a delegation ended) and, where the server says it may be done, "revoke" with a reason. The form offers the delegates (active staff), the delegator's own business permissions (never the administration, never a read), a unit and the kind of scope, the dates and a reason. The bar fills the share of the 90 days the window takes and never more than the whole bar (`role="progressbar"`, `aria-valuemax=90`); the end field cannot go past 90 days after the start and a longer window is not sent. A refusal is said in words (no chain, more than the delegator holds, the defects of the request by field).
