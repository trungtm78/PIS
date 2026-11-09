# Browser engines: what runs where and what is known to differ

## What runs where

| Engine | Where | What |
|---|---|---|
| Chromium (Google Chrome where installed, else Playwright's Chromium) | `browser.yml`, developer machines | the whole suite: route walk (406 routes at 1440 and 390 px), flows, accessibility, pixel regions |
| Firefox | `browsers.yml` (matrix leg `firefox`) | the smoke subset |
| WebKit (Safari's engine) | `browsers.yml` (matrix leg `webkit`) | the smoke subset |
| Microsoft Edge (the Chromium engine through the `msedge` channel, installed with `playwright install msedge`) | `browsers.yml` (matrix leg `edge`) | the smoke subset |

The smoke subset is `CROSS_BROWSER_SMOKE` in `apps/web/e2e/support/browsers.ts`: the real sign-in with its redirects and PKCE (`session-flows`), a list and form screen of the administration (`adm-flows`), a project screen with a form (`prj-flows`) and the accessibility check (`a11y`). The pixel baselines were rendered by Google Chrome on Windows and the route walk is a Chromium check, so `visual.spec.ts` and `route-walk.spec.ts` never run on the other engines (`BASELINE_ONLY`).

Locally, with the stack as usual (see `web-e2e.md`):

```bash
E2E_BROWSERS=firefox npm run e2e:smoke -w @machvon/web
E2E_BROWSERS=webkit  npm run e2e:smoke -w @machvon/web
E2E_BROWSERS=edge    npm run e2e:smoke -w @machvon/web
E2E_BROWSERS=chromium,firefox,webkit E2E_BROWSER_SCOPE=full npx playwright test      # everything on all three (release candidate; slow)
npx playwright install firefox webkit                                                  # once; browsers are never committed
```

`E2E_BROWSERS` names the engines (an unknown name stops the run); without it the run is the single default one and nothing here applies. The flows write to the database of the API stack they start, so CI gives each engine its own runner. The recording of the user guide (`playwright.hdsd.config.ts`) defines its own projects and always uses Chromium.

## State of the evidence

The lane is wired and its configuration is tested (`apps/web/e2e/support/browsers.test.ts`, `scripts/browsers-workflow.test.mjs`), but it has not been run on Firefox or WebKit yet: the machine that built it has no such browsers and no servers were started for it. The first run of the workflow is the first evidence; the table below starts with what is expected from the engines and is to be corrected with what the first runs show.

## Differences to expect

| Area | Chromium | Firefox | WebKit | What the product does about it |
|---|---|---|---|---|
| Fonts and Vietnamese diacritics | the baseline (Chrome on Windows) | different default fonts on Linux; stacked tone marks can change line height | different again | text is never compared by pixels outside Chromium; layout rules use `rem` and tokens, never a fixed pixel height for text |
| `input type="date"` and `type="month"` | native picker | native picker, different layout and keyboard handling | native picker, limited on desktop Safari versions | forms use the kit date field; specs fill dates through the label, never by clicking inside the picker |
| Scrollbars | classic scrollbars take width on Windows and Linux | thin scrollbars in recent versions | overlay scrollbars on macOS | no width computed from `100vw`; the 1440 px overflow rule of the route walk is Chromium only |
| Storage and cookies | permissive in a test context | total cookie protection can partition third-party cookies | tracking prevention caps script-written storage (about 7 days) and blocks third-party cookies | the session is a tenant token in memory plus the identity provider cookie of the same site; the sign-in smoke is the check |
| Redirect and PKCE sign-in | reference | same flow | stricter about cross-site cookies and secure contexts (`127.0.0.1` counts as secure) | `session-flows` runs the whole redirect on each engine |
| Viewport units on phones | `100vh` is the large viewport | same | the address bar changes `100vh`; use `dvh` | no full-height layout depends on `100vh`; the route walk checks 390 px on Chromium |
| Form zoom | none | none | iOS zooms an input under 16 px | the field kit keeps 16 px on narrow screens |
| Service worker and installation | installable | no install of a web app on desktop | limited background work and push | the PWA is an enhancement; the flows do not depend on a service worker |
| `Intl` collation of Vietnamese | ICU | ICU | ICU, with differences in older versions | sorting rules that matter to a legal register are done by the API, not by the browser |
| Print and PDF | reference | different pagination of tables | different pagination | exports are files made by the API (XLSX, DOCX, PDF), not browser printing |

## When a leg is red

1. Open the artifact `browser-smoke-<engine>` (traces) of the run and reproduce with `E2E_BROWSERS=<engine> npx playwright test <spec> --headed`.
2. Decide: a product defect (fix it), a test that relied on engine behaviour (fix the spec so it uses roles and labels), or a real difference of the engine that the product accepts. Only the last is recorded here, with the date, the spec and the reason; a difference is never hidden by removing a spec from the smoke list without a line below.
3. A spec that cannot run on one engine is excluded for that engine in `browsers.ts` (a named list with a reason in the code), not skipped inside the spec.

## Accepted differences

None recorded yet.
