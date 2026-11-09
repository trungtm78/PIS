# Ransomware scenario catalogue

Source: customer specification HSKT v0.3, requirement YCK.07 (security against ransomware: a copy of the data separated from operations, malware scanning of uploads, restricted egress, independent code review and penetration test). The machine readable form is `docs/security/ransomware-scenarios.json`; `npm run infra:check` refuses a scenario without a preventive control and a detective or recovery control, with evidence (a file, optionally a text in it) that does not exist, or without a test that exists. This page is the readable form for the customer and for the penetration tester (it is part of the pack `pentest-readiness.md`, section 6a).

The catalogue lists what the **product and the on-prem package** do. Controls of the customer's own estate (endpoint protection, mail filtering, network segmentation outside the compose set, staff training) are listed at the end as assumptions.

## Scenarios

| Id | Way in | What the attacker wants | Stops it | Detects it | Undoes it | Tests |
|---|---|---|---|---|---|---|
| RW-01 | File upload or portal attachment, executed by a user or served | A planted executable, script or macro document | Type judged by bytes; ClamAV scan before any link or download, closed when the scanner is away; portal upload refused when unscanned; read-only containers | Scan events (HELD, QUARANTINED) in the log | Immutable and offline backups | `apps/api/test/files/clamd-scan.test.ts`, `files.test.ts`, `packages/kernel/test/object-storage.test.ts` |
| RW-02 | Remote code execution in the API, the web edge or a container | Run code, encrypt what the process reaches | Non-root, dropped capabilities, no-new-privileges, read-only roots, strict CSP and headers | CodeQL security-extended, image and filesystem scan | Containers hold no state: rebuild from the bundle, restore the data | `scripts/infra-artefacts.test.mjs`, `apps/api/src/security/security-headers.test.ts` |
| RW-03 | SQL or command injection | Read or rewrite data, run commands | Contract validation that refuses unknown fields; row level security on every tenant table | CodeQL, ZAP scans of the API | Point in time recovery | `allowlist.pipe.test.ts`, `request-validation.test.ts`, `rls-catalog.test.ts` |
| RW-04 | Privilege escalation inside the application | Reach administration or other tenants, then delete data | Policy guard on every command, negative matrix, maker-checker | Audit events with actor, target, reason | Tenant restore, cluster restore with checksum comparison | `negative-matrix.test.ts`, `policy-guard.test.ts`, `audit-events.test.ts` |
| RW-05 | Session, token or administrator takeover | Operate as an administrator | Mandatory second factor (aal2 for platform roles), rotating refresh tokens, PKCE, session revocation | Audit of sign-ins and step-up | Backups an administrator cannot delete (writer cannot delete locked versions) | `infra-artefacts.test.mjs`, `jwt.test.ts`, `user-session-deny-list.test.ts` |
| RW-06 | Password guessing, credential stuffing | Sign in as a user | 5 failures lock 15 minutes, second factor after the password, passwords only in the directory | Lockout events (identity test plan) | Disable the directory group | `infra-artefacts.test.mjs`, `infra-check.test.mjs` |
| RW-07 | Exploit of a vulnerable third-party component | Get in through a published flaw | Pinned versions and digests, audit that fails on high advisories, native dependency check | Dependency review, image scan, SBOM | Signed offline bundle: upgrade and rollback | `supply-chain-check.test.mjs`, `infra-artefacts.test.mjs`, `onprem-bundle.test.mjs` |
| RW-08 | Direct access to the database or the backups | Encrypt, delete or exfiltrate data and backups | Internal networks without published ports; client-side encrypted backups; writer cannot delete or shorten locks; COMPLIANCE object lock; separate archive repository with own bucket, credentials and pass phrase; offline copy | Weekly repository verification, live lock probe, WAL and backup-age alerts | Restore drills with a ledger; `drill-status` reports overdue | `backup-verify.test.mjs`, `backup-cycles.test.mjs`, `egress-rules.test.mjs` |
| RW-09 | Command and control, data exfiltration | Call out to fetch tools or send data | Only db, backup and keycloak have a route out; the host firewall allows the object store and the directory and drops the rest | Dropped connections in the host log | Isolate, rebuild from the bundle, restore | `egress-rules.test.mjs`, `infra-security.test.mjs` |

## The copy separated from operations

YCK.07 asks for at least one copy that ransomware cannot reach. The package gives two layers (`docs/runbooks/infra/backup-immutable.md`):

1. **Immutable**: both repositories are object-locked buckets in COMPLIANCE mode written with an identity that cannot delete or shorten locked versions, and the bucket administrator is a different person from the backup writer. The archive repository (monthly full backup, twelve kept, 400 day lock) has its own bucket, credentials and pass phrase, so one compromised credential never reaches both.
2. **Offline**: once a month two custodians copy the monthly full backup to write-once or disconnected media that never touches a production host.

## How it is proven

* Offline, on every build: the catalogue, the egress script and its rules, the compose wiring of the scanner, the realm import rules and the backup policy are checked by `npm run infra:check`; each rule has a test with a mutated copy that must fail.
* Against fakes: the ClamAV adapter is exercised against a fake clamd server (clean, infected, error reply, garbage, silence, closed port, oversize file); the egress rules are evaluated for allowed and non-allowed destinations.
* Not proven here (done in the lab, `lab-install-checklist.md`): a real clamd with the EICAR file, the real Keycloak import, the real firewall on a Linux host with a blocked connection, the object lock probe against the customer's object store, the first restore drill.

## Assumptions about the customer's estate

Endpoint protection on the machines that sign in; mail filtering; the administrators of the host and of the object store are different people with separate accounts; the media of the offline copy is stored in another room; the directory is monitored. If one of these is absent the residual risk of the scenario that relies on it rises, and the penetration test report should say so.
