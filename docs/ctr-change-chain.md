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

## Not in this story

The decision of a CO (`post_contract_changes_id_decision`) and the revision it makes of the contract belong to ST-CTR-007; the retroactive adjustment, to a later story. `APPROVED` and
`REJECTED` exist in the table (V002) and no command in this story writes them.
