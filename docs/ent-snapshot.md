# The enterprise data path: period snapshot, one reader, forms from frozen figures, narratives (ENT-3a, ENT-3b)

Requirements DL.01, DL.03, CN.02, CN.03, BC.01 of the customer spec "HSKT Phan mem quan ly DTXD v0.3". Review decisions R17 (revisions, nothing is edited after the close), R21 (one read path), R27 (one narrative table). Model: `docs/fnd-funding-model.md` (sections 5, 6.5, 13). Report engine: `docs/report-engine.md`. Plans: `docs/plans/ent3a.md`, `docs/plans/ent3b.md`.

## 1. What a snapshot is

A period snapshot of the ENTERPRISE pack (`period_snapshot`, kind `ENTERPRISE_CLOSE`, hash schema 2) freezes, for one reporting period of the ENTERPRISE calendar, the accepted figures as they were reported:

- the funding figures of every project in `period_snapshot_figure` (long format, built by `figureRowsOf` plus two appended kinds: `PLAN_TO_DATE` per cell and `TMDT_IN_FORCE` per project, class `TOTAL`);
- the indicators of the dictionary in force (`ind_figure`) in `period_snapshot_indicator` (V2660), covered by the same hash through the optional `indicators` member of the schema 2 extras. A snapshot with no indicator hashes exactly as `snapshotHashFor(2, ...)` always did; the public golden (`fnd-public-golden`, schema 1) is untouched.

Operations (module FND, `enterprise-snapshot.controller.ts`; permissions `funding.snapshot.build`, `.freeze`, `.read`):

| Step | Rule |
| --- | --- |
| `buildEnterpriseSnapshot` | the period is locked; every planned (project, class, measure) cell has an accepted actual for every month up to the period (a gap is a gap, an accepted zero is a submission); otherwise 422 `ENTERPRISE_SNAPSHOT_INCOMPLETE` with the missing units, projects and cells. The result is BUILDING for review. |
| `freezeEnterpriseSnapshot` | by somebody other than the builder (403 `SELF_APPROVAL_DENIED`), under the version the screen saw, with the hash of the stored rows. FROZEN rows and indicators are immutable in the database. |
| rebuild after the freeze | refused (409 `SNAPSHOT_FROZEN`) until a reopening of the period (`period_reopen`: reason, approver other than the requester) was approved after the freeze. The new snapshot has `revision + 1` and names the old one (`supersedes_id`); the old one becomes SUPERSEDED and keeps its hash. |

## 2. One reader (R21)

`EnterpriseFigureReader` (kernel, pure) is the only way a consumer reads a frozen snapshot: cells, sums by project, unit, class and tenant, every ratio as a sum over a sum with its numerator and denominator, a missing figure as null with a reason, never zero. The API view of the snapshot (DIS-32, DIS-33), the leadership panel (HOME-09, `leader.controller.ts`), the report forms and the cross-report comparison (RPT-09) all call it. `loadFrozenEnterpriseSnapshot` plus the reader is the hook for any new consumer (HPM push of a period, dashboards).

## 3. The six PVFCCo forms stand on the snapshot

Each form bundle (`packages/edition-enterprise/src/report-forms/bundles.ts`) stays `dataSource: 'ILLUSTRATIVE'` with its DEMO stamp until the customer sends the official layouts (PX-01, rule R18) and names a `snapshotProvider` (`ENT_SNAPSHOT`, `apps/api/src/editions/enterprise/snapshot-provider.ts`, registered by `load-enterprise.ts` only). Generating a form for a month or a quarter:

- with a frozen snapshot of that period: the draft is filled from the latest revision through the reader, `data_source` is `LIVE`, `snapshot_ref` carries the snapshot id and revision, the stamp stays;
- without one: the illustrative data, exactly as before.

Issuing is the ordinary path (check, approve, issue; the cross-report gate of ENT-4a runs on the issue). A new revision of the snapshot (after a reopening) gives a new copy: a different package needs a reason, the issued copy of the first revision is never changed (`is_current` moves to the new one). End to end: `apps/api/test/reports/enterprise-snapshot-publication.enterprise.test.ts`.

## 4. The structured narrative and its Word document (ENT-3b)

The eight fields (status, schedule, disbursement, causes, difficulties, solutions, next plan, proposals) live in the pack columns of `report_narrative` (V2680, R27: one table, one row per report revision), with the picklist of standard causes (MDM-17), the directives rolled up (`getDirectivesForReport`) and the inheritance trace. The Word document of a form lays them out at the token `{{narrative:PROJECTS}}` of its skeleton. The words come from `EntNarrativeStore.acceptedForForm`: for each project of the snapshot, the latest report whose period lies inside the period of the form, that is ACCEPTED and still current (never a draft, a handed-in report, a taken-back or replaced one), with the names of the standard causes and one line for each directive that was rolled up, read from the register for the period of that report. Nothing is invented: a project with no accepted narrative keeps the square-bracket hint, and with none at all the token says there is none.

## 5. What stays PENDING-EXTERNAL

The official layouts of the six forms and the agency forms (PX-01, PX-15), the scope of the historical figures to load (PX-08) and the approved dictionary and estimate scope (PX-02). Until then every figure of a form is labelled DEMO, as in section 3.
