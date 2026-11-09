-- Authored by hand (not generated): ENT-4d (docs/ent-leader-dashboard.md, docs/plans/ent4d.md). Scheduled delivery by e-mail of ISSUED report-engine forms (HSKT BC.02 "ho tro gui bao cao tu dong qua email theo lich").
--   * `report_mail_schedule`: which form series (the layout code), when (a five-field cron in the time zone of Vietnam), in which file format, to whom (members of the tenant, one to fifty: the address is read from the
--     member when the message is sent and is never kept here) and with which note. What a schedule asks never changes; the only moves are the mark of the last run (forward only) and RETIRED, which is final.
--     A schedule mails only copies issued after it was made, so making one never floods the recipients with the history.
--   * `report_mailing`: the mailing log, one row for each (schedule, issued copy, recipient). It is written BEFORE the message is handed to the channel (SENDING) and settled after: SENT, FAILED (may be tried again, up to the
--     attempts the rule allows), REFUSED (for good), UNKNOWN (the answer was lost after the request may have left: never sent again on its own) or SKIPPED (a DEMO form, a format the copy does not have). The file that was
--     attached is named by its SHA-256, which is also in the message. Nothing is deleted. (The older `report_delivery` is the hand-over of a copy to a receiving body such as HPM; this is the e-mail to people.)

CREATE TABLE machvon.report_mail_schedule (
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
  CONSTRAINT report_mail_schedule_layout_chk CHECK (layout_code ~ '^[A-Za-z0-9._-]{2,80}$'),
  CONSTRAINT report_mail_schedule_cron_chk CHECK (cron = btrim(cron) AND char_length(cron) BETWEEN 9 AND 120),
  CONSTRAINT report_mail_schedule_format_chk CHECK (format IN ('XLSX', 'DOCX', 'PDF')),
  CONSTRAINT report_mail_schedule_recipients_chk CHECK (cardinality(recipients) BETWEEN 1 AND 50),
  CONSTRAINT report_mail_schedule_note_chk CHECK (note IS NULL OR (char_length(note) BETWEEN 1 AND 1000)),
  CONSTRAINT report_mail_schedule_status_chk CHECK (status IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT report_mail_schedule_retired_chk CHECK (status <> 'RETIRED' OR (retired_at IS NOT NULL AND retired_by IS NOT NULL AND nullif(btrim(coalesce(retire_reason, '')), '') IS NOT NULL))
);
CREATE INDEX report_mail_schedule_status_idx ON machvon.report_mail_schedule (tenant_id, status, created_at DESC, id);
CREATE INDEX report_mail_schedule_creator_idx ON machvon.report_mail_schedule (tenant_id, created_by);

CREATE TABLE machvon.report_mailing (
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
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES machvon.report_mail_schedule (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES machvon.report_issue (tenant_id, id),
  CONSTRAINT report_mailing_key_uq UNIQUE (tenant_id, schedule_id, issue_id, recipient_id),
  CONSTRAINT report_mailing_status_chk CHECK (status IN ('SENDING', 'SENT', 'FAILED', 'REFUSED', 'UNKNOWN', 'SKIPPED')),
  CONSTRAINT report_mailing_channel_chk CHECK (channel IN ('EMAIL')),
  CONSTRAINT report_mailing_format_chk CHECK (file_format IN ('XLSX', 'DOCX', 'PDF')),
  CONSTRAINT report_mailing_hash_chk CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT report_mailing_attempts_chk CHECK (attempts >= 0 AND attempts <= 20),
  CONSTRAINT report_mailing_sent_chk CHECK (status <> 'SENT' OR (sent_at IS NOT NULL AND file_sha256 IS NOT NULL)),
  CONSTRAINT report_mailing_error_chk CHECK (status IN ('SENDING', 'SENT') OR nullif(btrim(coalesce(error_code, '')), '') IS NOT NULL)
);
CREATE INDEX report_mailing_schedule_idx ON machvon.report_mailing (tenant_id, schedule_id, created_at DESC, id);
CREATE INDEX report_mailing_issue_idx ON machvon.report_mailing (tenant_id, issue_id);
CREATE INDEX report_mailing_recipient_idx ON machvon.report_mailing (tenant_id, recipient_id);
CREATE INDEX report_mailing_provider_message_idx ON machvon.report_mailing (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE FUNCTION machvon.guard_report_mail_schedule() RETURNS trigger
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
    RAISE EXCEPTION 'report mail schedules are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.layout_code, NEW.cron, NEW.timezone, NEW.format, NEW.recipients, NEW.note, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.layout_code, OLD.cron, OLD.timezone, OLD.format, OLD.recipients, OLD.note, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a report mail schedule asks, its recipients and its maker never change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'RETIRED' AND (NEW.status <> 'RETIRED' OR (NEW.retired_at, NEW.retired_by, NEW.retire_reason) IS DISTINCT FROM (OLD.retired_at, OLD.retired_by, OLD.retire_reason)) THEN
    RAISE EXCEPTION 'a retired report mail schedule is final' USING ERRCODE = '42501';
  END IF;
  IF NEW.last_run_at IS NOT NULL AND OLD.last_run_at IS NOT NULL AND NEW.last_run_at < OLD.last_run_at THEN
    RAISE EXCEPTION 'the last run of a report mail schedule only moves forward' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_mail_schedule_guard BEFORE UPDATE OR DELETE ON machvon.report_mail_schedule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_report_mail_schedule();
CREATE TRIGGER report_mail_schedule_no_truncate BEFORE TRUNCATE ON machvon.report_mail_schedule
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_report_mail_schedule();

CREATE FUNCTION machvon.guard_report_mailing() RETURNS trigger
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
    RAISE EXCEPTION 'the report mailing log is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.schedule_id, NEW.issue_id, NEW.recipient_id, NEW.channel, NEW.created_at)
     IS DISTINCT FROM (OLD.schedule_id, OLD.issue_id, OLD.recipient_id, OLD.channel, OLD.created_at) THEN
    RAISE EXCEPTION 'what a mailing is of and for whom never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('SENT', 'REFUSED', 'SKIPPED', 'UNKNOWN')
     AND (NEW.status, NEW.file_format, NEW.file_sha256, NEW.file_name, NEW.error_code, NEW.provider_message_id, NEW.sent_at, NEW.attempts)
         IS DISTINCT FROM (OLD.status, OLD.file_format, OLD.file_sha256, OLD.file_name, OLD.error_code, OLD.provider_message_id, OLD.sent_at, OLD.attempts) THEN
    RAISE EXCEPTION 'a mailing that ended as % is not changed', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'the attempts of a mailing only grow' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER report_mailing_guard BEFORE UPDATE OR DELETE ON machvon.report_mailing
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_report_mailing();
CREATE TRIGGER report_mailing_no_truncate BEFORE TRUNCATE ON machvon.report_mailing
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_report_mailing();

ALTER TABLE machvon.report_mail_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_mail_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_mail_schedule AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_mail_schedule AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.report_mailing ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.report_mailing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.report_mailing AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.report_mailing AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.report_mail_schedule FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.report_mailing FROM machvon_app;

COMMENT ON TABLE machvon.report_mail_schedule IS 'ENT-4d: a schedule that mails the issued copies of one report form to members of the tenant; what it asks never changes.';
COMMENT ON TABLE machvon.report_mailing IS 'ENT-4d: the mailing log, one row for each (schedule, issued copy, recipient), with the SHA-256 of the file that was attached.';
