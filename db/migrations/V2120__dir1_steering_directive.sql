-- Authored by hand (not generated): the directives of the investment steering meetings ("chỉ đạo giao ban", customer requirements CN.03 and QT.02; governance deepening, lane DIR-1).
-- A steering meeting (`steering_meeting`) is held on a day by a unit and has minutes (a version of a file of the tenant). It gives directives (`directive`): each says in words what the leadership orders, whether it
-- is about a project or about a unit, who must do it (a unit, and a person where one is named), by when, and how it stands (OPEN, IN_PROGRESS, DONE or CANCELLED; OVERDUE is not stored: an open directive past its
-- due day is overdue by the clock of the day, so that it is always right and no job keeps it right). A directive is closed with evidence by someone other than the person who recorded it and the person it was
-- given to (maker is not checker). What happens to a directive is `directive_event`, which is append-only: the first writing, a new assignee, a note of progress, a request to move the due day and its decision, the
-- closing, the cancelling and the reopening. An extension (`directive_extension`) is asked for with a reason and decided by someone other than who asked.

CREATE TABLE machvon.steering_meeting (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code = btrim(code) AND char_length(code) BETWEEN 3 AND 40),
  meeting_year smallint NOT NULL CHECK (meeting_year BETWEEN 2000 AND 2200),
  seq integer NOT NULL CHECK (seq >= 1),
  meeting_date date NOT NULL,
  meeting_type text NOT NULL CHECK (meeting_type IN ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'EXTRAORDINARY', 'SITE_VISIT', 'OTHER')),
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 300),
  summary text CHECK (summary IS NULL OR (summary = btrim(summary) AND char_length(summary) BETWEEN 1 AND 4000)),
  unit_id uuid NOT NULL,
  minutes_document_version_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT steering_meeting_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT steering_meeting_seq_uq UNIQUE (tenant_id, meeting_year, seq),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, minutes_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX steering_meeting_date_idx ON machvon.steering_meeting (tenant_id, meeting_date DESC, id);
CREATE INDEX steering_meeting_unit_idx ON machvon.steering_meeting (tenant_id, unit_id);

