# SAS_SUPPORT_ACCESS_ACTIVE

**Owner:** platform-oncall · **Severity:** warning · **Rule:** `alerts/rules/SAS_SUPPORT_ACCESS_ACTIVE.json`

## What it means

The gauge `support_access_active` is the number of support access grants in force across all tenants, as counted by the job `support-access-lifecycle` (every minute, `docs/runbooks/jobs.md`): approved by everybody the grant needs, not revoked, inside its window (at most 8 hours). Each of them lets an operator of the platform read, or read and write, the data of one tenant (BR-SAS-16). A few at a time is normal during an incident; more than five at once, or a number that does not go down by the end of the day, is unusual.

## What to do

1. Look at each tenant's grants (SAS-19, `get_resources_support_access_grant`): the ticket, the operator, the modules, the window and the two approvers of a write. Every request of an operator inside a grant is in the audit trail of the tenant as `support_access.used`, with the operator as the impersonator.
2. A grant that has no live ticket behind it, or an operator who should not be in, is revoked by the tenant (`revokeSupportAccess`): it takes effect on the operator's next request. The platform cannot revoke a grant of a tenant: ask the owner of the tenant.
3. A number that does not fall when the windows end means the job does not run: check `support-access-lifecycle` in `docs/runbooks/jobs.md`. The guard does not depend on the job (it judges the window itself on every request), so the access has already ended; only the record and this figure are late.
