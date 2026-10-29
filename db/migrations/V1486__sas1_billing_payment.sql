-- Authored by hand (not generated): the payments that come in and their reconciliation with the invoices (ST-SAS-012, SAS.md 3.7 item 3).
-- V002 gave `billing_payment` (one row for each transaction of a provider, `UNIQUE (provider, provider_txn_ref)`, a match status, a reversal link). What the reconciliation needs to be a record that
-- cannot be rewritten is put into the database here, whatever the application checked first:
--   * the payment names the event it came from by `source_inbox_event_id`, which is not a foreign key: the retention of the inbox may remove an old event, and a payment (a record of money) is never held back by it, nor removed with it;
--   * a payment that has just come in is nobody's invoice yet: the callback arrives without the tenant, so it is kept under the platform tenant (Unmatched, or PendingReview when a note and an amount
--     point at an invoice and do not agree) and **moves to the tenant of the invoice** the moment it is matched, in one step that nothing else can do (`billing_payment_adopt`);
--   * what a payment says (provider, transaction, amount, method, day, note) never changes, it is never deleted (except by that move) and its status goes forward only: Unmatched and PendingReview
--     to each other and to Matched, Matched to Reversed; a payment is Matched exactly when it names an invoice and who matched it;
--   * the code in a transfer note finds an invoice across tenants through `invoice_by_code`, which answers the ids and the amounts of the invoices that carry the code and nothing else.

ALTER TABLE machvon.billing_payment
  ADD COLUMN memo text NOT NULL DEFAULT '',
  ADD COLUMN source_inbox_event_id uuid,
  ADD COLUMN matched_at timestamptz,
  ADD COLUMN match_attempted_at timestamptz;

-- V002 let a payment be Matched without saying who matched it or when, or Unmatched with an invoice; none was ever written (nothing wrote this table before), but a database that has some is made to agree with the rule
-- before the rule is enforced: a Matched or Reversed payment gets the day it was received as the day it was matched and the worker as the one who matched it, one that names no invoice goes back to Unmatched, and
-- a payment that waits names no invoice.
UPDATE machvon.billing_payment SET match_status = 'Unmatched', matched_by = NULL WHERE match_status IN ('Matched', 'Reversed') AND invoice_id IS NULL;
UPDATE machvon.billing_payment SET matched_at = COALESCE(matched_at, received_at), matched_by = COALESCE(matched_by, '00000000-0000-4000-8000-0000000000e9') WHERE match_status IN ('Matched', 'Reversed');
UPDATE machvon.billing_payment SET invoice_id = NULL, matched_by = NULL, matched_at = NULL WHERE match_status IN ('Unmatched', 'PendingReview');

ALTER TABLE machvon.billing_payment
  ADD CONSTRAINT billing_payment_match_ck CHECK (
    (match_status IN ('Unmatched', 'PendingReview') AND invoice_id IS NULL AND matched_by IS NULL AND matched_at IS NULL)
    OR (match_status IN ('Matched', 'Reversed') AND invoice_id IS NOT NULL AND matched_by IS NOT NULL AND matched_at IS NOT NULL)
  );

CREATE INDEX billing_payment_source_event_idx ON machvon.billing_payment (tenant_id, source_inbox_event_id) WHERE source_inbox_event_id IS NOT NULL;
CREATE INDEX billing_payment_status_idx ON machvon.billing_payment (tenant_id, match_status, received_at DESC);
-- The matching worker looks at the payments whose note names an invoice code, the ones it looked at longest ago first, so that payments it cannot settle never keep the others from being looked at.
CREATE INDEX billing_payment_attempt_idx ON machvon.billing_payment (tenant_id, match_attempted_at NULLS FIRST, received_at) WHERE match_status = 'Unmatched';

GRANT SELECT, INSERT, UPDATE ON TABLE machvon.billing_payment TO machvon_control;
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.billing_payment TO machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.billing_payment FROM machvon_app, machvon_control;
-- The control plane takes the callbacks of the e-invoice provider into the inbox of the platform tenant in the same transaction that applies them to the invoice.
GRANT SELECT, INSERT, UPDATE ON TABLE machvon.integration_event_inbox TO machvon_control;

