-- Authored by hand (not generated): the system role STAFF_MEMBER and its grant to the people of the STAFF who exist (PWF 20.9, lane fix12). Without it a member who holds only MEMBER cannot read their own tasks, scores,
-- approvals or reminders: the home "Việc hôm nay" of an officer had nothing to read. seedSystemRoles inserts a missing role but never changes an existing one, so the role is added here with the same permissions as
-- packages/db/src/system-roles.ts, for the tenants that were seeded before it. It is a role for the people of the tenant: it is never granted to a membership of another type (a guest, a contractor, a service account).
-- Expand step of an expand-contract change: the code before this migration neither reads nor writes the role, and a grant of it is only a grant. No contract step is planned.
-- Idempotent: a role that exists is left alone; a person who holds an active grant of it on their unit is given none again.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition and role_grant have FORCE row-level security, so only that connection can reach the rows of every tenant at once. The creator of the role is the creator
-- of the TENANT_OWNER role of the same tenant, as in V2523.
INSERT INTO machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, guest_allowed, status, created_by)
SELECT o.tenant_id, gen_random_uuid(), 'STAFF_MEMBER', 'iam.role.STAFF_MEMBER.name',
       ARRAY['session.self', 'notification.self', 'pwf.task.work', 'staff_score.read_own', 'approval_task.read', 'pwf.preference.own']::text[], 6, true, false, 'Active', o.created_by
  FROM machvon.role_definition o
 WHERE o.code = 'TENANT_OWNER' AND o.is_system
ON CONFLICT (tenant_id, code) DO NOTHING;

-- Every person of the STAFF who is invited, active or suspended receives the role on their own unit, as the default role of an invitation does (UNIT_ONLY). The scope version of each is raised so that the access held in cache is read again.
WITH given AS (
  INSERT INTO machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
  SELECT m.tenant_id, gen_random_uuid(), m.id, r.id,
         jsonb_build_object('kind', 'UNIT_ONLY', 'ref_ids', jsonb_build_array(m.organization_id), 'path_prefixes', jsonb_build_array(u.path)),
         now(), 'UNIT_ONLY', ARRAY[m.organization_id], 'Active', r.created_by, 'default role of the staff'
    FROM machvon.membership m
    JOIN machvon.organization_unit u ON u.tenant_id = m.tenant_id AND u.id = m.organization_id
    JOIN machvon.role_definition r ON r.tenant_id = m.tenant_id AND r.code = 'STAFF_MEMBER' AND r.is_system
   WHERE m.membership_type = 'STAFF'
     AND m.status IN ('Invited', 'Active', 'Suspended')
     AND NOT EXISTS (
       SELECT 1 FROM machvon.role_grant g
        WHERE g.tenant_id = m.tenant_id AND g.membership_id = m.id AND g.role_id = r.id AND g.status = 'Active')
  RETURNING tenant_id, membership_id
)
UPDATE machvon.membership m
   SET scope_version = m.scope_version + 1
  FROM given
 WHERE m.tenant_id = given.tenant_id AND m.id = given.membership_id;
