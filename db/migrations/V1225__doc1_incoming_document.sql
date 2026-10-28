-- DOC-1, ST-DOC-011: incoming documents. The table incoming_document comes from the generated schema (V002). This adds the history of who a letter was given to, how late a letter was resolved, and the rules the
-- database keeps whoever writes: the chain of the states, the identity of the letter that never changes, and a history that nobody edits.
ALTER TABLE machvon.incoming_document
  ADD COLUMN late_days integer CHECK (late_days IS NULL OR late_days >= 0),
  ADD COLUMN overdue_since date;

-- A reassignment keeps the earlier ones (DOC.md, state chain): every assignment of a letter is a row, and none is ever changed or erased.
CREATE TABLE machvon.incoming_assignment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  incoming_document_id uuid NOT NULL,
  assigned_unit_id uuid NOT NULL,
  assignee_user_id uuid,
  leader_directive text,
  due_on date,
  assigned_by uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT incoming_assignment_incoming_fk FOREIGN KEY (tenant_id, incoming_document_id) REFERENCES machvon.incoming_document (tenant_id, id),
  CONSTRAINT incoming_assignment_unit_fk FOREIGN KEY (tenant_id, assigned_unit_id) REFERENCES machvon.organization_unit (tenant_id, id)
);
CREATE INDEX incoming_assignment_incoming_idx ON machvon.incoming_assignment (tenant_id, incoming_document_id, assigned_at);
CREATE INDEX incoming_assignment_unit_idx ON machvon.incoming_assignment (tenant_id, assigned_unit_id);
CREATE INDEX incoming_assignment_assignee_idx ON machvon.incoming_assignment (tenant_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;

ALTER TABLE machvon.incoming_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.incoming_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.incoming_assignment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.incoming_assignment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.incoming_assignment FROM machvon_app;

-- The chain RECEIVED, REGISTERED, ASSIGNED, PROCESSING, RESOLVED, FILED (with REJECTED from RECEIVED, and the reassignment from PROCESSING back to ASSIGNED), the identity of a letter (what arrived, from whom, when and
-- who took it in; the register once it has one), and the end of the chain: a filed or a rejected letter changes no more.
CREATE FUNCTION machvon.guard_incoming_document() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.document_id, NEW.channel, NEW.received_at, NEW.received_by, NEW.sender_name, NEW.original_symbol, NEW.original_issued_on, NEW.duplicate_override_reason, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.document_id, OLD.channel, OLD.received_at, OLD.received_by, OLD.sender_name, OLD.original_symbol, OLD.original_issued_on, OLD.duplicate_override_reason, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what arrived, from whom and when does not change' USING ERRCODE = '23514';
  END IF;
  -- The letter it duplicates is named at the door, or once, by the rejection of a copy; it is never changed after.
  IF OLD.duplicate_of_id IS NOT NULL AND NEW.duplicate_of_id IS DISTINCT FROM OLD.duplicate_of_id THEN
    RAISE EXCEPTION 'what arrived, from whom and when does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.register_id IS NOT NULL AND NEW.register_id IS DISTINCT FROM OLD.register_id THEN
    RAISE EXCEPTION 'the register of a letter does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('FILED', 'REJECTED') THEN
    RAISE EXCEPTION 'DOCUMENT_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF OLD.resolved_at IS NOT NULL AND (NEW.resolved_at, NEW.resolution_summary, NEW.response_outgoing_id, NEW.late_days) IS DISTINCT FROM (OLD.resolved_at, OLD.resolution_summary, OLD.response_outgoing_id, OLD.late_days) THEN
    RAISE EXCEPTION 'the resolution of a letter is kept as it is' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES ('RECEIVED', 'REGISTERED'), ('RECEIVED', 'REJECTED'), ('REGISTERED', 'ASSIGNED'), ('ASSIGNED', 'ASSIGNED'), ('ASSIGNED', 'PROCESSING'), ('PROCESSING', 'ASSIGNED'), ('PROCESSING', 'RESOLVED'), ('RESOLVED', 'FILED'))
           AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'DOCUMENT_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER incoming_document_guard BEFORE UPDATE ON machvon.incoming_document
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_incoming_document();

-- The reminder to the handler of an incoming letter that is past its deadline (DOC 3 F10, BR-DOC-18). The payload names the letter and the days, never its title or its sender.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'doc.incoming_overdue.v1',
  'DOC',
  1,
  '{"type":"object","required":["tenant_id","document_id","incoming_document_id","due_on","late_days"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"document_id":{"type":"string","format":"uuid"},"incoming_document_id":{"type":"string","format":"uuid"},"status":{"type":"string"},"due_on":{"type":"string","format":"date"},"late_days":{"type":"integer","minimum":1},"assigned_unit_id":{"type":["string","null"],"format":"uuid"},"assignee_user_id":{"type":["string","null"],"format":"uuid"},"notification":{"type":"object"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;
