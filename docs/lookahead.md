# Lane LOOKAHEAD: operations of the contract with no caller in the web product

Produced on 2026-11-08 by a script kept outside the repo (it walks `Design/MACHVON_Design/03_Engineering/openapi.json` and `apps/web/src`, ignores test files, and counts an operation as called when its operationId appears in a production file or when its path template appears in a string, because the public pages call the API with `fetch` and a path). Before the lane: 168 operations had no caller (83 of them the generic `get_resources_*` scaffold reads). After the lane: 52 operations other than the scaffold reads are left without a caller, all classified below.

## Look-ahead (GOV-11a, PRJ-30)

- Creation form on the look-ahead screen: week (a Monday), number of weeks from the rule `LOOK_AHEAD_POLICY` (never typed into the screen), items with start, finish and responsible, paste of lines from a sheet, a live window preview, validation with the rules of the server (`assertWindow`, `assertItems`), refusals in words (`LOOK_AHEAD_PLAN_EXISTS` links to the existing plan, `LOOK_AHEAD_WINDOW_INVALID`), the typed values survive a refusal, the "i" of the window with formula, source and version of the rule, the unverified note.
- Constraint form per item (`raiseLookAheadConstraint`): kind of the rule, words, owner from the members of the tenant (loading, error and none states), due day (a due day after the item starts is said, not refused).
- A week that has not begun was invisible to the screen (the read showed only the current plan), so a draft for next week could never be published. `getLookAhead` now takes an optional `plan_id` query (contract-patch, controller, store, db and API tests) and the list of weeks opens any plan.
- Not done on purpose: edit and withdraw of a draft. The API has no such operation and a published plan "no longer changes what it plans"; adding them is a contract change (follow-up for the API owner: `updateLookAheadPlan` for drafts, `withdrawLookAheadPlan`). Maker-checker: the contract has one permission `look_ahead.write` for create, publish, raise, clear and record, so the server cannot separate the maker from the publisher; the form says that the publisher is recorded as the owner and asks for a review of the draft (follow-up: a separate publish permission and `maker != publisher` in the store).

## Built in the owning screens (35 operations)

| Operation | Screen and action |
|---|---|
| createLookAheadPlan, raiseLookAheadConstraint | PRJ-30 creation form, constraint form |
| listVendorDuplicates | VND-01 duplicate queue with state filter, decide dialog reused |
| getVendorControlFigures | VND-01 control figures with the "i" of each |
| recordProposalSubmissionTrace | VND-13 trace dialog (write-once, files, duplicate version refused) |
| getMonitoringFeedback | PRJ-32 handling history of one feedback |
| getDocContainer | DOC-28 container detail with review figures |
| listGovernanceAlerts | PRJ-26 register of governance alerts (no project chosen) |
| listProjectRiskAlerts | PRJ-28 register of risk alerts |
| getContractRatingProposal | CTR-37 one proposal by `?proposal=` |
| listExpiringWarranties | AST-04 warranties ending soon |
| listUpcomingLandDeadlines | LND-01 land deadlines falling due |
| listMyAlertFeedback, withdrawAlertFeedback | HOME-30 my reports, withdraw while pending |
| getAlertLadderForItem | NOT-30 look-up of the ladder of one alert item |
| createDossier, getDossier, addDocumentToDossier, closeDossier | DOC-17 create, detail, add, close with retention preview |
| fileIncomingDocument | DOC-13 file a resolved letter into a dossier |
| placeLegalHold, releaseLegalHold | ADM-12 place and release (placer is not releaser) |
| getSodException | ADM-24 detail with approver decisions |
| createMneReport, correctMneReport | MNE-03 create, MNE-10 correct |
| confirmTreasuryManually | PAY payment detail manual confirmation |
| getBidClarification, getEvaluationReport | BID-11 `?clarification=`, BID-13 `?report=` |
| searchProposalPassages | BID-09 passage search |
| linkConversationResource | OMNI conversation link panel |
| post_budgets_id_reconcile | LLM-09 reconcile panel |
| createDocumentTemplateRevision | DOC-14 draft a template revision |
| getMyFeatureFlags | SAS-21 and SAS-23 release flag notes (unknown is never shown as off) |
| acceptInvitation | public page `/invitations/:invitationId/accept?token=` outside the shell (the mailer must point there) |

## Classified, nothing to build

- Same data served by another operation the screen already calls (alias or projection): `post_findings_id_review` (= `reviewAnalysisFinding`), `post_dashboards_id_publish` (= `decideBiPublication` flow), `listProjectDirectives` and `listOverdueDirectives` (the DIR board read takes `project_id` and `overdue`), `getInspection`, `getQualityAcceptance`, `getTreasuryDailyReconItem` (same record as the list row), `getAlertType` and `listGovernanceRules` (= `getEffectiveGovernanceRule` and `listGovernanceRuleVersions`), `getAiReviewChecklist`, `getAiEvalCriteriaSet`, `getCampaign`, `getDocumentLayoutProfile` (same schema as the list rows the screens show).
- Called with `fetch` and a path from the public pages (the script reports them only when the path is built in a template): `listPublicPortalProjects`, `getPublicPortalOc4ids`, `submitWhistleReport`, `getWhistleReportStatus`, `replyWhistleReportAsReporter` (PRJ-34 public portal and its report section).
- API-only by design, machine or module-to-module: webhooks (`receivePaymentWebhook`, `receiveEInvoiceWebhook`, `receiveChannelWebhook`), `receiveTreasuryCallback`, `receiveInteropMessage`, `recordUsageEvent`, the mobile sync set (`post_sync_batches`, `get_sync_commands_key`, `post_sync_attachments`, `post_sync_attachments_id_complete`, `get_sync_attachments_id`: called by the PWA and the Flutter app, not by the web shell), hub agents and runs (`recordHubRun`, `registerHubAgent`, `heartbeatHubAgent`), `pushFinanceFeedBatch`, the open API (`getOpenApiDocument`, `listOpenProjectCodes`, `listOpenDatasets`, `listOpenDisbursementLines`, `listOpenContractLines`, `issueOpenApiToken`), `requestDocumentIssue`, `resolveDocumentReference`, `resolveDocumentCitation`, `recordAiDecision`, `syncMetricRegistry`, `recordLineageBatch`, `issueSupportAccessToken`, `assignTenantOwner` (control plane, operator tooling).
- Read API of the finance feed for committee integrations: `getFinanceFeedQuality`, `getFinanceFeedFacts`, `listFinanceFeedProjects`. The BAN dashboards read the same facts server-side through `ProvinceFactsReader`, so no second screen is needed.
- The 83 generic `get_resources_*` scaffold reads: API-only (integration and tooling); three of them (`get_resources_membership`, `_project`, `_organization_unit`) are used by the lookups of the screens through the generic client.

## Hooks and follow-ups

- `updateLookAheadPlan` / `withdrawLookAheadPlan` and a publish permission for the look-ahead (maker-checker).
- Invitation mailer link format `/invitations/<id>/accept?token=<token>`.
- `HoldView.version` of `get_resources_legal_hold`: the release sends it as `If-Match`; if the row carries none the screen sends 1 and the server answers `VERSION_CONFLICT`.
- Deep-link detail views for `getInspection`, `getQualityAcceptance`, `getTreasuryDailyReconItem` are optional.
