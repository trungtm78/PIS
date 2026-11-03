# CTR: retroactive adjustment of a change order (ST-CTR-016, slice CTR-1)

A change order (CO) whose price applies from a day before the day it is approved cannot go through the ordinary decision: that refuses it (422 `RETROACTIVE_NOT_ALLOWED`, ST-CTR-007) because an approval does not rewrite what
was accepted and paid under the old terms. `approveRetroactiveAdjustment` (CTR 3.3 step 6, BR-CTR-03, UAT-AC58) is the one road for it. It approves the assessed CO, makes the next revision of the contract, and puts the money
difference of the acceptances the new price reaches on the cumulative ledger of PAY as **new entries**. The lines and the amounts of the acceptances stay as they were approved.

## The decisions this story had to take

The specification said "creates an adjustment ledger entry in PAY, does not touch `acceptance_line`, blocked when the settlement is approved" and left four things open. The code that was already there decides most of them; where it
does not, the rule below is the one that loses no money and rewrites no record. The kernel holds the rules as pure functions (`packages/kernel/src/ctr-retroactive.ts`, tests in `packages/kernel/test/ctr-retroactive.test.ts`).

### 1. The sign of the entry in PAY: a new kind `ADJUSTMENT`, signed, on the accepted amount only

The ledger had ten kinds and no way to say "the accepted amount of this balance was wrong by +50,000,000" or "by -1,000". The existing kinds cannot carry it:

* a forward entry may not be negative (`cumulative_ledger_entry_forward_sign_chk`), so a price that falls cannot be a forward entry;
* a reversal must be the exact opposite of one entry it names (V1562 `guard_ledger_entry_insert`), so a difference is not a reversal;
* an acceptance is recognised once on a balance (`cumulative_ledger_entry_recognize_uq`), so the rise cannot be a second `RECOGNIZE_ACCEPTANCE`;
* the balance is one row per `(contract, item, acceptance, party)`, so the difference cannot sit on a balance of its own.

The rule: `ADJUSTMENT` carries **the signed difference on `accepted_delta_vnd` and nothing else** (`requested`, `paid`, `advance_recovery` and `retention` are zero; the difference is never zero). It is positive when the price rose and
negative when it fell. It names the line of the adjustment it comes from (`adjustment_line_id`, one line one entry) and no entry it reverses. Nothing changes or deletes it; a wrong adjustment is put right by a later one. The
rules are in `assertEntryShape` (kernel), the CHECKs `cumulative_ledger_entry_entry_kind_check`, `cumulative_ledger_entry_forward_sign_chk` (ADJUSTMENT exempt), `cumulative_ledger_entry_adjustment_chk`, and the trigger
`cumulative_ledger_entry_adjustment_guard` (V1394). PAY.md and openapi.json (`PayLedgerEntry.kind`) were amended; `docs/pay-ledger.md` lists the kind.

The balance rules of the ledger judge the entry like any other: after a fall the accepted amount of the balance may not be below what was already requested (`requested ≤ accepted`), so a fall that reaches work already claimed
is refused as **409 `VALUE_EXCEEDED`** (rule `REQUESTED_LE_ACCEPTED`) and the whole adjustment with it. The alternative, letting the accepted amount drop under the claim, would leave a payment request larger than what was
accepted with no entry to say who owes the difference; that is a recovery of an overpayment, which belongs to PAY, not to this story (see "What is not here").

### 2. How the unit-price difference is computed

* **Which items.** Only the items whose **unit price the change order changes against the BOQ in force when it is approved**. The call carries the new BOQ (`boq_lines`, like the decision); the lines of an item whose price equals
  the price in the BOQ in force (compared as numbers, `1500000` equals `1500000.000000`) are not re-priced, whatever the snapshots of older acceptances say. Otherwise a revision in between that raised another price would be undone by a
  change order that never mentioned it. A new item, an item the new BOQ no longer prices, and a new rounding rule alone, re-price nothing.
* **Which lines.** Every approved, active line of such an item accepted **on the effective day or after** (the day is inclusive, like the first day of a revision), whichever revision priced it. The change order stands over the
  revisions since its day: an acceptance of 2 August priced at 2,100,000 under revision 2 is re-priced to the new price of a CO that applies from 1 June.
