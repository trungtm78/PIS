-- Authored by hand (not generated): the score of a person in a period, the adjustments and responses to it, and the signals of gaming (PWF-3, docs PWF 5 BR-PWF-36 to 41, 6, R33, R34, R43).
-- The score of a person is personal and sensitive: the database itself shows a row only to the person it is about, to the units whose manager asks (the unit at the time of the period, taken from the line) and to
-- the whole tenant when the human resources ask. The policy `scope_units_guard` reads two settings that the application puts into the transaction before every read or write of these tables:
--   app.scope_units  '*' (whole tenant) or the ids of the units the caller may read, comma separated; absent or empty shows nothing through the units;
--   app.score_subject the membership the caller is, so that a person reads their own rows; absent shows nothing through the subject.
-- Without either setting no row is seen and none can be written. The signals of gaming are for the reviewer only: their policy has no subject alternative, so the person scored never sees them.
-- A line is written while its period is a draft; once the period is locked only the adjusted score of a line (the sum of the approved adjustments) changes, and every change is an adjustment with a reason that a
-- second person approved. An adjustment and a response are decided once. Nothing here is deleted by the application apart from the lines and signals of a draft that is computed again.

CREATE TABLE machvon.staff_score_line (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL,
  -- Null only after the personal data of the period expired (V3033).
  membership_id uuid,
  -- The unit of the person when the period was computed: who may read the line is decided by it, not by where the person works later.
  unit_id_at_period uuid NOT NULL,
  score_computed numeric(5,2) CHECK (score_computed IS NULL OR score_computed BETWEEN 0 AND 100),
  score_adjusted numeric(5,2) CHECK (score_adjusted IS NULL OR score_adjusted BETWEEN 0 AND 100),
  -- The net points of the adjustments approved so far (the adjusted score is the computed score moved by them and kept inside 0 to 100).
  adjustment_points numeric(6,2) NOT NULL DEFAULT 0,
  rating text CHECK (rating IS NULL OR rating ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  state text NOT NULL CHECK (state IN ('RATED', 'NOT_RATED', 'SMALL_SAMPLE')),
  rated_task_count integer NOT NULL CHECK (rated_task_count >= 0),
  effective_weight numeric(14,2) NOT NULL CHECK (effective_weight >= 0),
  -- Where every point comes from: the tasks with the share of the person, the weight and the score; and what was left out, with the reason.
  contributions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contributions) = 'array'),
  excluded jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(excluded) = 'array'),
  erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT staff_score_line_period_member_uq UNIQUE (tenant_id, period_id, membership_id),
  CONSTRAINT staff_score_line_scope_uq UNIQUE (tenant_id, id, membership_id, unit_id_at_period),
  FOREIGN KEY (tenant_id, period_id) REFERENCES machvon.staff_score_period (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id_at_period) REFERENCES machvon.organization_unit (tenant_id, id),
  -- A person with no score has neither a rating nor an adjusted score; a small sample has a score and no rating (BR-PWF-36).
  CONSTRAINT staff_score_line_state_chk CHECK (
    (state = 'NOT_RATED') = (score_computed IS NULL)
    AND (score_computed IS NULL) = (score_adjusted IS NULL)
    AND (state = 'RATED' OR rating IS NULL)
  ),
  CONSTRAINT staff_score_line_erased_chk CHECK ((membership_id IS NULL) = (erased_at IS NOT NULL))
);

CREATE INDEX staff_score_line_period_idx ON machvon.staff_score_line (tenant_id, period_id, unit_id_at_period);
CREATE INDEX staff_score_line_member_idx ON machvon.staff_score_line (tenant_id, membership_id, period_id) WHERE membership_id IS NOT NULL;

CREATE TABLE machvon.staff_score_adjustment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL,
  -- The person and the unit of the line, copied so that the policy of the table does not need the line.
  subject_membership_id uuid,
  unit_id_at_period uuid NOT NULL,
  points numeric(5,2) NOT NULL CHECK (points BETWEEN -30 AND 30 AND points <> 0),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 1000),
  evidence_ref text CHECK (evidence_ref IS NULL OR char_length(evidence_ref) BETWEEN 1 AND 300),
  -- The response of the person that led to the adjustment, when it did.
  response_id uuid,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 5 AND 500),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, line_id, subject_membership_id, unit_id_at_period) REFERENCES machvon.staff_score_line (tenant_id, id, membership_id, unit_id_at_period),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  -- The one who asks and the one who decides are two people, and neither is the person scored (BR-PWF-38).
  CONSTRAINT staff_score_adjustment_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT staff_score_adjustment_not_subject_chk CHECK (subject_membership_id IS NULL OR (requested_by <> subject_membership_id AND (decided_by IS NULL OR decided_by <> subject_membership_id))),
  CONSTRAINT staff_score_adjustment_decision_chk CHECK ((status = 'REQUESTED') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL))
);

