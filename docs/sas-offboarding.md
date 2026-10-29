# Export of tenant data and offboarding (ST-SAS-016, SAS.md 3.2 and 3.10, BR-SAS-03)

A tenant that leaves keeps its data: the owner exports all of it, with a manifest that lets them check every file, and the System Admin archives the tenant only after an export was delivered or the window to export is over. Archiving deletes nothing.

## Offboarding and archive (control plane, System Admin)

| Operation | From → to | What happens |
| --- | --- | --- |
| `startTenantOffboarding` (`POST /system/tenants/{tenantId}/offboard`, `system.tenant.manage`, If-Match the version of the tenant) | Active or Suspended → Offboarding | Records the end of the contract, the days of the window (30 to 180) and when the window ends: **from the later of the end of the contract and now**, plus the days. 422 `VALIDATION_FAILED` names the first bad field; any other state is 409 `TENANT_STATE_INVALID`. The tenant becomes read-only and may export (`tenant_runtime` answers `READ_ONLY_EXPORT` for Offboarding). Event `sas.tenant.status_changed.v1`. |
| `archiveTenant` (`POST …/archive`) | Offboarding → Archived | Needs an export that was **Delivered** or a window that has **ended**, else 409 `EXPORT_NOT_CONFIRMED`. Its people can no longer sign in (`NO_ACCESS`). The legal holds of the tenant do not stop the archive: they stop the purge that follows (the retention job skips what a hold holds). |
| `resumeTenant` (existing) | Offboarding → Active | Inside the window only (a renewal of the contract); clears what offboarding recorded. After the window it is 409 `TENANT_STATE_INVALID`. |

`listSystemTenantExports` (`GET /system/tenants/{tenantId}/exports`, `system.tenant.read`) gives the System Admin what to decide on: the status and version of the tenant, the contract end, the days and end of the window, whether an export was delivered, the legal holds in force and the exports. Rules: `packages/kernel/src/sas-offboarding.ts`; transitions: `packages/db/src/tenant-state.ts`; migration **V1490**.

## The export (tenant plane, `tenant.export`)

| Step | Operation | What happens |
| --- | --- | --- |
| Ask | `post_tenants_id_export` (`POST /tenants/{id}/export`, 202) | The path is the caller's tenant (else 404). `scope` FULL or BUSINESS_DATA_ONLY, an optional RSA public key (2048 bits or more, PEM; 422 on `encryption_public_key_pem`), a reason of ten characters. **If-Match is the number of exports the caller saw** (`exports_version` of the list): when somebody asked meanwhile 409 `VERSION_CONFLICT`. One export at a time per tenant (409 `EXPORT_ALREADY_RUNNING`, a unique index). Allowed while the tenant is Active, Suspended with read and export, or Offboarding (else 409 `TENANT_STATE_INVALID`); the read-only guard lets it through though no plan feature gates it. |
| Make | the job `tenant-export` (every minute) | Reads every table of the tenant plane (tables with row-level security and a `tenant_id`; never the stored answers of commands, the events not yet relayed, the sessions and devices of people, the export jobs themselves) in **one read-only REPEATABLE READ transaction**, one JSON lines file per table, in pages. Columns that hold a secret (`secret`, `password`, `private_key`, `token_hash`, `token_fingerprint`, `api_key`) are left out and the manifest says which. A BUSINESS_DATA_ONLY export also leaves out the tables of who may do what and what was done (audit, roles, memberships, notifications, legal holds…). The clean files of the tenant (documents, imports, photos…) are copied under `attachments/{kind}/`, and so is every object that a row of an exported table refers to by its key (`tenants/{tenant}/{kind}/{id}`): the signed versions of documents and the reports of their verification live in the store of the document module, which is read for them. A reference that no store returns is listed in the manifest as `missing_files`, and the screen warns before the tenant is archived. The size is counted as the pages are read: a table that would take the export beyond 512 MiB stops it as Failed (`ExportTooLarge`) before it is held in memory. With a public key every file is encrypted (AES-256-GCM under a key of its own, wrapped with RSA-OAEP SHA-256) and the manifest carries the wrapped key and the hash of the plain file. |
| Read | `listTenantExports`, `getTenantExportManifest` (`GET /tenant-exports/{id}/manifest`) | The manifest lists `schema_version`, the snapshot time, every file `{path, bytes, sha256}`, the rows of every table, the omitted columns and the fingerprint of the key. Its sha256 is recorded in the job. |
| Download | `downloadTenantExportFile` (`GET /tenant-exports/{id}/file?path=…`) | Gives a **link of five minutes** with the size and the sha256 the bytes must have. The right to export, the state and the 72 hours are judged again on each ask. The public route `GET /tenant-exports/{id}/content` serves the bytes while the signature is good; it checks them against the manifest first and **records the download once the response has gone out whole** (a client that drops the connection leaves the export as it was). |
| Deliver | | The export is **Delivered** once every file of the manifest, the manifest included, was downloaded (`files_downloaded`). It stays downloadable until its 72 hours end. |
| End | the same job | A Ready export whose 72 hours ended is Expired; one that has run for two hours is Failed (`Stalled`). |

The table holds what the application relies on (V1490): what was asked for and what was made never change, a job only moves forward (Requested → Running → Ready/Failed, Ready → Delivered/Expired), nothing deletes one, and the functions `tenant_export_delivered` and `tenant_legal_holds_active` answer the two facts the archive and the screen depend on.

A support access grant never gives `tenant.export` (it reads across every module); the owner of the tenant is the only one who exports, and the System Admin sees the state, not the data.

## Screen SAS-17

`OffboardingScreen`: for the owner the request form, the exports with their status and how many files were downloaded, the manifest of one (files, sizes, rows, the start of each sha256, the columns left out, the key) and a link for each file; for the System Admin the tenant picker, the window, whether an export was delivered, the legal holds in force and the actions that the state allows (start offboarding, archive, renew). The list is read again every five seconds while an export is being made and every minute otherwise. The seven states come from `StateBoundary`.

## Telemetry and alerts

The gauge `tenant_export_pending` and the alert `SAS_TENANT_EXPORT_PENDING` (`docs/runbooks/alerts/`); the job in `docs/runbooks/jobs.md`. Audit actions: `tenant.offboarding_started`, `tenant.archived`, `tenant.export_requested|ready|failed|delivered|expired|link_issued`. Events: `sas.tenant_export.ready.v1`, `sas.tenant_export.delivered.v1`.

## Runbook: purge after the archive and the deletion certificate

Archiving closes the tenant; the data stays until the purge. The purge is the retention job (ADM-017) for the classes and periods of the policy; it skips every scope under a legal hold (`legal_hold_blocks`). Before a platform operator removes the rest of an archived tenant (the rows and the objects under `tenants/{tenant_id}/`): check `listSystemTenantExports` (`export_delivered` true or the window ended, `legal_holds_active` 0), keep the audit trail of the tenant for its retention period, write down what was removed (tables and row counts from the manifest of the delivered export, the object prefix and its object count) and have the System Admin and the data protection officer sign that record as the deletion certificate. There is no operation that purges a tenant: the procedure is manual in R1 (`TODOS.md`).
