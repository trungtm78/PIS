# The sealed proposal and the declaration of conflict of interest (ST-BID-004)

A proposal of a contractor is **confidential** until the bids of its package are opened, and a member of the evaluation team reads it only after they have said whether a
relation stands between them and a bidder (BR-BID-03, Luật Đấu thầu 22/2023 on impartial evaluation). The server decides what each caller sees, in one place
(`packages/kernel/src/bid-proposal.ts`, used by `BidProposalReads`); the screen BID-05 only says why the rest is missing.

## The receipt (`receiveProposal`, `uploadProposalFile`)

A clerk of the scope of `bid.proposal.receive` over the project of the package logs the files a contractor handed in. Each file goes through the shared upload door first
(`POST /proposals/files`: judged by its bytes, a PDF, scanned, stored under the tenant as a `document` upload, its pages counted; 25 MiB at most) and the proposal names the
clean uploads by key and digest. The files are read again when the proposal is received: the digest must still be the one named, the key must be a `document` upload of the
tenant (`FILE_KEY_INVALID`, `FILE_DIGEST_MISMATCH`), and a stored file stands for one proposal only (`FILE_ALREADY_ATTACHED`; otherwise one bidder's file could be carried into
another bidder's bid).

Refusals, in order: the shape (422 `VALIDATION_FAILED`: 1 to 500 files, a part of `LEGAL`, `TECHNICAL`, `FINANCIAL`, `OTHER`, a name of 1 to 200 characters, one digest once, a price
in whole VND of at most 24 digits, a hand-in time that is a real moment and not more than five minutes ahead of the server), the package (404 outside the scope, 409
`PACKAGE_STATE_INVALID` unless its plan is in force: `APPROVED`), the time (422 `BID_OPENING_UNSET`, 422 `BID_CLOSED`), the contractor (422 `CONTRACTOR_RESTRICTED`, 422
`CONTRACTOR_NOT_VERIFIED`, 422 `VALIDATION_FAILED` for one that does not exist).

* **The opening is the moment the proposal is unsealed.** It is the milestone `BID_OPENING` of the package (the day it happened, else the day it is planned for). A package with no
  opening takes no proposal: there would be no moment to unseal it at (fail closed). Once the opening has come no proposal is received, whatever time the clerk says it was
  handed in, and a proposal handed in after the `BID_CLOSING` milestone (the opening when there is none) is late.
* **Each file is a document**: `ATTACHMENT`, `CONFIDENTIAL`, document type `BID-PROPOSAL-FILE`, subject `BID_PROPOSAL` and the id of the proposal, scanned `CLEAN`. The reads of the
  DOC module never serve a document of that subject (`SEALED_SUBJECT_MODULE`): they are scoped by unit, and the unit says nothing about a bid. The proposal serves them to the people
  it names.
* **Another proposal of the same contractor** for the package is the next revision and sets the live one aside (`SUPERSEDED`); one live proposal per contractor per package (unique index).
* **What is kept and said**: the audit row `bid.proposal_received` and the event `bid.proposal.received.v1` say who sent a proposal for which package, its revision and how many files,
  never the price or a file name. Opening a proposal in full leaves `bid.proposal_opened` (who, which proposal, how many files).

## When a proposal is unsealed

`proposal.access_released_at` is the opening of the package, copied at the receipt and kept in step by the database: a trigger on `procurement_milestone` moves the release of the
live, still sealed proposals when the date of the opening changes, so a postponement keeps them sealed and nobody can read a proposal at a stale time. A proposal that was released
is **not sealed again**: a later opening date is refused (409 `OPENING_ALREADY_RELEASED` from `recordProcurementMilestone`, a row error from the file of the national system, and the
trigger as the last word). A change to `proposal` also keeps what the bidder handed in (package, contractor, time, price, files) and never deletes (REVOKE).

## What a caller sees

| Caller | Before the opening | From the opening |
|---|---|---|
| The clerk (`bid.proposal.receive` over the project) | the receipt: the contractor, the time, the number of files; never the price or a file | the same |
| A member of the team (`bid.evaluate` over the project), declared with no conflict, or with a conflict that was allowed | the proposal does not exist (404, and not in the list) | all of it: the price and the files, by part, title, type and pages |
| The same member, not declared | the proposal does not exist | the proposal in the list as waiting for the declaration, 403 `CONFLICT_UNDECLARED` on the detail |
| The same member, with a conflict not decided, recused or blocked | does not exist | does not exist for what the conflict covers (below) |
| Anyone else with `proposal.read` | does not exist | does not exist |

A replaced or withdrawn proposal is shown to the clerk (receipt) and never to the evaluators. A caller who is both clerk and member gets the clerk view whenever the member view is closed.

## The declaration (`declareConflictOfInterest`, `decideConflictOfInterest`, `listConflictDeclarations`)

A member declares **once per package** (422 `ALREADY_DECLARED` after that): either no conflict, or a conflict with the relation in words and, optionally, the contractor it is with.
A decision is taken by someone of the scope of `bid.conflict.decide` who is **not** the member (403 `SELF_APPROVAL_DENIED`; the database refuses a decision by the member too), under the
version the decider saw (409 `VERSION_CONFLICT`), with reasons of 20 to 2000 characters. A declaration of no conflict has nothing to be decided (422 `NO_CONFLICT_DECLARED`). A decision can
be taken again; each leaves its audit row with the reasons.

| Declaration | What the member sees |
|---|---|
| no conflict | every proposal, from the opening |
| a conflict, not decided | nothing of what it covers: the named contractor, or every contractor when none is named (fail closed) |
| `ALLOWED` | every proposal |
| `RECUSED` | not the proposals of the named contractor (every contractor when none is named); the others |
| `BLOCKED` | no proposal of the package |

`RECUSED` and `BLOCKED` also take the member out of the sign-off of the evaluation reports of the package that are not issued: a report that was fully signed goes back to `DRAFT`
because it has lost a signature (`signed_off_by` holds a membership id or an object with `membership_id`). The relation in words is told to the people who decide and the member; it
is left out of the audit trail and of the events.

## Assumptions and what is not here

* The evaluation team of a package is whoever holds `bid.evaluate` over its project: the register has no table of team members yet (`bid_conflict_declaration` is the only record of
  who took part). A member who finds a conflict after declaring none cannot change the declaration (`ALREADY_DECLARED`); the correction path is for the story that adds the team.
* `bid_conflict_declaration.contractor_id` is an addition to the generated table (nullable): the spec names the relation to a bidder (UAT-AC450) but the table had only the words.
* A file of a proposal is a PDF. Other types of the document upload purpose are not taken until the OCR stage (F3, R2) needs them.
* The reads of the files themselves (a download for the evidence of the analysis) are not part of this story: BID-07 and its stories open them under the same access rules.
