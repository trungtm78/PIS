-- Authored by hand (not generated), ST-NOT-009 (NOT 3.5, BR-NOT-12): the broadcast campaign. V002 laid down the table (the four-eyes check, "approved means previewed"); this adds what the flow needs and guards it:
--   * the last preview keeps its count of left-out people by reason (the screens show them), the moments of the steps, the decision with its reason and the count of the notifications made on approval;
--   * a campaign is kept and never deleted; what it is (name, purpose, template, segment, time, who made it) never changes after it is made; the preview changes only while the campaign is a draft or previewed;
--   * a campaign moves only the ways the state table of NOT 3.5 allows, and what ended (Completed, Rejected, Cancelled) is not touched again;
--   * the person who made the campaign neither approves it nor returns or rejects it (the check of V002 covers the approval; the decision as a whole is covered here).

ALTER TABLE machvon.notification_campaign ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE machvon.notification_campaign ADD COLUMN preview_excluded jsonb;
ALTER TABLE machvon.notification_campaign ADD COLUMN submitted_at timestamptz;
ALTER TABLE machvon.notification_campaign ADD COLUMN decided_by uuid;
ALTER TABLE machvon.notification_campaign ADD COLUMN decided_at timestamptz;
ALTER TABLE machvon.notification_campaign ADD COLUMN decision_reason text;
ALTER TABLE machvon.notification_campaign ADD COLUMN cancelled_at timestamptz;
ALTER TABLE machvon.notification_campaign ADD COLUMN completed_at timestamptz;
ALTER TABLE machvon.notification_campaign ADD COLUMN notification_count integer NOT NULL DEFAULT 0 CHECK (notification_count >= 0);
ALTER TABLE machvon.notification_campaign ADD CONSTRAINT notification_campaign_excluded_ck CHECK (preview_excluded IS NULL OR jsonb_typeof(preview_excluded) = 'object');
ALTER TABLE machvon.notification_campaign ADD CONSTRAINT notification_campaign_decider_ck CHECK (decided_by IS NULL OR decided_by <> created_by);

CREATE FUNCTION machvon.guard_notification_campaign() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE: a campaign is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.name, NEW.purpose, NEW.template_version_id, NEW.segment_json, NEW.scheduled_at, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.name, OLD.purpose, OLD.template_version_id, OLD.segment_json, OLD.scheduled_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE: what a campaign is does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('Completed', 'Rejected', 'Cancelled') THEN
    RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE: a campaign that ended is not touched again' USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('Draft', 'Previewed') AND (NEW.preview_hash, NEW.preview_recipient_count, NEW.preview_excluded_count, NEW.preview_excluded, NEW.previewed_at)
       IS DISTINCT FROM (OLD.preview_hash, OLD.preview_recipient_count, OLD.preview_excluded_count, OLD.preview_excluded, OLD.previewed_at) THEN
    RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE: the preview of a campaign that was sent to approval does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('Draft', 'Previewed'), ('Previewed', 'PendingApproval'), ('PendingApproval', 'Approved'), ('PendingApproval', 'Rejected'), ('PendingApproval', 'Draft'),
       ('Approved', 'Scheduled'), ('Approved', 'Sending'), ('Scheduled', 'Sending'), ('Sending', 'Completed'),
       ('Draft', 'Cancelled'), ('Previewed', 'Cancelled'), ('PendingApproval', 'Cancelled'), ('Approved', 'Cancelled'), ('Scheduled', 'Cancelled'), ('Sending', 'Cancelled'))) THEN
    RAISE EXCEPTION 'CAMPAIGN_STATE_INVALID: a campaign does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER notification_campaign_guard BEFORE UPDATE OR DELETE ON machvon.notification_campaign
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_notification_campaign();
REVOKE DELETE, TRUNCATE ON TABLE machvon.notification_campaign FROM machvon_app;

-- The list (newest first) and the job that moves the campaigns that are being sent.
CREATE INDEX notification_campaign_page_idx ON machvon.notification_campaign (tenant_id, created_at DESC, id DESC);
CREATE INDEX notification_campaign_progress_idx ON machvon.notification_campaign (status, scheduled_at) WHERE status IN ('Scheduled', 'Sending');
