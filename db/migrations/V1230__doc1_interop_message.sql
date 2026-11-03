-- DOC-1, ST-DOC-021: interoperability of documents through the LGSP of the agency (DOC.md F13). The table doc_interop_message comes from the generated schema (V002: one row for each message that leaves or
-- arrives, unique per direction and external id, and per envelope digest for what arrives). This makes it a record:
--   * The message that leaves belongs to one distribution of an issued document (`distribution_id`, one message for each distribution: sending it again is the same row). The message that arrives belongs to no
--     distribution, and the letter it made points back at it, once.
--   * The shape of each direction: what leaves is queued, sent, acknowledged or refused by the receiving agency, or fails and waits for its next attempt, or is dead after twenty failures; what arrives is received and
--     then processed into an incoming letter. A failure keeps the code of its reason, a wait has the moment it ends, a message that left has the id the LGSP gave it.
--   * The edges of the states, the attempts that are only counted up (a dead message that a person sends again starts a fresh count), the identity of a message that never changes, and the end of the chain: a message
--     that was acknowledged, refused or processed is kept as it is. Nothing is ever deleted (retention 10 years).

ALTER TABLE machvon.doc_interop_message
  ADD COLUMN distribution_id uuid;

ALTER TABLE machvon.doc_interop_message
  ADD CONSTRAINT doc_interop_message_distribution_fk FOREIGN KEY (tenant_id, distribution_id) REFERENCES machvon.document_distribution (tenant_id, id);

-- One message for each distribution, and the distribution is found from it.
CREATE UNIQUE INDEX doc_interop_message_distribution_uq ON machvon.doc_interop_message (tenant_id, distribution_id) WHERE distribution_id IS NOT NULL;
-- The monitor lists the latest first.
CREATE INDEX doc_interop_message_created_idx ON machvon.doc_interop_message (tenant_id, created_at DESC, id DESC);

-- One incoming letter for each message that arrived: the letter is made in the transaction that receives the message, so a second letter for the same message cannot be.
CREATE UNIQUE INDEX incoming_document_interop_message_uq ON machvon.incoming_document (tenant_id, interop_message_id) WHERE interop_message_id IS NOT NULL;

