# Claim register with limitation per contract (GOV-8, roadmap G1-9)

CTR section 14, screens CTR-32 (register), CTR-33 (record with clocks), CTR-34 (terms), story ST-CTR-021. Migrations `V1980` to `V1982` and `V1985` (block GOV-8, 1980-1999). Kernel: `packages/kernel/src/ctr-claim.ts` (pure rules and the report hooks). Database: `ctr-claim-term-store.ts`, `ctr-claim-store.ts`, `ctr-register-policy.ts`, alert source `home-contract-register-sources.ts`.

## The rule that decides everything

A claim has a limitation clock only when its own contract has an approved term. The term is entered from the clauses of the signed contract, proposed by one person and approved by another. A contract without one has no clock and says `NO_TERM`: nothing is borrowed from an international form, least of all for a domestic contract that does not say so. The templates of the rule `CLAIM_TERM_TEMPLATE` (`FIDIC_2017_EXAMPLE`: notice 28, particulars 84, response 42 days, a late notice bars the claim; `NEC4_EXAMPLE`: notice 56, response 14 days) are unverified examples a person may copy into a proposal; the register never applies one by itself.

## The term (`contract_claim_term`)

One APPROVED term per (contract, claimant side) at a time and at most one PROPOSED (409 `CLAIM_TERM_PENDING`).

| Field | Meaning |
|---|---|
| `claimant_side` | `CONTRACTOR` or `OWNER` |
| `notice_days`, `particulars_days`, `response_days`, `settlement_days` | The periods the contract gives; NULL is a period it does not give. At least one is given, each 1 to 3650 |
| `basis` | `CALENDAR_DAYS` or `WORKING_DAYS` (counted on the published working calendar; a year not published is `CALENDAR_UNAVAILABLE`, never a guessed day) |
| `particulars_from` | The particulars period counts from `AWARENESS` or from the `NOTICE` |
| `bar_effect` | `BARS_CLAIM`, `REDUCES_RELIEF`, `NONE`, `NOT_STATED`; the first two need a notice or particulars period |
| `clause_reference` | The clause of the contract (3 to 200 characters, required) |
| `basis_document_version_id`, `template_code` | The signed document (a clean file) and the template the numbers were copied from, both optional |

Approval is by somebody other than the proposer (403 `SELF_APPROVAL_DENIED`, and the CHECK `contract_claim_term_maker_checker_chk`). A rejection needs words. Approving supersedes the term in force (kept, `SUPERSEDED`) and binds the open claims of that side that had no term, one `TERM_BOUND` step each. A proposed term is never edited (trigger): propose a new one.

## The claim (`contract_claim`) and its timeline (`contract_claim_step`)

Numbered `CLM-nnn` per contract (the contract row is locked, so there is no gap). Registered with the day of the event and the day the claimant became aware of it (`awareness_on`, not before the event, not in the future): the notice limit counts from it, day 0 being that day. The contract must be past `DRAFT`, `IN_REVIEW` and `CANCELLED` (409 `CONTRACT_STATE_INVALID`). The person who answers for the claim (`responsible_membership_id`, the registrant by default) owns its alerts. Kinds: contractor `EXTENSION_OF_TIME`, `ADDITIONAL_PAYMENT`, `TIME_AND_COST`; owner `DELAY_DAMAGES`, `DEFECT_COST`, `SET_OFF`; both `OTHER` (a CHECK keeps side and kind together).

```
EVENT_RECORDED -notice-> NOTICE_SERVED -particulars-> PARTICULARS_SUBMITTED -response-> RESPONDED
RESPONDED -settlement proposal-> SETTLEMENT_PROPOSED -approved-> SETTLED   (rejected: back to RESPONDED)
```

A response may follow the notice directly; after `MORE_INFORMATION_REQUESTED` the particulars are submitted again; a settlement is proposed only after `ACCEPTED` or `PARTLY_ACCEPTED`; a referral (`REFERRED`) only after `REJECTED` or `PARTLY_ACCEPTED`; withdrawal (`WITHDRAWN`) from any open state before the settlement is approved. `SETTLED`, `WITHDRAWN`, `REFERRED` and `TIME_BARRED` end the claim; nothing moves it after (409 `CTR_CLAIM_STATE_INVALID`; a trigger keeps a settlement from being rewritten). Every step is a row of an append-only timeline with the day it happened in the contract world (`occurred_on`: not in the future, not before awareness, not before the previous step), words, the decision of a response, the figures of particulars and settlement and an optional evidence document. The dates the limits count from are kept on the claim in the same transaction.

## Deadlines and limitation (computed on the day it is read)

