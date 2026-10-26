# Supply chain: pins, lockfile, SBOM and audit (K0)

What ships is what the lockfile says. Four checks make that true and leave evidence for a reviewer or an auditor.

| Check | Command | Fails when |
|---|---|---|
| Pinned sources | `npm run supply-chain:check` | a dependency floats (`*`, `latest`, `>=1`, `1.x`, a dist-tag, a range with `\|\|`), comes from a URL, a path or a git reference without a full commit, or is a `^`/`~` range under the `exact` policy |
| Lockfile in sync | `npm run supply-chain:check` | `package-lock.json` is missing, a workspace is not in it, a manifest and the lockfile disagree on a dependency, a dependency has no locked package, or the locked version does not satisfy the manifest |
| SBOM | `npm run sbom`, then `npm run supply-chain:check` | the CycloneDX document is missing or malformed: it needs the format and spec version (1.4 to 1.6), a serial number, a timestamp, and for every component an npm `purl` and (third-party only) a hash |
| Images | `npm run supply-chain:check` | a Dockerfile exists, `supply-chain.json` has no `imageScan` policy (`tool`, `failOn`), or a base image has neither a digest nor a tag other than `latest` |
| Audit | `npm run supply-chain:check -- --audit` | `npm audit` reports a vulnerability at or above the policy level |

Sibling workspace packages (`"@machvon/kernel": "*"`) are linked, not downloaded, so they are exempt from the pin rules, but only when the lockfile really links the name to that workspace directory; a dependency that merely shares a workspace name and resolves from a registry or a source is checked like any other. A dependency pinned to a full git commit must also have a locked package that resolves to that commit. An unknown `auditLevel` (policy or `--audit-level`) fails the check instead of being read as `critical`.

## Policy: `supply-chain.json`

```json
{ "rangePolicy": "lockfile", "auditLevel": "high", "auditScope": "production" }
```

- `rangePolicy`: `exact` (default: every external dependency is an exact version) or `lockfile` (a `^`/`~` range is
  accepted when the locked version satisfies it, because `npm ci` installs exactly the lockfile). This repository uses
  `lockfile`: its manifests carry caret ranges, and the lockfile is the pin. Moving to `exact` is a one-line policy change
  plus pinning the manifests; the check will list every dependency that still has a range.
- `auditLevel`: lowest severity that fails the audit (`low`, `moderate`, `high`, `critical`), default `high`; any other value is rejected.
- `auditScope`: `production` (default, `npm audit --omit=dev`) or `all`.
- `imageScan`: `{ "tool": "trivy", "failOn": "HIGH" }`, required as soon as the repository holds a Dockerfile.

## Exceptions to the audit (`auditExceptions`)

A finding that cannot be fixed yet (no fixed release, a path that is not reachable) is accepted for a time, in the policy file and in review, never silently:

```json
{ "auditExceptions": [ { "package": "bad-package", "advisory": "GHSA-aaaa-bbbb-cccc", "owner": "security@example.org", "reason": "No fixed release yet; the call path is not reachable", "expires": "2026-12-01" } ] }
```

- All five fields are required; `reason` has at least 10 characters; `expires` is a day as `YYYY-MM-DD`.
- It excepts exactly that package and that advisory (the GHSA or CVE id at the end of the advisory link; the numeric id when the report has no link) and nothing else.
- `expires` is at most 90 days ahead (a quarter). A last day that is past, a longer one or an incomplete entry is a finding (`EXCEPTION_EXPIRED`, `EXCEPTION_TOO_LONG`, `EXCEPTION_INVALID`) and excepts nothing, so the vulnerability is red again until someone fixes it or decides again.
- Every run prints `EXCEPTED: package advisory (severity) until day, owner ...` for each exception in force, so the report shows what is being carried.

A red audit names each package with its advisory id: `bad-package GHSA-aaaa-bbbb-cccc (high)`. A report that only counts vulnerabilities without naming them still fails (with the counts) and cannot be excepted.

## The daily audit (`.github/workflows/supply-chain-daily.yml`)

A new advisory can be published for a dependency that was clean yesterday, so the same audit runs every day at 02:17 UTC (and on demand). npm is audited from the lockfile with the exceptions above; the pub packages of the mobile clients are audited by the OSV scanner from their `pubspec.lock` (a package without a lockfile has nothing locked to audit and says so). When either fails, the workflow opens one issue labelled `supply-chain` and `security`, **assigned to the owner**, with the end of the log and the link to the run; the next day's failure comments on the same issue instead of opening another. The owner is the repository variable `SUPPLY_CHAIN_OWNER` (the repository owner when it is not set). The run then fails, so the failure is also visible in the Actions list. The alert therefore reaches a named person within 24 hours of the advisory being published, as the advisory databases are updated.

## Offline audit

`npm audit` needs the registry. When it cannot be reached (`ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`, timeouts) the gate
prints `SKIPPED: dependency audit ...` and does not count as a pass; the exit code stays 0 so that a laptop without a
network can still run the other checks. Any other answer that is not an audit report fails the gate. CI always has a
network, so a skipped audit in CI is a CI problem to look at, not a pass.

## SBOM

`npm run sbom` writes `dist/sbom.cdx.json` (CycloneDX JSON from `npm sbom --package-lock-only`), and writes nothing when
the document is not valid. CI publishes it as the artifact `sbom-cyclonedx` for every run. To answer "are we affected by
CVE-X", search the artifact for the package name and version; the `purl` is the join key to vulnerability databases.

## When a check fails

| Finding | Fix |
|---|---|
| `LOCKFILE_OUT_OF_SYNC` | run `npm install`, review the lockfile diff, commit both files |
| `UNPINNED_RANGE` / `FLOATING_SPEC` | write the exact version that the lockfile resolves |
| `UNPINNED_SOURCE` | publish to or use the registry version, or pin the full 40 character commit |
| `SBOM_*` | `npm run sbom`; if npm itself fails, fix the lockfile first |
| `IMAGE_*` | add the `imageScan` policy and pin the base image by digest |
| `AUDIT_VULNERABLE` | upgrade the package; if no fix exists, record the decision in the ticket and lower nothing silently |

## Known open item

Development-only vulnerabilities (`npm audit` without `--omit=dev`) are not a gate yet: the `vitest 4.x` chain pulls
`tinypool` (critical, test runner only) and `@vitest/mocker`, and the fix is the breaking `vitest 5`. They do not ship in
any runtime artifact. Track the upgrade in TODOS.md; set `auditScope` to `all` once it is done.
