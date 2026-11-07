-- Authored by hand (not generated): the native clocks of the alert centre (governance deepening, lane GOV-2, roadmap G0-2). A module that has an obligation with a time limit of its own (a notice to post within so many working days,
-- a file to hand in) starts a clock here instead of keeping a private date; the clock says who answers for it, what is expected, what happens when the time runs out, and when that is, counted in working time on the published
-- calendar. The alert centre reads the running clocks as the source CLOCK. The clocks the modules already keep (the early warnings of DIS, the advances of PAY, the permits of PMT, the issues of ISS, the guarantees of CTR) are not
-- here: they are wrapped as they are (see docs/work-clocks.md).
-- A clock is never deleted: it is MET when what it waits for is done, or CANCELLED when it no longer applies, each with who and why. Pausing is a decision of `work_action` (source CLOCK), not a column here, so the history is whole.

CREATE TABLE machvon.work_clock (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  clock_type text NOT NULL CHECK (clock_type ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  subject_id text NOT NULL CHECK (subject_id = btrim(subject_id) AND char_length(subject_id) BETWEEN 1 AND 64),
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
  subtitle text CHECK (subtitle IS NULL OR (subtitle = btrim(subtitle) AND char_length(subtitle) BETWEEN 1 AND 200)),
  -- Who answers for it: a person, a unit, or both; a clock with neither is nobody's and is refused.
  owner_membership_id uuid,
  owner_unit_id uuid,
  -- The project the obligation is about, when it has one: the reader's right to read the project decides who sees the clock.
  project_id uuid,
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  expected_action text NOT NULL CHECK (expected_action = btrim(expected_action) AND char_length(expected_action) BETWEEN 5 AND 500),
  consequence text NOT NULL CHECK (consequence = btrim(consequence) AND char_length(consequence) BETWEEN 5 AND 500),
  calendar_code text NOT NULL DEFAULT 'WORKDAY_VN' CHECK (calendar_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  started_at timestamptz NOT NULL,
  -- How long it may run, in working minutes counted from `started_at`; `due_at` is the end of that count on the published calendar, and `calendar_version_ids` the versions that were read.
  working_minutes integer NOT NULL CHECK (working_minutes BETWEEN 1 AND 144000),
  due_at timestamptz NOT NULL,
  calendar_version_ids uuid[] NOT NULL DEFAULT '{}',
  policy_version text NOT NULL CHECK (policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 40),
  target_screen text NOT NULL CHECK (target_screen ~ '^[A-Z]{2,4}-[0-9]{2}$'),
  target_id text NOT NULL CHECK (target_id = btrim(target_id) AND char_length(target_id) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'MET', 'CANCELLED')),
  ended_at timestamptz,
  ended_by_membership_id uuid,
  end_reason text CHECK (end_reason IS NULL OR (end_reason = btrim(end_reason) AND char_length(end_reason) BETWEEN 1 AND 500)),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT work_clock_due_after_start_chk CHECK (due_at > started_at),
  CONSTRAINT work_clock_owner_chk CHECK (owner_membership_id IS NOT NULL OR owner_unit_id IS NOT NULL),
  CONSTRAINT work_clock_end_chk CHECK ((status = 'RUNNING' AND ended_at IS NULL AND end_reason IS NULL) OR (status <> 'RUNNING' AND ended_at IS NOT NULL AND end_reason IS NOT NULL))
);

-- One running clock for a subject and a type: a module that starts it twice (a retry, a second event) gets the same clock.
CREATE UNIQUE INDEX work_clock_running_uq ON machvon.work_clock (tenant_id, clock_type, subject_type, subject_id) WHERE status = 'RUNNING';
CREATE INDEX work_clock_due_idx ON machvon.work_clock (tenant_id, due_at, id) WHERE status = 'RUNNING';
CREATE INDEX work_clock_owner_idx ON machvon.work_clock (tenant_id, owner_membership_id, due_at) WHERE status = 'RUNNING' AND owner_membership_id IS NOT NULL;
CREATE INDEX work_clock_unit_idx ON machvon.work_clock (tenant_id, owner_unit_id, due_at) WHERE status = 'RUNNING' AND owner_unit_id IS NOT NULL;

ALTER TABLE machvon.work_clock ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.work_clock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.work_clock AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.work_clock AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- A clock is ended, not removed; what it said (the time, the action, the consequence) is never edited after it started.
REVOKE DELETE, TRUNCATE ON TABLE machvon.work_clock FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.work_clock FROM machvon_app;
GRANT UPDATE (status, ended_at, ended_by_membership_id, end_reason, version, owner_membership_id, owner_unit_id) ON TABLE machvon.work_clock TO machvon_app;

COMMENT ON TABLE machvon.work_clock IS 'Native clocks of the alert centre: an obligation with a limit in working time, its owner, the action expected and the consequence; ended as MET or CANCELLED, never deleted.';
