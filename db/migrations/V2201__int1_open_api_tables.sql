-- Authored by hand (not generated): the tables of the open interface (INT-1): the systems whose project codes we map, the machine accounts that read through the open API, their credentials, the log of every read,
-- the datasets switched on for external readers, and the register of the logins of BI tools. All are tenant tables (RLS enabled and forced, the restrictive boundary), none is deleted from.
--
--   * `int_source_system`: the other systems of the organization (PMIS, ERP, finance, Lakehouse...). The project codes live on `master_crosswalk` (V2203), never in a table of external identities of their own.
--   * `int_machine_account`: a machine that reads. It holds scopes (what it may read), a rate limit, and may end on a day. ACTIVE <-> SUSPENDED, and REVOKED for good; every move has a reason.
--   * `int_machine_credential`: the client id and the HASH of the secret (the secret itself is shown once and never stored). A rotation supersedes the old credential, which lives on until its own end for a bounded
--     overlap. `int_client_directory` (no RLS, like `tenant_domain_directory`) lets the token endpoint find the tenant of a client id before any tenant is known; a trigger keeps it, never the application.
--   * `int_access_log`: one row per call of a machine, append-only for everyone: the account, the credential, the operation, the scope, the path (no query values), the outcome and the number of rows.
--   * `int_export_dataset`: the certified datasets a tenant switched on for external readers (API and BI). The product behind it must be CERTIFIED at the time, and is judged again at every read.
--   * `int_bi_reader` and `int_bi_reader_event`: the register of the logins of BI tools (the login itself and its tenant binding are made by machvon_bi.provision_reader, V2200) and what was done to each, append-only.

CREATE TABLE machvon.int_source_system (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  code_pattern text,
  status text NOT NULL DEFAULT 'ACTIVE',
  retire_reason text,
  retired_by uuid,
  retired_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT int_source_system_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT int_source_system_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$' AND code NOT IN ('MUASAMCONG', 'TENANT_ALIAS')),
  CONSTRAINT int_source_system_name_chk CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT int_source_system_kind_chk CHECK (kind IN ('PMIS', 'ERP', 'FINANCE', 'LAKEHOUSE', 'GOV_PORTAL', 'OTHER')),
  CONSTRAINT int_source_system_pattern_chk CHECK (code_pattern IS NULL OR char_length(code_pattern) BETWEEN 1 AND 120),
  CONSTRAINT int_source_system_status_chk CHECK (status IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT int_source_system_retired_chk CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL AND retired_by IS NOT NULL AND char_length(btrim(retire_reason)) >= 10)),
  CONSTRAINT int_source_system_version_chk CHECK (version >= 1)
);

CREATE TABLE machvon.int_machine_account (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  scopes text[] NOT NULL,
  rate_limit_per_minute integer NOT NULL DEFAULT 60,
  expires_on date,
  status text NOT NULL DEFAULT 'ACTIVE',
  status_reason text,
  status_changed_by uuid,
  status_changed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT int_machine_account_name_chk CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT int_machine_account_description_chk CHECK (description IS NULL OR (description = btrim(description) AND char_length(description) BETWEEN 1 AND 1000)),
  CONSTRAINT int_machine_account_scopes_chk CHECK (cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['open.projects.read', 'open.project-codes.read', 'open.disbursement.read', 'open.contracts.read']::text[]),
  CONSTRAINT int_machine_account_rate_chk CHECK (rate_limit_per_minute BETWEEN 1 AND 6000),
  CONSTRAINT int_machine_account_status_chk CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  CONSTRAINT int_machine_account_reason_chk CHECK (
    (status_reason IS NULL) = (status_changed_by IS NULL) AND (status_reason IS NULL) = (status_changed_at IS NULL)
    AND (status_reason IS NULL OR char_length(btrim(status_reason)) >= 10)
    AND (status = 'ACTIVE' OR status_reason IS NOT NULL)
  ),
  CONSTRAINT int_machine_account_version_chk CHECK (version >= 1)
);
CREATE UNIQUE INDEX int_machine_account_name_uq ON machvon.int_machine_account (tenant_id, lower(name)) WHERE status <> 'REVOKED';
CREATE INDEX int_machine_account_list_idx ON machvon.int_machine_account (tenant_id, status, created_at DESC, id DESC);

