-- Authored by hand (not generated): the procurement plan with its packages, the budget check and the approval decision (ST-BID-001, BID 3 F1).
-- V002 gave `procurement_plan` (KHLCNT) and extended `procurement_package` (plan, title, contract type, bidding form, allocation line,
-- period, duration) with the row-level security of the tenant, the one APPROVED plan per project and the unique package code per project
-- revision. This migration puts into the database what the commands rely on:
--   * a plan is judged by two different people besides its maker: the person who submitted it and the person who approved it differ;
--   * a plan keeps what it was made of (project, revision, title, legal basis, total, predecessor, maker) and moves along the state machine
--     of BID 3 section 4 only; SUPERSEDED and CANCELLED are final; a plan is never deleted;
--   * one project has at most one plan in work (DRAFT or IN_REVIEW) at a time, so a revision never races another revision;
--   * the packages of a plan are written while the plan is a DRAFT, are never deleted, and keep their money, code and funding line for good;
--     only their status, the decision they rest on and the code on the national bidding network can follow;
--   * the total of a plan is the exact sum of its packages (checked at commit);
--   * every step of a plan leaves a row in its history, which no statement of the runtime role can change or erase.
-- The columns of the legacy shape of a package (no plan, no title, no funding line) stay as they were: the fixtures of other modules write
-- packages awarded outside a plan, and the checks below bind the packages that name a plan only.

ALTER TABLE machvon.procurement_plan
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz;

ALTER TABLE machvon.procurement_plan
  ADD CONSTRAINT procurement_plan_text_chk CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 3 AND 500
    AND legal_basis = btrim(legal_basis) AND char_length(legal_basis) BETWEEN 3 AND 2000
  ),
  ADD CONSTRAINT procurement_plan_submitted_chk CHECK (
    status NOT IN ('IN_REVIEW', 'APPROVED', 'SUPERSEDED') OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  ADD CONSTRAINT procurement_plan_approval_time_chk CHECK (status NOT IN ('APPROVED', 'SUPERSEDED') OR approved_at IS NOT NULL),
  -- The approver is neither the maker (procurement_plan_sod_chk of V002) nor the person who submitted the plan.
  ADD CONSTRAINT procurement_plan_submitter_sod_chk CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by),
  ADD CONSTRAINT procurement_plan_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  ADD CONSTRAINT procurement_plan_supersedes_fk FOREIGN KEY (tenant_id, supersedes_id) REFERENCES machvon.procurement_plan (tenant_id, id),
  ADD CONSTRAINT procurement_plan_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id);

