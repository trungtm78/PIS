# The connector to the national e-procurement network (`egp.muasamcong`)

Lane EGP-1 (part 1: kernel and documents; part 2: database, API and screens, section 10), EGP-2 (posting obligations and reconciliation screens). Spec of the module: `Design/MACHVON_Design/01_Documents/05_modules/BID.md` (F10, BR-BID-15 to BR-BID-18, BID-22 to BID-24). Code: `packages/kernel/src/egp.ts`, tests `packages/kernel/test/egp.test.ts`.

The platform **never opens a connection** to muasamcong.mof.gov.vn. It reads files that a person downloads from the network and hands over, and it prepares the postings that a person makes on the network by hand. The API adapter exists only as a refusing stub until the operator of the network publishes a specification.

## 1. Status: what is real and what is PENDING-EXTERNAL

No official sample file and no specification of the network were available. Everything that depends on the official format is therefore a **working assumption**, labelled as such on every screen and in every import (`format_version` = `WORKING-ASSUMPTION-2026.2`), and is **PENDING-EXTERNAL** (eng-review R18):

- UAT may run it, but the UAT verdict excludes it explicitly.
- It cannot be accepted until the official sample file exists and the recipient has confirmed it.
- `egpAcceptance(layoutVersion)` is `PENDING_EXTERNAL` for any layout version that starts with `WORKING-ASSUMPTION`, and every dry run, health answer and posting packet carries that word.

| Item (code) | What it is | Who gives it | Working assumption until then | What switches when it arrives |
|---|---|---|---|---|
| `SAMPLE_KHLCNT` | Official sample and column specification of the plan file | Operator of the network | KHLCNT layout of `WORKING-ASSUMPTION-2026.2` | The KHLCNT layout in `egp.ts`; BID-24 shows the official version |
| `SAMPLE_TBMT` | Official sample of the notice of invitation | Operator | TBMT layout | The TBMT layout |
| `SAMPLE_RESULT` | Official sample of the result of the choice of contractor | Operator | RESULT layout | The RESULT layout |
| `SAMPLE_CONTRACTOR` | Official sample of the contractor profile (Điều 19 NĐ 214/2025) | Operator | CONTRACTOR layout | The CONTRACTOR layout |
| `SAMPLE_RESTRICTION` | Official sample of the list of contractors under restriction | Operator | RESTRICTION layout | The RESTRICTION layout |
| `API_SPECIFICATION` | API specification, credentials, test environment | Operator | None: `EgpApiAdapter` refuses with 503 `EGP_API_UNAVAILABLE` | `EgpApiAdapter` is implemented; the connector may become VERIFIED |
| `POSTING_RECEIPT_FORMAT` | The receipt the network gives for a posting | Operator | A free reference typed by the person who posted | The reference is checked against the format |
| `LEGAL_TEXT_DEADLINES` | The official text of the posting deadlines, read by the customer's legal staff | Customer's legal staff | Rule `EGP_POSTING_DEADLINES` defaults, flagged `UNVERIFIED` | The tenant approves its own rule and the flag clears |

The list is `EGP_PENDING_EXTERNAL_ITEMS` in the kernel; BID-22 shows it ("Hạng mục chờ bên ngoài").

## 2. The connector registry entry

| Field | Value |
|---|---|
| `connector_code` | `egp.muasamcong` |
| mode | `FILE_IMPORT` (the file adapter); `API` is the refusing stub |
| adapter status | `PROPOSED` (the API adapter reports `MISSING`) |
| status | `Draft`. Only a `VERIFIED` adapter may be `Active` (`activationBlock`, 422 `CONNECTOR_NOT_ACTIVATABLE`), so the entry stays Draft until the layouts are confirmed. Importing a file does not need the connector to be Active, as the file of BID-19 does not |
| credentials | none. A future API adapter takes only a vault reference (`secret://...`), never a secret in the configuration |
| source system on the crosswalk | `MUASAMCONG` (the word `procurement_external_link` already uses) |
| import positions | one `connector_code` of the file import framework per layout: `EGP_KHLCNT_FILE`, `EGP_TBMT_FILE`, `EGP_RESULT_FILE`, `EGP_CONTRACTOR_FILE`, `EGP_RESTRICTION_FILE` |
| relation to `PROCUREMENT_FILE` | The milestone file of BID-17/19 (layout `WORKING-ASSUMPTION-2026.1`) is unchanged. Each package link it applies also becomes an ACTIVE mapping in `master_crosswalk` (part 2) |

### Health

Health is the **age of the last applied import** against the rule `CONNECTOR_FRESHNESS`, code `EGP_FILE` (registered by lane INT in `governance-rules.ts`):

- Formula: `age = now - time the last file was applied`; source of the time: the `file_import` row of the last applied file.
- `FRESH` up to `warn_after_hours` (default 120), `AGING` up to `max_age_hours` (default 168), `STALE` beyond it, `NEVER_IMPORTED` when no file has been applied.
- `STALE` raises the alert `CONNECTOR_STALE` at `stale_severity` (default WATCH for this code) and, when `figures_blocked_when_stale` says so (default false), the figures that rest on the files are shown as not up to date. A stale or never-imported connector is shown as such, never as "no data". A tenant that has never used the network gets no alert, only the words "Chưa nhập lần nào".
- The defaults are an operational choice of ours (the law sets no freshness), legal status `UNVERIFIED`; the agency sets its own.
- `egpConnectorHealth()` returns the status, the age in hours, the adapter status, the layout version, the acceptance word, the alert and whether figures are blocked.

## 3. The port and its two adapters

```
EgpPort
  readPlans / readNotices / readResults / readContractors / readRestrictions  (request: file bytes, layout version)  -> dry-run reading, never a write
  publish(obligation, fields)                                                    -> what a person takes to the network
```

| Adapter | Does | Never does |
|---|---|---|
| `EgpFileAdapter` (mode `FILE_IMPORT`, status `PROPOSED`) | Reads the five kinds of file into a dry run. `publish` returns a **posting packet**: the required fields of the kind in a fixed order and the SHA-256 of the content (the proof of what was posted). | Open a connection. It has no constructor argument and holds no client |
| `EgpApiAdapter` (mode `API`, status `MISSING`) | Refuses every call with 503 `EGP_API_UNAVAILABLE` (`extensions.reason = OPERATOR_SPECIFICATION_PENDING`) | Anything else. The day the operator publishes a specification this class is the only thing that changes |

