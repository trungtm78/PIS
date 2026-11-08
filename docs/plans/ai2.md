# Lane AI-2: the AI assistant on the real gateway (plan and decisions)

Branch `lane/ai2`, migration block 2180-2199, requirements AI.01, AI.02, AI.04, AI.05, AI.07, eng-review R5, KT.02.

## Scope

| Item | What is built | Where |
|---|---|---|
| AI.01 questions, summaries, explanatory notes | Statements labelled SOURCE, ASSUMPTION, INFERENCE; every citation verified against what the asker may read | `packages/kernel/src/ai-assist*.ts`, `apps/api/src/modules/llm/assist.*` |
| AI.02 review before submission | Checklists (rules in code plus AI questions); verdict is advice | `ai_review_checklist*`, `composeReview` |
| AI.04 contract performance | Criteria sets with weights in basis points, human decision, total from accepted scores | `ai_eval_criteria_set`, `ai_assist_decision`, `resolveDecision` |
| AI.05 feasibility | Section coverage shown, unsupported statements never kept | `sectionCoverage` |
| AI.07 real gateway | `LlmGatewayService.request` with record sources; `MockAiGateway` is only the test adapter | `gateway.service.ts` |
| R5 enterprise | Edition AI policy (customer servers only), approved and logged exceptions, provider attestation | `ai-edition-policy.ts`, `packages/edition-enterprise/src/ai-policy.ts` |

## Decisions (owner rule 2026-11-08: decide by governance, never cut scope)

1. Sources are DOCUMENT_VERSION, PROJECT, CONTRACT, APPRAISAL (approved only). A record without a class label is CONFIDENTIAL (BR-LLM-02); a project uses its own label.
2. A source the asker cannot read is indistinguishable from one that does not exist (422 `AI_ASSIST_SOURCE_NOT_READABLE`); a citation outside the readable set is dropped and only counted; a stored run is re-verified at every read.
3. A run is private to its asker, immutable, advisory by constraint; the decision is a separate append-only row and also the gateway `ai_decision_record`.
4. The edition policy is a process value (kernel mechanism, enterprise package value, loaded by the API seam); "external" means any route but SELF_HOSTED.
5. Exceptions: asked and approved by two people, at most 90 days, approval needs a paper reference, every use is logged (append-only).
6. Prompt injection: data/instruction separation in the input envelope, disarmed tags, signals counted and shown, strict output schema (no extra fields), citation verification as the last line.

## Hooks left for other lanes

- Prefill of the CTR scorecard from an accepted evaluation (a person does it today).
- DOC-2 page and cell citations: `locator` is `page:N` or `field:name` and can take more kinds.
- WF-1 may read the review verdict as an advisory input to a step; nothing blocks sending a file.
- Word export of an accepted note (IAM-2 / DOC-2).
- Real LiteLLM adapter behind `LLM_GATEWAY` on the customer servers (deployment).

## Review

Codex review (`codex review --base main`, model gpt-6-astra, read-only) of the branch before the merge of main; three findings, all valid and fixed with regression tests:

| Finding | Disposition | Test |
|---|---|---|
| P1 an external exception that ends while a call is pending still covers the retries and the fallbacks | The gateway reads the standing exceptions again before every call, retries included; a lapsed one ends the call chain (reject code `AI_EXTERNAL_EXCEPTION_REQUIRED` when nothing else was served) | `ai-external.enterprise.test.ts`, "reads the exception again before each call" |
| P1 a published PATTERN item can backtrack without end and block the event loop | The pattern runs in a VM context with a timeout of 100 ms; a pattern that cannot be run in time does not pass (`PATTERN_TIMEOUT`) | `packages/kernel/test/ai-assist.test.ts`, "cuts off a pattern that backtracks without end" |
| P2 the stored score proposals of an evaluation stay evidence-backed after the reader loses the source | `view()` computes the proposals again from the re-verified statements and the criteria | `ai-assist.test.ts`, "withholds the score again when the reader loses the source" |

## Verification

Kernel, db and API typecheck; API suites through the db lane: `llm/ai-assist`, `llm/ai-external.enterprise`, isolation, conformance, outbox consumers, DIS report, authz matrices; web: `src/screens/llm/assist` and `src/routes`; `edition:check`, `i18n-lint`, `commands:check`, `lint-error-codes`, `migrations:check`, `contracts:check`, design `check-cli` at zero errors.
