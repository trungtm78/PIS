-- Authored by hand (not generated): INT-2. A BI login is audited as a session: `pgaudit.log = read` is set on the role when it is made (a setting of the role is harmless where pgaudit is not loaded). The object audit of the views
-- (infra/onprem/config/bi-audit-setup.sql) does not see a read of the granted columns of the snapshot tables, which a login may make directly (V2202, V2960); the session audit of the login sees every read.
-- migrate: privileged
-- The function is V2200 with the one line added (it stays owned by the privileged connection, as there); its grants (V2200) stay with it.

CREATE OR REPLACE FUNCTION machvon_bi.provision_reader(p_tenant uuid, p_reader uuid, p_login text, p_verifier text, p_connection_limit integer)
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
  -- INT-2: every read of the login is written to the audit log of the database when pgaudit is loaded (the opt-in BI port of the offline bundle preloads it), including a direct read of the granted columns of the tables.
  EXECUTE format('ALTER ROLE %I SET pgaudit.log = %L', p_login, 'read');
  INSERT INTO machvon_bi.reader_binding (login_name, tenant_id, reader_id, active) VALUES (p_login, p_tenant, p_reader, true);
END;
$fn$;
