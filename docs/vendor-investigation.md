# Investigation of contractors and the contractor portal (lane VND-3)

Lane VND-3 of the governance deepening. Research: `research-vendor.md` items V6 (related parties and bid rigging, auditors only), V14 (continuous screening), V15 (contractor portal and annual re-confirmation), V16 (statistics of petitions and claims), V17 (remediation plan) and V18 (parties for OCDS), with the alerts V-A5, V-A14, V-A15 that belong to them. Code: `packages/kernel/src/vnd-link-graph.ts`, `vnd-bid-rigging.ts`, `vnd-investigation.ts`, `vnd-screening.ts`, `vnd-portal.ts`, `vnd3-alerts.ts` and the texts `messages/vnd3-texts.ts` (pure rules, registered by `registerVendor3Rules` in `governance-rules.ts`); `packages/db/src/vnd-*.ts`, `portal-boundary.ts` and `rls-catalog.ts` (stores, the portal path, the catalogue test); `apps/api/src/modules/bid/vendor*.ts` (controllers in the module BID, as VND-1); `apps/web/src/screens/vnd/` (screens VND-13 to VND-22). Migrations: block VND-3, `db/migrations/V2440` to `V2447`. VND-1 (`docs/vendor-management.md`) is the foundation; VND-2 (independence, finance, load, bid security, subcontracts, risk grade, performance evaluation) runs in parallel and its screens are VND-07 to VND-12.

Every number below is a **rule of governance** (`governance_rule`, read through `GovernancePolicyPort`; a tenant approves its own version, maker is not approver) with its formula, source and as-of day (2026-11-08), and every one is flagged **UNVERIFIED**. The legal sources are Điều 16 Luật Đấu thầu 22/2023 (banned conduct: collusion, fraud, a relative standing as bidder) and Điều 19, 20, 133 NĐ 214/2025/NĐ-CP, as read from summaries and not checked against Luật 57/2024 and 90/2025. The patterns of bid rigging are general knowledge of the competition authorities; the OECD guidelines of 2025 did not open, so no number is quoted from them.

## 1. What exists and what this lane adds

Before: the register of contractors with keys of address, telephone, e-mail, representative, owners and accounts (VND-1), the red flags of packages and contracts (GOV-10, twelve indicators, auditors only), the import of the list of the national network into `egp_record` (EGP-1), the guest contractor member bound to a contractor (`membership_type GUEST_CONTRACTOR`, `contractor_id`, ADM-17).

After: (1) a **link graph** between contractors and a **screening of bid rigging** that give ranked **leads** to the auditors, with a review in two steps; (2) a **continuous screening** of the register against the national debarment list and other lists, with a **hold** the gate enforces; (3) the **portal** of the contractor: its own profile, requests and answers, certificates, evaluations, annual re-confirmation with the declaration of integrity, and remediation plans; (4) statistics of petitions and claims and the export of the parties in OCDS shape.

Nothing in this lane concludes anything about a person: a lead and a hit are signals for a person to decide. Nothing in it bans: a ban is decided by the authority in the case of VND-1.

## 2. The link graph (V6, VND-13, VND-14)

**Keys.** `buildLinks` (`vnd-link-graph.ts`) compares keys, never values: the tax code head (a branch against its head office), the blind index of the bank accounts, the key of the legal representative, the keys of the owners (name and identity), the keys of the address, the telephone number and the e-mail address (all from VND-1), and, when the receiving officer recorded them, the key of the origin of a submission, of the device, and of the author of a file (`proposal_submission_trace`, `proposal_submission_file`, section 3).

**Weights** (rule `VENDOR_LINK_RULE`, one per kind, 0 switches a kind off): see section 11. The evidences of a pair are taken as independent: strength = 1 minus the product of (1 minus weight/100), in whole points. Two parties that share an address alone have 35 and no link; an address with a telephone number have 61 and are linked; an account and a representative give 99 (95 and 70).

**Noise.** A key that more than `max_group_size` (6) contractors share (the address of a public accounting firm, a switchboard) is ignored and recorded as ignored with its size; otherwise the graph would be one cluster of the whole register.

