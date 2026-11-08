-- Authored by hand (not generated): what a BI login reads (INT-1, eng-review R6 and R13). Lakehouse and Power BI connect with ONE DATABASE LOGIN PER TENANT; the login is bound to its tenant by its own name, and
-- the tenant of a read is resolved from `current_user` through `machvon_bi.reader_binding`, never from the session setting `app.tenant_id` (a login can change that setting at will).
--
--   * `machvon_bi.reader_binding`: login name -> tenant, written only by `machvon_bi.provision_reader` (V2200). Closed to every role but the owner; the functions below read it on behalf of the login.
--   * `machvon_bi.tenant_of(login)` and `machvon_bi.dataset_state(login, dataset)`: SECURITY DEFINER, and each answers for the CALLER's own login only (a login that asks about another login gets nothing).
--     The state of a dataset is the SQL twin of the kernel rule `datasetGate`: the tenant switched it on (`int_export_dataset`), its data product is CERTIFIED, and the certification has not run out.
--   * the views of `machvon_bi` are `security_invoker`: they run with the rights and the row-level security of the login. They show FROZEN snapshots only (immutable), a dataset that is not open yields no row at
--     all, and the tenant of every row is the one of the binding of the login.
--   * (Codex review) the header of a snapshot (period, day, status: no figure) is readable while EITHER dataset is open, because both views join it; the lines stay behind DS-DISB alone.
--   * (Codex review) the policy is also the gate of the dataset and, for the disbursement tables, the frozen filter of the views, so a login cannot read the granted columns directly while the dataset is closed.
--     The tables of the contract fact are gated by the dataset and the tenant; the views narrow them to the FROZEN close snapshots, a direct read sees every revision that was frozen once.
--   * the base tables the views read carry ONE more RESTRICTIVE policy, `bi_reader_boundary`, for the group role `machvon_bi_reader` alone: tenant_id = the tenant of the binding. So a login that sets `app.tenant_id`
--     to another tenant reads nothing, from the views AND from the granted columns of the tables themselves. The group role is granted only the columns the views use; no other table, and no write.
--
-- A login also holds the tenant as the default of its `app.tenant_id` (V2200) so a tool needs no set-up; that default is a convenience and never the authority.

CREATE TABLE machvon_bi.reader_binding (
  login_name text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  reader_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reader_binding_login_chk CHECK (login_name ~ '^machvon_bi_[0-9a-f]{12}$'),
  CONSTRAINT reader_binding_reader_uq UNIQUE (reader_id)
);
REVOKE ALL ON TABLE machvon_bi.reader_binding FROM PUBLIC;

-- The tenant of a login: the binding of the caller's own login while it is active, else nothing (every policy and view then yields no row).
CREATE FUNCTION machvon_bi.tenant_of(p_login text) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, machvon_bi, pg_temp
AS $fn$
  SELECT b.tenant_id FROM machvon_bi.reader_binding b
   WHERE b.login_name = p_login AND p_login = session_user::text AND b.active
     -- The access policy of the tenant, as machvon.tenant_runtime says it: a tenant with NO_ACCESS (suspended for a security incident, or in a state that gives none) is closed to BI logins as to every session.
     AND NOT EXISTS (
       SELECT 1 FROM machvon.tenant t
        WHERE t.id = b.tenant_id
          AND (t.status NOT IN ('Active', 'Suspended', 'Offboarding') OR (t.status = 'Suspended' AND t.lifecycle_reason = 'SECURITY_INCIDENT'))
     )
$fn$;

