-- Authored by hand (not generated): the per-contract aggregate (CA-1, eng-review R12). The scale test of the portfolio (50,000 contracts, 10 units, row-level security on) measured the live view `contract_fact` over its
-- budget of 800 ms at p95 (about 1.2 s for a page and the totals of all of it): the figures that cost are the ones that add up other tables per contract (the base revision, the approved changes, the price the package was
-- won at and its bidders, the guarantees). They are kept here, one row per contract, and are maintained by triggers in the very transaction that writes the source (the ledger columns of the contract are written the
-- same way), so a reader never sees an aggregate that is older than the rows it was made from.
--
-- The aggregate is a cache, never the only copy: `contract_aggregate_of` is the ONE definition of the figures (the refresh calls it and so does the view when a contract has no row yet), and
-- `contract_aggregate_backfill()` makes the rows of the tenant in scope (a tenant that had contracts before this migration runs it once; until then the view gives the same figures, only slower).

CREATE TABLE machvon.contract_aggregate (
  tenant_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  original_value_vnd numeric(24, 0) NOT NULL,
  approved_change_delta_vnd numeric(24, 0) NOT NULL,
  approved_change_count integer NOT NULL,
  max_change_tier smallint,
  max_cumulative_variation_pct numeric(9, 2),
  approved_extension_days integer NOT NULL,
  winning_bid_vnd numeric(24, 0),
  bidder_count integer,
  guarantee_required_vnd numeric(24, 0),
  guarantee_next_expiry_on date,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contract_id)
);

ALTER TABLE machvon.contract_aggregate ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_aggregate FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_aggregate AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_aggregate AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The one definition of the figures of the aggregate.
-- A composite, not a set: a figure of it is read as `(contract_aggregate_of(t, c)).column` anywhere, in a CASE too.
CREATE TYPE machvon.contract_aggregate_value AS (
  original_value_vnd numeric,
  approved_change_delta_vnd numeric,
  approved_change_count integer,
  max_change_tier smallint,
  max_cumulative_variation_pct numeric,
  approved_extension_days integer,
  winning_bid_vnd numeric,
  bidder_count integer,
  guarantee_required_vnd numeric,
  guarantee_next_expiry_on date
);

