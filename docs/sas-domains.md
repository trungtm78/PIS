# Tenant domains and verification (ST-SAS-017, SAS.md 3.4, BR-SAS-06)

A tenant can have domains: a subdomain of the platform (`b.machvon.vn`) or a domain of its own (`dautu.minhha.gov.vn`). A domain that is **Verified or Active chooses the tenant that the sign-in starts from; it gives nobody a membership**. The System Admin attaches, verifies and releases domains on the control plane (screen SAS-05).

## Operations (control plane)

| Operation | What happens |
| --- | --- |
| `addTenantDomain` (`POST /system/tenants/{tenantId}/domains`, 201, `system.tenant.manage`) | `{hostname, kind}`; the hostname is lower case (422 otherwise). A **custom** domain starts `PendingVerification` and the answer carries the TXT record to publish: `txt_record_name` (`_machvon-verify.<hostname>`), `txt_record_value` (`machvon-verify=<token>`) and `expires_at` (seven days). **The value is shown once**: the platform keeps only its SHA-256, the list never shows it, and the answer kept for the replay of the idempotency key has it emptied (`@Command({ withheld })`: a replay returns the name and an empty value); if it is lost, adding the same hostname again (a custom domain of the tenant that still waits for its proof, or Failed) gives a new value and a new week. A **platform subdomain** (under `MACHVON_PLATFORM_DOMAIN`, one label, not `www`, `api`, `admin`…) needs no proof and is Active at once. A hostname held by another tenant is 409 `DOMAIN_TAKEN`; one released less than 90 days ago, or a name of the platform itself, is 409 `DOMAIN_TAKEN` with `reason: RESERVED`. |
| `verifyTenantDomain` (`POST /system/tenant-domains/{domainId}/verify`, 202, If-Match the version of the domain) | Looks for the token in the TXT records of the challenge name. Found: `Verified`, event `sas.domain.verified.v1`, and the job gives it a certificate and makes it Active. Not found: **422 `DOMAIN_UNVERIFIED`**, and the check (its time, `failure_code` `TXT_NOT_FOUND`) is kept: the refusal is raised after the commit. A challenge answered after its seven days makes the domain Failed (`CHALLENGE_EXPIRED`). A domain that is Verified or Active already is answered as it is. |
| `removeTenantDomain` (`POST /system/tenant-domains/{domainId}/remove`, If-Match) | The domain becomes `Revoked` (final), stops choosing the tenant at once and its hostname is **held for 90 days** (`reserved_until`), against every tenant including the same one. Event `sas.domain.revoked.v1`. |
| `listTenantDomains` (`GET /system/tenants/{tenantId}/domains`, `system.tenant.read`) | The domains of the tenant, newest first, with status, TLS, the time of the last check, the challenge deadline, the hold and the name of the TXT record while it is needed. |

A hostname belongs to one tenant on the whole platform. Row-level security hides the domains of other tenants from a tenant, so the control plane asks the table `tenant_domain_directory` (one row per hostname with the state of its latest domain, no row-level security, readable by the control role only, kept by the trigger `keep_tenant_domain_directory`, never by the application). Migrations **V1491**, **V1492** (backfill); rules in `packages/kernel/src/sas-domain.ts`; the store in `packages/db/src/tenant-domain-store.ts`.

## The job `tenant-domain` (every 5 minutes)

A Verified domain gets its certificate through the certificate port and becomes Active (TLS Issued, 90 days). An Active custom domain is looked at again when seven days have passed since its last check; the proof gone makes it Failed (`TXT_NOT_FOUND`) so it no longer chooses the tenant. A certificate with 14 days left is renewed. A certificate that cannot be issued leaves `tls_status` Failed (`TLS_FAILED`) and is tried again at each pass. The pass is idempotent; the gauge `tenant_domain_failed_total` counts the domains that are Failed or whose certificate is Failed (alert `SAS_DOMAIN_FAILED`).

## Sign-in

The web sign-in (`OidcSessionProvider`) sends the host of the page in the header `X-Tenant-Host` with every request of the identity (the API allows the header in CORS), and the chooser (IAM-04) shows the `preselected` membership first. `GET /me/session/tenant-selection/candidates` (host from the header, or `?host=<hostname>`) marks `preselected: true` on the memberships of the tenant that has a Verified or Active domain on that host, and `POST /me/session/tenant-selection` with the header `X-Tenant-Host` refuses any other tenant: **403 `TENANT_SELECTION_INVALID`**, the answer a membership that is not the caller's gets, naming no tenant. A host nobody has proved (the platform's own, a domain still pending, anything that is not a hostname) chooses nothing. The host is part of the request hash, so the same idempotency key with another host is another request. The list of candidates still holds the memberships of the caller only: a domain never adds one.

## Screen SAS-05

`DomainsScreen`: the tenant picker, the form to add a domain (hostname and kind), the TXT record shown once with a button to hide it, the list (domain, status, TXT name and deadline, TLS and its end, last check, the hold of a released domain) and the check/remove actions with a reason of ten characters. A reader of the registry sees the list only. The list is read again every five seconds while a domain waits for its certificate and every minute otherwise. The seven states come from `StateBoundary`.

## Telemetry and alerts

The gauge `tenant_domain_failed_total` and the alert `SAS_DOMAIN_FAILED` (`docs/runbooks/alerts/`); the job in `docs/runbooks/jobs.md`. Audit actions: `tenant.domain_added|verified|unverified|removed|activated|failed|certificate_renewed|certificate_failed` (no token in any of them). Events: `sas.domain.verified.v1`, `sas.domain.revoked.v1`.