CREATE INDEX staff_score_adjustment_line_idx ON machvon.staff_score_adjustment (tenant_id, line_id, status);
CREATE INDEX staff_score_adjustment_subject_idx ON machvon.staff_score_adjustment (tenant_id, subject_membership_id) WHERE subject_membership_id IS NOT NULL;
CREATE INDEX staff_score_adjustment_response_idx ON machvon.staff_score_adjustment (tenant_id, response_id) WHERE response_id IS NOT NULL;
CREATE INDEX staff_score_adjustment_open_idx ON machvon.staff_score_adjustment (tenant_id, requested_at) WHERE status = 'REQUESTED';

CREATE TABLE machvon.staff_score_response (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL,
  subject_membership_id uuid,
  unit_id_at_period uuid NOT NULL,
  body text NOT NULL CHECK (body = btrim(body) AND char_length(body) BETWEEN 5 AND 2000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'HANDLED')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid,
  handled_at timestamptz,
  -- KEEP: the score stands; ADJUST: an adjustment was requested; UPHELD, RETURNED, KEPT: the decisions of the workflow of the approvers (the business type score.response).
  outcome text CHECK (outcome IS NULL OR outcome IN ('KEEP', 'ADJUST', 'UPHELD', 'RETURNED', 'KEPT')),
  conclusion text CHECK (conclusion IS NULL OR char_length(conclusion) BETWEEN 1 AND 2000),
  -- The instance of the ADM engine that handles the response, when the tenant runs a workflow for it (R43).
  approval_instance_id uuid,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, line_id, subject_membership_id, unit_id_at_period) REFERENCES machvon.staff_score_line (tenant_id, id, membership_id, unit_id_at_period),
  FOREIGN KEY (tenant_id, handled_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT staff_score_response_handled_chk CHECK ((status = 'OPEN') = (handled_at IS NULL) AND (handled_at IS NULL) = (outcome IS NULL)),
  -- Nobody handles the response to their own score (BR-PWF-39); a workflow decision has no single handler.
  CONSTRAINT staff_score_response_not_subject_chk CHECK (handled_by IS NULL OR subject_membership_id IS NULL OR handled_by <> subject_membership_id)
);

CREATE INDEX staff_score_response_line_idx ON machvon.staff_score_response (tenant_id, line_id, status);
CREATE INDEX staff_score_response_subject_idx ON machvon.staff_score_response (tenant_id, subject_membership_id) WHERE subject_membership_id IS NOT NULL;
CREATE INDEX staff_score_response_instance_idx ON machvon.staff_score_response (tenant_id, approval_instance_id) WHERE approval_instance_id IS NOT NULL;
CREATE INDEX staff_score_response_open_idx ON machvon.staff_score_response (tenant_id, submitted_at) WHERE status = 'OPEN';

-- The signals of gaming of a locked or draft period: for the reviewer only, never an input of a score (BR-PWF-37).
CREATE TABLE machvon.staff_score_signal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL,
  membership_id uuid,
  unit_id_at_period uuid NOT NULL,
  code text NOT NULL CHECK (code IN ('CANCELLED_SHARE_HIGH', 'TASKS_SPLIT_AFTER_BASELINE', 'BASELINE_REVISED_IN_PERIOD', 'ASSIGNEE_CHANGED_NEAR_DUE')),
  task_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(task_codes) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT staff_score_signal_uq UNIQUE (tenant_id, period_id, membership_id, code),
  FOREIGN KEY (tenant_id, period_id) REFERENCES machvon.staff_score_period (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id_at_period) REFERENCES machvon.organization_unit (tenant_id, id)
);

CREATE INDEX staff_score_signal_period_idx ON machvon.staff_score_signal (tenant_id, period_id, unit_id_at_period);
CREATE INDEX staff_score_signal_member_idx ON machvon.staff_score_signal (tenant_id, membership_id) WHERE membership_id IS NOT NULL;