**Clusters.** The connected groups of links (`clustersOf`); the score is the strongest link raised by 5 points for each member above two, capped at 100. A cluster of three or more, or a score from `cluster_from`, becomes a lead of kind `LINK_CLUSTER`. A cluster that holds a contractor under a restriction in force and others that are not gives the lead `RESTRICTED_AFFILIATE` ("suspected re-incorporation", the alert V-A1 of VND-1 reads the same fact for exposure).

**Projection.** The scan (`runVendorLinkScan`, also a nightly job) writes `contractor_party_link` (smaller id first, one row per pair, evidence as short fingerprints of eight characters, `ACTIVE` or `STALE`; a link a later scan no longer finds is marked `STALE`, never deleted) and `vendor_link_scan` (what the scan read and found, the versions of the rules). **Graph view**: `getVendorContractorLinks` returns the nodes, the links and the clusters around one contractor; the screen draws them with the deterministic `radialLayout` of the kernel (the contractor in focus at the centre, the others on a circle by strength) as an accessible SVG with a table that carries the same links, so no graph library is needed.

## 3. Bid rigging signals and leads (V6, VND-13, VND-14)

**Signals** (`vnd-bid-rigging.ts`, rule `VENDOR_BID_RIGGING`; each reads only what is recorded and gives nothing for want of data, `traceCoverage` says how much was recorded):

| Signal | Fires when |
|---|---|
| `ROTATING_WINNERS` | The contractors that bid in at least `rotation_min_packages` (4) of the packages of one buyer (the regulars) win in turn: at least two different winners, outsiders win at most `rotation_max_outsider_pct` (25) percent, no winner takes more than `rotation_max_share_pct` (70) percent |
| `COVER_BID` | At least `cover_min_bidders` (3) priced bids; the two lowest are within `cover_close_gap_bp` (50 basis points) and every other bid is at least `cover_far_gap_bp` (1000) above the second |
| `PRICE_PATTERN` | Identical prices from different bidders, or at least `pattern_min_bids` (3) prices that rise in equal steps within `pattern_step_tolerance_bp` (10) |
| `FILE_METADATA` | The same file fingerprint (author, producing program, creation stamp folded into one key) in the proposals of different bidders of one package |
| `SHARED_ORIGIN` | The same origin or device key in the submissions of different bidders, within `origin_window_minutes` (60) when both times are known |
| `WITHDRAWAL_FOR_WINNER` | A bidder withdrew in at least `withdrawal_min_count` (2) packages that the same other bidder won |

A withdrawn bid and a bid with no price are never priced. The score is the weight of the signal, raised when the pattern is more extreme; only a signal from `lead_from` (50) becomes a lead; the rank of a lead is the strongest score plus 5 for each further kind of signal on the same contractors (signals pile up where the trouble is).

**Trace of a submission** (`recordProposalSubmissionTrace`, permission `vnd.trace.write`): the officer who receives a proposal records, once, the address, the device, the user agent, the time of submission and, for each file, its author, producing program and creation stamp. The server keeps only keys made with the blind index of the field cipher; no address, user agent or author name is stored or shown. A second record for the same proposal is 409 `SUBMISSION_TRACE_EXISTS`; a trace is append-only.

**Leads.** One lead is one row (`vendor_investigation_lead`), keyed by the hash of the kind, the packages and the contractors, so a scan finds the same lead again and updates its rank and evidence (`evaluation_count`). The review is that of the red flags: **take** (NEW to IN_REVIEW), **propose dismissal** with a reason, and a **different** auditor **confirms** (403 `SELF_APPROVAL_DENIED`, also a CHECK of the table) or **rejects** with a reason; or **confirm the signal** as right with a reason, or **refer** it to an investigation. A move from the wrong status is 409 `LEAD_STATE_INVALID`. A dismissed lead is reopened by a scan when its rank rose by `reopen_rise` (15) points or a kind of evidence appeared that it did not have; a confirmed or referred lead is a record and never reopens. Every move is in `vendor_lead_review`, append-only.

