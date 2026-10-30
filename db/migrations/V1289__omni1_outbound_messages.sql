-- Authored by hand (not generated), ST-OMNI-005 (OMNI.md 3.3): what an agent says in a conversation. A message to the person is queued as a row of `channel_message` (OUTBOUND, status Queued) and goes out through the adapter of the channel
-- account of the conversation, later and outside any command; a note for the colleagues is a row too (INTERNAL_NOTE) that has no status and never a provider id (V002 checks it).
--   * a message keeps what it links to (opaque links to documents of the tenant), the subject of a mail made from a template, how often it was tried and when it is tried next, the code of the failure;
--   * every time a message is taken up for sending is a row of `channel_message_send` (the account, the moment, the estimated price): what the cap and the budget of the channel account count with the attempts of the notifications (BR-NOT-13). A retry is a row of its own, and a message that is put back because the channel is closed for the moment gives its row back;
--   * what a message says never changes (the purpose, the template and the links join the text, the author and the direction that V1287 already keeps);
--   * its status moves forward only: Queued, ProviderAccepted, Delivered, Read; a failure comes before delivery and is final. A late receipt can not undo a later one;
--   * the sends that are due are found by an index.

ALTER TABLE machvon.channel_message ADD COLUMN links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE machvon.channel_message ADD COLUMN subject text CHECK (subject IS NULL OR length(subject) <= 200);
ALTER TABLE machvon.channel_message ADD COLUMN send_attempts integer NOT NULL DEFAULT 0 CHECK (send_attempts >= 0);
ALTER TABLE machvon.channel_message ADD COLUMN next_attempt_at timestamptz;
-- When an attempt was taken up and its result was not recorded yet: a message found with this set, once its lease ran out, may have gone, and is asked about at the provider before anything is sent again.
ALTER TABLE machvon.channel_message ADD COLUMN claimed_at timestamptz;
ALTER TABLE machvon.channel_message ADD COLUMN error_code text CHECK (error_code IS NULL OR length(error_code) <= 100);
ALTER TABLE machvon.channel_message ADD CONSTRAINT channel_message_outbound_status_ck
  CHECK ((direction = 'OUTBOUND') = (delivery_status IS NOT NULL));

CREATE TABLE machvon.channel_message_send (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  message_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  channel_account_id uuid NOT NULL,
  sending_at timestamptz NOT NULL,
  cost numeric(24,8) NOT NULL CHECK (cost >= 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, message_id, attempt_no),
  FOREIGN KEY (tenant_id, message_id) REFERENCES machvon.channel_message (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES machvon.channel_account (tenant_id, id)
);
CREATE INDEX channel_message_send_account_idx ON machvon.channel_message_send (tenant_id, channel_account_id, sending_at);
ALTER TABLE machvon.channel_message_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.channel_message_send FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.channel_message_send AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.channel_message_send AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- A row is never changed: it is added when a message is taken up, and removed only when that attempt is put back.
REVOKE UPDATE, TRUNCATE ON TABLE machvon.channel_message_send FROM machvon_app;

CREATE INDEX channel_message_due_idx ON machvon.channel_message (tenant_id, next_attempt_at, id) WHERE direction = 'OUTBOUND' AND delivery_status = 'Queued';

CREATE OR REPLACE FUNCTION machvon.guard_channel_message() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  rank_old integer;
  rank_new integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MESSAGE_IMMUTABLE: a message is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.conversation_id, NEW.direction, NEW.body_text, NEW.author_membership_id, NEW.created_at, NEW.purpose, NEW.template_version_id, NEW.links, NEW.subject)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.conversation_id, OLD.direction, OLD.body_text, OLD.author_membership_id, OLD.created_at, OLD.purpose, OLD.template_version_id, OLD.links, OLD.subject) THEN
    RAISE EXCEPTION 'MESSAGE_IMMUTABLE: what a message says does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status THEN
    rank_old := CASE OLD.delivery_status WHEN 'Queued' THEN 0 WHEN 'ProviderAccepted' THEN 1 WHEN 'Delivered' THEN 2 WHEN 'Read' THEN 3 END;
    rank_new := CASE NEW.delivery_status WHEN 'Queued' THEN 0 WHEN 'ProviderAccepted' THEN 1 WHEN 'Delivered' THEN 2 WHEN 'Read' THEN 3 END;
    IF OLD.delivery_status IS NULL OR NEW.delivery_status IS NULL OR OLD.delivery_status = 'Failed'
       OR (NEW.delivery_status = 'Failed' AND rank_old > 1)
       OR (NEW.delivery_status <> 'Failed' AND rank_new <= rank_old) THEN
      RAISE EXCEPTION 'MESSAGE_STATE_INVALID: a message does not go from % to %', OLD.delivery_status, NEW.delivery_status USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
