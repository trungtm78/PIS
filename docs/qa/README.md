# Quality checks of the customer acceptance (lane QA-1)

| What | Where | Run |
|---|---|---|
| AI assistant evaluation, KT.01 (citation precision and recall), KT.02 (injection, exfiltration, payment decisions, external routing in the customer-servers edition), KT.03 (determinism) | scoring rules `packages/kernel/src/ai-assist-eval.ts`; harness, corpus and report writer `apps/api/test/llm/eval`, `apps/api/test/fixtures/ai-eval-corpus.json`; suite `apps/api/test/llm/ai-assist-eval.enterprise.test.ts`; committed report `ai-assist-eval.md` and `.json` in this folder | `cd apps/api && MACHVON_TEST_LANE=unit node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --testPathPatterns ai-assist-eval --forceExit --coverage=false` (no database, no server, no external call); `AI_EVAL_WRITE=1` rewrites the report after a deliberate change |
| Performance budget: a function under 5 s, a report under 20 s | `perf-budget.json`, `scripts/perf-budget.mjs`, `tests/k6`, `performance.md` | `node scripts/perf-budget.mjs --base-url <url>/v1 --token <jwt> --vars vars.json`; `npm run qa:check` validates the table |
| Browsers: chromium, firefox, webkit | `apps/web/e2e/support/browsers.ts`, `.github/workflows/browsers.yml`, `docs/runbooks/browser-differences.md` | `E2E_BROWSERS=firefox npm run e2e:smoke -w @machvon/web` |
| Phone guide steps: pass and fail criteria and device evidence | `scripts/hdsd/verification.json`, `scripts/hdsd/verification.mjs` | `node scripts/hdsd/verification.mjs --list`; after a new emulator walk: `node scripts/hdsd/verification.mjs --walk <walk.json> --list --require-verified` |
| Accessibility and responsive rules for screens | `scripts/a11y-lint.mjs`, `a11y-baseline.json` | `node scripts/a11y-lint.mjs --list`; a new screen must add no finding (`--update-baseline` only to record an accepted one, with a reason in the commit) |

`npm run qa:check` (part of `npm run lint`) runs the accessibility rules, the guide ledger check and the budget table check; it needs no browser, no emulator and no server. The unit tests of all of these run with `npm test` (`scripts/*.test.mjs`, the web support tests and the kernel and API suites).

## The accessibility rules

`A11Y-IMG-ALT`, `A11Y-BUTTON-TYPE`, `A11Y-CONTROL-NAME` (a label or a `FormField` around the control, or an id, `aria-label`, `aria-labelledby`, `title`), `A11Y-STATIC-CLICK` (a click on a non-interactive element needs a role and a key handler), `A11Y-TABINDEX` (never positive), `A11Y-BLANK-REL`, `A11Y-SVG-NAME`, `A11Y-ANCHOR-HREF`, `A11Y-OUTLINE-NONE` (a stylesheet that removes the outline needs a focus rule for the same element), `RSP-FIXED-WIDTH` (no inline width of 600 px or more), `RSP-VIEWPORT-WIDTH` (no `100vw` except as an upper bound) and `RSP-VIEWPORT-META` (device-width viewport, zoom allowed, a language). They read source text, so they are a smoke test: the axe run of `apps/web/e2e/a11y.spec.ts` and the route walk at 390 px remain the measurement.

The baseline holds what was found when the rules were added: one click on a `div` in `apps/web/src/ui/ProcessTree.tsx` (the outline row; the keyboard path is the tree item around it), to be fixed by the owner of the kit.