`egpPortFor(mode)` gives the file adapter for `FILE_IMPORT` and `FILE_EXPORT`, and the refusing adapter for `API` and `LGSP`.

**The test of "no connection leaves the machine"** (`packages/kernel/test/egp.test.ts`, the group "no connection is opened to the national network"):

1. It replaces `fetch`, `net.connect`, `net.createConnection`, `net.Socket#connect`, `tls.connect`, `http` and `https` `request` and `get`, `dns.lookup`, `dns.resolve` and `dgram.createSocket` with functions that fail and count.
2. It proves the replacement works (each way out fails and is counted), then runs every operation of the file adapter, every dry run, the mapping, the difference, the obligations, the clock and the health, and asserts zero attempts.
3. It reads the source of `egp.ts` and asserts that it imports no module that can open a connection (`node:net`, `tls`, `http`, `https`, `http2`, `dns`, `dgram`, `child_process`, `cluster`, `worker_threads`), calls no `fetch`, and imports nothing but sibling modules.

The test goes red if the adapter calls `fetch` (checked once by hand while writing it).

## 4. The layouts of `WORKING-ASSUMPTION-2026.2`

Common to all five (the file import framework and `tabular-file.ts`):

- A CSV (UTF-8; comma, semicolon or tab) or the first sheet of an XLSX; the format is told by the bytes, not the name. A header row; at most 5,000 rows; other limits of `readTabularFile`.
- Header names are read without regard to case, spaces and hyphens (`Plan Code` is `plan_code`). A column the layout does not know is ignored. A header that names a column twice (after that normalisation) is refused.
- A column marked "header" must be in the header even if a row may leave it empty (the columns a rule across fields needs). A file without a required column is 422 `IMPORT_SCHEMA_INVALID` with `extensions.missing_columns`; a file with no row is 422 `IMPORT_EMPTY`.
- **Day**: `YYYY-MM-DD` or `DD/MM/YYYY`, years 2000 to 2100, a day that exists; stored as `YYYY-MM-DD`.
- **Moment**: a day (its first instant in Vietnam, UTC+7) or an ISO date-time **with** its offset; stored as UTC.
- **Amount** (VND): plain digits with at most two decimals and no thousands separator (`1.200.000.000` and `12,5` are ambiguous and refused); at most 18 integer digits; kept as an exact decimal string.
- **Tax code** (mã số thuế): 10 digits, or 10 digits and a 3 digit branch (`0101234567-001`; 13 digits and spaces are normalised). The check digit is not verified (the algorithm is not in the sources read). A contractor is identified by it, never by name.
- **Word** (enum): read without regard to case; spaces and hyphens become underscores (`open bidding` is `OPEN_BIDDING`).
- **Code**: at most 100 characters (50 for our own codes `project_code`, `package_code`), no control character. **Text** may run over lines (a quoted cell) but holds no other control character.
- A row whose business key repeats an earlier row: same content once normalised (`2026-01-05` and `05/01/2026`) is `DUPLICATE` (ignored); other content is `CONFLICT` (refused, the first row stands).

Columns are listed as `name` (kind; R = every row must fill it; H = the header must have it). Optional columns not marked are free to be absent.

### 4.1 KHLCNT, the plan (position `EGP_KHLCNT_FILE`); key `plan_code|package_external_code`

| Column | Kind | Note |
|---|---|---|
| `plan_code` | code (R) | The code of the plan on the network |
| `package_external_code` | code (R) | The code of the package on the network |
| `package_name` | text, 500 | |
| `estimated_price` | amount | |
| `selection_method` | word | `OPEN_BIDDING`, `LIMITED_BIDDING`, `DIRECT_APPOINTMENT`, `COMPETITIVE_QUOTATION`, `DIRECT_PURCHASE`, `SELF_EXECUTION`, `COMMUNITY_PARTICIPATION`, `SPECIAL_CASE` |
| `approved_on` | day | |
| `decision_no` | text, 100 | |
| `project_code`, `package_code` | code, 50 | **Our** codes, when the file names them (an exact mapping) |

### 4.2 TBMT, the notice of invitation (`EGP_TBMT_FILE`); key `notice_code|notice_version`

| Column | Kind | Note |
|---|---|---|
| `notice_code` | code (R) | |
| `notice_version` | integer 0 to 99 | Default 0 |
| `notice_kind` | word | `INVITATION` (default), `MODIFICATION`, `CANCELLATION` |
| `package_external_code` | code (R) | |
| `plan_code` | code | |
| `published_at` | moment (R) | |
| `bid_closing_at`, `bid_opening_at` | moment | Rule: published <= closing <= opening (the same moment is allowed), else `BID_DATES_ORDER_INVALID` on the later field |
| `estimated_price`, `bid_security_amount` | amount | |
| `project_code`, `package_code` | code, 50 | Ours |

### 4.3 RESULT, the result of the choice of contractor (`EGP_RESULT_FILE`); key `result_code|contractor_tax_code`

A joint venture or a package of lots has one row for each winner; a result nobody won is keyed by the result alone.

| Column | Kind | Note |
|---|---|---|
| `result_code`, `notice_code`, `package_external_code` | code (R) | |
| `result_kind` | word (R) | `AWARDED`, `NO_QUALIFIED_BID`, `CANCELLED` |
| `published_at` | moment (R) | |
| `approved_on` | day | Rule: not after the Vietnam day of `published_at` (`RESULT_DATES_ORDER_INVALID`) |
| `contractor_tax_code` | tax code (H) | Required when `AWARDED` (`AWARD_FIELDS_REQUIRED`), must be empty otherwise (`AWARD_FIELDS_NOT_ALLOWED`) |
| `award_price` | amount (H) | Same rule |
| `contractor_name` | text, 300 | |
| `project_code`, `package_code` | code, 50 | Ours |

