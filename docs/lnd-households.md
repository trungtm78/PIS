# LND-1: affected households with sealed personal data (ST-LND-002)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (sections 3.5, BR-LND-07, BR-LND-09, 8). Migration: `V1683__lnd1_affected_household.sql` (the tables themselves are in `V002`). Screen LND-03. CXN-EXE-06 and CXN-13, so the story is DONE_UNCONFIRMED.

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `registerAffectedHousehold` | `POST /affected-households` | `land.household.write` over the unit | Registers a household on a legal basis for processing its data and for as long as the data is kept. |
| `linkHouseholdParcel` | `POST /affected-households/{id}/parcels` | `land.household.write` over the unit | Links the household to a parcel of its own unit and project, with the right it holds and its share. |
| `listAffectedHouseholds` | `GET /affected-households?project_id=` | `land.household.read` over the unit | The households of the scope, masked. |
| `revealHouseholdIdentity` | `GET /affected-households/{id}/identity?reason=` | `lnd.pii.read` over the unit (and `land.household.read`) | The one reading that opens the sealed data. |

`revealHouseholdIdentity` is additive to the design (CR-LND-02): the design names the permission `lnd.pii.read` and says that every opening is audited, but lists no operation for it. It is a GET and not a command on purpose: a command keeps its answer in the idempotency record, and the answer here is the personal data.

## Where each piece of personal data lives (input to the DPIA, TK-LND-002-5)

| Data | Collected by | Kept as | Shown as | Opened by |
|---|---|---|---|---|
| Name of the head | `registerAffectedHousehold` | `head_name_enc` (AES-256-GCM) | `head_name`: initials, the rest `*` (`N***** V** A`) | `revealHouseholdIdentity` |
| Identity number (9 or 12 digits) | the same | `national_id_enc`, and `national_id_hash` (HMAC, to find a duplicate) | `national_id_masked`: the last four digits; to a caller who may not open it, twelve `*` | the same |
| Telephone | the same | `phone_enc` | `phone_masked`: the last three digits; hidden whole as the identity number | the same |
| Address | the same | `address_enc` | `address_text`: only the last part (`***, Quận 1`) | the same |
| Legal basis, its reference, the consent record, the date the data is kept until | the same | in the clear (not personal) | in the list | not sealed |

- **Envelope encryption** (`packages/kernel/src/field-encryption.ts`). A key is derived (HKDF-SHA-256) per tenant and purpose from a master key; the ciphertext is bound (AAD) to `tenant | table | column | row`, so a copy moved to another row, column or tenant does not open. The id of the master key is in the header of the value, so a key can be rotated: the highest id seals, any held id opens.
- **Master keys** come from `FIELD_ENCRYPTION_KEYS` (`id:base64,id:base64`, each 32 bytes). They are read from the environment of the process and are not written anywhere in this repository. Without keys the API starts and everything that holds no personal data works; sealing or opening answers `503 PROVIDER_UNAVAILABLE` (it fails closed, it never stores a value unsealed). In production the variable is filled from the platform KMS or OpenBao secret (R-LND-04); that binding is not part of this story.
- **The blind index** (`national_id_hash`) is an HMAC of the identity number per tenant and project, so the same number is a duplicate inside one project (`409 HOUSEHOLD_DUPLICATE`, the unique index `affected_household_nid_uq`) and a different household in another.
- **No personal value in the trail, the events or the stored answers.** The audit row of a registration carries ids, the code, the legal basis and the names of the fields that were sealed; the event carries ids; the stored answer of the command is a `CommandResult`. A test (`apps/api/test/lnd/household.test.ts`) lists the row, the audit rows, the outbox and the idempotency records and fails if any holds a name, an address, a telephone or an identity number.

## Who sees a household (AC-ST-LND-002-1, UAT-AC379)

A household belongs to the unit that answers for it (`owner_unit_id`). The restrictive policy `scope_units_guard` (V002) shows a row only when `app.scope_units` is `*` or names its unit; with nothing set no row is seen. The API puts the setting in every transaction: `householdScopeUnits` turns the grants of the caller that carry the permission into `*` (a grant on the whole tenant) or the ids of the units they reach (a unit tree or a unit). A grant on a project or on a contract reaches no household, because a household is not a thing of a project. The same test is made again in the application, and a household outside the scope is answered as if it did not exist (404); one inside the scope that the caller may not open is `403 SCOPE_DENIED`. The list hides the identity number and the telephone whole, per unit, from a caller whose `lnd.pii.read` does not reach that unit.

## Legal basis and retention (AC-ST-LND-002-2, UAT-AC380)

