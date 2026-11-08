-- Authored by hand (not generated): the anonymous report channel (GOV-12, G4-12 should-have part, practice K17).
-- There is NO column for an address, an agent, an account or a contact, and no timestamp finer than a day on the reporter's side: what the database does not hold cannot be asked for. A reporter is known only by the hash of an
-- access code that was shown once. The public side works through SECURITY DEFINER functions that take the slug of the portal and the hash of the code; they set the tenant of the transaction themselves, and the
-- application role (the handlers) reads and answers through the ordinary tenant policies, with the rights of the auditors checked by the API.

CREATE TABLE machvon.whistle_report (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('CORRUPTION', 'PROCUREMENT_IRREGULARITY', 'WASTE_OF_FUNDS', 'SAFETY', 'CONFLICT_OF_INTEREST', 'RETALIATION', 'OTHER')),
  body text NOT NULL CHECK (body = btrim(body) AND char_length(body) BETWEEN 20 AND 8000),
  access_code_hash char(64) NOT NULL CHECK (access_code_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'DISMISSED')),
  received_on date NOT NULL,
  acknowledge_days integer NOT NULL CHECK (acknowledge_days BETWEEN 1 AND 60),
  resolve_days integer NOT NULL CHECK (resolve_days BETWEEN 1 AND 730),
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  subject_unit_id uuid,
  handler_membership_id uuid,
  acknowledged_on date,
  closed_on date,
  public_note text CHECK (public_note IS NULL OR (public_note = btrim(public_note) AND char_length(public_note) BETWEEN 10 AND 4000)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subject_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, handler_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT whistle_report_code_uq UNIQUE (tenant_id, access_code_hash),
  CONSTRAINT whistle_report_closed_chk CHECK ((status IN ('RESOLVED', 'DISMISSED')) = (closed_on IS NOT NULL) AND (closed_on IS NULL OR public_note IS NOT NULL)),
  CONSTRAINT whistle_report_ack_chk CHECK ((status = 'RECEIVED') OR acknowledged_on IS NOT NULL OR status = 'DISMISSED')
);
CREATE INDEX whistle_report_queue_idx ON machvon.whistle_report (tenant_id, status, received_on, id);
CREATE INDEX whistle_report_unit_idx ON machvon.whistle_report (tenant_id, subject_unit_id) WHERE subject_unit_id IS NOT NULL;
CREATE INDEX whistle_report_handler_idx ON machvon.whistle_report (tenant_id, handler_membership_id) WHERE handler_membership_id IS NOT NULL;
ALTER TABLE machvon.whistle_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.whistle_report FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.whistle_report AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.whistle_report AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE, UPDATE ON TABLE machvon.whistle_report FROM machvon_app;
GRANT UPDATE (status, subject_unit_id, handler_membership_id, acknowledged_on, closed_on, public_note, version) ON TABLE machvon.whistle_report TO machvon_app;

CREATE TABLE machvon.whistle_message (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  sender text NOT NULL CHECK (sender IN ('REPORTER', 'HANDLER')),
  body text NOT NULL CHECK (body = btrim(body) AND char_length(body) BETWEEN 1 AND 4000),
  sent_on date NOT NULL,
  handler_membership_id uuid,
  seq integer NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, report_id) REFERENCES machvon.whistle_report (tenant_id, id),
  FOREIGN KEY (tenant_id, handler_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT whistle_message_seq_uq UNIQUE (tenant_id, report_id, seq),
  CONSTRAINT whistle_message_sender_chk CHECK ((sender = 'HANDLER') = (handler_membership_id IS NOT NULL))
);
CREATE INDEX whistle_message_report_idx ON machvon.whistle_message (tenant_id, report_id, seq);
CREATE INDEX whistle_message_handler_idx ON machvon.whistle_message (tenant_id, handler_membership_id) WHERE handler_membership_id IS NOT NULL;
ALTER TABLE machvon.whistle_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.whistle_message FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.whistle_message AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.whistle_message AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.whistle_message FROM machvon_app;

