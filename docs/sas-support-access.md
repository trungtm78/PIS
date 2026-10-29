# Controlled support access (ST-SAS-015, SAS.md 3.9, BR-SAS-16)

A Support Operator of the platform reads the data of a tenant only with a **ticket**, the **consent of the tenant** and for **no more than 8 hours**; everything they do is audited as an impersonation. Write access needs two different people of the tenant. An operator can neither approve, extend nor revoke their own access.

## The rows and the rules

`support_access_grant` (V002 and **V1488**): `status` Requested → Approved → Active → Expired, or Rejected / Revoked; `access_mode` READ_ONLY or READ_WRITE; `owner_approved_by` (the first approver), `second_approver_id`; `starts_at`, `expires_at`; `scope_json` holds the modules, the resources and the minutes asked for.

The table holds what the application relies on (V1488): the window is at most 8 hours; the first approver is not the operator; a read-write grant cannot be in force without two different approvers (the old check refused the request itself, which has none yet); what was asked for (ticket, operator, mode, scope, reason, time) and an approval never change; a grant that ended is final; nothing deletes one; one open grant for an operator and a ticket at a time.

Pure rules are in `packages/kernel/src/sas-support-access.ts`; the store is `packages/db/src/support-access-store.ts`.

| Step | Who | Operation | What happens |
| --- | --- | --- | --- |
| Ask | Support Operator (`system.support.request`, control plane) | `requestSupportAccess` | The ticket must be one of the tenant and not closed (404 `TICKET_NOT_FOUND`, 409 `SUPPORT_GRANT_INVALID`); 15 to 480 minutes (400 outside, as ST-SAS-015 AC-2 says); one open request per operator and ticket. The command acts as the tenant, so the row, the audit and the event are the tenant's. It gives nothing. |
| Decide | TENANT_OWNER / TENANT_ADMIN (`tenant.support.approve`) | `post_support_access_id_approve` | Approve or reject (a reason of ten characters). A read is in force at the approval (from `starts_at` if given, at most a week ahead). A write needs a second, different person (403 `SELF_APPROVAL_DENIED`); until then it is in force for nobody. The window (`starts_at` + the minutes asked for, at most 8 hours) is fixed by the approval that completes the grant. If-Match version (409 `VERSION_CONFLICT`). |
| Take back | the same people | `revokeSupportAccess` | At any time while the grant is open; the operator is out on their next request (409 `SUPPORT_GRANT_INVALID` once it ended). |
| End | the job `support-access-lifecycle` (every minute) | | Approved → Active at its start, Active → Expired at its end, a request nobody decided on within a week lapses. The guard does not wait for it. |
| Read | the tenant (`support_access_grant.read`) | `get_resources_support_access_grant` (+ `_id`) | Who, for what, when, until when, who approved, and `in_force`. `status` is the status at the time of the read and `in_force=true` keeps the grants that let their operator in now; both are judged before the page is cut, so the banner of SAS-19 (which asks for `in_force=true`) does not depend on the pages of the history. |

TENANT_ADMIN holds `tenant.support.approve` and `support_access_grant.read` since V1489 (TENANT_OWNER holds them through `tenant.*` and `support_access_grant.*`); the seed and the backfill are the same as for the MEMBER support-ticket permissions.

## How the operator gets in

The operator has no membership of the tenant and a control token is refused on the tenant plane (403 `SCOPE_DENIED`, with a `authz.denied:<operation>` audit row for the tenant: the operator who reaches for business data leaves a trace even when they only read). They get in with a **support token**: a tenant token with `act=support`, `gid` (the grant) and `opr` (the operator, who is the membership of the context). Ordinary tenant tokens never carry these claims; the verifier refuses an `act` that is not `support`, a missing grant or operator, an operator who is not the membership, and a control audience. `LocalTenantTokenIssuer.issue({ support })` makes one and ends it with its grant.

The operator gets it from `issueSupportAccessToken` (`POST /support-access/{id}/token`, control plane, `system.support.request`, body `{ tenant_id }`): the grant must have been given to this operator and be in force, otherwise 403 `SCOPE_DENIED` and a denied audit row of the tenant (`support_access.token_denied`); the answer is a token of at most five minutes that ends with the grant (the operator asks again), with `Cache-Control: no-store`, after the audit row `support_access.token_issued` (operator as the impersonator) is written. It is not an idempotent command, so the token is never kept in an idempotency record. The session of the token is the operator's own, of the control plane: the authentication guard does not look it up as a tenant session; what ends a support token is its grant. Without an issuer (`supportIssuer`, or the session module's) the exchange answers 503 `SIGNING_KEY_UNAVAILABLE`.

The policy guard (`apps/api/src/policy.guard.ts`, `support-gate.ts`) judges the grant **on every request**, from the database:

1. the grant of this tenant is approved by everybody it needs, not revoked, inside its window, and was given to this operator (`isSupportGrantLive`);
2. the operation belongs to one of the modules of the grant (the first tag of the operation in `openapi.json`, else the module of its resource, generated as `MODULES`: the resource reads carry no tag, so `RESOURCE_MODULES` in `packages/contracts/src/generate.ts` places them; the audit trail, the devices of a person, the internals of the platform, proposals and the record of the tenant itself belong to no module, so no grant reaches them), is a read when the grant is read-only, and when the grant names resources the path names one of them;
3. the permissions are those of the operations of those modules on the tenant plane, **except** `tenant.support.*`, `system.*` and anything that asks for a second factor: a support token cannot approve, extend or revoke its own access, nor grant roles. Nor does it give the audit trail of the tenant (`audit.*`, `audit_event.*`: its reads and its export) or what reads across modules without asking each one (`search.*`, `home.*`, `sync.*`): the results of those are not narrowed by the modules of a grant.

Otherwise 403 `SCOPE_DENIED` and a denied audit row that names the operator as the impersonator. An allowed request writes `support_access.used` (operation, method, mode) with `impersonator_id`; if that row cannot be written the request does not go on. A command run under a support token is audited with `impersonator_id` too. A revocation or the end of the window takes effect on the next request.

## Screen SAS-19

`SupportAccessScreen`: the request form for the operator (tenant id, ticket, modules, mode, minutes, reason; it gives nothing, and says so); for the people of the tenant a banner while a grant is in force, the list of requests with the number of consents, and approve, reject and revoke with a reason. The seven states come from `StateBoundary`; there is no button to extend a grant.

## Telemetry and alerts

Counter `authz_decision_total{reason="SUPPORT_GRANT"}` for a support token the grant does not let in; the gauge `support_access_active` and the alert `SAS_SUPPORT_ACCESS_ACTIVE` (`docs/runbooks/alerts/`); the job in `docs/runbooks/jobs.md`. No personal data: the audit and the metrics carry ids.
