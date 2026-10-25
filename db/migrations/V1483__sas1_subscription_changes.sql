-- Authored by hand (not generated): the subscription of a tenant and the history of its plan changes (ST-SAS-008, SAS.md BR-SAS-08 and BR-SAS-09).
-- V002 gave `subscription` (one live subscription per tenant, `subscription_one_live_uq`) with its period, its pending plan and its version. What a change of plan
-- needs to be a record that billing can rely on is put into the database here, whatever the application checked first:
--   * a pending plan comes with the day it takes effect (both or neither); the cycle and the period were already checked by V002;
--   * every change of plan is kept as a row of `subscription_plan_change`: from which plan to which, effective now or at the next cycle, the day it takes
--     effect, the proration in whole VND (never negative: a downgrade gives no money back in the period), the preview it was judged on, the reason, who asked
--     and when. A row is never edited and never deleted; it records once when a pending change was applied (or that a later one replaced it before its day) and once when billing took its proration onto an invoice.

ALTER TABLE machvon.subscription
  ADD CONSTRAINT subscription_pending_ck CHECK ((pending_plan_version_id IS NULL) = (pending_effective_at IS NULL));

CREATE TABLE machvon.subscription_plan_change (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  from_plan_version_id uuid NOT NULL REFERENCES machvon.product_plan_version (id),
  to_plan_version_id uuid NOT NULL REFERENCES machvon.product_plan_version (id),
  effective text NOT NULL CHECK (effective IN ('NOW', 'NEXT_CYCLE')),
  effective_at timestamptz NOT NULL,
  proration_vnd numeric(24, 0) NOT NULL CHECK (proration_vnd >= 0),
  preview_hash char(64) NOT NULL CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  /** A change that waited for its day and was replaced by a later one before it came: it never applies. */
  superseded_at timestamptz,
  invoiced_invoice_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES machvon.subscription (tenant_id, id),
  CHECK (from_plan_version_id <> to_plan_version_id),
  CHECK (effective = 'NOW' OR proration_vnd = 0),
  CHECK (invoiced_invoice_id IS NULL OR applied_at IS NOT NULL),
  CHECK (superseded_at IS NULL OR (applied_at IS NULL AND effective = 'NEXT_CYCLE'))
);

CREATE INDEX subscription_plan_change_subscription_idx ON machvon.subscription_plan_change (tenant_id, subscription_id, requested_at DESC);
CREATE INDEX subscription_plan_change_from_plan_idx ON machvon.subscription_plan_change (tenant_id, from_plan_version_id);
CREATE INDEX subscription_plan_change_to_plan_idx ON machvon.subscription_plan_change (tenant_id, to_plan_version_id);
CREATE INDEX subscription_plan_change_invoice_idx ON machvon.subscription_plan_change (tenant_id, invoiced_invoice_id) WHERE invoiced_invoice_id IS NOT NULL;
-- The changes that wait for their day: the cycle job finds them without reading every row.
CREATE INDEX subscription_plan_change_pending_idx ON machvon.subscription_plan_change (tenant_id, effective_at) WHERE applied_at IS NULL AND superseded_at IS NULL;

ALTER TABLE machvon.subscription_plan_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.subscription_plan_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.subscription_plan_change AS RESTRICTIVE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.subscription_plan_change AS PERMISSIVE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The control plane records the changes and a job of the tenant applies the ones that waited; the history is read by whoever may read the subscription.
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.subscription_plan_change TO machvon_control;
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.subscription_plan_change TO machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.subscription_plan_change FROM machvon_app, machvon_control;

CREATE FUNCTION machvon.guard_subscription_plan_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a plan change is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.subscription_id, NEW.from_plan_version_id, NEW.to_plan_version_id, NEW.effective, NEW.effective_at, NEW.proration_vnd, NEW.preview_hash,
      NEW.reason, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.subscription_id, OLD.from_plan_version_id, OLD.to_plan_version_id, OLD.effective, OLD.effective_at, OLD.proration_vnd, OLD.preview_hash,
      OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'what a plan change says is never edited' USING ERRCODE = '23514';
  END IF;
  IF OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION 'a plan change is applied once' USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'a plan change is superseded once' USING ERRCODE = '23514';
  END IF;
  IF OLD.invoiced_invoice_id IS NOT NULL AND NEW.invoiced_invoice_id IS DISTINCT FROM OLD.invoiced_invoice_id THEN
    RAISE EXCEPTION 'a proration goes onto one invoice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER subscription_plan_change_guard BEFORE UPDATE OR DELETE ON machvon.subscription_plan_change
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_subscription_plan_change();

-- The plan change commands name only the subscription (/system/subscriptions/{subscriptionId}/...), and the control role reads a tenant table inside a transaction that
-- names the tenant, so it finds the tenant of a subscription through this function: it names each tenant in app.tenant_id while it looks, then puts the caller's
-- setting back exactly as it found it (as license_tenant_of does). It answers a uuid and nothing else.
CREATE FUNCTION machvon.subscription_tenant_of(p_subscription uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  one_tenant record;
  owner_id uuid;
BEGIN
  FOR one_tenant IN SELECT t.id FROM machvon.tenant t ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', one_tenant.id::text, true);
    IF EXISTS (SELECT 1 FROM machvon.subscription s WHERE s.tenant_id = one_tenant.id AND s.id = p_subscription) THEN
      owner_id := one_tenant.id;
      EXIT;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  RETURN owner_id;
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.subscription_tenant_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.subscription_tenant_of(uuid) TO machvon_control;
