# Management of contractors and suppliers, foundation (lane VND-1)

Lane VND-1 of the governance deepening. Research: `research-vendor.md` items V1, V2, V3, V8, V12 and the alert types and indicators that belong to them. Code: `packages/kernel/src/vendor-*.ts` (pure rules), `packages/db/src/vendor-*.ts` and `home-vendor-sources.ts` (stores, gates, alert source), `apps/api/src/modules/bid/vendor*.ts` (controllers, registered in the module BID), `apps/web/src/screens/vnd/` (screens VND-01 to VND-06). Migrations: block VND-1, `db/migrations/V2400` to `V2406`. VND-2 (independence, finance, load, bid security, subcontracts, risk tiers, performance) and VND-3 (investigation, screening, supplier portal) build on this foundation.

Every number below is a **rule of governance** (`governance_rule`, read through `GovernancePolicyPort`; a tenant approves its own version, maker is not approver) with its formula, source and as-of day, and every legal number is flagged **UNVERIFIED** until the legal staff of the tenant confirm it against the Gazette (`research-vendor.md` section 8). The sources are Điều 19, 20, 133 NĐ 214/2025/NĐ-CP and Điều 6, 16 Luật Đấu thầu 22/2023 as read from summaries, not checked against Luật 57/2024 and 90/2025.

## 1. What exists and what this lane adds

Before: `contractor` (identity by a tax code a person verified), `contractor_restriction` (a legal record that stops a bid and a result: 422 `CONTRACTOR_RESTRICTED`), `contract_party` (a joint venture of a contract), the e-GP import of restrictions (EGP-1). After this lane: the full profile, accounts with a controlled change, certificates and key staff, a debarment case behind every restriction, joint ventures, a ledger of events of bid conduct, and one **gate** asked at five places.

## 2. The master profile (V1, VND-02)

`contractor` gains the legal representative (name, position), the registered address, the telephone number (and the day it was put on file), the e-mail address, the business registration number, a declaration about ownership and the day of the next review. For each of the address, the telephone number, the e-mail address and the representative the table keeps a **key**: SHA-256 of the normal form (`vendor-profile.ts`: diacritics folded, `+84` written as `0`), never the value, so that two records of one party are found by equality. `contractor_owner` lists who holds the contractor (a person or an organisation, the share, the beneficial-owner flag, the basis of control, the paper); an owner is never rewritten, it ends (`ended_on`) and a new one is added, so the ownership on the day of a bid stays answerable; the number of an identity document is kept only as a blind index of the field cipher (HMAC), never stored.

**Tax code check** (`checkTaxCode`): the form (ten digits, or ten digits and a three digit branch) is decisive; the check digit (weights 31 29 23 21 19 17 13 7 5 3) is a **signal** shown on the profile with the badge "check digit rule unverified" (the algorithm is common knowledge, not in the sources read, and the acceptance fixtures do not all satisfy it), never a refusal.

**Completeness** (`profileCoverage`): rule `VENDOR_PROFILE` code `DEFAULT` lists `required_before_bid` (default: legal representative, registered address, contact, ownership), `review_months` (12) and `beneficial_owner_pct` (25, the threshold the anti money laundering decree is read to use; unverified). Ownership is present when an owner is listed or the contractor declared that nobody holds more than the threshold (`ownership_declaration`).

**Duplicates** (`scoreDuplicate`, rule `VENDOR_DUPLICATE_SIGNALS`): signals are the same tax code head (a branch against its head office), address, telephone number, e-mail address, representative, an owner (name key or identity key), an account (blind index), and a name alike (Jaccard of the words, 80 percent). Weights are rule data; a pair is **suggested** from 60 points. A pair is one row (`contractor_duplicate_suggestion`, smaller id first); a person dismisses it (it comes back only when the score rises above the score it was dismissed at) or sends it to the merge of master data (event `vnd.duplicate.decided.v1` is the hook for MDM F5). Nothing here merges and a name alone is never an identity.

## 3. Accounts a contractor is paid into (V12, VND-04)

