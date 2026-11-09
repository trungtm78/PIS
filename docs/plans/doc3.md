# DOC-3 plan: online help, admin guide, HPM proposal, Power BI model

Lane `lane/doc3`, ENT-3 gaps G17 (online help, YCK.08) and G18 (TH.01, TH.02, TK.02 documents). Customer spec: HSKT "Phan mem Quan ly DTXD" v0.3.

## Goal

1. Every web screen opens a help drawer from the shell header ("?" button) that shows the guide text of that screen, built from the existing hdsd tooling and the screen catalogue, stored as JSON (not in code).
2. An administrator guide built from the existing runbooks.
3. A proposal for the integration with HPM comparing the three methods, with a recommendation, a staged plan, the facts to ask for and the error/retry/correction rules.
4. A Power BI / Lakehouse sample semantic model with sample SQL over the read-only BI views and a `.pbids` file.

## Decisions (owner rule 2026-11-08: deepest governance, best extensibility, no scope cut)

- The help text is a generated, committed artefact `apps/web/src/help/help.vi.json`, one entry per web screen id, built by `scripts/help-index.mjs generate` from `routes.generated.json`, `screen_catalog.json` (purpose, role, fields, rule), the hdsd tour flows (`scripts/hdsd/flows/*.json`, headings and notes) and a generic per-kind step guide (`scripts/help/kind-guides.json`). `check` fails on drift, on a screen without an entry or an explicit reason in `scripts/help/no-help.json`, and on a reason for a screen that has an entry (stale).
- Vietnamese stays in JSON. Script and component code are English only.
- The JSON is loaded lazily (dynamic import, own chunk) when the drawer first opens, so the main bundle does not grow.
- The old "?" link to IAM-08 becomes the drawer button; the drawer carries a link to the help centre (IAM-08). The portal frame gets the same button.
- English locale: the help JSON is Vietnamese only today (customer language); the loader is keyed by locale (`help.<locale>.json`) and falls back to Vietnamese, so an English file can be added without code changes.
- `qa:check` gets `node scripts/help-index.mjs check` (it is a pure JSON/file check, cheap).

## Steps

- [ ] 1. Plan (this file).
- [ ] 2. `scripts/help-index.mjs` (generate, check), `scripts/help/kind-guides.json`, `scripts/help/no-help.json`, generated `apps/web/src/help/help.vi.json`, node tests. Test: `node --test scripts/help-index.test.mjs`.
- [ ] 3. Web: `apps/web/src/help/` loader + types, `apps/web/src/shell/HelpDrawer.tsx` (keyboard: opens with the button and the `?` key outside inputs, focus moved in and returned, Esc, Tab trap), TopBar and portal frame wiring, i18n parts `doc3.{vi,en}.json`. Tests: vitest of the single files (loader, drawer, TopBar, Shell help test).
- [ ] 4. `docs/admin-guide.md` from the runbooks (roles, rules, calendars, catalogues, integration hub, backup, audit export, upgrade).
- [ ] 5. `docs/integration/hpm-proposal.md`.
- [ ] 6. `docs/integration/power-bi-model.md`, `docs/integration/machvon-bi.pbids`, `docs/integration/power-bi-sample-queries.sql`.
- [ ] 7. hdsd index (`docs/hdsd` entry point list) and `qa:check` wiring; `git merge main`; independent review of `git diff main...HEAD`.

## Risks

- Shell tests that look for the help link (Shell.test.tsx) change: updated in step 3.
- Large generated JSON (about 569 entries): lazily loaded; size reported.
- The check needs the contract inputs in the worktree; they are committed files.
- i18n lint does not read unfolded parts: verified by folding in a throw-away copy of the catalogues, then restoring them.
- Codex is rate limited until 2026-11-10 23:17: the independent review uses a read-only subagent.
