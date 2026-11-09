-- Authored by hand (not generated): the manual backup request of INFRA-2 (HSKT YCK.06). A manual backup is asked for by one person and approved by another (maker-checker); the host runner of the installation runs it with
-- pgBackRest and the outcome (the backup label, or the failure) is recorded here. The API never runs a backup. The table is the ledger of who asked for which backup, why, who allowed it and what came of it.

CREATE TABLE machvon.backup_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- pgBackRest --type: full, diff (differential) or incr (incremental); the archive repository (2) takes full backups only.
  kind text NOT NULL,
  repository smallint NOT NULL DEFAULT 1,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'Requested',
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  -- The outcome, recorded after the runner ran the backup.
  recorded_by uuid,
  finished_at timestamptz,
  backup_label text,
  outcome_note text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT backup_request_kind_chk CHECK (kind IN ('full', 'diff', 'incr')),
  CONSTRAINT backup_request_repository_chk CHECK (repository IN (1, 2) AND (repository = 1 OR kind = 'full')),
  CONSTRAINT backup_request_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT backup_request_status_chk CHECK (status IN ('Requested', 'Approved', 'Rejected', 'Cancelled', 'Completed', 'Failed')),
  CONSTRAINT backup_request_four_eyes_chk CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT backup_request_decision_chk CHECK (
    CASE status
      WHEN 'Requested' THEN decided_by IS NULL AND decided_at IS NULL AND recorded_by IS NULL
      WHEN 'Cancelled' THEN decided_at IS NOT NULL AND recorded_by IS NULL
      WHEN 'Rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND recorded_by IS NULL
      WHEN 'Approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND recorded_by IS NULL
      WHEN 'Completed' THEN decided_by IS NOT NULL AND recorded_by IS NOT NULL AND finished_at IS NOT NULL AND backup_label IS NOT NULL AND char_length(btrim(backup_label)) BETWEEN 1 AND 200
      ELSE decided_by IS NOT NULL AND recorded_by IS NOT NULL AND finished_at IS NOT NULL AND outcome_note IS NOT NULL AND char_length(btrim(outcome_note)) >= 5
    END
  )
);

CREATE INDEX backup_request_requested_by_idx ON machvon.backup_request (tenant_id, requested_by);
CREATE INDEX backup_request_decided_by_idx ON machvon.backup_request (tenant_id, decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX backup_request_recorded_by_idx ON machvon.backup_request (tenant_id, recorded_by) WHERE recorded_by IS NOT NULL;
CREATE INDEX backup_request_listing_idx ON machvon.backup_request (tenant_id, requested_at DESC, id DESC);
-- One open request for each kind and repository: a second one is refused until the first is decided or recorded.
CREATE UNIQUE INDEX backup_request_open_uq ON machvon.backup_request (tenant_id, kind, repository) WHERE status IN ('Requested', 'Approved');

ALTER TABLE machvon.backup_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.backup_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.backup_request AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.backup_request AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.backup_request FROM machvon_app;

-- What was asked never changes, and the state moves forward only: Requested to Approved, Rejected or Cancelled; Approved to Completed or Failed; everything else is final.
CREATE FUNCTION machvon.guard_backup_request() RETURNS trigger
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
    RAISE EXCEPTION 'a backup request is never deleted (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.kind, NEW.repository, NEW.reason, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.kind, OLD.repository, OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'what a backup request asks never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT ((OLD.status = 'Requested' AND NEW.status IN ('Approved', 'Rejected', 'Cancelled')) OR (OLD.status = 'Approved' AND NEW.status IN ('Completed', 'Failed'))) THEN
    RAISE EXCEPTION 'a backup request does not go from % to %', OLD.status, NEW.status USING ERRCODE = '42501', DETAIL = 'STAGE_TRANSITION_DENIED';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER backup_request_guard BEFORE UPDATE OR DELETE ON machvon.backup_request
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_backup_request();
