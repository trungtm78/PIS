-- Authored by hand (not generated): the adjustment in the next period (ENT-3c, requirement TH.01). A figure of a period the receiver already accepted can be put right in two ways: the period is reopened and the revision
-- replaces it (`hpm_correction`, ENT-2), or the difference is booked in the NEXT period and the accepted period stays as it was. This is the second way.
--   * `hpm_adjustment`: one signed amount for a subject (an indicator or a project code) of an accepted period, to be carried into the next period of the same layout. Proposed by one person, decided by another (the
--     table says so), applied once by the push of the target period (the package carries it).
--   * `hpm_adjustment_entry`: the journal of the adjustment, append-only: every move with its actor, time and reason. The journal and the row cannot disagree because the store writes both in one transaction.

CREATE TABLE machvon.hpm_adjustment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  layout_code text NOT NULL,
  source_period text NOT NULL,
  source_revision integer NOT NULL,
  target_period text NOT NULL,
  subject_code text NOT NULL,
  amount_vnd numeric(24, 0) NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'PROPOSED',
  proposed_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  applied_push_id uuid,
  applied_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hpm_adjustment_layout_chk CHECK (layout_code ~ '^[A-Z][A-Z0-9_-]{1,59}$'),
  CONSTRAINT hpm_adjustment_source_chk CHECK (source_period ~ '^\d{4}(-(M(0[1-9]|1[0-2])|Q[1-4]|H[12]|(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])))?$'),
  CONSTRAINT hpm_adjustment_target_chk CHECK (target_period ~ '^\d{4}(-(M(0[1-9]|1[0-2])|Q[1-4]|H[12]|(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])))?$' AND target_period > source_period),
  CONSTRAINT hpm_adjustment_revision_chk CHECK (source_revision BETWEEN 1 AND 10000),
  CONSTRAINT hpm_adjustment_subject_chk CHECK (subject_code = btrim(subject_code) AND subject_code ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
  CONSTRAINT hpm_adjustment_amount_chk CHECK (amount_vnd <> 0),
  CONSTRAINT hpm_adjustment_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000),
  CONSTRAINT hpm_adjustment_state_chk CHECK (state IN ('PROPOSED', 'APPROVED', 'REJECTED', 'APPLIED')),
  CONSTRAINT hpm_adjustment_decision_chk CHECK (
    (state = 'PROPOSED') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    AND (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 10 AND 2000))
  ),
  CONSTRAINT hpm_adjustment_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT hpm_adjustment_applied_chk CHECK ((state = 'APPLIED') = (applied_push_id IS NOT NULL AND applied_at IS NOT NULL)),
  CONSTRAINT hpm_adjustment_version_chk CHECK (version >= 1)
);

-- One open adjustment for a subject of a period (a second waits for the first to be decided or applied).
CREATE UNIQUE INDEX hpm_adjustment_open_uq ON machvon.hpm_adjustment (tenant_id, layout_code, source_period, subject_code) WHERE state IN ('PROPOSED', 'APPROVED');
CREATE INDEX hpm_adjustment_target_idx ON machvon.hpm_adjustment (tenant_id, layout_code, target_period, state);
CREATE INDEX hpm_adjustment_push_idx ON machvon.hpm_adjustment (tenant_id, applied_push_id) WHERE applied_push_id IS NOT NULL;
CREATE INDEX hpm_adjustment_actor_idx ON machvon.hpm_adjustment (tenant_id, proposed_by, created_at DESC);

CREATE FUNCTION machvon.guard_hpm_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.layout_code IS DISTINCT FROM OLD.layout_code OR NEW.source_period IS DISTINCT FROM OLD.source_period OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.target_period IS DISTINCT FROM OLD.target_period OR NEW.subject_code IS DISTINCT FROM OLD.subject_code OR NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an adjustment keeps what was proposed' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('REJECTED', 'APPLIED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'an adjustment that was rejected or applied is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state = 'PROPOSED' AND NEW.state IN ('APPROVED', 'REJECTED')) OR (OLD.state = 'APPROVED' AND NEW.state = 'APPLIED')) THEN
    RAISE EXCEPTION 'an adjustment does not move from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hpm_adjustment_guard BEFORE UPDATE ON machvon.hpm_adjustment FOR EACH ROW EXECUTE FUNCTION machvon.guard_hpm_adjustment();

CREATE TABLE machvon.hpm_adjustment_entry (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  adjustment_id uuid NOT NULL,
  kind text NOT NULL,
  actor_id uuid NOT NULL,
  reason text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, adjustment_id) REFERENCES machvon.hpm_adjustment (tenant_id, id),
  CONSTRAINT hpm_adjustment_entry_kind_chk CHECK (kind IN ('PROPOSED', 'APPROVED', 'REJECTED', 'APPLIED')),
  CONSTRAINT hpm_adjustment_entry_uq UNIQUE (tenant_id, adjustment_id, kind)
);
CREATE INDEX hpm_adjustment_entry_actor_idx ON machvon.hpm_adjustment_entry (tenant_id, actor_id, at DESC);

CREATE FUNCTION machvon.hpm_adjustment_entry_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the journal of an adjustment is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER hpm_adjustment_entry_append_only BEFORE UPDATE OR DELETE ON machvon.hpm_adjustment_entry FOR EACH ROW EXECUTE FUNCTION machvon.hpm_adjustment_entry_append_only();

ALTER TABLE machvon.hpm_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hpm_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hpm_adjustment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hpm_adjustment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.hpm_adjustment_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hpm_adjustment_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hpm_adjustment_entry AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hpm_adjustment_entry AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.hpm_adjustment FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.hpm_adjustment_entry FROM machvon_app;

COMMENT ON TABLE machvon.hpm_adjustment IS 'ENT-3c (TH.01): a signed difference of an accepted period booked in the next period instead of overwriting; proposed by one person, decided by another, applied once by the push of the target period.';
COMMENT ON TABLE machvon.hpm_adjustment_entry IS 'ENT-3c: the journal of an adjustment, append-only.';
