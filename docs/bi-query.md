# Queries and drill (ST-BI-004)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/BI.md` (F3, F4, BR-BI-02..07). Tables `drill_context` and `bi_query_run` (baseline, V002). Operations: `post_dashboard_queries` (`bi.query`), `explainBiMetric` (`GET /bi/drill`), `refreshBiQueryContext`, and the reads `get_resources_drill_context` and `_id` (a person's own contexts). Screens BI-02 (the board of certified metrics) and BI-09 (the analysis workbench). Pure rules: `packages/kernel/src/bi-query.ts`; store: `packages/db/src/bi-query-store.ts`; controller: `apps/api/src/modules/bi/query.controller.ts`.

## What a query reads

A query is **one certified metric** over **one snapshot of BI** (the `snapshot_id` of the API is the id of the dataset version of a period, ST-BI-002; the lines it reads are those of the DIS close snapshot the version was made from), cut by **at most one dimension** (`unit`, `fund_source`, `project`, `budget_level`, `bucket`), narrowed by filters (`eq`, `in`, `gte`, `lte` on those dimensions). The server writes the SQL from allowlists: the fields a metric may read map to columns of a snapshot line (`DISBURSEMENT_FIELDS`), the dimensions map to columns (`DISBURSEMENT_DIMENSIONS`), the values are parameters. A body that carries a field the contract does not name (`sql`) is `400 FIELD_NOT_ALLOWED`; a dimension or a filter field the dataset does not offer (or a policy hides from the reader) is `422 DIMENSION_NOT_IN_DATASET`.

- **Additive / semi-additive** (within one snapshot): the sum of one field. **Ratio**: the sum of the numerator column over the sum of the denominator column, **never the mean of the ratios** (10.5 over 30 billion is 35.00%). **Distinct**: the count of distinct values of a field.
- **A figure that cannot be given is null with its reason**: `NO_DATA` (no line, or no line had a figure) or `NOT_APPLICABLE` (denominator of zero). Never 0 — except that a metric whose null policy is `ZERO_IF_NO_ROWS` is zero for a group with no line at all.
- **Unclassified**: a line with no value in the dimension is a group of its own (key null), so that the children add up to the parent. The groups of one query carry a token each (the first 100), except that one.
- **Reconciliation**: the server says whether the children add up (`reconciles_to_parent`) and, when not, why: for a distinct count one thing in two groups is counted in each and once in the total (`DISTINCT_NOT_ADDITIVE`); a ratio reconciles through the sums of its numerators and denominators.
- **Labels on every answer**: `as_of_period`, `snapshot_id`, `quality_badge` (with `feeds_certified` and the quarantined rows left out), `served_from_cache` and `built_at`, the scope (`YOUR_SCOPE` when the reader does not read the whole tenant: the units they may not read are absent, and the answer says so), and `new_data_available` with `newer_snapshot_id` when a newer version of the period is frozen (the figures stay on the snapshot asked).

## Closed by default, scope, policy

Before anything is read, `BiPolicyStore.applicable` is asked for the reader (their roles, their unit and the units above it, themselves): **no active policy is `403 ACCESS_POLICY_MISSING`**, never an empty answer, and the refusal is a record (a `bi.query_denied` audit; the answer is the refusal for the same idempotency key). The predicates of the policies are compiled to conditions on the lines (OR between policies, AND with the scope), a column a policy hides or masks is not a dimension for the reader. The scope itself is the projects the reader may read under `bi.query`, applied to every line.

## The drill and its token (BR-BI-06)

Every group carries a token for the way down: `base64url(claims).base64url(HMAC-SHA256)`, claims `{v, tid, ctx_id, scope_hash, metric_version_id, snapshot_id, as_of_period, iat, exp, kid}` (ids only, 30 minutes), signed with a key made for the tenant from the key of the application and the key id. The context it names (`drill_context`: the filters of the path, the dimensions gone through, the parent) is kept by the server. `explainBiMetric(drill_token, child_dimension)`:

