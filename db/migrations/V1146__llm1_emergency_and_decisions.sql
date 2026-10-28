-- Authored by hand (not generated): the guards under the emergency stop and the record of the decisions of people about what an AI answered (ST-LLM-006, LLM F7, F8, BR-LLM-12).
-- A switch is for one scope; the whole tenant has no reference, every other scope has one; two switches of one scope are not engaged together (the whole tenant included, which the baseline index did not see for the reference is empty).
-- A decision record is written once: it is not changed, except that the command that used it says which operation and which version of the resource it produced, once; and it is not deleted.

ALTER TABLE machvon.ai_kill_switch ADD CONSTRAINT ai_kill_switch_scope_chk CHECK ((scope_kind = 'TENANT' AND scope_ref IS NULL) OR (scope_kind <> 'TENANT' AND scope_ref IS NOT NULL AND length(scope_ref) > 0));
DROP INDEX machvon.ai_kill_switch_engaged_uq;
CREATE UNIQUE INDEX ai_kill_switch_engaged_uq ON machvon.ai_kill_switch (tenant_id, scope_kind, coalesce(scope_ref, '')) WHERE state = 'ENGAGED';
ALTER TABLE machvon.ai_kill_switch ADD CONSTRAINT ai_kill_switch_reason_chk CHECK (length(reason) >= 10);

CREATE OR REPLACE FUNCTION machvon.ai_kill_switch_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.state = 'RELEASED' AND (NEW.state <> 'RELEASED' OR NEW.release_reason IS DISTINCT FROM OLD.release_reason OR NEW.release_approved_by IS DISTINCT FROM OLD.release_approved_by) THEN
    RAISE EXCEPTION 'a switch that was released does not engage again: a new one is made' USING ERRCODE = '23514', CONSTRAINT = 'ai_kill_switch_released_guard';
  END IF;
  IF NEW.scope_kind <> OLD.scope_kind OR NEW.scope_ref IS DISTINCT FROM OLD.scope_ref OR NEW.reason <> OLD.reason OR NEW.engaged_by <> OLD.engaged_by THEN
    RAISE EXCEPTION 'the scope, the reason and the person of a switch do not change' USING ERRCODE = '23514', CONSTRAINT = 'ai_kill_switch_immutable_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ai_kill_switch_guard BEFORE UPDATE ON machvon.ai_kill_switch FOR EACH ROW EXECUTE FUNCTION machvon.ai_kill_switch_guard();

-- A request that was running when its scope was stopped, at a provider that cannot cancel it: its answer is thrown away when it comes.
ALTER TABLE machvon.ai_request ADD COLUMN killed_pending boolean NOT NULL DEFAULT false;

-- A request that was stopped before it had a route is cancelled without one.
ALTER TABLE machvon.ai_request DROP CONSTRAINT ai_request_route_chk;
ALTER TABLE machvon.ai_request ADD CONSTRAINT ai_request_route_chk CHECK (status IN ('ADMITTED','REJECTED_POLICY','CANCELLED') OR route_class IS NOT NULL);

CREATE OR REPLACE FUNCTION machvon.ai_decision_record_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a decision record is not deleted' USING ERRCODE = '23514', CONSTRAINT = 'ai_decision_record_insert_only';
  END IF;
  IF (to_jsonb(NEW) - 'applied_operation_id' - 'applied_resource_version') IS DISTINCT FROM (to_jsonb(OLD) - 'applied_operation_id' - 'applied_resource_version')
     OR OLD.applied_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'a decision record is not changed' USING ERRCODE = '23514', CONSTRAINT = 'ai_decision_record_insert_only';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER ai_decision_record_guard BEFORE UPDATE OR DELETE ON machvon.ai_decision_record FOR EACH ROW EXECUTE FUNCTION machvon.ai_decision_record_guard();
CREATE INDEX IF NOT EXISTS ai_decision_record_subject_idx ON machvon.ai_decision_record (tenant_id, ai_request_id, subject_kind, subject_id, decided_at DESC);
