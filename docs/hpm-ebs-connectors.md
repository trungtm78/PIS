# The connections of the enterprise edition: HPM push and Oracle EBS (ENT-2)

Specs: `Design/MACHVON_Design/01_Documents/05_modules/HPM.md` and `EBS.md`. Plan: `docs/plans/ent2.md`. Code: `packages/edition-enterprise/src/integration`, `apps/api/src/editions/enterprise`, `apps/web/src/editions/enterprise/screens`. Both connectors exist in the enterprise edition only; the public manifest denies the modules `HPM` and `EBS` (`ENTERPRISE_ONLY_MODULES`) and `npm run edition:check` keeps the public sources free of the code.

## 1. Status: PENDING-EXTERNAL (eng-review R18)

| Item | Who gives it | Working assumption | Consequence |
|---|---|---|---|
| Technical interface of HPM (platform, API, data structure) | Digital transformation and IT office | A delivery package written to a file (`HPM-FILE-WORKING-ASSUMPTION-2026.1`) by the file writer behind `HpmPort`; no socket is opened | A push is never accepted by itself: a person records the receipt of HPM; nothing built on the package is acceptable until the interface exists and the receiver confirmed it |
| Read access and format of the Oracle EBS extract | Finance and accounting office, IT office | Layout `WORKING-ASSUMPTION-2026.1` (columns project_code, period, extract_date, disbursed_vnd, committed_vnd) | Import and reconciliation run in UAT, the UAT verdict excludes them until an official sample file and the confirmation of finance exist |

Every answer of the API carries `acceptance: PENDING_EXTERNAL`, every screen shows the band, every audit row and event carries the word.

## 2. HPM push

- Key of a push: `organisation | layout | period | rN` (`issueKeyOf` of the kernel). `hpm_push` is unique on (tenant, key); the hash of the request makes another content under the key `HPM_KEY_REUSED`; a retry re-sends the same key with attempt n+1 (`hpm_push_attempt`, append-only), up to `max_attempts` of the rule `HPM_PUSH_POLICY` (`HPM_RETRY_EXHAUSTED`).
- Order of the revisions (R17): `assertDeliverable` of the kernel. A copy older than the newest issued (the head of RPT-1 included) or older than what HPM accepted is `REPORT_OUT_OF_DATE` with `current_revision`; the same bytes again are `ALREADY_DELIVERED`.
- Overwrite: a newer revision of an accepted period needs a period reopened (approved `period_reopen` of DIS, behind `PeriodReopenPort`) and a correction proposed and decided by two people (`hpm_correction`), used once; otherwise `HPM_OVERWRITE_NOT_AUTHORISED` naming `PERIOD_REOPENED` and `APPROVED_CORRECTION`. Each step is audited (ADM-11).
- The report: `issue_id` of an issued copy of RPT-1 (files, snapshot, form marks come from the copy; the delivery and the receipt are mirrored into `report_delivery`, channel `HPM_PUSH`, receiver `HPM`), or a file in the object store.
- Receipt: by somebody other than the pusher; a DEMO copy is never accepted (`TEMPLATE_UNCONFIRMED`).
- Port swap: an API adapter replaces `HpmFileWriter` behind `HPM_PORT`; nothing else changes. The sink of the file writer is a folder (`MACHVON_HPM_OUTBOX_DIR`), one sub-folder per tenant.

## 3. Oracle EBS

- Dry run (`previewEbsFile`) reads exactly as the apply and writes nothing; the apply (`importEbsFile`) goes through the file import framework once per hash and keeps what the file said in `ebs_record` (append-only).
- Reconciliation (`reconcileEbs`): per project code and period of the newest extract, cumulative disbursement (Treasury ledger to the end of the period, a reversal taking off) and commitment (price in force of the contracts that commit: SIGNED, ACTIVE, SUSPENDED, COMPLETED, CLOSED) against the statement, exact to the dong. Each difference is an `ebs_reconciliation_item`: owner not a maker (the loader and the runner), due in working days of the published calendar (`EBS_RECONCILE_POLICY`), explained by `OURS_WRONG`, `EBS_WRONG` (evidence) or `TIMING`, `WAIVED` (review day). The store never edits another module's record.

### 3.1 The code of a project in EBS and in HPM (ENT-3e, MD.01, TH.03, eng-review R25)

