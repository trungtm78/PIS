# INT-1 plan: open API, machine accounts, BI reader logins, multi-system project codes

Lane INT-1 (branch lane/int1, migration block 2200-2219). Source: plan "Dot 4 item 4 INT-1", eng-review R6 and R13. Owner rule 2026-11-08: decide by deepest governance, no scope cut. Integration Hub direction: this lane is the credentials and access side of the hub.

## Decisions
- Machine access is a separate audience token (`machvon-open`, ES256, 5 minutes) signed by the issuer of the tenant tokens; the account and the credential are judged again on every call (suspend acts at once).
- Secrets: client secret = 256-bit random, shown once (`withheld` in the idempotency answer), stored as SHA-256; BI password = SCRAM-SHA-256 verifier made in the application, so the clear password never reaches PostgreSQL.
- BI path (R13): one login per tenant, tenant resolved from `current_user` through `machvon_bi.reader_binding`; security_invoker views over frozen snapshots; extra RESTRICTIVE policy `bi_reader_boundary` on four source tables for group role `machvon_bi_reader`; column grants only.
- Certified datasets: `int_export_dataset` + live gate on `data_product` (kernel `datasetGate` = SQL `machvon_bi.dataset_state`).
- Project codes: `master_crosswalk` (subject PROJECT, type PROJECT_CODE), EGP-1 maker-checker life, `int_source_system` registry; no external identity table.
- Hub: kernel `integration-access-connection.ts` (connector `access.open-api`) and db `AccessOverviewReads`.

## Steps (status)
1. Kernel rules and tests: done.
2. Migrations V2200-V2203, stores, db tests including the mandatory negative test (a BI login sets app.tenant_id to another tenant and reads nothing): done.
3. API through contract-patch, authz matrix, command registry, open API controller, published OpenAPI subset (scripts/open-api-publish.mjs, docs/open-api/openapi.json): done; API tests in apps/api/test/int.
4. Web screens INT-01..INT-05 with the kit, the states matrix, i18n part int1 and tests: done.
5. Docs: INT.md, docs/open-api.md, design rows (story ST-INT-001, traceability, backlog, navigation, test cases, rebuilt pages): done.
6. Isolation suite: foreign-id cases for ten operations, fixtures, the database path of the BI logins as a channel (apps/api/test/isolation/channels/bi-reader.ts): done; to be run with the gate tests.
7. Integration Hub: connector descriptor kept in one small kernel file (integration-access-connection.ts) and the read AccessOverviewReads: done.
8. Codex review and triage: in progress (results in the final report).
