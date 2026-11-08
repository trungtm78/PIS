-- Authored by hand (not generated): the differences between the feed of the Finance Department and our own figures (FEED-1, docs/finance-feed.md section 7).
-- For a project of the feed that is mapped to one of ours and a fiscal year, three figures are compared: the plan against the plan of the DIS snapshot in force, the cumulative disbursement against the DIS
-- report, and against the Treasury statements. Each figure that differs by more than the tolerance is an item with an OWNER (accountable for settling it) and the MAKERS (the people who loaded the feed's records
-- and who made our figure). The database holds the two rules the application also applies:
--   * the owner is not a maker, and the person who resolves an item is not a maker (maker is not checker, ADM-11);
--   * an item is settled once, with one of four resolutions and a reason; a settled item is final and keeps who settled it and why.
-- One OPEN item exists for a project, a year and a figure at a time (a difference met again is the same piece of work).

CREATE TABLE machvon.finance_feed_difference (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  feed_project_code text NOT NULL,
  project_id uuid,
  fiscal_year integer NOT NULL,
  field text NOT NULL,
  kind text NOT NULL,
  feed_value numeric(30, 2) NOT NULL,
  our_value numeric(30, 2),
  delta numeric(30, 2),
  delta_pct numeric(12, 2),
  large boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'OPEN',
  owner_id uuid NOT NULL,
  maker_ids uuid[] NOT NULL DEFAULT '{}',
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  resolution_kind text,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_reason text,
  evidence_ref text,
  review_on date,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT finance_feed_difference_code_chk CHECK (feed_project_code = btrim(feed_project_code) AND feed_project_code <> '' AND char_length(feed_project_code) <= 50),
  CONSTRAINT finance_feed_difference_year_chk CHECK (fiscal_year BETWEEN 2000 AND 2100),
  CONSTRAINT finance_feed_difference_field_chk CHECK (field IN ('PLAN_VS_DIS', 'DISBURSED_VS_DIS', 'DISBURSED_VS_TREASURY')),
  CONSTRAINT finance_feed_difference_kind_chk CHECK (kind IN ('VALUE_MISMATCH', 'MISSING_OURS') AND ((kind = 'MISSING_OURS') = (our_value IS NULL))),
  CONSTRAINT finance_feed_difference_state_chk CHECK (state IN ('OPEN', 'RESOLVED')),
  CONSTRAINT finance_feed_difference_due_chk CHECK (due_at > opened_at),
  -- Maker is not checker: the owner and the person who resolves are never among the makers.
  CONSTRAINT finance_feed_difference_owner_chk CHECK (NOT (owner_id = ANY (maker_ids))),
  CONSTRAINT finance_feed_difference_resolver_chk CHECK (resolved_by IS NULL OR NOT (resolved_by = ANY (maker_ids))),
  CONSTRAINT finance_feed_difference_resolution_chk CHECK (
    (state = 'OPEN' AND resolution_kind IS NULL AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL AND evidence_ref IS NULL AND review_on IS NULL)
    OR (state = 'RESOLVED' AND resolution_kind IN ('ACCEPT_FEED', 'KEEP_OURS', 'DISPUTE', 'WAIVE') AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
        AND char_length(btrim(resolution_reason)) >= CASE WHEN resolution_kind IN ('DISPUTE', 'WAIVE') THEN 20 ELSE 10 END
        AND (resolution_kind <> 'DISPUTE' OR evidence_ref IS NOT NULL)
        AND ((resolution_kind = 'WAIVE') = (review_on IS NOT NULL)))
  ),
  CONSTRAINT finance_feed_difference_version_chk CHECK (version >= 1)
);
CREATE UNIQUE INDEX finance_feed_difference_open_uq ON machvon.finance_feed_difference (tenant_id, feed_project_code, fiscal_year, field) WHERE state = 'OPEN';
CREATE INDEX finance_feed_difference_list_idx ON machvon.finance_feed_difference (tenant_id, state, opened_at DESC, id DESC);
CREATE INDEX finance_feed_difference_project_idx ON machvon.finance_feed_difference (tenant_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX finance_feed_difference_owner_idx ON machvon.finance_feed_difference (tenant_id, owner_id, state);

CREATE FUNCTION machvon.guard_finance_feed_difference() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a difference of the finance feed is kept' USING ERRCODE = '23514';
  END IF;
  IF NEW.feed_project_code IS DISTINCT FROM OLD.feed_project_code OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year OR NEW.field IS DISTINCT FROM OLD.field
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.feed_value IS DISTINCT FROM OLD.feed_value OR NEW.our_value IS DISTINCT FROM OLD.our_value OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.maker_ids IS DISTINCT FROM OLD.maker_ids OR NEW.opened_by IS DISTINCT FROM OLD.opened_by OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'what a difference says, who owns it and who made the figures do not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'RESOLVED' THEN
    RAISE EXCEPTION 'a settled difference is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER finance_feed_difference_guard BEFORE UPDATE OR DELETE ON machvon.finance_feed_difference FOR EACH ROW EXECUTE FUNCTION machvon.guard_finance_feed_difference();

ALTER TABLE machvon.finance_feed_difference ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.finance_feed_difference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.finance_feed_difference AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.finance_feed_difference AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.finance_feed_difference FROM machvon_app;

COMMENT ON TABLE machvon.finance_feed_difference IS 'FEED-1: a figure of the Finance Department that differs from ours, with an owner and a resolution; owner and resolver are never among the makers.';
