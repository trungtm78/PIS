# INFRA-1: infrastructure as code, identity, backups, security scanning, pen-test readiness

Lane `lane/infra1` (worktree `D:\PIS-infra1`). Source: plan section "Wave 5: infrastructure" (on-prem package, Keycloak with AD/LDAP and MFA,
backups with immutable copies and restore drills, SAST/DAST, TLS and headers, independent pen test). Everything here is code and documents:
nothing touches a customer system, nothing needs network access or credentials, and no daemon (docker, helm, keycloak) is started. Every
artefact is validated by node tests and by `npm run infra:check`.

Status legend: `[ ]` open, `[x]` done.

## Decisions (owner rule 2026-11-08: decide by deepest governance, no scope cut)

- Compose is the authoritative on-prem deployment set (offline install, one or two hosts). A Helm chart is NOT produced: it cannot be validated
  without `helm`, and an unvalidated chart is worse than none. The compose set is the contract; a chart is a follow-up that reuses `infra/onprem/images.json`.
- The API runs TypeScript sources through `ts-register` (there is no compiled output), so the api and workers images carry the pruned workspace
  sources and production `node_modules`; the workers image is the same code started with `WORKERS_ENABLED=true` and no published port, the api image
  with `WORKERS_ENABLED=false`.
- The `multer` advisory GHSA-q7qp-rjg7-q26m is fixed by upgrading (`overrides` pins `multer` 2.5.0, the fixed release), not by an exception.
- Keycloak is delivered as a native realm import (`infra/keycloak/onprem/machvon-realm.json`, `${VAR}` placeholders substituted by Keycloak at import);
  the existing `realm-template.json` stays the declarative policy that `infra:check` already reads.
- Backups: pgBackRest (already the declared tool) writes full, differential and incremental backups and the WAL archive to an S3-compatible bucket
  with object lock (COMPLIANCE mode) at the second site; encryption is pgBackRest client-side AES-256 plus server-side encryption of the bucket.
- The restore drill extends the tenant restore tooling of `packages/db` (`verifyRestore`, `restoreReportReference`, `TenantRestoreStore.measure`):
  one manifest per tenant measured on the source and on the restored cluster, compared by the same function. No second comparison logic.

## Steps

1. [x] Plan file (this file), committed first.
2. [x] Dependency audit: upgrade `multer` to 2.5.0 through `overrides`, add `js-yaml` (exact) as a dev dependency for the YAML checks; the lockfile entry of `multer` and the root dev dependency edited by hand, because npm did not re-resolve under the junctioned `node_modules` (`npm audit` and the supply-chain check confirm the result).
   Test: `npm run supply-chain:check -- --audit` shows no high advisory; lockfile in sync.
3. [x] Native dependency check `scripts/native-deps-check.mjs` + test + policy (`infra/onprem/native-deps.json`): lists native and binary packages from the lockfile,
   flags those without a linux arm64 build, says that `embedded-postgres` is test-only. Test: fixtures with and without arm64 siblings, the real lockfile passes.
4. [x] Images and compose (`infra/onprem/`): Dockerfiles for api, web, workers and backup (pgBackRest), `.dockerignore`, `images.json` (every third-party image with
   tag and digest slot, platforms amd64 + arm64), `compose.yaml` (pinned, health checks, limits, secrets as files, read-only roots), config templates with references only.
5. [x] Offline bundle `scripts/onprem-bundle.mjs` + test: `build` (buildx per image to OCI archives, SHA256SUMS, SBOM through `scripts/sbom.mjs`, manifest, install and rollback scripts),
   `verify` (checksums, manifest, arch coverage). Docker is injected, so tests use a fake runner.
6. [x] TLS and headers: nginx edge config (`infra/onprem/nginx/`) with TLS 1.2/1.3 only, HSTS, CSP, frame, referrer, permissions and nosniff headers; API header middleware
   in `apps/api` (minimal, anchored) so the API actually sends them; a test that boots the API handler and asserts the headers of a response, and that reads the nginx config.
