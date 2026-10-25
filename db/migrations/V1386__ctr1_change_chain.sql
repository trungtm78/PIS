-- Authored by hand (not generated): the chain of changes of a contract (ST-CTR-006, CTR 3.3, BR-CTR-07).
-- The tables change_chain_config and change_request come from the generated schema (V002, with the extension columns of the change chain). This adds the assessment of a request (who
-- evaluated it, when, what it does to the schedule, the scope and the funding), the checks that make each status mean what it says, the guard that fixes the number of tiers of a project
-- once its first request is raised (even for a statement that bypasses the commands), and the guard that keeps a request in its place in the chain.

ALTER TABLE machvon.change_request
  ADD COLUMN evaluated_by uuid,
  ADD COLUMN evaluated_at timestamptz,
  ADD COLUMN funding_impact_note text,
  ADD COLUMN scope_impact_note text,
  ADD COLUMN evaluation_allocation_line_id uuid,
  ADD COLUMN status_reason text;

ALTER TABLE machvon.change_request ADD FOREIGN KEY (tenant_id, evaluation_allocation_line_id) REFERENCES machvon.allocation_line (tenant_id, id);
CREATE INDEX change_request_evaluation_allocation_line_id_idx ON machvon.change_request (tenant_id, evaluation_allocation_line_id);

-- An evaluated request carries its assessment: the cost, who made it and when, and what it does to the funding.
ALTER TABLE machvon.change_request
  ADD CONSTRAINT change_request_evaluated_chk CHECK (
    status <> 'EVALUATED' OR (evaluated_delta_vnd IS NOT NULL AND evaluated_by IS NOT NULL AND evaluated_at IS NOT NULL AND funding_impact_note IS NOT NULL)
  );

-- Only a CO is decided (approved or rejected); the first tier of a chain has no parent; a request that was raised has its maker (a draft and a withdrawn one may not).
ALTER TABLE machvon.change_request
  ADD CONSTRAINT change_request_stage_status_chk CHECK (stage = 'CO' OR status NOT IN ('APPROVED', 'REJECTED')),
  ADD CONSTRAINT change_request_parent_chk CHECK (stage <> 'EVENT' OR parent_id IS NULL),
  ADD CONSTRAINT change_request_submitted_chk CHECK (status IN ('DRAFT', 'WITHDRAWN') OR submitted_by IS NOT NULL),
  ADD CONSTRAINT change_request_text_chk CHECK (
    reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 2000
    AND (status_reason IS NULL OR (status_reason = btrim(status_reason) AND status_reason <> '' AND char_length(status_reason) <= 2000))
    AND (funding_impact_note IS NULL OR (funding_impact_note = btrim(funding_impact_note) AND funding_impact_note <> '' AND char_length(funding_impact_note) <= 2000))
    AND (scope_impact_note IS NULL OR (scope_impact_note = btrim(scope_impact_note) AND scope_impact_note <> '' AND char_length(scope_impact_note) <= 2000))
  );

-- A request is promoted once: a request has at most one child.
CREATE UNIQUE INDEX change_request_one_child_uq ON machvon.change_request (tenant_id, parent_id) WHERE parent_id IS NOT NULL;

-- A request keeps its place: the contract, the tier, the parent, the code, the baseline and the first estimate never change; the status moves along the edges only; a request that was
-- promoted, rejected or withdrawn is kept as it is; and a child stands under a parent of the same contract at the tier before its own, which was promoted for it.
CREATE FUNCTION machvon.guard_change_request() RETURNS trigger
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
  IF OLD.status IN ('PROMOTED', 'REJECTED', 'WITHDRAWN') THEN
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

CREATE TRIGGER change_request_guard BEFORE INSERT OR UPDATE ON machvon.change_request
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_change_request();

-- The number of tiers of a project is fixed by its first request (BR-CTR-07): once the configuration is locked it is not changed, not deleted and not unlocked, by a command or by a
-- statement of any other kind; before that it may be set again, and the lock itself changes nothing but the lock.
CREATE FUNCTION machvon.guard_change_chain_config() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'CHANGE_TIERS_LOCKED' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'CHANGE_TIERS_LOCKED' USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'the configuration of a project stays with the project' USING ERRCODE = '23514';
  END IF;
  IF NEW.locked_at IS NOT NULL AND NEW.tier_count IS DISTINCT FROM OLD.tier_count THEN
    RAISE EXCEPTION 'the lock of the tiers does not change them' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

-- The baseline guard only refused a change of the count; it is replaced by this one, which also covers the delete and the unlock.
DROP TRIGGER change_chain_config_guard_tg ON machvon.change_chain_config;
DROP FUNCTION machvon.change_chain_config_guard();

CREATE TRIGGER change_chain_config_guard_tg BEFORE UPDATE OR DELETE ON machvon.change_chain_config
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_change_chain_config();

-- The requests and the configuration of a project are part of its dossier: no command deletes one, and the runtime role no longer can.
REVOKE DELETE, TRUNCATE ON TABLE machvon.change_request FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.change_chain_config FROM machvon_app;
