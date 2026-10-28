# QMS: electronic site diary (ST-QMS-001, slice QMS-1)

The contractor writes the diary of each working day of a contract; the supervisor remarks on it; the owner confirms it; and it is locked, after which only a correction replaces it
(QMS 3.1, BR-QMS-01, BR-QMS-03). The three signatures are over one hash of what the diary says.

## The states

`DRAFT` → `CONTRACTOR_SIGNED` → `SUPERVISED` → `OWNER_CONFIRMED` → `LOCKED`, and `SUPERSEDED` for a locked diary whose correction was locked. The kernel (`packages/kernel/src/qms-diary.ts`,
`assertDiaryTransition`) refuses any other move with 409 `DIARY_STATE_INVALID` (extension `diary_status`). The owner may confirm only what the supervisor remarked on, and either may lock a
diary that was remarked on (`SUPERVISED` or `OWNER_CONFIRMED`). The trigger `guard_site_diary` (V1463) says the same in the database: identity columns never change, nothing is edited after `DRAFT`,
the remark of the supervisor is kept once written, and `machvon_app` has no `DELETE` or `TRUNCATE` on `site_diary`.

## Drafting and saving (`saveSiteDiaryDraft`, `reviseSiteDiaryDraft`, `diary.write`)

| rule | refusal |
|---|---|
| the contract is `ACTIVE` | 409 `CONTRACT_STATE_INVALID` |
| the day is not later than today in Vietnam (`vietnamDateOf`) | 422 `VALIDATION_FAILED` |
| the contract has a permit to start works (START_CONSTRUCTION gate) | 409 `PERMIT_GATE_BLOCKED` |
| the content is a non-empty object of at most 64 KiB; `weather_code` is an upper-case code; `workforce_count` is a whole number from 0 to 1,000,000 (`assertDiaryContent`) | 422 `VALIDATION_FAILED` |
| one main diary per contract and day; a second save of the same day without the version it was based on | 409 `DIARY_DAY_EXISTS` |
| a save based on a version other than the one that is held (an offline client that fell behind) | 409 `DIARY_SYNC_CONFLICT` |
| the diary is a draft | 409 `DIARY_STATE_INVALID` |

The number is `NK-{contract code}-{yyyymmdd}` (`-R{n}` for a correction). Every save carries `client_operation_id`: the same one again answers the first answer (`replayed`), it does not write twice. The diary keeps the operation that made it; an update of a draft (a save of the day or a revision) keeps its operation in `site_diary_operation` (append-only), so that a device that did not hear the answer and asks again with another key of the request is told what the update did and not that the draft moved on. A day whose diary was replaced by a correction has a diary: saving it is 409 `DIARY_STATE_INVALID`, and a correction is revised and signed through its own commands, never saved over. `reviseSiteDiaryDraft` is held to the same rules as a save: the contract must be `ACTIVE` and the permits of the start of construction open.

## Signing (`signSiteDiaryByContractor`, `addSupervisorRemark`, `confirmSiteDiaryByOwner`; versioned)

A signature is a row of `qms_signature` (`subject_kind = SITE_DIARY`), never updated or deleted. The contractor's signature fixes `content_hash` (SHA-256 of the canonical content, the contract, the
day and the diary it corrects, in sorted keys); the trigger `guard_site_diary_signature` refuses a signature of another role than the one whose turn it is, or over another hash. A person signs a diary once
(`qms_signature_person_diary_uq`, 409 `ALREADY_SIGNED`).

| rule | refusal |
|---|---|
| the signer is in standing for the role: the contractor as a member of the contractor of the contract (`contractor_id`), the supervisor and the owner as staff of the procuring entity (`rolesSignableBy`) | 403 `SCOPE_DENIED` (`signer_role`) |
| the method is one the role accepts (`assertSignatureMethod`); `DIGITAL_CERT` carries its serial and no other method does | 422 `SIGNATURE_METHOD_NOT_ACCEPTED` / `VALIDATION_FAILED` |
| the supervisor gives a remark (1 to 2000 characters); the owner may add a note | 422 `VALIDATION_FAILED` |

What a signature is worth (`legalEffectOf`): a certificate is a `LEGAL_E_SIGNATURE`; an in-app confirmation (`IN_APP_OTP`, `IN_APP_WEBAUTHN`) is an `INTERNAL_RECORD` and is never shown as a digital signature
(BR-QMS-03). Until the business settles the value of an in-app signature (**CXN-EXE-05**) every view carries `signature_value: { cxn: 'CXN-EXE-05', awaiting_confirmation: true }` and the screens say so.

## Locking and correcting (`lockSiteDiary`, `correctSiteDiary`)

`lockSiteDiary` (`diary.lock`) sets `locked_at`, `locked_by` and an optional reason. A locked diary is corrected with `correctSiteDiary` (`diary.correct`): a **new** diary with `correction_of_id` and
a `correction_reason`, drafted from the content the caller sends, signed again from the start. Only one correction of a diary is open at a time (`site_diary_correction_open_uq`, 409
`DIARY_STATE_INVALID` with `reason: CORRECTION_OPEN`). When the correction is locked the original becomes `SUPERSEDED`; until then the original stays as it is.

## Reads (`site_diary.read`)

`GET /resources/site_diary` (newest day first, keyset pagination on day and id; filters `contract_id`, `status`, `from`, `to`) and `GET /resources/site_diary/{id}`. The view is an allowlist: the content, the
signatures with name, method, effect, serial and whether they are over the hash the diary carries (`valid`), the roles the caller may sign as (`signable_roles`) and what the caller may do now (`actions`).
The contract scope applies to every read and write; a foreign id is answered 404.

## Audit and events

Audit actions `site_diary.drafted|revised|contractor_signed|supervised|owner_confirmed|locked|corrected|replayed` and events `qms.site_diary.*.v1` carry ids, the day, the status and the roles, never the
content, the remark or the note.

## Screens

| screen | what it does |
|---|---|
| QMS-01 (`DiaryCatalogueScreen`) | the catalogue with filters (contract, status, days), the chain of signatures per diary and the drafting of a new diary |
| QMS-02 (`DiaryComposeScreen`, `?diary=`) | the draft as a form saved as the version it was read at; signing as the contractor; correcting a locked diary; the note on the value of an in-app signature |
| QMS-03 (`DiaryReviewScreen`, `?diary=`) | the remark of the supervisor, the confirmation of the owner and the lock; without `?diary=`, the queue of diaries that wait for the caller |

Each has the seven states, forms that name the problem before anything is sent, and the refusals of the server in words. The server judges every command again.

## Not in this story

- The lock after three working days without a supervisor (a scheduled job; the story's `lockReason` is already carried) and its alert.
- `resolveDiaryConflict` and the conflict copies of an offline client (ST-QMS-002), `getDiaryCoverage` (days without a diary).
- Photos and attachments of the diary (ST-QMS-003).
- Checking the serial of a certificate against the DOC adapter; today the serial is kept as given.
- The value of an in-app signature (CXN-EXE-05) is a constant on the view, to be replaced by the business rule when it is settled.
