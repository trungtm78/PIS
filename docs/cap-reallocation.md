# The reallocation of capital from slow to fast projects (ST-CAP-010)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/CAP.md` (F5, BR-CAP-05, BR-CAP-07). Migration `V1369__cap1_reallocation_workflow.sql`. Operations: `draftReallocationProposal`, `submitReallocationProposal`, `decideReallocationProposal`, `applyReallocationProposal`, `listReallocationProposals`. Screen: CAP-19. Event: `capital.reallocation_applied.v1` (with `capital.plan_published.v1` for the revision it makes).

## The proposal

`DRAFT` -> `SUBMITTED` -> `APPROVED` -> `APPLIED`; `SUBMITTED` -> `REJECTED`, or back to `DRAFT` by a return (the author changes it and submits again). `WITHDRAWN` is in the data model, but the contract has no command for it.

- **Draft** (`capital.reallocation.propose`, in the scope of the unit of the plan): from a published plan, in the year and the unit of that plan, on a **frozen** snapshot of the disbursement (422 `SNAPSHOT_NOT_FROZEN`). Each line names a line of the plan to reduce, a receiving project and a whole positive amount. The receiving side is the line of that project in the **same appropriation, bucket, source year and budget level** (the same origin when there are several): a project with no such line is a move to another appropriation (NSTW to NSDP), so **422 `TRANSFER_UNBALANCED`** (BR-CAP-07: the total of the appropriation never changes). A donor line keeps at least what is **reserved, committed and disbursed** on it (422 `REVISED_BELOW_COMMITTED`, every line listed). The line keeps the basis it rests on (what the snapshot says the plan holds and the Treasury paid for both projects). A duplicate code is 409.
- **Submit** judges the plan, the lines and the floors again (409 `PLAN_CHANGED_SINCE_PROPOSAL` if the plan has a newer revision).
- **Decision** (`capital.reallocation.approve`): approve, reject or return, with the reason. **Neither the author nor the submitter may decide** (403 `SELF_APPROVAL_DENIED`; the same rule is in the database). This is also what lets the plan revision made on application keep the four-eyes of the plan.
- **Apply** (`capital.reallocation.apply`, the version of the proposal, the decision document, 422 `DECISION_REQUIRED` if it cannot be used): in **one transaction** a revision of the plan is made (the author is its maker, the submitter submits it, the approver approves it, as the plan's own rules want three different people), the donor lines are reduced and the recipient lines increased, and the revision is published by the applier with the document: the ledger gets `TRANSFER_OUT` and `TRANSFER_IN` entries that all name **the proposal** as their one source (`source_ref_kind = REALLOCATION`), the balances move with them, the plan in force is SUPERSEDED, the totals do not change. The applier is neither the author nor the submitter. The revision takes effect now, or when the plan it replaces does if that is later.
- **PLAN_CHANGED_SINCE_PROPOSAL** (409): the source plan is no longer the plan in force, or a newer revision exists; nothing is applied. A revision that is still in work is 409 `REVISION_PENDING_EXISTS`. The floors are judged again on the day of the application.

## Reading

`listReallocationProposals` (`capital.read`) lists the proposals of the units the reader may read, newest first, with the lines and what each side holds in the plan (the screen shows each before and after), by status and year, a page at a time (cursor `createdAt|id` with microseconds).

## Screen CAP-19

The list with a status filter, a draft form (plan, snapshot, reason and a list of lines: line to reduce, project to increase, amount, basis), the detail with **the donor on the left and the recipient on the right, each before and after, and the balance under them**, and the dialogs to decide and to apply (the application asks for the decision document and is offered only on an approved proposal, to someone who is neither its author nor its submitter).

## Assumptions and limits

- The thresholds that suggest donors and recipients (an estimate under 80% of the plan, 15 points behind the curve) are assumption data; this release lets the planner choose the lines. The estimate that tells a slow project (ST-DIS-018) is shown on DIS-23, not computed here.
- AC-ST-CAP-010-2 (the proposal follows the version of the approval workflow bound at its start, with two levels) needs the workflow engine and DoA of ADM (ST-ADM-012, not yet implemented): the domain guard (four-eyes) is in place and tested, the binding to a workflow version is not.