-- One plan in work per project.
CREATE UNIQUE INDEX procurement_plan_one_open_uq ON machvon.procurement_plan (tenant_id, project_id) WHERE status IN ('DRAFT', 'IN_REVIEW');
CREATE INDEX procurement_plan_supersedes_idx ON machvon.procurement_plan (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX procurement_plan_document_idx ON machvon.procurement_plan (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;
CREATE INDEX procurement_plan_listing_idx ON machvon.procurement_plan (tenant_id, created_at DESC, id DESC);

-- A plan starts as a DRAFT, keeps its identity, moves along the state machine and is never deleted.
CREATE FUNCTION machvon.guard_procurement_plan() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a procurement plan is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a procurement plan starts as a draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.revision, NEW.title, NEW.legal_basis, NEW.total_value_vnd, NEW.supersedes_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.revision, OLD.title, OLD.legal_basis, OLD.total_value_vnd, OLD.supersedes_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a procurement plan keeps its project, revision, text, total and maker for good' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('SUPERSEDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a superseded or cancelled procurement plan never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN
         (('DRAFT', 'IN_REVIEW'), ('DRAFT', 'CANCELLED'), ('IN_REVIEW', 'DRAFT'), ('IN_REVIEW', 'APPROVED'), ('IN_REVIEW', 'CANCELLED'), ('APPROVED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'the state transition of the procurement plan is not allowed' USING ERRCODE = '23514';
  END IF;
  -- The decision stays as it was taken once the plan is approved.
  IF OLD.status = 'APPROVED' AND (NEW.decision_document_id, NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.decision_document_id, OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'the approval of a procurement plan is not rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.procurement_plan
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_plan();

-- The total of a plan is the exact sum of the budgets of its packages. The packages are written after the plan in one transaction, so the
-- check waits for the commit.
CREATE FUNCTION machvon.check_procurement_plan_total() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  packaged numeric;
BEGIN
  SELECT coalesce(sum(budget_vnd), 0) INTO packaged FROM machvon.procurement_package WHERE tenant_id = NEW.tenant_id AND plan_id = NEW.id;
  IF packaged <> NEW.total_value_vnd THEN
    RAISE EXCEPTION 'the total of a procurement plan is the sum of its packages' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER procurement_plan_total_check AFTER INSERT ON machvon.procurement_plan
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION machvon.check_procurement_plan_total();

-- The packages that name a plan are complete: a title, the way the work is paid (contract type), the form of the bidding, the line of
-- capital that pays for it, a period and a duration, and a price above nothing.
ALTER TABLE machvon.procurement_package
  ADD CONSTRAINT procurement_package_plan_complete_chk CHECK (
    plan_id IS NULL
    OR (title IS NOT NULL AND contract_type IS NOT NULL AND bidding_form IS NOT NULL AND allocation_line_id IS NOT NULL
        AND planned_start_period IS NOT NULL AND duration_days IS NOT NULL AND budget_vnd > 0)
  ),
  ADD CONSTRAINT procurement_package_text_chk CHECK (
    plan_id IS NULL
    OR (code = btrim(code) AND char_length(code) BETWEEN 1 AND 50 AND title = btrim(title) AND char_length(title) BETWEEN 3 AND 500
        AND method = btrim(method) AND method <> '')
  ),
  ADD CONSTRAINT procurement_package_period_chk CHECK (planned_start_period IS NULL OR planned_start_period ~ '^[0-9]{4}-(Q[1-4]|0[1-9]|1[0-2])$'),
  ADD CONSTRAINT procurement_package_plan_fk FOREIGN KEY (tenant_id, plan_id) REFERENCES machvon.procurement_plan (tenant_id, id),
  ADD CONSTRAINT procurement_package_allocation_line_fk FOREIGN KEY (tenant_id, allocation_line_id) REFERENCES machvon.allocation_line (tenant_id, id),
  ADD CONSTRAINT procurement_package_decision_fk FOREIGN KEY (tenant_id, approved_decision_id) REFERENCES machvon.document (tenant_id, id);

CREATE INDEX procurement_package_plan_idx ON machvon.procurement_package (tenant_id, plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX procurement_package_allocation_line_idx ON machvon.procurement_package (tenant_id, allocation_line_id) WHERE allocation_line_id IS NOT NULL;
CREATE INDEX procurement_package_decision_idx ON machvon.procurement_package (tenant_id, approved_decision_id) WHERE approved_decision_id IS NOT NULL;
CREATE INDEX procurement_package_listing_idx ON machvon.procurement_package (tenant_id, created_at DESC, id DESC);

-- A package is written into a plan that is a DRAFT, of its own project and revision; it keeps its plan, code, money, method, funding line
-- and period for good, and is never deleted. Its status, the decision it rests on, the code on the national network and its version follow.
CREATE FUNCTION machvon.guard_procurement_package() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  plan_row machvon.procurement_plan%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'a package of a procurement plan is never deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.plan_id IS NOT NULL THEN
      SELECT * INTO plan_row FROM machvon.procurement_plan WHERE tenant_id = NEW.tenant_id AND id = NEW.plan_id;
      IF plan_row.status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'a package joins a procurement plan while the plan is a draft' USING ERRCODE = '23514';
      END IF;
      IF plan_row.project_id <> NEW.project_id OR plan_row.revision <> NEW.revision THEN
        RAISE EXCEPTION 'a package has the project and the revision of its plan' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.plan_id IS NULL THEN
    IF NEW.plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'a package is made inside its plan' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.plan_id, NEW.project_id, NEW.code, NEW.revision, NEW.budget_vnd, NEW.method, NEW.title, NEW.contract_type, NEW.bidding_form,
      NEW.allocation_line_id, NEW.planned_start_period, NEW.duration_days, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.plan_id, OLD.project_id, OLD.code, OLD.revision, OLD.budget_vnd, OLD.method, OLD.title, OLD.contract_type, OLD.bidding_form,
      OLD.allocation_line_id, OLD.planned_start_period, OLD.duration_days, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a package of a procurement plan keeps what the plan decided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_package_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.procurement_package
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_package();

-- The history of a plan: every step leaves one row with who took it, from and to which status, the words they gave and the decision
-- document an approval rests on.
CREATE TABLE machvon.procurement_plan_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  plan_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('CREATED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'SUPERSEDED', 'REPLACED')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid NOT NULL,
  comment text,
  decision_document_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT procurement_plan_event_plan_fk FOREIGN KEY (tenant_id, plan_id) REFERENCES machvon.procurement_plan (tenant_id, id),
  CONSTRAINT procurement_plan_event_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id),
  CONSTRAINT procurement_plan_event_statuses_chk CHECK (
    (from_status IS NULL OR from_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED', 'CANCELLED'))
    AND to_status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED', 'CANCELLED')
  ),
  CONSTRAINT procurement_plan_event_comment_chk CHECK (
    (comment IS NULL OR (comment = btrim(comment) AND char_length(comment) BETWEEN 1 AND 2000))
    AND (event_kind NOT IN ('REJECTED', 'RETURNED') OR comment IS NOT NULL)
  ),
  CONSTRAINT procurement_plan_event_decision_chk CHECK ((event_kind = 'APPROVED') = (decision_document_id IS NOT NULL))
);

CREATE INDEX procurement_plan_event_history_idx ON machvon.procurement_plan_event (tenant_id, plan_id, occurred_at, id);
CREATE INDEX procurement_plan_event_actor_idx ON machvon.procurement_plan_event (tenant_id, actor_id);
CREATE INDEX procurement_plan_event_document_idx ON machvon.procurement_plan_event (tenant_id, decision_document_id) WHERE decision_document_id IS NOT NULL;

ALTER TABLE machvon.procurement_plan_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.procurement_plan_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.procurement_plan_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.procurement_plan_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only: the runtime role writes and reads rows, it never changes or erases one.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.procurement_plan_event FROM machvon_app;

CREATE FUNCTION machvon.guard_procurement_plan_event() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'a recorded step of a procurement plan is never changed or deleted' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER procurement_plan_event_guard BEFORE UPDATE OR DELETE ON machvon.procurement_plan_event
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_procurement_plan_event();

-- Plans and their packages are kept with the project (retention: the life of the project): no command deletes them.
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_plan FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.procurement_package FROM machvon_app;
