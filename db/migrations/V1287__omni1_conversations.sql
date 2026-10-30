-- Authored by hand (not generated), ST-OMNI-004 (OMNI.md 3.1, 3.2): the conversations and the messages that come in. V002 laid down `conversation` and `channel_message` (unique by account and thread, the note without a provider id); this adds what the inbox and
-- the assignment need and guards the tables:
--   * a conversation has the unit whose queue it is in (`queue_unit_id`, set by the routing policy, ST-OMNI-006; none means the queue of the whole tenant) and the moment it was assigned;
--   * a message keeps the text that came in (`body_text`: personal data of the person, read only through the conversation); a message of a provider is one per provider id in a conversation already (V002), so the same message coming twice is one;
--   * a closed conversation is final (OMNI.md 4): a message on its thread opens a new conversation, which points to the one before it (`previous_conversation_id`), so the thread is unique among the conversations that are not closed;
--   * what a conversation is (account, thread, when it began, the one before it) never changes; it moves only the ways the state table of OMNI.md allows; it is kept and never deleted;
--   * what a message is (conversation, direction, text, who wrote it) never changes; a message is kept and never deleted.

ALTER TABLE machvon.conversation ADD COLUMN queue_unit_id uuid;
ALTER TABLE machvon.conversation ADD COLUMN assigned_at timestamptz;
ALTER TABLE machvon.conversation ADD COLUMN previous_conversation_id uuid;
ALTER TABLE machvon.conversation ADD FOREIGN KEY (tenant_id, queue_unit_id) REFERENCES machvon.organization_unit (tenant_id, id);
ALTER TABLE machvon.conversation ADD FOREIGN KEY (tenant_id, previous_conversation_id) REFERENCES machvon.conversation (tenant_id, id);
DROP INDEX machvon.conversation_thread_uq;
CREATE UNIQUE INDEX conversation_open_thread_uq ON machvon.conversation (tenant_id, channel_account_id, external_thread_id) WHERE status <> 'Closed';
CREATE INDEX conversation_thread_history_idx ON machvon.conversation (tenant_id, channel_account_id, external_thread_id, created_at DESC);
ALTER TABLE machvon.channel_message ADD COLUMN body_text text;
ALTER TABLE machvon.channel_message ADD CONSTRAINT channel_message_body_ck CHECK (body_text IS NULL OR length(body_text) <= 20000);

CREATE INDEX channel_message_conversation_page_idx ON machvon.channel_message (tenant_id, conversation_id, created_at, id);
CREATE INDEX conversation_page_idx ON machvon.conversation (tenant_id, created_at DESC, id DESC);
CREATE INDEX conversation_queue_unit_idx ON machvon.conversation (tenant_id, queue_unit_id);
CREATE INDEX conversation_previous_idx ON machvon.conversation (tenant_id, previous_conversation_id);

CREATE FUNCTION machvon.guard_conversation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CONVERSATION_IMMUTABLE: a conversation is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.channel_account_id, NEW.external_thread_id, NEW.created_at, NEW.previous_conversation_id) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.channel_account_id, OLD.external_thread_id, OLD.created_at, OLD.previous_conversation_id) THEN
    RAISE EXCEPTION 'CONVERSATION_IMMUTABLE: what a conversation is does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('New', 'Assigned'), ('Assigned', 'InProgress'),
       ('InProgress', 'PendingCustomer'), ('InProgress', 'Resolved'),
       ('PendingCustomer', 'InProgress'), ('PendingCustomer', 'Resolved'),
       ('Resolved', 'InProgress'), ('Resolved', 'Closed'))) THEN
    RAISE EXCEPTION 'CONVERSATION_STATE_INVALID: a conversation does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER conversation_guard BEFORE UPDATE OR DELETE ON machvon.conversation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_conversation();
REVOKE DELETE, TRUNCATE ON TABLE machvon.conversation FROM machvon_app;

CREATE FUNCTION machvon.guard_channel_message() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MESSAGE_IMMUTABLE: a message is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.conversation_id, NEW.direction, NEW.body_text, NEW.author_membership_id, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.conversation_id, OLD.direction, OLD.body_text, OLD.author_membership_id, OLD.created_at) THEN
    RAISE EXCEPTION 'MESSAGE_IMMUTABLE: what a message says does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER channel_message_guard BEFORE UPDATE OR DELETE ON machvon.channel_message
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_channel_message();
REVOKE DELETE, TRUNCATE ON TABLE machvon.channel_message FROM machvon_app;
