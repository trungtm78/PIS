# The forms of a settlement and the calendar of its verification (ST-PAY-012)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/PAY.md` (3.5 steps 3 and 4, PAY-16, UAT-AC339, UAT-AC340). Migration `V1572__pay1_settlement_forms.sql`. Operations: `generateSettlementForms` (`POST /settlements/{id}/forms`, `settlement.forms.generate`, in the contract since the design) and one read added to it, `listSettlementForms` (`GET /settlements/{id}/forms`, `settlement_revision.read`). The reminders of the calendar are the job `settlement-deadline` of ST-PAY-009 (`docs/runbooks/jobs.md`).

## The rule

A settlement that is **verified** and is of a year (`ANNUAL`) or of a completed project (`PROJECT`) is drawn up with the forms of its scope, through DOC; a settlement of one contract has none (422 `VALIDATION_FAILED` on the settlement). The pure rule is `packages/kernel/src/pay-settlement-forms.ts`; the codes await the original forms (CXN-09).

- **The forms.** Year: `01/QTNĐ` to `05/QTNĐ`. Project: `01/QTDA` to `12/QTDA`, of which `10/QTDA` is the decision that approves the settlement. A form of the other scope, an unknown one or one named twice is 422 `VALIDATION_FAILED` on `form_codes`, naming the form; the forms asked for are taken in the order of the list.
- **The template.** For each form, DOC holds the template in force on the day under the form code; it must be confirmed (422 `TEMPLATE_UNCONFIRMED`, CXN-09) and in force (422 `TEMPLATE_NOT_EFFECTIVE`), and the refusal names the form. The forms asked for are all drawn or none is: a refusal keeps nothing. Without the document renderer bound, 503 `PROVIDER_UNAVAILABLE`.
- **The payload** is made from the figures of the settlement by the server (project, year, revision, group, the settled amount, what is still owed, the advance not recovered, the days of the sending and of the verification, and the place the person gave); the same settlement gives the same payload and the same hash. The mapping of the fields to the cells of the forms is the accountant's and the capital owner's to sign.
- **The proof.** Each form is a row of `payment_form_instance` (`subject_kind` `SETTLEMENT`, `settlement_revision_id`): the template and its revision, the legal basis of that revision, the file (document, version, hash), the hash of the payload and of the input of the render. Drawing a form again supersedes the one that stood for the same code (the unique index `payment_form_settlement_uq`); nothing is changed or deleted.
- **The decision 10/QTDA** is drawn like the other forms (the file is its proof) and, besides, DOC holds an outgoing document in DRAFT for it: drafted by the unit that owns the project, with the template and the payload of the form and the settlement as its subject (`subject_module` PAY); the answer names it (`decision_draft_id`) and the audit row `outgoing_document.create` starts its trail. One decision is drafted for a settlement while one that is not cancelled stands, so drawing the form again drafts no second. The review, the signature and the issue are DOC's own steps (it has no recipient or signer yet); the closing of the settlement still needs the decision issued (ST-PAY-009, UAT-AC340).
- **The state.** A settlement that is not verified is 409 `SETTLEMENT_STATE_INVALID`; the database says the same (the trigger `payment_form_instance_guard` refuses a form of a settlement that is not verified or of a contract, and the check `payment_form_instance_settlement_code_chk` the code that is not one of the 17).
- **The caller.** Holds `settlement.forms.generate` over the project: a settlement outside the scope is 404, and a caller without the right is 403. The audit row `settlement_revision.forms_generated` and the event `pay.settlement_form.generated.v1` carry the ids, the scope and, for each form, the code, the template revision and the hashes.

## The read

`listSettlementForms` lists the forms of a settlement in the scope of the reader, the ones that stand first and then the ones they replaced, newest first. A settlement the reader cannot reach is 404.

## The screen (PAY-16)

`SettlementFormsScreen`: the **calendar** lists the settlements that were sent and wait for their verification, by their last day, with the day they were sent, the days left (negative once late) and the stage of the reminders (overdue, 7 days or fewer, 30 days or fewer, not yet), each linking to PAY-15. Below it, the verified settlements that have forms are chosen; their forms are listed with the template and its revision, the legal basis, the first characters of the hash and the moment; the decision is told apart. Who holds `settlement.forms.generate` has the button that opens the dialog: the forms of the scope as boxes and the place; the refusal is told in words with the form it names. A reader sees the calendar and the forms and nothing else.

## What is not done

- The originals of the forms and the mapping of their fields are not confirmed (CXN-09): the templates are those the legal officer publishes in DOC, and the platform draws none whose template waits for its confirmation.
- The reminders at 30 days, 7 days and overdue are sent by the job of ST-PAY-009; the calendar only shows where each settlement stands.
- A settlement of one contract has no form; the contract is closed by CTR-17.
