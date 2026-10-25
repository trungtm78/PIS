-- Authored by hand (not generated): the postings of CAP from the payment and Treasury events (ST-CAP-006, CAP 3.4, UAT-PLAN-01, UAT-PLAN-02).
-- A payment request commits capital when it is sent and does not hold a commitment of its own, takes it back when it is returned, and a payment the Treasury confirmed turns the commitment into
-- a disbursement dated by the day the Treasury paid; a reversal puts it back. A request that is returned and sent again commits again, so the key that keeps one posting for one business fact
-- gains the number of the posting of that fact (0 for the first and for every entry written before this); an entry is still never updated or deleted.

ALTER TABLE machvon.capital_ledger_entry
  ADD COLUMN source_ref_seq smallint NOT NULL DEFAULT 0;
ALTER TABLE machvon.capital_ledger_entry
  ADD CONSTRAINT capital_ledger_source_ref_seq_chk CHECK (source_ref_seq >= 0);

DROP INDEX machvon.capital_ledger_dedupe_uq;
CREATE UNIQUE INDEX capital_ledger_dedupe_uq
  ON machvon.capital_ledger_entry (tenant_id, source_ref_kind, source_ref_id, entry_type, allocation_line_id, source_ref_seq) NULLS NOT DISTINCT;

-- An entry that commits, uncommits or disburses capital for a payment is for a line of a project (the reconciliation of the balances reads it by both), and the reversal of such an entry is for
-- the line and the whole amount of the entry it undoes (the other reversals of the ledger keep their own rules).
ALTER TABLE machvon.capital_ledger_entry
  ADD CONSTRAINT capital_ledger_payment_line_chk
  CHECK (source_ref_kind NOT IN ('PAYMENT_REQUEST', 'TREASURY_TRANSACTION') OR (allocation_line_id IS NOT NULL AND project_id IS NOT NULL));

CREATE FUNCTION machvon.guard_capital_ledger_reversal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  undone machvon.capital_ledger_entry%ROWTYPE;
BEGIN
  IF NEW.reversal_of_id IS NULL OR NEW.source_ref_kind NOT IN ('PAYMENT_REQUEST', 'TREASURY_TRANSACTION') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO undone FROM machvon.capital_ledger_entry WHERE tenant_id = NEW.tenant_id AND id = NEW.reversal_of_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAPITAL_REVERSAL_INVALID: the entry a reversal undoes must exist' USING ERRCODE = '23514';
  END IF;
  IF undone.entry_type = 'REVERSAL' OR undone.amount_vnd <> NEW.amount_vnd OR undone.allocation_line_id IS DISTINCT FROM NEW.allocation_line_id THEN
    RAISE EXCEPTION 'CAPITAL_REVERSAL_INVALID: a reversal undoes one entry, once, for its line and its whole amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER capital_ledger_reversal_guard BEFORE INSERT ON machvon.capital_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_capital_ledger_reversal();

-- The postings of a payment are found by the request or the transaction they name, and the lines of a project by index.
CREATE INDEX capital_ledger_source_idx ON machvon.capital_ledger_entry (tenant_id, source_ref_kind, source_ref_id);
CREATE INDEX capital_ledger_line_idx ON machvon.capital_ledger_entry (tenant_id, allocation_line_id, entry_type);
