-- Authored by hand (not generated): the certification of a data product (ST-DGV-009, DGV 3.1 F9, DGV-18).
-- V002 gave `data_product` its columns and one rule (a certified product names a certifier who is not its owner and a day it runs out). This adds the rest of what the table must keep whatever the application does:
-- a product is made of 1 to 50 datasets and has a code of its own, the evidence is a list, a revoked product states why and a certified one states when, the status moves only along the lines of the design
-- (NOT_ASSESSED -> PROVISIONAL | CERTIFIED, PROVISIONAL -> CERTIFIED, CERTIFIED -> CERTIFIED | PROVISIONAL (it ran out) | REVOKED, REVOKED is final), and a product is never deleted.

ALTER TABLE machvon.data_product
  ADD CONSTRAINT data_product_shape_chk CHECK (
    jsonb_typeof(dataset_ids) = 'array' AND jsonb_array_length(dataset_ids) BETWEEN 1 AND 50
    AND jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) <= 500
    AND code = btrim(code) AND char_length(code) BETWEEN 1 AND 80
    AND title = btrim(title) AND char_length(title) BETWEEN 1 AND 300
  ),
  ADD CONSTRAINT data_product_state_chk CHECK (
    (certification_status <> 'REVOKED' OR (revoke_reason IS NOT NULL AND char_length(revoke_reason) BETWEEN 10 AND 2000))
    AND (certification_status <> 'CERTIFIED' OR (certified_at IS NOT NULL AND jsonb_array_length(evidence_refs) >= 1))
    AND (certification_status <> 'NOT_ASSESSED' OR (certified_by IS NULL AND certified_at IS NULL AND certification_expires_on IS NULL))
  );

CREATE INDEX data_product_expiry_idx ON machvon.data_product (tenant_id, certification_expires_on) WHERE certification_status = 'CERTIFIED';

CREATE FUNCTION machvon.guard_data_product_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the code, the owner and the maker of a data product never change here' USING ERRCODE = '23514';
  END IF;
  IF NEW.certification_status IS DISTINCT FROM OLD.certification_status AND NOT (
       (OLD.certification_status = 'NOT_ASSESSED' AND NEW.certification_status IN ('PROVISIONAL', 'CERTIFIED'))
    OR (OLD.certification_status = 'PROVISIONAL' AND NEW.certification_status = 'CERTIFIED')
    OR (OLD.certification_status = 'CERTIFIED' AND NEW.certification_status IN ('PROVISIONAL', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'a data product does not go from % to %', OLD.certification_status, NEW.certification_status USING ERRCODE = '23514';
  END IF;
  IF OLD.certification_status = 'REVOKED' THEN
    RAISE EXCEPTION 'a revoked data product is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER data_product_update_guard BEFORE UPDATE ON machvon.data_product
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_data_product_update();

REVOKE DELETE, TRUNCATE ON TABLE machvon.data_product FROM machvon_app;

-- The reminder the notification service knows: a certification that ran out (to the owner of the product). The payload names ids, the code and the day, never the datasets or the evidence.
INSERT INTO machvon.notification_event_type (id, event_type, owning_module, schema_version, payload_schema, allowed_purposes, data_classification, status)
VALUES (
  gen_random_uuid(),
  'dgv.product.expired.v1',
  'DGV',
  1,
  '{"type":"object","required":["tenant_id","product_id","code","status","expired_on"],"properties":{"tenant_id":{"type":"string","format":"uuid"},"product_id":{"type":"string","format":"uuid"},"code":{"type":"string"},"status":{"type":"string","enum":["PROVISIONAL"]},"expired_on":{"type":"string"},"occurred_at":{"type":"string"}}}'::jsonb,
  ARRAY['REMINDER', 'OPERATIONAL'],
  'INTERNAL',
  'Active'
)
ON CONFLICT (event_type, schema_version) DO NOTHING;
