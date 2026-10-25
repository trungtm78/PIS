-- Authored by hand (not generated): the review, the signing and the activation of a contract (ST-CTR-004, CTR 3.1 steps 3 to 5, state machine of section 4).
-- The columns of the contract register (V1380) are joined by who sent the contract to review, who signed it and on which document, the decision that dealt with a conflict of
-- interest at the signing, and who activated it; the signature and the activation are written once and kept; and the history of the status can only grow.

ALTER TABLE machvon.contract
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN signed_by uuid,
  ADD COLUMN signed_document_version_id uuid,
  ADD COLUMN conflict_decision_ref text,
  ADD COLUMN activated_by uuid;

ALTER TABLE machvon.contract ADD FOREIGN KEY (tenant_id, signed_document_version_id) REFERENCES machvon.document_version (tenant_id, id);
CREATE INDEX contract_signed_document_version_id_idx ON machvon.contract (tenant_id, signed_document_version_id);

-- Whoever signs is not whoever drafted the contract (BR-CTR-15), and a decision about a conflict is words, not an empty text.
ALTER TABLE machvon.contract
  ADD CONSTRAINT contract_signer_chk CHECK (signed_by IS NULL OR created_by IS NULL OR signed_by <> created_by),
  ADD CONSTRAINT contract_activator_chk CHECK (activated_by IS NULL OR created_by IS NULL OR activated_by <> created_by),
  ADD CONSTRAINT contract_conflict_decision_chk CHECK (conflict_decision_ref IS NULL OR (conflict_decision_ref = btrim(conflict_decision_ref) AND conflict_decision_ref <> '' AND char_length(conflict_decision_ref) <= 2000));

-- The signature and the activation of a contract are written once, by the commands that move the status (they take the signer, the document and the date with the move), and
-- kept: a signature that moved would make the paper trail say something the signer did not sign.
CREATE FUNCTION machvon.guard_contract_signature() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.signed_by IS NOT NULL AND (NEW.signed_by, NEW.signed_document_version_id, NEW.signed_on, NEW.conflict_decision_ref) IS DISTINCT FROM (OLD.signed_by, OLD.signed_document_version_id, OLD.signed_on, OLD.conflict_decision_ref) THEN
    RAISE EXCEPTION 'the signature of a contract does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.activated_by IS NOT NULL AND (NEW.activated_by, NEW.effective_from) IS DISTINCT FROM (OLD.activated_by, OLD.effective_from) THEN
    RAISE EXCEPTION 'the activation of a contract does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_signature_guard BEFORE UPDATE ON machvon.contract
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_signature();

-- The history of the status is a record: a change is added and never rewritten or removed, by the runtime role least of all.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_status_change FROM machvon_app;
