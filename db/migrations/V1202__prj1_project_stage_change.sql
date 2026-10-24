-- Authored by hand (not generated): the history of the stage of a project (ST-PRJ-002, PRJ 3.1 F3 to F5, section 4).
-- A project moves along the PIMA life cycle only through a guarded command or a system consumer; each move leaves one row here with the stages
-- it joined, the command or event behind it, who made it (a member or the system), the decision document it rests on and the reason. The row
-- is what getProjectLifecycle reads, and it is kept for good: no row changes or is deleted, by the runtime role or by a statement that
-- bypassed the commands.

CREATE TABLE machvon.project_stage_change (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  -- The version the project had after the move: with the project it names the move, and one move per version is all there can be.
  project_version bigint NOT NULL CHECK (project_version > 1),
  from_stage text NOT NULL,
  to_stage text NOT NULL,
  -- The command (startProjectImplementation...) or the event type (capital.plan_published.v1) that moved the project.
  operation text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('USER', 'SYSTEM')),
  actor_id uuid NOT NULL,
  decision_document_id uuid,
  reason text,
  effective_date date,
  -- The outbox event a system move answers; a repeated delivery of it moves nothing a second time.
  source_event_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_stage_change_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  CONSTRAINT project_stage_change_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id),
  CONSTRAINT project_stage_change_stages_chk CHECK (
    from_stage <> to_stage
    AND from_stage IN ('CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED')
    AND to_stage IN ('CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED')
  ),
  -- A closed, rejected or cancelled project leads nowhere.
  CONSTRAINT project_stage_change_terminal_chk CHECK (from_stage NOT IN ('CLOSED', 'REJECTED', 'CANCELLED')),
  -- A member explains the move; the system names the event it answers.
  CONSTRAINT project_stage_change_actor_chk CHECK (
    (actor_kind = 'USER' AND reason IS NOT NULL AND btrim(reason) <> '' AND source_event_id IS NULL)
    OR (actor_kind = 'SYSTEM' AND source_event_id IS NOT NULL)
  ),
  CONSTRAINT project_stage_change_operation_chk CHECK (operation = btrim(operation) AND operation <> '')
);

-- One move per version of a project, and one move per event of the system.
CREATE UNIQUE INDEX project_stage_change_version_uq ON machvon.project_stage_change (tenant_id, project_id, project_version);
CREATE UNIQUE INDEX project_stage_change_event_uq ON machvon.project_stage_change (tenant_id, project_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX project_stage_change_history_idx ON machvon.project_stage_change (tenant_id, project_id, occurred_at, id);
CREATE INDEX project_stage_change_actor_idx ON machvon.project_stage_change (tenant_id, actor_id);
CREATE INDEX project_stage_change_event_idx ON machvon.project_stage_change (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX project_stage_change_document_idx ON machvon.project_stage_change (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;

ALTER TABLE machvon.project_stage_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.project_stage_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.project_stage_change AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.project_stage_change AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only: the runtime role writes and reads rows, it never changes or erases one.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.project_stage_change FROM machvon_app;

CREATE FUNCTION machvon.guard_project_stage_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a recorded stage change is never changed or deleted' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER project_stage_change_guard BEFORE UPDATE OR DELETE ON machvon.project_stage_change
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_stage_change();
