-- Authored by hand (not generated): the clarification requests to contractors during the evaluation of bids (ST-BID-011, BID 3 F6, BR-BID-03). The table bid_clarification comes from the generated schema (V002, with the
-- foreign keys to the package, the proposal, the finding it rests on and the two documents, and an index on each of them). This adds what makes it the record of a question and its answer: who answered, the shape of
-- a request that was sent and of one that was answered, one document for each letter and for each answer, the edges of the status, and the guard that keeps what was asked as it was asked. A request is written as
-- SENT (the contractor reads it from that moment); EXPIRED is what a reader sees of a request nobody answered by its deadline, so nothing is written when the deadline passes.

ALTER TABLE machvon.bid_clarification
  ADD COLUMN answered_by uuid,
  ADD COLUMN answered_as_guest boolean;

-- The question fits a letter and the deadline lies after the moment it was asked.
ALTER TABLE machvon.bid_clarification
  ADD CONSTRAINT bid_clarification_question_chk CHECK (char_length(btrim(question)) BETWEEN 10 AND 4000),
  ADD CONSTRAINT bid_clarification_due_chk CHECK (due_at > created_at);

-- A request that left the draft has the letter that asked; a request that was answered says who answered, as a guest of the contractor or as the staff who took the letter, on a document other than the letter,
-- and in time; a request that was not answered has none of it.
ALTER TABLE machvon.bid_clarification
  ADD CONSTRAINT bid_clarification_sent_chk CHECK (status = 'DRAFT' OR sent_document_id IS NOT NULL),
  ADD CONSTRAINT bid_clarification_answered_chk CHECK (
    CASE WHEN status = 'ANSWERED' THEN answered_by IS NOT NULL AND answered_as_guest IS NOT NULL AND answer_document_id IS NOT NULL AND answered_at IS NOT NULL
                                       AND answered_at <= due_at AND answer_document_id <> sent_document_id
         ELSE answer_document_id IS NULL AND answered_at IS NULL AND answered_by IS NULL AND answered_as_guest IS NULL END
  );

-- One letter asks one question and one document answers one request.
CREATE UNIQUE INDEX bid_clarification_sent_document_uq ON machvon.bid_clarification (tenant_id, sent_document_id) WHERE sent_document_id IS NOT NULL;
CREATE UNIQUE INDEX bid_clarification_answer_document_uq ON machvon.bid_clarification (tenant_id, answer_document_id) WHERE answer_document_id IS NOT NULL;

-- The requests of a package, newest first.
CREATE INDEX bid_clarification_package_created_idx ON machvon.bid_clarification (tenant_id, package_id, created_at DESC, id DESC);

-- What was asked never changes: the package, the proposal, the words, the finding they rest on, the deadline and the letter stay as they were written, and a request is never deleted. Only its status moves:
-- a request that waits is answered (or expires, or is withdrawn) and then is kept as it is. A request is written as SENT with the letter that carries it, a confidential document about it. The answer is a
-- document that is not the letter of any request. The owner of the schema (the migrations and the maintenance of the platform) is not held.
CREATE FUNCTION machvon.guard_bid_clarification() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'a clarification request is kept as it was asked' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'SENT' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'a clarification request is written as sent' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM machvon.document d
       WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.sent_document_id AND d.classification = 'CONFIDENTIAL'
         AND d.subject_module = 'BID_CLARIFICATION' AND d.subject_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'the letter of a clarification request is a confidential document about it' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.package_id, NEW.proposal_id, NEW.question, NEW.basis_finding_id, NEW.due_at, NEW.sent_document_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.package_id, OLD.proposal_id, OLD.question, OLD.basis_finding_id, OLD.due_at, OLD.sent_document_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a clarification request asks never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'SENT' THEN
    RAISE EXCEPTION 'a clarification request that was answered, expired or withdrawn is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status NOT IN ('SENT', 'ANSWERED', 'EXPIRED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'CLARIFICATION_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'ANSWERED' AND EXISTS (
    SELECT 1 FROM machvon.bid_clarification c WHERE c.tenant_id = NEW.tenant_id AND c.sent_document_id = NEW.answer_document_id
  ) THEN
    RAISE EXCEPTION 'the answer is not the letter of a request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER bid_clarification_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.bid_clarification
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_bid_clarification();
CREATE TRIGGER bid_clarification_no_truncate BEFORE TRUNCATE ON machvon.bid_clarification
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_bid_clarification();

REVOKE DELETE, TRUNCATE ON TABLE machvon.bid_clarification FROM machvon_app;
