# Performance budget of the customer

The customer asks that every function answers in under 5 seconds and every report in under 20 seconds. The budget is a table, `docs/qa/perf-budget.json`, and two ways to check it. Both read the same table, so there is one place to change a budget or to add an operation.

## The table

- `classes`: `FUNCTION` 5000 ms (a hot read of a screen: lists, boards, counters, the home page) and `REPORT` 20000 ms (a report or an export file, measured until the whole body is received).
- `defaults`: 20 samples after 2 warm-up requests; the measured figure is the 95th percentile (`p95`); `p50` and `max` are reported as well.
- `variables`: the ids a run needs from the tenant it measures (a project, an ISO week, a report draft, an issued report, an export, a monitoring report, an evaluation report). An operation whose variable is not given is not measured (`SKIPPED`), and with `--strict` that is a failure.
- `discovery`: for the variables that a list of the API can give (`projectId`, `allocationLineId`, `reportDraftId`, `reportIssueId`), the list to read (`path`, `query`) and the place of the id in its answer (`pick`, for example `items.0.id`); `--discover` uses it. An id that no list serves (a finished report export, a monitoring and evaluation report, an evaluation report of a package: they exist only after the tenant made them) is given by `--vars`, and the operation is `SKIPPED` with its name until then.
- `operations`: one line each: `id` (`PB-F...` function, `PB-R...` report), the `operationId`, method (reads only), path and permission of the contract, the `class`, the `area`, optional `query` (a value `$name` is a variable), `pathVars` (path parameter to variable) and `pathFixed` (a fixed path value). Three optional fields: `budgetMs` holds the row to a budget tighter than its class (never looser: the table is refused otherwise; the runner, the list, the k6 thresholds and the timeout of a request all use it), `scale` says how many times the volume of the demo of PVFCCo (22 projects, 9 owner units) the row must be measured at, and `edition` (`PUBLIC` or `ENTERPRISE`) says which edition serves it.

The tests keep the table honest: every operation must exist in `Design/MACHVON_Design/03_Engineering/openapi.json` with the same method, path and permission, every required parameter must have a value, and every `export*` read of the contract must be in the table as a report. When an operation is added to the contract and is hot, add a line.

## The rows of the enterprise edition and of the report PDF (HT.05)

- `PB-F068` `getEnterpriseSnapshot` and `PB-F069` `getLeaderRates`: the read of the frozen enterprise period snapshot (the figures by project and unit) and the leadership rates built from it (company, unit, project, same day last year). `budgetMs` 800, `scale` 20, edition `ENTERPRISE`: p95 of at most 800 ms on a tenant 20 times the demo (440 projects, 180 units). They need the variable `enterpriseSnapshotId`, found by `--discover` as the newest FROZEN snapshot (`GET /enterprise-snapshots?status=FROZEN&limit=1`); a tenant of the public edition has none and the rows are `SKIPPED` (a failure under `--strict`).
- `PB-R008` `getReportIssueFile` with the format `PDF`: the issued copy of a report form as the PDF made from the same document as the Excel and Word files (ENT-4b), in the class `REPORT`: 20 seconds, measured until the whole body is received.
- The code of ours inside the 800 ms is checked in every test run by `packages/edition-enterprise/src/leader/rates-scale.test.ts`: it builds a frozen snapshot of 440 projects in 180 units with a plan and ten months of actuals, and reads it through the one reader (cuts and comparison with last year) 20 times; p95 must stay at or under 800 ms (about 80 ms on a laptop for two snapshots). The SQL read of the frozen rows is the part only a real tenant measures: seed the tenant at 20 times the demo, freeze a snapshot, and run `node scripts/perf-budget.mjs --discover --only FND,PB-F069 --strict --out evidence.json`.

## Run it with Node (no k6)

```
node scripts/perf-budget.mjs --base-url https://host/v1 --token "$TOKEN" --vars vars.json
node scripts/perf-budget.mjs --base-url https://host/v1 --token "$TOKEN" --vars vars.json --only REPORT --samples 10 --out report.json
node scripts/perf-budget.mjs --list                 # the table without calling anything
```

`--discover` finds the ids that `--vars` and `--var` did not give by reading the first row of the lists named in `discovery` (nothing is written to the tenant; what it could not find is said, and the operation stays `SKIPPED`); `--vars-out file.json` keeps the variables used, to hand to k6 as `VARS`. `vars.json` holds the variables, for example `{"projectId":"...","isoWeek":"2026-W42"}`; `--var name=value` adds or overrides one. The token can also be given in `PERF_TOKEN`. `--only` takes ids, operation names, areas or classes. `--header "Name: value"` adds a header. `--stat max` judges the slowest sample instead of p95.

Exit codes: 0 every measured operation is within budget; 1 one is over its budget or had a failed sample (a 4xx, a 5xx, a timeout; a request is aborted after twice its budget); 2 wrong usage or an invalid table; 3 `--strict` and something could not be measured. Requests go one after the other, so the figures are those of one user; the token is never written to the output or to `--out`.

For an acceptance run: a tenant seeded with realistic volumes, a token of a person who holds the permissions of the table, the runner on a machine in the same network as the users, `--strict`, and the `--out` file kept as evidence.

## Run it with k6 (for those who have k6; not run in CI)

```
k6 run -e BASE_URL=https://host/v1 -e TOKEN="$TOKEN" -e VARS="$(cat vars.json)" tests/k6/budget.js
k6 run -e BASE_URL=https://host/v1 -e TOKEN="$TOKEN" -e VARS="$(cat vars.json)" -e VUS=50 -e DURATION=10m tests/k6/load.js
```

`tests/k6/budget.js` is the single user run of the table (`SAMPLES` per operation, default 20); `tests/k6/load.js` is a random mix of the operations for `VUS` users with think time. Both set a threshold per class and per operation (`p(95)` under the budget of the class) and a failure rate under 1 percent, so k6 exits non-zero when the budget is exceeded. `ONLY` filters like `--only`. `tests/k6/budget-lib.js` builds the requests; a node test checks that it builds the same URLs as the node runner.

## What a run does not prove

The budget is a contract about the customer hardware and data volume. A green run on a laptop with an empty tenant says only that the table and the runner work. The run that counts is the one on the customer servers with the data of the customer, and its `--out` file is the evidence for the acceptance record.
