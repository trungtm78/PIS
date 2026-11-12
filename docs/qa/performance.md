# Performance budget of the customer

The customer asks that every function answers in under 5 seconds and every report in under 20 seconds. The budget is a table, `docs/qa/perf-budget.json`, and two ways to check it. Both read the same table, so there is one place to change a budget or to add an operation.

## The table

- `classes`: `FUNCTION` 5000 ms (a hot read of a screen: lists, boards, counters, the home page) and `REPORT` 20000 ms (a report or an export file, measured until the whole body is received).
- `defaults`: 20 samples after 2 warm-up requests; the measured figure is the 95th percentile (`p95`); `p50` and `max` are reported as well.
- `variables`: the ids a run needs from the tenant it measures (a project, an ISO week, a report draft, an issued report, an export, a monitoring report, an evaluation report). An operation whose variable is not given is not measured (`SKIPPED`), and with `--strict` that is a failure.
- `discovery`: for the variables that a list of the API can give (`projectId`, `allocationLineId`, `reportDraftId`, `reportIssueId`), the list to read (`path`, `query`) and the place of the id in its answer (`pick`, for example `items.0.id`); `--discover` uses it. An id that no list serves (a finished report export, a monitoring and evaluation report, an evaluation report of a package: they exist only after the tenant made them) is given by `--vars`, and the operation is `SKIPPED` with its name until then.
- `operations`: one line each: `id` (`PB-F...` function, `PB-R...` report), the `operationId`, method (reads only), path and permission of the contract, the `class`, the `area`, optional `query` (a value `$name` is a variable), `pathVars` (path parameter to variable) and `pathFixed` (a fixed path value).

The tests keep the table honest: every operation must exist in `Design/MACHVON_Design/03_Engineering/openapi.json` with the same method, path and permission, every required parameter must have a value, and every `export*` read of the contract must be in the table as a report. When an operation is added to the contract and is hot, add a line.

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

## Measured rows of the enterprise edition (INT-2)

The rows `PB-R016` (`getEnterpriseSnapshot`, the frozen enterprise period snapshot with every ratio, by class, unit and project, `REPORT`), `PB-R017` (`getReportCrosscheck`, the cross comparison of the reports of a month, `REPORT`), `PB-F068` (`getReportingCalendar`, the table of the periods and their step deadlines) and `PB-F069` (`getReportingCalendarBoard`, the status board by input point) were added with the enterprise edition; the issued PDF of a form is `PB-R008` (`format=PDF`). They were measured on 2026-11-12 against the enterprise demo stack (`npm run demo:enterprise`: API in the enterprise edition, embedded PostgreSQL, sample data of Đạm Phú Mỹ with a frozen snapshot of 2026-05: 12 projects, 496 figures, a 116 KB answer), one request after the other, 20 samples after 2 warm-up requests, on a laptop (Intel Core i7-13620H, 16 threads, 16 GB, Windows 11), with `node scripts/perf-budget.mjs --discover --var periodYear=2026 --var periodMonth=5`:

| Row | p50 | p95 | max | Budget |
|---|---|---|---|---|
| PB-F068 getReportingCalendar | 31.1 ms | 34.8 ms | 35.1 ms | 5000 ms |
| PB-F069 getReportingCalendarBoard | 16.7 ms | 31.5 ms | 31.9 ms | 5000 ms |
| PB-R008 getReportIssueFile (PDF) | 15.6 ms | 23.6 ms | 27.7 ms | 20000 ms |
| PB-R016 getEnterpriseSnapshot | 50.5 ms | 100.4 ms | 136 ms | 20000 ms |
| PB-R017 getReportCrosscheck (person of the drafting office) | 37.1 ms | 55.1 ms | 101 ms | 20000 ms |

These are measurements of the table and the code on a small sample tenant, not an acceptance result: the volume of the customer (about 31 projects, three classes, two measures, twelve months of figures) is larger and the run that counts is the one on the customer servers (PX-10). The new variables are `enterpriseSnapshotId` and `enterprisePeriodId` (found by `--discover` from the list of the frozen snapshots), `periodYear` and `periodMonth` (given with `--var`).

## What a run does not prove

The budget is a contract about the customer hardware and data volume. A green run on a laptop with an empty tenant says only that the table and the runner work. The run that counts is the one on the customer servers with the data of the customer, and its `--out` file is the evidence for the acceptance record.