CREATE FUNCTION machvon.guard_billing_payment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('machvon.payment_adoption', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'PAYMENT_IMMUTABLE: a payment is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.provider, NEW.provider_txn_ref, NEW.amount_vnd, NEW.method, NEW.received_at, NEW.memo)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.provider, OLD.provider_txn_ref, OLD.amount_vnd, OLD.method, OLD.received_at, OLD.memo) THEN
    RAISE EXCEPTION 'PAYMENT_IMMUTABLE: what a payment says is never edited' USING ERRCODE = '23514';
  END IF;
  IF NEW.match_status IS DISTINCT FROM OLD.match_status AND NOT (
       (OLD.match_status = 'Unmatched' AND NEW.match_status IN ('PendingReview', 'Matched'))
    OR (OLD.match_status = 'PendingReview' AND NEW.match_status IN ('Unmatched', 'Matched'))
    OR (OLD.match_status = 'Matched' AND NEW.match_status = 'Reversed')
  ) THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: a payment does not go from % to %', OLD.match_status, NEW.match_status USING ERRCODE = '23514';
  END IF;
  IF OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'PAYMENT_IMMUTABLE: a matched payment stays with its invoice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER billing_payment_guard BEFORE UPDATE OR DELETE ON machvon.billing_payment
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_billing_payment();

-- The invoices that carry a code, in any tenant: the transfer note names a code, not a tenant. It names each tenant in app.tenant_id while it looks, then puts the caller's setting back exactly
-- as it found it (as subscription_tenant_of does), and answers the tenant, the invoice, its status, its total and what the payments that matched it came to.
CREATE FUNCTION machvon.invoice_by_code(p_code text)
RETURNS TABLE (tenant_id uuid, invoice_id uuid, status text, total_vnd numeric, paid_vnd numeric)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  one_tenant record;
BEGIN
  FOR one_tenant IN SELECT t.id FROM machvon.tenant t ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', one_tenant.id::text, true);
    RETURN QUERY
      SELECT i.tenant_id, i.id, i.status, i.total_vnd,
             COALESCE((SELECT sum(p.amount_vnd) FROM machvon.billing_payment p WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.id AND p.match_status = 'Matched'), 0)
        FROM machvon.invoice i
       WHERE i.tenant_id = one_tenant.id AND i.invoice_code = p_code AND i.status <> 'Discarded';
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  RETURN;
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.invoice_by_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.invoice_by_code(text) TO machvon_control;

-- Moves a payment of the platform tenant to the tenant of the invoice it settles, as Matched: the row of the platform is removed and the row of the tenant is made in the same
-- step, so that there is one payment for the transaction at every moment. The invoice must belong to that tenant (the key of the table says so). It answers the id of the payment of the tenant.
CREATE FUNCTION machvon.billing_payment_adopt(p_platform uuid, p_payment uuid, p_tenant uuid, p_invoice uuid, p_matched_by uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  previous text := current_setting('app.tenant_id', true);
  held record;
  adopted uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.tenant_id', p_platform::text, true);
  SELECT * INTO held FROM machvon.billing_payment WHERE tenant_id = p_platform AND id = p_payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESOURCE_NOT_FOUND: no such payment' USING ERRCODE = 'P0002';
  END IF;
  IF held.match_status NOT IN ('Unmatched', 'PendingReview') THEN
    RAISE EXCEPTION 'PAYMENT_STATE_INVALID: the payment is %', held.match_status USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('machvon.payment_adoption', 'on', true);
  DELETE FROM machvon.billing_payment WHERE tenant_id = held.tenant_id AND id = held.id;
  PERFORM set_config('machvon.payment_adoption', 'off', true);
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  INSERT INTO machvon.billing_payment (tenant_id, id, invoice_id, provider, provider_txn_ref, amount_vnd, method, received_at, match_status, matched_by, inbox_event_id, memo, source_inbox_event_id, matched_at, version)
    VALUES (p_tenant, adopted, p_invoice, held.provider, held.provider_txn_ref, held.amount_vnd, held.method, held.received_at, 'Matched', p_matched_by, NULL, held.memo, held.source_inbox_event_id, now(), 1);
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  RETURN adopted;
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.billing_payment_adopt(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.billing_payment_adopt(uuid, uuid, uuid, uuid, uuid) TO machvon_control;