### 4.4 CONTRACTOR, the contractor profile (`EGP_CONTRACTOR_FILE`); key: the tax code

| Column | Kind | Note |
|---|---|---|
| `contractor_tax_code` | tax code (R) | |
| `contractor_name` | text, 300 (R) | |
| `external_contractor_code` | code | Else the tax code is the code on the network |
| `legal_status` | word | `ACTIVE`, `SUSPENDED`, `DISSOLVED`, `UNKNOWN` |
| `registered_address` | text, 500 | Free text, hidden from the quarantine preview |
| `violation_count` | integer 0 to 9999 | |
| `as_of` | day (R) | The day the data is true |

### 4.5 RESTRICTION, the list of contractors under restriction (`EGP_RESTRICTION_FILE`); key `restriction_code|contractor_tax_code`

A decision may name every member of a joint venture, one row each.

| Column | Kind | Note |
|---|---|---|
| `restriction_code` | code (R) | The decision on the network |
| `contractor_tax_code` | tax code (R) | |
| `contractor_name` | text, 300 | |
| `restriction_kind` | word (R) | `DEBARMENT` (Điều 133), `REPUTATION_LISTED` (Điều 20.1-2) |
| `scope` | word | `NATIONWIDE`, `MINISTRY`, `PROVINCE`. Required for `DEBARMENT` (`SCOPE_REQUIRED`): a province's ban is never read as nationwide |
| `valid_from`, `valid_until` | day (R) | Rule: `valid_until` not before `valid_from` (`VALID_RANGE_INVALID`) |
| `decision_no` | text, 100 (R) | A restriction with no decision cannot be audited |
| `decision_date` | day | |
| `legal_basis` | text, 300 | |

### 4.6 What a dry run says

`dryRunEgpFile(kind, bytes, layoutVersion)` reads the file exactly as the apply will and **writes nothing** (BR-BID-13): no claim of the file, no batch, no quarantine. The answer carries the layout version, the SHA-256 of the file, the acceptance word, the counts `{total, valid, errors, duplicates, conflicts}` and for each row its line, the status and, for an error, a code and the field:

| Status | Meaning |
|---|---|
| `VALID` | The row is read; it carries the typed record and the business key |
| `ERROR` | `FIELD_REQUIRED`, `FIELD_TOO_LONG`, `CHARACTER_INVALID`, `ENUM_INVALID`, `DAY_INVALID`, `MOMENT_INVALID`, `MONEY_INVALID`, `INTEGER_INVALID`, `TAX_CODE_INVALID`, or a rule across fields: `BID_DATES_ORDER_INVALID`, `AWARD_FIELDS_REQUIRED`, `AWARD_FIELDS_NOT_ALLOWED`, `RESULT_DATES_ORDER_INVALID`, `VALID_RANGE_INVALID`, `SCOPE_REQUIRED` |
| `DUPLICATE` | `ROW_DUPLICATE`: a later row with the key and content of an earlier one; ignored |
| `CONFLICT` | `ROW_CONFLICT`: the key of an earlier row with other content; refused, the first row stands |

