# Payment integrity checks and exceptions to the ceilings of disbursement (G4-2, G4-5 ceilings; lane D)

Spec: `Design/MACHVON_Design/01_Documents/05_modules/PAY.md` section 3.3b and `AUD.md` (AUD-12). Screens: PAY-03 (panel), PAY-21 (register of exceptions), AUD-12 (findings). Migrations: V1835 to V1839 (block GOV-7).

## What it does

A payment request is checked inside the transaction of `post_payment_requests_id_submit`, before it takes the claim on its acceptance and before anything is put on the books. The check is the new `PaymentIntegrityGuard` (`apps/api/src/modules/pay/payment-integrity.controller.ts`), one call at the top of `PaymentClaimController.submit`; the store is `PayIntegrityStore` (`packages/db/src/gov-d-integrity-store.ts`) over the pure kernel module `packages/kernel/src/gov-d-integrity.ts`.

| Code | Kind | Meaning | Built on |
|---|---|---|---|
| `DUPLICATE_CLAIM` | invariant (all `block_attrs` match) or signal (at least `signal_min_matches`) | another live request of the look-back looks the same | `payment_request`, `payment_document` |
| `EXCEEDS_CONTRACT` | invariant (or signal if the rule says `WARN`) | requested total or cash out (paid + advances not yet recovered) above the price in force | `contractAvailability` (money control, CAP-17) |
| `EXCEEDS_PLAN` | invariant | net above what the capital plan line has left | `allocation_balance`, the same arithmetic as `PayClaimStore.assertLineHasRoom` |
| `EXCEEDS_ACCEPTED` | invariant | gross above the accepted value of the acceptance | `acceptance.accepted_amount_vnd` |
| `UNIT_PRICE_OUTLIER` | signal | unit price far from the contract price or from like items (robust z-score, median and MAD) | `acceptance_line`, `boq_line` |
| `QUANTITY_VS_DIARY` | signal | too few working days of the measured period with a diary, or a quantity above what the diaries record | `QmsDiaryCoverageReads`, `site_diary.content.work_done[]` |

Invariants block; signals are stored for the approver. A blocked send answers 422 with the code of the first standing invariant (ceilings before duplicates), commits the run and its findings (`scope.refuseAfterCommit`, stored as the answer of the idempotency key) and leaves the request a draft.

### Rule

Type `PAYMENT_INTEGRITY`, code `DEFAULT`, registered in `registerIntegrityRules` of `packages/kernel/src/governance-rules.ts`, read by `resolveGovD` (the approved version in force on the day, else the built-in default, flagged unconfirmed). Every run stores the version, the source (`RULE` or `DEFAULT`), the params and the day it applied. Defaults: block on number + supplier + amount; signal at 3 of 4 attributes; look-back 365 days; contract tolerance 15 percent; at least 5 peers; robust z 3.5; diary ratio 0.5 and tolerance 10 percent; all ceilings `BLOCK`; exceptions up to 30 days. All are starting values of the research (`legalStatus UNVERIFIED`).

### Diary convention

The site diary is free text of the contractor. To judge quantities the checks read an optional array `content.work_done`, each element `{ "boq_key": "B01", "quantity": "120.5" }`. Items for which no diary of the period gives a quantity are not judged on quantity; coverage (days with a diary over working days of the calendar `WORKDAY_VN`) is always judged. A year without a published calendar makes the diary source unavailable: the run says so and is PARTIAL, never PASSED.

### Never a silent pass

Prices and the diary feed signals only: a source that cannot be read is listed in `unavailable` (read in a savepoint, so the transaction goes on) and the outcome cannot be PASSED. Duplicates and ceilings are invariants: when they cannot be read the command fails.

## Exceptions

`disbursement_exception` (V1836): asked for a draft that a ceiling blocks (the ceiling must really stand, the amount must cover the excess, the day must be within `exception_max_days`), decided by someone other than whoever asked, drew up or sent the request, used once by the sending that goes under it (same transaction, so a refused send does not use it) and lapsing on its day (EXPIRED is derived). Only `EXCEEDS_PLAN` and `EXCEEDS_CONTRACT` have exceptions. The value of an acceptance is kept by the ledger and has none.

Limits the exception does not lift, on purpose: an `EXCEEDS_PLAN` exception lets the request through the check of the line when sending; the database check `allocated >= committed + disbursed` still holds when the Treasury payment is matched, so the line has to be adjusted (reallocation) before money leaves. An `EXCEEDS_CONTRACT` exception covers cash out with advances not yet recovered; the checks `requested <= accepted <= contract value` of the ledger stay.

## Tables

`payment_integrity_run` and `payment_integrity_finding` are append-only (revoked for the app role and a trigger for everyone else). `disbursement_exception` has a unique live index per (request, ceiling), a four-eyes CHECK and a window CHECK (V1838).

## Alerts

`PAYMENT_INTEGRITY_BLOCKED` (ACTION), `PAYMENT_INTEGRITY_SIGNAL` (WATCH) and `DISBURSEMENT_EXCEPTION_EXPIRING` (WATCH) are registered as `ALERT_TYPE` defaults. `PayIntegrityAlertSource` (`packages/db/src/gov-d-integrity-alerts.ts`) reads the three from the tables for a scope: blocked drafts (latest run BLOCKED, request still DRAFT), requests sent with signals and waiting for the approver, approved exceptions that lapse within the window or lapsed unused. The alert centre reads them (integration GOV-INT, `packages/db/src/home-integrity-sources.ts`) as the sources `PAYMENT_INTEGRITY` (kinds `PAYMENT_INTEGRITY_BLOCKED` and `PAYMENT_INTEGRITY_SIGNAL`, a blocked draft is read back 30 days, opens PAY-03) and `DISBURSEMENT_EXCEPTION` (kind `DISBURSEMENT_EXCEPTION_EXPIRING`, an exception that lapses within 7 days or lapsed within the last 7, opens PAY-21), each with its own failure; they belong to the leader accountable for the project and to the one who drew up or sent the request, and in the view scope to whoever reads the project.

## Tests

`packages/kernel/src/gov-d-integrity.test.ts` (30 unit cases), `apps/api/test/gov/payment-integrity.test.ts` (13 cases over HTTP on the db lane), `apps/web/src/screens/pay/integrity/integrity.test.tsx` (21 cases: model, panel, register, AUD-12 including the states).
