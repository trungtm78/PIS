# Lane QA-1: test items of "Dot 5" (AI evaluation, performance budget, browsers, guide steps, accessibility)

Branch `lane/qa1`. Source: plan section "Dot 5: hoan thien, UAT, phat hanh", test items; KT.01 to KT.03 (AI), the customer budget (every function under 5 s, every report under 20 s), multi-browser CI.

## Goal

Make the quality claims of the customer checkable by machines: a grounded-assistant evaluation that is scored by pure rules, a performance budget with a runner anyone can point at an API, three browser engines in CI, guide steps that can fail, and a lint-like accessibility rule set for screens.

## Steps

- [x] 1. AI scoring rules in kernel (pure): `packages/kernel/src/ai-assist-eval.ts` (citation precision and recall, case verdicts, thresholds, summary, markdown renderer) with golden tests `packages/kernel/test/ai-assist-eval.test.ts`. Test: golden numbers, thresholds, empty sets, determinism of the renderer.
- [ ] 2. AI evaluation suite (KT.01 to KT.03) over the mock gateway, no external call, no database: fixture corpus `apps/api/test/fixtures/ai-eval/corpus.json`, jest suite `apps/api/test/llm/ai-assist-eval.test.ts` (grounded answers, citation precision and recall, prompt injection, exfiltration of other tenants data, payment requests, external routing in the enterprise edition (R5), no AI-made decision, determinism of the mock gateway), report writer that writes `docs/qa/ai-assist-eval.json` and `.md` (`AI_EVAL_WRITE=1`) and a drift test that the committed report equals the regenerated one.
- [ ] 3. Performance budget: `docs/qa/perf-budget.json` (hot reads and report exports from the contract, class FUNCTION 5000 ms and REPORT 20000 ms), pure evaluator and runner `scripts/perf-budget.mjs` (any base URL, bearer token, p50 and p95, exit 1 when over budget, no k6), unit tests `scripts/perf-budget.test.mjs` (including a check of every entry against `openapi.json`), k6 scripts under `tests/k6` and `docs/qa/performance.md`.
- [ ] 4. Multi-browser: `apps/web/e2e/support/browsers.ts` (projects chromium, firefox, webkit chosen by `E2E_BROWSERS`, smoke subset for the engines that are not the baseline engine), wired in both Playwright configs, `e2e:smoke` script, matrix job in `.github/workflows/browser.yml`, YAML test with js-yaml, `docs/runbooks/browser-differences.md`.
- [ ] 5. Guide steps that can fail: the phone chapters and the DIR step carry a verification ledger (`scripts/hdsd/verification.json`) with a pass criterion for each step and a status; `scripts/hdsd/verification.mjs` checks the ledger against the chapters and fails on a step with no criterion, no needed data, or (with `--require-verified`) on a step still untested; node test.
- [ ] 6. Accessibility and responsive rules for screens: `scripts/a11y-lint.mjs` (pure rules over the sources of `apps/web/src`, a ratchet baseline) with test; added to `npm run lint` only if it is fast and green.
- [ ] 7. Gate: `npm run lint`, typecheck of kernel/api/web, tests of what changed, scan-files self-check, Codex review (model gpt-6-astra), fixes, final report.

## Decisions (owner rule 2026-11-08)

1. The scoring is kernel code so the web and the API can reuse it; the harness that needs the mock gateway lives in the API tests (the kernel never imports the API).
2. The AI suite needs no database: it runs with `MACHVON_TEST_LANE=unit` and is deterministic; the committed report is compared in a test, so a change of behaviour shows as a diff of a report a reviewer reads.
3. Thresholds: citation precision 1.0 (a wrong citation is never acceptable), recall at least 0.9 on the fixture corpus, injection resistance 1.0, exfiltration 0, AI-made decisions 0.
4. The performance runner skips an operation whose path parameters it has no value for and says so; `--strict` turns a skip into a failure, so a customer run with a seeded tenant is strict.
5. Firefox and webkit run a smoke subset (sign-in, a list, a form) only; the pixel baselines stay Chrome only.

## Risks

- The Playwright smoke subset cannot be run here (no browsers, no servers): it is validated statically (config load, YAML) and documented as such.
- Perf numbers depend on the customer hardware: the budget table is the contract, the runner reports the evidence.
