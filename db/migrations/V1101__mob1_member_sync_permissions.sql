-- Authored by hand (not generated), ST-MOB-005 and ST-MOB-009: every member's phone sends its queued commands and uploads its attachments (`sync.submit`, `sync.upload`). The two permissions only open the door of
-- the sync endpoints: each queued command is judged again by the permission, the scope and the license of the operation it carries, exactly as if it had been sent online. Tenants seeded before this keep the old
-- permission list, because seedSystemRoles inserts a missing role but never changes an existing one (as V1444 and V1281 did). Idempotent: a role that holds them is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = permissions || ARRAY(SELECT p FROM unnest(ARRAY['sync.submit', 'sync.upload']) AS p WHERE NOT (p = ANY (permissions))),
       version = version + 1
 WHERE code = 'MEMBER'
   AND is_system
   AND NOT (permissions @> ARRAY['sync.submit', 'sync.upload']);
