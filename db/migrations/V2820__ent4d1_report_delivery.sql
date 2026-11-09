-- Authored by hand (not generated): ENT-4d (docs/ent-leader-dashboard.md, docs/plans/ent4d.md). Scheduled delivery by e-mail of ISSUED report-engine forms (HSKT BC.02 "ho tro gui bao cao tu dong qua email theo lich").
--   * `report_delivery_schedule`: which form series (the layout code), when (a five-field cron in the time zone of Vietnam), in which file format, to whom (members of the tenant, one to fifty: the address is read from the
--     member when the message is sent and is never kept here) and with which note. What a schedule asks never changes; the only moves are the mark of the last run (forward only) and RETIRED, which is final.
--     A schedule delivers only copies issued after it was made, so making one never floods the recipients with the history.
--   * `report_delivery`: the delivery log, one row for each (schedule, issued copy, recipient). The file that was attached is named by its SHA-256, which is also in the message. A row is written when the
--     send is attempted and moves forward only: FAILED may be tried again (up to the attempts the rule allows), SENT, REFUSED and SKIPPED are final, UNKNOWN (the answer was lost after the request left) is never sent again
--     on its own. Nothing is deleted.

CREATE TABLE machvon.report_delivery_schedule (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  layout_code text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  format text NOT NULL,
  recipients uuid[] NOT NULL,
  note text,
  status text NOT NULL DEFAULT 'ACTIVE',
  last_run_at timestamptz,
  retired_at timestamptz,
  retired_by uuid,
  retire_reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT report_delivery_schedule_layout_chk CHECK (layout_code ~ '^[A-Za-z0-9._-]{2,80}$'),
  CONSTRAINT report_delivery_schedule_cron_chk CHECK (cron = btrim(cron) AND char_length(cron) BETWEEN 9 AND 120),
  CONSTRAINT report_delivery_schedule_format_chk CHECK (format IN ('XLSX', 'DOCX', 'PDF')),
  CONSTRAINT report_delivery_schedule_recipients_chk CHECK (cardinality(recipients) BETWEEN 1 AND 50),
  CONSTRAINT report_delivery_schedule_note_chk CHECK (note IS NULL OR (char_length(note) BETWEEN 1 AND 1000)),
  CONSTRAINT report_delivery_schedule_status_chk CHECK (status IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT report_delivery_schedule_retired_chk CHECK (status <> 'RETIRED' OR (retired_at IS NOT NULL AND retired_by IS NOT NULL AND nullif(btrim(coalesce(retire_reason, '')), '') IS NOT NULL))
);
CREATE INDEX report_delivery_schedule_status_idx ON machvon.report_delivery_schedule (tenant_id, status, created_at DESC, id);
CREATE INDEX report_delivery_schedule_creator_idx ON machvon.report_delivery_schedule (tenant_id, created_by);

CREATE TABLE machvon.report_delivery (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'EMAIL',
  file_format text NOT NULL,
  file_name text,
  file_sha256 text,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  provider_message_id text,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES machvon.report_delivery_schedule (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id),
  CONSTRAINT report_delivery_key_uq UNIQUE (tenant_id, schedule_id, issue_id, recipient_id),
  CONSTRAINT report_delivery_status_chk CHECK (status IN ('SENT', 'FAILED', 'REFUSED', 'UNKNOWN', 'SKIPPED')),
  CONSTRAINT report_delivery_channel_chk CHECK (channel IN ('EMAIL')),
  CONSTRAINT report_delivery_format_chk CHECK (file_format IN ('XLSX', 'DOCX', 'PDF')),
  CONSTRAINT report_delivery_hash_chk CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_delivery_attempts_chk CHECK (attempts >= 0 AND attempts <= 20),
  CONSTRAINT report_delivery_sent_chk CHECK (status <> 'SENT' OR (sent_at IS NOT NULL AND file_sha256 IS NOT NULL)),
  CONSTRAINT report_delivery_error_chk CHECK (status NOT IN ('FAILED', 'REFUSED', 'UNKNOWN', 'SKIPPED') OR nullif(btrim(coalesce(error_code, '')), '') IS NOT NULL)
);
CREATE INDEX report_delivery_schedule_idx ON machvon.report_delivery (tenant_id, schedule_id, created_at DESC, id);
CREATE INDEX report_delivery_issue_idx ON machvon.report_delivery (tenant_id, issue_id);
CREATE INDEX report_delivery_recipient_idx ON machvon.report_delivery (tenant_id, recipient_id);

CREATE FUNCTION machvon.guard_report_delivery_schedule() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'report delivery schedules are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.layout_code, NEW.cron, NEW.timezone, NEW.format, NEW.recipients, NEW.note, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.layout_code, OLD.cron, OLD.timezone, OLD.format, OLD.recipients, OLD.note, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a report delivery schedule asks, its recipients and its maker never change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'RETIRED' AND (NEW.status <> 'RETIRED' OR (NEW.retired_at, NEW.retired_by, NEW.retire_reason) IS DISTINCT FROM (OLD.retired_at, OLD.retired_by, OLD.retire_reason)) THEN
    RAISE EXCEPTION 'a retired report delivery schedule is final' USING ERRCODE = '42501';
  END IF;
  IF NEW.last_run_at IS NOT NULL AND OLD.last_run_at IS NOT NULL AND NEW.last_run_at < OLD.last_run_at THEN
    RAISE EXCEPTION 'the last run of a report delivery schedule only moves forward' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_delivery_schedule_guard BEFORE UPDATE OR DELETE ON machvon.report_delivery_schedule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_report_delivery_schedule();
CREATE TRIGGER report_delivery_schedule_no_truncate BEFORE TRUNCATE ON machvon.report_delivery_schedule
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_report_delivery_schedule();

CREATE FUNCTION machvon.guard_report_delivery() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'the report delivery log is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.schedule_id, NEW.issue_id, NEW.recipient_id, NEW.channel, NEW.file_format, NEW.created_at)
     IS DISTINCT FROM (OLD.schedule_id, OLD.issue_id, OLD.recipient_id, OLD.channel, OLD.file_format, OLD.created_at) THEN
    RAISE EXCEPTION 'what a delivery is of and for whom never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('SENT', 'REFUSED', 'SKIPPED', 'UNKNOWN') AND (NEW.status, NEW.file_sha256, NEW.file_name, NEW.error_code, NEW.provider_message_id, NEW.sent_at, NEW.attempts) IS DISTINCT FROM (OLD.status, OLD.file_sha256, OLD.file_name, OLD.error_code, OLD.provider_message_id, OLD.sent_at, OLD.attempts) THEN
    RAISE EXCEPTION 'a delivery that ended as % is not changed', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'the attempts of a delivery only grow' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_delivery_guard BEFORE UPDATE OR DELETE ON machvon.report_delivery
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_report_delivery();
CREATE TRIGGER report_delivery_no_truncate BEFORE TRUNCATE ON machvon.report_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_report_delivery();

ALTER TABLE machvon.report_delivery_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_delivery_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_delivery_schedule AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_delivery_schedule AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.report_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_delivery AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_delivery AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.report_delivery_schedule FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.report_delivery FROM machvon_app;

COMMENT ON TABLE machvon.report_delivery_schedule IS 'ENT-4d: a schedule that sends the issued copies of one report form by e-mail to members of the tenant; what it asks never changes.';
COMMENT ON TABLE machvon.report_delivery IS 'ENT-4d: the delivery log, one row for each (schedule, issued copy, recipient), with the SHA-256 of the file that was attached.';