-- Row-level security: the tenant, then the person or the units. A row is never reachable without one of them.
ALTER TABLE machvon.staff_score_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.staff_score_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.staff_score_line AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.staff_score_line AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scope_units_guard ON machvon.staff_score_line AS RESTRICTIVE FOR ALL
  USING (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')) OR membership_id::text = current_setting('app.score_subject', true))
  WITH CHECK (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')) OR membership_id::text = current_setting('app.score_subject', true));

ALTER TABLE machvon.staff_score_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.staff_score_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.staff_score_adjustment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.staff_score_adjustment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scope_units_guard ON machvon.staff_score_adjustment AS RESTRICTIVE FOR ALL
  USING (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')) OR subject_membership_id::text = current_setting('app.score_subject', true))
  WITH CHECK (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')) OR subject_membership_id::text = current_setting('app.score_subject', true));

ALTER TABLE machvon.staff_score_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.staff_score_response FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.staff_score_response AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.staff_score_response AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scope_units_guard ON machvon.staff_score_response AS RESTRICTIVE FOR ALL
  USING (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')) OR subject_membership_id::text = current_setting('app.score_subject', true))
  WITH CHECK (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')) OR subject_membership_id::text = current_setting('app.score_subject', true));

ALTER TABLE machvon.staff_score_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.staff_score_signal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.staff_score_signal AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.staff_score_signal AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No subject alternative: the person scored never sees a signal about themselves.
CREATE POLICY scope_units_guard ON machvon.staff_score_signal AS RESTRICTIVE FOR ALL
  USING (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')))
  WITH CHECK (current_setting('app.scope_units', true) = '*' OR unit_id_at_period::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')));

REVOKE DELETE, TRUNCATE ON TABLE machvon.staff_score_adjustment FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.staff_score_response FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.staff_score_line FROM machvon_app;
REVOKE TRUNCATE ON TABLE machvon.staff_score_signal FROM machvon_app;

-- The status of the period a row belongs to (the tables below follow it).
CREATE FUNCTION machvon.staff_score_period_status(p_tenant uuid, p_period uuid) RETURNS text
LANGUAGE sql STABLE
AS $fn$
  SELECT status FROM machvon.staff_score_period WHERE tenant_id = p_tenant AND id = p_period
$fn$;

-- Lines and signals are written while the period is a draft (and deleted only then, when it is computed again). After the lock a line changes in exactly one way: its adjusted score and the net points behind it.
CREATE FUNCTION machvon.guard_staff_score_line() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_status text;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_status := machvon.staff_score_period_status(OLD.tenant_id, OLD.period_id);
  ELSE
    v_status := machvon.staff_score_period_status(NEW.tenant_id, NEW.period_id);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'a line is written only while its period is a draft' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF v_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'a line of a locked period is never deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF v_status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.period_id, NEW.membership_id, NEW.unit_id_at_period, NEW.score_computed, NEW.rating, NEW.state, NEW.rated_task_count, NEW.effective_weight, NEW.contributions, NEW.excluded, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.period_id, OLD.membership_id, OLD.unit_id_at_period, OLD.score_computed, OLD.rating, OLD.state, OLD.rated_task_count, OLD.effective_weight, OLD.contributions, OLD.excluded, OLD.created_at) THEN
    RAISE EXCEPTION 'the computed score of a locked line never changes; it is adjusted by an approved adjustment' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER staff_score_line_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.staff_score_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_staff_score_line();

CREATE FUNCTION machvon.guard_staff_score_signal() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_status text;
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_status := machvon.staff_score_period_status(OLD.tenant_id, OLD.period_id);
  ELSE
    v_status := machvon.staff_score_period_status(NEW.tenant_id, NEW.period_id);
  END IF;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'a signal is written or removed only while its period is a draft' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER staff_score_signal_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.staff_score_signal
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_staff_score_signal();

-- An adjustment keeps what was asked for good; it is decided once, REQUESTED to APPROVED or REJECTED.
CREATE FUNCTION machvon.guard_staff_score_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an adjustment of a score is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.line_id, NEW.subject_membership_id, NEW.unit_id_at_period, NEW.points, NEW.reason, NEW.evidence_ref, NEW.response_id, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.line_id, OLD.subject_membership_id, OLD.unit_id_at_period, OLD.points, OLD.reason, OLD.evidence_ref, OLD.response_id, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'an adjustment keeps what was asked for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided adjustment never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER staff_score_adjustment_guard BEFORE UPDATE OR DELETE ON machvon.staff_score_adjustment
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_staff_score_adjustment();

-- A response keeps what the person wrote for good; it is handled once.
CREATE FUNCTION machvon.guard_staff_score_response() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a response to a score is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.line_id, NEW.subject_membership_id, NEW.unit_id_at_period, NEW.body, NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.line_id, OLD.subject_membership_id, OLD.unit_id_at_period, OLD.body, OLD.submitted_at) THEN
    RAISE EXCEPTION 'a response keeps what the person wrote for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'HANDLED' THEN
    RAISE EXCEPTION 'a handled response never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER staff_score_response_guard BEFORE UPDATE OR DELETE ON machvon.staff_score_response
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_staff_score_response();

COMMENT ON TABLE machvon.staff_score_line IS 'PERSONAL, SENSITIVE: the score of a person in a period with every point traced to a task (PWF-3, R33); seen only by the person, the unit at the time of the period and the human resources.';
COMMENT ON TABLE machvon.staff_score_adjustment IS 'PERSONAL, SENSITIVE: an adjustment of a score with a reason, asked by one person and decided by another (BR-PWF-38).';
COMMENT ON TABLE machvon.staff_score_response IS 'PERSONAL, SENSITIVE: the response of the person scored to their score, handled by someone else (BR-PWF-39, R43).';
COMMENT ON TABLE machvon.staff_score_signal IS 'PERSONAL, SENSITIVE: the signals of gaming of a period, for the reviewer only; they never change a score (BR-PWF-37).';