* **The difference of a line** is `round(quantity × new unit price) − amount the line was accepted for`, rounded as the **new** line of the BOQ is rounded (`HALF_UP`, `DOWN`, `UP`, `HALF_EVEN`). It is the difference of the
  rounded amounts, not `(new − old price) × quantity`: after the adjustment the line is worth exactly what it would have been accepted for at the new price, with no unit of rounding lost or made. (Example: 3 at 1,234.5 accepted
  for 3,704; at 1,235.5 `HALF_UP` it is 3,707 and the difference is 3, not 3.) A line whose difference is zero has no adjustment.
* **The entry.** The lines of one item of one acceptance (and member of a joint venture) are one balance of the ledger and one adjustment line; the entry is the sum of their differences.

UAT-AC58 in numbers: B02, 500 m3 accepted on 25 July at 2,000,000 (1,000,000,000); a CO from 1 June sets 2,100,000; the line is worth 1,050,000,000, the entry is +50,000,000, the balance's accepted amount goes from
1,000,000,000 to 1,050,000,000, the acceptance and its line still say 1,000,000,000, and the accepted total of the contract rises by 50,000,000.

### 3. The revision, and the day it is in force from

The revision a retroactive CO makes is the next one in the history (`retroactive = true`, kind `CHANGE_ORDER`), **in force from the day of the approval** and put in force at once (the job `revision-effective` has nothing
left to do for it): `putRevisionInForce` is the code the job uses, shared. It is not back-dated. The history of revisions is a line where exactly one is in force at a time, an acceptance takes the price of the revision in
force on its day (BR-CTR-03), and a back-dated revision would put two in force on the same day. The day the change reaches back to (`effective_on`, a day before today) is kept on the change order
(`change_request.effective_on`, `retroactive = true`) and on the record of the adjustment; the work accepted from that day is paid for by the entries, and the work accepted from today is priced by the revision. It
is put in force at once because the ledger it adjusts is judged against the value the contract has after the change: `contract_ledger_order_chk` (accepted total ≤ value) must hold when the entries are posted.

The call is refused (409 `CONTRACT_STATE_INVALID`, `reason: REVISION_PENDING`) while another revision waits for its day, and (422 `VALIDATION_FAILED`, `reason: NOT_AFTER_REVISION`) when the revision in force began today or later.

### 4. What "approved settlement" means

A settlement blocks the call when it is `VERIFIED` or `CLOSED` (its figures were read from the ledger and certified; a returned, draft, submitted or verifying one is still being worked) and it **has read the entries
the call would post** (`settlementBlocks`, mirroring `PayProjectSettlementStore.figuresOf`): a settlement of the **contract**, of the **project** of the contract, or of a **year** that is the year of the posting (Vietnam time) or
later, since a settlement of a year reads the entries posted before the year ends and a year that is over was settled with all its entries already posted. 409 `SETTLEMENT_ALREADY_APPROVED`, naming the settlement.

### 5. The list of affected acceptances

The caller names them (`affected_acceptance_ids`, at most 500, each once whatever the case of the uuid) and the list must be **exactly** the acceptances the change reaches (rule 2). The server computes the set itself and a
list that differs is 422 `VALIDATION_FAILED` on `affected_acceptance_ids`, `reason: AFFECTED_MISMATCH`, with `missing_acceptance_ids` and `unexpected_acceptance_ids`. A call that silently re-priced some acceptances and left
others at the old price would be worse than a refusal, and a call that trusted the list would let a caller choose the acceptances it re-prices. A change that reaches none (no price moved, or none accepted from the day) is
allowed with an empty list: the revision is made and no entry is posted.

### 6. An adjusted acceptance is not withdrawn

`revokeAcceptance` takes back the entry that recognised the acceptance and lowers the accepted total by the amount of the approval; an adjustment on its balance would stay behind. A revocation of an acceptance that has an
adjustment line is refused (409 `ACCEPTANCE_STATE_INVALID`, `reason: RETROACTIVELY_ADJUSTED`), and the database refuses the status change too (trigger `acceptance_adjusted_guard`).

