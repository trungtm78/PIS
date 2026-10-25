# CTR: the chain of changes of a contract (ST-CTR-006, slice CTR-1)

A contract that is being performed changes: the owner instructs something else, the site is not what the survey said, a law moves. CTR keeps each change as a request that goes up a chain
of one, two or three **tiers** — the change event (`EVENT`), the price of the change (`PCO`) and the change order (`CO`) — and only a CO is decided (ST-CTR-007) and can change the
contract. This story is the chain up to the decision: the tiers of a project, the requests, the promotion from tier to tier, the assessment and the withdrawal.

## The tiers of a project (BR-CTR-07, CTR-20)

`tier_count` is 1, 2 or 3, set by the business owner for the project (`setChangeChainTiers`, `change.tiers.configure`, in the scope of the project). The tiers are

| tier_count | tiers | a request starts at |
|---|---|---|
| 3 | EVENT, PCO, CO | EVENT |
| 2 | PCO, CO | PCO |
| 1 | CO | CO |

The count may be set again as often as the owner likes **until the first request of the project is raised**. That request locks it: `change_chain_config.locked_at` and
`locked_by_change_id` are set in the same transaction, and from then on the command answers 409 `CHANGE_TIERS_LOCKED` (with `tier_count` and `locked_by_change_id`). The lock does not
rest on the command alone: the trigger `change_chain_config_guard_tg` (V1386, which replaces the weaker one of the baseline) refuses, with SQLSTATE 23514 and the message
`CHANGE_TIERS_LOCKED`, any `UPDATE` of a locked configuration and any `DELETE` of it, whoever runs it, and an `UPDATE` that moves the configuration to another project or locks it
while changing the count. The runtime role has no `DELETE` or `TRUNCATE` on `change_request` or `change_chain_config` either (V1386).

## The requests

| command | who | what it does |
|---|---|---|
| `createChangeRequest` (`POST /contracts/{id}/change-requests`, `change.manage`) | contract officer | raises a request at the first tier of the chain: `SUBMITTED`, code `CE-001`, `PCO-001` or `CO-001` (numbered per contract and tier), resting on a revision of the contract that is **in force** (`EFFECTIVE`); the first request of the project locks its tiers |
| `promoteChangeRequest` (`POST /change-requests/{id}/promote`, `change.manage`, versioned) | contract officer | the request becomes `PROMOTED` with the reason and a new one is raised under it at the next tier (same contract, baseline, kind of event and estimate); a CO has no next tier |
| `evaluateChangeRequest` (`POST /change-requests/{id}/evaluate`, `change.evaluate`, versioned) | evaluator | at a PCO or a CO: records the cost (`evaluated_delta_vnd`, signed), the schedule (`schedule_impact_days`, signed), the funding note and, optionally, the scope note; the request is `EVALUATED`, and may be assessed again until it is decided |
| `withdrawChangeRequest` (`POST /change-requests/{id}/withdraw`, `change.manage`, versioned) | contract officer | an open request becomes `WITHDRAWN` with the reason; the requests above it in the chain are not touched |

A request is **open** while it is `SUBMITTED` or `EVALUATED`. The contract has to be `ACTIVE` or `SUSPENDED` (409 `CONTRACT_STATE_INVALID` with `contract_status` otherwise; a suspended
contract may still need a variation, such as more time). A tier other than the first one of the chain is 422 `CHANGE_STAGE_NOT_ALLOWED` (`allowed_stage`, `tier_count`); so is a project
that has set no tiers (`reason: TIERS_NOT_CONFIGURED`), the promotion of a CO (`reason: LAST_TIER`) and the assessment of a request that is not a PCO or a CO
(`reason: STAGE_NOT_EVALUATED`). A request that is over is 409 `CHANGE_STATE_INVALID` (with `change_status`).

