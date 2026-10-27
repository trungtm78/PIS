# Drill and source tracing (ST-HOME-002)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/HOME.md` (F2, BR-HOME-03, BR-HOME-08). One operation, `explainHomeMetric` (`GET /home/drill`, `home.read`), no table, no migration. The screen is HOME-10. The figures and their tiles are those of ST-HOME-001 (`docs/home-command-center.md`); the formulas are proposals until the business owner signs them (CXN-03).

## The token and what each step does

The token of a tile (and of every child of a drill) is `base64url(payload).base64url(hmac-sha256)` over a purpose prefix, good for 30 minutes (`signHomeContext`, `verifyHomeContext` of the kernel). The payload names the tenant, the **member**, the snapshot, the hash of the scope it was made under, the metric, and how far down it has gone (`unitId`, `projectId`, `lineId`); it holds no name and no figure (BR-HOME-08). Each request:

1. reads the token back: 400 `INVALID_REQUEST` for one that was altered, signed with another key, not a token, of **another tenant or another member** (nothing is said of which); 409 `SNAPSHOT_EXPIRED` for one that is good but old, with `snapshot_id`, `metric_code`, `unit_id`, `project_id` in the problem body (the signature is good, so they are the server's own);
2. keeps the snapshot of the token (a newer one that is frozen is never taken; a snapshot that is not there is 404);
3. judges the right to read again, as it is now: the unit by the unit scope, the project by the project scope, the cell by the project's lines in the snapshot. What the reader cannot read is **403 `SCOPE_DENIED`** that names nothing, and is written to the audit trail as `home.drill_denied` (outcome DENIED, `home_drill`, the snapshot as the resource, the metric and the level in the diff, no name of a unit or a project). A token made under another scope is still read over the scope the reader has now, and the answer says `scope_changed: true`.

## The answer

`context_token` (the same step, renewed), `metric_code`, `level` (`SCOPE`, `UNIT`, `PROJECT`, `CELL`), `snapshot_id`, `as_of_date`, `treasury_cutoff_date`, `definition_status`, `scope` (the names of the unit and the project, which the reader has just been judged to read), `formula`, `unit`, `value`, `numerator`, `denominator`, `null_reason`, `child_dimension` and `child_dimensions`, `exclusions`, `children`, `reconciles_to_parent`, `non_additive_reason`, `source_records`, `next_cursor`.

- **Levels and dimensions**: from the scope or a unit the children are `unit` (the units that own lines, under the unit) or `project`; from a project they are its `cell`s (the lines of the year plan: current-year, central or local; the carried-over cells are not of the year plan the center divides by, and are left out); a cell has no children, its way goes on to the sources. Each child carries its own token, narrowed one step further.
- **Reconciliation, at the server (BR-HOME-03)**: for money the children that have a figure are added as big integers and compared with the parent to the dong (`reconciles_to_parent`; a child with no figure adds nothing); for a ratio `reconciles_to_parent` is false and `non_additive_reason` is `RATIO`, and each child gives its numerator and denominator, so that the reader adds those. The check covers every child, whatever page is shown. A cell, which has no children, answers true: there is nothing that fails to add up.
- **Unknown is not zero (BR-HOME-04)**: a child the Treasury booked nothing for is null with `NO_DATA`, and is also listed in `exclusions`.
- **Sources**: from a project or a cell, the report revisions the lines were taken from (`REPORT_REVISION`, with revision, status, submitted and accepted times) on the first page, and the project's Treasury transactions up to the end of the cutoff day of the snapshot, Vietnam time, latest first (`TREASURY_TRANSACTION`, with the external id, the amount and the time of confirmation, and the transaction it reverses), a page at a time. A transaction confirmed after the cutoff is not a source of the figures.
- **Paging**: `limit` 1 to 200 (50 by default) and `cursor`; at a scope or a unit the cursor pages the children (sorted by code), below it the transactions.

## HOME-10

Reached from a tile (`/home/home-10?token=`), or from a child of a drill. It shows the formula, the numerator and denominator, the snapshot (the whole id in its title) and the day, the place the figure is of, what is left out, the breakdown (choose the dimension when there are two, "go down" on each row, "show more"), the proof that the rows add up or why a ratio does not, the sources, and a breadcrumb that walks back. It says "the rights changed" with a button to read again when `scope_changed` is true.

- **Right gone (403)**: a page of its own, "you may no longer read this", with the label "needs a refresh" and the way back to the center; no name of any unit, project or step of the trail is left on it.
- **Token old (409)**: the center is asked for the same snapshot (`getCommandCenter?snapshot_id=&unit_id=`), the token of the same metric replaces the old one, and the page goes on. When the old token was below the unit (a project or a cell) the steps below cannot be renewed one by one: the trace goes on from the unit, and the page says so. When the center has no such tile, the page says the token is not good (it does not wait for ever).
- **Token not good (400, 422)**, **snapshot not there (404)**, and the other states (loading, error, offline, denied, signed out) are the standard ones; no token in the address is a page of its own and asks nothing of the server.

## Assumptions and limits

- The unit children are the units that own lines (flat), not the tree of the organisation; each unit's own drill is over its subtree.
- The hop to the documents (DOC `document_version`) is not built: DOC has no read endpoint for it yet (cross-group request). The audit for hops into documents (sensitive-read) follows it.
- A token below the unit is not renewed by itself (see above); the renewal of a deep token needs an endpoint that issues one for a project, which is a decision for the BI context library that shares this token (cross-group).
