-- Authored by hand (not generated): the period in which the staff of a unit are scored (PWF-3, docs PWF 3 F9, 4, 6, BR-PWF-36, 39, 42, R34, R43).
-- A period is DRAFT while it can be computed again, LOCKED once the snapshot is taken (the assignment intervals and shares, the policy, the calendars, the baselines and the cut-off of the events the figures were read
-- on, with the figures themselves) and the hash of that snapshot is written, and OFFICIAL when the window of response has ended or every response was handled. There is no way back: a correction is an adjustment with
-- a lineage or a period that replaces this one (`supersedes_period_id`). The table holds no score of a person; those are in `staff_score_line` (V3032), which only the person, the manager of the unit and the
-- human resources can read.

CREATE TABLE machvon.staff_score_period (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_unit_id uuid NOT NULL,
  period_kind text NOT NULL CHECK (period_kind IN ('MONTH', 'QUARTER', 'YEAR')),
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'LOCKED', 'OFFICIAL')),
  -- The STAFF_SCORING_POLICY the period was computed by: code, the rule row (null for the built-in default) and its version.
  policy_code text NOT NULL CHECK (policy_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  policy_rule_id uuid,
  policy_version integer NOT NULL CHECK (policy_version >= 0),
  -- The hash of the draft as last computed: the same inputs always give the same hash.
  preview_hash text CHECK (preview_hash IS NULL OR preview_hash ~ '^[0-9a-f]{64}$'),
  computed_at timestamptz NOT NULL DEFAULT now(),
  computed_by uuid NOT NULL,
  -- The snapshot of a locked period and its hash; the figures of the period are recomputed from the snapshot to the same hash.
  snapshot jsonb CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
  -- Counts and the mean of the period, with no name: what stays when the personal data expires (BR-PWF-42).
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  locked_by uuid,
  locked_at timestamptz,
  response_until date,
  official_at timestamptz,
  official_by uuid,
  supersedes_period_id uuid,
  -- The personal data of the period was erased or anonymised at the end of its retention (V3033).
  erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, scope_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_period_id) REFERENCES machvon.staff_score_period (tenant_id, id),
  FOREIGN KEY (tenant_id, computed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, locked_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, official_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT staff_score_period_window_chk CHECK (period_to >= period_from AND period_to - period_from < 400),
  -- A draft has no snapshot; a locked or official period has one, and says who locked it and until when people may respond.
  CONSTRAINT staff_score_period_lock_chk CHECK (
    (status = 'DRAFT') = (snapshot_hash IS NULL)
    AND (status = 'DRAFT') = (locked_at IS NULL)
    AND (locked_at IS NULL) = (locked_by IS NULL)
    AND (locked_at IS NULL) = (response_until IS NULL)
    AND (snapshot IS NULL OR snapshot_hash IS NOT NULL)
  ),
  CONSTRAINT staff_score_period_official_chk CHECK ((status = 'OFFICIAL') = (official_at IS NOT NULL) AND (official_at IS NULL) = (official_by IS NULL)),
  -- Two periods of one unit never cover the same day, unless the later one replaces the earlier (a correction of an official period).
  CONSTRAINT staff_score_period_no_overlap
    EXCLUDE USING gist (tenant_id WITH =, scope_unit_id WITH =, daterange(period_from, period_to, '[]') WITH &&) WHERE (supersedes_period_id IS NULL)
);

CREATE INDEX staff_score_period_unit_idx ON machvon.staff_score_period (tenant_id, scope_unit_id, period_from DESC);
CREATE INDEX staff_score_period_status_idx ON machvon.staff_score_period (tenant_id, status, locked_at);
CREATE INDEX staff_score_period_rule_idx ON machvon.staff_score_period (tenant_id, policy_rule_id) WHERE policy_rule_id IS NOT NULL;
CREATE INDEX staff_score_period_supersedes_idx ON machvon.staff_score_period (tenant_id, supersedes_period_id) WHERE supersedes_period_id IS NOT NULL;

ALTER TABLE machvon.staff_score_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.staff_score_period FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.staff_score_period AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.staff_score_period AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.staff_score_period FROM machvon_app;

-- A draft may be computed again; a locked period keeps its snapshot, hash, policy, window and lock for good and moves only to OFFICIAL; an official period never changes (apart from the erasure of its
-- personal data at the end of the retention, which the owner of the database does).
CREATE FUNCTION machvon.guard_staff_score_period() RETURNS trigger
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
    RAISE EXCEPTION 'a scoring period is never deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.scope_unit_id, NEW.period_kind, NEW.period_from, NEW.period_to, NEW.supersedes_period_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.scope_unit_id, OLD.period_kind, OLD.period_from, OLD.period_to, OLD.supersedes_period_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a scoring period keeps its unit, kind and days for good' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT', 'LOCKED') THEN
      RAISE EXCEPTION 'a draft period is locked before it is official' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.policy_code, NEW.policy_rule_id, NEW.policy_version, NEW.preview_hash, NEW.computed_at, NEW.computed_by, NEW.snapshot, NEW.snapshot_hash, NEW.summary, NEW.locked_by, NEW.locked_at, NEW.response_until)
     IS DISTINCT FROM
     (OLD.policy_code, OLD.policy_rule_id, OLD.policy_version, OLD.preview_hash, OLD.computed_at, OLD.computed_by, OLD.snapshot, OLD.snapshot_hash, OLD.summary, OLD.locked_by, OLD.locked_at, OLD.response_until) THEN
    RAISE EXCEPTION 'a locked scoring period keeps its snapshot, hash and policy for good' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'LOCKED' AND NEW.status = 'OFFICIAL') THEN
    RAISE EXCEPTION 'a scoring period cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'OFFICIAL' AND (NEW.official_at IS DISTINCT FROM OLD.official_at OR NEW.official_by IS DISTINCT FROM OLD.official_by) THEN
    RAISE EXCEPTION 'an official scoring period never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER staff_score_period_guard BEFORE UPDATE OR DELETE ON machvon.staff_score_period
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_staff_score_period();

COMMENT ON TABLE machvon.staff_score_period IS 'The period in which the staff of a unit are scored (PWF-3): DRAFT, LOCKED (snapshot and hash), OFFICIAL; no way back (BR-PWF-39).';
COMMENT ON COLUMN machvon.staff_score_period.snapshot IS 'PERSONAL: the assignment intervals and the figures the period was computed from; erased at the end of the retention, the hash stays.';