An account is never changed in place. A change is a request (`contractor_bank_change_request`) with the letter of the contractor as evidence document; the holder must equal the legal name of the contractor (rule `name_match` REQUIRE or WARN); **two people approve in two roles** (CONTRACT_MATCH: the request against the contract file and the profile; ACCOUNT_MATCH: the account against its holder and bank), neither of them the requester and not the same person twice (the database holds this with a CHECK too); **somebody calls the contractor back** on the number the profile already held (the person says they used the number on file, the number dialled must equal the profile number now and at the time of the request, and must have been on file `callback_number_min_age_days`, default 7, so a number changed with the request proves nothing; only its last four digits are kept); a call that does not confirm rejects the request. When the third step is done the new account is activated, the account it replaces is SUPERSEDED, and **a payment waits `waiting_hours` (default 72)** before it may go to the new account. A request expires after `request_valid_days` (30). The number is sealed (`account_no_enc`, field cipher) and indexed blind (`account_no_key`); screens and answers show it masked only; one account held by two contractors is an alert. Every step is in `contractor_bank_event`, append-only.

Rule `VENDOR_PAYEE_ACCOUNT` also says whether a payment to a contractor that **never had an account** is warned about (default) or refused (`require_registered_account`), and whether the account that was replaced may be paid into during the wait (default no). A contractor that has had accounts and has none valid is always refused (422 `PAYEE_ACCOUNT_NOT_VALID`, reason IN_WAITING_PERIOD, NO_VALID_ACCOUNT, NO_ACCOUNT_REGISTERED). Decision: the default warns about a contractor with no account at all because every existing contract was made without one; a tenant switches the rule to BLOCK when its accounts are entered.

## 4. Certificates and key staff (V8, VND-05)

`contractor_qualification` (kind, number, grade III/II/I, scope, issuer, first and last day, paper) and `contractor_key_staff` (role, person, qualifying certificate, period, paper). Entered by one person, **verified by another** (CHECK in the database, and a paper is needed to verify); one that was not verified satisfies no requirement; revoked with a reason, never deleted; dates and number never change (a renewal is a new row). Warnings: rule `VENDOR_EXPIRY_WARNING` codes `QUALIFICATION` and `KEY_STAFF`: first warning 60 days before the end (WATCH), second 30 days (ACTION), on the day after the end EXPIRED (URGENT); the last day is a day on which the certificate still holds. `package_qualification_requirement` says what a package asks of its bidders (kind, lowest grade, a word the scope must contain); the gate checks the contractor against it at contract activation and when a subcontractor is taken on. The kinds of certificate and the grades are not confirmed against NĐ 175/2024 (the competent body of each grade and the date grade III stops being issued are reported differently): the list of kinds is wide and the order of grades is the one the certificate states.

## 5. The debarment case and joint ventures (V2, VND-03)

`restriction_case` is the workflow behind a restriction: **PROPOSED** (the proposal received; the clock of the decision starts) → **NOTICE_SENT** (the contractor is told and has `response_days`, default 10, our own choice) → **RESPONSE_RECEIVED** (an answer, or none after the window: `CLOSE_NO_RESPONSE` only after the window) → **DECIDED** (BAN or DISMISS by a person **other than the proposer**, on a decision paper; a ban names its months, its scope TENANT / PROVINCE / NATIONWIDE, its first day) → **EFFECTIVE** (the restriction rows are written, on a decision paper that is in force, on or after the first day) → **EXPIRED** (after the last day; `expireDue`) or **LIFTED** (an appeal succeeded: the rows get `lifted_at` and never block again, even on their first day); a case not yet decided can be WITHDRAWN (DISMISSED). Triggers: investor proposal, inspection or audit conclusion, petition resolution, import of the register of the national network, own initiative. Every move is in `restriction_case_event`, append-only; a case is never deleted; the decision is made once (database guard).

**Time limit**: rule `VENDOR_DEBARMENT`: `decide_within_days` 15 from the day the proposal is received (Điều 133; counted in `CALENDAR_DAYS` by default, the stricter reading, rolled to the next working day, or `WORKING_DAYS`), counted by the working-time engine (`postingDeadline` on the published calendar `WORKDAY_VN`; a year without a calendar is 422 `CALENDAR_NOT_EFFECTIVE`, never a guessed day). The decision is allowed late: `decided_late` is kept and the case raises an alert while open (`DUE_SOON` within `remind_before_days` of the end, `OVERDUE` after it). The response window of the contractor is counted the same way.

