-- Authored by hand (not generated): preferences, quiet hours and the consent history of the notification module (ST-NOT-003, NOT 3.3, BR-NOT-07, BR-NOT-08).
--   * notification_preference_profile: the settings of one person that are not per channel (quiet hours, time zone) and the version the whole set is
--     changed under (If-Match of updateMyNotificationPreferences). V002 put quiet_start, quiet_end and time_zone on every preference row, which cannot hold
--     them for a person who has no row and has no single version for a PUT of the whole set; those columns stay as V002 left them and are not read.
--   * notification_preference: the category of an event is a name or the star (all categories), so a row cannot hold free text.
--   * contact_consent: the history is append-only. A consent is granted once and leaves "Granted" once (withdrawn or expired); a new consent is a new
--     row; the latest one decides. No role can delete a row, and a row that has ended is never changed.

CREATE TABLE machvon.notification_preference_profile (
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  quiet_start time,
  quiet_end time,
  time_zone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT notification_preference_profile_quiet_chk CHECK ((quiet_start IS NULL) = (quiet_end IS NULL) AND (quiet_start IS NULL OR quiet_start <> quiet_end)),
  CONSTRAINT notification_preference_profile_zone_chk CHECK (time_zone <> '' AND length(time_zone) <= 64),
  CONSTRAINT notification_preference_profile_version_chk CHECK (version >= 1)
);

ALTER TABLE machvon.notification_preference_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.notification_preference_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.notification_preference_profile AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.notification_preference_profile AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.notification_preference_profile FROM machvon_app;

ALTER TABLE machvon.notification_preference
  ADD CONSTRAINT notification_preference_category_chk CHECK (event_category ~ '^(\*|[a-z][a-z0-9_]{0,59})$');

-- Consent: what can be consented to, and the facts a withdrawal needs.
ALTER TABLE machvon.contact_consent
  ADD CONSTRAINT contact_consent_channel_chk CHECK (channel IN ('EMAIL', 'SMS', 'ZALO', 'WHATSAPP', 'PUSH')),
  ADD CONSTRAINT contact_consent_purpose_chk CHECK (purpose IN ('OPERATIONAL', 'REMINDER', 'ANNOUNCEMENT', 'SUPPORT_CONVERSATION')),
  ADD CONSTRAINT contact_consent_withdrawn_reason_chk CHECK ((status = 'Withdrawn') = (withdrawn_reason IS NOT NULL)),
  ADD CONSTRAINT contact_consent_ended_chk CHECK (revoked_at IS NULL OR revoked_at >= effective_at),
  ADD CONSTRAINT contact_consent_evidence_chk CHECK (evidence_reference <> '' AND length(evidence_reference) <= 500),
  ADD CONSTRAINT contact_consent_text_version_chk CHECK (consent_text_version <> '' AND length(consent_text_version) <= 50);

-- The latest consent of a person for a channel and purpose is read at every send: one index lookup.
CREATE INDEX contact_consent_latest_idx ON machvon.contact_consent (tenant_id, membership_id, channel, purpose, effective_at DESC, id DESC) WHERE membership_id IS NOT NULL;
CREATE INDEX contact_consent_history_idx ON machvon.contact_consent (tenant_id, membership_id, effective_at DESC, id DESC) WHERE membership_id IS NOT NULL;
CREATE INDEX contact_consent_page_idx ON machvon.contact_consent (tenant_id, effective_at DESC, id DESC);

-- A consent is evidence. Its facts never change; the one change it undergoes is the end of its life (withdrawn by the person, or expired), once, and an
-- ended consent is final. The version moves with that change so a stale withdrawal is refused.
CREATE FUNCTION machvon.guard_contact_consent() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a consent is kept as evidence and never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.evidence_reference IS DISTINCT FROM OLD.evidence_reference OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
     OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis OR NEW.consent_text_version IS DISTINCT FROM OLD.consent_text_version
     OR NEW.capture_method IS DISTINCT FROM OLD.capture_method THEN
    RAISE EXCEPTION 'the facts of a consent never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'Granted' THEN
    RAISE EXCEPTION 'a consent that has ended is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'Granted' THEN
    RAISE EXCEPTION 'a granted consent can only end' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'the version of a consent moves with its change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER contact_consent_guard BEFORE UPDATE OR DELETE ON machvon.contact_consent
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contact_consent();

REVOKE DELETE, TRUNCATE ON TABLE machvon.contact_consent FROM machvon_app;
