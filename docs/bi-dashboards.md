# Dashboards and immutable versions (ST-BI-005)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/BI.md` (F5, F6, section 4, BR-BI-01, BR-BI-03, BI-01, BI-03, BI-04, UAT-AC32, UAT-AC474). Migration `V1581__bi1_dashboard_versions.sql`. Operations: `createDashboard`, `saveDashboardVersion`; reads `listDashboards`, `getDashboard` (new, `bi.query`) and `get_resources_dashboard_version`, `get_resources_dashboard_version_id` (`dashboard_version.read`).

## The rule

A dashboard is an object with an owner; a **version** is saved whole, never edited, and the dashboard points at the latest one. A published layout never changes silently because no layout ever changes: the next change is the next revision.

- **Making a dashboard (`createDashboard`, `bi.dashboard.manage`).** A code (letters, digits and `_ - .`, 2 to 80 characters) and a title; the dashboard is `PRIVATE`, `DRAFT`, with no version, and its owner is the maker. A code that the tenant uses already is 409 `DASHBOARD_CODE_DUPLICATE`.
- **Saving a version (`saveDashboardVersion`, `If-Match` on the version of the dashboard).** Only the owner (a dashboard that is not theirs and not in the library is 404, one in the library is 403 `SCOPE_DENIED`; an archived one is 409 `STAGE_TRANSITION_DENIED`). The draft is judged in the kernel (`parseDashboardDraft`): the layout is a grid of 12 columns of tiles (KPI, BAR, LINE, AREA, PIE, TABLE; at most 100) that do not overlap, each over a metric the version names, with a dimension for the kinds that have one; the breakpoints (`sm`, `md`, `lg`, `xl`, 320 to 4000 px) grow; the filters map to dimensions; the policy of the datasets is `LATEST_FROZEN` (no pinned version) or `PINNED` (at least one). Then the store reads what the kernel cannot: every metric exists in the tenant and is `CERTIFIED` (**422 `METRIC_NOT_CERTIFIED`**, with the ids), and every pinned version of a dataset exists and is `FROZEN` (**422 `DATASET_VERSION_NOT_FROZEN`**). A refused version leaves nothing. The revision is the next one; the dashboard moves to the version and its own version moves by one.
- **Reading.** `listDashboards` is the library of the caller: their own dashboards and those the tenant published to its library, by code, with the owner, the audience, the state, the version the dashboard points to (revision, state, number of metrics, and whether every metric of it is still certified now); `getDashboard` adds every version, newest first; `get_resources_dashboard_version` lists the versions the caller sees. Sharing and its effect on who sees what come with ST-BI-007.
- **The numbers on a tile** come from the query of BI (BR-BI-01, BR-BI-02): a ratio is the sum of its numerator over the sum of its denominator, and every answer carries its period and its snapshot. The chart builder shows exactly that, with the table of the same figures beside the chart.
- **The trail.** Audit rows `bi.dashboard.create` and `bi.dashboard.save_version` (the facts of the version, never its layout), events `bi.dashboard.created.v1` and `bi.dashboard.version_saved.v1`.

## The database

`V1581`: the pinned versions agree with the policy; the revision is one or more, once for each dashboard (V002); a version that is not a draft has who published it and when (and not the person who saved it: V002); `guard_dashboard_version` refuses to change what a version holds (layout, metrics, filters, breakpoints, policy, revision, who and when it was saved: `VERSION_IMMUTABLE`), lets the state move only DRAFT to PUBLISHED to SUPERSEDED and writes who published it once, and nothing is deleted or truncated by the application role (the data owner is exempt, as for the other governed tables); `guard_dashboard` fixes the code and the owner and lets a dashboard point only at a version of its own.

## The screens

- **BI-01** `DashboardLibraryScreen`: the cards of the library, with the owner, the audience, the state, the version and the certification of its metrics; a form to make a dashboard (with the checks of the contract) that leads to the builder.
- **BI-03** `DashboardBuilderScreen`: the dashboard of the address (or picked), its versions, a preview of the grid with a table of the tiles, and a form that starts from the version chosen: tiles (kind, certified metric, dimension, title, place), breakpoints, filters, and the policy of the datasets with the frozen versions to pin. The form judges the grid, the ids, the breakpoints, the filters and the policy before it sends; the server judges again. A person who may not change the dashboard, an archived one and a read-only session only see it.
- **BI-04** `ChartBuilderScreen`: a certified metric over a frozen version, cut by a dimension, drawn as bars, a line, an area, a pie or a figure from the groups of the answer (a group with no figure is not drawn as zero), the labels of the answer and its table next to it, and a link that hands the chart to the builder as a tile.

## What is not done

- Publication of a version (DRAFT to PUBLISHED, `submitBiPublication`, `decideBiPublication`, `post_dashboards_id_publish`) is ST-BI-006; sharing is ST-BI-007; the comparison of two versions (BI-10) comes with the publication.
- The tiles of the saved layout are not drawn with live data in the builder (the preview is the structure); the figures are drawn in BI-04 and on the board BI-02.
- The edit right of a person the dashboard is shared with is part of ST-BI-007; until then only the owner changes a dashboard.