- `legal_basis` is `PUBLIC_TASK_LAND_LAW`, `LEGAL_OBLIGATION` or `CONSENT`; `legal_basis_ref` (the law, decision or record) is required; a missing or empty one, or a basis that is not one of the three, is `422 LEGAL_BASIS_REQUIRED`. `CONSENT` needs `consent_record_id` (`422 CONSENT_REQUIRED`); the consent record itself belongs to the IAM story that does not exist yet, so the identifier is a logical reference and is not checked against a table.
- `retention_until` is required and may not be in the past (the day is the day in Vietnam); the database also refuses a retention that ends before the household was created.
- The database refuses to delete from either table (the runtime role has no `DELETE` or `TRUNCATE`): erasing is anonymising, a command of a later story (`handleHouseholdDataRequest`, LND-13).

## Reading the personal data

`revealHouseholdIdentity` wants a `reason` of 10 to 300 characters. The reason is judged before anything is read, written to the audit row beside the names of the fields that were opened (never their values), and the row is written in the same transaction as the reading: a reading that cannot be recorded is not answered. The screen asks for the reason, shows the data in a dialog and keeps it nowhere else (no cache key, no refetch, closed with the dialog). The counter `lnd_pii_decrypt_total` is incremented for every reading.

## Rules of the link

A household is linked to a parcel of its own unit and project (`422 VALIDATION_FAILED`, `parcel_id`, with the reason `NOT_A_PARCEL_OF_THE_PROJECT` or `NOT_A_PARCEL_OF_THE_UNIT`); the same pair twice is `409 LINK_DUPLICATE`; the shares of a parcel never come to more than 100 (`422 SHARE_EXCEEDS_100`, also guarded by a trigger); a title document has to be a clean version (`422 DOCUMENT_NOT_CLEAN`). The statuses of a household move only along the edges of the state machine (a trigger), and what a household is (tenant, project, unit, code) never changes.

## Tests

- `packages/kernel/test/field-encryption.test.ts`: sealing, tampering, key rotation, masks, normalisation.
- `packages/db/test/lnd-household-store.test.ts`: the store against the real database, the policy of the unit, the triggers, the constraints.
- `apps/api/test/lnd/household.test.ts`: the four operations through HTTP, the trail, the events, the scope.
- `apps/web/src/screens/lnd/household/*.test.ts(x)`, `apps/web/e2e/lnd-household-flows.spec.ts`: the screen LND-03.
- The authorization matrix and the isolation suite list the four operations.

## Requests of the people whose data a household holds (ST-LND-003, UAT-AC381)

Migration `V1684__lnd1_household_data_request.sql`. Screen LND-13. CXN-EXE-06, so the story is DONE_UNCONFIRMED.

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `handleHouseholdDataRequest` | `POST /affected-households/{id}/data-requests` | `land.dsr.handle` over the unit | Handles one request: `request_kind`, `requester_verified`, `outcome`, `reason`. |

The person who asked has to be identified first (`requester_verified` false is `422 REQUESTER_NOT_VERIFIED`, for every kind, before anything is done). A household outside the scope of the caller is `404`. What a request does:

| Kind | FULFILLED | PARTIAL | REFUSED |
|---|---|---|---|
| `ACCESS`, `RECTIFY` | recorded as served; the data is read by the officer who may open it (every reading is recorded), the correction is made in the record | the same | recorded, nothing changes |
| `WITHDRAW_CONSENT` | only for a household registered on its consent (otherwise `422 VALIDATION_FAILED`, `request_kind`, reason `NOT_CONSENT_BASED`): the telephone and the address are erased, the name and the identity number kept | the same | recorded |
| `RESTRICT` | `processing_restricted_at` is set: the sealed data is kept and `revealHouseholdIdentity` answers `409 PROCESSING_RESTRICTED` | the same | recorded |
| `ERASE` | the household is anonymised (`anonymised_at`): the name becomes `[erased]`, the identity number, its blind index, the telephone and the address are removed; the code, the unit, the basis and the status stay. **If a payment was made to the household** (`compensation_payment` `PAID` or `DEPOSITED`, whose voucher has to be kept) it is `409 RETENTION_LEGAL_HOLD` with `retained_payments`, and nothing is recorded or changed | the telephone and the address are erased; the name, the identity number and the code are kept (the officer says so, and why) | recorded |

Every handled request is a row of `household_data_request` (kind, outcome, the reason, the names of the fields erased, the number of payment records kept, who and when), appended and never edited or removed by the runtime role, and seen only from inside the unit of the household. The audit row and the event `lnd.household.dsr_handled.v1` carry ids, the kind, the outcome and the names of the fields; the reason lives in the request only. An anonymised household does not get its data back (a trigger), a restriction is not lifted by an update, and a second erasure of an anonymised household erases nothing.

## Not in this story

The inventory (`recordInventory`) is another story. Lifting a restriction and a response deadline for the data requests (an open legal question in the story) are not modelled. The DPIA itself (R-LND-02) and the binding of the master keys to the KMS (R-LND-04) are for the data protection officer and the platform team.
