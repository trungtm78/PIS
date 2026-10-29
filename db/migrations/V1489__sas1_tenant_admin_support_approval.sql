-- Authored by hand (not generated): the administrators of a tenant decide on a support access request together with its owner (ST-SAS-015, SAS.md 2 and 3.9: "chấp thuận bởi TENANT_OWNER/TENANT_ADMIN"; a write needs two
-- different people, so two people of the tenant must be able to approve). TENANT_ADMIN gets `tenant.support.approve` and `support_access_grant.read`. Tenants seeded before this keep the old permission list, because
-- seedSystemRoles inserts a missing role but never changes an existing one (as V1241 did for MEMBER). Idempotent: a role that holds both is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = permissions || ARRAY(SELECT p FROM unnest(ARRAY['tenant.support.approve', 'support_access_grant.read']) AS p WHERE NOT (p = ANY (permissions))),
       version = version + 1
 WHERE code = 'TENANT_ADMIN'
   AND is_system
   AND NOT (ARRAY['tenant.support.approve', 'support_access_grant.read'] <@ permissions);
