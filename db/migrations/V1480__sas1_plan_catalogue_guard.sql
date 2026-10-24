-- Authored by hand (not generated): the plan catalogue is immutable once it is published (ST-SAS-007, SAS.md BR-SAS-07, BR-SAS-10).
-- V002 gave the tables and V008 the grants of the control plane; what makes a published plan a promise is put into the database here,
-- whatever the application checked first:
--   * a Draft may become Published, and a Published may become Retired; nothing goes back, and a Retired plan is final;
--   * a Published or Retired plan version never changes any other column (price, cycles, VAT, terms, name, revision), and it records
--     who published it and when, once;
--   * the features of a plan version are written while the version is a Draft and never after: the sold features and limits are the promise;
--   * a plan version and its features are never deleted: subscriptions, entitlement versions and invoices point at them for good.

REVOKE DELETE, TRUNCATE ON TABLE machvon.product_plan_version, machvon.plan_feature FROM machvon_control;

CREATE FUNCTION machvon.guard_product_plan_version() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a plan version is never deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Retired' THEN
    RAISE EXCEPTION 'a retired plan version is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Published' THEN
    IF NEW.status NOT IN ('Published', 'Retired') THEN
      RAISE EXCEPTION 'a published plan version does not go back to a draft' USING ERRCODE = '23514';
    END IF;
    IF (NEW.id, NEW.plan_code, NEW.revision, NEW.name, NEW.billing_cycles, NEW.base_price_vnd, NEW.vat_category, NEW.legal_terms_ref, NEW.published_by, NEW.published_at)
       IS DISTINCT FROM
       (OLD.id, OLD.plan_code, OLD.revision, OLD.name, OLD.billing_cycles, OLD.base_price_vnd, OLD.vat_category, OLD.legal_terms_ref, OLD.published_by, OLD.published_at) THEN
      RAISE EXCEPTION 'a published plan version is immutable: a change is a new revision' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'Retired' THEN
    RAISE EXCEPTION 'a draft plan version is published before it is retired' USING ERRCODE = '23514';
  ELSIF NEW.status = 'Published' AND (NEW.published_by IS NULL OR NEW.published_at IS NULL) THEN
    RAISE EXCEPTION 'a published plan version records who published it and when' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER product_plan_version_guard BEFORE UPDATE OR DELETE ON machvon.product_plan_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_product_plan_version();

CREATE FUNCTION machvon.guard_product_plan_feature() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM machvon.product_plan_version WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.plan_version_id ELSE OLD.plan_version_id END;
  IF v_status IS DISTINCT FROM 'Draft' THEN
    RAISE EXCEPTION 'the features of a plan version are written while it is a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

-- V009 seeds the STANDARD plan with its features before this guard exists, and its version is Published, so only later writes meet it.
CREATE TRIGGER plan_feature_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.plan_feature
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_product_plan_feature();
