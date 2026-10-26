-- ST-AUD-003: the assignment, the remediation, the dispute and the separated verification of the recommendations of a conclusion (AUD 3.3, 3.5, 4, BR-AUD-06, BR-AUD-08, BR-AUD-09).
--
-- 1. A recommendation keeps who raised the dispute (the explanation that sends an accepted dispute to the verifier counts as the report of the owner, so the separation of duties has a person to
--    compare) and the words of the last verification (a return says what is left to do).
-- 2. The edges of the status of a recommendation are held at the table as in the state machine of the module: nothing else moves it, whoever writes.
-- 3. The money of a recommendation is frozen once it is assigned (a change of amount needs an amended conclusion, ST-AUD-007), and the verifier is neither the owner nor the one who reported it.
-- 4. A dispute has its words and its document together; a recommendation waiting for verification has someone who reported it.

ALTER TABLE machvon.audit_recommendation
  ADD COLUMN disputed_by uuid,
  ADD COLUMN verification_note text;

ALTER TABLE machvon.audit_recommendation
  ADD CONSTRAINT audit_recommendation_dispute_pair_chk CHECK ((dispute_reason IS NULL) = (dispute_document_id IS NULL)),
  ADD CONSTRAINT audit_recommendation_pending_chk CHECK (status <> 'PENDING_VERIFICATION' OR submitted_by IS NOT NULL OR disputed_by IS NOT NULL),
  ADD CONSTRAINT audit_recommendation_verifier_chk CHECK (status <> 'CLOSED' OR (verified_by IS DISTINCT FROM disputed_by AND verified_by IS DISTINCT FROM owner_user_id)),
  ADD CONSTRAINT audit_recommendation_note_chk CHECK (verification_note IS NULL OR length(trim(verification_note)) >= 1);

ALTER TABLE machvon.audit_remediation_action
  ADD CONSTRAINT audit_remediation_action_code_chk CHECK (length(trim(action_code)) >= 1),
  ADD CONSTRAINT audit_remediation_action_cancel_chk CHECK (status <> 'CANCELLED' OR completed_on IS NULL);

CREATE FUNCTION machvon.audit_recommendation_edges_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.status = OLD.status AND NEW.status <> 'ASSIGNED' THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) IN (
    ('OPEN', 'ASSIGNED'), ('OPEN', 'CANCELLED'),
    ('ASSIGNED', 'ASSIGNED'), ('ASSIGNED', 'IN_PROGRESS'), ('ASSIGNED', 'DISPUTED'), ('ASSIGNED', 'CANCELLED'),
    ('IN_PROGRESS', 'PENDING_VERIFICATION'), ('IN_PROGRESS', 'DISPUTED'),
    ('PENDING_VERIFICATION', 'CLOSED'), ('PENDING_VERIFICATION', 'IN_PROGRESS'),
    ('DISPUTED', 'IN_PROGRESS'), ('DISPUTED', 'PENDING_VERIFICATION'),
    ('CLOSED', 'IN_PROGRESS')
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a recommendation does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'audit_recommendation_edges_guard';
END
$fn$;

CREATE TRIGGER audit_recommendation_edges_guard
  BEFORE UPDATE OF status ON machvon.audit_recommendation
  FOR EACH ROW EXECUTE FUNCTION machvon.audit_recommendation_edges_guard();

CREATE FUNCTION machvon.audit_recommendation_frozen_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status <> 'OPEN' AND (NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd OR NEW.rec_type <> OLD.rec_type OR NEW.conclusion_id <> OLD.conclusion_id) THEN
    RAISE EXCEPTION 'the amount and the type of a recommendation do not change once it is assigned' USING ERRCODE = '23514', CONSTRAINT = 'audit_recommendation_frozen_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_recommendation_frozen_guard
  BEFORE UPDATE OF amount_vnd, rec_type, conclusion_id ON machvon.audit_recommendation
  FOR EACH ROW EXECUTE FUNCTION machvon.audit_recommendation_frozen_guard();
