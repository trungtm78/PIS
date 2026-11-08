# Clip data: the seed layer of the two intro clips

The two intro clips (public investment, province of Cao Bang; enterprise edition, PVFCCo style) are recorded on a REAL running product with data made by the product's own commands: real personas, real
maker-checker and approval flows, no SQL into business tables, no mock screens. This layer builds that data, repeatably. All names and figures are ILLUSTRATIVE demo data, never real customer data.
Everything is deterministic from the seed of the dataset. The clips are in Vietnamese only: every word the groups write into the product comes from the fixtures (`scripts/fixtures/clip-data/*.json`), the code holds keys.

## Parts

| Part | Where | What |
|---|---|---|
| Datasets | `scripts/fixtures/clip-data/public.json`, `enterprise.json` | Counts, catalogues, the seed and ALL Vietnamese demo text (`texts` is read by the groups with `clipText(key)`). |
| Planner | `scripts/clip-seed-lib.mjs` | Pure: dataset + seed give one plan (projects, lines of capital, packages with their workflow step and clock, funding, files, rules, meetings, dashboards). Same seed, same digest. Also the phases of an apply. |
| CLI | `scripts/clip-seed.mjs` | `plan`, `apply`, `verify`. |
| Verify | `scripts/clip-seed-verify.mjs`, `clip-seed-client.mjs` | Read-only: reads counts back through the real read operations and fails when something is missing (a figure is never invented, a verdict over no check fails). One block of checks for each part. |
| Groups | `apps/web/e2e/hdsd/seed/clip/*.ts` | The seed groups that call the commands; they join the registry of the guide seeds (`apps/web/e2e/hdsd/seed/index.ts`). |
| Stack clock | `apps/api/test/e2e-stack/serve.stack.ts` | `GET/POST /__e2e/clock {offset_days}` (and `E2E_CLOCK_OFFSET_DAYS`): only `Date` is shifted. |
| Phone conflict | `scripts/hdsd/mobile-data.mjs` command `conflict` | Makes a real diary conflict through the commands (see below). |
| Tests | `scripts/clip-seed.test.mjs`, `apps/web/e2e/hdsd/seed/clip/clip.test.ts`, `scripts/hdsd/mobile-data.test.mjs` | The pure parts. `node --test scripts/clip-seed.test.mjs scripts/hdsd/mobile-data.test.mjs`; from `apps/web`: `node --test e2e/hdsd/seed/clip/clip.test.ts`. |

## Product changes made for the clip data

1. **Demo templates of the Treasury payment forms** (`apps/api/src/modules/doc/payment-forms-demo.json`, `loadTemplatePack(directory, { demoForms })`, `DEMO_FORMS=true`): four published templates (03.a/TT, 04.a/TT, 04.b/TT, 05.a/TT), stamped as demo, so
   a payment request can have its forms drawn and be sent to the Treasury; see `docs/pay-treasury-forms.md`. The ordinary pack (25 templates) is unchanged.
2. **The metric bundle can be given inline** to `syncMetricRegistry` (`bundle`), so a tenant without a file pipeline can sync the registry and have dashboards; see `docs/bi-metrics.md`. No operation was added; the schema `BiMetricSync` changed through `contract-patch`.
3. **The committee workspace stands on the feed where no frozen snapshot exists** (`SnapshotOrFeedFactsReader`, `FeedProvinceFactsReader`, kernel `feedFactsToProvinceFacts`); see `docs/committee-workspace.md`.
4. **Package states**: sealed proposals and results accepted only `APPROVED`, which no command gives; a package of an approved plan is `PLANNED`. `isOpenForBids` accepts both (this unblocks tenders, awards and contracts).
5. **The `conflict` data command of the phone chapter** (MOB-42) no longer throws: it makes a real diary conflict (below).
6. **Stack**: the clock, and `MACHVON_EDITION=enterprise` serves the enterprise edition.

## The clock and the phases

