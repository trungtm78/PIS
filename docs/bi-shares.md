# Sharing a dashboard (ST-BI-007)

BI 3 F6: the owner of a dashboard gives a person, a role or a unit the right to see its layout (or to change it) and takes it back at once. A share gives no data.

## The share

`POST /bi/dashboards/{id}/shares` (`shareDashboard`, `bi.dashboard.share`, `If-Match` the version of the dashboard) with `grantee_kind` (`USER`, `ROLE`, `UNIT`), `grantee_ref_id` and `permission` (`VIEW`, `EDIT`). Only the owner shares (403 `SCOPE_DENIED` for a person who sees the dashboard and does not own it, 404 for one who does not see it). The grantee must be of the tenant: a membership that is active, a role, an organization unit; anything the tenant does not hold (another tenant's person included, since the policies of the rows hide it) is 422 `GRANTEE_OUT_OF_TENANT`. Sharing with the owner is 422 `VALIDATION_FAILED`; a second active share for one grantee is 409 `STAGE_TRANSITION_DENIED` (the unique index of V002); an archived dashboard is 409.

`POST /bi/dashboard-shares/{id}/revocation` (`revokeDashboardShare`, `If-Match` the version of the share) ends it, once (409 `SHARE_STATE_INVALID` after). Sharing again after it ended is a new row. The dashboard is `SHARED` while it has an active share and `PRIVATE` when it has none (a dashboard in the library keeps its audience); its version moves with each.

Audit: `bi.dashboard.share`, `bi.dashboard.share_revoke`. Events: `bi.dashboard.shared.v1`, `bi.dashboard.share_revoked.v1`.

## What a share reaches

A dashboard is seen by its owner, by whoever the tenant library shows it to, and by whoever an active share reaches: a share to a person (the membership), to a role held now, or to a unit the member belongs to **or is under** (sharing with a unit reaches its subtree). The right is judged when the dashboard is asked for, never kept, so a revocation is felt at the next read: the dashboard is 404 for the person (`getDashboard`, the library, the versions). `permission` on the dashboard is what the viewer may do: `OWNER`, `EDIT`, `VIEW` (null in the library only); `may_edit` is true for the owner and for `EDIT`, and a person with `EDIT` saves versions (`saveDashboardVersion`), which stay theirs (the version of a dashboard is published by someone else). Sharing, revoking and asking to publish remain the owner's.

`getDashboard` lists the shares (with the names of the grantees) to the owner only; a person it is shared with sees `shares: []`.

A share gives no data: the figures are asked for with `/dashboard-queries`, which judges the policies and the scope of the person who asks, and answers with the label of the scope (`YOUR_SCOPE` or `FULL_TENANT`). A person with a share and no right to query reads no figure (UAT-AC35: the staff member of one unit sees the layout of D-2 and a total that is not the leader's).

## In the database (V1584)

`dashboard_share`: a state check (ACTIVE has no end, REVOKED has one) and `guard_dashboard_share` (the dashboard, the grantee, the permission and who shared never change; ACTIVE moves to REVOKED once and the moment it ended is written once; nothing is deleted), `DELETE` and `TRUNCATE` revoked.

## Screen

**BI-17** `DashboardShareScreen`: the dashboards of the caller to pick from, the warning that a share gives no data, who the dashboard is shared with (with the state, and a revoke button on the active ones), and the form to share with more (kind, id, permission), with the refusals told by their reason. A person who is not the owner, holds no share right, is in a read-only session or has an archived dashboard only sees the list. BI-01 leads to it from the dashboards that are the caller's.

## What is not done

- The grantee is given by id (the contract has no directory of people, roles or units to pick from); the screen does not look the name up before the share.
- The page of a shared dashboard in BI-03 for a person with `EDIT` is the same builder as the owner's (it is gated by `may_edit`), with no mark of whose dashboard it is beyond the owner shown in the library.