A request that names another `mapping_version` is refused before the file is opened (422 `VALIDATION_FAILED`, `mapping_version`). The formats are also exported as `EGP_FORMATS` (`FileImportFormat`), so the apply goes through the shared framework (`docs/file-import.md`): once per `(tenant, SHA-256)`, valid rows applied, refused rows to the quarantine (masked: codes, days, amounts and words only; names and addresses are left out because a sole trader's address is personal data).

## 5. The id mapping on `master_crosswalk` (structure B: no new table)

`master_crosswalk` keeps `(source_system, external_type, external_code)`, a validity range, a match method, a confidence and ACTIVE or RETIRED, unique among the ACTIVE ones. Today its subject is a `master_record`. EGP-1 part 2 **extends the same table**: it adds `subject_type` and `subject_id` for what is not a master record (a package, a notice, a contract), and lets `master_record_id` be empty when they are set (a CHECK that exactly one of the two is set). The same table later holds HPM, EBS and multi-system project codes (INT-1, ENT-2). The kernel model is `EgpIdMapping`.

| Subject (`subjectType`) | `external_type` | Our side | External code |
|---|---|---|---|
| `PROJECT` | `EGP_PROJECT` | project | Code of the project on the network |
| `PLAN` | `EGP_PLAN` | plan of a project | `plan_code` |
| `PACKAGE` | `EGP_PACKAGE` | procurement package | `package_external_code` |
| `NOTICE` | `EGP_NOTICE` | notice of a package | `notice_code` |
| `RESULT` | `EGP_RESULT` | result of a package | `result_code` |
| `CONTRACT` | `EGP_CONTRACT` | contract | Code of the contract on the network |
| `CONTRACTOR` | `EGP_CONTRACTOR` | contractor (master record by tax code) | `external_contractor_code`, else the tax code |

**Match methods** (`EgpMatchMethod`) and what the crosswalk holds today (`crosswalkMethodOf`):

| Method | Meaning | `match_method` stored | `confidence` |
|---|---|---|---|
| `EXACT_CODE` | The file names our code and theirs | `IMPORT` | none |
| `TAX_CODE` | A contractor matched by its tax code | `RULE` | none |
| `NAME_SUGGESTION` | A person confirmed a suggestion made from name and price | `MANUAL` | above 0, at most 1 |
| `MANUAL` | A person typed it | `MANUAL` | none |

**Validity.** `valid_from` is the first day the mapping holds, `valid_until` the first day it no longer does (null: no end), `valid_until > valid_from`. `resolveEgpMapping` and `externalCodeOf` answer on a day, ACTIVE mappings only.

**What writing a mapping does** (`egpMappingOutcome`, against the ACTIVE mappings that exist):

| Outcome | When | At the database |
|---|---|---|
| `CREATE` | Nothing in the way | insert |
| `UNCHANGED` | The same subject already holds the same code | no-op (a second import changes nothing) |
| `EXTERNAL_CODE_TAKEN` | Another subject holds the code | 409 `CROSSWALK_DUPLICATE` |
| `SUBJECT_HAS_OTHER_CODE` | The subject has another code in an overlapping period | never relinked silently: a reconciliation item (as `EXTERNAL_CODE_MISMATCH` does for the packages of BID-19) |

`validateEgpMapping` gives the findings (`egp.mapping.error.*`) that the CHECKs cannot state: the external type must match the subject, the source system must be `MUASAMCONG`, the code is trimmed and within 100 characters, a suggestion has a confidence and the others none, and **a contractor is mapped by tax code only**.

**What a valid row asks for** (`egpMappingProposals`): KHLCNT gives a PACKAGE and a PLAN proposal, TBMT a PACKAGE and a NOTICE, RESULT a PACKAGE and a RESULT, CONTRACTOR a CONTRACTOR (`TAX_CODE`), RESTRICTION none. A proposal whose `ourCode` is empty (the row did not name our code) is shown on BID-23 with suggestions for a person to confirm. Nothing here links anything; the store decides and writes through `egpMappingOutcome`.

**Suggestions** (`suggestPackageMatches`): a package of ours is suggested only when its budget equals the imported price to the unit **and** the names are alike. Likeness is the Jaccard index of the words of the two names (diacritics and case ignored), three decimals; the line is 0.8 (`EGP_SUGGESTION_THRESHOLD`, our own number, unverified, a hint and never a link). With no price on either side nothing is suggested: a name is not an identity (MDM F5).

## 6. Reconciliation: our record against the imported one

`diffEgpRecords(subject, ours, theirs)` compares the fields of the subject and nothing else:

| Subject | Fields (kind) |
|---|---|
| `PROJECT` | `project_name` (text), `total_investment` (amount) |
| `PLAN` | `decision_no` (code), `approved_on` (day) |
| `PACKAGE` | `package_name` (text), `estimated_price` (amount), `selection_method` (word) |
| `NOTICE` | `published_at`, `bid_closing_at`, `bid_opening_at` (day) |
| `RESULT` | `result_kind` (word), `contractor_tax_code` (code), `award_price` (amount), `published_at` (day) |
| `CONTRACT` | `contract_price` (amount), `contractor_tax_code` (code), `signed_on` (day) |
| `CONTRACTOR` | `contractor_name`, `registered_address` (text), `legal_status` (word) |

Equality: text ignores case and spacing; an amount is an exact decimal (`1200000000` equals `1200000000.00`); a day is the Vietnam calendar day (a moment is first turned into it, as BID-19 does for milestones); a code is the normalised tax code. Two empty values are no difference; a value on one side only is `MISSING_OURS` or `MISSING_THEIRS`; a value that differs is `VALUE_MISMATCH`, with the signed `theirs - ours` for an amount.

Each difference becomes an **item** (`openReconciliationItems`): subject, key, field, both values, the delta, an owner, a due time, the people who made the record (`makerIds`: who made our record, who loaded the file) and `OPEN`. The owner is never one of the makers (422 `owner_id`); `pickReconciliationOwner(candidates, makerIds)` gives the first candidate who is not a maker, or none, and the store then escalates to a data steward group.

**Resolutions** (`resolveReconciliationItem`):

| Kind | Meaning | Reason (min characters) | Also needs | Next step |
|---|---|---|---|---|
| `ACCEPT_EXTERNAL` | The network is right | 10 | | The owner's own command changes our record (the resolution never edits another module's data) |
| `CORRECT_OURS` | Ours is right | 10 | | Check whether a posting correction is due (EGP-2) |
| `DISPUTE` | The network is wrong and the operator is told | 20 | `evidence_ref` (the letter) | Escalate to the operator |
| `WAIVE` | Leave it | 20 | `review_on`, after today and within 365 days | Looked at again on that day |

Refusals, in order: already settled (409 `EGP_RECONCILIATION_STATE_INVALID`); the person is a maker (403 `SELF_APPROVAL_DENIED`); a reason, `evidence_ref` or `review_on` that does not hold (422 `VALIDATION_FAILED` naming the field). The store writes the audit event (ADM-11) from the returned item.

## 7. Posting obligations (EGP-2 model, in the kernel now)

Điều 19-20 NĐ 214/2025 oblige the investor to post information on the network. Eight kinds, each an obligation with a subject, a deadline from the rule `EGP_POSTING_DEADLINES` and a state.

