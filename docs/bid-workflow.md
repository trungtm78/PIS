# BID: the workflow of a procurement package (PRC-1, slice PRC-1, migrations V2320 to V2322)

The owner asked for one thing: looking at ONE package you see exactly which step it is at, and looking at ONE step you see which packages are in it. This story gives every package a **workflow** (the ordered steps of its selection method, with a checklist of evidence in each step), the rules that move it from step to step, a **process tree** ("Cây tiến độ") that counts packages in every state, and a **day-by-day timeline** of each package. Everything is derived from an append-only history; nothing on the screens is typed in.

## The definition is rule data (BR-PRC-01)

The governance rule type `PROCUREMENT_WORKFLOW` (owner module BID, code = the selection method: `OPEN_BIDDING`, `LIMITED_BIDDING`, `DIRECT_APPOINTMENT`, `COMPETITIVE_QUOTATION`, `DIRECT_PURCHASE`, `SELF_EXECUTION`, `COMMUNITY_PARTICIPATION`, `SPECIAL_CASE`) carries the steps. It is registered in `packages/kernel/src/governance-rules.ts` by `registerProcurementWorkflowRules` (never a constant of a screen or a controller) and read through `GovernancePolicyPort`: the approved version in force, else the built-in default of `packages/kernel/src/bid-workflow.ts`. A tenant changes it with the existing rule screens (draft, submit, approve by someone else; BID-31 is the viewer and editor).

| param | meaning |
|---|---|
| `name`, `method` | the name of the process and the method it is for (the code of the rule must equal the method) |
| `stalled_after_working_days` | a package with no activity for this many working days is stalled (alert `PRC_PACKAGE_STALLED`) |
| `checklist_warn_days` | a required item due within this many days is shown and alerted |
| `steps[]` | `code`, `name`, `entry_condition`, `exit_condition`, `responsible_role`, `standard_working_days`, `evidence_kinds[]` (each kind at least once between the items of the step), optional `milestone_kind`, `maker_checker`, `checklist[]` |
| `steps[].checklist[]` | `code`, `name`, `required`, `owner_role`, `due_offset_working_days` (from the day the step is entered), `evidence_kinds[]`, `evidence_required`, optional `milestone_kind` |

**Every default is flagged `legalStatus: UNVERIFIED`** ("chưa kiểm chứng"). The order follows the sequence of the Luật Đấu thầu 22/2023/QH15 (plan, prepare, appraise and approve the bidding document, notice, issue, clarify, close, open, evaluate, appraise and approve the result, post the result, negotiate, sign, performance guarantee); the number of standard days is a starting value set by the builders, and legal counsel and the procuring entity confirm it before anyone relies on it. The screens, the export file and the help text say so. `npm run governance:check` fails the build when a default lacks its formula, source, as-of day or legal flag.

A package that starts takes a **frozen copy** of the definition (version of the rule, 0 for the built-in default, and a SHA-256 of the canonical text). Changing the rule afterwards never moves a package that is under way; a new package takes the new version.

## The commands (all audited in ADM-11, announced in the outbox with ids and days only, `Idempotency-Key`; `If-Match` on the ones that change a workflow)

| command | permission | rule | refusals |
|---|---|---|---|
| `startPackageWorkflow` | `bid.workflow.manage` | the plan of the package is approved; one workflow per package; the method has a definition | 409 `PACKAGE_STATE_INVALID`, 409 `PACKAGE_WORKFLOW_STATE_INVALID` (`ALREADY_STARTED`), 422 `PACKAGE_WORKFLOW_METHOD_UNSUPPORTED` |
| `completePackageChecklistItem` | `bid.workflow.work` | an OPEN item of the CURRENT step of a running workflow; evidence of an allowed kind; a document of the tenant, a milestone of the package that has an actual date and the item's kind, an outside receipt reference, or a note (an attestation always has one) | 422 `CHECKLIST_EVIDENCE_REQUIRED`, 422 `VALIDATION_FAILED` (`evidence[i].*`), 409 `PACKAGE_WORKFLOW_STATE_INVALID` |
| `assignPackageChecklistItem` | `bid.workflow.manage` | names the person of an open item | 409, 422 |
| `advancePackageStep` | `bid.workflow.advance` | every required item DONE or WAIVED, the evidence of the step shown, and for a `maker_checker` step the caller completed none of its items; an approved `SKIP_ITEMS` exception covers open items and missing evidence (never maker-checker, never a workflow on hold); the last step completes the workflow | 409 `PACKAGE_WORKFLOW_BLOCKED` (`blockers[]`, `coverable_by_exception`), 403 `WORKFLOW_MAKER_IS_APPROVER`, 409 `STEP_EXCEPTION_STATE_INVALID`, 409 version |
| `returnPackageStep` | `bid.workflow.manage` | back to an EARLIER step with a reason; a new visit with a fresh checklist | 422 `VALIDATION_FAILED` (`to_step`), 409 |
| `holdPackageWorkflow`, `resumePackageWorkflow` | `bid.workflow.manage` | reason 5 to 500 characters; resume moves the due day of the step later by the working days it was held (calendar published) | 409 |
| `assignPackageWorkflowOwner` | `bid.workflow.manage` | a member of the tenant; a reassignment needs a reason; the same person again changes nothing | 422, 409 |
| `requestPackageStepException` | `bid.workflow.work` | `SKIP_ITEMS` (something to except: an open required item or missing evidence) or `CORRECT_BACK` (a previous step exists), with a reason; one open exception of a kind per visit | 409 `STEP_EXCEPTION_STATE_INVALID` |
| `decidePackageStepException` | `bid.workflow.approve` | APPROVE or REJECT by **another person than the one who asked** (database check too); approving `CORRECT_BACK` executes it: the wrongly entered visit ends as CORRECTED and a visit of the earlier step opens as a CORRECTION | 403 `SELF_APPROVAL_DENIED`, 409 `STEP_EXCEPTION_STATE_INVALID` (`NOT_WAITING`, `PACKAGE_MOVED_ON`) |
| `cancelPackageWorkflow` | `bid.workflow.approve` | a running or held workflow ends as CANCELLED with a reason | 409 |

