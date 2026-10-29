-- Authored by hand (not generated): what a payment can settle once an invoice has been corrected (ST-SAS-013, SAS.md 3.7 item 4).
-- `invoice_by_code` (V1486) answered each invoice with its own total and the payments that matched it. After a correction that is not what the buyer owes:
--   * an invoice stands for its total and the adjustments of it that were **issued**: one that waits for the provider, or that could not be issued, is not yet a credit (it only reserves room, see the store), so a
--     payment is never judged against a reduction that may not happen;
--   * what was paid on it includes what was paid on the invoices it replaced, back along the chain of replacements (a replacement is the whole invoice again);
--   * an adjustment is not payable by itself (it is folded into the invoice it adjusts), so the answer says what kind of invoice it is.
-- The function answers the same ids and now also the kind; nothing else changes.

DROP FUNCTION IF EXISTS machvon.invoice_by_code(text);

CREATE FUNCTION machvon.invoice_by_code(p_code text)
RETURNS TABLE (tenant_id uuid, invoice_id uuid, kind text, status text, total_vnd numeric, paid_vnd numeric)
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
      SELECT i.tenant_id, i.id, i.kind, i.status,
             i.total_vnd + COALESCE((SELECT sum(a.total_vnd) FROM machvon.invoice a
                                      WHERE a.tenant_id = i.tenant_id AND a.related_invoice_id = i.id AND a.kind = 'ADJUSTMENT'
                                        AND a.status IN ('Issued', 'Sent', 'PartiallyPaid', 'Paid', 'Overdue')), 0),
             COALESCE((WITH RECURSIVE chain(id) AS (
                         SELECT i.id
                         UNION
                         SELECT c.related_invoice_id FROM machvon.invoice c JOIN chain ON c.id = chain.id
                          WHERE c.kind = 'REPLACEMENT' AND c.related_invoice_id IS NOT NULL AND c.tenant_id = i.tenant_id
                       )
                       SELECT sum(p.amount_vnd) FROM machvon.billing_payment p
                        WHERE p.tenant_id = i.tenant_id AND p.match_status = 'Matched' AND p.invoice_id IN (SELECT id FROM chain)), 0)
        FROM machvon.invoice i
       WHERE i.tenant_id = one_tenant.id AND i.invoice_code = p_code AND i.status <> 'Discarded';
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  RETURN;
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.invoice_by_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.invoice_by_code(text) TO machvon_control;

-- An adjusted invoice stays Adjusted (the table lets it go to Replaced only), so its status cannot say that it fell due and is still owed. The day the sweep found it so is noted on the invoice (not one of the sealed
-- fields), and cleared when what is owed has been paid.
ALTER TABLE machvon.invoice ADD COLUMN overdue_since date;
CREATE INDEX invoice_adjusted_due_idx ON machvon.invoice (tenant_id, due_at) WHERE status = 'Adjusted' AND overdue_since IS NULL;

-- What is still owed on an invoice, defined once for the sweep, the reconciliation and the recovery of a subscription: the total and the adjustments of it that were issued, less what was paid on it and on the invoices
-- it replaced (the caller's tenant: it reads under the row-level security of the transaction).
CREATE FUNCTION machvon.invoice_outstanding(p_invoice uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $fn$
  SELECT i.total_vnd
         + COALESCE((SELECT sum(a.total_vnd) FROM machvon.invoice a WHERE a.related_invoice_id = i.id AND a.kind = 'ADJUSTMENT' AND a.status IN ('Issued', 'Sent', 'PartiallyPaid', 'Paid', 'Overdue')), 0)
         - COALESCE((WITH RECURSIVE chain(id) AS (
                       SELECT i.id
                       UNION
                       SELECT c.related_invoice_id FROM machvon.invoice c JOIN chain ON c.id = chain.id WHERE c.kind = 'REPLACEMENT' AND c.related_invoice_id IS NOT NULL
                     )
                     SELECT sum(p.amount_vnd) FROM machvon.billing_payment p WHERE p.match_status = 'Matched' AND p.invoice_id IN (SELECT id FROM chain)), 0)
    FROM machvon.invoice i WHERE i.id = p_invoice
$fn$;
GRANT EXECUTE ON FUNCTION machvon.invoice_outstanding(uuid) TO machvon_control, machvon_app;
