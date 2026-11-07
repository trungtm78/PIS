-- Authored by hand (not generated): the item of difference of the daily reconciliation (G4-4): a line whose difference is strictly above the threshold opens an item for one project, one fund and one business day, with an owner and a
-- day it is due counted in working days. The two figures the item was opened with never change (the generated difference stays what it was); `latest_difference_vnd` follows later passes. An item whose difference is gone when a later
-- pass of the day runs is AUTO_CLEARED with the pass that proves it (`cleared_run_id`); otherwise a person explains it, resolves it, or writes it off with the document that approves it. The write-off is for someone who is neither the
-- owner nor the person who explained it nor the one who opened it: maker is not checker. One live item for one project, fund and day at a time.

CREATE TABLE machvon.treasury_daily_recon_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  fund_key text NOT NULL CHECK (fund_key = btrim(fund_key) AND char_length(fund_key) BETWEEN 1 AND 100),
  fund_label text,
  recon_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('UNMATCHED', 'MISSING_ON_TREASURY', 'MISSING_INTERNAL', 'AMOUNT')),
  books_vnd numeric(24,0) NOT NULL,
  treasury_vnd numeric(24,0) NOT NULL,
  difference_vnd numeric(24,0) GENERATED ALWAYS AS (treasury_vnd - books_vnd) STORED,
  latest_difference_vnd numeric(24,0) NOT NULL,
  owner_membership_id uuid NOT NULL,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'EXPLAINED', 'RESOLVED', 'WRITTEN_OFF_APPROVED', 'AUTO_CLEARED')),
  opened_run_id uuid NOT NULL,
  last_run_id uuid NOT NULL,
  cleared_run_id uuid,
  explained_by uuid,
  explained_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR (resolution_note = btrim(resolution_note) AND char_length(resolution_note) BETWEEN 1 AND 2000)),
  resolved_by uuid,
  resolved_at timestamptz,
  approval_document_version_id uuid,
  overdue_flagged_at timestamptz,
  issue_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, opened_run_id) REFERENCES machvon.treasury_daily_recon_run (tenant_id, id),
  FOREIGN KEY (tenant_id, last_run_id) REFERENCES machvon.treasury_daily_recon_run (tenant_id, id),
  FOREIGN KEY (tenant_id, cleared_run_id) REFERENCES machvon.treasury_daily_recon_run (tenant_id, id),
  FOREIGN KEY (tenant_id, explained_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES machvon.membership (tenant_id, id),
  -- No foreign key on the author: the hourly job writes as the worker, who is not a member of any tenant (like computed_by of the early-warning score).
  CONSTRAINT treasury_daily_recon_item_ended_chk CHECK (
    (status IN ('RESOLVED', 'WRITTEN_OFF_APPROVED')) = (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL)
  ),
  CONSTRAINT treasury_daily_recon_item_cleared_chk CHECK ((status = 'AUTO_CLEARED') = (cleared_run_id IS NOT NULL)),
  CONSTRAINT treasury_daily_recon_item_explained_chk CHECK (status <> 'EXPLAINED' OR (explained_by IS NOT NULL AND resolution_note IS NOT NULL)),
  CONSTRAINT treasury_daily_recon_item_write_off_chk CHECK (
    status <> 'WRITTEN_OFF_APPROVED'
    OR (approval_document_version_id IS NOT NULL AND resolved_by <> owner_membership_id AND resolved_by IS DISTINCT FROM explained_by AND resolved_by <> created_by)
  )
);

-- One item of one project, fund and day while it waits (an item that ended makes room for a new one if the difference comes back).
CREATE UNIQUE INDEX treasury_daily_recon_item_live_uq ON machvon.treasury_daily_recon_item (tenant_id, project_id, fund_key, recon_date) WHERE status IN ('OPEN', 'EXPLAINED');
CREATE INDEX treasury_daily_recon_item_list_idx ON machvon.treasury_daily_recon_item (tenant_id, status, due_on, id);
CREATE INDEX treasury_daily_recon_item_owner_idx ON machvon.treasury_daily_recon_item (tenant_id, owner_membership_id, status, due_on);
CREATE INDEX treasury_daily_recon_item_project_idx ON machvon.treasury_daily_recon_item (tenant_id, project_id, recon_date DESC);

ALTER TABLE machvon.treasury_daily_recon_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.treasury_daily_recon_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.treasury_daily_recon_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.treasury_daily_recon_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Kept for good: an item is never deleted.
REVOKE DELETE, TRUNCATE ON TABLE machvon.treasury_daily_recon_item FROM machvon_app;

-- The guard. What an item was opened with never changes; the moves are the ones of its life. (`difference_vnd` is generated from the two figures, which are protected; a BEFORE trigger sees it before it is computed, so it is left out of the comparison.)
CREATE FUNCTION machvon.guard_treasury_daily_recon_item() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_mutable constant text[] := ARRAY['difference_vnd', 'latest_difference_vnd', 'owner_membership_id', 'due_on', 'status', 'last_run_id', 'cleared_run_id', 'explained_by', 'explained_at', 'resolution_note', 'resolved_by', 'resolved_at', 'approval_document_version_id', 'overdue_flagged_at', 'issue_id', 'updated_by', 'updated_at', 'version'];
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'reconciliation items of the day are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'the figures and the identity of a daily reconciliation item never change (UPDATE on %.% by %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'OPEN' AND NEW.status IN ('EXPLAINED', 'RESOLVED', 'WRITTEN_OFF_APPROVED', 'AUTO_CLEARED'))
    OR (OLD.status = 'EXPLAINED' AND NEW.status IN ('RESOLVED', 'WRITTEN_OFF_APPROVED', 'AUTO_CLEARED'))
  ) THEN
    RAISE EXCEPTION 'RECONCILIATION_STATE_INVALID: an item cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER treasury_daily_recon_item_guard BEFORE UPDATE OR DELETE ON machvon.treasury_daily_recon_item
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_treasury_daily_recon_item();

COMMENT ON TABLE machvon.treasury_daily_recon_item IS 'Items of difference of the daily reconciliation (G4-4): one project, one fund, one day, with an owner and a due day; figures never change; write-off needs a checker who is not the owner, the explainer or the opener.';
