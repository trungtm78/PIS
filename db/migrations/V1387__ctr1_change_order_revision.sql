-- Authored by hand (not generated): the decision of a change order and the revisions it makes of a contract (ST-CTR-007, CTR 3.3 steps 4 and 5, BR-CTR-03, BR-CTR-06).
-- The columns that link a revision to the change order that made it (contract_revision.change_request_id and supersedes_id, change_request.resulting_revision_id) come from the generated
-- schema (V002) without their foreign keys. This adds the keys, the checks that make a decided change order and a pending revision mean what they say, the guard that keeps the history of
-- revisions as it was written, and lets the BOQ of a change order be put right while the revision waits for its day.

-- ---- the links ---------------------------------------------------------------------------------------------------------------------

ALTER TABLE machvon.contract_revision ADD FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.change_request (tenant_id, id);
ALTER TABLE machvon.contract_revision ADD FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.contract_revision (tenant_id, id);
ALTER TABLE machvon.change_request ADD FOREIGN KEY (tenant_id, resulting_revision_id) REFERENCES machvon.contract_revision (tenant_id, id);

-- A change order makes one revision, and a revision comes from one change order: the kind says so both ways.
ALTER TABLE machvon.contract_revision
  ADD CONSTRAINT contract_revision_change_order_chk CHECK ((kind = 'CHANGE_ORDER') = (change_request_id IS NOT NULL)),
  ADD CONSTRAINT contract_revision_supersedes_chk CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  ADD CONSTRAINT contract_revision_retroactive_chk CHECK (NOT retroactive OR kind = 'CHANGE_ORDER');
CREATE UNIQUE INDEX contract_revision_change_request_uq ON machvon.contract_revision (tenant_id, change_request_id) WHERE change_request_id IS NOT NULL;
-- The job that puts the revisions in force looks for the pending ones that are due.
CREATE INDEX contract_revision_pending_idx ON machvon.contract_revision (tenant_id, valid_from) WHERE status = 'PENDING_EFFECTIVE';

