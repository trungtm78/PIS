# Runbook: security scanning in CI

What runs, when it fails, who answers. Nothing here needs a secret of the product; nothing scans a customer's system.

| Check | Workflow and job | Fails when | Policy file |
|---|---|---|---|
| SAST | `security.yml` / `codeql` (JavaScript and TypeScript with the `security-extended` queries; the workflows themselves) | an alert at any severity is opened that the Security tab does not accept | repository code scanning settings |
| Secret scan | `security.yml` / `secrets` (gitleaks over the whole history) | any finding outside the allowances | `.gitleaks.toml` |
| Dependency audit | `ci.yml` (`npm run supply-chain:check -- --audit`), `supply-chain-daily.yml` (every day, opens an issue for the owner) | a high or critical advisory in production dependencies without a valid time-boxed exception | `supply-chain.json`, `docs/runbooks/supply-chain.md` |
| Dependency review | `security.yml` / `dependency-review` (pull requests) | a new dependency with a high advisory or a denied licence | the workflow |
| Filesystem scan | `security.yml` / `filesystem` (Trivy: vulnerabilities, secrets, misconfiguration of Dockerfiles, compose and workflows) | a HIGH or CRITICAL finding that has a fix | `infra/scan/trivy.yaml`, `infra/scan/.trivyignore` |
| Image scan | `images.yml` / `image` (each of api, workers, web, db, built natively on amd64 and on arm64, scanned and SBOM kept) | a HIGH or CRITICAL finding that has a fix | `infra/scan/trivy.yaml` |
| Multi-platform build | `images.yml` / `multi-platform` (QEMU build of both platforms and the plan of the offline bundle) | a build definition that does not build for both platforms | the Dockerfiles |
| ARM leg | `ci.yml` / `arm64` on `ubuntu-24.04-arm` (typecheck, unit tests, web build, native dependency check) | anything that passes on x86 and fails on ARM | `infra/onprem/native-deps.json` |
| DAST baseline and API scan | `dast.yml` (OWASP ZAP against a deployed **test** stack; scheduled weekly and on demand) | a rule at FAIL level in `.zap/rules.tsv` (missing security header, cookie flags, error disclosure, injection) | `.zap/rules.tsv` |
| Declarative infrastructure | `npm run infra:check` in `npm run lint` and the deploy preflight | a floating image tag, a secret literal, weak backup, missing MFA, a weaker TLS or header standard, a missing scan workflow | `infra/policies/`, `infra/policies/artefacts.json` |

## DAST: the test stack

`dast.yml` never runs against production or a customer. Install the compose set on a test host with synthetic data, then set the repository variables `DAST_WEB_URL` (`https://<test host>`) and `DAST_API_URL` (`https://<test host>/api`), and optionally the secret `DAST_BEARER_TOKEN` (a token of a test account, so the API scan reaches the operations behind the login). While the variables are empty the jobs print a warning and finish: **a scan that did not run earned no credit**, and the pen-test readiness checklist counts it as not done. Read the reports in the run's artifacts (`zap-baseline`, `zap-api`).

To run the same scan by hand: `docker run --rm -v "$PWD/zap:/zap/wrk:rw" -v "$PWD/.zap:/zap/rules:ro" zaproxy/zap-stable:2.17.0 zap-baseline.py -t https://<test host> -c /zap/rules/rules.tsv -r baseline.html`.

## Triage

| Severity | Respond within | Fix within |
|---|---|---|
| Critical, exploitable, or a leaked secret | 1 working day (rotate the secret first) | 7 days |
| High | 2 working days | 30 days |
| Medium | 5 working days | 90 days |
| Low and informational | next planning | as planned |

A finding that cannot be fixed in time is accepted for at most 90 days, in a reviewed file with an owner and a reason: `supply-chain.json` `auditExceptions` for npm advisories, `infra/scan/.trivyignore` for image findings (comment with owner and last day), `.zap/rules.tsv` for ZAP rules (a WARN or IGNORE row with the reason in the file and a link here). Lowering a level or deleting a check is not an exception.

## Adding or changing a check

Edit the workflow, its row in the table above, and the rule in `infra/policies/artefacts.json` that `npm run infra:check` enforces, in one change. The check refuses a repository that has lost one of these workflows or its content (for example CodeQL without `security-extended`, a scan without the policy file, an ARM leg without `ubuntu-24.04-arm`).
