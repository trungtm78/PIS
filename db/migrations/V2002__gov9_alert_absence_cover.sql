-- Authored by hand (not generated): absences and the deputies who take over the alerts of the absent (governance deepening, lane GOV-9a, roadmap G2-7).
-- `alert_absence`: a person declares that they are away from a day to a day (or their leader does it for them). `alert_absence_cover`: a deputy takes over the alerts of the absent person for a period, for all sources or for some. A cover
-- is PENDING until a third person (not the one who proposed it, not the absent person, not the deputy) allows it; it routes attention only, never authority (what a deputy may decide in a module stays what the module grants them).
-- The loops, the depth, the rank of the deputy and the window are judged by the command with the pure rules of the kernel; the table keeps what cannot be wrong whatever the command does. Both tables are changed by commands under
-- If-Match versions and are never deleted: an absence is ENDED (the person is back) or CANCELLED, a cover is REJECTED or REVOKED, each with who and when.

CREATE TABLE machvon.alert_absence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('LEAVE', 'SICK', 'MISSION', 'TRAINING', 'OTHER')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)),
  status text NOT NULL DEFAULT 'DECLARED' CHECK (status IN ('DECLARED', 'ENDED', 'CANCELLED')),
  declared_by uuid NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by uuid,
  end_reason text CHECK (end_reason IS NULL OR (end_reason = btrim(end_reason) AND char_length(end_reason) BETWEEN 1 AND 500)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, declared_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT alert_absence_window_chk CHECK (valid_from < valid_until),
  CONSTRAINT alert_absence_end_chk CHECK ((status = 'DECLARED' AND ended_at IS NULL AND ended_by IS NULL) OR (status <> 'DECLARED' AND ended_at IS NOT NULL AND ended_by IS NOT NULL))
);

CREATE INDEX alert_absence_member_idx ON machvon.alert_absence (tenant_id, membership_id, valid_until DESC);
CREATE INDEX alert_absence_declared_by_idx ON machvon.alert_absence (tenant_id, declared_by);
CREATE INDEX alert_absence_ended_by_idx ON machvon.alert_absence (tenant_id, ended_by) WHERE ended_by IS NOT NULL;
CREATE INDEX alert_absence_open_idx ON machvon.alert_absence (tenant_id, valid_until) WHERE status = 'DECLARED';

CREATE TABLE machvon.alert_absence_cover (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  absence_id uuid NOT NULL,
  absent_membership_id uuid NOT NULL,
  deputy_membership_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('ALL', 'SOURCES')),
  sources text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (decision_note = btrim(decision_note) AND char_length(decision_note) BETWEEN 1 AND 500)),
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND char_length(revoke_reason) BETWEEN 1 AND 500)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, absence_id) REFERENCES machvon.alert_absence (tenant_id, id),
  FOREIGN KEY (tenant_id, absent_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, deputy_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT alert_absence_cover_people_chk CHECK (absent_membership_id <> deputy_membership_id),
  CONSTRAINT alert_absence_cover_window_chk CHECK (valid_from < valid_until),
  CONSTRAINT alert_absence_cover_scope_chk CHECK ((scope_kind = 'ALL' AND cardinality(sources) = 0) OR (scope_kind = 'SOURCES' AND cardinality(sources) BETWEEN 1 AND 40)),
  -- The person who allows or rejects is a third person: not the one who proposed it, not the absent person, not the deputy.
  CONSTRAINT alert_absence_cover_third_chk CHECK (decided_by IS NULL OR (decided_by <> requested_by AND decided_by <> absent_membership_id AND decided_by <> deputy_membership_id)),
  CONSTRAINT alert_absence_cover_state_chk CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL AND revoked_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX alert_absence_cover_absence_idx ON machvon.alert_absence_cover (tenant_id, absence_id);
CREATE INDEX alert_absence_cover_absent_idx ON machvon.alert_absence_cover (tenant_id, absent_membership_id, status, valid_until);
CREATE INDEX alert_absence_cover_deputy_idx ON machvon.alert_absence_cover (tenant_id, deputy_membership_id, status, valid_until);
CREATE INDEX alert_absence_cover_requested_idx ON machvon.alert_absence_cover (tenant_id, requested_by);
CREATE INDEX alert_absence_cover_decided_idx ON machvon.alert_absence_cover (tenant_id, decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX alert_absence_cover_revoked_idx ON machvon.alert_absence_cover (tenant_id, revoked_by) WHERE revoked_by IS NOT NULL;

ALTER TABLE machvon.alert_escalation ADD CONSTRAINT alert_escalation_cover_fk FOREIGN KEY (tenant_id, cover_id) REFERENCES machvon.alert_absence_cover (tenant_id, id);

-- The facts of an absence and of a cover never change after they are written (only the state, with its who and when, and the version); a row is never deleted.
CREATE FUNCTION machvon.guard_alert_absence() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.declared_by IS DISTINCT FROM OLD.declared_by OR NEW.declared_at IS DISTINCT FROM OLD.declared_at THEN
    RAISE EXCEPTION 'the facts of an absence never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'DECLARED' THEN
    RAISE EXCEPTION 'an absence that has ended is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'the version of an absence moves with its change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER alert_absence_guard BEFORE UPDATE ON machvon.alert_absence FOR EACH ROW EXECUTE FUNCTION machvon.guard_alert_absence();

CREATE FUNCTION machvon.guard_alert_absence_cover() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.absence_id IS DISTINCT FROM OLD.absence_id OR NEW.absent_membership_id IS DISTINCT FROM OLD.absent_membership_id
     OR NEW.deputy_membership_id IS DISTINCT FROM OLD.deputy_membership_id OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.sources IS DISTINCT FROM OLD.sources OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'the facts of a cover never change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('REJECTED', 'REVOKED') THEN
    RAISE EXCEPTION 'a cover that has ended is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'the version of a cover moves with its change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER alert_absence_cover_guard BEFORE UPDATE ON machvon.alert_absence_cover FOR EACH ROW EXECUTE FUNCTION machvon.guard_alert_absence_cover();

DO $gov9$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['alert_absence', 'alert_absence_cover'] LOOP
    EXECUTE format('ALTER TABLE machvon.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE machvon.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format($p$CREATE POLICY tenant_boundary ON machvon.%I AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, tbl);
    EXECUTE format($p$CREATE POLICY tenant_access ON machvon.%I AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, tbl);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE machvon.%I FROM machvon_app', tbl);
  END LOOP;
END
$gov9$;

COMMENT ON TABLE machvon.alert_absence IS 'A person declared away from a day to a day; ENDED when they are back, CANCELLED when it did not happen; never deleted.';
COMMENT ON TABLE machvon.alert_absence_cover IS 'A deputy takes over the alerts of an absent person for a period (all sources or some), allowed by a third person; routes attention, never authority.';