**Who must not see it.** A lead is for auditors (`vnd.lead.*`, whole-tenant grant); the people who took part in the packages it is about (`vendor_lead_involved`: drafter, panel, workflow, result, contract, receiver of the proposal) get 404 on every read and move, as for the red flags. A contractor never sees a lead: the portal path of the database refuses every table of the investigation (section 5). **Precision.** The share of decided leads that were confirmed or referred (`leadPrecision`) is the measure of false alarms (KPI 9 of the research); none while nothing was decided.

## 4. Continuous screening against the lists of banned parties (V14, VND-15)

**Lists.** The list of the national procurement network is read where the file import of EGP-1 already keeps it: `egp_record` of kind `RESTRICTION` (tax code, name, validity, decision). The lists of the multilateral banks (`WORLD_BANK`, `ADB`), of politically exposed persons (`PEP`) and a list of the tenant (`OTHER_LIST`) come in through `importVendorScreeningList` (a bulk import of up to 5000 entries with the source, the as-of day and a reference, idempotent by the hash of the content; an entry a later import no longer lists is `WITHDRAWN`). The research did not find a public interface for the national list or for BHXH, tax and registration data, so the lists enter as files.

**Match** (`matchEntry`, rule `VENDOR_SCREENING`): the same tax code scores `weight_tax_code` (100); the same ten-digit head (a branch against its head office) `weight_tax_head` (90); a name alike (Jaccard of the words with the words of the company form taken out, from `name_similarity_from_pct` 80) scores `weight_name` (60) times the likeness and never more, and the rule is refused if the name weight could reach the hold line. A match from `hit_from` (60) is a **hit**; from `hold_from` (90) on an entry in force it **holds** the contractor (an entry not yet in force alerts without a hold unless `hold_not_yet_in_force`).

**Runs.** On a schedule (nightly job), after a change of a profile, after a list import and on request (`runVendorScreening`). A run writes `screening_run` and one `screening_hit` per contractor and entry (unique), with the score, the basis, the entry as it was (fingerprint of the row), and a history in `screening_hit_event`.

**Hold and the gate.** `VendorGate` of VND-1 asks about a hold at the five places (bid submission, result, contract activation, subcontract, payment): a contractor with a pending or confirmed hit with a hold is refused with 422 `CONTRACTOR_SCREENING_HOLD` until a person decides. The hold stops new work only.

**Decision.** A person with `vnd.screening.decide` **confirms** (PENDING to CONFIRMED; for a national record this opens the debarment case of VND-1 through `RestrictionCaseStore.openFromEgpRecord`, trigger `EGP_IMPORT`, so the 15 days run, the contractor is told, and the authority decides on a paper; the screening writes no row of `contractor_restriction`) or **dismisses** with a reason of at least 20 characters. A dismissed hit is asked again (PENDING, `reopened_count` plus one) when the entry changed (a new row hash) or after `dismiss_valid_days` (365); a hit whose entry left the list, or whose case has a decision, is RESOLVED. A move from the wrong status is 409 `SCREENING_HIT_STATE_INVALID`. The indicator `VENDOR_SCREENING_IN_TIME` measures the hits decided within `decide_within_days` (5).

## 5. The contractor portal (V15, VND-16 to VND-19)

**Identity.** A contractor is a guest member (`membership_type GUEST_CONTRACTOR`, `contractor_id`, an end day, ADM-17) with the system role `GUEST_CONTRACTOR`. Every portal operation takes the contractor from the caller (`BidContractorStore.callerOf`), never from the path or the body; a caller who is not a guest bound to a contractor is 403 `PORTAL_CONTRACTOR_REQUIRED`. A contractor gets its account through the invitation of ADM-17 (a guest member bound to the contractor, with an end day). The portal rights do not depend on a contract; the existing rule of `GuestAccessStore` ends the grants that name a contract when the last one closes, so the grant of the portal role is given to the guest without a contract scope (the follow-up for ADM-17 in section 13 says what is left). staff can send a request only to a contractor that has a live guest account (422 `CONTRACTOR_PORTAL_NOT_BOUND` otherwise).

