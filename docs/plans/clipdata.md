# Lane CLIPDATA: the seed layer for the two intro clips

Goal: a repeatable, deterministic seed layer that builds the demo datasets of the two intro clips on a REAL running stack, only through the
real HTTP commands of the product (real personas, real maker-checker and approval flows, no SQL into business tables, no mock UI).

- Clip A public edition, provincial scenario (Cao Bang): organisation, capital with central / local / ODA sources, 40+ projects, procurement plans and
  packages through the package workflow (a spread of states for the process tree), contractors, e-GP import and posting obligations, finance feed
  into the province committee workspace, alerts, directives, accounts for the clip roles.
- Clip B enterprise edition (PVFCCo, Dam Phu My): investment and equipment-purchase projects, equity vs loan funding figures, PVN forms issued,
  HPM push log, EBS reconciliation differences, directives from meetings.
- All names and figures are ILLUSTRATIVE; all Vietnamese demo text lives in JSON files; the datasets are deterministic from a seed.

## Design (decisions, owner rule: deepest governance, extensible, no scope cut)

1. Execution engine = the existing seed layer `apps/web/e2e/hdsd/seed` (SeedContext: real API, persona tokens, ask-first/skip-if-exists). New groups
   live in `apps/web/e2e/hdsd/seed/clip/`. They never invent ids: they query what exists.
2. Datasets are fixtures (`scripts/fixtures/clip-data/<dataset>.json`: Vietnamese texts, catalogues, counts, the seed). A pure planner
   (`scripts/clip-seed-lib.mjs`) expands a dataset into a deterministic plan (projects, packages, files, dates) with a seeded PRNG; the plan is a JSON
   file the TypeScript groups read (`CLIP_PLAN_FILE`), so the planning is unit-testable and the groups stay generic.
3. `scripts/clip-seed.mjs` has the sub-commands `plan`, `apply --dataset public|enterprise --api <url>` and `verify` (read-only, through the real
   read operations; fails when a count or figure is missing). Tokens use the same development session key as the stack (local env only).
4. The enterprise dataset needs the stack to serve the enterprise edition: `serve.stack.ts` gets a small, edition-check clean switch on
   `MACHVON_EDITION` (loads the edition manifest and modules through `load-edition`).
5. Honest limits recorded in `docs/clip-data.md`: no clock override exists over HTTP (late packages and late payments are only as late as the
   business dates the commands accept), BI metric registry sync has no HTTP route for its bundle, FEED to BAN bridge state.

## Steps

- [x] 0. Research the surface (API cheat sheets, existing seeds, stack).
- [x] 1. Pure planner + fixtures + `clip-seed.mjs` (plan/apply/verify skeleton) + tests `scripts/clip-seed.test.mjs`.
- [x] 2. Run the existing groups on a fresh docs stack (baseline proof), fix what is broken (appropriation of the programme fund, document seed route).
- [~] 3. Public groups: portfolio, contractors, plans, workflows at seven clocks, contracts (written, not yet run), alerts (written, not yet run); measurements, payments, advances NOT DONE.
- [~] 4. e-GP DONE and run; Treasury statement, snapshots, committee roster DONE and run; finance feed and directives WRITTEN, not yet run; alerts WRITTEN; BI NOT DONE (no route stores the metric bundle).
- [~] 5. Enterprise stack switch, projects, funding, directives, EBS DONE and run; PVN/HPM group WRITTEN, not yet run.
- [~] 6. Early runs verified; the full phased public run reached the end; the last groups wait for a stack window (the coordinator stopped the stack).
- [x] 7. `docs/clip-data.md`; gates; Codex review (gpt-6-astra) and triage; final report.

## Tests per step

- Planner: determinism (same seed, same plan), counts, uniqueness of codes, dates in order, no Vietnamese in code (gate).
- CLI: argument parsing, `verify` rule evaluation against a stub reader.
- Groups: proven by running on the stack (the ledger and `verify`), and by the unit tests of the pure parts.

## Risks

- Memory is tight: one stack, one run at a time, stop the stack when done.
- The docs stack has no business data and no working calendar: groups call `ensureWorkCalendar` first.
- Rules that need real elapsed time (late workflow steps, payment clocks) cannot be forced over HTTP; the seed uses the dates the commands accept.
