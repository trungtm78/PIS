-- Authored by hand (not generated), ST-NOT-010: the notification administrators read the delivery attempts and the channel accounts (`delivery_attempt.read`, `channel_account.read`, the generic reads the operations overview
-- NOT-04, the limits NOT-15 and the screens NOT-11 to NOT-13 call). The role NOTIFICATION_ADMIN held `notification.*`, which does not cover the generic read of another resource. Tenants seeded before this keep the old
-- permission list, because seedSystemRoles inserts a missing role but never changes an existing one (as V1444 did). Idempotent: a role that holds them is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = permissions || ARRAY(SELECT p FROM unnest(ARRAY['delivery_attempt.read', 'channel_account.read']) AS p WHERE NOT (p = ANY (permissions))),
       version = version + 1
 WHERE code = 'NOTIFICATION_ADMIN'
   AND is_system
   AND NOT (permissions @> ARRAY['delivery_attempt.read', 'channel_account.read']);
