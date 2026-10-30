-- Authored by hand (not generated), ST-OMNI-001: the omnichannel supervisors read the channel accounts (`channel_account.read`, the generic read the screens OMNI-05 and OMNI-06 call).
-- The role OMNI_SUPERVISOR held `omni.*`, which does not cover the generic read of another resource. Tenants seeded before this keep the old permission list, because seedSystemRoles inserts a missing role but
-- never changes an existing one (as V1444 did). Idempotent: a role that holds it is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = array_append(permissions, 'channel_account.read'),
       version = version + 1
 WHERE code = 'OMNI_SUPERVISOR'
   AND is_system
   AND NOT ('channel_account.read' = ANY (permissions));
