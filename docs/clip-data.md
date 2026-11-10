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

## First recording round (REC1, 2026-11-08): what ran on a stack

Public edition, one fresh stack: `apply` ran through all 14 phases (about two minutes) and `verify` read back 45 projects in every stage, 19 procurement plans, 60 packages, 40 started workflows (16 late, 2 on hold, 16 not started), 287 process tree nodes, 23 certified metrics, 3 alert rules, the e-GP records (13 plan rows, 8 notices, 19 mappings, 3 overdue obligations), 2 frozen snapshots, the Treasury statement, 1335 feed records, the committee workspace (32 projects, 4 members) and 6 directives (3 overdue). Enterprise edition (`MACHVON_EDITION=enterprise`, web with `VITE_EDITION=enterprise`): `verify` passed all 9 checks (12 projects, 12 equity and 12 loan batches, 6 directives, 32 accounting differences, 6 demo forms, 2 HPM pushes). The shared chapters of the enterprise clip (analytics, alerts, contractors, process tree) read the public groups, so the enterprise stack also had `apply --dataset public`.

Fixed on the first run: a tender whose result is pending was invited after its clarification deadline (`bid.ts`); the measurement of the payment chain named the line id and not its `boq_item_id` (`public-payments.ts`); the joint venture of the advance contract had one member (now lead and runner-up, `public-contracts.ts`).

Documented gaps that remain (`verify` stays red on them): active contracts 3 (below 5), no payment request settled or waiting at the Treasury and no advance (the payment request answers 422 `PARTY_REQUIRED`: the contract has no party yet, so the joint venture members of the advance contract are still to be checked on a stack), the metric dashboards are not published (`POST /bi/publication-requests` answers 403 `SCOPE_DENIED` for the leader of the docs stack), and no early warning is made at the freeze of the snapshots (the alert centre still lists 10 items from the workflow deadlines).

Seed runs keep their step ledgers (`seed-ledger.*.json`, `seed-steps.*.json`) next to the stack-info file: delete them when you start a new stack in the same folder, or the steps are skipped ("1 ms") and the data is missing. Under Git Bash set `MSYS_NO_PATHCONV=1` when you export `VITE_API_BASE_URL=/api`, or the path is rewritten to a Windows path.

## Enterprise data for the shared chapters (REC3, 2026-11-08)

The enterprise clip shares chapters with the public one (leader home, documents and AI, analytics and BI, alerts, contractors, process tree). They used to show the province's data because the enterprise stack was given the public groups. The enterprise dataset now has its own groups, which run the groups of the guide on the enterprise plan: `applyClipPlan` REPLACES the guide's tables (projects, assignments, lines of capital, tenders, contractors) with the ones of the enterprise plan, so no word of the province is written into the product.

Enterprise groups in order: `clip-ent-projects`, `clip-ent-capital` (appraisal to the pipeline, assignments of equity and loan, plan of the year, budgeted and started projects), `clip-ent-funding`, `clip-ent-directives`, `clip-ent-ebs`, `clip-ent-reports` (six demo forms, stamped "MẪU DEMO — chờ mẫu chính thức"), `clip-ent-documents` (delegation matrix, decisions and letters of the office in the words of the enterprise: `platform-records/data/doc.enterprise.json`), `clip-ent-procurement` (16 illustrative contractors, plans of the funded projects), `clip-ent-contracts` (tenders in every state and the contracts taken to ACTIVE), `clip-ent-alerts` (the warning rules `EW-DN-01..03` on the late weekly report, one per level, made by the officer and published by the leader BEFORE the weekly snapshots are frozen: the freeze of `clip-ent-disbursement` evaluates them; the rate rules of the disbursement module do not read the equity/loan plan of the enterprise), `clip-ent-equipment` (the equipment lines of EQP-01 and EQP-02 tied to the equipment packages and contracts above: stages come out as the tenders left them; lines not yet packaged and one dropped from the plan), `clip-ent-workflow` (the package workflows at seven clocks), `clip-ent-bi` (dashboards over certified metrics), `clip-ent-alert-triage` (after the freeze the leader handles the warnings the job opened: a handful stay open at the three levels, the others are dismissed with a reason, one is acknowledged; HOME-03 and HOME-06 show them), `clip-ent-capital-adjust` (last: the plan of the year KHV-2026 gets a second revision, a transfer of 10 billion between two projects on the same assignment, approved and published, so CAP-07 compares revision 2 with revision 1; it runs after the groups above because the packages and snapshots are made on the lines of revision 1). `clip-ent-capital` also registers the monthly estimates and registrations of disbursement of eight funded projects (CAP-12; the schedule keeps the classes of the public pack).

- The plan carries `capital`, `contractors`, `tenders`, `procurement` (process tree packages), `bi` and `texts` (`scripts/fixtures/clip-data/enterprise.json`); texts named `<file>:<key>` replace the key of a table of the guide (`seed/overlay.ts`).
- Equity and loan are the two assignments `VCSH` (fund NSDP-DTPT) and `VAY` (fund ODA-ONLEND): the fund sources of the platform are the national catalogue, so their labels are the catalogue's.
- The stack of the docs seed takes the enterprise brand (theme and unit names) when `MACHVON_EDITION=enterprise` (`serve.stack.ts`).
- Payments, Treasury and e-GP chapters have no enterprise data (they belong to the public edition).
- Own stack, own ports: `E2E_API_PORT`, `E2E_IDP_PORT`, `MACHVON_TEST_LANE=unit` (no shared database lane), web app on its own port with `VITE_EDITION=enterprise`.