CREATE TABLE machvon.directive (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  code text NOT NULL CHECK (code = btrim(code) AND char_length(code) BETWEEN 3 AND 60),
  scope_kind text NOT NULL CHECK (scope_kind IN ('PROJECT', 'UNIT')),
  project_id uuid,
  -- The unit the directive is about: the owner unit of the project (as it was when the directive was given) or the unit itself.
  scope_unit_id uuid NOT NULL,
  directive_text text NOT NULL CHECK (directive_text = btrim(directive_text) AND char_length(directive_text) BETWEEN 1 AND 2000),
  assignee_unit_id uuid NOT NULL,
  assignee_membership_id uuid,
  original_due_on date NOT NULL,
  due_on date NOT NULL,
  extension_count smallint NOT NULL DEFAULT 0 CHECK (extension_count >= 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  -- Who ended the directive and when: the closing (DONE) or the cancelling (CANCELLED).
  closed_by uuid,
  closed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT directive_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT directive_seq_uq UNIQUE (tenant_id, meeting_id, seq),
  FOREIGN KEY (tenant_id, meeting_id) REFERENCES machvon.steering_meeting (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT directive_scope_chk CHECK ((scope_kind = 'PROJECT' AND project_id IS NOT NULL) OR (scope_kind = 'UNIT' AND project_id IS NULL)),
  CONSTRAINT directive_due_chk CHECK (due_on >= original_due_on),
  -- An ended directive says who ended it and when; a live one says neither.
  CONSTRAINT directive_ended_chk CHECK ((status IN ('DONE', 'CANCELLED')) = (closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  -- Maker is not checker: a directive that is done was closed by someone other than who recorded it and than who must do it.
  CONSTRAINT directive_closer_chk CHECK (status <> 'DONE' OR (closed_by <> created_by AND closed_by IS DISTINCT FROM assignee_membership_id))
);

CREATE INDEX directive_due_idx ON machvon.directive (tenant_id, due_on, id) WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX directive_meeting_idx ON machvon.directive (tenant_id, meeting_id, seq);
CREATE INDEX directive_project_idx ON machvon.directive (tenant_id, project_id, due_on) WHERE project_id IS NOT NULL;
CREATE INDEX directive_assignee_unit_idx ON machvon.directive (tenant_id, assignee_unit_id, status);
CREATE INDEX directive_assignee_member_idx ON machvon.directive (tenant_id, assignee_membership_id) WHERE assignee_membership_id IS NOT NULL;

-- A request to move the due day: one open request for a directive at a time, decided by someone other than who asked.
CREATE TABLE machvon.directive_extension (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  directive_id uuid NOT NULL,
  from_due_on date NOT NULL,
  proposed_due_on date NOT NULL,
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 1 AND 2000)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, directive_id) REFERENCES machvon.directive (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT directive_extension_days_chk CHECK (proposed_due_on > from_due_on),
  CONSTRAINT directive_extension_decision_chk CHECK (
    (status = 'REQUESTED' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
  ),
  CONSTRAINT directive_extension_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

CREATE UNIQUE INDEX directive_extension_open_uq ON machvon.directive_extension (tenant_id, directive_id) WHERE status = 'REQUESTED';
CREATE INDEX directive_extension_directive_idx ON machvon.directive_extension (tenant_id, directive_id, requested_at);

-- What happens to a directive, in the order it happens; never changed and never removed.
CREATE TABLE machvon.directive_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  directive_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('CREATED', 'ASSIGNED', 'PROGRESS', 'EXTENSION_REQUESTED', 'EXTENSION_APPROVED', 'EXTENSION_REJECTED', 'CLOSED', 'CANCELLED', 'REOPENED')),
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR (note = btrim(note) AND char_length(note) BETWEEN 1 AND 2000)),
  progress_pct smallint CHECK (progress_pct IS NULL OR progress_pct BETWEEN 0 AND 100),
  from_assignee_unit_id uuid,
  to_assignee_unit_id uuid,
  from_assignee_membership_id uuid,
  to_assignee_membership_id uuid,
  from_due_on date,
  to_due_on date,
  extension_id uuid,
  -- The person who decided the extension (the actor of the decision event).
  approver_id uuid,
  directive_version bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, directive_id) REFERENCES machvon.directive (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, extension_id) REFERENCES machvon.directive_extension (tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, from_assignee_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, to_assignee_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  -- Each kind of event says what it needs: a note of progress has words, a new assignee names the unit, an extension names its request and the days, and a closing, cancelling or reopening gives its reason.
  CONSTRAINT directive_event_shape_chk CHECK (
    (event_type = 'CREATED' AND to_assignee_unit_id IS NOT NULL AND to_due_on IS NOT NULL)
    OR (event_type = 'ASSIGNED' AND to_assignee_unit_id IS NOT NULL)
    OR (event_type = 'PROGRESS' AND note IS NOT NULL)
    OR (event_type = 'EXTENSION_REQUESTED' AND extension_id IS NOT NULL AND from_due_on IS NOT NULL AND to_due_on IS NOT NULL AND note IS NOT NULL)
    OR (event_type = 'EXTENSION_APPROVED' AND extension_id IS NOT NULL AND from_due_on IS NOT NULL AND to_due_on IS NOT NULL AND approver_id IS NOT NULL AND note IS NOT NULL)
    OR (event_type = 'EXTENSION_REJECTED' AND extension_id IS NOT NULL AND approver_id IS NOT NULL AND note IS NOT NULL)
    OR (event_type IN ('CLOSED', 'CANCELLED', 'REOPENED') AND note IS NOT NULL)
  )
);

CREATE INDEX directive_event_directive_idx ON machvon.directive_event (tenant_id, directive_id, occurred_at, id);

-- The documents that show a directive was done (or how far it is): one row for each document of a directive, added with the event that brought it.
CREATE TABLE machvon.directive_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  directive_id uuid NOT NULL,
  event_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT directive_evidence_document_uq UNIQUE (tenant_id, directive_id, document_version_id),
  FOREIGN KEY (tenant_id, directive_id) REFERENCES machvon.directive (tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES machvon.directive_event (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  FOREIGN KEY (tenant_id, added_by) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX directive_evidence_directive_idx ON machvon.directive_evidence (tenant_id, directive_id, added_at);

-- What a directive is about and who recorded it never change; the rest moves only through the commands (which also move the version).
CREATE FUNCTION machvon.guard_directive() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.meeting_id, NEW.seq, NEW.code, NEW.scope_kind, NEW.project_id, NEW.scope_unit_id, NEW.directive_text, NEW.original_due_on, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.meeting_id, OLD.seq, OLD.code, OLD.scope_kind, OLD.project_id, OLD.scope_unit_id, OLD.directive_text, OLD.original_due_on, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a directive is about and who recorded it never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'a change of a directive moves its version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER directive_guard BEFORE UPDATE ON machvon.directive
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_directive();

-- The timeline and the evidence are never edited or removed, by the application or by anyone with a statement.
CREATE FUNCTION machvon.forbid_directive_history_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of a directive is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER directive_event_immutable BEFORE UPDATE OR DELETE ON machvon.directive_event
  FOR EACH ROW EXECUTE FUNCTION machvon.forbid_directive_history_change();
CREATE TRIGGER directive_event_no_truncate BEFORE TRUNCATE ON machvon.directive_event
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_directive_history_change();
CREATE TRIGGER directive_evidence_immutable BEFORE UPDATE OR DELETE ON machvon.directive_evidence
  FOR EACH ROW EXECUTE FUNCTION machvon.forbid_directive_history_change();
CREATE TRIGGER directive_evidence_no_truncate BEFORE TRUNCATE ON machvon.directive_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.forbid_directive_history_change();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.directive_event FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.directive_evidence FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.directive FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.directive_extension FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.steering_meeting FROM machvon_app;

DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['steering_meeting', 'directive', 'directive_extension', 'directive_event', 'directive_evidence'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END
$rls$;

COMMENT ON TABLE machvon.steering_meeting IS 'An investment steering meeting (giao ban): the day, the type, the convening unit and the minutes; the directives it gave belong to it.';
COMMENT ON TABLE machvon.directive IS 'A directive of a steering meeting: what is ordered, about a project or a unit, who must do it and by when; OVERDUE is not stored, it is the clock of the day.';
COMMENT ON TABLE machvon.directive_extension IS 'A request to move the due day of a directive, with a reason, decided by someone other than who asked.';
COMMENT ON TABLE machvon.directive_event IS 'Append-only timeline of a directive: created, assigned, progress, extension asked and decided, closed, cancelled, reopened.';
COMMENT ON TABLE machvon.directive_evidence IS 'Append-only evidence documents of a directive; closing needs at least one where the policy says so.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX directive_scope_unit_idx ON machvon.directive (tenant_id, scope_unit_id);
CREATE INDEX directive_event_actor_idx ON machvon.directive_event (tenant_id, actor_id);
CREATE INDEX directive_event_approver_idx ON machvon.directive_event (tenant_id, approver_id) WHERE approver_id IS NOT NULL;
CREATE INDEX directive_event_extension_idx ON machvon.directive_event (tenant_id, extension_id) WHERE extension_id IS NOT NULL;
CREATE INDEX directive_event_from_assignee_membership_idx ON machvon.directive_event (tenant_id, from_assignee_membership_id) WHERE from_assignee_membership_id IS NOT NULL;
CREATE INDEX directive_event_from_assignee_unit_idx ON machvon.directive_event (tenant_id, from_assignee_unit_id) WHERE from_assignee_unit_id IS NOT NULL;
CREATE INDEX directive_event_to_assignee_membership_idx ON machvon.directive_event (tenant_id, to_assignee_membership_id) WHERE to_assignee_membership_id IS NOT NULL;
CREATE INDEX directive_event_to_assignee_unit_idx ON machvon.directive_event (tenant_id, to_assignee_unit_id) WHERE to_assignee_unit_id IS NOT NULL;
CREATE INDEX directive_evidence_document_version_idx ON machvon.directive_evidence (tenant_id, document_version_id);
CREATE INDEX directive_evidence_event_idx ON machvon.directive_evidence (tenant_id, event_id);
CREATE INDEX steering_meeting_minutes_document_version_idx ON machvon.steering_meeting (tenant_id, minutes_document_version_id) WHERE minutes_document_version_id IS NOT NULL;
