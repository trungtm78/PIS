# BI publication approval (ST-BI-006)

BI 3 F5: a metric is certified, a version of a dashboard is published and an access policy is made active only on the decision of someone other than who asked, after checks that are made when the request is asked and made again when it is decided.

## The request

`POST /bi/publication-requests` (`submitBiPublication`, `bi.publish.request`) asks for one object: `object_kind` is `METRIC` (a metric a tenant drafted), `DASHBOARD` (the id of a **version** of a dashboard, a draft) or `ACCESS_POLICY` (a draft policy). A metric and a policy are the tenant's, so the request needs the right over the whole tenant; a version of a dashboard is asked for by the owner of the dashboard (someone else's is 404). One request is pending for an object at a time (`PUBLICATION_ALREADY_PENDING`, also the unique index of V002).

The checks run first and are written on the request (`checks_json`), so BI-11 shows what the request was made with:

| Object | Check | Meaning |
|---|---|---|
| METRIC | `FORMULA_COMPUTABLE` | the definition reads fields of the dataset and builds a measure plan |
| METRIC | `FROZEN_VERSION_EXISTS` | the dataset has a frozen version (the latest one by build time) over a snapshot to rerun on |
| METRIC | `ROWS_MATCH_SNAPSHOT` | the lines the rerun finds are as many as the rows the snapshot stored (`period_snapshot.row_count`) |
| METRIC | `GROUPS_ADD_UP` | for each dimension of the metric, the groups add up to the whole (the sum of the numerators, and of the denominators of a ratio); a distinct count is not added, only its rows are compared |
| DASHBOARD | `METRICS_CERTIFIED` | every metric of the version is certified now (`METRIC_NOT_CERTIFIED`, 422) |
| DASHBOARD | `DATASET_VERSIONS_FROZEN` | every pinned version of a dataset is frozen (`DATASET_VERSION_NOT_FROZEN`, 422) |
| ACCESS_POLICY | `POLICY_IS_DRAFT`, `DATASET_ACTIVE` | the policy is a draft over a dataset that is open |

A metric whose rerun fails any of its checks is `REPRODUCIBILITY_CHECK_FAILED` (422) with the name of the check in `detail` and all four in `extensions.checks`; no request is made (AC-ST-BI-006-2, UAT-AC471). An object that is not in the state the request needs (a certified metric, a published version, an active policy) is 409 `STAGE_TRANSITION_DENIED`.

## The decision

`POST /bi/publication-requests/{id}/decision` (`decideBiPublication`, `bi.publish`, `If-Match` the version of the request, over the whole tenant). The one who asked cannot decide (`SELF_APPROVAL_DENIED`, 403, also `bi_publication_request_sod_chk`); a request that is decided is 409 `STAGE_TRANSITION_DENIED`; a stale `If-Match` is 409 `VERSION_CONFLICT`.

- `APPROVED` runs the checks again (the data may have changed since the request) and then does what was asked: a metric becomes `CERTIFIED` with who certified it and when, and the revision of the same code that was certified is superseded and closed on the day the new one takes effect; a version of a dashboard becomes `PUBLISHED` with who published it and when, the version that was published is `SUPERSEDED` (whole, as it was), and the dashboard is `PUBLISHED` and points to it; a policy becomes `ACTIVE` and the one it replaces `RETIRED`. The author of the metric, of the version or of the policy cannot be the approver either (`SELF_APPROVAL_DENIED`).
- `REJECTED` needs a `comment` (422 `VALIDATION_FAILED`, `comment`) and changes nothing else; the object stays a draft and may be asked for again.

Audit: `bi.publication.request`, `bi.publication.decide` (the decision, the codes of the checks, the reason), `bi.metric.certify`, `bi.dashboard.publish`, `bi.policy.activate`. Events: `bi.publication.requested.v1`, `bi.publication.decided.v1`, `bi.dashboard.published.v1`, `bi.policy.activated.v1`.

`POST /dashboards/{id}/publish` (`post_dashboards_id_publish`, `bi.publish`, `If-Match` the version of the dashboard) is the baseline approval of the layout under the decision: `approve` publishes the version the dashboard points to by the same checks and the same four-eyes rule, and decides the request pending for it in the same act (none is left behind); `return` and `reject` need that pending request and reject it with the reason.

