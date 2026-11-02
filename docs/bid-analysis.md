# BID: the AI analysis of a proposal (ST-BID-009, slice BID-1)

A member of the evaluation team asks for a **run** over a proposal (BID 3 F5): a model gives one finding per criterion, and the run keeps only what the pages bear out. The run's input is immutable, the data goes
only to domestic or self-hosted models, and the content of a bid is treated as data, never as an instruction. Everything the model says is a proposal for an expert to review (ST-BID-010 is where an expert decides).

## Asking for a run (`post_analysis_runs`, `ai.analyze`)

Refusals in order (the first that applies; nothing is written for them unless said):

| step | refusal |
|---|---|
| the proposal is not one the caller has the full view of (member of the evaluation team over the project, with `ai.analyze`; declared; released; no conflict standing) | 404, or 403 `CONFLICT_UNDECLARED` when the declaration is owed |
| criteria: of another package (422), not found (404), not approved (409 `CRITERIA_STATE_INVALID`) - checked after the repeat of a run that stands | |
| profile: not a PUBLISHED profile of the task `BID_ANALYSIS` (422 `PROFILE_NOT_PUBLISHED`), a tool that can write (422 `TOOL_NOT_READ_ONLY`) | |
| the pages: a file with a page the OCR has not recorded (409 `OCR_NOT_RECORDED`), a page that waits for a person (409 `OCR_REVIEW_PENDING`, BR-BID-06 / ST-BID-008), a text that does not match its digest (409 `OCR_NOT_RECORDED`), an input larger than the profile reads (422) | |

**Immutable input (BR-BID-05).** `document_version_set_sha256` hashes the files of the proposal (id and checksum, sorted); `input_hash = SHA-256(criteria_version_id, document_version_set_sha256, profile_version_id,
prompt_version_id)`. The same input is the same run: the repeat returns the run that stands (`reused: true`, no model asked), even when its criteria were superseded since. A new input (criteria, a file added to the
proposal, another profile or prompt) is a new run with `supersedes_run_id` = the latest run that stands; the older run and its findings are never updated (the database refuses it). A run that was **cancelled, failed
or refused** does not hold its input, so the same request is asked again as a new run.

**The pipeline** (`BidAnalysisService`, in the transaction of the command, so a run is whole or not there):
1. EXTRACT - the text of every page (the corrected text of a page a person corrected), each checked against its digest; the figures of the price are computed **in code** (`priceFacts`, exact decimals from the tables
   of the pages: the total of each table, whether it equals the price bid). The input (criteria, figures, pages wrapped as untrusted data between markers that the text cannot forge) is stored as a generated file;
   the gateway gets its key and hash, never the text.
2. MATCH - `LlmGatewayService.request` (ST-LLM-005): the class is the highest class of the files (CONFIDENTIAL for a bid), the route is decided by the policy in force and the profile (domestic then self-hosted, never
   international for non-public data), the budget is held, the answer is checked (JSON schema, citations). `max_cost_vnd` is the cost limit of BID-07. The route explanation is the `ai_request` of the run: class,
   `policy_version_id`, attempts.
3. VERIFY - `parseAnswer` (one finding per criterion, no other), each citation looked for on the page it names (`quoteIsPresent`: same words, white space and composed letters ignored; at least 8 characters), each
   figure cited by id looked for among the computed ones. `settleFinding` (BR-BID-07): a finding that says SUPPORTED/CONTRADICTED with no verified citation becomes NEEDS_REVIEW with `missing_source`.
   `confidence_type` is `HEURISTIC` (a signal, never shown as a probability, BR-BID-08).

How a run ends (`runEnd`): `AWAITING_REVIEW` when the answer was used; `REJECTED_BY_POLICY` when the policy or the budget refused (the error is answered, the run is kept); `FAILED` otherwise with the code of the gateway
(`AI_ROUTE_EXHAUSTED`, `REJECTED_NO_CITATION`, `INVALID_JSON`, `AI_KILL_SWITCH_ENGAGED`) or `OUTPUT_INVALID` at VERIFY. A failed run keeps its cost and has no finding.

## Tables (V1350)

`analysis_run` (extended in V002): the statuses, `failure_code`, `failed_step`, `version`, the checks that tie a status to what it needs, and the unique input of a **live** run (not cancelled, failed or refused).
`analysis_finding`: `missing_source`, one finding per criterion per run, `SUPPORTED`/`CONTRADICTED` need `evidence_count >= 1`, the review fields (`final_status`, reason of at least 20 characters). `analysis_evidence`:
the facts. Guards (`guard_analysis_run/finding/evidence`, owner of the schema not held): a run begins queued or running, its input never changes, it moves forward once, a run that is over stays so; a finding is written while
its run runs and then only an expert's review fields change (of a run that waits for the experts or is completed); evidence is insert-only; nothing is deleted or truncated. A deferred constraint trigger checks at commit
that `evidence_count` is the number of the finding's `verified_present` evidence.

## Cancelling (`post_analysis_runs_id_cancel`, `ai.cancel`, If-Match)

A run that waits for the experts (or is not over) is cancelled with a reason of 3 to 1000 characters if no finding has been reviewed (409 `ANALYSIS_STATE_INVALID`; 409 `VERSION_CONFLICT`). The run and its findings stay; the
cancellation frees the input. What the run cost stays settled at the gateway.

## Reads

`listAnalysisFindings` (`bid.evaluate`): the findings of a run with their evidence, filters `status`, `missing_source`, cursor; leaves `bid.findings_opened` (no text). `get_resources_analysis_run(_id)` and
`get_resources_analysis_finding(_id)`: DTOs of the runs and of the findings' standing (no text, no evidence, no `input_hash`, no `ai_request_id`). All of them show only what belongs to a proposal the caller has the full view
of: for anyone else it does not exist (404; 403 `CONFLICT_UNDECLARED` when the declaration is owed). `searchProposalPassages` (`bid.evaluate`): the pages of the files of the proposals of a package that the caller has the
full view of are cut into passages and ranked by an approved embedding model against a question (`AiKnowledgeService.rank`); the ACL is applied **before** any text is embedded, so a proposal of a contractor the caller
is recused from is never in the set (UAT-AC14), and page 12 of that proposal is 404 on `listProposalOcrPages`. The model must embed, take the class of the files and not be international for non-public files.

## Screens

BID-07 `/bid/bid-07?package=&proposal=` (configuration: criteria in force, profile id, cost limit, the OCR gate, the runs of the proposal), BID-08 `/bid/bid-08?run=` (the timeline, cost, route, cancel), BID-09
`/bid/bid-09?run=` (the workbench: findings with the label "AI proposal - expert review required", evidence verified or not found on the page, the missing-source flag, no accept action).

## What is not here

A real OCR engine and model providers (the port is the AI gateway; the stand-ins answer in tests); the temporal workflow (the run is synchronous in the request); retrieval over a persistent index of proposals (sealed
proposals are excluded from the knowledge collections by design: the ranking embeds the permitted pages at question time); the PDF viewer with bounding boxes; the SCORECARD evidence; the review of a finding by an expert
(ST-BID-010); the evaluation of the routes (ST-BID-014).
