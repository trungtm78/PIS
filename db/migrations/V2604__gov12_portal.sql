-- Authored by hand (not generated): the public portal (GOV-12, G4-9). The portal never reads the source tables.
--   * portal_setting: one row for a tenant: the slug of the portal in its URL, whether it is on, the words of the publisher, and the SNAPSHOT of the policy that was in force when it was last saved (allowed_fields, the rate
--     limit, the page size: the governance rule PUBLIC_PORTAL_RULE, read at that time), because the public side cannot read the rules of a tenant.
--   * portal_record: what has been published for a project: the fields cut by the allow-list when it was published (a field that was not allowed is not in the row, so a query of the table cannot return it), the hash of them,
--     the revision, and the withdrawal with a reason. One row for a project; every publication is audited with the hash.
--   * portal_directory: control plane, no row-level security, no right for the application role (the same as tenant_domain_directory): which slug belongs to which tenant and whether it is on. It is kept by a trigger.
-- The public side reads through two SECURITY DEFINER functions that return nothing but published fields, and set the tenant of the transaction themselves.

CREATE TABLE machvon.portal_setting (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' AND slug !~ '--'),
  enabled boolean NOT NULL DEFAULT false,
  whistle_enabled boolean NOT NULL DEFAULT false,
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 3 AND 200),
  publisher_name text NOT NULL CHECK (publisher_name = btrim(publisher_name) AND char_length(publisher_name) BETWEEN 3 AND 200),
  id_prefix text NOT NULL CHECK (id_prefix ~ '^[A-Za-z0-9]{2,12}(-[A-Za-z0-9]{1,12}){0,3}$'),
  license_uri text NOT NULL CHECK (license_uri = btrim(license_uri) AND license_uri ~ '^https?://[^[:space:]<>]{3,255}$'),
  policy_uri text NOT NULL CHECK (policy_uri = btrim(policy_uri) AND policy_uri ~ '^https?://[^[:space:]<>]{3,255}$'),
  allowed_fields text[] NOT NULL DEFAULT '{}',
  rate_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 6000),
  page_size_max integer NOT NULL DEFAULT 100 CHECK (page_size_max BETWEEN 1 AND 500),
  policy_rule_version integer NOT NULL DEFAULT 0 CHECK (policy_rule_version >= 0),
  whistle_acknowledge_days integer NOT NULL DEFAULT 7 CHECK (whistle_acknowledge_days BETWEEN 1 AND 60),
  whistle_resolve_days integer NOT NULL DEFAULT 90 CHECK (whistle_resolve_days BETWEEN 1 AND 730),
  whistle_rate_per_hour integer NOT NULL DEFAULT 5 CHECK (whistle_rate_per_hour BETWEEN 1 AND 1000),
  whistle_rule_version integer NOT NULL DEFAULT 0 CHECK (whistle_rule_version >= 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT portal_setting_tenant_uq UNIQUE (tenant_id),
  CONSTRAINT portal_setting_on_chk CHECK (NOT enabled OR cardinality(allowed_fields) >= 1)
);
CREATE INDEX portal_setting_updated_by_idx ON machvon.portal_setting (tenant_id, updated_by);
ALTER TABLE machvon.portal_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.portal_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.portal_setting AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.portal_setting AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.portal_setting FROM machvon_app;

CREATE TABLE machvon.portal_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  public_code text NOT NULL CHECK (public_code = btrim(public_code) AND char_length(public_code) BETWEEN 1 AND 80),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  fields_sha256 char(64) NOT NULL CHECK (fields_sha256 ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_by uuid,
  withdrawn_at timestamptz,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR (withdrawn_reason = btrim(withdrawn_reason) AND char_length(withdrawn_reason) BETWEEN 5 AND 500)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, withdrawn_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT portal_record_project_uq UNIQUE (tenant_id, project_id),
  CONSTRAINT portal_record_code_uq UNIQUE (tenant_id, public_code),
  CONSTRAINT portal_record_withdrawn_chk CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_at IS NULL) = (withdrawn_reason IS NULL)),
  CONSTRAINT portal_record_code_in_fields_chk CHECK (fields ? 'project_code')
);
CREATE INDEX portal_record_live_idx ON machvon.portal_record (tenant_id, public_code) WHERE withdrawn_at IS NULL;
CREATE INDEX portal_record_published_by_idx ON machvon.portal_record (tenant_id, published_by);
CREATE INDEX portal_record_withdrawn_by_idx ON machvon.portal_record (tenant_id, withdrawn_by) WHERE withdrawn_by IS NOT NULL;
ALTER TABLE machvon.portal_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.portal_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.portal_record AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.portal_record AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.portal_record FROM machvon_app;

