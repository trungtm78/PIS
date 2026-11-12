# The open interface (INT-1)

Lane INT-1. Spec of the module: `Design/MACHVON_Design/01_Documents/05_modules/INT.md`. Plan and decisions: `docs/plans/int1.md`. Code: `packages/kernel/src/open-api*.ts`, `packages/kernel/src/integration-access-connection.ts`, `packages/db/src/int-*.ts`, `apps/api/src/modules/int/`, migrations `V2200` to `V2203`, screens `apps/web/src/screens/int/` (INT-01 to INT-05).

## 1. What it is

Three ways for something outside the platform to read what an organization has certified, none of which reaches around the tenant boundary:

| Path | Who | How it is bound to one tenant | Where every read is written |
|---|---|---|---|
| Open API `/open/v1` | A machine account with scopes | The token names the tenant; the transaction names it again, so row-level security applies | `int_access_log`, in the transaction of the read |
| BI database login | Lakehouse, Power BI | The login is bound to its tenant by its own name (`machvon_bi.reader_binding`), never by the session setting `app.tenant_id` | The log of the database server (pgaudit); the lifecycle of the login is in `int_bi_reader_event` |
| Project codes | The people of the organization | `master_crosswalk` rows of the tenant | The audit log (ADM-11) |

## 2. The open API for external readers

The published document is `docs/open-api/openapi.json` (also served, without authentication, at `GET /open/v1/openapi.json`). It is made from the operations of the contract marked `x-open-api` by `node scripts/open-api-publish.mjs`; `--check` fails when it is stale and the API test compares the served document with the file.

1. Open a machine account on INT-01. The answer shows `client_id` and `client_secret` once.
2. `POST /open/v1/token` with `{"grant_type":"client_credentials","client_id":"...","client_secret":"...","scope":"open.projects.read"}` (the scope is optional and can only narrow what the account holds). The answer is a Bearer token of 5 minutes.
3. Call the operations with `Authorization: Bearer <token>`.

| Operation | Scope | Reads |
|---|---|---|
| `listOpenProjects` | `open.projects.read` | Projects with their ACTIVE codes in other systems |
| `listOpenProjectCodes` | `open.project-codes.read` | ACTIVE codes by system, external code or our code |
| `listOpenDatasets` | any | The datasets the account may read, open or closed and why |
| `listOpenDisbursementLines` | `open.disbursement.read` | DS-DISB, frozen close snapshots of the reporting periods |
| `listOpenContractLines` | `open.contracts.read` | DS-CTR, frozen contract fact snapshots |

Rules: a refusal of the exchange is always `401 OPEN_CLIENT_INVALID` with no reason; a missing scope is `403 OPEN_SCOPE_DENIED`; a closed dataset is `403 OPEN_DATASET_NOT_CERTIFIED` (`reason`: `DISABLED`, `NOT_CERTIFIED`, `EXPIRED`); the rate limit of the account is `429 RATE_LIMIT` with `Retry-After`. Lists come in pages (`limit` up to 200, `cursor`). Money is whole dong as a decimal string. A suspension, a revocation, a taken-away scope and a revoked certification act at once, also on a token that is still alive.

## 3. Secrets

- Client secret: 256 random bits, shown once, stored as SHA-256, compared in constant time; the stored answer of the idempotency key has it emptied (`withheld`), so a replay gives an empty string. No audit row, event or log carries it.
- BI password: shown once; the application makes the SCRAM-SHA-256 verifier and gives that to PostgreSQL, so the clear password never reaches the server or its logs.
- A rotation of a client secret keeps the old secret for `grace_hours` (0 to 72, default 24); an account never holds more than two live secrets.

## 4. The BI path (eng-review R6 and R13)

1. The migration `V2200` (privileged) makes the group role `machvon_bi_reader` (NOLOGIN, NOBYPASSRLS) and four SECURITY DEFINER functions, executable by the application role only, that make, rotate, park and drop a login. They act only for the tenant of the caller's transaction and accept only a password verifier.
2. A login is `NOSUPERUSER NOBYPASSRLS`, read-only by default, with a connection limit and a statement timeout, a member of the group role and of nothing else. Its `app.tenant_id` is set to its tenant as a default for convenience; it is not the authority.
3. The views `machvon_bi.v_disbursement_lines`, `v_contract_lines` and `v_dataset_catalogue` are `security_invoker` and read FROZEN snapshots. Their tenant comes from `machvon_bi.dataset_state(current_user, dataset)`, which reads the binding. A dataset that is not open yields no row.
4. The four source tables carry one more RESTRICTIVE policy, `bi_reader_boundary`, for the group role: `tenant_id = machvon_bi.tenant_of(current_user)`. The group role is granted only the columns the views read.
5. The negative test (`packages/db/test/int-open-api.test.ts`, `apps/api/test/int/int.test.ts`): a login sets `app.tenant_id` to another tenant and reads nothing, from the views and from the tables.

To connect a tool: host and database of the platform, the login and password shown on INT-04, default schema `machvon_bi`, read the views listed on INT-04.

## 5. Operating notes

- The database must let the privileged migration make logins; otherwise the BI commands answer `503 BI_PROVISIONING_UNAVAILABLE` and change nothing.
- The offline install bundle has the opt-in read-only database port (`install.sh --with-bi`, `docs/runbooks/infra/bi-port.md`), closed by default. When it is on, the image's pgaudit (object mode on the views of `machvon_bi`) and `log_connections` are on and the daily audit file is shipped off the host: it is the record of what a BI tool read. Do not give out the first BI login before it is on.
- The rate limiter counts in the process: with several replicas the ceiling is multiplied by their number; the access log is the record.
- Integration Hub: the access side is read through `AccessOverviewReads` (database) and `accessConnectionView` (kernel, connector `access.open-api`): accounts per consumer, last use, scope, rate-limit refusals, state of the credentials, expiry and revocation.
