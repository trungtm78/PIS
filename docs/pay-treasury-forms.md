# The Treasury forms of a payment request (ST-PAY-005)

PAY 3.3 steps 1 and 2, CXN-08. Screens PAY-04 (follow-up of what goes to the Treasury) and PAY-14 (the forms of one request). The statement import, the callback and the matching are ST-PAY-006 and later; **no call is made to the Treasury**: the file is taken there by the accountant, and the day and the number the Treasury gave it are entered by hand.

## The four forms

`03.a/TT`, `04.a/TT`, `04.b/TT`, `05.a/TT` (packages/kernel/src/pay-forms.ts; the database holds the same four, and a test reads the migration to keep the two equal). They await the original appendix of Decree 254/2025 (CXN-08, R-PAY-02): until it is verified, the codes and what the templates say are working assumptions of the platform and every template is the tenant's own data in the DOC library.

## Drawing the forms (`generatePaymentForms`, `payment.forms.generate`)

`POST /payment-requests/{id}/forms` with `form_codes` (one to four of the forms) and `place` (the place of the place-and-date line).

1. The contract is locked, then the request; it must be **checked** (`VERIFIED`): 409 `PAYMENT_STATE_INVALID` otherwise (a request that was sent has its forms as they were sent).
2. For each form asked for, in the order of the list: DOC is asked for the template of that form code in force today (`DocumentStore.templateFor`, the latest revision of the published template in force) and renders it with `requireConfirmed`: a template (or its layout profile) that waits for its legal confirmation is 422 `TEMPLATE_UNCONFIRMED`; none in force is 422 `TEMPLATE_NOT_EFFECTIVE`. The refusal names the form (`form_code`).
3. The payload is made by the server from the figures of the request (`formPayload`): the agency (the investor unit), the place, the request number, the contract, the contractor, the project, the plan year, and gross, recovery, retention, tax adjustment and net, each as whole dong and as text in groups of three digits. The client sends none of them.
4. DOC stores the PDF (a document of the tenant, a clean version); PAY keeps `payment_form_instance` rows: template code and revision, the legal basis of that revision, the document and its version, the SHA-256 of the file, the SHA-256 of the payload and of the whole render input, who and when.
5. A new form for the same request and kind makes the one before `SUPERSEDED`; exactly one stands for each kind (`payment_form_request_uq`).

The forms asked for in one call are drawn all or none: a refusal rolls the call back. To draw the forms one by one (as in UAT-AC337, where two of three are refused) the call names one form. Every call is audited and tells PAY once (`pay.payment_form.generated.v1`, with the forms, their template revisions and hashes).

The field mapping (data → cell of the form) is the accountant's to sign: value of the accepted work ← `gross`; advance recovered ← `advance_recovery`; retention ← `retention`; amount asked for ← `net`; contract, contractor, line of capital and plan year from the records of the contract. The codes and columns are not hard-coded in PAY beyond the four form codes.

## Recording that the file was sent (`markPaymentSentToTreasury`, `payment.treasury.send`, versioned)

`POST /payment-requests/{id}/send-treasury` with `treasury_submitted_on` (a real day, not after today), `treasury_ref` (optional, as entered) and `form_instance_ids`.

* the request must be `VERIFIED` and the version the one the caller saw;
* the ids must be forms that **stand** for this request, and between them cover all four kinds, else 422 `FORMS_NOT_GENERATED` with `missing_form_codes` (an id of a superseded form, or of another request, is 422 `VALIDATION_FAILED`);
* the request goes to `SENT_TREASURY` with the day, the number, who recorded it and when. Its figures and forms are not touched.

## What the database keeps (V1566)

* a form is drawn for a checked request, carries the whole proof (template, document, hashes, who and when) and is never changed except to be superseded; it is never deleted or truncated;
* a request moves to `SENT_TREASURY` only with the day, the person and a standing form of each of the four kinds (`FORMS_NOT_GENERATED`), whoever writes the row;
* a request that comes back (returned inside or by the Treasury) supersedes the forms drawn for its old figures; they are drawn again when it has been corrected and checked.

## Screens

* **PAY-04** the requests checked and sent, with the forms that stand (of four), the day and the number; each row leads to PAY-14.
* **PAY-14** the four forms with the template revision, the legal basis and the hash of the one that stands, the ones it replaced, the commands to draw one or all (asking the place) and to record the send (asking the day and the number). PAY-03 leads to it once the request is checked.

Browser flow `apps/web/e2e/pay-payment-flows.spec.ts` (the last test); visual regions PAY-04 and PAY-14.
