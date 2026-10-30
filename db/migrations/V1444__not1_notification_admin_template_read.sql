-- Authored by hand (not generated), ST-NOT-005: the notification administrators read the template revisions (`notification_template_version.read`, the generic read the editor NOT-07 and the preview NOT-08 call).
-- The role NOTIFICATION_ADMIN held `notification.*`, which does not cover the generic read of another resource. Tenants seeded before this keep the old permission list, because seedSystemRoles inserts a missing role but
-- never changes an existing one (as V1241 and V1489 did). Idempotent: a role that holds it is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = array_append(permissions, 'notification_template_version.read'),
       version = version + 1
 WHERE code = 'NOTIFICATION_ADMIN'
   AND is_system
   AND NOT ('notification_template_version.read' = ANY (permissions));