CREATE FUNCTION machvon.contract_aggregate_of(p_tenant uuid, p_contract uuid)
RETURNS machvon.contract_aggregate_value
LANGUAGE sql
STABLE
AS $fn$
  SELECT ROW(
    -- the value at signing: the base revision
    coalesce((SELECT r.amount_vnd FROM machvon.contract_revision r WHERE r.tenant_id = c.tenant_id AND r.contract_id = c.id AND r.kind = 'BASE' AND r.status <> 'REJECTED' ORDER BY r.revision LIMIT 1), c.contract_value_vnd),
    -- what the approved changes added, how many they are, the highest tier and the highest cumulative variation, and the days they moved the due date by
    coalesce((SELECT sum(q.approved_delta_vnd) FROM machvon.change_request q WHERE q.tenant_id = c.tenant_id AND q.contract_id = c.id AND q.status = 'APPROVED'), 0),
    (SELECT count(*) FROM machvon.change_request q WHERE q.tenant_id = c.tenant_id AND q.contract_id = c.id AND q.status = 'APPROVED')::integer,
    (SELECT max(q.tier) FROM machvon.change_request q WHERE q.tenant_id = c.tenant_id AND q.contract_id = c.id AND q.status = 'APPROVED'),
    (SELECT max(q.cumulative_variation_pct) FROM machvon.change_request q WHERE q.tenant_id = c.tenant_id AND q.contract_id = c.id AND q.status = 'APPROVED'),
    coalesce((SELECT sum(q.schedule_impact_days) FROM machvon.change_request q WHERE q.tenant_id = c.tenant_id AND q.contract_id = c.id AND q.status = 'APPROVED'), 0)::integer,
    -- the price the package was won at: the approved result of the procurement, else the bid of the winning contractor
    coalesce(
      (SELECT pr.award_price_vnd FROM machvon.procurement_result pr WHERE pr.tenant_id = c.tenant_id AND pr.package_id = c.package_id AND pr.status = 'APPROVED' AND pr.outcome = 'AWARDED' LIMIT 1),
      (SELECT pp.bid_price_vnd FROM machvon.proposal pp WHERE pp.tenant_id = c.tenant_id AND pp.package_id = c.package_id AND pp.contractor_id = c.contractor_id AND pp.status = 'RECEIVED' AND pp.bid_price_vnd IS NOT NULL ORDER BY pp.revision DESC LIMIT 1)
    ),
    -- no proposal on record is NULL (unknown), never a bidder count of zero
    nullif((SELECT count(DISTINCT pp.contractor_id) FROM machvon.proposal pp WHERE pp.tenant_id = c.tenant_id AND pp.package_id = c.package_id AND pp.status = 'RECEIVED'), 0)::integer,
    -- the guarantees the register holds (verified, not released, called or replaced); none on the register is NULL, not zero
    (SELECT sum(g.amount_vnd) FROM machvon.guarantee g WHERE g.tenant_id = c.tenant_id AND g.contract_id = c.id AND g.status IN ('ACTIVE', 'EXPIRED')),
    (SELECT min((g.expires_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) FROM machvon.guarantee g WHERE g.tenant_id = c.tenant_id AND g.contract_id = c.id AND g.status = 'ACTIVE')
  )::machvon.contract_aggregate_value
  FROM machvon.contract c
  WHERE c.tenant_id = p_tenant AND c.id = p_contract
$fn$;

CREATE FUNCTION machvon.contract_aggregate_refresh(p_tenant uuid, p_contract uuid) RETURNS void
LANGUAGE sql
AS $fn$
  INSERT INTO machvon.contract_aggregate AS a (tenant_id, contract_id, original_value_vnd, approved_change_delta_vnd, approved_change_count, max_change_tier, max_cumulative_variation_pct, approved_extension_days,
                                               winning_bid_vnd, bidder_count, guarantee_required_vnd, guarantee_next_expiry_on, refreshed_at)
  SELECT p_tenant, p_contract, (x.f).original_value_vnd, (x.f).approved_change_delta_vnd, (x.f).approved_change_count, (x.f).max_change_tier, (x.f).max_cumulative_variation_pct, (x.f).approved_extension_days,
         (x.f).winning_bid_vnd, (x.f).bidder_count, (x.f).guarantee_required_vnd, (x.f).guarantee_next_expiry_on, now()
    FROM (SELECT machvon.contract_aggregate_of(p_tenant, p_contract) AS f) x
   WHERE (x.f).original_value_vnd IS NOT NULL
  ON CONFLICT (tenant_id, contract_id) DO UPDATE SET
    original_value_vnd = EXCLUDED.original_value_vnd,
    approved_change_delta_vnd = EXCLUDED.approved_change_delta_vnd,
    approved_change_count = EXCLUDED.approved_change_count,
    max_change_tier = EXCLUDED.max_change_tier,
    max_cumulative_variation_pct = EXCLUDED.max_cumulative_variation_pct,
    approved_extension_days = EXCLUDED.approved_extension_days,
    winning_bid_vnd = EXCLUDED.winning_bid_vnd,
    bidder_count = EXCLUDED.bidder_count,
    guarantee_required_vnd = EXCLUDED.guarantee_required_vnd,
    guarantee_next_expiry_on = EXCLUDED.guarantee_next_expiry_on,
    refreshed_at = EXCLUDED.refreshed_at
$fn$;

-- The aggregate of every contract the caller can see (the tenant of the transaction): what a tenant that had contracts before this migration runs once, and what a bulk load runs after it.
CREATE FUNCTION machvon.contract_aggregate_backfill() RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  made bigint;
BEGIN
  WITH done AS (
    INSERT INTO machvon.contract_aggregate AS a (tenant_id, contract_id, original_value_vnd, approved_change_delta_vnd, approved_change_count, max_change_tier, max_cumulative_variation_pct, approved_extension_days,
                                                 winning_bid_vnd, bidder_count, guarantee_required_vnd, guarantee_next_expiry_on, refreshed_at)
    SELECT c.tenant_id, c.id, (x.f).original_value_vnd, (x.f).approved_change_delta_vnd, (x.f).approved_change_count, (x.f).max_change_tier, (x.f).max_cumulative_variation_pct, (x.f).approved_extension_days,
           (x.f).winning_bid_vnd, (x.f).bidder_count, (x.f).guarantee_required_vnd, (x.f).guarantee_next_expiry_on, now()
      FROM machvon.contract c
      CROSS JOIN LATERAL (SELECT machvon.contract_aggregate_of(c.tenant_id, c.id) AS f) x
    ON CONFLICT (tenant_id, contract_id) DO UPDATE SET
      original_value_vnd = EXCLUDED.original_value_vnd,
      approved_change_delta_vnd = EXCLUDED.approved_change_delta_vnd,
      approved_change_count = EXCLUDED.approved_change_count,
      max_change_tier = EXCLUDED.max_change_tier,
      max_cumulative_variation_pct = EXCLUDED.max_cumulative_variation_pct,
      approved_extension_days = EXCLUDED.approved_extension_days,
      winning_bid_vnd = EXCLUDED.winning_bid_vnd,
      bidder_count = EXCLUDED.bidder_count,
      guarantee_required_vnd = EXCLUDED.guarantee_required_vnd,
      guarantee_next_expiry_on = EXCLUDED.guarantee_next_expiry_on,
      refreshed_at = EXCLUDED.refreshed_at
    RETURNING 1
  )
  SELECT count(*) INTO made FROM done;
  RETURN made;
END;
$fn$;

-- The triggers: whatever writes a source of the aggregate refreshes the aggregate of the contracts it touches, in the same transaction. A package is shared by the contracts under it, so a result or a proposal refreshes them all.
CREATE FUNCTION machvon.contract_aggregate_touch() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target uuid;
BEGIN
  IF TG_ARGV[0] = 'contract' THEN
    PERFORM machvon.contract_aggregate_refresh(NEW.tenant_id, NEW.id);
  ELSIF TG_ARGV[0] = 'contract_id' THEN
    PERFORM machvon.contract_aggregate_refresh(NEW.tenant_id, NEW.contract_id);
  ELSE
    FOR target IN SELECT c.id FROM machvon.contract c WHERE c.tenant_id = NEW.tenant_id AND c.package_id = NEW.package_id LOOP
      PERFORM machvon.contract_aggregate_refresh(NEW.tenant_id, target);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE TRIGGER contract_aggregate_contract AFTER INSERT ON machvon.contract FOR EACH ROW EXECUTE FUNCTION machvon.contract_aggregate_touch('contract');
CREATE TRIGGER contract_aggregate_revision AFTER INSERT OR UPDATE ON machvon.contract_revision FOR EACH ROW EXECUTE FUNCTION machvon.contract_aggregate_touch('contract_id');
CREATE TRIGGER contract_aggregate_change AFTER INSERT OR UPDATE ON machvon.change_request FOR EACH ROW EXECUTE FUNCTION machvon.contract_aggregate_touch('contract_id');
CREATE TRIGGER contract_aggregate_guarantee AFTER INSERT OR UPDATE ON machvon.guarantee FOR EACH ROW EXECUTE FUNCTION machvon.contract_aggregate_touch('contract_id');
CREATE TRIGGER contract_aggregate_result AFTER INSERT OR UPDATE ON machvon.procurement_result FOR EACH ROW EXECUTE FUNCTION machvon.contract_aggregate_touch('package');
CREATE TRIGGER contract_aggregate_proposal AFTER INSERT OR UPDATE ON machvon.proposal FOR EACH ROW EXECUTE FUNCTION machvon.contract_aggregate_touch('package');

COMMENT ON TABLE machvon.contract_aggregate IS 'The figures of contract_fact that add up other tables per contract, kept per contract and refreshed in the transaction of the write that changes them (R12); a cache of contract_aggregate_of, never the only copy.';
COMMENT ON FUNCTION machvon.contract_aggregate_backfill() IS 'Makes the aggregate of every contract of the tenant of the transaction; idempotent.';
