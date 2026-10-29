-- ST-SAS-016 (SAS.md 3.2 and 3.10, BR-SAS-03): offboarding of a tenant and the export of its data.
--   * the tenant remembers when its contract ends and until when it may export (the window starts at the later of the end of the contract and the start of offboarding);
--   * an export job keeps what the owner asked for, when its snapshot was taken, which files it holds and which of them were downloaded: it is Delivered when all were;
--   * what was asked for and what was made never change, a job moves only forward, nothing deletes one (a Delivered export is what lets a tenant be archived);
--   * the control plane reads the jobs of the tenant it acts as, and asks whether one was delivered and whether a legal hold is active, which the purge honours.

ALTER TABLE machvon.tenant ADD COLUMN contract_end_date date;
ALTER TABLE machvon.tenant ADD COLUMN export_window_days integer CHECK (export_window_days IS NULL OR export_window_days BETWEEN 30 AND 180);
ALTER TABLE machvon.tenant ADD COLUMN export_window_ends_at timestamptz;

ALTER TABLE machvon.tenant_export_job ADD COLUMN reason text NOT NULL DEFAULT '';
ALTER TABLE machvon.tenant_export_job ADD COLUMN requested_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE machvon.tenant_export_job ADD COLUMN snapshot_at timestamptz;
-- The state of the tenant as the snapshot saw it: an export made while the offboarding was not yet committed saw it Active, however late its clock says it was.
ALTER TABLE machvon.tenant_export_job ADD COLUMN snapshot_tenant_status text;
ALTER TABLE machvon.tenant_export_job ADD COLUMN ready_at timestamptz;
ALTER TABLE machvon.tenant_export_job ADD COLUMN delivered_at timestamptz;
ALTER TABLE machvon.tenant_export_job ADD COLUMN error_code text;
ALTER TABLE machvon.tenant_export_job ADD COLUMN files_downloaded text[] NOT NULL DEFAULT '{}';
ALTER TABLE machvon.tenant_export_job ADD CONSTRAINT tenant_export_job_delivered_ck CHECK ((status = 'Delivered') = (delivered_at IS NOT NULL));
ALTER TABLE machvon.tenant_export_job ADD CONSTRAINT tenant_export_job_ready_ck CHECK (status NOT IN ('Ready', 'Delivered') OR (ready_at IS NOT NULL AND snapshot_at IS NOT NULL AND expires_at IS NOT NULL AND manifest_storage_key IS NOT NULL));

-- One export at a time for a tenant: a second request while one waits or runs is 409 EXPORT_ALREADY_RUNNING.
CREATE UNIQUE INDEX tenant_export_job_active_uq ON machvon.tenant_export_job (tenant_id) WHERE status IN ('Requested', 'Running');
CREATE INDEX tenant_export_job_status_idx ON machvon.tenant_export_job (tenant_id, status, requested_at DESC);

CREATE FUNCTION machvon.guard_tenant_export_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EXPORT_IMMUTABLE: an export job is never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.scope_json <> OLD.scope_json OR NEW.format <> OLD.format OR NEW.requested_by <> OLD.requested_by
     OR NEW.reason <> OLD.reason OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'EXPORT_IMMUTABLE: what was asked for does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (('Requested', 'Running'), ('Requested', 'Failed'), ('Running', 'Ready'), ('Running', 'Failed'), ('Ready', 'Delivered'), ('Ready', 'Expired'))) THEN
    RAISE EXCEPTION 'EXPORT_IMMUTABLE: an export job does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- What a finished export holds is fixed when it becomes Ready.
  IF OLD.status IN ('Ready', 'Delivered', 'Expired', 'Failed') AND (NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256 OR NEW.manifest_storage_key IS DISTINCT FROM OLD.manifest_storage_key
     OR NEW.file_count IS DISTINCT FROM OLD.file_count OR NEW.total_bytes IS DISTINCT FROM OLD.total_bytes OR NEW.row_counts IS DISTINCT FROM OLD.row_counts
     OR NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at OR NEW.snapshot_tenant_status IS DISTINCT FROM OLD.snapshot_tenant_status OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'EXPORT_IMMUTABLE: what the export holds does not change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_export_job_guard BEFORE UPDATE OR DELETE ON machvon.tenant_export_job FOR EACH ROW EXECUTE FUNCTION machvon.guard_tenant_export_job();
REVOKE DELETE, TRUNCATE ON TABLE machvon.tenant_export_job FROM machvon_app;

-- The control plane reads the jobs of the tenant it acts as (SAS-17 for the System Admin) and asks the two facts the archive and the purge depend on.
GRANT SELECT ON TABLE machvon.tenant_export_job TO machvon_control;

-- Whether an export was delivered whose snapshot was taken at or after `p_since` and saw the tenant Offboarding: the archive asks it with the moment offboarding started, so an export delivered while the tenant was still changing its data (or in an earlier
-- offboarding that was renewed) does not authorize archiving the data the tenant has now. Without `p_since` any delivered export counts (the screen shows it).
CREATE FUNCTION machvon.tenant_export_delivered(p_tenant uuid, p_since timestamptz) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM machvon.tenant_export_job WHERE tenant_id = p_tenant AND status = 'Delivered' AND (p_since IS NULL OR (snapshot_at >= p_since AND snapshot_tenant_status = 'Offboarding')));
$fn$;
CREATE FUNCTION machvon.tenant_legal_holds_active(p_tenant uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = machvon, pg_temp AS $fn$
  SELECT count(*)::integer FROM machvon.legal_hold WHERE tenant_id = p_tenant AND released_at IS NULL AND effective_at <= now();
$fn$;
REVOKE ALL ON FUNCTION machvon.tenant_export_delivered(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION machvon.tenant_legal_holds_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.tenant_export_delivered(uuid, timestamptz) TO machvon_control;
GRANT EXECUTE ON FUNCTION machvon.tenant_legal_holds_active(uuid) TO machvon_control;