The code a project has in Oracle EBS (system `ORACLE_EBS`, the code its file import already names) and in HPM (system `HPM`) is a row of `master_crosswalk`: subject PROJECT, external type `PROJECT_CODE`, the maker-checker life of EGP-1 (proposed by one person, approved by another, retired and replaced, never edited) and a validity range. In the words of the plan these are the external types `EBS_PROJECT_CODE` and `HPM_PROJECT_CODE`; they are the pairs (system, type) of INT-1, not two new type strings, so the guard trigger, the unique indexes, the open API and the screen INT-03 serve them with no second copy. `ProjectCodeResolver.ensureSystems` registers the two systems in `int_source_system` of the tenant.

- Expand then contract: the import (`known` of the adapter, `figuresOf` of the reconciliation) reads a code through the ACTIVE mapping that holds on the day first, and by direct match against `project.code` after it (`DIRECT_MATCH_FALLBACK`, `resolveInbound`). A code that was reconciled by direct match is read as before: the records and the items keep the code the file said, the fingerprints do not move.
- A mapping of EBS or HPM may not give a code that is, as text, the code of ANOTHER project (409 `CROSSWALK_DUPLICATE`, reason `EXTERNAL_CODE_IS_OTHER_PROJECT`, at the proposal and again at the approval): the direct reading would have meant that other project and the mapping would move its history.
- HPM: the manifest of a package whose copy has a snapshot lists every project of the snapshot with the code HPM knows it by and how it was found (`project_codes`: `CROSSWALK` or `DIRECT`, the own code sent under the fallback), and counts those not yet mapped (`project_codes_unmapped`). A copy without a snapshot has the manifest it always had.
- INT-03 shows the reach of the codes of each system (`coverage` of `listProjectCodes`: projects, mapped, read by own code, waiting, in conflict).
- Contract step (a later version): when the coverage shows no project that depends on the fallback and no conflict, set `DIRECT_MATCH_FALLBACK` to false; `resolveInbound`, `resolveOutbound` and the coverage already name the result (`unmapped`).

## 4. Connections, freshness and alerts

Both register in `ent_connection` and the connector registry (`integration_connector`, Draft, adapter PROPOSED, like `egp.muasamcong`). Freshness: `HPM_PUSH_POLICY` and `CONNECTOR_FRESHNESS` code `EBS_FILE`, read through the governance port, numbers flagged unverified. Alert types `HPM_PUSH_FAILED` and `HPM_PUSH_STALE` (and the base `CONNECTOR_STALE` for EBS), owner INTEGRATION_ADMINISTRATOR, through the reader registry of the alert source CONNECTOR (`registerConnectorAlertReader`). For the Integration Hub each connector has one descriptor file: `hpm-connection.ts`, `ebs-connection.ts`.

## 5. Tests

`packages/edition-enterprise/src/integration/*.test.ts` (pure rules, port without network, rule registration, descriptors); `apps/api/test/editions/hpm.enterprise.test.ts` and `ebs.enterprise.test.ts` (real database, authorization, isolation, sockets watched); `apps/web/src/editions/enterprise/screens/**/*.test.tsx`.

## 6. The push of a step of the staged approval, and the adjustment in the next period (ENT-3c)

- The PUSH step of the staged approval (DIS reports, FND figure batches, IND entry batches) pushes through `HpmApprovalPush`: one series per record (`DIS_WEEKLY-<project>`, `FND_FIGURES-<project>`, `IND_ENTRIES-<project>`), the period is the end day of the report period or the period of the figures, the revision is the revision of the record. The same revision is one push however often the step is tried; the push log shows it with the file key `approval:<owner>:...`; it is tried again by approving the step again, not by `retryHpmPush` (409 `HPM_PUSH_STATE_INVALID`, `origin`). The step is done only when somebody other than the pusher records the receipt on HPM-01. See `docs/adm-approval-workflow.md`.
- TH.01 has two ways to put right a figure of an accepted period. By overwrite: reopening plus an approved correction (section 2). By adjustment in the next period: `proposeHpmCorrection` with `mode: ADJUST_NEXT_PERIOD` names the layout, the accepted period and revision, a subject code and a signed whole-dong amount; the amount is booked in the next period of the same grain (`2026-M12` is `2027-M01`; a period named by a day has none). Proposed by one person, decided by another through `decideHpmCorrection` (the id names the correction or the adjustment), recorded in `hpm_adjustment` with an append-only journal `hpm_adjustment_entry` (V2702), and carried once by the package of the target period (the first push of the key takes the approved adjustments; a retry sends exactly the ones its first try used). The accepted period is never touched. `listHpmCorrections` lists both modes (`mode`, `target_period`, `subject_code`, `amount_vnd`).
