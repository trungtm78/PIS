-- Authored by hand (not generated): the domains that exist before V1491 are brought up to date once: a released domain gets the time it was released, and the directory of domains (kept by a trigger from now on) is filled. The latest domain of each hostname wins (a live one before a released one).
-- migrate: privileged
-- Runs as the privileged connection, not as machvon_owner: tenant_domain has FORCE row-level security, so only that connection reaches the rows of every tenant at once.
-- The guard and the directory trigger are put aside for the one update (a released domain is final, and the directory is filled below with the winner of each hostname), and are back before this migration ends.
ALTER TABLE machvon.tenant_domain DISABLE TRIGGER tenant_domain_guard;
ALTER TABLE machvon.tenant_domain DISABLE TRIGGER tenant_domain_directory_tg;
-- The time a domain was released was not recorded: the hold of 90 days starts now, the safe side (a name is never freed early).
UPDATE machvon.tenant_domain SET revoked_at = clock_timestamp() WHERE status = 'Revoked' AND revoked_at IS NULL;
ALTER TABLE machvon.tenant_domain ENABLE TRIGGER tenant_domain_guard;
ALTER TABLE machvon.tenant_domain ENABLE TRIGGER tenant_domain_directory_tg;
ALTER TABLE machvon.tenant_domain VALIDATE CONSTRAINT tenant_domain_revoked_ck;
INSERT INTO machvon.tenant_domain_directory (hostname, holder_tenant_id, domain_id, status, revoked_at)
SELECT DISTINCT ON (lower(d.hostname)) lower(d.hostname), d.tenant_id, d.id, d.status, d.revoked_at
  FROM machvon.tenant_domain d
 ORDER BY lower(d.hostname), (d.status <> 'Revoked') DESC, d.revoked_at DESC NULLS FIRST, d.created_at DESC
ON CONFLICT (hostname) DO NOTHING;
