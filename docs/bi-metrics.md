# Metrics as code (ST-BI-001)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/BI.md` (F1). Tables `metric_definition` (extended in V002) and `bi_metric_sync_run`; migration `V1580` (below). Operations: `syncMetricRegistry` (`bi.metric.sync`), `createTenantMetricDefinition` (`bi.metric.manage`), `get_resources_metric_definition` and `_id` (`metric_definition.read`). Screens BI-05 (catalogue), BI-06 (definition), BI-15 (registration from source). Pure rules: `packages/kernel/src/bi-metric.ts`; store: `packages/db/src/bi-metric-store.ts`.

## A metric is data, never SQL

A metric is a small document: `code`, `grain`, `aggregation_type` (`additive`, `semi_additive`, `ratio`, `distinct`), an expression tree, for a ratio a `numerator` and a `denominator`, `unit`, `null_policy`, `dimensions` and `effective_from`. The tree has these nodes only: `field` (a name), `const` (a number), an aggregate (`sum`, `count`, `count_distinct`, `min`, `max`) over one node, and arithmetic (`add`, `sub`, `mul`, `div`) over two. Depth is at most 6 and size at most 40. Anything else, a `raw_sql` node first of all, is `EXPRESSION_NOT_ALLOWED` (a tenant draft) or `METRIC_DEFINITION_INVALID` naming where (a sync). A ratio without a numerator or without a denominator is `RATIO_REQUIRES_NUMERATOR_DENOMINATOR`; a metric of another kind that has either is invalid. The ratio of a group is the **sum of the numerators over the sum of the denominators**, never the mean of the ratios; no row is `NO_DATA`, a denominator of zero is `NOT_APPLICABLE`, and zero is a value only when the metric says `ZERO_IF_NO_ROWS`. A semi-additive metric is its value at the end of the period up to the one asked, from one snapshot (`ratioOfSums`, `periodEndValue`).

## The sync of the platform metrics

The platform writes its metrics in `metrics/*.metric.yaml` (or `.json`). `scripts/bi-metrics-bundle.mjs` (run in `npm run lint` as `bi:metrics:check`, so a bad file fails in the pull request) judges each file with the kernel validator, sorts the metrics by code and writes a JSON bundle `{version: 1, metrics}` with the SHA-256 of its bytes. The pipeline stores the bundle through the file service (purpose `document`, `text/plain`) and calls `syncMetricRegistry {source_commit, bundle_object_key, bundle_sha256}`.

The server reads the bundle (it must be the bytes of that hash, else `BUNDLE_HASH_MISMATCH`), and plans against the latest revision of each platform code:

- a new code is added at revision 1, `CERTIFIED`, with `origin = PLATFORM_CODE`, the commit and the SHA-256 of its canonical definition (platform metrics are certified by the review of the change in the repository: `certified_by` is empty);
- the same definition is left alone; a changed one is the next revision and the one it replaces is `SUPERSEDED` (closed on the day the next takes effect);
- a change of what a number means (grain, unit, kind, expression, numerator, denominator) with `effective_from` not later than the revision in force is `BREAKING_CHANGE_WITHOUT_NEW_CODE`, naming the code, and the whole sync is refused;
- a code in force that is not in the bundle is `RETIRED`; one that comes back is the next revision of it;
- nothing to do is `NO_CHANGE`.

Every sync leaves a run. A refused sync is recorded as `REJECTED` with its code in a transaction of its own (the command rolls back, the refusal is still seen). **The same commit with the same bundle again is the same deploy** (`NO_CHANGE`, nothing read); the bytes of an older bundle from a revert commit are a new deploy and are applied (migration V1580 changes the unique index of the baseline from "a hash applies once" to "a commit and a hash apply once"). Syncs of a tenant are serialized by an advisory lock. The event `bi.metric_registry.synced.v1` and an audit record say what was added, revised and retired.

## The metrics of a tenant

