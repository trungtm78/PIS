-- Authored by hand (not generated): the contract register (ST-CTR-001, CTR 3.1 steps 1 and 2, state machine of section 4).
-- The tables contract, contract_revision, contract_party and contract_status_change come from the generated schema (V002, with the extension
-- columns of CTR, the ceiling and the signed-value checks and the append-only grants of the history). This adds what the register relies on:
-- the version default, the text of the identity, a guard that keeps the identity of a contract for good, a guard that lets the status move
-- only along the transitions of the state machine, and the joint-venture rule held at commit from both sides (the members and the contract).

ALTER TABLE machvon.contract ALTER COLUMN version SET DEFAULT 1;

-- The code is the name the paper trail refers to: stored as typed after trimming, so a code that differs by a space cannot defeat the unique index.
ALTER TABLE machvon.contract
  ADD CONSTRAINT contract_identity_text_chk CHECK (code = btrim(code) AND code <> '' AND (title IS NULL OR (title = btrim(title) AND title <> '')));

-- A contract keeps its place: the project, the package it was awarded under, the contractor, the code, the kind and the currency never change.
-- A different contractor or package is a different contract, and a mistake is answered by cancelling the draft and writing another.
CREATE FUNCTION machvon.guard_contract_identity() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.project_id, NEW.package_id, NEW.contractor_id, NEW.code, NEW.type, NEW.currency)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.project_id, OLD.package_id, OLD.contractor_id, OLD.code, OLD.type, OLD.currency) THEN
    RAISE EXCEPTION 'a contract keeps its project, package, contractor, code, type and currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_identity_guard BEFORE UPDATE ON machvon.contract
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_identity();

-- The status moves along the state machine of CTR section 4 and nowhere else, whoever writes it (CONTRACT_STATE_INVALID): the commands check
-- the same table first and answer 409; this is the last word for a statement that bypasses them.
CREATE FUNCTION machvon.guard_contract_status() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('DRAFT', 'IN_REVIEW'), ('IN_REVIEW', 'DRAFT'), ('IN_REVIEW', 'SIGNED'), ('SIGNED', 'ACTIVE'),
        ('ACTIVE', 'SUSPENDED'), ('SUSPENDED', 'ACTIVE'),
        ('SIGNED', 'TERMINATED'), ('ACTIVE', 'TERMINATED'), ('SUSPENDED', 'TERMINATED'),
        ('ACTIVE', 'COMPLETED'), ('COMPLETED', 'CLOSED'), ('TERMINATED', 'CLOSED'),
        ('DRAFT', 'CANCELLED'), ('IN_REVIEW', 'CANCELLED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'CONTRACT_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_status_guard BEFORE UPDATE OF status ON machvon.contract
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_status();

-- BR-CTR-08: once a contract is past review, the active members of a joint venture hold exactly 100 percent, whichever way the rows change
-- (insert, update or delete of a member, or a status change of the contract), and the moment the contract leaves the draft states the work
-- the members take adds up to the value of the contract. The check runs at commit, so a replacement of all members in one transaction is judged
-- once, on the result. A contract that is not a joint venture and has no member rows is not judged.
CREATE OR REPLACE FUNCTION machvon.contract_party_share_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target_tenant uuid;
  target_contract uuid;
  held record;
  total_share numeric;
  total_work numeric;
  members integer;
  leaving_draft boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'contract' THEN
    target_tenant := NEW.tenant_id;
    target_contract := NEW.id;
    leaving_draft := OLD.status IN ('DRAFT', 'IN_REVIEW') AND NEW.status NOT IN ('DRAFT', 'IN_REVIEW', 'CANCELLED');
  ELSIF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_contract := OLD.contract_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_contract := NEW.contract_id;
  END IF;
  SELECT status, is_joint_venture, contract_value_vnd INTO held
    FROM machvon.contract WHERE tenant_id = target_tenant AND id = target_contract;
  IF NOT FOUND OR held.status IN ('DRAFT', 'IN_REVIEW', 'CANCELLED') THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(share_pct), 0), COALESCE(SUM(work_value_vnd), 0), COUNT(*) INTO total_share, total_work, members
    FROM machvon.contract_party WHERE tenant_id = target_tenant AND contract_id = target_contract AND status = 'ACTIVE';
  IF held.is_joint_venture OR members > 0 THEN
    IF total_share <> 100 THEN
      RAISE EXCEPTION 'JV_SHARE_NOT_100' USING ERRCODE = '23514';
    END IF;
    IF leaving_draft AND total_work <> held.contract_value_vnd THEN
      RAISE EXCEPTION 'BOQ_TOTAL_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER contract_party_share_tg ON machvon.contract_party;
CREATE CONSTRAINT TRIGGER contract_party_share_tg AFTER INSERT OR UPDATE OR DELETE ON machvon.contract_party
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.contract_party_share_guard();
CREATE CONSTRAINT TRIGGER contract_party_share_contract_tg AFTER UPDATE OF status ON machvon.contract
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.contract_party_share_guard();