## The command (`approveRetroactiveAdjustment`, `change.retroactive.approve`, If-Match, Idempotency-Key)

`POST /change-requests/{id}/retroactive-adjustment` with `{ adjustment_basis, decision_document_version_id, affected_acceptance_ids, effective_on, approved_delta_vnd?, boq_lines? }`. `effective_on` is new in the
contract (required; the evaluation of a change order carries no day; `compat-allow.json` records it); `approved_delta_vnd` defaults to the assessed amount; without `boq_lines` the revision is a copy of the BOQ in force
and no price moves. Refusals, in this order (all in one transaction: nothing is left behind by any of them):

| step | refusal |
|---|---|
| the shape: `adjustment_basis` blank or over 2000 characters, `effective_on` not a calendar day, an id that is not an id or more than 500 | 422 `VALIDATION_FAILED` |
| the request is outside the scope of the caller, or does not exist | 404 |
| the version in `If-Match` is not the current one | 409 `VERSION_CONFLICT` |
| the request is not a CO | 422 `CHANGE_STAGE_NOT_ALLOWED` (`ONLY_CO_DECIDED`) |
| the CO is not EVALUATED (a second call finds it APPROVED) | 409 `CHANGE_STATE_INVALID` |
| the contract is not ACTIVE or SUSPENDED | 409 `CONTRACT_STATE_INVALID` |
| no decision document, or one that is infected or a sealed bid | 422 `DECISION_DOCUMENT_REQUIRED` |
| the caller raised, promoted or assessed a request of the chain, or made the decision document | 403 `SELF_APPROVAL_DENIED` |
| `effective_on` is today or later | 422 `VALIDATION_FAILED` (`NOT_RETROACTIVE`: decide it the ordinary way); before the contract began: `BEFORE_CONTRACT` |
| a settlement that read the ledger is VERIFIED or CLOSED | 409 `SETTLEMENT_ALREADY_APPROVED` |
| the revision in force began today or later; one waits for its day | 422 `NOT_AFTER_REVISION`; 409 `CONTRACT_STATE_INVALID` (`REVISION_PENDING`) |
| the value after the change is not above zero; the lines of the BOQ add up to more than the value | 422 `VALIDATION_FAILED` (`approved_delta_vnd`); 422 `BOQ_TOTAL_MISMATCH` |
| the list of acceptances is not the one the change reaches | 422 `VALIDATION_FAILED` (`AFFECTED_MISMATCH`) |
| the larger of the change and the money it moves on the ledger is above the delegation limit of the caller (document type `CTR_CHANGE`) | 403 `SCOPE_DENIED` |
| the new value is below the floor, counting what the adjustment adds to the accepted total (BR-CTR-06) | 422 `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT` |
| an increase of the contract that the line of capital cannot take | 422 `ALLOCATION_UNAVAILABLE` |
| an acceptance the ledger has not recognised yet (the event is still on its way) | 409 `ACCEPTANCE_STATE_INVALID` (`NOT_ON_LEDGER`), to be retried |
| an entry that would break a rule of the ledger (a fall below what was requested, below nothing) | 409 `VALUE_EXCEEDED` |

On success, in one transaction: the revision is made with the BOQ and put in force (the one before it SUPERSEDED, value and current revision of the contract follow); the record is written (`retroactive_adjustment` with the
day, the basis, the decision document and the total, and one `retroactive_adjustment_line` for each balance); one `ADJUSTMENT` entry is posted on each balance in the order of the ledger registry after the lock of the
contract (`PayLedgerStore.adjust`, the PAY port of the story); the accepted total of the contract moves by the total; the CO becomes APPROVED with `effective_on`, `retroactive`, the document, the amount and the resulting
revision. The answer is the `CommandResult` of the CO (status APPROVED).

Audit: `change.retroactive_applied` (with the basis as the reason), `contract.revision_created`, `contract.revision_effective`, `ledger.adjusted` (every entry). Events: `ctr.change.retroactive_applied.v1`,
`ctr.contract_revision.created.v1`, `ctr.commitment.changed.v1` (the capital is told the new value, as when the job puts a revision in force), `pay.ledger.adjusted.v1` (drops the cached pages of the ledger). They carry ids, days
and amounts, never the words of the basis.

