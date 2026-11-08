# Clip data: the seed layer of the two intro clips

The two intro clips (public investment, province of Cao Bang; enterprise edition, PVFCCo style) are recorded on a REAL running product with data made by
the product's own commands: real personas, real maker-checker and approval flows, no SQL into business tables, no mock screens. This layer builds that
data, repeatably. All names and figures are ILLUSTRATIVE demo data, never real customer data. Everything is deterministic from the seed of the dataset.

## Parts

| Part | Where | What |
|---|---|---|
| Datasets | `scripts/fixtures/clip-data/public.json`, `enterprise.json` | Counts, catalogues, the seed and ALL Vietnamese demo text (the code holds English only). |
| Planner | `scripts/clip-seed-lib.mjs` | Pure: dataset + seed give one plan (projects, lines of capital, packages with their workflow step and clock, funding, files, rules, meetings). Same seed, same digest. Also the phases of an apply. |
| CLI | `scripts/clip-seed.mjs` | `plan`, `apply`, `verify`. |
| Verify | `scripts/clip-seed-verify.mjs`, `clip-seed-client.mjs` | Read-only: reads counts back through the real read operations and fails when something is missing (a figure is never invented, a verdict over no check fails). |
| Groups | `apps/web/e2e/hdsd/seed/clip/*.ts` | The seed groups that call the commands; they join the registry of the guide seeds (`apps/web/e2e/hdsd/seed/index.ts`). |
| Stack clock | `apps/api/test/e2e-stack/serve.stack.ts` | `GET/POST /__e2e/clock {offset_days}` (and `E2E_CLOCK_OFFSET_DAYS`): only `Date` is shifted. |
| Tests | `scripts/clip-seed.test.mjs`, `apps/web/e2e/hdsd/seed/clip/clip.test.ts` | The pure parts (planner, phases, verify rules against stub stacks, the files the groups upload). `node --test scripts/clip-seed.test.mjs`; from `apps/web`: `node --test e2e/hdsd/seed/clip/clip.test.ts`. |

## The clock

The product reads `new Date()` and no command takes a date of "now". So the stack gets a shiftable clock and `apply` runs in PHASES (`DATASET_PHASES`): the clock is set
(`clockDays` from the real day), the groups of the phase run, and the clock is always brought back to the real day at the end. The public dataset runs:
the capital groups at -80 days (the annual plan is published in the past, so the snapshots of the closed months find a plan in force); documents, plans and
contracts at the real day; the package workflows at seven clocks (-70 ... -1 days, each package has its own: a step entered long ago stands over its due day when the
clock comes back, so the process tree shows late steps beside the ones on time, on hold and given back); then e-GP, alerts, disbursement, feed, directives and the committee at the real day.
The seed client reads the day from the stack (`SeedContext.syncClock`), so every date it computes is the day the server believes it is. What the database stamps by itself
(`created_at`) stays real.

## Datasets

Public (`--dataset public`), groups in order: `base`, `capital`, `clip-public-documents`, `clip-public-procurement`, `clip-public-contracts`, `clip-public-workflow`,
`clip-public-alerts`, `clip-public-egp`, `clip-public-disbursement`, `clip-public-feed`, `clip-public-directives`, `clip-public-committee`.

- Province of Cao Bang: 16 wards, 13 projects of the guide plus 32 generated: 45 projects over 8 sectors in every stage. Funded projects get a national code and lines of the
  annual plan `KHV-2026` on the assignments of capital: central (`NSTW`), local (`NSDP`), the national target programme, ODA grant and ODA on-lending.
- Documents: the delegation-of-authority matrix and the document seed of the guide issue the decisions that procurement needs (an incoming letter is not "in force").
- Procurement: 14 plans, 42 packages, approved by the leader on an issued decision; every package workflow is moved to the step the plan names (running at many
  steps, 2 on hold, some given back, some not started), at its own clock. 16 contractors (the owner verifies as the second person).
- Contracts: the tenders of the five projects of the guide (sealed proposals, evaluation, result approved) and the contract of each awarded package taken to ACTIVE
  (bill of quantities, guarantee verified by a second person, review, signature, activation); a claim and a periodic evaluation on the first.
- Alerts: the early-warning rules (information, warning, critical by how far a project is behind the line) are published BEFORE the snapshots are frozen; the warnings
  are made by the platform when a snapshot is frozen. Nothing is inserted into an alert table.
- e-GP (muasamcong): plan and notice files through the dry run and the apply (bad rows named), mappings decided by the leader (some left waiting), posting obligations
  overdue, due soon and met, reconciliation with items resolved in different ways.
- Money: the Treasury office and its code mapping, the statement file imported, monthly periods closed, the snapshots of the last two months frozen (command center, rates,
  committee). The finance feed (project, plan and disbursement files, mappings, generator, reconciliation).