**Funding.** An assessment that adds to the contract (`evaluated_delta_vnd` above zero) has to name the line of capital it is paid from (`allocation_line_id`; 422
`ALLOCATION_UNAVAILABLE` with `reason: ALLOCATION_LINE_REQUIRED` without it), and CAP is asked through its port whether the line can take the increase
(`CapitalCommitments.assertCanAbsorb`, which judges the availability policy without committing anything: a line that is not in force is `reason: NOT_IN_FORCE`, a policy that blocks the
amount carries its own reason). A warning is not a refusal here; the commitment itself, when the contract changes, will ask for it to be accepted. A decrease or no change asks nothing of
the capital.

The database keeps the rest (V1386): a request keeps its place (contract, tier, parent, code, baseline and estimate do not change), the status moves along the edges only, a child stands
under a request of the same contract that was promoted for it, at the tier after the parent's, and only one child per parent (`change_request_one_child_uq`); the assessment columns are
written together; a request has its maker; text is trimmed and not empty.

## Reads

* `getChangeChain` (`GET /projects/{id}/change-chain?contract_id=`, `change.read`) is the read model of the board (CTR-19) and the form (CTR-07): the tiers (`config`, absent while the
  owner has not set them and for a guest contractor), the requests in the scope of the caller, and for the staff what the caller may do with each (`actions`: promote, evaluate,
  withdraw — the status, the tier, the contract and the permission over the contract all allow it) and with the project (`actions.configure`, `actions.open`).
* `get_resources_change_request` and `get_resources_change_request_id` (`change_request.read`) list and read the requests a page at a time, the oldest first.
* A **guest contractor** reads the tier and the status of the requests of its own contract and nothing else: no reason, no figures, no people, no actions. A project or a request outside
  the scope of the caller does not exist for them (404).

## Events and audit

Events (outbox, same transaction): `ctr.change_chain.configured.v1`, `ctr.change.opened.v1`, `ctr.change.promoted.v1` (carries the new request and `promoted_from_id`),
`ctr.change.evaluated.v1`, `ctr.change.withdrawn.v1`; ids, codes, tiers, statuses and amounts, never the words of a reason. Audit actions: `change.tiers_configured`, `change.opened`
(also for the request a promotion raises), `change.promoted` (on the request that was promoted), `change.evaluated`, `change.withdrawn`; the reason of a promotion or a withdrawal is
the `reason` of the row.

## Screens

* **CTR-20** (`TiersScreen`): the tiers of a project; locked, it names the request that locked it and offers no way to change them.
* **CTR-07** (`RequestScreen`): the form that raises a request on a contract; it says where the chain starts and, for the first request of the project, that it fixes the tiers.
* **CTR-19** (`ChainScreen`): the board, a column for each tier, with the figures of each request and the commands that apply to it.
* The workspace of the contract (CTR-03) links to CTR-07 for the staff of a contract that is being performed.

## The decision of a CO and the revisions (ST-CTR-007, CTR-08, CTR-26)

`post_contract_changes_id_decision` (`POST /contract-changes/{id}/decision`, `contract.change.approve`, versioned) decides a CO that was assessed (409 `CHANGE_STATE_INVALID` otherwise;
422 `CHANGE_STAGE_NOT_ALLOWED` with `reason: ONLY_CO_DECIDED` for a request that is no CO) on a contract that is ACTIVE or SUSPENDED.

* **Who.** Not whoever raised or promoted a request of the chain, nor whoever assessed the CO, nor (for an approval) whoever made the decision document: 403 `SELF_APPROVAL_DENIED`, whatever
  the decision. They can withdraw it instead.
