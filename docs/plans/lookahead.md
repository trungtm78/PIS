# Lane LOOKAHEAD plan: close the functional gaps the lanes left in the web product

Branch `lane/lookahead` (worktree `D:\PIS-lookahead`), deadline: everything committed by 20:15 on 2026-11-08. No migration block is needed (web and design rows only; no new tables).

## Decisions (owner standing rule: decide by deepest governance, no scope cut)

- The look-ahead API has no edit or withdraw operation (a draft cannot be changed, a published plan "no longer changes what it plans"). The web does not invent one: the creation form is complete before it is sent (a local preview, validation with the same rules as the kernel `assertWindow` / `assertItems`), a refused create keeps what the person typed, and a wrong draft is handled by the server rule (one plan per project and week; refusal `LOOK_AHEAD_PLAN_EXISTS` names the plan, the screen links to it). Edit and withdraw are recorded as a follow-up for the API owner (they need a contract change, outside this lane's web scope).
- Maker-checker: the contract has no separate checker for the look-ahead plan; the person who publishes becomes the owner of the plan (store comment). The screen shows who may do what from the grant: the create, publish, raise, clear and outcome commands are separate permissions, so the maker (creates) and the owner (publishes) can be different people; the screen says so on the form and never hides a command the server would allow.
- The window (weeks) and the constraint kinds come from the rule `LOOK_AHEAD_POLICY` (`rule.params` of the read), never typed into the screen; a default nobody confirmed shows the unverified note.
- Operations with no UI caller: the list is produced by a script in the scratchpad (`unused-ops.mjs`, not in the repo); each is classified as SCREEN (a user does it), READ-ONLY-PROJECTION, or API-ONLY by design (machine account, webhook, job, agent, public portal consumer, generic resource read). The user-facing ones get actions in the owning screen.

## Steps

- [ ] 1. This plan committed first.
- [ ] 2. Look-ahead: model (pure validation, Monday rule, window, item rows) with unit tests; creation form (items table, week start, horizon) on the look-ahead screen; raise-constraint form per item; refusal words; states (loading, empty with the "create the first plan" action, error); the "i" with formula and source; i18n part `lookahead.{vi,en}.json`; vitest.
- [ ] 3. A11y: `ProcessTree.tsx` row becomes a real button with keyboard support; the a11y-lint baseline shrinks by the finding; vitest.
- [ ] 4. Classification of the uncalled operations (table in `docs/lookahead.md`); screen actions for the user-facing ones in their owning screens, each with a test; design rows (catalogue, navigation, route registry, backlog, traceability, test cases) only for a new screen id, through the design tooling.
- [ ] 5. Gates: web `tsc`, `eslint`, `i18n:check` on a scratch copy of the folded catalogues (folded files are not committed), `routes:check`, architecture, design `check-cli` and `baseline-cli` to 0 errors, repo `npm run lint` / `typecheck`.
- [ ] 6. Codex review (`gpt-6-astra`), every finding triaged, valid ones fixed with a test.

## Tests per step

- Step 2: `apps/web/src/screens/gov11/lookahead-form.test.ts` (pure rules), `gov11-screens.test.tsx` additions (create flow, refusals, empty state, preview, raise constraint).
- Step 3: `ProcessTree.test.tsx` (keyboard Enter and Space select, role, focus), `scripts/a11y-lint` self-test run.
- Step 4: one test per added action in the owning screen's test file.

## Risks

- Shared files (`screen_catalog.json`, routes index, authz) conflict at merge: edits are one anchored line each.
- DB jest queue is shared with a long gate: this lane changes no DB code and runs no DB tests.