-- A change order that was decided says who decided it, when and why; one that was approved says which revision it made; no other one has a revision.
ALTER TABLE machvon.change_request
  ADD CONSTRAINT change_request_decided_chk CHECK (
    status NOT IN ('APPROVED', 'REJECTED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND status_reason IS NOT NULL)
  ),
  ADD CONSTRAINT change_request_resulting_revision_chk CHECK ((status = 'APPROVED') = (resulting_revision_id IS NOT NULL));

-- A change order that was approved is over like one that was promoted, rejected or withdrawn: the database keeps it as it is.
CREATE OR REPLACE FUNCTION machvon.guard_change_request() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent machvon.change_request%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT * INTO parent FROM machvon.change_request WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
      IF NOT FOUND OR parent.contract_id <> NEW.contract_id THEN
        RAISE EXCEPTION 'a change request stands under a request of the same contract' USING ERRCODE = '23514';
      END IF;
      IF (parent.stage, NEW.stage) NOT IN (('EVENT', 'PCO'), ('PCO', 'CO')) THEN
        RAISE EXCEPTION 'CHANGE_STAGE_NOT_ALLOWED' USING ERRCODE = '23514';
      END IF;
      IF parent.status <> 'PROMOTED' THEN
        RAISE EXCEPTION 'a change request is promoted from a request that was promoted' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.stage, NEW.parent_id, NEW.code, NEW.baseline_revision_id, NEW.event_kind, NEW.estimated_delta_vnd, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.stage, OLD.parent_id, OLD.code, OLD.baseline_revision_id, OLD.event_kind, OLD.estimated_delta_vnd, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a change request keeps its place in the chain' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('PROMOTED', 'APPROVED', 'REJECTED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'a change request that is over is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('DRAFT', 'SUBMITTED'), ('DRAFT', 'WITHDRAWN'),
        ('SUBMITTED', 'EVALUATED'), ('SUBMITTED', 'PROMOTED'), ('SUBMITTED', 'WITHDRAWN'),
        ('EVALUATED', 'SUBMITTED'), ('EVALUATED', 'PROMOTED'), ('EVALUATED', 'WITHDRAWN'), ('EVALUATED', 'APPROVED'), ('EVALUATED', 'REJECTED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- ---- the history of revisions -------------------------------------------------------------------------------------------------------

-- A revision keeps its place in the history of the contract, moves along DRAFT, PENDING_EFFECTIVE, EFFECTIVE and SUPERSEDED (or is REJECTED while it is a draft) and nowhere else, and
-- once it is decided its terms (value, first day, document) never change: what was priced under a revision stays priced under it. The last day of a revision (valid_until, which is the
-- first day of the next one) is written once, when it is superseded.
CREATE FUNCTION machvon.guard_contract_revision() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.contract_id, NEW.revision, NEW.kind, NEW.change_request_id, NEW.supersedes_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.contract_id, OLD.revision, OLD.kind, OLD.change_request_id, OLD.supersedes_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a revision keeps its place in the history of the contract' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('DRAFT', 'PENDING_EFFECTIVE'), ('DRAFT', 'EFFECTIVE'), ('DRAFT', 'REJECTED'),
        ('PENDING_EFFECTIVE', 'EFFECTIVE'),
        ('EFFECTIVE', 'SUPERSEDED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'REVISION_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF (NEW.amount_vnd, NEW.valid_from, NEW.document_version_id, NEW.retroactive, NEW.decided_by, NEW.decided_at)
       IS DISTINCT FROM
       (OLD.amount_vnd, OLD.valid_from, OLD.document_version_id, OLD.retroactive, OLD.decided_by, OLD.decided_at) THEN
      RAISE EXCEPTION 'a revision that was decided keeps its terms' USING ERRCODE = '23514';
    END IF;
    IF NEW.valid_until IS DISTINCT FROM OLD.valid_until AND NOT (NEW.status = 'SUPERSEDED' AND OLD.valid_until IS NULL) THEN
      RAISE EXCEPTION 'the last day of a revision is written once, when it is superseded' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_revision_guard BEFORE UPDATE ON machvon.contract_revision
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_revision();

-- ---- the BOQ of a change order -------------------------------------------------------------------------------------------------------

-- The lines of a BOQ are written while the revision is a draft, and also while a change order waits for its day: the approval copies the lines of the revision in force, and the new
-- prices are put in before the day the revision takes over. Once it is in force the lines are fixed.
CREATE OR REPLACE FUNCTION machvon.guard_boq_line_write() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target_tenant uuid;
  target_revision uuid;
  held record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_revision := OLD.contract_revision_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_revision := NEW.contract_revision_id;
  END IF;
  SELECT status, kind, contract_id INTO held FROM machvon.contract_revision WHERE tenant_id = target_tenant AND id = target_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVISION_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF held.status <> 'DRAFT' AND NOT (held.status = 'PENDING_EFFECTIVE' AND held.kind = 'CHANGE_ORDER') THEN
    RAISE EXCEPTION 'REVISION_NOT_DRAFT' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.contract_revision_id, NEW.boq_item_id, NEW.contract_id) IS DISTINCT FROM (OLD.tenant_id, OLD.contract_revision_id, OLD.boq_item_id, OLD.contract_id) THEN
    RAISE EXCEPTION 'a BOQ line keeps its revision and its item' USING ERRCODE = '23514';
  END IF;
  -- The line, its revision and its item are of one contract.
  IF NEW.contract_id IS DISTINCT FROM held.contract_id
     OR NOT EXISTS (SELECT 1 FROM machvon.boq_item WHERE tenant_id = NEW.tenant_id AND id = NEW.boq_item_id AND contract_id = NEW.contract_id AND business_key = NEW.business_key AND unit_code = NEW.unit_code) THEN
    RAISE EXCEPTION 'a BOQ line belongs to the contract, the key and the unit of its item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
