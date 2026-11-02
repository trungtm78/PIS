# BID: clarification requests to contractors (ST-BID-011, slice BID-1)

During the evaluation a member of the evaluation team may ask the contractor of a proposal to explain something in it (BID 3 F6, BR-BID-03). The question goes with a deadline, the contractor answers with a document before
that deadline, and the question and the answer stay on record. Nothing here scores, ranks or decides anything: a clarification is a record of what was asked and answered, and an answer after the deadline is refused.

## Sending a request (`sendBidClarification`, `bid.evaluate`, Idempotency-Key)

`POST /bid-clarifications` with `{ proposal_id, question, basis_finding_id?, due_at }`. Refusals in order (nothing is written for them, not even the letter):

| step | refusal |
|---|---|
| the shape: `question` trimmed under 10 or over 4000 characters, `due_at` not a date-time with its zone, an id that is not an id | 422 `VALIDATION_FAILED` |
| `due_at` is now or past | 422 `DUE_IN_PAST` |
| the caller is a guest contractor (whatever the role says) | 403 `SCOPE_DENIED` |
| the proposal is not one of a project the caller evaluates (`bid.evaluate` over it), its bids are not opened yet, or a conflict of interest of the caller shuts them out of the bids of that contractor (declared and pending, or RECUSED) | 404 |
| the caller owes the declaration about the package | 403 `CONFLICT_UNDECLARED` |
| the proposal was replaced or withdrawn (the bids are open, this one takes no question) | 409 `PROPOSAL_NOT_OPEN` |
| `basis_finding_id` is not a finding of a run of this proposal | 422 `VALIDATION_FAILED` (`basis_finding_id`) |

A request is written SENT at version 1 with its letter: a DOC `document` (`REFERENCE`, type `BID-CLARIFICATION`, CONFIDENTIAL, subject `BID_CLARIFICATION` and the id of the request, created by the sender) made through the
DOC `DocumentStore`, and `sent_document_id` points at it. The audit row `bid.clarification_sent` and the event `bid.clarification.sent.v1` carry ids, the code of the package, the deadline and the letter; they never carry
the words of the question.

## Answering (`recordClarificationAnswer`, `bid.clarification.answer`, If-Match, Idempotency-Key)

`POST /bid-clarifications/{id}/answer` with `{ answer_document_id }`, by the contractor as a guest of that contractor (`membership.contractor_id` equals the contractor of the proposal), or by the clerk who took their letter
(staff with `bid.clarification.answer` over the project of the package). Refusals in order:

| step | refusal |
|---|---|
| the document id is not an id | 422 `VALIDATION_FAILED` |
| the request is not one the caller reaches: a guest of another contractor, another tenant, a project outside the scope of the clerk, an evaluator a conflict shuts out | 404 (an evaluator who owes the declaration: 403 `CONFLICT_UNDECLARED`) |
| the deadline has passed, whatever the status | 409 `CLARIFICATION_EXPIRED` |
| the request is not SENT (answered already, withdrawn) | 409 `CLARIFICATION_STATE_INVALID` |
| the version in `If-Match` is not the current one | 409 `VERSION_CONFLICT` with `current_version` |
| the document is not one of the tenant, is the letter of any request, answers another request, is about a sealed proposal, or (for a guest) was not made by the guest | 422 `VALIDATION_FAILED` (`answer_document_id`, reason `DOCUMENT_ALREADY_USED` for the second kind) |

The deadline comes before the state and the version on purpose: the contractor who answers a second time the day after is told the time is up (UAT-AC452), whichever version they name, and the request is not touched. An answer
in time makes the request ANSWERED (version + 1) with `answer_document_id`, `answered_at`, `answered_by` and `answered_as_guest` (true when the contractor answered, false when the staff recorded it). Audit row
`bid.clarification_answered`, event `bid.clarification.answered.v1`.

## Reads

`GET /bid-clarifications` (`bid.clarification.read`; filters `package_id`, `proposal_id`; newest first, at most 500) and `GET /bid-clarifications/{id}`:

- a guest reaches only the requests about the proposals of their own contractor, and sees neither who on the evaluation team asked (`asked_by` null) nor the finding the question rests on (`basis_finding` null);
- the staff reach the requests of the projects they hold the permission over; a member of the evaluation team (`bid.evaluate` over the project) is held to the declaration as for the proposal itself: 403 `CONFLICT_UNDECLARED` while it
  is owed, and the requests about a contractor they are recused from are not there;
- `status` is the status a reader should see: a SENT request past its deadline reads EXPIRED. Nothing is written when a deadline passes (the stored status stays SENT; the database holds the same edges), so no job is needed and a late answer
  cannot find the request changed;
- `actions.answer` is true when the request waits, is in time, and the caller holds `bid.clarification.answer` (a guest by their role, the staff over the project). The server judges the command again.

## What the database holds (V1353)

Table `bid_clarification` comes from the generated V002 with its foreign keys and an index on each id. V1353 adds `answered_by` and `answered_as_guest`, the checks that tie a status to its columns (a request that left the draft has its
letter; an ANSWERED request has the answerer, the document, the time, an answer at or before `due_at` and a document other than the letter; any other has none of them), the question length, `due_at > created_at`, one letter and one answer
document per request (unique partial indexes), and the guard `guard_bid_clarification` (the owner of the schema is not held): a request is written SENT at version 1 with a confidential letter that is about it, never deleted or truncated
(`machvon_app` also loses DELETE and TRUNCATE), what it asks (package, proposal, words, finding, deadline, letter) never changes, only SENT moves (to ANSWERED, EXPIRED or WITHDRAWN), the others are kept as they are, and an answer is never the
letter of a request.

## Screen

BID-11 `/bid/bid-11?package=&proposal=`: the requests of the package as a conversation (question, basis criterion, deadline with an "expired" cue, recipient, status, answer document); the send form for a member of the evaluation team
(recipient taken from the proposals the caller has in full view, question with its counter, optional finding, deadline in the future), and one answer form per request that the server says may be answered (a document id; one answer at a time, an
attempt of its own per intention). An evaluator who owes the declaration is told to declare first; a guest sees neither who asked nor the finding. No action acts on several requests at once.

## What is not here

- **Delivery of the letter outside the system.** The letter is a DOC anchor (a `document` with no file version); the contractor reads the question from BID-11 as a guest. The formal letter as an outgoing document of DOC (a template for
  the clarification request, the signature of the authority, a number, and a distribution to the contractor by e-mail, LGSP or paper) is not wired: the template pack of DOC has no template for it and its confirmation is DOC's. Likewise no
  notification reaches the guest when a request is sent (the notification event routes by unit and project, a guest holds a contract scope).
- **A way for a guest to upload the answer.** The answer names a DOC document the guest (or the clerk) made; no operation lets a guest upload a file to DOC, so the screen takes the document id as the petition screen does.
- **Guests of a package.** The contractor is a guest of their contractor (`membership.contractor_id`); IAM invites guests for contracts only (`inviteGuestContractor` needs active contracts), so before an award there is no way to invite one. The
  rule here is the contractor's own requests, which is what a package scope would give. The system role `GUEST_CONTRACTOR` is not changed (its matrix is pending sign-off): a tenant defines a guest role with `bid.clarification.read` and
  `bid.clarification.answer`.
- Withdrawing a request (`WITHDRAWN`) and a draft (`DRAFT`) have no operation; the database holds the edges for them.
