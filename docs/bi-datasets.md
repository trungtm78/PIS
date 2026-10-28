# Dataset versions by period (ST-BI-002)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/BI.md` (F2). Tables `bi_dataset` and `bi_dataset_version` (baseline, V002). Operations: `buildBiDatasetVersion` (`bi.dataset.build`, 202), and two reads added to the contract for the screens: `listBiDatasets` and `listBiDatasetVersions` (`bi.query`). Screens BI-07 (sources and model) and BI-18 (datasets and period snapshots). Pure rules: `packages/kernel/src/bi-dataset.ts`; store: `packages/db/src/bi-dataset-store.ts`; consumer: `apps/api/src/modules/bi/dataset.consumer.ts`.

## What a version is

One version is the data of **one period** as **one frozen close snapshot** of DIS (`snapshot_kind = PERIOD_CLOSE`, `payload_sha256` set) gave it, with what DGV said of that snapshot. It has the period (`reporting_period.code`), the snapshot, `row_count`, a checksum of its content, the linked quality run, the quality badge and the rows its rules quarantined. **One version per dataset and period is `FROZEN`** (unique index of the baseline); when the content changes the one that stood becomes `SUPERSEDED`, and it stays: a drill opened on it is served from it.

- **No run yet** (or a run that is still running, or that could not measure): `NOT_ASSESSED`, nothing linked, **0 rows excluded**. Never "good".
- **A completed run**: the badge is its verdict (`PASSED`, `WARNING`, `FAILED`; a run that blocks certified figures is `FAILED`), the run is linked and `excluded_quarantine_rows` is the number of rows its rules quarantined. Certified rows are at least rows − excluded: DGV adds up what each of its rules quarantined, so a row two rules quarantined is counted twice and `excluded_quarantine_rows` is an upper bound of the distinct rows (the API says `certified_row_count_min`, the screen "at least").
- **A run of other data** (its snapshot digest is not the digest of this snapshot): `STALE`, linked, nothing excluded.
- A version feeds certified figures unless its badge is `FAILED` or `STALE` (`feeds_certified`).

## How a version is made

- **The consumer** (`bi-dataset-build`) handles `snapshot.frozen.v1` (creating the dataset of the disbursement figures `DS-DISB` the first time, with its dimensions and approved joins in `join_paths`) and `dgv.quality_run.completed.v1`: for every active dataset made from period snapshots it builds the version of the snapshot's period. A snapshot that is not a frozen close snapshot (ad hoc, MNE, one a later freeze replaced) builds nothing. Each dataset is built in a savepoint. A delivery that is repeated is a counted duplicate (inbox row in the transaction), and two events for one content find the version already there: **nothing new is made when the content is the same** (the checksum of the snapshot, run and excluded rows).
- **The command** `buildBiDatasetVersion {as_of_period, source_snapshot_id?}` does the same for one dataset and period: the snapshot named, or the latest frozen close snapshot of the period (`422 SOURCE_SNAPSHOT_NOT_FROZEN` when there is none, or when the one named is not one). Asking for the same content again answers `UNCHANGED` and audits it.
- **A build already in progress** is `409 BUILD_ALREADY_RUNNING`: a `BUILDING` row of the dataset and period (one older than an hour is taken for dead and marked `FAILED`), or an advisory lock held by a build in another transaction. The consumer retries such a delivery.
- Each new version is audited (`bi.dataset_version_built`) and announced (`bi.dataset_version.frozen.v1 {dataset_id, as_of_period, snapshot_id, quality_badge}`).

## The screens

- **BI-07**: each dataset as a tree: source, grain, dimensions, approved joins ("nothing else is reachable; no query is typed"), refresh policy, link to the catalogue of DGV, the version in use with its badge. Seven states.
- **BI-18**: the versions of the dataset chosen, newest first: period, snapshot of DIS, when built, rows and certified rows (with the quarantined rows left out), badge, status; whoever may build can ask for a period (the form judges the code, and says built / nothing changed / why it was refused). A dataset with no version yet still shows the form. Seven states.

## Assumptions and limits

- `DS-DISB` is the only dataset made from period snapshots in R1; the other source kinds of `bi_dataset` (treasury, LLM usage, notification, subscription, audit, DOC facts) are not buildable yet (`422 VALIDATION_FAILED` on `dataset`) and arrive with their sources.
- DGV counts the rows its rules quarantined (`quality_run.quarantined_count`) but does not keep which rows: `excluded_quarantine_rows` is the count, and the exclusion of the rows from a certified total is the job of the query compiler (ST-BI-004), which is not built.
- The version is a record of the snapshot, its quality and its content identity; the rows are read from the snapshot (`period_snapshot_line`) by the compiler, not copied.
- The two reads (`listBiDatasets`, `listBiDatasetVersions`) are additions to the contract made for the screens; both are `bi.query`.
