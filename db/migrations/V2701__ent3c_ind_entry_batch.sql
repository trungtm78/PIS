-- Authored by hand (not generated): the batch of indicator entries that goes through the staged approval (ENT-3c, QT.01). Until now a person's entry was written to `ind_figure` at once. A tenant that approves the staged rule
-- for IND_ENTRY_ACCEPT hands the entry in as a batch instead: the figures are judged and kept here with the warnings the entry rules gave (they do not block, BBH 43), the batch goes through the steps, and only the last
-- approval writes the figures to the register (append-only, as an entry does). A return keeps the warnings so that both the person who entered and the approver see them.

CREATE TABLE machvon.ind_entry_batch (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  period_id uuid NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL DEFAULT 'SUBMITTED',
  figures jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  figure_count integer NOT NULL,
  entered_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  written_count integer,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES machvon.reporting_period (tenant_id, id),
  CONSTRAINT ind_entry_batch_revision_uq UNIQUE (tenant_id, project_id, period_id, revision),
  CONSTRAINT ind_entry_batch_revision_chk CHECK (revision >= 1),
  CONSTRAINT ind_entry_batch_status_chk CHECK (status IN ('SUBMITTED', 'ACCEPTED', 'RETURNED', 'WITHDRAWN')),
  CONSTRAINT ind_entry_batch_figures_chk CHECK (jsonb_typeof(figures) = 'array' AND jsonb_array_length(figures) BETWEEN 1 AND 200 AND figure_count = jsonb_array_length(figures)),
  CONSTRAINT ind_entry_batch_warnings_chk CHECK (jsonb_typeof(warnings) = 'array'),
  CONSTRAINT ind_entry_batch_decision_chk CHECK (
    (status IN ('ACCEPTED', 'RETURNED')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)
    AND (status <> 'RETURNED' OR (decision_reason IS NOT NULL AND char_length(decision_reason) >= 10))
    AND (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) <= 2000))
  ),
  CONSTRAINT ind_entry_batch_written_chk CHECK ((status = 'ACCEPTED') = (written_count IS NOT NULL)),
  CONSTRAINT ind_entry_batch_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> entered_by),
  CONSTRAINT ind_entry_batch_version_chk CHECK (version >= 1)
);

-- One batch waits for a decision for a project and a period: the next one is handed in after this one is decided or taken back.
CREATE UNIQUE INDEX ind_entry_batch_open_uq ON machvon.ind_entry_batch (tenant_id, project_id, period_id) WHERE status = 'SUBMITTED';
CREATE INDEX ind_entry_batch_period_idx ON machvon.ind_entry_batch (tenant_id, period_id, status);
CREATE INDEX ind_entry_batch_project_idx ON machvon.ind_entry_batch (tenant_id, project_id, submitted_at DESC);
CREATE INDEX ind_entry_batch_actor_idx ON machvon.ind_entry_batch (tenant_id, entered_by, submitted_at DESC);

-- What was handed in is never edited; the batch only moves from SUBMITTED to a decision.
CREATE FUNCTION machvon.guard_ind_entry_batch() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.period_id IS DISTINCT FROM OLD.period_id OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.figures IS DISTINCT FROM OLD.figures
     OR NEW.warnings IS DISTINCT FROM OLD.warnings OR NEW.figure_count IS DISTINCT FROM OLD.figure_count OR NEW.entered_by IS DISTINCT FROM OLD.entered_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a batch of entries keeps what was handed in' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'SUBMITTED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a batch that was decided is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'SUBMITTED' AND NEW.status IN ('ACCEPTED', 'RETURNED', 'WITHDRAWN')) THEN
    RAISE EXCEPTION 'a batch does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ind_entry_batch_guard BEFORE UPDATE ON machvon.ind_entry_batch FOR EACH ROW EXECUTE FUNCTION machvon.guard_ind_entry_batch();

ALTER TABLE machvon.ind_entry_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ind_entry_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ind_entry_batch AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ind_entry_batch AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.ind_entry_batch FROM machvon_app;

COMMENT ON TABLE machvon.ind_entry_batch IS 'ENT-3c: a batch of indicator entries handed in for the staged approval; the figures are written to ind_figure only by the last approval; the warnings of the entry rules stay with the batch.';