- a token that was altered, signed for another tenant or key, or is not one, one of **another member**, or one whose context is gone is **`400 DRILL_TOKEN_INVALID`** (nothing is said of what exists) and is recorded `DENIED` (`bi.drill_denied`);
- a good token that is old is **`409 SNAPSHOT_EXPIRED`** naming the snapshot to ask again for;
- the snapshot of the path is kept; the right to read is judged again **as it is now**: a unit the path names that the reader no longer reads is **`403 SCOPE_DENIED` naming nothing** (recorded), while the retained unit answers `200` on the same snapshot with `scope_changed`;
- a dimension already on the path is refused (`422`).
- `limit` cuts the children returned (and `truncated` says so; the reconciliation is judged on the whole). A query that continues a context (`context_token`) is judged by the same scope rule: a unit of the path the reader no longer reads is `403 SCOPE_DENIED`, never an empty figure.

`refreshBiQueryContext` makes a new context on the newest frozen version of the period, the old one as `parent_context_id`; the old token goes on serving the old snapshot until it expires. Every query and drill writes a `bi_query_run` (period, scope hash, cache, duration, rows).

## The cache (BR-BI-07)

An answer is cached in the process for five minutes under `t:{tenant}:bi:{metric_versions}:{filters_hash}:{snapshot_id}:{scope_hash}`: nobody whose tenant, snapshot, query or scope differs shares an entry (the policies are part of the hash of the query).

## The screens

- **BI-02**: for the period chosen (a frozen version), a tile for each certified metric with its figure and the labels above, and a link to BI-09 on the same metric and snapshot; a tile that cannot be given says why. Dashboards a person builds come with the dashboard builder (R2).
- **BI-09**: metric, snapshot and dimension; the table of groups with its total, the numerator and denominator of a ratio, the banner for newer data (a click renews the context and asks again on the newest snapshot), the "sum of children = parent ✔" or why not, and the drill with a breadcrumb that goes back up. Refusals are worded (a policy that does not open the dataset, a revoked scope, a token that is gone or old, with a renew button where it helps).
- Both have the seven states.

## Assumptions and limits

- **Not done**: the asynchronous job (`202`) above a cost threshold and the per-tenant rate limit (`429`) are not built: a query runs synchronously and a result is cut at 500 groups (`truncated`). `cursor` of the contract is accepted and not used.
- **Permissions of the screens**: BI-02 and BI-09 list the certified metrics (`get_resources_metric_definition`, permission `metric_definition.read`) and the datasets and versions beside the query itself (`bi.query`). A role that is to use them carries both; a reader with `bi.query` alone sees the screen's "no access" state, never a half-working one. A catalogue read under `bi.query` would be a new operation of the contract and is left to the permission matrix of the roles (ST-IAM).
- **The key of the drill tokens** is made from the configured secret of the application (`OUTBOX_SIGNING_KEY`, given to the module as `biDrillSecret`; the key itself is an HMAC of it, so the secret is never the key): every replica and every restart reads the tokens of the others. Without a configured secret (tests, one process) a key is made for the life of the process.
- A token that is not the reader's own on a **command** (`context_token` of a query, `drill_token` of a refresh) is a recorded refusal (`bi.query_denied`, `bi.drill_refresh_denied`) with the same 400, as it is on the drill.
- The cache is in the process of the server (a restart empties it); a shared cache with invalidation on a revocation is for the platform's cache service. Revocation still takes effect at once because the scope hash and the access are read again on every request.
- `DrillQuery` has no `as_of_period`: the period is the one of the version named. `context_token` continues a context of the reader (its filters and snapshot are kept).
- Only the dataset `DS-DISB` is queryable; the other source kinds wait for their sources.
- A dataset version whose badge is `FAILED` or `STALE` is served with `feeds_certified: false`; the rows DGV quarantined are counted (an upper bound) but cannot be left out of the sums because DGV does not keep which rows they are.
