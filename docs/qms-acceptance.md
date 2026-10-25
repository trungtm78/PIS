# QMS: quality acceptance minutes (ST-QMS-005, slice QMS-1)

An inspection that passed (docs/qms-inspections.md) is followed by **minutes**: the record that the work was accepted for its quality, signed by each role the regime required of the
inspection, approved by someone other than whoever drafted them, and sent to CTR, which takes it when it accepts the quantities of work (QMS 3.2, BR-QMS-02, BR-QMS-03, BR-QMS-05).

## Drafting (`createQualityAcceptance`, `qacceptance.manage`)

| rule | refusal |
|---|---|
| the contract is `ACTIVE` | 409 `CONTRACT_STATE_INVALID` |
| the inspection has a recorded result of `PASS` or `CONDITIONAL` | 422 `INSPECTION_NOT_PASSED` |
| the scope fits the kind of inspection: `WORK_ITEM` from a material, concealed-work, safety or other inspection, `STAGE` from a construction stage, `PART` from a part acceptance, `COMPLETION` from the completion | 422 `VALIDATION_FAILED` (`acceptance_scope`) |
| no serious non-conformance of the contract is open (`quality_nonconformance.blocks_acceptance` and not `CLOSED`) | 422 `OPEN_CRITICAL_NCR` |
| the paper is a clean file version of the tenant | 422 `VALIDATION_FAILED` (`document_version_id`) |
| one live set of minutes for an inspection (drafted, being signed or approved; rejected and revoked ones make room) and a number once for the contract | 409 `QUALITY_ACCEPTANCE_STATE_INVALID` (`reason`: `ALREADY_DRAFTED`, `RECORD_NO_USED`) |

The minutes copy from the inspection the roles that sign (`required_roles`, the snapshot of the regime of the day the inspection was asked for; the completion has the designer too), the regime
version and whether it waits for its confirmation (CXN-07). They store `content_hash`: the SHA-256 of what the signers sign (the minutes, the scope, the paper, the roles, the result and the
answers of the checklist, in sorted keys, BR-QMS-02). Nothing about the minutes changes after they are drafted (trigger `guard_quality_acceptance`).

## Signing (`signQualityAcceptance`, `qacceptance.sign`, versioned)

A signature is a row of `qms_signature` (`subject_kind = QUALITY_ACCEPTANCE`): the role, the person, the name at the time, the method, what it is worth, the certificate serial and the hash it is over.
It is never updated or deleted (privileges revoked). A database trigger refuses a signature for a role the minutes do not require, over a hash other than theirs, or on minutes that are not being signed.

| rule | refusal |
|---|---|
| the minutes are `DRAFT` or `SIGNING`; the first signature moves them to `SIGNING` | 409 `QUALITY_ACCEPTANCE_STATE_INVALID` |
| the role is one the minutes require | 422 `ROLE_NOT_REQUIRED` |
| `DIGITAL_CERT` carries its serial and no other method does; only a certificate is a `LEGAL_E_SIGNATURE`, an in-app confirmation (`IN_APP_OTP`, `IN_APP_WEBAUTHN`) is an `INTERNAL_RECORD` (BR-QMS-03) | 422 `SIGNATURE_METHOD_NOT_ACCEPTED` |
| the hash the minutes carry is the hash of what they say | 409 `QUALITY_ACCEPTANCE_STATE_INVALID` (`reason: CONTENT_CHANGED`) |
| the role is the signer's to sign: a guest of the contractor of the contract (or of a member of its joint venture) signs as `CONTRACTOR` and as nothing else; the staff signs as `SUPERVISOR`, `OWNER` or `DESIGNER`; a guest of another firm signs as none | 403 `SCOPE_DENIED` (`detail: signer_role`) |
| a role signs once over the same hash, and a person signs once | 409 `ALREADY_SIGNED` |
| `client_operation_id` is used once | 422 `VALIDATION_FAILED` |

## Deciding (`decideQualityAcceptance`, `qacceptance.approve`, versioned)

`approve` is refused, in this order: a serious non-conformance of the contract is open (422 `OPEN_CRITICAL_NCR`, judged before the state, so minutes that are only drafted are refused for it too,
UAT-AC361); the minutes are not being signed (409); the caller drafted them (403 `SELF_APPROVAL_DENIED`); the hash changed (409); a required role has not signed over the hash (422
`SIGNATURES_INCOMPLETE`, `missing_roles`); the contract is no longer `ACTIVE` (409). Approving emits `qms.quality_acceptance.approved.v1` (`quality_acceptance_id`, `contract_id`,
`inspection_id`, `boq_item_id`, `acceptance_scope`) once: the event key is the version it was approved at, and a repeated key answers the first response. `reject` needs the reason and moves
`SIGNING` to `REJECTED`; it is audited (`quality_acceptance.rejected`) and sends no event.

## Revoking (`revokeQualityAcceptance`, `qacceptance.revoke`, versioned)

Only `APPROVED` minutes, with a reason, kept with them. Refused while an approved acceptance of work holds them (`acceptance.quality_acceptance_id` with status `APPROVED`): 409
`ACCEPTANCE_ALREADY_USED`. Emits `qms.quality_acceptance.revoked.v1`, which CTR takes to unlink the minutes from the acceptance it holds in a draft (ST-CTR-009).

## Reading (`listQualityAcceptances`, `getQualityAcceptance`, `qacceptance.read`)

The minutes of the contracts in the scope of the caller, newest first (filters `contract_id`, `inspection_id`), with the signatures (`valid` is false for one over another hash), the roles still
missing, the number of serious non-conformances still open, the regime warning, and what the caller may do (`actions`, `signable_roles`: a person who signed already, or who is on the other side, is
offered no signing; whoever drafted the minutes is not offered the approval).

## The table (V1461)

`content_hash`, `regime_awaiting_confirmation`, `regime_cxn`, `rejected_*`, `revoked_*`, `revoke_reason`; checks (words trimmed and bounded, roles a non-empty list of the four, the shape of each decision,
the approver is not the drafter); the unique index `quality_acceptance_live_uq`; the unique index `qms_signature_person_uq`; the guards `guard_quality_acceptance` (identity and content never change, the
edges `DRAFT → SIGNING → APPROVED | REJECTED`, `APPROVED → REVOKED`, an approval is kept) and `guard_quality_acceptance_signature`; `DELETE` and `TRUNCATE` revoked from the application role for the minutes,
`UPDATE`, `DELETE` and `TRUNCATE` for the signatures.

## Screen QMS-05

`/qms/qms-05?contract=<id>`: the minutes with, for each required role, who signed, when, how and what the signature is worth (an in-app confirmation says it is an internal record, not a digital
signature), the warning while serious non-conformances are open or the regime waits for CXN-07, and the dialogs to draft (from the inspections that passed and have no live minutes), sign, decide and revoke.
