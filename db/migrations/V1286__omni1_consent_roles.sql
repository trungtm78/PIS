-- Authored by hand (not generated), ST-OMNI-003: the omnichannel agents take and withdraw the consent of the contacts (`omni.consent.manage`: OMNI.md 2, "quản lý danh bạ/consent"), and both omnichannel roles read the consents (`contact_consent.read`, the generic
-- read the screen OMNI-04 calls, which `omni.*` and `omni.conversation.*` do not cover). Tenants seeded before this keep the old permission lists, because seedSystemRoles inserts a missing role but never changes an existing one (as V1284 did).
-- Idempotent: a role that holds them is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = permissions || ARRAY(SELECT p FROM unnest(ARRAY['omni.consent.manage', 'contact_consent.read']) AS p WHERE NOT (p = ANY (permissions))),
       version = version + 1
 WHERE code = 'OMNI_AGENT'
   AND is_system
   AND NOT (permissions @> ARRAY['omni.consent.manage', 'contact_consent.read']);

UPDATE machvon.role_definition
   SET permissions = array_append(permissions, 'contact_consent.read'),
       version = version + 1
 WHERE code = 'OMNI_SUPERVISOR'
   AND is_system
   AND NOT ('contact_consent.read' = ANY (permissions));
