-- Authored by hand (not generated): the system role PORTAL_CONTRACTOR (PORTAL-2; docs/plans/portal2.md) and the right to upload a file on the portal.
-- A contractor with no contract is let in through the registry (V2640), and its grant cannot be scoped to a contract. The role GUEST_CONTRACTOR holds `contract.read`, which on a scope wider than a contract would show
-- contracts of a unit, so the registry-bound guest gets a role of its own: the portal rights and nothing else. The portal itself checks the right anywhere on the grants of the caller and takes the contractor from the
-- membership, never from the grant. seedSystemRoles inserts a missing role but never changes an existing one, so the role is added here for tenants seeded before it, with the same list as
-- packages/db/src/system-roles.ts; the upload right is also appended to GUEST_CONTRACTOR. Idempotent.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
INSERT INTO machvon.role_definition (tenant_id, id, code, name, permissions, rank, is_system, guest_allowed, status, created_by)
SELECT o.tenant_id, gen_random_uuid(), r.code, r.name, r.permissions, r.rank, true, true, 'Active', o.created_by
  FROM machvon.role_definition o
 CROSS JOIN (VALUES
   ('PORTAL_CONTRACTOR', 'iam.role.PORTAL_CONTRACTOR.name', 10, ARRAY['vnd.portal.read', 'vnd.portal.respond', 'vnd.portal.certificate', 'vnd.portal.reconfirm', 'vnd.portal.remediation', 'vnd.portal.upload']::text[])
 ) AS r(code, name, rank, permissions)
 WHERE o.code = 'TENANT_OWNER' AND o.is_system
ON CONFLICT (tenant_id, code) DO NOTHING;

UPDATE machvon.role_definition
   SET permissions = array_append(permissions, 'vnd.portal.upload'),
       version = version + 1
 WHERE code = 'GUEST_CONTRACTOR'
   AND is_system
   AND NOT ('vnd.portal.upload' = ANY (permissions));