**Ban periods**: rule `VENDOR_DEBARMENT_PERIOD` codes `GROUP_1` 36 to 60 months, `GROUP_2` 12 to 36, `GROUP_3` 6 to 12; several groups give from the longest shortest ban to the sum of the longest, capped at `cumulative_max_months` (60): 422 `RESTRICTION_BAN_PERIOD_INVALID` naming the range. **Limitation** `limitation_years` 10: a violation older than that cannot be proposed (422 `RESTRICTION_CASE_TIME_BARRED`). **Escalation**: 3 decisions in force suggest a ban by the province, 5 by the minister (`province_threshold`, `national_threshold`): a suggestion shown on the profile and the case, never an action. All of these numbers are UNVERIFIED.

**Joint ventures** (`joint_venture`, `joint_venture_member`): a name, one lead, shares that add up to 100 with at most two decimals (also a deferred constraint trigger in the database), the agreement paper; set once, ended with a reason. A case against a venture reaches **every member** (each gets its own restriction row; `restriction_case_member` says which row came from which case), except for the violation groups listed in `jv_exception_groups` (default none), where only the members named `culpable_member_ids` are banned. The gates ask about the members of every active venture the contractor leads (and the parties of a contract).

## 6. The gate: blocks at five places (V2, V12)

`VendorGate.assertAllowed(tx, action, { contractorId | contractId, packageId, now })` (`packages/db/src/vendor-gate.ts`) is the precondition port, in the way `PayDisbursementCheck` is one for a disbursement. It is called by `BidProposalStore.receive` (BID_SUBMISSION), `BidResultStore` (RESULT), `CtrContractLifecycleStore.activate` (CONTRACT_ACTIVATION), `PayPaymentStore.build` and `PayClaimStore` at send (PAYMENT), and exposed for the subcontract of VND-2 (SUBCONTRACT). Checks per action (`GATE_CHECKS_BY_ACTION`): RESTRICTION everywhere; VERIFICATION and PROFILE at a bid, a result, an activation; QUALIFICATION at an activation and a subcontract; PAYEE at a payment.

| Check | Refusal | Softened by the tenant? |
|---|---|---|
| A restriction in force on the contractor, on a member of a venture it leads or on a party of the contract | 422 `CONTRACTOR_RESTRICTED` (`via` SELF, JOINT_VENTURE_MEMBER, CONTRACT_PARTY) | never |
| Tax code not verified | 422 `CONTRACTOR_NOT_VERIFIED` | never |
| Profile incomplete (rule `VENDOR_PROFILE`) | 422 `CONTRACTOR_PROFILE_INCOMPLETE` with the missing fields | `VENDOR_GATE.profile_enforcement` BLOCK or WARN (default WARN) |
| Certificate the package asks for missing, expired, not verified, low grade, scope not covered | 422 `CONTRACTOR_QUALIFICATION_MISSING` with the findings | `VENDOR_GATE.qualification_enforcement` (default WARN) |
| No valid account | 422 `PAYEE_ACCOUNT_NOT_VALID` | `require_registered_account` for a contractor that never had an account |

Decision: profile and qualification default to WARN because the existing records carry none of this data; the gate returns the warnings, `GET /vendor/gate-check` shows them, and the coverage indicator measures the work to do; a tenant that has completed its records approves a `VENDOR_GATE` rule with BLOCK (a rule version with a reason). A restriction is a legal record and is never softened.

## 7. Ledger of events of bid conduct (V3, VND-06)

`contractor_reputation_event`: the behaviours of Điều 20.1-2 (not comparing documents, not negotiating, winning without signing, withdrawing after closing, no bid security, no performance security, no confirmation of the award within 3 working days, no key staff or equipment, and a ninth the law may add), the day, the package or contract, the paper. The day the posting on the national system falls due is counted on the published calendar by the rule **`EGP_POSTING_DEADLINES` code `REPUTATION_EVENT`** (7 working days, EGP-2), so the clock here and the obligation of the posting there are one number. **Posted or retracted once by somebody other than the recorder** (CHECK too), with the receipt of the network or a reason of 20 characters; both final. Rule `VENDOR_REPUTATION`: a posted event multiplies the bid security of the contractor by 3 for 2 years from the posting day (`bidSecurityFactor`, shown on the profile as `bid_security`: the application of the factor to a bid security is VND-2 V10), and a winner confirms the award in 3 working days. Hook for EGP-2: when it builds the obligation `REPUTATION_EVENT` it reads these rows; the posting here (receipt reference) is the receipt of the obligation.