CREATE FUNCTION machvon.whistle_tenant(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT holder_tenant_id FROM machvon.portal_directory WHERE slug = lower(p_slug) AND enabled AND whistle_enabled;
$fn$;
REVOKE ALL ON FUNCTION machvon.whistle_tenant(text) FROM PUBLIC;

-- Submits a report. The caller gives the days of the rule as the portal settings hold them (a snapshot taken when the settings were saved: the public side cannot read the rules of a tenant); the table checks their range.
CREATE FUNCTION machvon.whistle_submit(p_slug text, p_category text, p_body text, p_code_hash text, p_received_on date, p_acknowledge_days integer, p_resolve_days integer, p_rule_version integer)
RETURNS date
LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
DECLARE
  v_tenant uuid := machvon.whistle_tenant(p_slug);
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'WHISTLE_CHANNEL_OFF: there is no open channel at this address' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  INSERT INTO machvon.whistle_report (tenant_id, category, body, access_code_hash, received_on, acknowledge_days, resolve_days, rule_version)
  VALUES (v_tenant, p_category, p_body, p_code_hash, p_received_on, p_acknowledge_days, p_resolve_days, p_rule_version);
  PERFORM set_config('app.tenant_id', '', true);
  RETURN p_received_on;
END $fn$;

CREATE FUNCTION machvon.whistle_lookup(p_slug text, p_code_hash text) RETURNS TABLE (category text, status text, received_on date, acknowledged_on date, closed_on date, public_note text, acknowledge_days integer, resolve_days integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
DECLARE
  v_tenant uuid := machvon.whistle_tenant(p_slug);
BEGIN
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  RETURN QUERY SELECT r.category, r.status, r.received_on, r.acknowledged_on, r.closed_on, r.public_note, r.acknowledge_days, r.resolve_days FROM machvon.whistle_report r WHERE r.tenant_id = v_tenant AND r.access_code_hash = p_code_hash;
  PERFORM set_config('app.tenant_id', '', true);
END $fn$;

CREATE FUNCTION machvon.whistle_thread(p_slug text, p_code_hash text) RETURNS TABLE (seq integer, sender text, body text, sent_on date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
DECLARE
  v_tenant uuid := machvon.whistle_tenant(p_slug);
BEGIN
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  RETURN QUERY SELECT m.seq, m.sender, m.body, m.sent_on FROM machvon.whistle_message m JOIN machvon.whistle_report r ON r.tenant_id = m.tenant_id AND r.id = m.report_id WHERE r.tenant_id = v_tenant AND r.access_code_hash = p_code_hash ORDER BY m.seq;
  PERFORM set_config('app.tenant_id', '', true);
END $fn$;

CREATE FUNCTION machvon.whistle_reply(p_slug text, p_code_hash text, p_body text, p_sent_on date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
DECLARE
  v_tenant uuid := machvon.whistle_tenant(p_slug);
  v_report machvon.whistle_report%ROWTYPE;
  v_seq integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'WHISTLE_CHANNEL_OFF: there is no open channel at this address' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  SELECT * INTO v_report FROM machvon.whistle_report WHERE tenant_id = v_tenant AND access_code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_id', '', true);
    RAISE EXCEPTION 'WHISTLE_CODE_UNKNOWN: no report has this code' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.status IN ('RESOLVED', 'DISMISSED') THEN
    PERFORM set_config('app.tenant_id', '', true);
    RAISE EXCEPTION 'WHISTLE_REPORT_CLOSED: the report is closed' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM machvon.whistle_message WHERE tenant_id = v_tenant AND report_id = v_report.id;
  INSERT INTO machvon.whistle_message (tenant_id, report_id, sender, body, sent_on, seq) VALUES (v_tenant, v_report.id, 'REPORTER', p_body, p_sent_on, v_seq);
  PERFORM set_config('app.tenant_id', '', true);
  RETURN v_seq;
END $fn$;
REVOKE ALL ON FUNCTION machvon.whistle_submit(text, text, text, text, date, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.whistle_lookup(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.whistle_thread(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.whistle_reply(text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.whistle_submit(text, text, text, text, date, integer, integer, integer) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.whistle_lookup(text, text) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.whistle_thread(text, text) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.whistle_reply(text, text, text, date) TO machvon_control;

COMMENT ON TABLE machvon.whistle_report IS 'Anonymous report: no address, agent, account or contact column; the reporter is known only by the hash of an access code; dates have day precision.';