**The database holds the boundary** (migration V2446, `portal-boundary.ts`, the catalogue test `rlsReport`). A portal operation runs in the usual tenant transaction and sets `app.portal_contractor_id` to the contractor of the caller (`enterPortalPath`; the value is checked to be a uuid). While it is set: the tables of one contractor (`contractor`, `contractor_owner`, `contractor_qualification`, `contractor_key_staff`, `contractor_performance`, `contractor_portal_request`, `contractor_portal_request_event`, `contractor_reconfirmation`, `contractor_remediation_plan`, `contractor_remediation_action`, `contractor_remediation_event`) answer only the rows of that contractor (restrictive policy `portal_boundary`); the tables of the investigation (`red_flag_*`, `vendor_link_scan`, `contractor_party_link`, `vendor_investigation_lead`, `vendor_lead_*`, `screening_*`, `proposal_submission_*`), of the debarment register (`contractor_restriction`, `restriction_case*`), of the accounts (`contractor_bank_*`), of the duplicates, of the reputation ledger, of the national records (`egp_record`) and of the conflict declarations answer nothing and accept no row. Without the setting (staff, jobs) the policy is true and nothing changes. Negative tests prove that a contractor cannot read another contractor, a red flag, a lead or a screening hit, even by raw SQL on the portal path.

**What a contractor sees** (`projectPortalProfile` is a whitelist: id, legal name, tax code, verification status, representative, address, telephone, e-mail, registration number, ownership declaration, next review day, version): its own profile, its requests and the clocks, its certificates and key staff with their expiry state, its **approved** evaluations (`contractor_performance`, status APPROVED; the 20 days to answer come from the request channel below), its remediation plans, the state of its re-confirmation. **What it never sees**: a red flag, a lead, a screening hit, the risk grade, a link, duplicate suggestions, internal notes, the name of a reviewer, or any other contractor.

**Requests and clocks** (`contractor_portal_request`, rule `VENDOR_PORTAL` with one code per kind). Staff send a request (kind `EVALUATION_RESPONSE`, `CERTIFICATE_UPLOAD`, `PROFILE_UPDATE`, `INFORMATION`, `SCREENING_CLARIFICATION`, `REMEDIATION_RESPONSE` or `OTHER`, optionally about a subject) and the due time is counted by the rule (calendar or working days on the published calendar, 422 `CALENDAR_NOT_EFFECTIVE` for a year with none). The contractor answers with text and optionally a document or a certificate; **a late answer is kept and marked late, never refused**. Staff accept it or return it with a reason (the request opens again, round plus one); the person who accepts is never the person who answered (CHECK). 409 `PORTAL_REQUEST_STATE_INVALID` for a move from the wrong status. The clock states are ON_TIME, DUE_SOON, OVERDUE, ANSWERED, ANSWERED_LATE.

**Certificates.** `submitPortalQualification` puts a certificate on file as the guest member (entered by the guest) in `contractor_qualification`: it is unverified and counts for no requirement until a different person verifies it (the VND-1 rule), and it may answer a request of kind `CERTIFICATE_UPLOAD`.

**Permissions** (V2447, privileged migration that appends to the existing role of every tenant, as V1444 did): `vnd.portal.read`, `vnd.portal.respond`, `vnd.portal.certificate`, `vnd.portal.reconfirm`, `vnd.portal.remediation`, added to `GUEST_CONTRACTOR`; the auditors' role receives the `vnd.lead.*` rights by grant, never the guest.

## 6. Annual re-confirmation (V15, VND-16, VND-20)

Rule `VENDOR_RECONFIRMATION`: every `interval_months` (12) the contractor confirms its profile and signs the declaration of integrity (no collusion, no price fixing, no relative of an official standing as bidder, no bribery, will report changes; Điều 16 Luật Đấu thầu). The text and its version are part of the rule (`declaration_version`, `declaration_text`); the contractor confirms the version it was shown, and a stale version is 409 `RECONFIRMATION_DECLARATION_STALE`. `confirmPortalReconfirmation` writes one append-only row of `contractor_reconfirmation` with the day, the SHA-256 of the declaration text, the SHA-256 of the profile as it was shown, what the contractor said had changed, the day it satisfied and the next due day (the confirmation day plus the interval; the month end stays a month end), and moves `contractor.next_review_due`. State on a day: CURRENT until `remind_days` (30) before the due day, DUE_SOON until it, OVERDUE for `grace_days` (30) after, then LAPSED; NEVER when no day is set. A lapse is **shown** (alert V-A15 and the indicator `VENDOR_RECONFIRMATION_CURRENT`), never a block: the register keeps working with the contractor.

