-- Authored by hand (not generated): the three system roles of the committee (COMMITTEE_HEAD, COMMITTEE_MEMBER, COMMITTEE_SECRETARIAT) for the tenants that were seeded before them, and the right to read the audit of views
-- of the committee workspace for the security administrator and the auditor (BAN-1, docs/committee-workspace.md). seedSystemRoles inserts a missing role but never changes an existing one, so the roles are added here with
-- the same permissions as packages/db/src/system-roles.ts. The creator of a role is the creator of the TENANT_OWNER role of the same tenant. Idempotent: a role that exists is left alone, a permission already held is not added twice.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
INSERT INTO machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, guest_allowed, status, created_by)
SELECT o.tenant_id, gen_random_uuid(), r.code, r.name, r.permissions, r.rank, true, false, 'Active', o.created_by
  FROM machvon.role_definition o
 CROSS JOIN (VALUES
   ('COMMITTEE_HEAD', 'iam.role.COMMITTEE_HEAD.name', 62, ARRAY['committee.read', 'committee.attention.decide', 'committee.alert.acknowledge', 'home.read', 'approval.decide', 'directive.read', 'directive.manage', 'directive.meeting.manage', 'directive.extension.decide', 'directive.close', 'rpt.read', 'rpt.approve']::text[]),
   ('COMMITTEE_MEMBER', 'iam.role.COMMITTEE_MEMBER.name', 55, ARRAY['committee.read', 'home.read', 'directive.read', 'rpt.read', 'rpt.check']::text[]),
   ('COMMITTEE_SECRETARIAT', 'iam.role.COMMITTEE_SECRETARIAT.name', 52, ARRAY['committee.read', 'committee.manage', 'committee.attention.decide', 'committee.alert.evaluate', 'committee.alert.acknowledge', 'home.read', 'directive.read', 'directive.manage', 'directive.meeting.manage', 'rpt.read', 'rpt.generate', 'rpt.issue', 'rpt.deliver']::text[])
 ) AS r(code, name, rank, permissions)
 WHERE o.code = 'TENANT_OWNER' AND o.is_system
ON CONFLICT (tenant_id, code) DO NOTHING;

UPDATE machvon.role_definition
   SET permissions = array_append(permissions, 'committee.audit.read'),
       version = version + 1
 WHERE code IN ('SECURITY_ADMIN', 'AUDITOR')
   AND is_system
   AND NOT ('committee.audit.read' = ANY (permissions));
