-- Authored by hand (not generated): the database logins of BI tools (INT-1, plan "Dot 4 item 4", eng-review R6 and R13) and the permission of the owner of a tenant to manage them.
-- migrate: privileged
-- Runs as the privileged connection: creating and dropping a login needs CREATEROLE, which the application role must never have. The four functions below are the ONLY way the application makes, rotates, parks or
-- removes a BI login, and each one is narrow on purpose:
--   * SECURITY DEFINER with a fixed search_path, executable by the application role alone (never PUBLIC);
--   * it acts only for the tenant of the caller's own transaction (`app.tenant_id`), so a tenant cannot touch the login of another tenant;
--   * the login name must be `machvon_bi_` and twelve hex characters (nothing a caller can choose freely reaches an identifier), and the password arrives as a SCRAM-SHA-256 verifier, never in the clear, so the
--     server and its logs never see the password;
--   * a login is NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE, read-only by default, with a connection limit and a statement timeout, a member of the group role `machvon_bi_reader` and of nothing else.
-- The group role holds what BI logins may read (grants of V2202); the tenant of a login is the row of `machvon_bi.reader_binding`, written here in the same statement that makes the login.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'machvon_bi_reader') THEN
    CREATE ROLE machvon_bi_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS machvon_bi AUTHORIZATION machvon_owner;
ALTER SCHEMA machvon_bi OWNER TO machvon_owner;
GRANT USAGE ON SCHEMA machvon_bi TO machvon_bi_reader, machvon_app, machvon_control;
GRANT USAGE ON SCHEMA machvon TO machvon_bi_reader;

CREATE FUNCTION machvon_bi.provision_reader(p_tenant uuid, p_reader uuid, p_login text, p_verifier text, p_connection_limit integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, machvon_bi, pg_temp
AS $fn$
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a BI login is made for the tenant of the transaction only' USING ERRCODE = '42501';
  END IF;
  IF p_login !~ '^machvon_bi_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'the name of a BI login is machvon_bi_ and twelve hex characters' USING ERRCODE = '22023';
  END IF;
  IF p_verifier !~ '^SCRAM-SHA-256\$[0-9]{4,7}:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' THEN
    RAISE EXCEPTION 'the password of a BI login arrives as a SCRAM-SHA-256 verifier' USING ERRCODE = '22023';
  END IF;
  IF p_connection_limit IS NULL OR p_connection_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'the connection limit of a BI login is 1 to 20' USING ERRCODE = '22023';
  END IF;
  EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT %s PASSWORD %L', p_login, p_connection_limit, p_verifier);
  EXECUTE format('GRANT machvon_bi_reader TO %I', p_login);
  -- The tenant here is a convenience default (so a BI tool needs no setup), never the authority: the views and the policies read the binding below.
  EXECUTE format('ALTER ROLE %I SET app.tenant_id = %L', p_login, p_tenant::text);
  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', p_login);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', p_login, '60s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', p_login, '60s');
  EXECUTE format('ALTER ROLE %I SET search_path = machvon_bi', p_login);
  INSERT INTO machvon_bi.reader_binding (login_name, tenant_id, reader_id, active) VALUES (p_login, p_tenant, p_reader, true);
END;
$fn$;

CREATE FUNCTION machvon_bi.rotate_reader_password(p_tenant uuid, p_login text, p_verifier text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, machvon_bi, pg_temp
AS $fn$
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a BI login is changed for the tenant of the transaction only' USING ERRCODE = '42501';
  END IF;
  IF p_verifier !~ '^SCRAM-SHA-256\$[0-9]{4,7}:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' THEN
    RAISE EXCEPTION 'the password of a BI login arrives as a SCRAM-SHA-256 verifier' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM machvon_bi.reader_binding b WHERE b.login_name = p_login AND b.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'no such BI login in this tenant' USING ERRCODE = 'P0002';
  END IF;
  EXECUTE format('ALTER ROLE %I PASSWORD %L', p_login, p_verifier);
  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = p_login;
END;
$fn$;

CREATE FUNCTION machvon_bi.set_reader_active(p_tenant uuid, p_login text, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, machvon_bi, pg_temp
AS $fn$
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a BI login is changed for the tenant of the transaction only' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM machvon_bi.reader_binding b WHERE b.login_name = p_login AND b.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'no such BI login in this tenant' USING ERRCODE = 'P0002';
  END IF;
  -- The binding goes first: every policy and every view reads it, so a session that is already open reads nothing from this statement on, even before its connection is cut.
  UPDATE machvon_bi.reader_binding SET active = p_active WHERE login_name = p_login;
  EXECUTE format('ALTER ROLE %I %s', p_login, CASE WHEN p_active THEN 'LOGIN' ELSE 'NOLOGIN' END);
  IF NOT p_active THEN
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = p_login;
  END IF;
END;
$fn$;

CREATE FUNCTION machvon_bi.retire_reader(p_tenant uuid, p_login text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, machvon_bi, pg_temp
AS $fn$
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a BI login is removed for the tenant of the transaction only' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM machvon_bi.reader_binding b WHERE b.login_name = p_login AND b.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'no such BI login in this tenant' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM machvon_bi.reader_binding WHERE login_name = p_login;
  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = p_login;
  EXECUTE format('DROP ROLE %I', p_login);
END;
$fn$;

REVOKE ALL ON FUNCTION machvon_bi.provision_reader(uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon_bi.rotate_reader_password(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon_bi.set_reader_active(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon_bi.retire_reader(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon_bi.provision_reader(uuid, uuid, text, text, integer) TO machvon_app;
GRANT EXECUTE ON FUNCTION machvon_bi.rotate_reader_password(uuid, text, text) TO machvon_app;
GRANT EXECUTE ON FUNCTION machvon_bi.set_reader_active(uuid, text, boolean) TO machvon_app;
GRANT EXECUTE ON FUNCTION machvon_bi.retire_reader(uuid, text) TO machvon_app;

-- The owner of a tenant holds every permission of the tenant plane (`int.*` is new), as the seeded role says for tenants made after this; tenants seeded before keep the old list, so it is added here, once.
-- Idempotent: a role that already holds it is left alone, its version included.
UPDATE machvon.role_definition
   SET permissions = permissions || ARRAY['int.*'],
       version = version + 1
 WHERE code = 'TENANT_OWNER'
   AND is_system
   AND NOT ('int.*' = ANY (permissions));

COMMENT ON FUNCTION machvon_bi.provision_reader(uuid, uuid, text, text, integer) IS 'INT-1: makes the database login of a BI tool for the tenant of the caller; the password arrives as a SCRAM verifier; the login is bound to its tenant by machvon_bi.reader_binding.';
