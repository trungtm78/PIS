# SAS_DOMAIN_FAILED

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_DOMAIN_FAILED.json`

## What it means

The gauge `tenant_domain_failed_total` is the number of domains of tenants that are `Failed` or whose certificate is `Failed`, as counted by the job `tenant-domain` (every 5 minutes, `docs/runbooks/jobs.md`). A domain fails when the TXT record that proved it was found gone at the weekly recheck (`failure_code` `TXT_NOT_FOUND`, status Failed) or when its challenge was answered too late (`CHALLENGE_EXPIRED`); its certificate fails when the authority could not issue or renew it (`TLS_FAILED`, `tls_status` Failed, the domain keeps its status and the job tries again at each pass). A Failed domain no longer chooses the tenant at sign-in; the tenant itself, its people and its other domains are not touched.

## What to do

1. List the domains of the tenant (`GET /system/tenants/{tenantId}/domains`, screen SAS-05) and read `failure_code` and `last_checked_at`.
2. `TXT_NOT_FOUND` or `CHALLENGE_EXPIRED`: ask the customer whether the TXT record was removed on purpose. If not, they publish it again and the System Admin chooses Check (`verifyTenantDomain`); a domain that is found again becomes Verified and the job gives it a certificate. If the customer gave the domain up, remove it (`removeTenantDomain`): the name is then held for 90 days.
3. `TLS_FAILED`: check the certificate authority (the port is the MOCK until a real one is bound, `TODOS.md` ST-SAS-017). The job tries again at each pass, so the certificate is issued as soon as the authority answers; nothing needs to be done to the domain.
4. Do not edit `tenant_domain` in the database: the guards refuse a change of what a domain is and a release is final. The directory table `tenant_domain_directory` is kept by a trigger, not by hand.