-- The state of a dataset for the tenant of the caller's login. One row, always: when the login is not bound (or asks about another login) there is no tenant and the dataset is closed.
-- The tenant is named in app.tenant_id only while the row-level security of the tables read here needs it, and the caller's own setting is put back exactly as it was.
CREATE FUNCTION machvon_bi.dataset_state(p_login text, p_dataset text)
RETURNS TABLE (tenant_id uuid, is_open boolean, reason text, certified_until date)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, machvon_bi, machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  holder uuid := machvon_bi.tenant_of(p_login);
  switched boolean;
  certification text;
  expires date;
  found_row boolean := false;
  today date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  IF holder IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, false, 'NO_BINDING'::text, NULL::date;
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', holder::text, true);
  SELECT true, e.enabled, p.certification_status, p.certification_expires_on INTO found_row, switched, certification, expires
    FROM machvon.int_export_dataset e
    LEFT JOIN machvon.data_product p ON p.tenant_id = e.tenant_id AND p.id = e.product_id
   WHERE e.tenant_id = holder AND e.dataset_code = p_dataset;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  IF NOT coalesce(found_row, false) OR NOT coalesce(switched, false) THEN
    RETURN QUERY SELECT holder, false, 'DISABLED'::text, NULL::date;
  ELSIF certification IS DISTINCT FROM 'CERTIFIED' THEN
    RETURN QUERY SELECT holder, false, 'NOT_CERTIFIED'::text, expires;
  ELSIF expires IS NOT NULL AND expires <= today THEN
    RETURN QUERY SELECT holder, false, 'EXPIRED'::text, expires;
  ELSE
    RETURN QUERY SELECT holder, true, 'OPEN'::text, expires;
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION machvon_bi.tenant_of(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon_bi.dataset_state(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon_bi.tenant_of(text) TO machvon_bi_reader;
GRANT EXECUTE ON FUNCTION machvon_bi.dataset_state(text, text) TO machvon_bi_reader;
-- The columns the views read, and no others. RLS conditions run with the rights of the reader, so tenant_id is in each list.
GRANT SELECT (tenant_id, id, period_id, snapshot_kind, as_of_date, status) ON machvon.period_snapshot TO machvon_bi_reader;
GRANT SELECT (tenant_id, id, snapshot_id, project_id, unit_id, fund_source_version_id, bucket, budget_level, plan_total_vnd, disbursed_treasury_vnd, disbursed_reported_vnd, period_delta_vnd, rate_total_pct, rate_null_reason, treasury_coverage)
  ON machvon.period_snapshot_line TO machvon_bi_reader;
GRANT SELECT (tenant_id, id, period_snapshot_id, period_id, revision, cutoff_date) ON machvon.contract_fact_snapshot TO machvon_bi_reader;
GRANT SELECT (tenant_id, snapshot_id, contract_id, contractor_id, is_lead, share_pct, project_id, unit_id, contract_status, contract_type, contract_value_vnd, active_value_vnd, paid_vnd)
  ON machvon.contract_fact_snapshot_line TO machvon_bi_reader;

CREATE POLICY bi_reader_boundary ON machvon.period_snapshot AS RESTRICTIVE FOR SELECT TO machvon_bi_reader USING (tenant_id = (SELECT machvon_bi.tenant_of(current_user::text)) AND ((SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-DISB') d) OR (SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-CTR') d)) AND status = 'FROZEN' AND snapshot_kind = 'PERIOD_CLOSE');
CREATE POLICY bi_reader_boundary ON machvon.period_snapshot_line AS RESTRICTIVE FOR SELECT TO machvon_bi_reader USING (tenant_id = (SELECT machvon_bi.tenant_of(current_user::text)) AND (SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-DISB') d) AND EXISTS (SELECT 1 FROM machvon.period_snapshot p WHERE p.tenant_id = period_snapshot_line.tenant_id AND p.id = period_snapshot_line.snapshot_id AND p.status = 'FROZEN' AND p.snapshot_kind = 'PERIOD_CLOSE'));
CREATE POLICY bi_reader_boundary ON machvon.contract_fact_snapshot AS RESTRICTIVE FOR SELECT TO machvon_bi_reader USING (tenant_id = (SELECT machvon_bi.tenant_of(current_user::text)) AND (SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-CTR') d));
CREATE POLICY bi_reader_boundary ON machvon.contract_fact_snapshot_line AS RESTRICTIVE FOR SELECT TO machvon_bi_reader USING (tenant_id = (SELECT machvon_bi.tenant_of(current_user::text)) AND (SELECT d.is_open FROM machvon_bi.dataset_state(current_user::text, 'DS-CTR') d));

-- DS-DISB: one row per line of a FROZEN close snapshot of a reporting period (the figures of the disbursement of public investment, by project, unit, fund source version and bucket).
CREATE VIEW machvon_bi.v_disbursement_lines WITH (security_invoker = true) AS
SELECT
  g.tenant_id,
  s.id AS snapshot_id,
  s.period_id,
  s.as_of_date,
  l.id AS line_id,
  l.project_id,
  l.unit_id,
  l.fund_source_version_id,
  l.bucket,
  l.budget_level,
  l.plan_total_vnd,
  l.disbursed_treasury_vnd,
  l.disbursed_reported_vnd,
  l.period_delta_vnd,
  l.rate_total_pct,
  l.rate_null_reason,
  l.treasury_coverage,
  g.certified_until AS certification_expires_on
FROM machvon_bi.dataset_state(current_user::text, 'DS-DISB') g
JOIN machvon.period_snapshot s ON g.is_open AND s.tenant_id = g.tenant_id AND s.status = 'FROZEN' AND s.snapshot_kind = 'PERIOD_CLOSE'
JOIN machvon.period_snapshot_line l ON l.tenant_id = s.tenant_id AND l.snapshot_id = s.id;

-- DS-CTR: one row per contract and active party of the frozen contract fact of a FROZEN close snapshot (every revision of the period is a row set of its own, so a reader can see a correction).
CREATE VIEW machvon_bi.v_contract_lines WITH (security_invoker = true) AS
SELECT
  g.tenant_id,
  s.id AS snapshot_id,
  s.period_id,
  s.revision,
  s.cutoff_date,
  l.contract_id,
  l.contractor_id,
  l.is_lead,
  l.share_pct,
  l.project_id,
  l.unit_id,
  l.contract_status,
  l.contract_type,
  l.contract_value_vnd,
  l.active_value_vnd,
  l.paid_vnd,
  g.certified_until AS certification_expires_on
FROM machvon_bi.dataset_state(current_user::text, 'DS-CTR') g
JOIN machvon.contract_fact_snapshot s ON g.is_open AND s.tenant_id = g.tenant_id
JOIN machvon.period_snapshot p ON p.tenant_id = s.tenant_id AND p.id = s.period_snapshot_id AND p.status = 'FROZEN'
JOIN machvon.contract_fact_snapshot_line l ON l.tenant_id = s.tenant_id AND l.snapshot_id = s.id;

-- What the login may read, and why a dataset is closed when it is: the first thing a person opens in the tool.
CREATE VIEW machvon_bi.v_dataset_catalogue WITH (security_invoker = true) AS
SELECT d.dataset_code, d.view_name, d.grain, s.is_open, s.reason, s.certified_until
FROM (VALUES
  ('DS-DISB', 'v_disbursement_lines', 'one row per line of a frozen close snapshot of a reporting period'),
  ('DS-CTR', 'v_contract_lines', 'one row per contract and active party of a frozen contract fact snapshot')
) AS d(dataset_code, view_name, grain)
CROSS JOIN LATERAL machvon_bi.dataset_state(current_user::text, d.dataset_code) s;

GRANT SELECT ON machvon_bi.v_disbursement_lines, machvon_bi.v_contract_lines, machvon_bi.v_dataset_catalogue TO machvon_bi_reader;

COMMENT ON VIEW machvon_bi.v_disbursement_lines IS 'INT-1: DS-DISB for external readers; security_invoker; the tenant is resolved from current_user through machvon_bi.reader_binding, never from app.tenant_id.';
COMMENT ON VIEW machvon_bi.v_contract_lines IS 'INT-1: DS-CTR for external readers; security_invoker; the tenant is resolved from current_user through machvon_bi.reader_binding, never from app.tenant_id.';
COMMENT ON VIEW machvon_bi.v_dataset_catalogue IS 'INT-1: the datasets a BI login may read and whether each is open (switched on and certified) now.';
