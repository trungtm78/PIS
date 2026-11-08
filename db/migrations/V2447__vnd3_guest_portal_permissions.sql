-- Authored by hand (not generated): the contractor portal permissions of the system role GUEST_CONTRACTOR (VND-3; docs/vendor-investigation.md section 5).
-- The role was seeded with `contract.read` only, and seedSystemRoles inserts a missing role but never changes an existing one, so tenants seeded before this keep the old list (as V1444 did). The five rights are the
-- whole portal: reading the own profile, evaluations, requests and plans; answering a request; putting a certificate on file; re-confirming the profile with the declaration of integrity; working a plan of remediation.
-- Idempotent: a role that holds a right is left alone for that right.
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: role_definition has FORCE row-level security, so only that connection can reach the rows of every tenant at once.
DO $vnd3$
DECLARE
  granted text;
BEGIN
  FOREACH granted IN ARRAY ARRAY['vnd.portal.read', 'vnd.portal.respond', 'vnd.portal.certificate', 'vnd.portal.reconfirm', 'vnd.portal.remediation'] LOOP
    UPDATE machvon.role_definition
       SET permissions = array_append(permissions, granted),
           version = version + 1
     WHERE code = 'GUEST_CONTRACTOR'
       AND is_system
       AND NOT (granted = ANY (permissions));
  END LOOP;
END
$vnd3$;

-- The auditors read and review the leads of the investigation (VND-3, V6: auditors only) and read the screening; the same rule: a right already held is left alone.
DO $vnd3a$
DECLARE
  granted text;
BEGIN
  FOREACH granted IN ARRAY ARRAY['vnd.read', 'vnd.lead.read', 'vnd.lead.review', 'vnd.lead.confirm', 'vnd.lead.scan', 'vnd.screening.read'] LOOP
    UPDATE machvon.role_definition
       SET permissions = array_append(permissions, granted),
           version = version + 1
     WHERE code = 'AUDITOR'
       AND is_system
       AND NOT (granted = ANY (permissions));
  END LOOP;
END
$vnd3a$;
