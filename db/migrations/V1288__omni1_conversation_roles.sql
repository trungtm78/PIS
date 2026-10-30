-- Authored by hand (not generated), ST-OMNI-004: the omnichannel roles read the conversations and their messages (`conversation.read`, `channel_message.read`, the generic reads the inbox OMNI-01 calls, which `omni.*` and `omni.conversation.*` do not cover);
-- the supervisors also look at the events of the webhooks and replay them (`adm.integration.read`, `adm.integration.operate`: OMNI.md 2, OMNI-11); and the agents answer and convert but do not assign. The agent held `omni.conversation.*`, which carries
-- `omni.conversation.assign` too; assigning is for the supervisor (OMNI.md 3.2), so the wildcard is replaced by the two it was meant to give. Tenants seeded before this keep the old permission lists, because seedSystemRoles inserts a missing role
-- but never changes an existing one (as V1284 did). Idempotent: a role that holds them is left alone, its version included.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = ARRAY(SELECT p FROM unnest(permissions) AS p WHERE p <> 'omni.conversation.*')
                     || ARRAY(SELECT p FROM unnest(ARRAY['omni.conversation.reply', 'omni.conversation.convert', 'conversation.read', 'channel_message.read']) AS p
                               WHERE NOT (p = ANY (permissions))),
       version = version + 1
 WHERE code = 'OMNI_AGENT'
   AND is_system
   AND ('omni.conversation.*' = ANY (permissions) OR NOT (permissions @> ARRAY['omni.conversation.reply', 'omni.conversation.convert', 'conversation.read', 'channel_message.read']));

UPDATE machvon.role_definition
   SET permissions = permissions || ARRAY(SELECT p FROM unnest(ARRAY['conversation.read', 'channel_message.read', 'adm.integration.read', 'adm.integration.operate']) AS p WHERE NOT (p = ANY (permissions))),
       version = version + 1
 WHERE code = 'OMNI_SUPERVISOR'
   AND is_system
   AND NOT (permissions @> ARRAY['conversation.read', 'channel_message.read', 'adm.integration.read', 'adm.integration.operate']);