## 7. Remediation plans (V17, VND-19, VND-21)

After a poor evaluation, a non-conformance, a screening hit or a dispute (or by hand) staff propose a plan (`contractor_remediation_plan`) with actions that have a due day (`contractor_remediation_action`, up to 50, no longer than `max_plan_days` 365). The contractor **agrees** on the portal (its commitment is its own), staff start the plan, the contractor marks each action **done** with a note and optionally a paper, staff **verify** each one (or reopen it with a note; the verifier is not the person who marked it done, CHECK). The plan is **completed** only when every action is VERIFIED (409 `REMEDIATION_STATE_INVALID` otherwise); it **fails** or is **cancelled** with a reason. Every move is in `contractor_remediation_event`. An action past its day raises the alert `VENDOR_REMEDIATION_ACTION` (from `remind_before_days` 3 before it). The plan links an evaluation of VND-2 as `trigger_ref`.

## 8. Disputes and the OCDS export (V16, V18, VND-22)

**Disputes** (`getVendorDisputes`, `disputeStats`): the petitions (`procurement_petition`) and the claims of a contractor, folded into four outcomes (OPEN, UPHELD, REJECTED, WITHDRAWN); counts that add up to the total, the share upheld among the decided, the mean days to close; for one contractor and for the whole register. It is information for the auditors; it decides nothing.

**OCDS parties** (`exportVendorOcdsParties`, `ocdsParty`, permission `vnd.ocds.export`): a party in the shape of `parties[]` of the Open Contracting Data Standard with the identifier `VN-MST` and the tax code (never an internal id), the registered address and the roles (`tenderer`, `supplier`). The standard has no field for beneficial owners: they go in `beneficialOwners` (in the way Open Ownership describes), and the contact point too, **only when the rule `VENDOR_OCDS_EXPORT` allows** (both off by default: the legal basis for publishing them is not confirmed). The answer names the rule version and says whether owners and contact were included.

## 9. Alerts (`ALERT_TYPE`, source `VENDOR`)

Registered in `governance-rules.ts` (`registerVendor3Rules`) with owner, expected action, consequence and response time; read by the alert source of the lane when the alert centre is read (no job); the facet severities are `VND3_FACET_SEVERITY` and a tenant changes them on the alert type.

| Alert (research id) | When | Owner | Facets and severity | Consequence |
|---|---|---|---|---|
| `VENDOR_LINK_LEAD` (V-A5) | An open lead; read only by auditors who did not take part in its packages | Auditor | `LEAD_NEW` WATCH, `LEAD_HIGH` (rank from `alert_from`) ACTION | Collusion or related parties may go undetected; the result may be cancelled on inspection |
| `VENDOR_SCREENING_HIT` (V-A14) | A pending hit; with a hold it is urgent | Approver of the register | `SCREENING_HOLD` URGENT, `SCREENING_HIT` ACTION | The contractor on hold cannot bid, win, activate or be paid; dealing with a banned party breaches Điều 16 |
| `VENDOR_RECONFIRM_OVERDUE` (V-A15) | Re-confirmation due soon, overdue or lapsed | Procurement officer | `RECONFIRM_DUE` WATCH, `RECONFIRM_OVERDUE` ACTION | The profile ages; ownership and representative cannot be trusted at evaluation |
| `VENDOR_PORTAL_REQUEST` | A request answered and waiting for review, due soon, or overdue | Procurement officer | `REQUEST_ANSWERED` ACTION, `REQUEST_DUE_SOON` WATCH, `REQUEST_OVERDUE` ACTION | Past the time limit an evaluation or request is closed without the contractor's view and may be contested |
| `VENDOR_REMEDIATION_ACTION` | An action of a plan near or past its day | Contract manager | `REMEDIATION_DUE` WATCH, `REMEDIATION_OVERDUE` ACTION | Schedule and quality risk of the contractor stays unaddressed |