| Kind | About | Rule code | Starts on | Default (all `UNVERIFIED`) | Reminder |
|---|---|---|---|---|---|
| `PLAN` | plan | `PLAN` | `DECISION_APPROVED` | 5 working days | 2 days |
| `NOTICE` | notice | `NOTICE` | `DECISION_APPROVED` | 5 working days | 2 days |
| `RESULT` | result | `RESULT` | `RESULT_ISSUED` | 5 working days | 2 days |
| `CONTRACT_INFO` | contract | `CONTRACT_INFO` | `CONTRACT_SIGNED` | 5 working days | 2 days |
| `CONTRACTOR_PERFORMANCE` | contract | `CONTRACTOR_PERFORMANCE` | `CONTRACT_COMPLETED` | **6 months** (Điều 20.3-4) | 14 days |
| `VIOLATION` | contractor | `VIOLATION` | `EVENT_OCCURRED` | **7 working days** | 2 days |
| `REPUTATION_EVENT` | contractor | `REPUTATION_EVENT` | `EVENT_OCCURRED` | 7 working days (Điều 20.1-2) | 2 days |
| `CONTRACTOR_RESPONSE` | contractor | `CONTRACTOR_RESPONSE` | `CONTRACTOR_NOTIFIED` | **20 calendar days** (a reading of Điều 20.8: counted from the day the contractor's response arrives) | 5 days |

The numbers in bold are the three the plan names; the rest are read from the summaries of Luật 22/2023 and NĐ 214/2025 (`research-vendor.md` §1, not checked against the Gazette). Every one is `legalStatus: UNVERIFIED` and an obligation copies that flag (`EgpObligation.legalStatus`); the rule type is registered in `governance-rules.ts`, the tenant approves its own rule and the flag clears. `REPUTATION_EVENT` is a code this lane added under `EGP_POSTING_DEADLINES`.

**Deadline** (`postingDeadline`, on `working-time.ts`): the day of the trigger is not counted; the deadline is the end of the working window of the last day (17:00 Vietnam by default, so the alert comes before the office day ends).

- `WORKING_DAYS`: the Nth working day of the tenant's calendar after the trigger day; weekends and holidays never count. The result agrees with `addWorkingTime` (the end of the trigger day plus 8 hours per day; a test checks it).
- `CALENDAR_DAYS`: trigger day plus N, then, if that day is not worked, the next working day.
- `MONTHS`: trigger day plus N months (31 August plus 6 months is 28 February), then the same move to a working day.
- The calendar of each year the deadline passes through must be given; a year without one is 422 `CALENDAR_NOT_EFFECTIVE`, never a guessed weekly pattern.
- The move to the next working day and the end-of-window time are policy of the module (`EGP_ROLLS_TO_WORKING_DAY`), not rule parameters, and unverified for this use; the rule keeps `due_in`, `due_unit`, `starts_on`, `remind_before_days` and `legal_basis`.

**States** (`moveObligation`): `DUE` → `PREPARED` → `SUBMITTED` → `RECEIPTED` or `REJECTED`; a rejected posting is prepared again; `CANCELLED` from DUE, PREPARED or REJECTED with a reason of 20 characters (the package was cancelled and there is nothing to post). `RECEIPTED` and `CANCELLED` are final. Any other move is 409 `EGP_OBLIGATION_STATE_INVALID`.

- **The person who submits is not the person who prepared** (403 `SELF_APPROVAL_DENIED`): what goes to the network under the agency's name is looked at by a second person.
- A receipt needs the reference the network gave (at most 100 characters) and a time not before the submission. A rejection needs a reason (10 characters).
- `EgpFileAdapter.publish()` builds the packet of a posting: the fields of `EGP_POSTING_FIELDS[kind]` (all required, none other, no control character) and the SHA-256 of the content. A person posts it on the network and records the receipt.

**Clock** (`egpObligationClock`): open (DUE, PREPARED, REJECTED): `OVERDUE` past the deadline, `DUE_SOON` within `remindBeforeDays` of it, else `ON_TIME`. `SUBMITTED` and `RECEIPTED`: `MET` when the submission was at or before the deadline, `MET_LATE` after it (the posting is made when it is submitted; the receipt only confirms it). A rejection puts the clock back. `CANCELLED`: none. "% posted on time" (for example violations within 7 working days) is `MET / (MET + MET_LATE + OVERDUE)`.

### Alerts

Registered by lane INT as `ALERT_TYPE` rules (G0-3); an alert type without an owner, an expected action and a consequence cannot exist.

| Alert | When (`egpAlertFor`) | Owner | Expected action | Consequence | Response | Severity |
|---|---|---|---|---|---|---|
| `EGP_POSTING_DUE` | The clock is `DUE_SOON` | Procurement officer | Post on the network and submit the receipt | Soon overdue: a late posting is recorded as a breach of the rules on publishing procurement information | 48 h | Cần xử lý (ACTION) |
| `EGP_POSTING_OVERDUE` | The clock is `OVERDUE` | Procurement officer | Post at once what is missing and record why it is late | Overdue: the agency is in breach of the rules on publishing procurement information | 24 h | Khẩn (URGENT) |
| `CONNECTOR_STALE` | The connector is `STALE` | Integration administrator | Check the connector, fetch the latest file, record the cause | Figures from outside are older than allowed and must say so | 24 h | per rule (WATCH for `EGP_FILE`) |

No alert once an obligation is submitted, late or not: lateness is a figure.

## 8. Screens

All screens follow `design.md` and the whole states matrix: loading, empty, partial (rows with errors), error (stale, schema invalid), forbidden (403, scope), success. Every number has an "i" with formula, source and as-of date. Each carries the badge "Adapter PROPOSED, chỉ nhập tệp" and "Mẫu tệp là giả định (PENDING-EXTERNAL)" while the layout is a working assumption.

| Screen | Shows | Actions |
|---|---|---|
| **BID-22 Kết nối** | Connector code, adapter status, mode, layout version, last import, age against `CONNECTOR_FRESHNESS`, the PENDING-EXTERNAL list (section 1), open posting obligations due | Switch the connection on or off with a reason (`bid.egp.admin`; the registry entry stays Draft while the adapter is PROPOSED); links to BID-23 and BID-24 |
| **BID-23 Ánh xạ** | `master_crosswalk` rows of source `MUASAMCONG` by subject: our code, external code, method, confidence, validity, status; suggestions waiting for a person; codes held by another object | Propose by hand or from a suggestion (`bid.egp.map`), approve or reject (`bid.egp.map.approve`, never the person who proposed it), retire with a reason; a contractor can only be mapped by tax code |
| **BID-24 Các lần nhập** | Past imports (kind, layout version, file hash, mode, valid/error/duplicate/conflict counts, who, when, open differences); the dry run of the file being loaded, row by row with the line, code and field | Choose kind and file, **dry run** (writes nothing), **apply** (needs `bid.import` on the whole tenant; the same file again answers "đã nạp") |
| **BID-32 Nghĩa vụ đăng tải** (EGP-2, section 12.1) | Obligations by state and clock, owner, deadline with its legal-status badge, receipts | Prepare, submit (a second person), record receipt, record rejection, cancel with a reason |
| **BID-33 Đối chiếu** (EGP-2, section 12.2) | Items: both values, delta, owner, due | Resolve with one of the four kinds (not the maker); audit ADM-11 |

## 9. Errors

New codes (registered in `error_codes.json`): 503 `EGP_API_UNAVAILABLE`, 409 `EGP_OBLIGATION_STATE_INVALID`, 409 `EGP_RECONCILIATION_STATE_INVALID`, 409 `EGP_RECEIPT_DUPLICATE` (EGP-2). Existing codes used: `IMPORT_SCHEMA_INVALID`, `IMPORT_EMPTY`, `VALIDATION_FAILED` (`mapping_version`, `file`, `reason`, `review_on`, `evidence_ref`, `owner_id`, `due_at`, `receipt_ref`, `fields.<name>`), `SELF_APPROVAL_DENIED`, `CROSSWALK_DUPLICATE`, `CALENDAR_NOT_EFFECTIVE`, `GOVERNANCE_RULE_PARAMS_INVALID`, `CONNECTOR_NOT_ACTIVATABLE`. Row-level codes (section 4.6) are not HTTP errors: they are the `code` of a row of the answer.

## 10. Part 2: database, API and screens (built) and the hooks it leaves

Migrations, block EGP-1 (1940-1959, registered): `V1940__egp1_crosswalk_subjects.sql` (the extension of `master_crosswalk`), `V1941__egp1_connection.sql` (`egp_connection`, `egp_connection_event`), `V1942__egp1_record.sql` (`egp_record`). All have RLS (restrictive tenant boundary, FORCE), the history tables are append-only (trigger and no UPDATE/DELETE for the application role).

- **Crosswalk (`master_crosswalk`, no new identity table).** New columns `subject_type`, `subject_id` (exactly one of `master_record_id` and the pair is set), `proposal_reason`, `import_id`, `approved_by/at`, `decision_reason`, `retired_by/at`, `retire_reason`. Statuses `PROPOSED` and `REJECTED` exist for rows of the new kind only. A mapping is PROPOSED by one person (`created_by`; for a file, the person who loaded it) and ACTIVE only when another person approves it (CHECK `approved_by <> created_by`); REJECTED and RETIRED are final and keep who and why; a wrong code is replaced by a new proposal, so the rows are the version history. One external code, one subject at a time (the old unique index on ACTIVE rows); one subject, one ACTIVE code per system and code type (new index); a waiting proposal is not repeated. The subject of a NOTICE and a RESULT is the package (a notice and a result are about a package); the subject of a PLAN is the plan in force of the project; a CONTRACTOR is the register's contractor found by tax id.
- **Connection.** `egp_connection` (one row per tenant: `enabled`, reason, who, when, layout version, version) with `egp_connection_event`. The row, the registry entry (`integration_connector`: `egp.muasamcong`, FILE_IMPORT, adapter PROPOSED, Draft) and the five positions (`integration_cursor`, one per layout) are created at the first command of the tenant (`ensure`); a read never writes and shows the connection as it will be created. Switching needs a reason of 10 characters and the version (`If-Match`); a file is applied only while the connection is on (409 `EGP_CONNECTION_DISABLED`), a dry run always works.
- **Files.** `EgpImportAdapter` (`packages/db/src/egp-import.ts`) plugs the kernel layouts into the file import framework, one position per kind. Dry run = `previewFileImport` with the same adapter (nothing written, per-row VALID/ERROR/DUPLICATE/CONFLICT and what the apply would do: `RECORD`, `RECORD_AND_PROPOSE`, `RECORD_AND_DIFFERENCE`). Apply = `FileImportStore.run` (once per hash, 409 `IMPORT_FILE_ALREADY_APPLIED`; unreadable file, `IMPORT_SCHEMA_INVALID`/`IMPORT_EMPTY`; nothing takeable, 422 `IMPORT_HAS_ERRORS`; a layout version the module does not read, 422 `EGP_LAYOUT_VERSION_UNKNOWN` naming the version and the supported ones, before the file is opened). A row that is applied is kept in `egp_record` (append-only, one per business key, with layout version and row hash), proposes the mappings it asks for, and opens a difference where it cannot (a code held by another subject, a subject that holds another code, a code of ours that is not in the register or names two rows). A restriction for a contractor of the register is written to `contractor_restriction` only under an official layout; under a working assumption it becomes the difference `EGP_RESTRICTION_FOR_REGISTERED_CONTRACTOR` for a person to record on a decision (BID-21), because a legal restriction is not written from a file nobody confirmed (R18). A key already applied that a later file says differently about is the framework's conflict item, and the first record stands.
- **Audit and outbox.** Every command writes an ADM-11 audit row and an outbox event with ids and codes only: `bid.egp_connection_switched` / `bid.egp.connection.changed.v1`, `bid.egp_import_previewed`, `bid.egp_import_applied` / `bid.egp.import.applied.v1`, `bid.contractor_restriction_recorded` / `bid.egp.restriction.recorded.v1`, `bid.egp_mapping_proposed|approved|rejected|retired` / `bid.egp.mapping.proposed|decided|retired.v1`. Idempotency: the shared command interceptor (`Idempotency-Key`).
- **Permissions.** `bid.read` reads (the lists span the whole tenant: a grant on a subtree is 403 `SCOPE_DENIED`); `bid.egp.preview` uploads and dry-runs; `bid.import` on the whole tenant applies; `bid.egp.admin` switches the connection; `bid.egp.map` proposes and retires; `bid.egp.map.approve` approves and rejects (never the maker).
- **Health and the alert.** `EgpConnectionStore.health` reads the rule `CONNECTOR_FRESHNESS`/`EGP_FILE` through `GovernancePolicyPort` (a tenant rule, else the built-in default with its formula, source, as-of day and legal status UNVERIFIED) against the time of the last applied file; the alert type `CONNECTOR_STALE` (owner, expected action, consequence) was registered by lane INT and the alert centre reads the health as its source `CONNECTOR` (`HomeConnectorSources`), so no job is needed: the age is computed when it is read.
- **No connection leaves the machine.** The kernel test of section 3 covers the pure module; `apps/api/test/bid/egp.test.ts` runs dry runs, applies and every command with `net.Socket#connect` recorded and asserts that every connection is to the test server itself, none to `muasamcong`, and reads the sources of the controllers, the views, the stores and the adapter for any import of a network module or call to `fetch`.
- **Hook for the workflow of the package (PRC-1).** Nothing here writes milestones: BID-17/19 own `procurement_milestone`. The event `bid.egp.mapping.decided.v1` (APPROVE, subject type PACKAGE, NOTICE or RESULT) says which notice and result of the network are the package's, and `egp_record` holds their dates (`publishedAt`, `bidClosingAt`, `bidOpeningAt`, `approvedOn`); a consumer fills the milestones from them (an actual date only where there is none, source IMPORT) and calls `BidWorkflowStore.syncMilestones` in its own transaction. For the posting obligations of EGP-2 register the evidence kind `EGP_POSTING_RECEIPT` (source `EXTERNAL_RECEIPT`) before approving the rule that lists it (`docs/bid-workflow.md`).
- **EGP-2 (built, section 12).** Tables for the obligations and the reconciliation items (V1960 to V1962), BID-32 and BID-33 (the ids BID-25 and BID-26 were taken by no screen; the catalogue gave the next free ones), the contractor export of CTR-24 as the packet of the evaluation and violation postings. The differences of an import that the framework opens (`file_import_reconciliation_item`, codes that could not be mapped) stay the framework's; the field differences between our register and `egp_record` are the items of section 12.

## 11. Pieces

| Piece | File |
|---|---|
| Port, adapters, layouts, dry run, mapping, difference, reconciliation, obligations, clock, health | `packages/kernel/src/egp.ts` (exported from `packages/kernel/src/index.ts`) |
| Tests (66): fixtures for every layout, every row code, mapping, difference, deadlines, state machine, clock, health, no network | `packages/kernel/test/egp.test.ts` |
| Rules and alert types | `packages/kernel/src/governance-rules.ts` (`registerIntegrationRules`) |
| Working calendar | `packages/kernel/src/working-time.ts` |
| CSV/XLSX reader, file import framework | `packages/kernel/src/tabular-file.ts`, `file-import.ts`, `docs/file-import.md` |
| Milestone file of BID-17/19 | `docs/bid-procurement-file.md`, `procurement-file.ts`, `packages/db/src/bid-external-link.ts` |
| Crosswalk | `packages/db/src/master-crosswalk-store.ts`, `apps/api/src/modules/mdm/master-crosswalk.controller.ts`, MDM F4 |
| Management rules (connection switch, mapping life, request judging, health view; pure, 20 tests) | `packages/kernel/src/egp-connection.ts`, `packages/kernel/test/egp-connection.test.ts` |
| Migrations V1940 to V1943 (crosswalk subjects, connection, records, alert source) | `db/migrations/V194*.sql`, block EGP-1 of `db/migrations/blocks.json` |
| Stores and the file adapter (connection, mappings, suggestions, runs; import adapter) | `packages/db/src/egp-store.ts`, `packages/db/src/egp-import.ts`, tests `packages/db/test/egp-store.test.ts` |
| Alert source `CONNECTOR_STALE` | `packages/db/src/home-connector-sources.ts` (registered in `HomeWorkStore`, `home-work-rules.ts`, `packages/kernel/src/home-work.ts`) |
| Controllers (commands, reads, views) and the API test with the no-connection proof | `apps/api/src/modules/bid/egp.controller.ts`, `egp-reads.controller.ts`, `egp-view.ts`, `apps/api/test/bid/egp.test.ts` |
| Screens BID-22, BID-23, BID-24 | `apps/web/src/screens/bid/egp/` (`ConnectionScreen`, `MappingScreen`, `ImportScreen`), strings `egp.connection.*`, `egp.mapping.*`, `egp.import.*` |
| Module spec and catalogue | `Design/MACHVON_Design/01_Documents/05_modules/BID.md`, `Design/MACHVON_Design/03_Engineering/screen_catalog.json` (BID-22 to BID-24, BID-32, BID-33) |
| EGP-2 pure rules (severity by time left, on-time figure, facts that open a duty, milestone dates of a notice and a result, fingerprint of a difference, evidence kind `EGP_POSTING_RECEIPT`) | `packages/kernel/src/egp-posting.ts`, `packages/kernel/test/egp-posting.test.ts` |
| EGP-2 migrations V1960 to V1962 | `db/migrations/V196*.sql`, block EGP-2 of `db/migrations/blocks.json` |
| EGP-2 stores, hook and alert source | `packages/db/src/egp-posting-store.ts`, `egp-reconciliation-store.ts`, `egp-milestone-hook.ts`, `home-egp-posting-sources.ts`, tests `packages/db/test/egp-posting-store.test.ts` |
| EGP-2 controllers, view, consumer and the API test with the no-connection proof | `apps/api/src/modules/bid/egp-posting.controller.ts`, `egp-posting-view.ts`, `egp-milestone.consumer.ts`, `apps/api/test/bid/egp-posting.test.ts` |
| Screens BID-32, BID-33 | `apps/web/src/screens/bid/egp/` (`PostingScreen`, `ReconciliationScreen`), strings `egp.posting.*`, `egp.reconcile.*` |

## 12. Part 3 (EGP-2): posting obligations, field reconciliation and the imported milestones

Migrations, block EGP-2 (1960-1979, registered): `V1960__egp2_posting_obligation.sql` (`egp_posting_obligation`, `egp_posting_receipt`, `egp_posting_event`), `V1961__egp2_reconciliation_item.sql` (`egp_reconciliation_item`), `V1962__egp2_alert_source.sql` (the alert source `EGP_POSTING` on `work_action`). RLS restrictive and forced, the receipt and the history append-only (trigger and no UPDATE or DELETE for the application role), every `*_id` column indexed with `tenant_id` first.

### 12.1 The obligations (BID-32)

- **Opening.** From the facts of the register (`EGP_OBLIGATION_FACTS`): an approved plan (PLAN), an approved result that was not cancelled (RESULT, subject: the package), a signed contract (CONTRACT_INFO), an approved completion evaluation (CONTRACTOR_PERFORMANCE, clock from the day of approval: the register keeps no completion day), a confirmed violation (VIOLATION, clock from the day it occurred, as the rule says `EVENT_OCCURRED`). The sweep (`sweepEgpObligations`) takes a cutover day, default 90 days before today: an older fact is not a duty of this system, and the agency may name another day. A notice, a reputation event and a contractor response have no fact in the register yet (CA-3 will push `CONTRACTOR_NOTIFIED`): a person opens them by hand (`openEgpObligation`), and any other kind may be opened by hand too. Key of a duty: (kind, source of the fact, the instant it happened): opening again returns the one that is there and leaves a line `bid.egp_obligation_open_repeated` in the trail.
- **Deadline.** `postingDeadline` of the rule `EGP_POSTING_DEADLINES` read through `GovernancePolicyPort` on the published working calendar (`WORKDAY_VN`); the rule version and whether it is the built-in default (`rule_source`), and the flag UNVERIFIED, are copied onto the duty. A tenant with no published calendar for the year gets 422 `CALENDAR_NOT_EFFECTIVE`.
- **Moves.** DUE, PREPARED (the packet: the fields of `EGP_POSTING_FIELDS[kind]`, all required, none other, built by the port; or, for CONTRACTOR_PERFORMANCE and VIOLATION, the batch of the contractor export of CTR-24 of the right scope that the caller may read; the SHA-256 is the proof of what was posted), SUBMITTED (a person other than the preparer, 403 `SELF_APPROVAL_DENIED`, and a CHECK of the database), RECEIPTED (the reference of the network, unique in the tenant, 409 `EGP_RECEIPT_DUPLICATE`; a row of its own that never changes) or REJECTED (the clock runs again; the rejected submission is cleared when the posting is prepared again). CANCELLED needs 20 characters. Every move is versioned (`If-Match`), audited (ADM-11) and announced.
- **CTR-24 moved into the lane.** The export of the records of the contractors (`docs/ctr-export.md`) is unchanged (behaviour, tests, screen CTR-24) and is now the packet of the evaluation and violation postings: preparing the posting names the batch, and the receipt of the posting is the receipt of the batch (`CtrExportStore.submitFromObligation`: a batch that was generated becomes SUBMITTED_EXTERNALLY with the reference and the day of the receipt; a batch that a person already marked on CTR-24 is left as it is). One receipt entry, one place.
- **Alerts.** `HomeEgpPostingSources` (source `EGP_POSTING`): `EGP_POSTING_DUE` while an open duty is inside the reminder window, `EGP_POSTING_OVERDUE` past the deadline, with the ALERT_TYPE registered by lane INT (owner procurement officer, expected action, consequence). The severity follows the time that is left, through the rule `EGP_POSTING_SEVERITY` (`urgent_within_hours`, default 24, UNVERIFIED): overdue is URGENT, due soon is URGENT within the line and ACTION before it. Submitted raises nothing, late or not: the receipt confirms it and closes the duty. The owner of a duty sees it; the holders of `bid.egp.post.prepare` over the whole tenant see all of them; anyone else sees what was handed to them. The clock is computed when the list is read: no job.
- **Posted on time.** `egpOnTimeOf`: MET / (MET + MET_LATE + OVERDUE), rounded down to the basis point, null while nothing is judged; the formula and the source are on the answer (the "i" of the number).

### 12.2 The reconciliation (BID-33)

`runEgpReconciliation` reads each ACTIVE mapping against its imported record (`egp_record`, the latest of the key) and compares the fields our register holds (`diffEgpRecords`): PACKAGE (name, price, method), PLAN (approval day), NOTICE (day of publication, closing and opening, from our milestones; the notice is the highest version that is not a cancellation), RESULT (kind, winner by tax code, award price, publication day; the winner and the price only when the result has one row, a joint venture has one row for each winner), CONTRACTOR (name). A field the file leaves empty is not a statement of the network and is not compared. An item per difference: the people who made our record (the maker, the people who submitted and approved a result, who set a milestone) and who loaded the file are its `maker_ids`; the owner is the person asked for, else the first holder of `bid.egp.reconcile` on the whole tenant who is not a maker, else none: the difference is counted as `no_owner` and nothing is opened (the database also refuses an owner or a resolver who is a maker). Due time from the rule `EGP_RECONCILIATION_POLICY` (`due_in_working_days`, default 10, UNVERIFIED). One OPEN item for a field of a subject; the fingerprint of the statement makes a second run open nothing; a resolved item does not come back unless a figure moved or a waiver reaches its review day. `resolveEgpReconciliationItem`: the four resolutions of section 6, audited with the follow-up each asks (`EGP_RESOLUTION_FOLLOW_UP`); the resolution edits nothing of another module.

### 12.3 The imported milestones (hook of section 10, now built)

`EgpMilestoneConsumer` (`bid-egp-milestone`) consumes `bid.egp.mapping.decided.v1` (APPROVE of a PACKAGE, NOTICE or RESULT mapping) and `bid.egp.import.applied.v1` (kind TBMT or RESULT). `EgpMilestoneHook` gives the package the dates of the notice that invites (the earliest version) and of the result that its ACTIVE mappings name: published, closing, opening, result published and approved. Only where the package has no actual date; the source is IMPORT with a batch of `procurement_import_batch` that mirrors the file (the milestone keeps the proof of the file); the order of the milestones holds (`ORDER_REFUSED`), a date still to come is not taken (`IN_THE_FUTURE`), a package the plan has not approved, one that was replaced or dropped takes none (`PACKAGE_CLOSED`); a day a person recorded is kept (`KEPT_OURS`) and the difference shows on BID-33. Then `BidWorkflowStore.syncMilestonesOfPackage` completes the checklist items of the running workflow that those milestones carry. The milestones and the evidence are written for the person who acted (approver or loader: the evidence needs a member of the tenant); the audit rows and events are the system's. Idempotent: a second pass finds the dates there.

### 12.4 Permissions

`bid.read` reads (the lists span the whole tenant: 403 `SCOPE_DENIED` for a grant on a subtree); `bid.egp.post.prepare` opens, sweeps, prepares and cancels; `bid.egp.post.submit` submits, records receipts and rejections; `bid.egp.reconcile` runs the reconciliation and settles items.

### 12.5 Still PENDING-EXTERNAL

The layouts (so every reconciliation rests on a working assumption), the legal text of the deadlines (`LEGAL_TEXT_DEADLINES`: the numbers of `EGP_POSTING_DEADLINES`, `EGP_POSTING_SEVERITY` and `EGP_RECONCILIATION_POLICY` are defaults flagged UNVERIFIED), the format of the receipt (`POSTING_RECEIPT_FORMAT`: a free reference today). No network call exists: `apps/api/test/bid/egp-posting.test.ts` records every socket while the obligations and the reconciliation run, reads the sources of the controller, the view, the consumer, the stores, the hook and the alert source for any client of the network, and `packages/kernel/test/egp-posting.test.ts` does the same for the pure module.

