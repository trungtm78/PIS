# Lab install checklist (first installation on a test host)

Purpose: everything that `npm run infra:check` and the unit tests cannot prove because it needs a real daemon, directory or object store. Run it once on the lab host before the UAT installation, record the result of every line, and keep the filled copy with the minutes. A line that fails is a finding; do not skip a line, mark it `N/A` with the reason.

Preconditions: the offline bundle of the release candidate (`onprem-install.md`), a Linux host (amd64 or arm64), a test directory (AD/LDAPS) with the group prefix of `ad-group-role-map.json`, a test object store with two buckets, a test mail relay is not needed. Use generated test secrets only.

## A. Bundle and install

- [ ] `sh verify.sh` of the bundle passes (checksums, manifest, both architectures).
- [ ] `sh install.sh` ends with all health checks green (`docker compose ps`: every service healthy, including `clamav`).
- [ ] `docker compose exec api node -e "console.log(process.env.MACHVON_SCAN_ADAPTER)"` prints `clamav`.

## B. Keycloak realm import (G16: first import into a running server)

- [ ] The log of `keycloak` shows the realm `machvon` imported with no error and no warning about an unresolved `${...}` placeholder.
- [ ] `https://<host>/idp/realms/<realm>/.well-known/openid-configuration` answers.
- [ ] The realm has the 7 authentication flows of the file, the browser flow is `machvon browser`, level 1 and level 2 conditions exist.
- [ ] The LDAP provider `corporate-directory` connects (Test connection) over LDAPS with the CA in `ldap_ca_cert`; a user of the test directory appears after the first sign-in.
- [ ] A test user in a `MACHVON-*` group gets exactly the roles of `ad-group-role-map.json`; a user in another group gets none.
- [ ] Mandatory second factor: first sign-in forces the TOTP enrolment; a platform role forces WebAuthn (`identity-test-plan.md`).
- [ ] Five wrong passwords lock the account for 15 minutes (temporarily); the sixth correct one within the lock is refused.
- [ ] Record the Keycloak version and the import result in the minutes (`infra/keycloak/onprem/machvon-realm.json` sha256).

## C. Malware scan (G16)

Follow the verification steps of `malware-scan.md` (EICAR refused, ordinary PDF released, scanner stopped holds files and refuses portal uploads, held file released after restart). Record the signature date.

## D. Egress allowlist (G16: negative test on a real host)

- [ ] `sh egress-firewall.sh <object store> 443 <directory> 636 --apply` as root; the chain `MACHVON-EGRESS` is hooked into `DOCKER-USER`.
- [ ] From the `db` container the object store answers on 443; the directory answers from the `keycloak` container on 636.
- [ ] From the `db` container a connection to a host that is not on the allowlist (for example `1.1.1.1:443`) times out or is refused; the same from `keycloak`.
- [ ] From `api` and `workers` no connection leaves the host at all.
- [ ] The rules survive a reboot (distribution's iptables service).

## E. Backup cycles and immutability (G15)

- [ ] `docker compose --profile tools run --rm backup check` passes; `backup --type=full` succeeds.
- [ ] `backup --type=diff` and `backup --type=incr` succeed; `backup --type=full --repo=2` succeeds into the archive bucket.
- [ ] `pgbackrest info` shows the backups and the WAL range for both repositories; at least 3 backups are kept.
- [ ] `systemctl list-timers 'machvon-backup*'` shows full, incr, diff, monthly and verify timers.
- [ ] `node scripts/backup-verify.mjs live --bucket <operational> --endpoint <url> --archive-bucket <archive> --probe` passes: lock, versioning, encryption, and a locked version cannot be deleted or shortened.
- [ ] The offline copy procedure was walked through once with two custodians (`backup-immutable.md`, Offline copy); media label recorded.
- [ ] The manual backup request: a request is recorded by one person, approved by another, run by the host runner, and the screen shows the new backup label.

## F. Restore drill (G15: the first entry of the ledger)

- [ ] Run the procedure of `restore-drill.md` on a clean host from repo1; then once from repo2 or the offline media.
- [ ] `restore:drill compare` verdict `matches`, RPO and RTO within target.
- [ ] Append the entry to `infra/backup/restore-drill-ledger.json` (two people), `node scripts/backup-verify.mjs drill-status` prints `CURRENT`.

## G. Security scans against the running stack (G16)

- [ ] ZAP baseline and API scan (`dast.yml` rules) run against the lab URL; no new high finding.
- [ ] The independent penetration test is scheduled with the pack `pentest-readiness.md` and the catalogue `ransomware-scenarios.md` (outside this checklist).

## H. Sign-off

Names of the operator and the witness, date, release version, host sizing used (compare with `sizing-uat-prod.md`).
