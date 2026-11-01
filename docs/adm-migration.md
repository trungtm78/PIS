# Conversion of legacy data in batches (ST-ADM-020)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/ADM.md` (3.10, BR-ADM-01, BR-ADM-12, ADM-13, UAT-AC143, UAT-NFR-OPERABILITY-06). Migration `V1309__adm1_migration_batches.sql`. Pure rules in `packages/kernel/src/migration-batch.ts`, storage in `packages/db/src/adm-migration-store.ts`, the job in `apps/api/src/modules/adm/migration.job.ts`, the API in `apps/api/src/modules/adm/migration-batch.controller.ts`, the screen in `apps/web/src/screens/adm/migration/`.

## The operations

| Operation | Who (on the whole tenant) | What it does |
| --- | --- | --- |
| `registerMigrationBatch` `POST /migration-batches` | `adm.migration.manage` | Registers an uploaded, scanned file (`file_id` is the id of the file in the import file store; its hash is read from the store, never taken on trust) for a target entity and a mapping version. One file for one entity is registered once: 409 `MIGRATION_FILE_ALREADY_REGISTERED`. Starts `Uploaded`. |
| `dryRunMigrationBatch` `POST /migration-batches/{batchId}/dry-run` | `adm.migration.manage` | 202; asks for a dry run of a batch that is `Uploaded`, `DryRunFailed` or `Failed` (409 `MIGRATION_STATE_INVALID` otherwise, 409 `MIGRATION_FILE_ALREADY_APPLIED` for an applied one). The job judges the file and writes the errors; nothing is written to the target. |
| `applyMigrationBatch` `POST /migration-batches/{batchId}/apply` | `adm.migration.approve`, **not the registrar** | 202; only from `DryRunPassed` (409 `MIGRATION_STATE_INVALID`), 403 `SELF_APPROVAL_DENIED` for the registrar. Starts `Applying`; the job writes the rows. |
| `rollbackMigrationBatch` `POST /migration-batches/{batchId}/rollback` | `adm.migration.approve` | 202; only from `Applied`. Marks the rows of the batch INVALID (they are not deleted). 409 `MIGRATION_DEPENDENTS_EXIST` while the rows of another batch refer to rows of this one. |
| `listMigrationBatches`, `getMigrationBatch` | `adm.migration.read` | The batches (newest first, filters `status`, `target_entity`, cursor) and one batch with the errors row by row (the first 1,000) and the control totals. |

## What a file is judged by

The mapping version of the batch says which column holds the business key, which the amount, which must be filled and which columns refer to rows of another entity. The platform knows `GENERIC-1` (a business key, an optional amount, the rest kept as it came) and `GENERIC-CHILD-1` (the same, with a `parent_key` that must be a row of the entity `PARENT` that was migrated before and not rolled back). The mapping of a real source waits for the decision on the source mapping (D04).

A row is an error when: the business key is empty, longer than 200 characters or on an earlier row; a required cell is empty; a cell is longer than 2,000 characters; the amount is not a whole number of up to 24 digits (a sign is allowed); a reference names a row nobody migrated. A column that is missing, or more than 100,000 rows, is judged by that alone. The errors are listed with the row (from 1 after the header), the line of the file, the column and a code; the control totals of the file are the number of rows and the sum of the amounts of the rows that have no error, summed as integers.

## Applying

The job `adm-migration` (every minute; scheduled where the object store is bound) stands in for the Temporal `MigrationApplyWorkflow`: a dry run reads the file, checks that its hash is the registered one and records the judgement; an apply writes the rows in lots of 1,000, each lot in a transaction of its own and each row upserted by `(tenant, entity, business key)`, so that a lot that is run again, or a batch that is carried on after it stopped, does not double. At the end the rows written for the batch are added up and compared with the control totals of the file: they agree → `Applied` (`control_totals` = expected, actual, matched; event `adm.migration_batch.applied.v1`); they differ → `Failed` with `CONTROL_TOTALS_MISMATCH`. A batch that cannot go on (the file is not the registered one, a lot cannot be written) stops as `Failed` (`DryRunFailed` for a dry run) with `failure_code`; it is dry-run and applied again and goes on from the rows it wrote. A batch that is `Applied` already is `ALREADY_IMPORTED` when the job reaches it again: nothing is written twice.

## In the database

`migration_batch` never changes what it was registered with; moves only along `Uploaded → Validating → DryRunPassed | DryRunFailed`, `DryRunFailed | Failed → Validating`, `DryRunPassed → Applying → Applied | Failed`, `Applied → RolledBack`; an applied batch keeps its approver, its row count and its control totals; `approved_by <> created_by`; nothing is deleted or truncated by the application role. `migration_row` marks, never deletes.