The product reads `new Date()` and no command takes a date of "now". So the stack has a shiftable clock and `apply` runs in PHASES (`DATASET_PHASES`): the clock is set (`clockDays` from the real day), the groups of the phase run, and the clock is always brought back to the real day at the end.
Public: `base`, `capital` at -80 days (the annual plan is published in the past, so the snapshots of the closed months find a plan in force); documents, procurement plans and contracts at the real day; the payments SENT at -40 days (the payment clock and the recovery of the advance then run
out); the package workflows at seven clocks (-70 ... -1 days, each package has its own, so the process tree shows late steps beside the ones on time, on hold and given back); the first payment CLOSED by the Treasury on the real day; then alerts, e-GP, disbursement, feed, BI, directives and the committee at the real day.
The seed client reads the day from the stack (`SeedContext.syncClock`). What the database stamps by itself (`created_at`) stays real.

## Datasets

Public groups in order: `base`, `capital`, `clip-public-documents`, `clip-public-procurement`, `clip-public-contracts`, `clip-public-payments`, `clip-public-workflow`, `clip-public-alerts`, `clip-public-egp`, `clip-public-disbursement`, `clip-public-feed`, `clip-public-bi`, `clip-public-directives`, `clip-public-committee`.
Enterprise groups: `clip-ent-projects`, `clip-ent-funding`, `clip-ent-directives`, `clip-ent-ebs`, `clip-ent-reports`.

- Province of Cao Bang: 16 wards, 45 projects over 8 sectors in every stage, funded from central, local, national-programme and ODA sources.
- Documents and procurement: the delegation-of-authority matrix and the document seed issue the decisions; 14 plans, 42 packages, workflows at many steps; 16 contractors.
- Contracts: the tenders of the five projects of the guide, then the contract of each awarded package to ACTIVE (bill of quantities, guarantee verified by a second person, review, signature, activation); a claim and a periodic evaluation.
- Payments: a measurement approved by the leader, an acceptance approved by a second person, a payment request checked by the accountant with the four demo forms, sent to the Treasury; one confirmed and matched (settled), one left waiting (its clock runs out), and an advance paid long ago (over its recovery deadline).
- Alerts: early-warning rules published before the snapshots are frozen; the warnings are made by the platform when a snapshot is frozen. Nothing is inserted into an alert table.
- e-GP, Treasury statement, frozen snapshots, finance feed, committee roster, directives (some overdue), BI (the metric bundle of the repository synced inline, two dashboards published by the leader).
- Enterprise: 6 investment and 6 equipment-purchase projects; equity and loan year plans; directives; the accounting file imported and reconciled; the PVN and HPM demo forms issued by three people, and the HPM push log.

## The phone conflict (MOB-42)

`node scripts/hdsd/mobile-data.mjs conflict` (needs `E2E_STACK_INFO` and `E2E_SESSION_KEY`, and an active contract, so the public data first): as the officer it saves a site diary of a free working day, revises it (version 2), then saves the same day again from "a device" that last saw version 1; the server
answers 409 `DIARY_SYNC_CONFLICT` and keeps the second copy as a conflict diary, which the phone lists and the person resolves (keep the main copy, adopt the other, or merge). The step `mob-42` in `verification.json` is no longer marked blocked; it becomes VERIFIED when a walk of the phone passes it.

## Accounts

The people are the accounts of the docs stack (`apps/web/e2e/support/docs-people.json`): leader (`capApprover`), unit admin (`unitAdmin`), officer (`projectManager`), accountant (`treasuryMaker`), auditor (`auditor`), tenant owner (`owner`, the second person of every maker-checker pair), a plain member, and the
committee head `docHead` (the docs stack grants the system role COMMITTEE_HEAD at start; it approves and issues the report engine forms and reads the committee workspace). They sign in with the development session of the stack (`?devUser=`). There are no passwords in the dev stack; the session key (`E2E_SESSION_KEY`) is generated per run and
lives only in your local environment or an untracked file, never in the repository.

