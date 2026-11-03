-- Authored by hand (not generated): the retroactive adjustment of a change order (ST-CTR-016, CTR 3.3 step 6, BR-CTR-03).
-- A change order whose price takes effect from a day before its approval does not rewrite the acceptances: their lines and amounts stay as they were approved (the guards of V1389 keep them), and the
-- money difference is a new entry of the cumulative ledger of PAY. The ledger had no entry for that: a forward entry could not carry a negative amount (a price that falls) and a reversal had to be
-- the exact opposite of an entry. This adds the entry kind ADJUSTMENT (a signed difference on the accepted amount of a balance and on nothing else, named after the line of the adjustment it comes from),
-- the record of the adjustment (the change order, the revision it made, the decision document and one line for each balance it moved), and the guards that keep the record and the ledger in step.

-- ---- the record of an adjustment ------------------------------------------------------------------------------------------------

CREATE TABLE machvon.retroactive_adjustment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  contract_id uuid NOT NULL,
  change_request_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  effective_on date NOT NULL,
  approved_on date NOT NULL,
  basis text NOT NULL,
  decision_document_version_id uuid NOT NULL,
  line_count integer NOT NULL,
  acceptance_count integer NOT NULL,
  total_delta_vnd numeric(24,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- The change reaches back: it applies from a day before the day it was approved, in words that fit a decision.
  CONSTRAINT retroactive_adjustment_day_chk CHECK (effective_on < approved_on),
  CONSTRAINT retroactive_adjustment_basis_chk CHECK (basis = btrim(basis) AND basis <> '' AND char_length(basis) <= 2000),
  -- No line, no acceptance and no difference go together; a line belongs to one acceptance at least.
  CONSTRAINT retroactive_adjustment_count_chk CHECK (line_count >= 0 AND acceptance_count >= 0 AND acceptance_count <= line_count AND (line_count = 0) = (acceptance_count = 0) AND (line_count > 0 OR total_delta_vnd = 0))
);
ALTER TABLE machvon.retroactive_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.retroactive_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON machvon.retroactive_adjustment AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_boundary ON machvon.retroactive_adjustment AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE machvon.retroactive_adjustment
  ADD FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.change_request (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, revision_id) REFERENCES machvon.contract_revision (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, decision_document_version_id) REFERENCES machvon.document_version (tenant_id, id);
-- A change order is adjusted once and makes one revision: a mistake in an adjustment is put right by a later one, not by a second record of the same change.
CREATE UNIQUE INDEX retroactive_adjustment_change_request_uq ON machvon.retroactive_adjustment (tenant_id, change_request_id);
CREATE UNIQUE INDEX retroactive_adjustment_revision_uq ON machvon.retroactive_adjustment (tenant_id, revision_id);
CREATE INDEX retroactive_adjustment_contract_id_idx ON machvon.retroactive_adjustment (tenant_id, contract_id, created_at, id);
CREATE INDEX retroactive_adjustment_change_request_id_idx ON machvon.retroactive_adjustment (tenant_id, change_request_id);
CREATE INDEX retroactive_adjustment_revision_id_idx ON machvon.retroactive_adjustment (tenant_id, revision_id);
CREATE INDEX retroactive_adjustment_decision_document_version_id_idx ON machvon.retroactive_adjustment (tenant_id, decision_document_version_id);