The audiences are `vnd.lead.read`, `vnd.screening.decide`, `vnd.portal.manage` and `vnd.remediation.manage`, on the whole tenant (`VND3_AUDIENCE_PERMISSIONS`). V-A9 to V-A13 belong to VND-2.

## 10. Indicators (KPI register, `KPI_DEFINITION` defaults)

`VENDOR_LEAD_PRECISION` (leads confirmed or referred over leads decided; research KPI 9), `VENDOR_LEADS_OPEN`, `VENDOR_SCREENING_IN_TIME` (hits decided within `decide_within_days` over decided plus overdue), `VENDOR_PORTAL_RESPONSE_IN_TIME` (requests answered in time over answered plus overdue; research KPI 4), `VENDOR_RECONFIRMATION_CURRENT` (verified contractors whose re-confirmation is not overdue over verified contractors). Each has numerator, denominator, source and the unverified flag; `getVendorInvestigationFigures` and the screens VND-13, VND-15, VND-20 show them with the "i".

## 11. Rules (`governance_rule`, all UNVERIFIED, as-of 2026-11-08)

Source of all: the research report `research-vendor.md` and the articles named at the top; the numbers are starting values to settle with the customer and the auditors.

| Rule type (code) | Starting values |
|---|---|
| `VENDOR_LINK_RULE` (`DEFAULT`) | weights: tax head 90, bank account 95, legal representative 70, owner 75, address 35, telephone 40, e-mail 40, submission origin 55, device 60, file author 65; `link_from` 50, `cluster_from` 80, `max_group_size` 6 |
| `VENDOR_BID_RIGGING` (`DEFAULT`) | weights: rotating winners 75, cover bid 55, price pattern 55, file metadata 70, shared origin 60, withdrawal for winner 60; `rotation_min_packages` 4, `rotation_max_outsider_pct` 25, `rotation_max_share_pct` 70, `cover_close_gap_bp` 50, `cover_far_gap_bp` 1000, `cover_min_bidders` 3, `pattern_min_bids` 3, `pattern_step_tolerance_bp` 10, `withdrawal_min_count` 2, `origin_window_minutes` 60, `lead_from` 50 |
| `VENDOR_INVESTIGATION` (`DEFAULT`) | `reopen_rise` 15, `window_days` 1095, `alert_from` 70 |
| `VENDOR_SCREENING` (`DEFAULT`) | `weight_tax_code` 100, `weight_tax_head` 90, `weight_name` 60, `name_similarity_from_pct` 80, `hit_from` 60, `hold_from` 90, `dismiss_valid_days` 365, `hold_not_yet_in_force` false, `decide_within_days` 5 |
| `VENDOR_PORTAL` (one code per kind) | response days and unit, days before the end to remind: `EVALUATION_RESPONSE` 20 calendar, 5; `CERTIFICATE_UPLOAD` 15 calendar, 3; `PROFILE_UPDATE` 15 calendar, 3; `INFORMATION` 10 working, 2; `SCREENING_CLARIFICATION` 7 working, 2; `REMEDIATION_RESPONSE` 15 calendar, 3; `OTHER` 10 calendar, 2 |
| `VENDOR_RECONFIRMATION` (`DEFAULT`) | `interval_months` 12, `remind_days` 30, `grace_days` 30, `declaration_version` V1 with its text |
| `VENDOR_REMEDIATION` (`DEFAULT`) | `remind_before_days` 3, `max_plan_days` 365 |
| `VENDOR_OCDS_EXPORT` (`DEFAULT`) | `include_owners` false, `include_contact` false |

The 20 days of an evaluation are read from Điều 20 NĐ 214/2025 (summary); the others, and every weight and threshold, are our own starting choices. The refusals of a rule that cannot work are made when it is saved (422 `GOVERNANCE_RULE_PARAMS_INVALID`): a cluster line below the link line, a far gap not above the close gap, a name weight that could hold, a hold line below the hit line.

## 12. Permissions and operations