7. [x] Identity: Keycloak realm export (LDAP/AD federation placeholders, mandatory TOTP or WebAuthn, brute force 5 failures / 15 minutes lock, session policy, AD group to role mapping,
   `acr` mapping to `aal2`), `ad-group-role-map.json`, `docs/security/identity-test-plan.md`, runbook. Test: structural tests over the export and the mapping.
8. [x] Backups: `infra/backup/backup-policy.json` (schedule full/diff/incremental/WAL, retention, immutability, encryption, RPO/RTO), pgBackRest conf template, `scripts/backup-verify.mjs`
   (offline policy verification and live object-lock verification through an injected S3 CLI), restore drill (`packages/db/src/restore-drill.ts` + CLI + runbook with checksum comparison).
9. [x] Security scanning workflows: `security.yml` (CodeQL, secret scanning, dependency review, filesystem scan), `images.yml` (multi-arch build without push, image scan, SBOM),
   `dast.yml` (ZAP baseline against `vars.DAST_TARGET_URL`, never run here), `.zap/rules.tsv`; `supply-chain.json` image scan policy; CI ARM leg (`ubuntu-24.04-arm`) in `ci.yml`.
10. [x] Pen-test readiness pack `docs/security/pentest-readiness.md` (scope, rules of engagement template, OWASP Top 10 / API Top 10 / ASVS L2 mapped to controls and tests) and runbooks
    (`docs/runbooks/infra/onprem-install.md`, `onprem-upgrade-rollback.md`, `backup-immutable.md`, `restore-drill.md`, `tls-headers.md`, `security-scanning.md`).
11. [x] `infra:check` extended (`scripts/infra-artefacts.mjs`, wired into `scripts/infra-check.mjs`) with tests: pinned versions, no latest tags, no secret literals, immutable-backup settings,
    MFA policy, multi-arch, security workflows, ARM leg, headers. Messages in `scripts/messages/{vi,en}.json`.
12. [x] Gates: `npm run lint`, `npm run typecheck`, tests of what changed, `node scripts/edition-check.mjs`, scan-files self check; Codex review, triage of every finding, fixes with tests.

## Tests per step

Every step ends with node tests (`node --test scripts/<name>.test.mjs`) and a negative case for each rule of the check it adds (a mutated copy of the artefact must fail with the named code).

## Risks

- Keycloak realm JSON and compose YAML are validated structurally only; they were not imported or started. The report says so.
- Image digests cannot be resolved offline: `images.json` carries tags and digest slots filled by the bundle build; the rule is "tag pinned to a full version, never latest, digest recorded in the bundle manifest".
- `package-lock.json` and `package.json` are shared files: edits are small (one override, one dev dependency).

## Codex review (model gpt-6-astra, three passes) and dispositions

Pass 1 (whole branch), six P1 findings, all valid and fixed with a rule in `infra:check` and a test each: the TypeScript loader `@swc/core` was a dev dependency (now a dependency of `@machvon/api`, optional platform binaries kept, `embedded-postgres` deleted from the image); the migration job needs `schema_reference.sql` (copied, rule `requiredCopies`); the first migration creates `vector` (the db image installs `postgresql-18-pgvector`, rule `extensionPackages`); backups and the directory need a way out (an `egress` network with a fixed subnet for db, backup and keycloak only, host firewall script, rule on who may join it); nginx renders its template at start (tmpfs on `/etc/nginx/conf.d`); secret files must be readable by unprivileged container users (group `MACHVON_SECRETS_GID`, `group_add`, mode 0440, install script check).
Pass 2 (fixes), two findings, valid and fixed: the firewall must allow traffic inside the egress network (Keycloak to the database); both destinations must resolve before any rule is written (tests with a fake `getent`).
Pass 3: no actionable finding.

## Not run (honest list)

No docker, compose, helm, keycloak, nginx, PostgreSQL server of the product's version, pgBackRest, object store, ZAP, CodeQL or Trivy was started: images, compose set, nginx configuration, realm import, install and rollback scripts, bucket scripts and workflows are validated by static rules and unit tests only. The workflows were parsed as YAML but not run on GitHub.
