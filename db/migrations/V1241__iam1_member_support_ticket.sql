-- Authored by hand (not generated): every member may ask for help (ST-IAM-007, IAM-08) and read their own tickets, so the MEMBER role gets
-- `support.ticket.create` and `support.ticket.read`. Tenants seeded before this keep the old permission list, because seedSystemRoles inserts a missing role but
-- never changes an existing one (as V010 did for `session.self`). Idempotent: a role that holds both is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that
-- connection can reach the rows of every tenant at once, and the statement needs no tenant context.
UPDATE machvon.role_definition
   SET permissions = permissions || ARRAY(SELECT p FROM unnest(ARRAY['support.ticket.create', 'support.ticket.read']) AS p WHERE NOT (p = ANY (permissions))),
       version = version + 1
 WHERE code = 'MEMBER'
   AND is_system
   AND NOT (ARRAY['support.ticket.create', 'support.ticket.read'] <@ permissions);
