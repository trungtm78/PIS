# DGV: source mappings, the gate of a batch and the reconciliation of two sources (ST-DGV-004, slice DGV-1)

A field of a source reaches a dataset only through a mapping that its owner confirmed, with the unit the source writes it in; and two sources are compared on the same period and basis, difference by difference, without
ever choosing one as right (DGV.md F7, BR-DGV-09, D04). The people are memberships, as everywhere in DGV, and the rights are held on the whole tenant (a dataset belongs to no unit).

## Mappings (`dataset_source_mapping`, DGV-20)

| command | right | rule |
|---|---|---|
| `proposeSourceMapping` | `data.mapping.manage` | a dataset the proposer can see (404); the unit is one the system knows (422 `unit`): `VND`, `THOUSAND_VND`, `MILLION_VND`, `BILLION_VND` or the words (`triệu đồng`, `tỷ đồng`…); none means dong; a live duplicate (proposed or confirmed, same dataset, system, source field and target field) is 409 `MAPPING_DUPLICATE`; a rejected or retired one can be proposed again; a confirmed one is changed by proposing another for the same fields (one that says the same is 409 too) |
| `decideSourceMapping` | `data.mapping.approve` | `CONFIRMED` or `REJECTED` at the version read; not by the one who proposed it (403 `SELF_APPROVAL_DENIED`); only a proposed one (409 `MAPPING_STATE_INVALID`) |

What a mapping says is never changed (a trigger refuses it): a new one is proposed, and confirming it **retires** the confirmed one it replaces (`RETIRED`, kept in the history; the audit row and the event name `retired_mapping_ids`). The decision is written once, nothing is erased. Each command writes an audit row and an outbox event (`dgv.mapping.proposed.v1`,
`dgv.mapping.decided.v1`). Reads: `listSourceMappings` (`data.mapping.read`), for the datasets the viewer may see.

## The gate of a batch (`dataset_batch_gate`, DGV-14)

`DgvMappingStore.gate(tx, { datasetId, sourceSystem, batchRef, rowCount, sourceFields, actor })` is what a pipeline (DIS, PAY, MDM) calls before it reads a batch of a source. Every field of the batch needs a **confirmed** mapping.
If one does not, the whole batch is kept out in **quarantine** with the reason `MAPPING_NOT_CONFIRMED` and the fields named; it is not read with a guessed mapping and does not reach an official report. Otherwise it is applied
with the factor of the unit of each field (`convertAmount` converts exactly and refuses a result that is not a whole number of dong; it never rounds). What the gate did is written once (`dataset_batch_gate` is append-only) and
read by `listBatchGates` (`data.mapping.read`).

The pipelines do not call the gate yet: DIS and PAY import their files through their own stores. Calling it from them is recorded in TODOS.

## The reconciliation (`reconciliation_run`, DGV-09)

`runReconciliation` (`data.quality.run`, answers 202 with the id; the comparison is done already) compares

* **A**, `PAY.treasury_transaction`: what the Treasury paid, project by project, up to the last day of the month by the day of the Vietnam clock it confirmed (a refund takes away); and
* **B**, `DIS.report_accepted`: what the frozen `PERIOD_CLOSE` snapshot of the month reports each project disbursed (`disbursed_reported_vnd`; a project the report gives no figure for is not there).

The sources and the basis are the ones the server knows (`PAY.treasury_transaction`, `DIS.report_accepted`, `VND, ngày Kho bạc thanh toán`): anything else is 422 `BASIS_MISMATCH` naming `source_a`, `source_b` or `basis`.
A month without a frozen report is 422 `SNAPSHOT_NOT_FOUND`. The dataset the incident belongs to is `dataset_id` or the only DIS dataset the caller can see (422 `dataset_id` otherwise).

Each key (a project) is classified by `reconcileSources`:

| kind | when |
|---|---|
| `TIMING` | the whole difference was confirmed after the cut-off date of the report |
| `REVERSAL` | the whole difference is refunds |
| `MAPPING` | one amount is the other times a thousand, a million or a billion (a unit that was not converted) |
| `MISSING` | one side has the project and the other has not |
| `AMOUNT` | anything else |

The two totals stay apart and the difference is only the difference (`A − B`); neither is taken as right. The result is `MATCHED` when no project differs, `WITHIN_TOLERANCE` when every project is on both sides and every
difference (and the one of the totals) is within the tolerance, otherwise `DIFFERENT`. This reading is stricter than a comparison of the totals: differences that offset one another are still differences.

A `DIFFERENT` reconciliation has **one incident**: HIGH, 24 hours, owned by the owner of the dataset, about the frozen report that was compared (`quality_incident.reconciliation_id`, `rule_id` is empty; exactly one of the two
is set). The open incident of the same code and month is reused (the lock is the one of the run job and the sweep of waivers). Closing it needs a later reconciliation of the same code and month that is not `DIFFERENT`
(`rerunEvidence`). The reconciliation is a measurement: the database refuses to change it (only the incident can be set, once) or to delete it. At most 1000 differences are kept one by one (`differences_truncated`); the
totals and the counts by kind are always whole. The audit row and the event `dgv.reconciliation.completed.v1` name the figures and the incident, never the projects.

The amounts are those of every project of the tenant, so the command and the reads (`listReconciliations`, `getReconciliation`, `data.quality.read`) need the right on the whole tenant (403 `SCOPE_DENIED` otherwise).

## Quarantined rows (ST-DGV-002 → ST-DGV-004)

A rule whose action is `QUARANTINE` and that did not pass now also lists the rows it kept out (the sample ids it keeps, at most 50) as **open exceptions** of the owner of the dataset, with the incident of the rule. They are
resolved or waived as any other exception (ST-DGV-003); the count of the rest is `quarantined_count` of the result.

## Screens

* **DGV-20** (`MappingScreen`): the mappings by dataset and status; propose; confirm or reject as the server's `actions` allow.
* **DGV-14** (`PipelineScreen`): the batches the gate let through or kept out, with the reason and the fields; the confirmed mappings the pipeline reads; the proposals that wait.
* **DGV-09** (`ReconciliationScreen`): the list; one reconciliation with the two totals side by side, the difference, the count by kind, each difference, the link to the incident (`?recon=`); run a reconciliation.