CREATE TABLE machvon.retroactive_adjustment_line (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  adjustment_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  acceptance_id uuid NOT NULL,
  boq_item_id uuid NOT NULL,
  party_id uuid,
  quantity numeric(24,6) NOT NULL,
  old_amount_vnd numeric(24,0) NOT NULL,
  new_unit_price numeric(24,6) NOT NULL,
  new_amount_vnd numeric(24,0) NOT NULL,
  delta_vnd numeric(24,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT retroactive_adjustment_line_amount_chk CHECK (quantity > 0 AND old_amount_vnd >= 0 AND new_unit_price >= 0 AND new_amount_vnd >= 0),
  -- The difference is the new amount less the old one, and it is never nothing: a balance that does not change has no line.
  CONSTRAINT retroactive_adjustment_line_delta_chk CHECK (delta_vnd <> 0 AND delta_vnd = new_amount_vnd - old_amount_vnd)
);
ALTER TABLE machvon.retroactive_adjustment_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.retroactive_adjustment_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON machvon.retroactive_adjustment_line AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_boundary ON machvon.retroactive_adjustment_line AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE machvon.retroactive_adjustment_line
  ADD FOREIGN KEY (tenant_id, adjustment_id) REFERENCES machvon.retroactive_adjustment (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, acceptance_id) REFERENCES machvon.acceptance (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, boq_item_id) REFERENCES machvon.boq_item (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, party_id) REFERENCES machvon.contract_party (tenant_id, id);
-- One line for each balance of the ledger (an item of an acceptance, and the member of a joint venture) in an adjustment.
CREATE UNIQUE INDEX retroactive_adjustment_line_balance_uq ON machvon.retroactive_adjustment_line (tenant_id, adjustment_id, acceptance_id, boq_item_id, party_id) NULLS NOT DISTINCT;
CREATE INDEX retroactive_adjustment_line_adjustment_id_idx ON machvon.retroactive_adjustment_line (tenant_id, adjustment_id);
CREATE INDEX retroactive_adjustment_line_contract_id_idx ON machvon.retroactive_adjustment_line (tenant_id, contract_id);
CREATE INDEX retroactive_adjustment_line_acceptance_id_idx ON machvon.retroactive_adjustment_line (tenant_id, acceptance_id);
CREATE INDEX retroactive_adjustment_line_boq_item_id_idx ON machvon.retroactive_adjustment_line (tenant_id, boq_item_id);
CREATE INDEX retroactive_adjustment_line_party_id_idx ON machvon.retroactive_adjustment_line (tenant_id, party_id);

-- A record is kept as it was written: nobody changes or deletes it, not the runtime role and not a trigger that lets it through.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.retroactive_adjustment FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.retroactive_adjustment_line FROM machvon_app;

CREATE FUNCTION machvon.guard_retroactive_adjustment_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'RETROACTIVE_ADJUSTMENT_IMMUTABLE: an adjustment is put right by a later adjustment' USING ERRCODE = '23514';
END;
$fn$;
CREATE TRIGGER retroactive_adjustment_append_only BEFORE UPDATE OR DELETE ON machvon.retroactive_adjustment
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_retroactive_adjustment_append_only();
CREATE TRIGGER retroactive_adjustment_no_truncate BEFORE TRUNCATE ON machvon.retroactive_adjustment
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_retroactive_adjustment_append_only();
CREATE TRIGGER retroactive_adjustment_line_append_only BEFORE UPDATE OR DELETE ON machvon.retroactive_adjustment_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_retroactive_adjustment_append_only();
CREATE TRIGGER retroactive_adjustment_line_no_truncate BEFORE TRUNCATE ON machvon.retroactive_adjustment_line
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_retroactive_adjustment_append_only();

-- A line is about the contract of its adjustment, an acceptance of that contract that is approved, and an item of that contract (and a member of it).
CREATE FUNCTION machvon.guard_retroactive_adjustment_line() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM machvon.retroactive_adjustment a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.adjustment_id AND a.contract_id = NEW.contract_id) THEN
    RAISE EXCEPTION 'a line of an adjustment is about the contract of the adjustment' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM machvon.acceptance a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.acceptance_id AND a.contract_id = NEW.contract_id AND a.status = 'APPROVED')
     OR NOT EXISTS (SELECT 1 FROM machvon.boq_item i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.boq_item_id AND i.contract_id = NEW.contract_id)
     OR (NEW.party_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM machvon.contract_party p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.party_id AND p.contract_id = NEW.contract_id)) THEN
    RAISE EXCEPTION 'a line of an adjustment is about an approved acceptance, an item and a member of the contract' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER retroactive_adjustment_line_guard BEFORE INSERT ON machvon.retroactive_adjustment_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_retroactive_adjustment_line();

-- At every commit the header of an adjustment says what its lines are, and each line has the one entry of the ledger that moved its balance by its difference: whoever writes one without the other
-- is refused when the transaction ends.
CREATE FUNCTION machvon.check_retroactive_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target uuid;
  head machvon.retroactive_adjustment%ROWTYPE;
  summed record;
BEGIN
  IF TG_TABLE_NAME = 'retroactive_adjustment' THEN
    target := NEW.id;
  ELSE
    target := NEW.adjustment_id;
  END IF;
  SELECT * INTO head FROM machvon.retroactive_adjustment WHERE tenant_id = NEW.tenant_id AND id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS lines, count(DISTINCT acceptance_id) AS acceptances, COALESCE(sum(delta_vnd), 0) AS total
    INTO summed
    FROM machvon.retroactive_adjustment_line WHERE tenant_id = NEW.tenant_id AND adjustment_id = target;
  IF (head.line_count, head.acceptance_count, head.total_delta_vnd) IS DISTINCT FROM (summed.lines, summed.acceptances, summed.total) THEN
    RAISE EXCEPTION 'ADJUSTMENT_SUM_MISMATCH: the header of an adjustment is the sum of its lines' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM machvon.retroactive_adjustment_line l
     WHERE l.tenant_id = NEW.tenant_id AND l.adjustment_id = target
       AND (SELECT count(*) FROM machvon.cumulative_ledger_entry e WHERE e.tenant_id = l.tenant_id AND e.adjustment_line_id = l.id) <> 1
  ) THEN
    RAISE EXCEPTION 'ADJUSTMENT_LEDGER_MISMATCH: each line of an adjustment has one entry of the ledger' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE CONSTRAINT TRIGGER retroactive_adjustment_sum AFTER INSERT ON machvon.retroactive_adjustment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_retroactive_adjustment();