CREATE TABLE machvon.int_machine_credential (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  client_id text NOT NULL,
  secret_hash char(64) NOT NULL,
  secret_hint text NOT NULL,
  superseded_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES machvon.int_machine_account (tenant_id, id),
  CONSTRAINT int_machine_credential_client_uq UNIQUE (client_id),
  CONSTRAINT int_machine_credential_client_chk CHECK (client_id ~ '^mvc_[a-z2-7]{26}$'),
  CONSTRAINT int_machine_credential_hash_chk CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT int_machine_credential_hint_chk CHECK (secret_hint ~ '^mvs_[A-Za-z0-9_-]{4}$'),
  CONSTRAINT int_machine_credential_revoked_chk CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX int_machine_credential_account_idx ON machvon.int_machine_credential (tenant_id, account_id, created_at DESC, id DESC);
CREATE INDEX int_machine_credential_client_idx ON machvon.int_machine_credential (tenant_id, client_id);

CREATE TABLE machvon.int_client_directory (
  client_id text PRIMARY KEY,
  holder_tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  credential_id uuid NOT NULL
);
CREATE INDEX int_client_directory_holder_idx ON machvon.int_client_directory (holder_tenant_id);
CREATE INDEX int_client_directory_account_idx ON machvon.int_client_directory (account_id);
CREATE INDEX int_client_directory_credential_idx ON machvon.int_client_directory (credential_id);
REVOKE ALL ON TABLE machvon.int_client_directory FROM PUBLIC, machvon_app, machvon_outbox_relay, machvon_reporting, machvon_sync;

CREATE FUNCTION machvon.keep_int_client_directory() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
BEGIN
  INSERT INTO machvon.int_client_directory (client_id, holder_tenant_id, account_id, credential_id) VALUES (NEW.client_id, NEW.tenant_id, NEW.account_id, NEW.id);
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER int_machine_credential_directory AFTER INSERT ON machvon.int_machine_credential FOR EACH ROW EXECUTE FUNCTION machvon.keep_int_client_directory();

-- What a credential is never changes; it can only be superseded once, revoked once, and be used.
CREATE FUNCTION machvon.guard_int_machine_credential() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a credential is revoked, never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash OR NEW.secret_hint IS DISTINCT FROM OLD.secret_hint OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a credential keeps its identifier, its secret hash and its account' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'a credential is superseded once' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'a revoked credential stays revoked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER int_machine_credential_guard BEFORE UPDATE OR DELETE ON machvon.int_machine_credential FOR EACH ROW EXECUTE FUNCTION machvon.guard_int_machine_credential();

-- The id a client id belongs to is what the token endpoint finds (no tenant is known yet): the function names the tenant while it reads, as machvon.memberships_of_user does (the owner is subject to FORCE ROW LEVEL SECURITY
-- too), and puts the caller's setting back. It answers with the facts that decide an authentication and nothing else; the secret is compared by the caller, in constant time.
CREATE FUNCTION machvon.int_client_lookup(p_client_id text)
RETURNS TABLE (tenant_id uuid, account_id uuid, credential_id uuid, secret_hash text, credential_expires_at timestamptz, credential_revoked_at timestamptz, account_status text, account_expires_on date, scopes text[], rate_limit_per_minute integer, tenant_status text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  holder uuid;
BEGIN
  SELECT d.holder_tenant_id INTO holder FROM machvon.int_client_directory d WHERE d.client_id = p_client_id;
  IF holder IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', holder::text, true);
  RETURN QUERY
    SELECT c.tenant_id, a.id, c.id, c.secret_hash::text, c.expires_at, c.revoked_at, a.status, a.expires_on, a.scopes, a.rate_limit_per_minute, t.status
      FROM machvon.int_machine_credential c
      JOIN machvon.int_machine_account a ON a.tenant_id = c.tenant_id AND a.id = c.account_id
      LEFT JOIN machvon.tenant t ON t.id = c.tenant_id
     WHERE c.client_id = p_client_id AND c.tenant_id = holder;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.int_client_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.int_client_lookup(text) TO machvon_control;

CREATE TABLE machvon.int_access_log (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  operation text NOT NULL,
  scope text,
  path text NOT NULL,
  query_keys text[] NOT NULL DEFAULT '{}',
  outcome text NOT NULL,
  status integer NOT NULL,
  row_count integer,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES machvon.int_machine_account (tenant_id, id),
  FOREIGN KEY (tenant_id, credential_id) REFERENCES machvon.int_machine_credential (tenant_id, id),
  CONSTRAINT int_access_log_outcome_chk CHECK (outcome IN ('OK', 'DENIED_CLIENT', 'DENIED_SCOPE', 'DENIED_DATASET', 'RATE_LIMITED', 'INVALID_REQUEST')),
  CONSTRAINT int_access_log_status_chk CHECK (status BETWEEN 100 AND 599),
  CONSTRAINT int_access_log_rows_chk CHECK (row_count IS NULL OR row_count >= 0),
  CONSTRAINT int_access_log_path_chk CHECK (char_length(path) BETWEEN 1 AND 300 AND position('?' IN path) = 0)
);
CREATE INDEX int_access_log_time_idx ON machvon.int_access_log (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX int_access_log_account_idx ON machvon.int_access_log (tenant_id, account_id, occurred_at DESC, id DESC);
CREATE INDEX int_access_log_credential_idx ON machvon.int_access_log (tenant_id, credential_id);
CREATE INDEX int_access_log_correlation_idx ON machvon.int_access_log (tenant_id, correlation_id);

CREATE FUNCTION machvon.int_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'this record is append-only' USING ERRCODE = '23514';
END;
$fn$;
CREATE TRIGGER int_access_log_append_only BEFORE UPDATE OR DELETE ON machvon.int_access_log FOR EACH ROW EXECUTE FUNCTION machvon.int_append_only();

CREATE TABLE machvon.int_export_dataset (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  dataset_code text NOT NULL,
  product_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  state_reason text,
  state_changed_by uuid NOT NULL,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES machvon.data_product (tenant_id, id),
  CONSTRAINT int_export_dataset_code_uq UNIQUE (tenant_id, dataset_code),
  CONSTRAINT int_export_dataset_code_chk CHECK (dataset_code IN ('DS-DISB', 'DS-CTR')),
  CONSTRAINT int_export_dataset_reason_chk CHECK (state_reason IS NULL OR (state_reason = btrim(state_reason) AND char_length(state_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT int_export_dataset_version_chk CHECK (version >= 1)
);
CREATE INDEX int_export_dataset_product_idx ON machvon.int_export_dataset (tenant_id, product_id);

CREATE TABLE machvon.int_bi_reader (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tool text,
  login_name text NOT NULL,
  connection_limit integer NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  status_reason text,
  status_changed_by uuid,
  status_changed_at timestamptz,
  password_rotated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT int_bi_reader_login_uq UNIQUE (login_name),
  CONSTRAINT int_bi_reader_login_chk CHECK (login_name ~ '^machvon_bi_[0-9a-f]{12}$'),
  CONSTRAINT int_bi_reader_name_chk CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT int_bi_reader_tool_chk CHECK (tool IS NULL OR (tool = btrim(tool) AND char_length(tool) BETWEEN 1 AND 60)),
  CONSTRAINT int_bi_reader_limit_chk CHECK (connection_limit BETWEEN 1 AND 20),
  CONSTRAINT int_bi_reader_status_chk CHECK (status IN ('ACTIVE', 'SUSPENDED', 'RETIRED')),
  CONSTRAINT int_bi_reader_reason_chk CHECK (status_reason IS NULL OR (status_reason = btrim(status_reason) AND char_length(status_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT int_bi_reader_version_chk CHECK (version >= 1)
);
CREATE INDEX int_bi_reader_list_idx ON machvon.int_bi_reader (tenant_id, status, created_at DESC, id DESC);

CREATE TABLE machvon.int_bi_reader_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  reader_id uuid NOT NULL,
  action text NOT NULL,
  reason text,
  actor_id uuid NOT NULL,
  reader_version bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, reader_id) REFERENCES machvon.int_bi_reader (tenant_id, id),
  CONSTRAINT int_bi_reader_event_action_chk CHECK (action IN ('PROVISIONED', 'PASSWORD_ROTATED', 'SUSPENDED', 'REACTIVATED', 'RETIRED')),
  CONSTRAINT int_bi_reader_event_reason_chk CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000))
);
CREATE INDEX int_bi_reader_event_idx ON machvon.int_bi_reader_event (tenant_id, reader_id, occurred_at DESC, id DESC);
CREATE INDEX int_bi_reader_event_actor_idx ON machvon.int_bi_reader_event (tenant_id, actor_id, occurred_at DESC);
CREATE TRIGGER int_bi_reader_event_append_only BEFORE UPDATE OR DELETE ON machvon.int_bi_reader_event FOR EACH ROW EXECUTE FUNCTION machvon.int_append_only();

-- Row-level security: enabled, forced, the restrictive boundary and the permissive access, as every tenant table.
DO $rls$
DECLARE
  one_table text;
BEGIN
  FOREACH one_table IN ARRAY ARRAY['int_source_system', 'int_machine_account', 'int_machine_credential', 'int_access_log', 'int_export_dataset', 'int_bi_reader', 'int_bi_reader_event'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', one_table);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', one_table);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, one_table);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, one_table);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', one_table);
  END LOOP;
END
$rls$;
REVOKE UPDATE ON TABLE machvon.int_access_log FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.int_bi_reader_event FROM machvon_app;

COMMENT ON TABLE machvon.int_machine_account IS 'INT-1: a machine that reads through the open API: scopes, rate limit, end day; ACTIVE, SUSPENDED or REVOKED, every move with a reason.';
COMMENT ON TABLE machvon.int_machine_credential IS 'INT-1: the client id and the SHA-256 hash of the secret of a machine account; the secret is shown once and never stored.';
COMMENT ON TABLE machvon.int_access_log IS 'INT-1: one row per call of a machine to the open API; append-only; no query values, only the names of the parameters.';
COMMENT ON TABLE machvon.int_export_dataset IS 'INT-1: a certified dataset switched on for external readers (API and BI); judged against the certification of its product at every read.';
COMMENT ON TABLE machvon.int_bi_reader IS 'INT-1: the register of the database logins of BI tools; the login and its tenant binding live in machvon_bi.';
COMMENT ON TABLE machvon.int_source_system IS 'INT-1: another system of the organization whose project codes are mapped on master_crosswalk.';
