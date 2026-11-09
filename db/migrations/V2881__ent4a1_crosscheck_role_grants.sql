-- Authored by hand (not generated): ENT-4a (docs/plans/ent4a.md). The permissions of the comparison of the reports of one period (`rpt.crosscheck.read`, `rpt.crosscheck.explain`) for the committee system roles of the
-- tenants that were seeded before them. seedSystemRoles inserts a missing role but never changes an existing one, so the permissions are added here with the same values as packages/db/src/system-roles.ts: all three committee
-- roles read the comparison; only the head (who approves and issues and never prepares a report) explains a blocking difference. Idempotent: a permission already held is not added twice.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
UPDATE machvon.role_definition
   SET permissions = array_append(permissions, 'rpt.crosscheck.read'),
       version = version + 1
 WHERE code IN ('COMMITTEE_HEAD', 'COMMITTEE_MEMBER', 'COMMITTEE_SECRETARIAT')
   AND is_system
   AND NOT ('rpt.crosscheck.read' = ANY (permissions));

UPDATE machvon.role_definition
   SET permissions = array_append(permissions, 'rpt.crosscheck.explain'),
       version = version + 1
 WHERE code = 'COMMITTEE_HEAD'
   AND is_system
   AND NOT ('rpt.crosscheck.explain' = ANY (permissions));