CREATE TABLE machvon.portal_directory (
  slug text PRIMARY KEY CHECK (slug = lower(slug)),
  holder_tenant_id uuid NOT NULL,
  enabled boolean NOT NULL,
  whistle_enabled boolean NOT NULL
);
CREATE UNIQUE INDEX portal_directory_tenant_uq ON machvon.portal_directory (holder_tenant_id);
-- The default privileges give the application role every right on a new table, and the directory has no row-level security: the tenant plane must not read or write it.
REVOKE ALL ON TABLE machvon.portal_directory FROM PUBLIC, machvon_app, machvon_outbox_relay, machvon_reporting, machvon_sync;
GRANT SELECT ON TABLE machvon.portal_directory TO machvon_control;

CREATE FUNCTION machvon.keep_portal_directory() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
BEGIN
  DELETE FROM machvon.portal_directory WHERE holder_tenant_id = NEW.tenant_id AND slug <> lower(NEW.slug);
  INSERT INTO machvon.portal_directory (slug, holder_tenant_id, enabled, whistle_enabled)
  VALUES (lower(NEW.slug), NEW.tenant_id, NEW.enabled, NEW.whistle_enabled)
  ON CONFLICT (slug) DO UPDATE SET enabled = EXCLUDED.enabled, whistle_enabled = EXCLUDED.whistle_enabled WHERE machvon.portal_directory.holder_tenant_id = EXCLUDED.holder_tenant_id;
  IF NOT EXISTS (SELECT 1 FROM machvon.portal_directory WHERE slug = lower(NEW.slug) AND holder_tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'PORTAL_SLUG_TAKEN: the address belongs to another portal' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER portal_setting_directory_tg AFTER INSERT OR UPDATE ON machvon.portal_setting FOR EACH ROW EXECUTE FUNCTION machvon.keep_portal_directory();

-- The public reads. Each function resolves the slug in the directory, refuses a portal that is off, sets the tenant of the transaction, reads only published rows and clears the tenant again.
CREATE FUNCTION machvon.portal_public_info(p_slug text) RETURNS TABLE (title text, publisher_name text, id_prefix text, license_uri text, policy_uri text, allowed_fields text[], rate_per_minute integer, page_size_max integer, record_count bigint, last_published_at timestamptz, whistle_enabled boolean, whistle_acknowledge_days integer, whistle_resolve_days integer, whistle_rate_per_hour integer, whistle_rule_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT holder_tenant_id INTO v_tenant FROM machvon.portal_directory WHERE slug = lower(p_slug) AND enabled;
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  RETURN QUERY
    SELECT s.title, s.publisher_name, s.id_prefix, s.license_uri, s.policy_uri, s.allowed_fields, s.rate_per_minute, s.page_size_max,
           (SELECT count(*) FROM machvon.portal_record r WHERE r.tenant_id = s.tenant_id AND r.withdrawn_at IS NULL),
           (SELECT max(r.published_at) FROM machvon.portal_record r WHERE r.tenant_id = s.tenant_id AND r.withdrawn_at IS NULL),
           s.whistle_enabled, s.whistle_acknowledge_days, s.whistle_resolve_days, s.whistle_rate_per_hour, s.whistle_rule_version
      FROM machvon.portal_setting s WHERE s.tenant_id = v_tenant AND s.enabled;
  PERFORM set_config('app.tenant_id', '', true);
END $fn$;

CREATE FUNCTION machvon.portal_public_records(p_slug text, p_after text, p_limit integer) RETURNS TABLE (public_code text, fields jsonb, revision integer, published_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT holder_tenant_id INTO v_tenant FROM machvon.portal_directory WHERE slug = lower(p_slug) AND enabled;
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  RETURN QUERY
    SELECT r.public_code, r.fields, r.revision, r.published_at
      FROM machvon.portal_record r
     WHERE r.tenant_id = v_tenant AND r.withdrawn_at IS NULL AND (p_after IS NULL OR r.public_code > p_after)
     ORDER BY r.public_code
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
  PERFORM set_config('app.tenant_id', '', true);
END $fn$;
REVOKE ALL ON FUNCTION machvon.portal_public_info(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.portal_public_records(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.portal_public_info(text) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.portal_public_records(text, text, integer) TO machvon_control;

COMMENT ON TABLE machvon.portal_record IS 'What is published to the public portal for a project: only the fields the allow-list gave when it was published.';