## What the database holds (V1394)

* `retroactive_adjustment` and `retroactive_adjustment_line`: row level security, an index on every id, the unique key of a change order (adjusted once) and of a revision, one line per balance of an adjustment. Never changed
  or deleted by anyone (`RETROACTIVE_ADJUSTMENT_IMMUTABLE`; `machvon_app` also loses UPDATE, DELETE, TRUNCATE). `effective_on < approved_on`; the difference of a line is `new − old` and never zero. A line is about the contract of
  its adjustment, an **approved** acceptance of that contract, and an item and a member of it.
* At every commit (deferred constraint triggers) the header says what its lines are (`ADJUSTMENT_SUM_MISMATCH`) and each line has exactly one entry of the ledger (`ADJUSTMENT_LEDGER_MISMATCH`).
* `cumulative_ledger_entry`: the kind `ADJUSTMENT`, the column `adjustment_line_id` (foreign key, index, one entry per line), and the checks and the guard of section 1.
* `acceptance_adjusted_guard`: section 6.

## Reads and screens

* `getContractSummary` / `GET /resources/contract/{id}` carry `retroactive_adjustments` (by right of the ledger only: a guest contractor sees the flag of a revision, never the money): for each adjustment the day, the basis, the
  total, and the balances it moved (acceptance, item, quantity, what it was accepted for, the new price and amount, the signed difference).
* The board of changes (`getChangeChain`) reads `retroactive` on a request and `actions.adjust` (an assessed CO, a contract being performed, the permission `change.retroactive.approve` over it, and not a person of the chain).
* The ledger page (PAY-10) lists the new kind with its sign (`ADJUSTMENT`).
* **CTR-26** (revisions): a revision that reaches back says so, lists the acceptances it re-priced with the difference on each (for those who read the ledger) and links to CTR-14.
* **CTR-14** `/ctr/ctr-14?id=<contract>&request=<co>`: the delay summary (completion day of the contract, the days of the approved COs and the day it moves to, the days of the COs waiting for a decision) and the form of the
  adjustment: day (before today), decision document, change of value, new BOQ lines (JSON), basis, and the acceptances from that day on to tick. A refusal with `AFFECTED_MISMATCH` shows which acceptances the list left out and
  which it named in vain, with a button that puts the list as the server found it. One attempt for each intention: the retry after a lost answer keeps the version and the idempotency key of the first request. Below the form,
  the adjustments already made.

## What is not here

* **Paying the difference.** The ledger now says the balance's accepted amount is higher or lower; a payment request is still drawn up for one acceptance and its lines (`acceptance_line`, unchanged), so an increase is not
  yet claimable and a fall that reaches what was claimed is refused. Claiming the difference of an adjustment, and recovering an overpayment when a price falls on work already paid, need a request kind in PAY. Until then the
  money is on the ledger, and in the totals, but not on a payment request.
* **The price of delays and of compensation claims.** CTR-14 shows the schedule impact of the change orders only. What a delay costs, the responsibility and the claim file (the fields of the screen in the catalogue) depend on a
  business rule that is not specified (`assumption` of the story); no table and no command exist for them.
* **A preview.** The screen cannot show the money before the call: the server answers a wrong list with the acceptances it found, but not their amounts.
* **A settlement under review** (SUBMITTED, VERIFYING) is not a block, as the story says "approved": its figures were read when it was sent and are read again if it is returned.
* **Two adjustments on one day.** A revision is in force from its first day to the first day of the next, so two revisions cannot begin on the same day (`valid_from < valid_until`): a second retroactive CO of the same contract
  approved on the day of the first (or on the day the job or an ordinary decision put a revision in force) is refused with 422 `NOT_AFTER_REVISION` and waits for the next day.
* **Correcting an adjustment.** A change order is adjusted once; a mistake is put right by another change order that adjusts again.
* **Members of a joint venture** share a contract value that the change does not re-split (BR-CTR-08 is judged when the contract leaves the draft only), as for the ordinary decision.