## What a stack window must run (exact commands)

Work from `D:\PIS-clipdata2` (branch `lane/clipdata2`). ONE stack at a time; stop it when done (it holds the shared database lane).

```
# 0. choose a folder outside the repository for the stack files, and a key
export CLIP=D:/tmp/clipstack; mkdir -p $CLIP
export E2E_SESSION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export E2E_SEED=docs E2E_API_PORT=47311 E2E_IDP_PORT=47312 E2E_STACK_INFO=$CLIP/stack-info.json DEMO_FORMS=true

# 1. PUBLIC: start the stack (background; wait until $CLIP/stack-info.json exists)
node apps/web/e2e/support/clean-orphans.ts
node scripts/lane.mjs browser -- npm run e2e:stack -w @machvon/api
# 2. apply and verify (about 5 to 8 minutes: 14 phases)
node scripts/clip-seed.mjs apply  --dataset public --api http://127.0.0.1:47311 --stack-info $CLIP/stack-info.json
node scripts/clip-seed.mjs verify --dataset public --api http://127.0.0.1:47311 --stack-info $CLIP/stack-info.json
# 3. the diary conflict of the phone chapter (after the public data)
node scripts/hdsd/mobile-data.mjs conflict
# 4. stop the stack
touch $CLIP/stack-info.json.stop

# 5. ENTERPRISE: a new stack with the edition (same variables, plus):
export MACHVON_EDITION=enterprise
node scripts/lane.mjs browser -- npm run e2e:stack -w @machvon/api
node scripts/clip-seed.mjs apply  --dataset enterprise --api http://127.0.0.1:47311 --stack-info $CLIP/stack-info.json
node scripts/clip-seed.mjs verify --dataset enterprise --api http://127.0.0.1:47311 --stack-info $CLIP/stack-info.json
touch $CLIP/stack-info.json.stop
```

Tests that need the database lane (not a stack; one run at a time through `lane.mjs db`), written in this branch and NOT yet run:

```
cd packages/db && node ../../scripts/lane.mjs db -- node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --testPathPatterns "finance-feed-store|bid-proposal-store|bid-result-store|bid-open-for-bids" --forceExit --coverage=false
cd apps/api    && node ../../scripts/lane.mjs db -- node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --testPathPatterns "bi-metrics|metric-bundle-source|template-pack|committee" --forceExit --coverage=false
```

## Reset

Stop the stack and start it again (a new database), then apply again. The same seed gives the same projects, codes, packages and figures; the dates are relative to the day of the run.

## State of the proof (honest list)

Run on a local stack in earlier windows and verified: the portfolio, procurement plans and contractors, the e-GP chapter, the Treasury statement and frozen snapshots, the committee roster, the clock and the phases up to the workflow (late, on hold and not started packages showed in the summary), the enterprise projects, equity and loan
funding, directives and the accounting reconciliation. Written, unit-tested for their pure parts, reviewed, but NOT yet run on a stack: alerts, contracts, payments and advances, the feed, BI, the public directives, the PVN and HPM group, the conflict command, and the base/capital phases at -80 days (the fixed dates of the guide seeds were moved
earlier for it). Their `verify` checks fail (they never pass silently) until the data exists. Expect some first-run fixes in the payment chain (the cheat sheet of the request bodies was read from the code, not run).

Known limits:

- The payment forms are DEMO forms: the layouts of the Treasury are not known (R18); they are never an official acceptance.
- The committee workspace shows the official snapshot when there is one; the feed is its fallback and does not state the year before, the estimate at completion, the delay or the stalled step.
- The upload and dry-run permissions of the file imports end in "preview", so the roles of the docs stack give them to the leader: the groups upload as the leader and import as the officer.
- The phone half of the conflict (an offline write queued on the device) is made by the product itself when the phone syncs; the data command makes the server half the product would make.
- API keys of the voice services are local environment variables of the clip tools; this layer never reads or writes them.
