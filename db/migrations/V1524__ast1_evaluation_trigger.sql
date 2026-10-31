-- Authored by hand (not generated): the trigger of the evaluation after the investment (ST-AST-006, AST 3.4, UC-AST-04, UAT-AC394).
-- The table evaluation_trigger, the kinds and the statuses, the fired trigger that names its time, the unique index (a trigger of a kind exists once for a project and a handover), the foreign keys to
-- the project, the handover and the evaluation of MNE and the index of the due day are in V002. This adds who set the trigger (the job that fires it is a worker, not a member, so who last changed it is not a foreign key), that a trigger after a handover names the
-- handover, that a trigger acknowledged names the evaluation it led to, that what a trigger is does not change once it is written, that its status only moves forward, and that it is never deleted.

ALTER TABLE machvon.evaluation_trigger
  ADD CONSTRAINT evaluation_trigger_handover_chk CHECK (trigger_kind NOT IN ('POST_HANDOVER_12M', 'POST_HANDOVER_24M') OR source_handover_id IS NOT NULL),
  ADD CONSTRAINT evaluation_trigger_ack_chk CHECK ((status = 'ACKNOWLEDGED') = (mne_evaluation_id IS NOT NULL)),
  ADD CONSTRAINT evaluation_trigger_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id);

CREATE FUNCTION machvon.guard_evaluation_trigger() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.trigger_kind, NEW.source_handover_id, NEW.due_on, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.trigger_kind, OLD.source_handover_id, OLD.due_on, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a trigger of evaluation says never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status, NEW.status) IN (('SCHEDULED', 'FIRED'), ('FIRED', 'ACKNOWLEDGED'), ('SCHEDULED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'this move of the status of a trigger of evaluation is not allowed' USING ERRCODE = '23514';
  END IF;
  -- A trigger that has been fired keeps the time it was fired, and the event that announced it is written once.
  IF (OLD.fired_at IS NOT NULL AND NEW.fired_at IS DISTINCT FROM OLD.fired_at) OR (OLD.outbox_event_id IS NOT NULL AND NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id) THEN
    RAISE EXCEPTION 'a trigger of evaluation keeps the time it was fired and the event that announced it' USING ERRCODE = '23514';
  END IF;
  IF OLD.mne_evaluation_id IS NOT NULL AND NEW.mne_evaluation_id IS DISTINCT FROM OLD.mne_evaluation_id THEN
    RAISE EXCEPTION 'a trigger of evaluation keeps the evaluation it led to' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER evaluation_trigger_guard BEFORE UPDATE ON machvon.evaluation_trigger
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_evaluation_trigger();

REVOKE DELETE, TRUNCATE ON machvon.evaluation_trigger FROM machvon_app;

-- The reminder the notification service knows: an evaluation that has fallen due (to the one who set the trigger). The payload names ids, the kind and the day.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'ast.evaluation.due.v1',
  'AST',
  1,
  '{"type":"object","required":["tenant_id","trigger_id","project_id","trigger_kind","due_on"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"trigger_id":{"type":"string","format":"uuid"},"project_id":{"type":"string","format":"uuid"},"trigger_kind":{"type":"string"},"handover_id":{"type":["string","null"]},"due_on":{"type":"string"},"occurred_at":{"type":"string"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;
