# Plan and result of lane AUD2 (audit of master data, configuration and integration mapping against the HSKT)

Branch `lane/aud2`, worktree `D:\PIS-aud2`. The lanes ENT-3d, ENT-3e and ENT-4e are merged, but `docs/hskt/TRACEABILITY.md` still listed their gaps. This lane checked every row against the code and the tests, and closed what was genuinely open. Owner rule 2026-11-08: deepest governance, best extensibility, no scope cut; what only the customer can provide stays behind a port with a labelled working assumption (R18).

## What the audit found (verified in code, not in the old text)

| Row | Old gap text | Finding |
|---|---|---|
| HT.02 | no PVFCCo pack, no AD map | Stale. Built by ENT-3d: pack of 09 contact points in one tenant (`UNIT_ONLY` entry and unit approval, `TENANT` planning review, close, leadership, administration), loader through the ADM migration batch with dry run and a second person to apply, `materialiseEnterpriseOrgPack`, `tenantMappings` of `ad-group-role-map.json`, label `PVFCCO-TEMPLATE`. Tests: 38 pack tests run here, API test with the real database. Only the customer's names and accounts remain (PX-05, PX-16). |
| MD.01 | EBS direct match, no HPM code per project, no project types, no start flag | Stale for the crosswalk path (`ProjectCodeResolver`, regression test with reconciled imports), HPM code per project (`hpm-project-codes`), project types (catalogue rules and `PROJECT_TYPE`). Genuinely open: the web form of `PROJECT_TYPE` did not offer `MAJOR_REPAIR`; nothing read the start flag. |
| MD.02 | no milestone catalogue, no legal document types, no registry connection | The catalogues exist as governance rules but nothing read them (`milestonesOf`, `startFlagOf`, `assertMilestonesInOrder` had no consumer); there was no registry port. |
| MD.03 | no FX catalogue, report types and receivers are constants | FX is built (ENT-4e). The five report-chain types existed but the report engine still read the constants, the receiver of a delivery was free text, and the web had no typed forms for them. |
| CN.01 | origins missing | Stale for the origins and the decision kinds (V2740). The view `v_project_origin_decision` had no reader: the split per project was not readable by anybody. |
| TH.03 | EBS direct match | Stale (crosswalk first, fallback one version). No eProcurement or registry port existed. |
| CN.02 | no equipment screen | Stale (EQP-01, EQP-02). No eProcurement port existed. |
| HT.06 | no limits, only `safe_diff` | Limits and the detail store exist (ENT-4e) but only the reopening of a period and the HPM push passed `detail`; creation, save, handing in and decision of reports and the soft close and lock of a period did not. |

## Built here

1. **Ports** (`packages/edition-enterprise/src/external`): `EProcurementPort` and `DocumentRegistryPort`, working-assumption layouts, fake adapters, shared contract suite `test/support/port-contract.ts`; docs in `docs/hpm-ebs-connectors.md` section 7.
2. **Report catalogue** (MD.03): kernel `report-catalogue.ts` (pure), `ReportCatalogueStore` (reads published `REPORTING_PERIOD_KIND`, `REPORT_TYPE`, `RECEIVING_AGENCY`), optional attribute `receiver_code` of `RECEIVING_AGENCY`, the template pack aligned with the six forms (agency `NMD_PM`, receiver codes, period of the steering report), the report engine uses it: a form is registered under the agency that lists its type, `deliverReport` and `answerReportDelivery` accept only the receivers of the catalogue for the forms of the code once a tenant manages any, `listReportCatalogue` shows the managed receiver. A tenant that manages nothing behaves as before. Typed forms for the five types and the `MAJOR_REPAIR` kind in the web (i18n part `aud2`).
3. **Audit detail** (HT.06): `detail: { before, after }` on the soft close and lock of a period (command and job share `periodMoveRecord`), on the creation and save of a report (figures of every funding line, read back from the rows by `DisReportStore.figuresOf`, shape `reportFiguresDetail`), on the handing in and on the decision (status left and reached, the words of the reason inside the policy-controlled detail only). Opt-in per class stays: `reporting_period` and `report_revision` join `period_reopen` and `hpm_push`.
4. **Investment profile** (MD.01, MD.02, CN.01): `GET /projects/{id}/investment-profile?plan_year=` (`getProjectInvestmentProfile`, `project.read` in scope, enterprise module `IPF`): type, flag of the stage in the plan year, milestones against `ENT_LIFECYCLE_MILESTONE` with the findings `MILESTONE_ORDER` and `REQUIRED_SKIPPED`, split of the plan by origin with the documents, `group_assigned_vnd` and `board_approved_vnd`.

## Decisions

- The receiver of a form is an agency of the managed catalogue; the code stays the default, and a disagreement (`NO_AGENCY`, `AGENCY_NOT_UNIQUE`, `PERIOD_UNKNOWN`, `PERIOD_MISMATCH`) is reported by `reportCatalogueView`, never settled silently. The period of a form stays owned by the code because the layout is built for it.
- Only the forms of the code are judged for the receiver; configured layouts and the public forms keep their own receiver.
- The profile reads every annual plan of the project in the year, one revision per plan history: the published revision, and for a caller who drafts or approves plans also the newest revision still in work (the visibility rule of the plan reads); a medium-term plan is not an annual plan; start year: groundbreaking milestone (actual, else planned), else the start year of the project record; a cancelled groundbreaking gives no start.
- No migration was needed (every object has a table or a view); no block was registered.

## Not built, and why

- A web screen for the investment profile: it needs a screen id, a route, navigation, help and UAT documents and was not started; the API is the contract.
- Writing the legal document type of the catalogue when a project document is created (`createProjectDocument` is a public-edition command; the catalogue is enterprise-only, so it needs an extension port first).
- The real eProcurement, registry and direct EBS database connectors: PENDING-EXTERNAL (PX-06, PX-07, PX-04).

## Tests

kernel (`report-catalogue.test.ts`), db (`report-catalogue-store`, `master-types-ent3d`, `dis-report-detail`, `dis-period-store`), edition package (`external-ports`, `investment-profile`, `ent-catalogue`, `org-pack`), api with the real database (`report-engine.enterprise`, `investment-profile.enterprise`, `dis/report`), web (`mdm/catalogues`).