CREATE CONSTRAINT TRIGGER retroactive_adjustment_line_sum AFTER INSERT ON machvon.retroactive_adjustment_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_retroactive_adjustment();

-- ---- the ledger takes an adjustment ---------------------------------------------------------------------------------------------

ALTER TABLE machvon.cumulative_ledger_entry DROP CONSTRAINT cumulative_ledger_entry_entry_kind_check;
ALTER TABLE machvon.cumulative_ledger_entry
  ADD CONSTRAINT cumulative_ledger_entry_entry_kind_check CHECK (entry_kind IN ('RECOGNIZE_ACCEPTANCE','REVOKE_ACCEPTANCE','CLAIM','CLAIM_RELEASE','PAYMENT','PAYMENT_REVERSAL','ADVANCE_RECOVERY','ADVANCE_RECOVERY_REVERSAL','RETENTION_HOLD','RETENTION_RELEASE','ADJUSTMENT'));

-- An adjustment may take away or add: it is the one forward entry that carries a negative amount, and only on the accepted amount.
ALTER TABLE machvon.cumulative_ledger_entry DROP CONSTRAINT cumulative_ledger_entry_forward_sign_chk;
ALTER TABLE machvon.cumulative_ledger_entry
  ADD CONSTRAINT cumulative_ledger_entry_forward_sign_chk CHECK (
    entry_kind IN ('REVOKE_ACCEPTANCE','CLAIM_RELEASE','PAYMENT_REVERSAL','ADVANCE_RECOVERY_REVERSAL','RETENTION_RELEASE','ADJUSTMENT')
    OR (accepted_delta_vnd >= 0 AND requested_delta_vnd >= 0 AND paid_delta_vnd >= 0 AND advance_recovery_delta_vnd >= 0 AND retention_delta_vnd >= 0)
  );

ALTER TABLE machvon.cumulative_ledger_entry ADD COLUMN adjustment_line_id uuid;
ALTER TABLE machvon.cumulative_ledger_entry
  ADD FOREIGN KEY (tenant_id, adjustment_line_id) REFERENCES machvon.retroactive_adjustment_line (tenant_id, id),
  ADD CONSTRAINT cumulative_ledger_entry_adjustment_chk CHECK (
    (entry_kind = 'ADJUSTMENT') = (adjustment_line_id IS NOT NULL)
    AND (entry_kind <> 'ADJUSTMENT' OR (accepted_delta_vnd <> 0 AND requested_delta_vnd = 0 AND paid_delta_vnd = 0 AND advance_recovery_delta_vnd = 0 AND retention_delta_vnd = 0))
  );
CREATE INDEX cumulative_ledger_entry_adjustment_line_id_idx ON machvon.cumulative_ledger_entry (tenant_id, adjustment_line_id);
-- One line, one entry.
CREATE UNIQUE INDEX cumulative_ledger_entry_adjustment_line_uq ON machvon.cumulative_ledger_entry (tenant_id, adjustment_line_id) WHERE adjustment_line_id IS NOT NULL;

-- An entry of adjustment sits on the balance its line is about and moves it by the difference of the line.
CREATE FUNCTION machvon.guard_adjustment_entry() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM machvon.retroactive_adjustment_line l
      JOIN machvon.cumulative_ledger b ON b.tenant_id = l.tenant_id AND b.id = NEW.ledger_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.adjustment_line_id
       AND l.contract_id = b.contract_id AND l.acceptance_id = b.acceptance_id AND l.boq_item_id = b.boq_item_id AND l.party_id IS NOT DISTINCT FROM b.party_id
       AND l.delta_vnd = NEW.accepted_delta_vnd
  ) THEN
    RAISE EXCEPTION 'an entry of adjustment moves the balance its line is about by the difference of the line' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER cumulative_ledger_entry_adjustment_guard BEFORE INSERT ON machvon.cumulative_ledger_entry
  FOR EACH ROW WHEN (NEW.entry_kind = 'ADJUSTMENT') EXECUTE FUNCTION machvon.guard_adjustment_entry();

-- ---- an acceptance that was adjusted is not withdrawn -------------------------------------------------------------------------------------

-- Withdrawing an acceptance takes back the entry that recognised it, and the accepted total of the contract by the amount it was approved for; an adjustment on its balance would stay behind. The
-- adjustment is put right by a later adjustment first.
CREATE FUNCTION machvon.guard_acceptance_adjusted() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.status = 'REVOKED' AND OLD.status IS DISTINCT FROM 'REVOKED'
     AND EXISTS (SELECT 1 FROM machvon.retroactive_adjustment_line l WHERE l.tenant_id = NEW.tenant_id AND l.acceptance_id = NEW.id) THEN
    RAISE EXCEPTION 'ACCEPTANCE_ADJUSTED: an acceptance with a retroactive adjustment is not withdrawn' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER acceptance_adjusted_guard BEFORE UPDATE ON machvon.acceptance
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_acceptance_adjusted();
