-- Authored by hand (not generated): the cumulative ledger of a contract (ST-PAY-001, PAY 3.1, BR-PAY-01).
-- The tables cumulative_ledger and cumulative_ledger_entry come from the generated schema (V002, with the row level security, the checks that keep requested <= accepted, paid <= requested and
-- recovered + held <= requested, the key of a balance and the single reversal of an entry). This adds what makes the ledger a ledger: an entry is never changed or deleted by anyone (not by the
-- runtime role, and not by a trigger that lets it through), an entry belongs to the balance it names and reverses exactly what it says it reverses, a balance is at every commit the sum of its
-- entries, and an acceptance is recognised once.

-- No command changes or deletes an entry, and none deletes a balance; the runtime role no longer can.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.cumulative_ledger_entry FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.cumulative_ledger FROM machvon_app;

-- The same holds for whoever else holds the right to write to the table: a posted entry is kept as it is.
CREATE FUNCTION machvon.guard_ledger_entry_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'LEDGER_ENTRY_IMMUTABLE: a posted entry is corrected by an entry that reverses it' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER cumulative_ledger_entry_append_only BEFORE UPDATE OR DELETE ON machvon.cumulative_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_ledger_entry_append_only();
CREATE TRIGGER cumulative_ledger_entry_no_truncate BEFORE TRUNCATE ON machvon.cumulative_ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_ledger_entry_append_only();

-- An entry says which item of which acceptance of which contract it is about, and that is what its balance is about. An entry that reverses another is the exact opposite of it, of the kind
-- that kind of reversal reverses, on the same balance.
CREATE FUNCTION machvon.guard_ledger_entry_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  ledger machvon.cumulative_ledger%ROWTYPE;
  reversed machvon.cumulative_ledger_entry%ROWTYPE;
  expected_kind text;
BEGIN
  SELECT * INTO ledger FROM machvon.cumulative_ledger WHERE tenant_id = NEW.tenant_id AND id = NEW.ledger_id;
  IF NOT FOUND OR (ledger.contract_id, ledger.boq_item_id, ledger.acceptance_id) IS DISTINCT FROM (NEW.contract_id, NEW.boq_item_id, NEW.acceptance_id) THEN
    RAISE EXCEPTION 'an entry belongs to the balance it names' USING ERRCODE = '23514';
  END IF;
  IF NEW.reversal_of_id IS NOT NULL THEN
    SELECT * INTO reversed FROM machvon.cumulative_ledger_entry WHERE tenant_id = NEW.tenant_id AND id = NEW.reversal_of_id;
    expected_kind := CASE NEW.entry_kind
      WHEN 'REVOKE_ACCEPTANCE' THEN 'RECOGNIZE_ACCEPTANCE'
      WHEN 'CLAIM_RELEASE' THEN 'CLAIM'
      WHEN 'PAYMENT_REVERSAL' THEN 'PAYMENT'
      WHEN 'ADVANCE_RECOVERY_REVERSAL' THEN 'ADVANCE_RECOVERY'
    END;
    IF NOT FOUND OR reversed.ledger_id <> NEW.ledger_id OR reversed.entry_kind IS DISTINCT FROM expected_kind
       OR (NEW.accepted_delta_vnd, NEW.requested_delta_vnd, NEW.paid_delta_vnd, NEW.advance_recovery_delta_vnd, NEW.retention_delta_vnd)
          IS DISTINCT FROM (-reversed.accepted_delta_vnd, -reversed.requested_delta_vnd, -reversed.paid_delta_vnd, -reversed.advance_recovery_delta_vnd, -reversed.retention_delta_vnd) THEN
      RAISE EXCEPTION 'an entry that reverses another is its exact opposite' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER cumulative_ledger_entry_guard BEFORE INSERT ON machvon.cumulative_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_ledger_entry_insert();

-- Who a balance is about never changes; only what it holds does, and only together with an entry.
CREATE FUNCTION machvon.guard_ledger_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.boq_item_id, NEW.acceptance_id, NEW.party_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.boq_item_id, OLD.acceptance_id, OLD.party_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a balance of the ledger is about never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER cumulative_ledger_identity BEFORE UPDATE ON machvon.cumulative_ledger
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_ledger_identity();

-- At every commit a balance is the sum of its entries: whoever changes one without the other is refused when the transaction ends, so the two can be written in either order inside it.
CREATE FUNCTION machvon.check_ledger_sum() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target uuid;
  balance machvon.cumulative_ledger%ROWTYPE;
  summed record;
BEGIN
  IF TG_TABLE_NAME = 'cumulative_ledger' THEN
    target := NEW.id;
  ELSE
    target := NEW.ledger_id;
  END IF;
  SELECT * INTO balance FROM machvon.cumulative_ledger WHERE tenant_id = NEW.tenant_id AND id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(accepted_delta_vnd), 0) AS accepted, COALESCE(sum(requested_delta_vnd), 0) AS requested, COALESCE(sum(paid_delta_vnd), 0) AS paid,
         COALESCE(sum(advance_recovery_delta_vnd), 0) AS recovered, COALESCE(sum(retention_delta_vnd), 0) AS held
    INTO summed
    FROM machvon.cumulative_ledger_entry
   WHERE tenant_id = NEW.tenant_id AND ledger_id = target;
  IF (balance.accepted_vnd, balance.requested_vnd, balance.paid_vnd, balance.advance_recovered_vnd, balance.retention_held_vnd)
     IS DISTINCT FROM (summed.accepted, summed.requested, summed.paid, summed.recovered, summed.held) THEN
    RAISE EXCEPTION 'LEDGER_SUM_MISMATCH: a balance is the sum of its entries' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER cumulative_ledger_sum AFTER INSERT OR UPDATE ON machvon.cumulative_ledger
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_ledger_sum();
CREATE CONSTRAINT TRIGGER cumulative_ledger_entry_sum AFTER INSERT ON machvon.cumulative_ledger_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_ledger_sum();

-- An acceptance is recognised once on each balance, however often the event that says so is delivered.
CREATE UNIQUE INDEX cumulative_ledger_entry_recognize_uq ON machvon.cumulative_ledger_entry (tenant_id, ledger_id) WHERE entry_kind = 'RECOGNIZE_ACCEPTANCE';

-- The balances of a contract are read in a stable order, and the entries of a balance in the order they were posted (the indexes of the identifiers are those of the generated schema).
CREATE INDEX cumulative_ledger_contract_order_idx ON machvon.cumulative_ledger (tenant_id, contract_id, created_at, id);
CREATE INDEX cumulative_ledger_entry_ledger_order_idx ON machvon.cumulative_ledger_entry (tenant_id, ledger_id, posted_at, id);