`GET /bi/publication-requests` (`listBiPublicationRequests`, `bi.publish`) is the inbox: newest first, by `status` and `object_kind`, with the code and revision of the object, who asked and decided, and the checks.

## In the database (V1582, V1583)

- `bi_publication_request`: a state check (PENDING has no decision, DECIDED has the decision, who decided and when), a reason check (a rejection has a comment), `guard_bi_publication_request` (what is asked, who asked and the checks never change; PENDING moves to DECIDED or WITHDRAWN only; the decision is written once; nothing is deleted); `DELETE` and `TRUNCATE` are revoked.
- `metric_definition`: `guard_metric_definition` (code, revision and origin fixed; a metric that left DRAFT keeps its definition, 409 `VERSION_IMMUTABLE` at the application and 42501 here; the states only move forward; who certified is written once), a certified-by check for the metrics of a tenant, `DELETE` and `TRUNCATE` revoked.
- V1583 holds the `SET NOT NULL` of V1581 on its own, as the expand-then-contract policy asks.

## The check step and the three signatures (BC.02, lane AUD3)

A management report that a person made themself carries three signatures, as the forms of the report engine do: who prepared it, who checked it, who approved it.

- **The check** (`checkBiPublication`, `POST /bi/publication-requests/{id}/check`, permission `bi.publish` over the whole tenant, `If-Match`): somebody who is neither the one who asked nor the author of the version records the check once, while the request is pending, with an optional note. The request stays pending; the decision is a third person's (the checker is refused as the approver, 403 `SELF_APPROVAL_DENIED`). The step is optional: a request decided without it is the two-person flow of before.
- **In the database** (V2920): `checked_by`, `checked_at`, `check_comment` on `bi_publication_request`; checks `checked_by <> requested_by`, `checked_by <> decided_by`, the person and the instant come together, a note needs a checker; the guard lets the three columns move once, from empty to written, while the request is pending.
- **The block** (`sign_off` of `getDashboard`, for the version the dashboard points to and for each of its `versions`): `prepared_by` (the author of the version), `checked_by` (the check of the request that is pending for the version or approved it; the check of a rejected request is not carried to a later one), `approved_by` (who published it), each `{id, name, at}` or null, with `state` (UNSIGNED, PREPARED, CHECKED, APPROVED) and `complete` (all three). A publication that skipped the check is APPROVED and not complete; nobody is made up. The name is the one of the directory of the tenant, null when it has none (the screen then shows the identifier).
- **The export files** (CSV, XLSX, PDF, DOCX): three lines after the usual header, "Người lập", "Người kiểm tra", "Người phê duyệt", with the name and the day, or "chưa có". An export is made for a person from a certified metric: the person it is made for prepared it, the check is the one of the request that certified the metric, the approval is its certification (a metric certified by the platform has no checker).
- **Screens**: BI-11 shows who checked each request and gives the "record as checked" action (the checker and the one who asked do not see the decision); BI-03 shows the block of the version the dashboard points to and the furthest step of each version. Strings: i18n part `aud3`.

## Screens

- **BI-11** `PublicationInboxScreen`: the requests by state (pending first), with the object, who asked and the checks; the approver reviews one, comments (required to reject) and approves or rejects; the one who asked sees that they cannot; the refusals of the server are told by their reason (the check that failed by name). A member who may ask has the form to ask for an object by its id.
- **BI-10** `DashboardCompareScreen`: two versions of a dashboard (the newest and the one before it, or the ones picked): the tiles added, removed and changed, the metrics by version (named from the catalogue, by id when the catalogue cannot be read) and the settings (columns, breakpoints, filters, the policy for the datasets, the pinned versions). The owner asks to publish the newer draft from here. BI-03 leads to it when a dashboard has two versions or more.

## What is not done

- A request cannot be withdrawn (the state `WITHDRAWN` is in the table and the guard, no command moves to it: the plan has none).
- The reproducibility check is a check of the snapshot the metric reads and of the metric over it (the rows and the groups), not a comparison with a figure stored at an earlier certification, because no such figure is stored.
- Sharing a dashboard (the audience) is ST-BI-007; publishing does not change the audience.