`createTenantMetricDefinition` drafts a revision (`DRAFT`, `origin = TENANT_UI`): the code of a metric of the platform is `PLATFORM_METRIC_READ_ONLY` whoever asks; any other code must start with `t_` (and have something after it); the dataset must exist and be `ACTIVE`; every dimension must be one the dataset offers (`DIMENSION_NOT_IN_DATASET`); a code the tenant drafted before gets the next revision. The registry belongs to the tenant: the sync and the draft are refused to a grant that does not cover the whole tenant. Certification of a draft (data owner other than the author, `decideBiPublication`) is a later story (ST-BI-003).

## The screens

- **BI-05**: every revision with its formula, unit, owner, origin, commit and MDM term; a filter by origin; a link to BI-06; a note that platform metrics are read-only on the screen. Seven states.
- **BI-06**: with `?id=` one revision, read-only (a platform one says so); without it the form that drafts a tenant metric. The formula is an aggregate over a field (a ratio has a numerator and a denominator), so a node outside the grammar cannot be typed; the server judges again and its refusals are worded. Seven states.
- **BI-15**: for each commit that brought platform metrics, what it added and revised, how many are retired and how many in force.

## Assumptions and limits

- `bi_dataset.join_paths.dimensions` (a list of codes, or an object keyed by code) is where a dataset says what dimensions it offers; a dataset that declares none offers none. ST-BI-002 owns that format.
- The glossary term of a platform metric (`glossary_term`) is validated and part of the hash, but not linked (`glossary_term_id` stays empty) until the MDM glossary term can be looked up by code.
- The exclusion of two published revisions of one code over the same days (`metric_definition` in the effective-range registry) is not added: a sync closes the revision it replaces, and BI-003 adds the constraint with the publisher.
- BI-15 has no read of the sync log in the contract: the bundle hash and the error of a run show "no data yet"; the counts are derived from the revisions in the registry.

## Certification of KPI definitions and datasets (G3-1, G0-4)

The registry above certifies the metrics (a publication request decided by someone other than its author). Two more kinds of object now go through the same four words, in `analytics_certification` (migration V1810, append-only): the definitions of the KPI register (`KPI_DEFINITION` rules of the governance store; the key is the code and the version is the version of the rule) and the BI datasets (the key is the dataset id and the version is the version of its definition). Nháp (`DRAFT`) to Đã xác nhận (`CONFIRMED`, one person) to Đã chứng nhận (`CERTIFIED`, another person: `SELF_APPROVAL_DENIED`, also a CHECK of the table) to Lỗi thời (`OBSOLETE`); sending back to Nháp and making obsolete need words; a step cannot be skipped (`STAGE_TRANSITION_DENIED`); only the version in force is certified. The built-in default of a definition (version 0) is certified by the review of the repository and is not moved here. `listAnalyticsCertifications` (BI-19) reads the three kinds side by side and maps the registry status of a metric to the four words (`IN_REVIEW` is Đã xác nhận, `SUPERSEDED` and `RETIRED` are Lỗi thời) without certifying a metric a second time. The command center and the dashboards of the leader give a leader only a figure whose definition is certified; the others carry a flag, and a figure with no data is never 0. Spec: `Design/MACHVON_Design/01_Documents/05_modules/BI.md` (F8, F9) and `HOME.md` (F7 to F9).

## The bundle given inline (clip data, demo tenants)

`syncMetricRegistry` takes the bundle in one of two ways, exactly one: `bundle_object_key` with `bundle_sha256` (the pipeline of the repository stores the file first), or `bundle`, the document itself (`{version: 1, metrics: [...]}`, the document `scripts/bi-metrics-bundle.mjs` builds). With `bundle` the server keeps the canonical bytes of the document, computes the hash itself and names the run by `inline:<sha256>`, so the same document again is the same deploy (NO_CHANGE). Giving both, neither, or one half of the stored way is 422 `VALIDATION_FAILED` (detail `bundle`, `bundle_object_key` or `bundle_sha256`). The permission and the whole-tenant rule are unchanged. No operation was added.