| Deadline | Starts | Done by | Owed by |
|---|---|---|---|
| `NOTICE` | awareness day | the notice step | claimant |
| `PARTICULARS` | awareness or notice (`particulars_from`) | the first particulars step | claimant |
| `RESPONSE` | the latest particulars (the notice when the term has no particulars period) | a response dated after it | the other side (the owner, for a contractor claim) |
| `SETTLEMENT` | the latest accepting response | the approval | both |

States: `NOT_DEFINED`, `NOT_STARTED`, `NOT_APPLICABLE` (the claim ended without it), `CALENDAR_UNAVAILABLE`, `RUNNING`, `APPROACHING` (within `approach_days`), `MET`, `MET_LATE` (judged by the day the step happened), `MISSED` (only after its day has ended). The limitation of a claim reads only the notice and the particulars, the two steps that carry a bar: `NO_TERM`, `NOT_DEFINED`, `CALENDAR_UNAVAILABLE`, `RUNNING`, `APPROACHING`, `MISSED`, `MET`, `MET_LATE`, `BARRED`, `CLOSED`. The working numbers (`approach_days` 7, `response_approach_days` 3) are the rule `CLAIM_POLICY`, flagged unverified.

## The bar (`declareClaimBar`)

Allowed only when a limitation day passed and the term says a miss bars the claim (409 `CLAIM_BAR_NOT_DUE`, detail `limitation` or `bar_effect`), with the reason in words, and by somebody other than the person who registered the claim (403 `SELF_APPROVAL_DENIED`; CHECK `contract_claim_bar_maker_checker_chk`). The register shows a missed day as `MISSED`; whether the claim is lost is a decision of people.

## Settlement

Proposed in a step (an amount, days, or both; never more than the claim asks for in money or days: 422 `CLAIM_SETTLEMENT_EXCEEDS_CLAIM`), decided by `decideClaimSettlement` by somebody other than the proposer (403 `SELF_APPROVAL_DENIED`; CHECK `contract_claim_settle_maker_checker_chk`) with words either way. `SETTLED` needs the approver, the day and at least an amount or days (CHECK).

## Links

`linkClaim` ties the claim to a change order (`change_request`) and to a payment request of the same contract (422 `VALIDATION_FAILED` for another contract's). The links stay after the claim ends: the settlement is paid after it.

## Alerts (ALERT_TYPE, source `CONTRACT_CLAIM`)

One item per open claim with a term, the most pressing, computed when the list is read (no job).

| Code | Owner | Expected action | Consequence | Response | Severity |
|---|---|---|---|---|---|
| `CLAIM_LIMITATION_APPROACHING` | contract manager | send the notice or particulars before the day and record the day | the claim may be lost or reduced | 48 h | ACTION, only for a step the owner owes |
| `CLAIM_LIMITATION_MISSED` | contract manager | decide: record the late notice with a reason, or ask to declare the claim barred, confirmed by a second person | the claim hangs: nobody knows what is left of it | 24 h | URGENT for the owner's own step, ACTION for the other side's |
| `CLAIM_RESPONSE_DUE` | contract manager | answer the contractor's claim and record it | taken as accepted or the right to refuse lost; a dispute | 48 h | ACTION before the day, URGENT after |
| `CLAIM_SETTLEMENT_OVERDUE` | contract manager | settle the accepted claim: propose, then a second person approves | money and time not in the contract; late payment | 72 h | ACTION |

A limitation day the contractor owes is shown only once missed, never before.

## Interfaces

Permissions: `claim.read`, `claim.manage`, `claim.term.propose`, `claim.term.approve`, `claim.settle`, `claim.bar`. Operations: `proposeClaimTerm`, `listClaimTerms`, `decideClaimTerm`, `registerClaim`, `listClaims`, `getClaim`, `recordClaimStep`, `decideClaimSettlement`, `declareClaimBar`, `linkClaim` (commands change nothing without `Idempotency-Key`; the decisions, steps and links take `If-Match`). Events: `ctr.claim_term.proposed.v1`, `ctr.claim_term.decided.v1`, `ctr.claim.registered.v1`, `ctr.claim.updated.v1`. Scope as the other CTR registers: 404 outside the read scope, 403 `SCOPE_DENIED` when readable but not changeable.

## Report hooks for CA-3

`claimRegisterReport` (each claim read against its term; counts by state, side and limitation; claimed, settled and open-claimed money in exact decimals, days asked and granted; claims without a term), `limitationHorizon` (the notice and particulars days ahead and just missed, earliest first) in the kernel, and `CtrClaimStore.reportInputs` (one input per claim in the read scope, newest first, at most 2000, `truncated` when cut). The reports themselves belong to another lane.