- Committee: the steering committee registered, four members appointed; the head is the account `docHead` (see Accounts). Directives of three meetings, some overdue.

Enterprise (`--dataset enterprise`, the stack must serve the enterprise edition), groups: `clip-ent-projects`, `clip-ent-funding`, `clip-ent-directives`, `clip-ent-ebs`, `clip-ent-reports`.

- 6 investment and 6 equipment-purchase projects; the year plan of each split into equity and loan (prepared by the officer, accepted by the leader); the directives
  of three meetings; the file of the accounting system imported and reconciled; the PVN and HPM demo forms issued through the report engine by three different people and the HPM push log
  (one written, one answered with a rejection reason, because a demo copy can never be accepted).

## Accounts

The people are the accounts of the docs stack (`apps/web/e2e/support/docs-people.json`): leader (`capApprover`), unit admin (`unitAdmin`), officer (`projectManager`),
accountant (`treasuryMaker`), auditor (`auditor`), tenant owner (`owner`, the second person of every maker-checker pair), a plain member, and the committee head `docHead`
(the system role COMMITTEE_HEAD is granted by the docs stack at start; it holds the approval and the issue of the report engine and reads the committee workspace). They sign
in with the development session of the stack (`?devUser=` in the web app). There are no passwords in the dev stack; the session key (`E2E_SESSION_KEY`) is generated per run and
lives only in your local environment or an untracked file, never in the repository.

## How to run

1. Start the stack in its docs mode (empty tenant), ONE stack at a time, and stop it when you are done (it holds the shared database lane). From the repository root:
   `E2E_SEED=docs E2E_SESSION_KEY=<base64 of 32 random bytes> E2E_API_PORT=<p> E2E_IDP_PORT=<q> E2E_STACK_INFO=<dir>/stack-info.json node scripts/lane.mjs browser -- npm run e2e:stack -w @machvon/api`
   For the enterprise dataset add `MACHVON_EDITION=enterprise DEMO_FORMS=true`.
2. `node scripts/clip-seed.mjs plan --dataset public` prints the plan and its digest (add `--out file` to keep it).
3. `E2E_SESSION_KEY=<same key> node scripts/clip-seed.mjs apply --dataset public --api http://127.0.0.1:<p> --stack-info <dir>/stack-info.json`
   (`--groups a,b` runs some groups; every step asks first and skips what exists, so a second run does nothing twice).
4. `node scripts/clip-seed.mjs verify --dataset public --api http://127.0.0.1:<p> --stack-info <dir>/stack-info.json` exits 1 when a count is short.
5. Stop the stack by creating `<dir>/stack-info.json.stop` (it also removes its temporary database).

## Reset

The data lives in the embedded database of the stack: stop the stack, start it again (a new database), apply again. The same seed gives the same projects, codes, packages and figures;
the dates are relative to the day of the run.

## State of the proof (honest list)

Run on a local stack and verified (earlier in the lane): the portfolio, procurement plans and contractors, the e-GP chapter, the enterprise projects, equity and loan funding,
directives and the accounting reconciliation; the whole phased public run (documents, plans approved, 42 workflows driven at seven clocks, e-GP, Treasury statement, frozen snapshots,
committee roster) ran to the end and the workflow summary showed late, on-hold and not-started packages. Written and reviewed but NOT yet run end to end, because the coordinator took the
stack away: `clip-public-alerts` (the severities depend on the rules firing when the snapshots freeze), `clip-public-contracts`, `clip-public-feed`, `clip-public-directives` on the public dataset,
`clip-ent-reports` (PVN and HPM) and the verify definitions of all of them. Their `verify` checks fail (they do not pass silently) until the data exists.

Findings:

- Product defect fixed: approving a procurement plan puts its packages in `PLANNED`, but sealed proposals and results accepted only `APPROVED`, which no command produces, so no package could be
  tendered or awarded and no contract could follow. `isOpenForBids` now accepts both (`packages/db/src/bid-proposal-store.ts`, used by the result store; test `bid-open-for-bids.test.ts` and a case in `bid-proposal-store.test.ts`).
- The seed of the guide had drifted from the product (the national-programme fund cannot be appropriated directly; the document seed read a route that does not exist and used templates of
  another document type for four documents): fixed in the seeds.
- The committee workspace reads frozen period snapshots (the Treasury statement and the published plan), not feed records; no code feeds `finance_feed_record` into it. The feed is shown through its
  own quality figures, differences and alerts.
- Not done: measurements, payments and advances (late) and the payment forms they need (four published, legally confirmed templates that no seed makes); BI dashboards (the metric bundle is read from the
  object store and no HTTP route stores a JSON file of that purpose, so the registry cannot be synced by a seed).
- The upload and dry-run permissions of the file imports end in "preview", so the roles of the docs stack give them to the leader: the groups upload as the leader and import as the officer.
- API keys of the voice services are local environment variables of the clip tools; this layer never reads or writes them.
