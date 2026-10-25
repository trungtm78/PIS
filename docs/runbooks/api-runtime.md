# Running the API (ST-KERNEL-050)

`npm start -w @machvon/api` validates the environment, starts the API and stops it gracefully. The process entry is
`apps/api/src/serve.ts`; `bootstrap(config)` in `apps/api/src/bootstrap.ts` builds everything and is what the tests start.

## Configuration

`loadConfig(env)` reads the variables below and fails with **one** error that lists every missing or malformed one, by
name. A value, a password or a key is never written into a message. The process exits with status 78 before any
connection is opened. `.env.example` lists them.

| Variable | Meaning |
|---|---|
| `DATABASE_URL_APP`, `DATABASE_URL_CONTROL`, `DATABASE_URL_OUTBOX_RELAY` | one `postgres://` URL per role (`machvon_app`, `machvon_control`, `machvon_outbox_relay`); the API never uses one role for everything |
| `OIDC_ISSUER`, `OIDC_JWKS_URI` (optional), `OIDC_IDENTITY_AUDIENCE`, `OIDC_CONTROL_AUDIENCE` | the identity provider; the key set is discovered from the issuer unless `OIDC_JWKS_URI` is given |
| `TENANT_TOKEN_ISSUER`, `TENANT_TOKEN_SIGNING_KEY_PEM_PATH`, `TENANT_TOKEN_KEY_ID` | the EC P-256 key that signs tenant access tokens; `TENANT_TOKEN_RETIRED_KEY_*` (both or neither) keep the previous key published during a rotation |
| `OUTBOX_SIGNING_KEY` | base64 of at least 32 bytes; signs the worker context of outbox deliveries |
| `FIELD_ENCRYPTION_KEYS` (optional) | `id:base64` pairs separated by commas, each key of 32 bytes and each id from 1 to 255; the highest id seals the personal data of the households (ST-LND-002) and any id listed opens what it sealed. Rotating is adding a higher id and keeping the old one until nothing is sealed with it. A value that is there is judged at start (exit 78 when malformed); without it the API runs and answers 503 `PROVIDER_UNAVAILABLE` to whatever must seal or open personal data. See `docs/lnd-households.md`. |
| `PORT` (3000), `MAX_BODY_BYTES` (1048576, at most 50 MiB), `SHUTDOWN_TIMEOUT_MS` (15000) | runtime limits |
| `CORS_ORIGINS` | comma-separated origins; empty means no cross-origin access, `*` is refused |
| `MIGRATIONS_DIR`, `ERROR_CODES_PATH` | where the SQL migrations and `error_codes.json` are read from (defaults point into the repository) |
| `TELEMETRY_EXPORTER` (`none`), `OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | `console` writes one JSON line per span, `otlp` posts OTLP/HTTP JSON to `<endpoint>/v1/traces` |
| `WORKERS_ENABLED` (`true`) | `true`, `false`, `1` or `0` (anything else is refused by name). Whether this process starts the background workers: the outbox relay with its consumers and the scheduled jobs (see "Background workers"). Set `false` for a process that only serves requests; the default is on, so `npm start` delivers events and runs the jobs |
| `ALERT_WEBHOOK_URL` | optional `http(s)` URL; every alert is always written as one JSON line on standard error, and also POSTed here when set. A failing delivery is logged and never fails the raiser |
| `LICENSE_SIGNING_KEY_ID`, `LICENSE_SIGNING_KEY_PEM_PATH`, `LICENSE_RETIRED_KEY_ID`, `LICENSE_RETIRED_KEY_PUBLIC_PEM_PATH` | optional; the Ed25519 key with which the provisioning saga signs the pilot license of a new tenant (the file is read when first needed; without it that step fails with `SIGNING_KEY_UNAVAILABLE`). The public half must be registered (`license_signing_key`) |

## Health checks

| Route | Answers | Used for |
|---|---|---|
| `GET /health/live` | always 200 `{"status":"live"}`; asks nothing of the database | the orchestrator's liveness probe: a database outage must not restart healthy processes |
| `GET /health/ready` | 200 `ready`, or 503 `not_ready` | the readiness probe: the database answers a trivial query **and** every migration of `MIGRATIONS_DIR` is in `machvon.schema_migration` |

The 503 body names states and a count (`pending_migrations`), never an error text or a connection detail. The control-plane
role reads the ledger through the grant of `V020__ledger_read_access.sql`. A rolling deployment migrates first, then rolls
the processes: until the new schema is applied the new version stays not ready and receives no traffic.

## Background workers

After the server listens, `bootstrap` starts the workers of `apps/api/src/workers/` unless `WORKERS_ENABLED` is off:

- the scheduler (`IntervalScheduler`) running the six jobs of `docs/runbooks/jobs.md` through the job runner, each at its documented interval
  (audit-seal 5 minutes, audit-verify hourly, idempotency-purge hourly, certificate-expiry daily, access-cache-expiry every minute,
  outbox-relay 5 seconds), one owner per job through the database advisory lock;
- the outbox relay (role `machvon_outbox_relay`, signed delivery context with `OUTBOX_SIGNING_KEY`) with every consumer that exists:
  tenant provisioning, entitlement and tenant status cache invalidation, notifications;
- the one alert sink handed to the relay, the seal job, the job runner and the consumers.

The process opens two more pools of the relay role (2 connections for the relay, up to 6 for the job locks) next to the application pool
(10) and the control pool (4). A failing tick is logged by error class and raised as `JOB_FAILED`; it never ends the process. Details,
alerts and limits: `docs/runbooks/jobs.md`.

## Shutdown

On SIGTERM or SIGINT the process stops accepting connections, lets in-flight requests finish (idle keep-alive connections
are closed at once; after `SHUTDOWN_TIMEOUT_MS` the remaining ones are cut), clears the timers of the workers and waits for the tick
in flight, flushes the telemetry exporter and closes the database pools. A second signal during shutdown does nothing, and
`stop()` of the running API is safe to call twice.

## Telemetry

Every request gets one correlation id (the caller's `x-correlation-id`, else the trace id of a valid `traceparent`, else a
new one) and a span in the trace of that id. The ids come back in `x-correlation-id` and `x-request-id`.

- A span carries only `tenant_id`, `operation_id`, `request_id`, `correlation_id`, `http.status_code` and `db.operation`
  (`packages/kernel/src/telemetry.ts`). Any other attribute is dropped, and a value that looks like an email, a phone
  number, a bearer token, a JWT or a token in a URL is dropped even under an allowed name. UUID identifiers are kept.
- **Outbox propagation without a column:** the trace id of a request is its correlation id without dashes, and the
  correlation id is stored on every outbox row. A consumer wraps its work in `traceDelivery(tracer, delivery, ...)`, which
  continues the trace of the request that wrote the event.
- An exporter that fails never fails the request.

## Not yet wired (tracked in TODOS.md)

- **Infrastructure adapters:** the tenant provisioning saga that the relay's consumer runs uses the in-memory MOCK ports (identity provider
  organisation, DNS, certificates, storage, placement) and the MOCK invitation mailer until the real adapters of Task 20 exist; a run in
  flight when its process dies is not resumed after the restart (see `docs/runbooks/jobs.md`, limits).
- **Tracing backend:** the OpenTelemetry SDK packages are not added (a supply-chain review is pending); the exporter port has
  console, in-memory and OTLP/HTTP JSON adapters, and the SDK can replace the port without touching a call site.
- **`build`** is a type check: the workspace packages are consumed as TypeScript sources, and `start` runs them through
  `apps/api/scripts/ts-register.mjs` (an SWC loader with the decorator settings of the jest transform). A bundled production
  artifact belongs to the infrastructure task.
