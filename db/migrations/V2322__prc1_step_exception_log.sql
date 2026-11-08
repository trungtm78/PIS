-- Authored by hand (not generated): the exceptions to the rules of a step and the log of what happens to a package under its workflow (PRC-1).
-- An exception is asked for with a reason by one person and decided by ANOTHER (maker is not approver): SKIP_ITEMS lets the package leave a step with required items open or evidence missing, CORRECT_BACK takes it back one
-- step when it was moved by mistake (approval executes the correction and the wrongly entered visit ends as CORRECTED, nothing is erased). The log is the append-only record of the holds, resumes, assignments, requests,
-- decisions and corrections that the timeline reads.

CREATE TABLE machvon.package_step_exception (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  step_visit_id uuid NOT NULL,
  package_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SKIP_ITEMS', 'CORRECT_BACK')),
  item_codes text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'USED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (decision_note = btrim(decision_note) AND char_length(decision_note) BETWEEN 1 AND 500)),
  used_at timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.package_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, step_visit_id) REFERENCES machvon.package_step (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT package_step_exception_decision_chk CHECK ((status IN ('APPROVED', 'REJECTED', 'USED')) = (decided_by IS NOT NULL) AND (decided_by IS NULL) = (decided_at IS NULL) AND (status = 'USED') = (used_at IS NOT NULL)),
  -- Maker is not approver.
  CONSTRAINT package_step_exception_sod_chk CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

-- One exception of a kind in work for a visit at a time.
CREATE UNIQUE INDEX package_step_exception_open_uq ON machvon.package_step_exception (tenant_id, step_visit_id, kind) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE INDEX package_step_exception_workflow_idx ON machvon.package_step_exception (tenant_id, workflow_id, requested_at);
CREATE INDEX package_step_exception_waiting_idx ON machvon.package_step_exception (tenant_id, requested_at) WHERE status = 'REQUESTED';

ALTER TABLE machvon.package_step_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.package_step_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.package_step_exception AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.package_step_exception AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.package_step_exception FROM machvon_app;

-- What an exception asks never changes; it moves REQUESTED -> APPROVED | REJECTED, APPROVED -> USED, and no further.
CREATE FUNCTION machvon.guard_package_step_exception() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'an exception to a step is never deleted (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.workflow_id, NEW.step_visit_id, NEW.package_id, NEW.kind, NEW.item_codes, NEW.reason, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.workflow_id, OLD.step_visit_id, OLD.package_id, OLD.kind, OLD.item_codes, OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'what an exception to a step asks never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('REJECTED', 'USED') THEN
    RAISE EXCEPTION 'a decided exception never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'REJECTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'USED')
  ) THEN
    RAISE EXCEPTION 'an exception cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER package_step_exception_guard BEFORE UPDATE OR DELETE ON machvon.package_step_exception
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_package_step_exception();

-- The log of what happens to a package under its workflow, append-only (the holds, resumes, assignments, requests, decisions and corrections the timeline reads).
CREATE TABLE machvon.package_workflow_log (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  package_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('HOLD', 'RESUME', 'ASSIGN_OWNER', 'REASSIGN_OWNER', 'ASSIGN_ITEM', 'EXCEPTION_REQUESTED', 'EXCEPTION_APPROVED', 'EXCEPTION_REJECTED', 'CORRECTION', 'CANCEL')),
  at timestamptz NOT NULL DEFAULT now(),
  actor uuid NOT NULL,
  step_code text CHECK (step_code IS NULL OR step_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)),
  subject uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES machvon.package_workflow (tenant_id, id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES machvon.procurement_package (tenant_id, id),
  FOREIGN KEY (tenant_id, actor) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX package_workflow_log_workflow_idx ON machvon.package_workflow_log (tenant_id, workflow_id, at);
CREATE INDEX package_workflow_log_package_idx ON machvon.package_workflow_log (tenant_id, package_id, at);

ALTER TABLE machvon.package_workflow_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.package_workflow_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.package_workflow_log AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.package_workflow_log AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.package_workflow_log FROM machvon_app;

COMMENT ON TABLE machvon.package_step_exception IS 'Exceptions to the rules of a step (PRC-1): asked with a reason by one person, decided by another; SKIP_ITEMS or CORRECT_BACK.';
COMMENT ON TABLE machvon.package_workflow_log IS 'Append-only log of the holds, resumes, assignments, exception requests and decisions of a package workflow (PRC-1).';

-- An item that was waived names the exception that waived it.
ALTER TABLE machvon.package_checklist_item
  ADD CONSTRAINT package_checklist_item_exception_fk FOREIGN KEY (tenant_id, waived_exception_id) REFERENCES machvon.package_step_exception (tenant_id, id);
CREATE INDEX package_checklist_item_exception_idx ON machvon.package_checklist_item (tenant_id, waived_exception_id) WHERE waived_exception_id IS NOT NULL;

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX package_step_exception_package_idx ON machvon.package_step_exception (tenant_id, package_id);