ALTER TABLE machvon.doc_interop_message
  ADD CONSTRAINT doc_interop_message_adapter_chk CHECK (adapter_code = btrim(adapter_code) AND adapter_code <> '' AND char_length(adapter_code) <= 40),
  ADD CONSTRAINT doc_interop_message_hash_chk CHECK (envelope_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT doc_interop_message_key_chk CHECK (envelope_object_key = btrim(envelope_object_key) AND char_length(envelope_object_key) BETWEEN 10 AND 500),
  ADD CONSTRAINT doc_interop_message_codes_chk CHECK (
    (external_message_id IS NULL OR (external_message_id = btrim(external_message_id) AND external_message_id <> '' AND char_length(external_message_id) <= 200))
    AND (sender_code IS NULL OR (sender_code = btrim(sender_code) AND sender_code <> '' AND char_length(sender_code) <= 100))
    AND (receiver_code IS NULL OR (receiver_code = btrim(receiver_code) AND receiver_code <> '' AND char_length(receiver_code) <= 100))),
  ADD CONSTRAINT doc_interop_message_error_chk CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z_]{2,59}$'),
  -- What leaves is for a distribution of a document, to a receiver; what arrives is from a sender with the id the sender gave it and has no distribution, no attempts and no wait.
  ADD CONSTRAINT doc_interop_message_direction_chk CHECK (
    CASE WHEN direction = 'OUTBOUND'
         THEN status IN ('QUEUED', 'SENT', 'ACKED', 'REJECTED', 'FAILED', 'DEAD') AND document_id IS NOT NULL AND distribution_id IS NOT NULL AND receiver_code IS NOT NULL
         ELSE status IN ('RECEIVED', 'PROCESSED') AND distribution_id IS NULL AND external_message_id IS NOT NULL AND sender_code IS NOT NULL AND attempts = 0 AND next_attempt_at IS NULL
              AND (status = 'RECEIVED') = (document_id IS NULL)
    END),
  -- A failure has its reason (a message that waits to be sent again keeps the last one) and, unless it is the last, the moment it is tried again; a message that was handed over has the id the LGSP gave it, and one that was refused has the code of the reason (the receiving agency's, or that its distribution was called off); a message that ended has the moment it ended.
  ADD CONSTRAINT doc_interop_message_status_chk CHECK (
    ((status = 'FAILED') = (next_attempt_at IS NOT NULL))
    AND (status NOT IN ('FAILED', 'DEAD') OR error_code IS NOT NULL)
    AND (status NOT IN ('SENT', 'ACKED', 'RECEIVED', 'PROCESSED') OR error_code IS NULL)
    AND (status <> 'FAILED' OR attempts BETWEEN 1 AND 19)
    AND (status <> 'DEAD' OR attempts = 20)
    AND (status <> 'REJECTED' OR error_code IS NOT NULL)
    AND (status NOT IN ('SENT', 'ACKED') OR (external_message_id IS NOT NULL AND attempts >= 1))
    AND ((status IN ('ACKED', 'REJECTED', 'PROCESSED')) = (processed_at IS NOT NULL))),
  ADD CONSTRAINT doc_interop_message_version_chk CHECK (version >= 1);

REVOKE DELETE, TRUNCATE ON TABLE machvon.doc_interop_message FROM machvon_app;

CREATE FUNCTION machvon.guard_doc_interop_message() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'interoperability messages are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.attempts <> 0 OR NOT ((NEW.direction = 'OUTBOUND' AND NEW.status = 'QUEUED') OR (NEW.direction = 'INBOUND' AND NEW.status = 'RECEIVED')) THEN
      RAISE EXCEPTION 'a message is written as queued (what leaves) or received (what arrives)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.direction, NEW.distribution_id, NEW.adapter_code, NEW.sender_code, NEW.receiver_code, NEW.envelope_sha256, NEW.envelope_object_key, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.direction, OLD.distribution_id, OLD.adapter_code, OLD.sender_code, OLD.receiver_code, OLD.envelope_sha256, OLD.envelope_object_key, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'the direction, the parties and the envelope of a message never change' USING ERRCODE = '23514';
  END IF;
  -- The id the LGSP gave a message, and the document an incoming message made, are written once.
  IF OLD.external_message_id IS NOT NULL AND NEW.external_message_id IS DISTINCT FROM OLD.external_message_id THEN
    RAISE EXCEPTION 'the id of a message is written once' USING ERRCODE = '23514';
  END IF;
  IF OLD.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'the document of a message is written once' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('ACKED', 'REJECTED', 'PROCESSED') THEN
    RAISE EXCEPTION 'a message that ended is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('OUTBOUND', 'QUEUED', 'SENT'), ('OUTBOUND', 'QUEUED', 'FAILED'), ('OUTBOUND', 'QUEUED', 'DEAD'), ('OUTBOUND', 'FAILED', 'QUEUED'), ('OUTBOUND', 'DEAD', 'QUEUED'),
                   ('OUTBOUND', 'SENT', 'ACKED'), ('OUTBOUND', 'SENT', 'REJECTED'), ('OUTBOUND', 'QUEUED', 'REJECTED'), ('OUTBOUND', 'FAILED', 'REJECTED'),
                   ('INBOUND', 'RECEIVED', 'PROCESSED'))
           AS allowed (direction, from_status, to_status)
     WHERE allowed.direction = OLD.direction AND allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'INTEROP_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts AND NOT (OLD.status = 'DEAD' AND NEW.status = 'QUEUED' AND NEW.attempts = 0) THEN
    RAISE EXCEPTION 'attempts are counted, never taken back (a dead message that is sent again starts over)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER doc_interop_message_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.doc_interop_message
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_doc_interop_message();
CREATE TRIGGER doc_interop_message_no_truncate BEFORE TRUNCATE ON machvon.doc_interop_message
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_doc_interop_message();

-- The message a letter came with is written when the letter is made and never changes.
CREATE FUNCTION machvon.guard_incoming_interop_link() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.interop_message_id IS NOT NULL AND NEW.interop_message_id IS DISTINCT FROM OLD.interop_message_id THEN
    RAISE EXCEPTION 'the message a letter came with does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER incoming_document_interop_link_guard BEFORE UPDATE ON machvon.incoming_document
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_incoming_interop_link();