* **`return`** puts the CO back to `SUBMITTED` with the reason, to be assessed again. **`reject`** ends it (`REJECTED`, with who and when). Both need the reason only.
* **`approve`** needs a decision document (422 `DECISION_DOCUMENT_REQUIRED`: a version of a file of the tenant that is not infected and not a sealed bid), a first day that is today or later
  (422 `RETROACTIVE_NOT_ALLOWED`: what was accepted and paid under the old terms is not rewritten; a change that reaches back goes through the adjustment of its own, a later story) and
  after the first day of the revision it follows (revisions cannot begin on the same day), and an amount (`approved_delta_vnd`, the assessment by default). The new value is the value of the
  revision it follows plus the amount; it must be above zero and **at or above the floor** (BR-CTR-06): the greater of `accepted_total_vnd` and `advance_paid + paid_total - advance_recovered`
  (422 `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT`, with the new value and the floor). The size of the change, whichever way it goes, is judged against the delegation matrix of ADM for the document
  type `CTR_CHANGE` when the tenant configured bands for it (403 `SCOPE_DENIED` above the band of the approver); a tenant that configured none leaves it to the permission and its scope. An
  increase must still be taken by the line of capital the assessment named (422 `ALLOCATION_UNAVAILABLE`).
* **What an approval writes**, in one transaction: the change order (`APPROVED`, amount, first day, document, who, when, `resulting_revision_id`) and the next revision of the contract:
  kind `CHANGE_ORDER`, `PENDING_EFFECTIVE`, from the first day, with the value above, following the latest revision in force or waiting. Its BOQ is the `boq_lines` sent with the decision (the
  lines of an import, replacing), or a copy of the BOQ of the revision it follows; the lines never add up to more than the value, so a decrease has to say which lines shrink (422
  `BOQ_TOTAL_MISMATCH`). Until the revision's first day the contract is worth what it was, the old revision still prices the work, and the BOQ of the new one can be put right by an import
  (CTR-04) — V1387 lets the BOQ of a pending change order be written, and nothing else once a revision is in force.
* Events: `ctr.change.approved.v1`, `ctr.contract_revision.created.v1`, `ctr.change.returned.v1`, `ctr.change.rejected.v1`. Audit: `change.approved` (with the document, the amounts and the
  revision), `contract.revision_created`, `change.returned`, `change.rejected`; the reason is the `reason` of the row.

### Putting the revision in force

The job `revision-effective` (hourly; `docs/runbooks/jobs.md`) takes every pending revision whose first day (in Vietnam) has come, in the order of their days: the revision in force becomes
`SUPERSEDED` and ends where the new one begins (`valid_until` is the first day of the next revision, exclusive), the new one is `EFFECTIVE`, `contract_value_vnd` and
`current_revision_id` follow, the audit row `contract.revision_effective` is written and `ctr.commitment.changed.v1` tells the capital the value to commit. There is exactly one revision in
force (`contract_revision_effective_uq`). A revision waits, and is counted, while the contract is no longer being performed or while its value is below what has been accepted or paid since the
approval; the gauge `ctr_revision_overdue` and the alert `CTR_REVISION_OVERDUE` tell when one is more than a day late.

`CtrRevisionStore.pricingRevisionAt` and `unitPriceAt` are what the acceptance of a quantity (ST-CTR-009) takes its price from: the revision in force on the day of the acceptance, never a
pending one, and never one that was superseded before that day. An acceptance on 25 July is priced by the revision that was in force then, even after a change order took effect on 1 August.

The guard `contract_revision_guard` (V1387) keeps the history as it was written: a revision keeps its place (contract, number, kind, the change order, the revision it follows), moves along
DRAFT, PENDING_EFFECTIVE, EFFECTIVE, SUPERSEDED (or is REJECTED as a draft) and nowhere else, keeps its terms (value, first day, document) once it is decided, and its last day is written once.

### Screens

* **CTR-08** (`DecisionScreen`): the change beside the contract in force (value, change, schedule, first day), the BOQ of the new revision against the one it follows once approved, and the form of
  the decision for someone who may take it. **CTR-26** (`RevisionsScreen`): the revisions in time, each with when it applies, what it adds, the change order that made it and how far its BOQ covers
  its value; a pending revision says it is not used for payment. The workspace of the contract links to CTR-26 and the board to CTR-08.

## Not in this story

The retroactive adjustment (`approveRetroactiveAdjustment`) is a later story. The capital's own commitment of the change (a new source kind for the ledger and the release of a decrease) is not
written: the job tells CAP the value to commit with `ctr.commitment.changed.v1`, and the approval only asks whether the line can take an increase.