## 8. Alerts (`ALERT_TYPE`, source `VENDOR`)

Registered in `governance-rules.ts` (`registerVendorRules`) with owner, expected action, consequence and response time; read by `HomeVendorSources` when the alert centre is read (no job): the age and the clocks are computed then.

| Alert (research id) | When | Owner | Severity |
|---|---|---|---|
| `VENDOR_RESTRICTED_EXPOSURE` (V-A1) | A contractor under a restriction in force still has a contract that is signed, active or suspended, or a payment request not settled | Procurement officer | URGENT |
| `VENDOR_REPUTATION_POST` (V-A2) | An event recorded and not posted: within the reminder window (ACTION) or past its 7 working days (URGENT) | Investor representative | ACTION, URGENT |
| `VENDOR_DEBARMENT_DECISION` (V-A3) | A case without a decision: within `remind_before_days` of the 15 days (ACTION) or past them (URGENT) | Debarment authority | ACTION, URGENT |
| `VENDOR_PAYEE_ACCOUNT` (V-A6) | A change of account awaiting its approvals or call-back (ACTION); an account held by two contractors (URGENT) | Payment accountant | ACTION, URGENT |
| `VENDOR_QUALIFICATION_EXPIRY` (V-A8) | A certificate or a member of the key staff in its first window (WATCH), second (ACTION), expired (URGENT) | Contract manager | WATCH, ACTION, URGENT |

V-A7 (guarantees) is VND-2; V-A4, V-A5, V-A9 to V-A15 belong to VND-2 and VND-3.

## 9. Indicators (KPI register, `KPI_DEFINITION` defaults)

`VENDOR_PROFILE_COVERAGE` (verified contractors with every required field), `VENDOR_DEBARMENT_IN_TIME` (cases decided within the 15 days over decided plus overdue), `VENDOR_REPUTATION_POSTED_IN_TIME` (events posted within 7 working days over posted plus overdue; retracted left out), `VENDOR_ACCOUNT_CHANGES` (requests, with the number that had a call-back). Each has numerator, denominator, source and the unverified flag; `GET /vendor/figures` computes them and VND-01 shows them with the "i".

## 10. Permissions and operations

`vnd.read` (all reads), `vnd.profile.write`, `vnd.duplicate.decide`, `vnd.bank.request`, `vnd.bank.approve`, `vnd.bank.callback`, `vnd.qualification.write`, `vnd.qualification.verify`, `vnd.restriction.propose`, `vnd.restriction.decide`, `vnd.reputation.write`, `vnd.reputation.post`, `vnd.venture.write`; all on a grant over the **whole tenant** (a register of contractors belongs to no unit; a grant on a subtree is 403 `SCOPE_DENIED`). 12 reads and 30 commands under `/vendor/...` (`openapi.json`, tag VND). Every command is audited (ADM-11; classification PERSONAL for profile and accounts, CONFIDENTIAL for cases) and announces an outbox event with ids and codes only.

## 11. Hooks and follow-ups

- **e-GP import** (BID-24): see `docs/egp-connector.md` section 10, "Hook for the debarment register".
- **EGP-2**: reads `contractor_reputation_event` for the obligation `REPUTATION_EVENT`; the posting receipt is `posting_ref`.
- **VND-2**: `VendorGate` action SUBCONTRACT; `bidSecurityFactor` for the bid security (V10); the risk tier reads coverage, restrictions and certificates; the performance rating (V4) feeds the third decision of V2.
- **MDM**: `vnd.duplicate.decided.v1` with `decision = MERGE_REQUESTED` carries both contractor ids.
- **CTR, PAY**: consumers of `vnd.restriction.effective.v1` may suspend open work; the gate already stops new work.
- **Not done here**: a job that scans duplicates for the whole register nightly (the scan runs when a profile changes and on request), an official lookup of the tax code (the adapter of BID stays PROPOSED), exports for the national database, the supplier portal (VND-3).