**Correct (the brief's "correct").** A step moved by mistake is corrected with `CORRECT_BACK`: asked with a reason, decided by someone else, and recorded as new rows; no row of the history is edited or deleted.

## The history is append-only (BR-PRC-05)

`package_step` has a row per visit, opened when the package enters a step and closed once when it leaves (`ADVANCE`, `RETURN`, `CANCEL`, `COMPLETE`, `CORRECTED`); a closed visit never changes (trigger `guard_package_step`, only the due day of an open visit may move later). `package_checklist_evidence` and `package_workflow_log` have no UPDATE, DELETE or TRUNCATE for the application role. `package_workflow`, the items and the exceptions keep what they said for good; only their status moves along the edges the triggers allow. RLS (restrictive tenant boundary), `FORCE ROW LEVEL SECURITY` and the `machvon_owner` bypass follow `governance_rule` (V1850).

## Milestones are evidence (BR-PRC-08)

A milestone of the package that has an **actual date** (recorded by hand in BID-17 or written by the file of the national bidding network in BID-19) completes by itself the item that names its kind (`INVITATION_PUBLISHED`, `BID_CLOSING`, `BID_OPENING`, `EVALUATION_DONE`, `RESULT_APPROVED`, `RESULT_PUBLISHED`, `CONTRACT_SIGNED`; `CLARIFICATION_DEADLINE` maps to the clarification step). `BidWorkflowStore.syncMilestones(tx, workflow, actor, now)` does it when a workflow starts, when a step is entered and before a step is left: the item becomes DONE with `completed_via = MILESTONE` and no person (so it never counts as the maker of a maker-checker step) and the milestone is linked as evidence. Nothing about BID-17, BID-19 or the milestone import changes. **Hook:** a module that records a milestone may call `syncMilestones` in its own transaction to make the item follow at once; it is not wired into the milestone store, to keep BID-17 and BID-19 untouched.

## Evidence kinds are an open registry (hook for EGP-1 part 2; built by EGP-2)

EGP-2 registered `EGP_POSTING_RECEIPT` (source `EXTERNAL_RECEIPT`, `packages/kernel/src/egp-posting.ts`) and built the consumer of the dates of the national network (`docs/egp-connector.md` section 12.3): the milestones it fills complete the items through `BidWorkflowStore.syncMilestonesOfPackage`. A rule version that lists the kind on the step `NOTICE_POST` or `RESULT_POST` is still approved by the tenant.

`registerEvidenceKind({ code, source, label, module })` in `packages/kernel/src/bid-workflow.ts` (sources: `DOCUMENT`, `MILESTONE`, `EXTERNAL_RECEIPT`, `ATTESTATION`). Built in: `DOCUMENT`, `DECISION_DOCUMENT`, `MILESTONE`, `ATTESTATION`. A code is registered once. The wiring of the posting obligations of EGP-1 part 2 as steps is: register `EGP_POSTING_RECEIPT` with source `EXTERNAL_RECEIPT` (the evidence then carries the receipt reference in `external_ref`), then approve a new version of the rule `PROCUREMENT_WORKFLOW/<method>` whose step `NOTICE_POST` or `RESULT_POST` lists the kind in `evidence_kinds` of its item. The rule validator refuses a kind nobody registered, so the registration must run before the rule is approved.

## Dates and the working calendar (BR-PRC-04)

The due day of a step is the day of entry plus its standard working days on the published working calendar (`WORKDAY_VN`, the one the clocks of the alert centre use); a year that has no published calendar gives no due day (`due_basis = CALENDAR_UNAVAILABLE`), never a guess, and the screens say "chưa có lịch làm việc". Days in a step are working days when the calendar allows, else calendar days, and the response says which. A package on hold is not late. Pure functions: `addWorkingDays`, `workingDaysBetween`, `daysInStep` (kernel `bid-workflow.ts`).

## The process tree (BR-PRC-06): `buildProcessTree` in `packages/kernel/src/bid-process-tree.ts`

Every package is in exactly one **leaf**: the sub-state of its step (`ON_HOLD`, `LATE`, `RETURNED`, `ON_TRACK`, the first that applies) or a terminal (`NOT_STARTED`, `COMPLETED`, `CANCELLED`). Nodes: `ROOT`, `M:<method>`, `S:<method>:<step>`, `S:<method>:<step>:<SUB>`, `T:<method>:<TERMINAL>`. A node carries `count`, `value_vnd` (exact sum of whole VND), `share_count_bp` and `share_value_bp` (ten-thousandths of all packages and of all value), `median_days` (of the packages in it now), `late_count`, `path` (ids from the root) and `route` (the steps leading to it). Edges (`ADVANCE`, `RETURN`, `HOLD`, `CANCEL`, `COMPLETE`) count the moves **inside the period**. `packagesOfNode` is the same rule the tree counts with, so the list of a node always has exactly `count` rows. A package whose step is no longer in the definition is counted under its method, not hidden. The read keeps at most 5000 packages in memory and says `truncated` when more were found.

## The timeline (BR-PRC-05): `buildPackageTimeline` in `packages/kernel/src/bid-timeline.ts`

One function builds the day-by-day timeline of a package from the facts only: the visits (state changes with who, the days spent in the state left, the reason of a return or correction), the items done with their evidence, the log (holds, resumes, assignments, exception requests and decisions), the milestones (an import from a file of the national network is `IMPORT`), and the day a clock ran out (`CLOCK_OVERDUE`, derived from the due day, not stored). Companions: `groupTimelineByDay`, `filterTimeline` (day range, actor, state changes only), `timelineSummary` ("12 ngày ở bước 3, trễ 4 ngày so với chuẩn"), `ganttOf` (planned versus actual bars; the plan needs the calendar), `mergeRecentChanges` (the feed of a node).

## Statistics and KPIs (BR-PRC-07)

`stepStatistics`, `stuckPackages`, `medianOf`. For the KPI register (`WORKFLOW_KPIS` in the kernel; the register reads these definitions): `PRC_STEP_ON_TIME_SHARE` (share of the visits that ended by moving on in the period within the standard working days of the step, per step and per method) and `PRC_STEP_MEDIAN_DAYS` (median working days of those visits). The report `exportPackageWorkflowReport` carries the formula, the source and the as-of day and the notice that the standard days are unverified.

## Alerts (hook in `packages/db/src/home-work-*.ts`)

Source `PROCUREMENT_WORKFLOW` of the alert centre, read by `HomePrcSources` (`packages/db/src/home-prc-sources.ts`); four kinds, each an `ALERT_TYPE`:

| code | owner | expected action | consequence | default severity |
|---|---|---|---|---|
| `PRC_STEP_OVERDUE` | `PACKAGE_OWNER` | finish the open items and move the package on, or ask for an exception with a reason | the steps after it and the contract date move back; the project may disburse late | ACTION |
| `PRC_CHECKLIST_DUE` | `CHECKLIST_OWNER` | complete the required item with evidence before its day | the item blocks the package from the next step; past its day the step turns late | ACTION when overdue, WATCH within the warning days |
| `PRC_PACKAGE_STALLED` | `PACKAGE_OWNER` | see where the package is stuck, put it on hold with a reason or push the step | nobody records anything: the real progress is no longer followed | WATCH |
| `PRC_NO_OWNER` | `PROCUREMENT_MANAGER` | assign an owner to the package | nobody receives the alerts of the step and the checklist; the package drifts | ACTION |

The hook is additive in the files of lane A2: the four kinds in `WORK_KINDS` and their priority (`packages/kernel/src/home-work.ts`), the source, `SOURCE_OF_KIND`, the severity rules and `CONSEQUENCES` (`home-work-rules.ts`), and one reader in the list of `HomeWorkStore.collect`. Stalled packages are counted on the working calendar; with no calendar nothing is said.

## The screens

BID-27 the process tree (main view), BID-28 the board by step and the list, BID-29 one package, BID-30 bottleneck analysis and the Excel export, BID-31 the definition viewer and editor; phone MOB-69 packages by step, MOB-70 one package with its timeline, MOB-71 the tree as an outline; the PWA leader dashboard has a funnel card from `getPackageWorkflowSummary`. Design: `docs/process-tree-design.md`.