Permissions on a grant over the **whole tenant** (a register of contractors and an investigation belong to no unit; a grant on a subtree is 403 `SCOPE_DENIED`): `vnd.read`, `vnd.lead.read`, `vnd.lead.review`, `vnd.lead.confirm`, `vnd.lead.scan`, `vnd.trace.write`, `vnd.screening.read`, `vnd.screening.run`, `vnd.screening.decide`, `vnd.screening.import`, `vnd.portal.manage`, `vnd.remediation.manage`, `vnd.ocds.export`; and for the guest: `vnd.portal.read`, `vnd.portal.respond`, `vnd.portal.certificate`, `vnd.portal.reconfirm`, `vnd.portal.remediation`. Every command is audited (ADM-11; CONFIDENTIAL for leads and hits, PERSONAL for the portal and the trace), carries an outbox event of ids and codes only, and takes an `Idempotency-Key`.

17 reads and 26 commands, tag VND:

| Screen | Operations |
|---|---|
| VND-13, VND-14 | `listVendorLeads`, `getVendorLead`, `getVendorContractorLinks`, `getVendorInvestigationFigures`, `runVendorLinkScan`, `takeVendorLead`, `proposeVendorLeadDismissal`, `confirmVendorLeadDismissal`, `rejectVendorLeadDismissal`, `confirmVendorLeadSignal`, `referVendorLead`, `recordProposalSubmissionTrace` |
| VND-15 | `getVendorScreening`, `getVendorScreeningHit`, `runVendorScreening`, `confirmVendorScreeningHit`, `dismissVendorScreeningHit`, `importVendorScreeningList` |
| VND-16 to VND-19 | `getPortalHome`, `listPortalRequests`, `respondPortalRequest`, `listPortalQualifications`, `submitPortalQualification`, `listPortalEvaluations`, `confirmPortalReconfirmation`, `listPortalRemediationPlans`, `agreePortalRemediationPlan`, `markPortalRemediationActionDone` |
| VND-20, VND-21 | `listVendorPortalRequests`, `listVendorReconfirmations`, `createVendorPortalRequest`, `acceptVendorPortalRequest`, `returnVendorPortalRequest`, `cancelVendorPortalRequest`, `listVendorRemediationPlans`, `getVendorRemediationPlan`, `createVendorRemediationPlan`, `startVendorRemediationPlan`, `verifyVendorRemediationAction`, `completeVendorRemediationPlan`, `closeVendorRemediationPlan` |
| VND-22 | `getVendorDisputes`, `exportVendorOcdsParties` |

Error codes added: `LEAD_STATE_INVALID`, `SCREENING_HIT_STATE_INVALID`, `CONTRACTOR_SCREENING_HOLD`, `PORTAL_REQUEST_STATE_INVALID`, `PORTAL_CONTRACTOR_REQUIRED`, `CONTRACTOR_PORTAL_NOT_BOUND`, `RECONFIRMATION_DECLARATION_STALE`, `REMEDIATION_STATE_INVALID`, `SUBMISSION_TRACE_EXISTS`.

## 13. Hooks and follow-ups

- **VND-2**: the request channel is generic. VND-2 creates a request of kind `EVALUATION_RESPONSE` when it adopts a rating (the 20-day clock and the answer of the contractor are here; the publication clock of 6 months and the posting are VND-2); the risk grade may read the re-confirmation state, the screening holds and the confirmed leads; the gate action SUBCONTRACT already asks the hold; the subcontractor portal (confirmation of what the prime paid) can reuse the portal path.
- **EGP-2**: the national list is read from `egp_record`; the posting of a response of the contractor (20 days) can reference the request id.
- **ADM-17**: the invitation of a guest binds the member to the contractor; the screen of ADM-17 should offer the portal role as a grant that does not name a contract, so that the account outlives the contracts; until then the lead grants it by hand.
- **MDM**: unchanged; the screening never merges and never bans.
- **Alert centre**: the lead alert is read only by auditors who did not take part; the other four by the approver.
- **Not done here**: lists of PEP and the multilateral banks are bulk imports, not feeds (no public interface was confirmed); the national list stays a file; no tax, social insurance or registration lookup; beneficial-owner publication is off until the legal basis is confirmed; a mobile app for the portal; the nightly jobs run the same code as the commands and are registered with the jobs of the API.
