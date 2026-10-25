-- Authored by hand (not generated): the advance of a contract, its request, its cancellation and its recovery outside the payments (ST-PAY-004, PAY 3.2, BR-PAY-04, BR-PAY-10, BR-PAY-11).
-- The advance and its journal are in V002 with the checks on the amounts. This adds what keeps the advance honest when the application is bypassed: a planned advance is asked for on a contract that is in
-- force and, for a contract advance, under a guarantee that covers it; the status moves along the edges of PAY 4 and agrees with the amounts; what an advance is about is never changed; an advance is
-- never deleted; and a recovery that is not made by a payment says what it is made of and keeps its evidence.

ALTER TABLE machvon.advance_ledger_entry
  ADD COLUMN basis text,
  ADD COLUMN source_ref_id uuid,
  ADD COLUMN evidence_document_version_id uuid;

ALTER TABLE machvon.advance_ledger_entry
  ADD CONSTRAINT advance_ledger_entry_basis_chk CHECK (basis IS NULL OR basis IN ('COMPENSATION_PAYMENT', 'REFUND', 'OTHER')),
  ADD CONSTRAINT advance_ledger_entry_outside_chk CHECK (entry_kind <> 'RECOVER' OR payment_request_id IS NOT NULL OR (basis IS NOT NULL AND evidence_document_version_id IS NOT NULL)),
  ADD CONSTRAINT advance_ledger_entry_evidence_fk FOREIGN KEY (tenant_id, evidence_document_version_id) REFERENCES machvon.document_version (tenant_id, id);

CREATE INDEX advance_ledger_entry_evidence_idx ON machvon.advance_ledger_entry (tenant_id, evidence_document_version_id);
CREATE INDEX advance_ledger_entry_source_ref_id_idx ON machvon.advance_ledger_entry (tenant_id, source_ref_id);

-- The status says where the money is, and the amounts agree with it.
ALTER TABLE machvon.contract_advance
  ADD CONSTRAINT contract_advance_status_amounts_chk CHECK (
    CASE status
      WHEN 'FULLY_RECOVERED' THEN paid_vnd > 0 AND recovered_vnd = paid_vnd
      WHEN 'RECOVERING' THEN recovered_vnd > 0 AND recovered_vnd < paid_vnd
      WHEN 'PAID' THEN paid_vnd > 0 AND recovered_vnd = 0
      ELSE paid_vnd = 0 AND recovered_vnd = 0
    END
  );

REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_advance FROM machvon_app;

CREATE FUNCTION machvon.guard_contract_advance() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  covering machvon.guarantee%ROWTYPE;
  facts RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM machvon.contract_party p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.party_id AND p.contract_id = NEW.contract_id AND p.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'an advance is paid to an active member of its contract' USING ERRCODE = '23514';
    END IF;
    -- A planned advance is a request: it is made on a contract in force, from a rule that was read, and a contract advance is covered by a guarantee that is valid today.
    IF NEW.status = 'PLANNED' THEN
      SELECT c.status, c.effective_from INTO facts FROM machvon.contract c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contract_id;
      IF facts.status IS DISTINCT FROM 'ACTIVE' OR facts.effective_from IS NULL OR facts.effective_from > (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
        RAISE EXCEPTION 'ADVANCE_CONTRACT_NOT_EFFECTIVE: an advance is asked for on a contract that is in force' USING ERRCODE = '23514';
      END IF;
      IF NEW.cap_rule_version_id IS NULL THEN
        RAISE EXCEPTION 'an advance keeps the version of the rule that capped it' USING ERRCODE = '23514';
      END IF;
      IF NEW.kind = 'CONTRACT' THEN
        SELECT g.* INTO covering FROM machvon.guarantee g WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.guarantee_id;
        IF NOT FOUND OR covering.contract_id <> NEW.contract_id OR covering.kind <> 'ADVANCE' OR covering.status <> 'ACTIVE' OR covering.verification_status <> 'VERIFIED'
           OR covering.expires_at <= now() OR covering.amount_vnd < NEW.amount_vnd OR (covering.party_id IS NOT NULL AND covering.party_id <> NEW.party_id) THEN
          RAISE EXCEPTION 'ADVANCE_GUARANTEE_REQUIRED: an advance of a contract is covered by an active, verified guarantee that is valid and large enough' USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.party_id, NEW.tranche_no, NEW.kind, NEW.amount_vnd, NEW.cap_vnd, NEW.cap_rule_version_id, NEW.guarantee_id, NEW.allocation_line_id, NEW.recovery_threshold_pct, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.party_id, OLD.tranche_no, OLD.kind, OLD.amount_vnd, OLD.cap_vnd, OLD.cap_rule_version_id, OLD.guarantee_id, OLD.allocation_line_id, OLD.recovery_threshold_pct, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what an advance is about never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('PLANNED', 'REQUESTED'), ('PLANNED', 'CANCELLED'), ('REQUESTED', 'PLANNED'), ('REQUESTED', 'PAID'), ('REQUESTED', 'CANCELLED'),
                   ('PAID', 'RECOVERING'), ('PAID', 'FULLY_RECOVERED'), ('RECOVERING', 'PAID'), ('RECOVERING', 'FULLY_RECOVERED'), ('FULLY_RECOVERED', 'RECOVERING'), ('FULLY_RECOVERED', 'PAID')) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'ADVANCE_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  -- The money paid is fixed at the moment it is paid.
  IF NEW.paid_vnd IS DISTINCT FROM OLD.paid_vnd AND NOT (OLD.status = 'REQUESTED' AND NEW.status = 'PAID' AND OLD.paid_vnd = 0) THEN
    RAISE EXCEPTION 'ADVANCE_STATE_INVALID: the amount paid is set once, when the advance is paid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_advance_guard BEFORE INSERT OR UPDATE ON machvon.contract_advance
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_advance();
