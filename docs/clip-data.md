# Clip data: the seed layer of the two intro clips

The two intro clips (public investment, province of Cao Bang; enterprise edition, PVFCCo style) are recorded on a REAL running product with data made by
the product's own commands: real personas, real maker-checker and approval flows, no SQL into business tables, no mock screens. This layer builds that
data, repeatably. All names and figures are ILLUSTRATIVE demo data, never real customer data. Everything is deterministic from the seed of the dataset.

## Parts

| Part | Where | What |
|---|---|---|
| Datasets | `scripts/fixtures/clip-data/public.json`, `enterprise.json` | Counts, catalogues, the seed and ALL Vietnamese demo text (the code holds English only). |
| Planner | `scripts/clip-seed-lib.mjs` | Pure: dataset + seed give one plan (projects, lines of capital, packages, funding, files). Same seed, same digest. |
| CLI | `scripts/clip-seed.mjs` | `plan`, `apply`, `verify`. |
| Verify | `scripts/clip-seed-verify.mjs`, `clip-seed-client.mjs` | Read-only: reads counts back through the real read operations and fails when something is missing (a figure is never invented). |
| Groups | `apps/web/e2e/hdsd/seed/clip/*.ts` | The seed groups that call the commands; they join the registry of the guide seeds (`apps/web/e2e/hdsd/seed/index.ts`). |
| Tests | `scripts/clip-seed.test.mjs` | The pure parts (planner, verify rules, client). `node --test scripts/clip-seed.test.mjs`. |

## Datasets

Public (`--dataset public`), groups in order: `base`, `capital`, `clip-public-documents`, `clip-public-procurement`.

- Province of Cao Bang: the 8 wards of the guide plus 8 more, 13 projects of the guide plus 32 generated ones: 45 projects over 8 sectors in every stage
  (17 in implementation, 9 budgeted, 4 completed, 2 suspended, 4 in appraisal, 5 in the pipeline, 2 rejected, 2 concept). Funded projects get a national
  code and lines of the annual plan `KHV-2026` drawn on the assignments of capital: central (`NSTW`), local (`NSDP`), the national target programme,
  ODA grant (`SUPPORT`) and ODA on-lending (`ODAV`). The assignments are decided by the leader.
- Procurement: a plan of 14 funded projects, 42 packages, approved by the leader on an issued decision; the package workflow of each package is moved to the
  step the plan names (a spread of steps for the process tree, some on hold, some given back, some not started).
- The seed layer of the guide also makes the contractors (16, with verification by a second person) and, through `field-assurance` and `intelligence`,
  permits, land, quality, issues, audit and the AI board (run them with `--groups` when a chapter needs them).

Enterprise (`--dataset enterprise`, the stack must serve the enterprise edition), groups: `clip-ent-projects`, `clip-ent-funding`, `clip-ent-directives`, `clip-ent-ebs`.

- 6 investment and 6 equipment-purchase projects of the group; the year plan of each split into equity and loan (prepared by the project manager, accepted
  by the leader); the directives of three steering meetings (some overdue); the file of the accounting system imported and reconciled (some figures
  differ on purpose, so the differences have an owner and a result to show).

## Accounts

The people are the seven accounts of the docs stack (`apps/web/e2e/support/docs-people.json`): leader (`capApprover`), unit admin (`unitAdmin`), officer
(`projectManager`), accountant (`treasuryMaker`), auditor (`auditor`), tenant owner (`owner`, the second person of every maker-checker pair) and a plain
member. They sign in with the development session of the stack (`?devUser=` in the web app). Passwords: there are none in the dev stack; the session key
(`E2E_SESSION_KEY`) is generated per run and lives only in your local environment or an untracked file, never in the repository. A committee head account
is a grant of the system role `COMMITTEE_HEAD` to one of these people (`POST /role-grants` as the owner); the groups do not make a new account.

## How to run

1. Start the stack in its docs mode (empty tenant, no business data), one stack at a time. From the repository root:
   `E2E_SEED=docs E2E_SESSION_KEY=<base64 of 32 random bytes> E2E_API_PORT=<p> E2E_IDP_PORT=<q> E2E_STACK_INFO=<dir>/stack-info.json node scripts/lane.mjs browser -- npm run e2e:stack -w @machvon/api`
   For the enterprise dataset add `MACHVON_EDITION=enterprise DEMO_FORMS=true`.
2. `node scripts/clip-seed.mjs plan --dataset public` prints the plan and its digest (add `--out file` to keep it).
3. `E2E_SESSION_KEY=<same key> node scripts/clip-seed.mjs apply --dataset public --api http://127.0.0.1:<p> --stack-info <dir>/stack-info.json`
   (`--groups a,b` runs some groups; every step asks first and skips what exists, so a second run does nothing twice).
4. `node scripts/clip-seed.mjs verify --dataset public --api http://127.0.0.1:<p> --stack-info <dir>/stack-info.json` exits 1 when a count is short.
5. Stop the stack by creating the file `<dir>/stack-info.json.stop` (it also removes its temporary database).

## Reset

The data lives in the embedded database of the stack: stop the stack, start it again (a new database), apply again. The same seed gives the same
projects, codes, packages and figures; only the dates move with the day of the run (they are relative to today).

## Known limits (honest list)

- The product reads the clock of the server and no command accepts a clock override. So no workflow step is late, no payment clock is late; the process
  tree shows ON_TRACK, ON_HOLD and RETURNED substates. Late posting obligations of the e-GP chapter can be made by an old trigger date (an obligation
  opened with a trigger a month ago is overdue at once).
- The decision documents that procurement plans need must be ISSUED outgoing decisions. The group `clip-public-documents` makes the delegation of authority
  matrix and runs the document seed of the guide (`platform-records/doc.ts`) to issue them.
- Not yet seeded by this layer (hooks for the next step): contracts with claims, payments and advances; e-GP import files and obligations; the finance
  feed through the generator into the province committee workspace (the committee workspace reads period snapshots; no code feeds feed records into it);
  alert evaluation; BI dashboards (no HTTP route stores the metric bundle); the PVN forms issued and the HPM push log (the six PVN forms are DEMO forms and
  the issue chain needs three distinct people with report permissions).
- API keys of the voice services are local environment variables of the clip tools; this layer never reads or writes them.
