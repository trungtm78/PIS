-- ST-SAS-017 (SAS.md 3.4, BR-SAS-06): the domains of a tenant, proved by a TXT record, with a certificate, and held for 90 days once they are released.
--   * a domain remembers when it was released, until when its challenge may be answered, why it failed and when it was made;
--   * what a domain is (tenant, hostname, kind) never changes, it moves forward (PendingVerification → Verified → Active) or fails, a released one is final;
--   * two functions answer what row-level security hides from a tenant: who holds a hostname (or held it lately), and which tenant a verified hostname chooses.

ALTER TABLE machvon.tenant_domain ADD COLUMN revoked_at timestamptz;
ALTER TABLE machvon.tenant_domain ADD COLUMN challenge_expires_at timestamptz;
ALTER TABLE machvon.tenant_domain ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE machvon.tenant_domain ADD COLUMN failure_code text;
-- Added NOT VALID: tenant_domain has FORCE row-level security, so this connection cannot set revoked_at on the rows that exist; V1492 (privileged) does, and then validates the constraint.
ALTER TABLE machvon.tenant_domain ADD CONSTRAINT tenant_domain_revoked_ck CHECK ((status = 'Revoked') = (revoked_at IS NOT NULL)) NOT VALID;
-- A custom domain is proved by a token; a platform subdomain is the platform's own and has none.
ALTER TABLE machvon.tenant_domain ADD CONSTRAINT tenant_domain_token_ck CHECK (kind = 'PLATFORM_SUBDOMAIN' OR status = 'Revoked' OR txt_token_hash IS NOT NULL);
CREATE INDEX tenant_domain_released_idx ON machvon.tenant_domain (lower(hostname), revoked_at DESC) WHERE status = 'Revoked';

CREATE FUNCTION machvon.guard_tenant_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DOMAIN_IMMUTABLE: a domain is released, never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Revoked' THEN
    RAISE EXCEPTION 'DOMAIN_IMMUTABLE: a released domain does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR lower(NEW.hostname) <> lower(OLD.hostname) OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'DOMAIN_IMMUTABLE: what a domain is does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('PendingVerification', 'Verified'), ('PendingVerification', 'Failed'), ('PendingVerification', 'Active'), ('Verified', 'Active'), ('Verified', 'Failed'),
       ('Active', 'Failed'), ('Failed', 'PendingVerification'), ('Failed', 'Verified'), ('Failed', 'Active'),
       ('PendingVerification', 'Revoked'), ('Verified', 'Revoked'), ('Active', 'Revoked'), ('Failed', 'Revoked'))) THEN
    RAISE EXCEPTION 'DOMAIN_IMMUTABLE: a domain does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_domain_guard BEFORE UPDATE OR DELETE ON machvon.tenant_domain FOR EACH ROW EXECUTE FUNCTION machvon.guard_tenant_domain();
REVOKE DELETE, TRUNCATE ON TABLE machvon.tenant_domain FROM machvon_app, machvon_control;

-- Row-level security hides the domains of other tenants, and the platform has to see who holds a hostname (to say "taken" or "reserved") and which tenant a verified hostname chooses at sign-in. The directory has one
-- row for each hostname, with the state of its latest domain, and no row-level security: it is read by the control plane alone, never by the tenant plane, and it is kept by the trigger below, not by the application.
CREATE TABLE machvon.tenant_domain_directory (
  hostname text PRIMARY KEY CHECK (hostname = lower(hostname)),
  holder_tenant_id uuid NOT NULL REFERENCES machvon.tenant (id),
  domain_id uuid NOT NULL,
  status text NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX tenant_domain_directory_domain_uq ON machvon.tenant_domain_directory (domain_id);
CREATE INDEX tenant_domain_directory_tenant_idx ON machvon.tenant_domain_directory (holder_tenant_id);
-- The default privileges of V001 give machvon_app every right on a new table, and the directory has no row-level security: the tenant plane must not read or write it.
REVOKE ALL ON TABLE machvon.tenant_domain_directory FROM PUBLIC, machvon_app, machvon_outbox_relay, machvon_reporting, machvon_sync;
GRANT SELECT ON TABLE machvon.tenant_domain_directory TO machvon_control;

CREATE FUNCTION machvon.keep_tenant_domain_directory() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
BEGIN
  INSERT INTO machvon.tenant_domain_directory (hostname, holder_tenant_id, domain_id, status, revoked_at)
  VALUES (lower(NEW.hostname), NEW.tenant_id, NEW.id, NEW.status, NEW.revoked_at)
  ON CONFLICT (hostname) DO UPDATE SET holder_tenant_id = EXCLUDED.holder_tenant_id, domain_id = EXCLUDED.domain_id, status = EXCLUDED.status, revoked_at = EXCLUDED.revoked_at;
  RETURN NEW;
END $fn$;
CREATE TRIGGER tenant_domain_directory_tg AFTER INSERT OR UPDATE ON machvon.tenant_domain FOR EACH ROW EXECUTE FUNCTION machvon.keep_tenant_domain_directory();

-- Who holds a hostname, or released it lately.
CREATE FUNCTION machvon.tenant_domain_holder(p_hostname text) RETURNS TABLE (tenant_id uuid, status text, revoked_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT d.holder_tenant_id, d.status, d.revoked_at FROM machvon.tenant_domain_directory d WHERE d.hostname = lower(p_hostname);
$fn$;
-- The tenant that a hostname chooses at sign-in: the one with a Verified or Active domain on it.
CREATE FUNCTION machvon.tenant_of_domain(p_hostname text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT d.holder_tenant_id FROM machvon.tenant_domain_directory d WHERE d.hostname = lower(p_hostname) AND d.status IN ('Verified', 'Active');
$fn$;
-- The tenant of a domain, for the commands that name only the domain (the same way an invoice names only itself).
CREATE FUNCTION machvon.tenant_domain_tenant_of(p_domain uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT d.holder_tenant_id FROM machvon.tenant_domain_directory d WHERE d.domain_id = p_domain;
$fn$;
REVOKE ALL ON FUNCTION machvon.tenant_domain_holder(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.tenant_of_domain(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.tenant_domain_tenant_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.tenant_domain_holder(text) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.tenant_of_domain(text) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.tenant_domain_tenant_of(uuid) TO machvon_control;
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.tenant_domain TO machvon_control;
