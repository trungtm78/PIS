# INFRA-2: backup cycles, manual backup request, malware scanning, egress and ransomware evidence, sizing

Lane `lane/infra2` (worktree `D:\PIS-infra2`), migration block 2800-2819. Sources: customer specification HSKT v0.3 YCK.06 (backup) and YCK.07 (security), plan section ENT-3 gaps G15 and G16, plus the "UAT/Production recommended configuration" document of G17. Builds on INFRA-1 (`docs/plans/infra1.md`): the policy file, the artefact checker and the pentest pack are extended, not replaced. Nothing here starts docker, compose, a server, a scanner or a real backup.

Status legend: `[ ]` open, `[x]` done.

## Decisions (owner rule 2026-11-08: deepest governance, extensibility, no scope cut)

- Backup cycles. Repository 1 (operational, immutable bucket at the second site) keeps the existing daily full plus four-hourly incremental plus WAL, and gains a weekly differential (Sunday 02:30). Repository 2 is the separated copy: a monthly full backup (1st of the month 00:30, `--repo=2`) kept for 12 fulls, in a different bucket under a different identity with object lock (COMPLIANCE), or on media that is disconnected after the run (the offline variant). "Keep at least 3 latest backups" is a policy value (`retention.minimumBackups`) that the check holds against every retention number and against both repositories.
- Manual backup is a request, not a button that runs a command: a request (full, differential or incremental, reason) is recorded by one person and approved by another (maker-checker), the host runner (systemd, outside the API) executes the approved request and the outcome is recorded with the pgBackRest label. The API never runs a backup and has no access to the repository: it reads the last backup and verify state from a port (`BackupStatePort`, adapter reading the status file that the timers write from `pgbackrest info --output=json`; no adapter configured = state UNKNOWN, never a made-up value).
- Restore-drill evidence is a ledger file (`docs/runbooks/infra/evidence/restore-drill-ledger.json`) with a schema checked by `backup-verify`; its freshness against `maxDaysBetweenDrills` is reported by `drill-status` (a clock dependent check cannot live in the offline lint). The tenant restore store keeps doing the tenant level restores; the ledger is the evidence of the whole-cluster drill.
- Malware scanning: one port (`ScanPort`, the existing shared pipeline port) gets a ClamAV adapter that speaks clamd `INSTREAM` over TCP (host and port from `MACHVON_CLAMD_HOST` and `MACHVON_CLAMD_PORT`). The pipeline is closed by default: an unconfigured or failing scanner leaves the file PENDING (nothing can link or download it) and never CLEAN; an infected file is INFECTED (terminal, quarantined). The portal hook gets the same adapter behind `MACHVON_PORTAL_SCAN=CLAMAV` and maps any scanner failure to UNAVAILABLE. A ClamAV container is NOT added to the compose set: its image digest cannot be resolved offline and an unpinned image is refused by our own check; the operator supplies clamd and the runbook says how.
- Egress allowlist: the rule generator in `egress-firewall.sh` is exercised by a node test with a fake resolver (a destination that is not on the allowlist reaches the DROP rule and no ACCEPT rule names it); the artefact check additionally proves that only `db`, `backup` and `keycloak` join the egress network and that the script ends in DROP.
- Ransomware scenarios: `docs/security/ransomware-scenarios.md` plus `docs/security/ransomware-scenarios.json` (machine readable: scenario, entry point, controls, tests, residual risk). A checker (inside `infra-artefacts`) refuses a scenario without a control or a control whose test or file does not exist; the pentest pack lists the catalogue.
- Keycloak: an offline structural check of `machvon-realm.json` against the import rules of Keycloak 26 (unique ids and names, references between clients, roles, groups and flows resolve, no duplicate executions, required fields), plus a lab-install checklist for the real import (not run here).

## Steps

1. [x] Plan (this file), committed first.
2. [x] Backup policy v2: `backup-policy.json` (differential, monthly archive repo, minimumBackups, offline copy, drill ledger), pgBackRest template for the three cycles, systemd units, `backup-verify` rules and messages, `artefacts.json` entries. Tests: mutated copies of each rule fail with the named code.
3. [x] Restore drill ledger and `drill-status` command, runbook updates (restore, archive, offline copy). Tests: schema and freshness.
4. [ ] Malware scan adapter (`clamd` INSTREAM), closed by default, pipeline and portal wiring, quarantine view. Tests: fake clamd server (clean, infected, error, oversize, timeout, unconfigured).
5. [ ] Egress allowlist test, ransomware catalogue (md + json) and checker, pentest pack wiring, Keycloak import check, lab-install checklist. Tests: fixtures and mutated copies.
6. [ ] Sizing document `docs/runbooks/infra/sizing-uat-prod.md` and its check (required sections, the figures consistent with `infra/onprem/compose`).
7. [ ] Manual backup request: kernel rules, migration V2800, store, port and adapter, contract through `contract-patch`, controller and permissions (ADM), web screen with i18n part `infra2`, design rows, authz and isolation entries for the shared suites.
8. [ ] Gates after the pre-push gate is done: lint, typecheck, DB and API suites of the lane, shared suites once. Independent review (Codex when its limit allows, else a read-only reviewer subagent), triage, `git merge main`.

## Risks

- Everything is validated statically or against fakes: no pgBackRest, no object store, no clamd, no Keycloak was started. The report says so.
- The shared contract files (openapi, error codes, screen catalog) are edited only through `scripts/contract-patch.mjs`.
- DB and shared suites are not run while the gate of the other checkout runs; their entries are added and listed as not run.
