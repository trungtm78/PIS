-- Authored by hand (not generated): the billing run and the e-invoice (ST-SAS-011, SAS.md BR-SAS-04, BR-SAS-13, BR-SAS-14 and 3.7).
-- V002 gave `invoice` (the total is the subtotal plus the VAT, a unique e-invoice number per provider, a template and a series, one replacement per original) and
-- `invoice_line`. What the billing run and the e-invoice need to be a record that no one can rewrite is put into the database here, whatever the application checked first:
--   * one ORIGINAL invoice for each period of a subscription, however many times the run is made; a discarded draft does not count;
--   * an invoice that has been issued is the invoice the buyer was given: nothing it says changes (not the lines, not the totals, not the buyer, not the number), it
--     is never deleted and there is no state to cancel it in; a mistake is corrected by an adjustment or a replacement that points to it (SAS-24). Its status moves
--     only along the chain of SAS.md 3.7: Draft -> PendingIssue -> Issued -> Sent -> PartiallyPaid -> Paid, Overdue on the way, Adjusted or Replaced at the end;
--   * the lines of an invoice are written while it is a Draft and never after, and an invoice goes out for issue only when the lines add up to its totals;
--   * the attempts to issue are counted with the time of the first one, so that the provider is asked five times in 24 hours and then no more (IssueFailed);
--   * a subscription remembers that a suspension was proposed (30 days past due), which changes nothing about the tenant: only a System Admin decides it (BR-SAS-04);
--   * a metered feature of a plan carries the price of a unit beyond its limit (the USAGE line of the run), written with the plan while it is a draft.

ALTER TABLE machvon.plan_feature
  ADD COLUMN overage_price_vnd numeric(24, 0),
  ADD CONSTRAINT plan_feature_overage_ck CHECK (overage_price_vnd IS NULL OR (limit_kind = 'METERED' AND overage_price_vnd >= 0));

ALTER TABLE machvon.subscription ADD COLUMN suspension_proposed_at timestamptz;

ALTER TABLE machvon.invoice
  ADD COLUMN issue_attempts integer NOT NULL DEFAULT 0 CHECK (issue_attempts >= 0),
  ADD COLUMN issue_started_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN issue_error text,
  ADD CONSTRAINT invoice_issued_ck CHECK (
    status NOT IN ('Issued', 'Sent', 'PartiallyPaid', 'Paid', 'Overdue', 'Adjusted', 'Replaced')
    OR (einvoice_provider IS NOT NULL AND einvoice_number IS NOT NULL AND provider_ref IS NOT NULL AND issued_at IS NOT NULL AND due_at IS NOT NULL)
  ),
  ADD CONSTRAINT invoice_pending_ck CHECK (status <> 'PendingIssue' OR (issue_started_at IS NOT NULL AND issue_attempts >= 0));

CREATE UNIQUE INDEX invoice_one_original_uq ON machvon.invoice (tenant_id, subscription_id, period_start, period_end) WHERE kind = 'ORIGINAL' AND status <> 'Discarded';
-- The sweeps of the billing job find what is due without reading every invoice.
CREATE INDEX invoice_retry_idx ON machvon.invoice (tenant_id, next_attempt_at) WHERE status = 'PendingIssue';
CREATE INDEX invoice_due_idx ON machvon.invoice (tenant_id, due_at) WHERE status IN ('Issued', 'Sent', 'PartiallyPaid');

-- V002 made the first shape of a line a price of a meter with a version of the AI pricing table; a line of the invoice is now a kind, a description and a whole amount of VND.
ALTER TABLE machvon.invoice_line
  ALTER COLUMN meter DROP NOT NULL,
  ALTER COLUMN quantity DROP NOT NULL,
  ALTER COLUMN unit_price DROP NOT NULL,
  ALTER COLUMN amount DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL,
  ALTER COLUMN pricing_version_id DROP NOT NULL,
  ADD COLUMN line_no integer NOT NULL DEFAULT 1;
-- A line that already exists is numbered in the order of its id within its invoice, so that the numbers are distinct before they are required to be.
UPDATE machvon.invoice_line l SET line_no = numbered.n FROM (SELECT tenant_id, id, row_number() OVER (PARTITION BY tenant_id, invoice_id ORDER BY id) AS n FROM machvon.invoice_line) numbered
  WHERE l.tenant_id = numbered.tenant_id AND l.id = numbered.id;
ALTER TABLE machvon.invoice_line
  ADD CONSTRAINT invoice_line_no_ck CHECK (line_no >= 1),
  ADD CONSTRAINT invoice_line_usage_ck CHECK (line_kind <> 'USAGE' OR (meter IS NOT NULL AND quantity IS NOT NULL AND unit_price IS NOT NULL)),
  ADD CONSTRAINT invoice_line_vat_ck CHECK (vat_category <> 'NOT_SUBJECT' OR vat_vnd = 0),
  ADD CONSTRAINT invoice_line_no_uq UNIQUE (tenant_id, invoice_id, line_no);

-- A proration goes onto one invoice, and onto the invoice that replaces it when that one was only a draft that was discarded: nobody was charged by it. Everything else of the guard of V1483 stays.
CREATE OR REPLACE FUNCTION machvon.guard_subscription_plan_change() RETURNS trigger
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
  IF OLD.invoiced_invoice_id IS NOT NULL AND NEW.invoiced_invoice_id IS DISTINCT FROM OLD.invoiced_invoice_id
     AND NOT EXISTS (SELECT 1 FROM machvon.invoice i WHERE i.tenant_id = OLD.tenant_id AND i.id = OLD.invoiced_invoice_id AND i.status = 'Discarded') THEN
    RAISE EXCEPTION 'a proration goes onto one invoice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

GRANT SELECT, INSERT, UPDATE ON TABLE machvon.invoice, machvon.invoice_line TO machvon_control;
GRANT SELECT ON TABLE machvon.invoice, machvon.invoice_line TO machvon_app;
-- An invoice is never deleted, not even a draft: a draft nobody wants is Discarded.
REVOKE DELETE, TRUNCATE ON TABLE machvon.invoice, machvon.invoice_line FROM machvon_app, machvon_control;

CREATE FUNCTION machvon.guard_invoice() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_sealed constant text[] := ARRAY['Issued', 'Sent', 'PartiallyPaid', 'Paid', 'Overdue', 'Adjusted', 'Replaced'];
  v_lines_amount numeric;
  v_lines_vat numeric;
  v_lines integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EINVOICE_IMMUTABLE: an invoice is never deleted' USING ERRCODE = '23514';
  END IF;
  -- What an invoice says (its period, buyer, amounts and due day) is fixed from the first attempt to issue it, when its lines are fixed too: a retry, or the provider's answer to the first attempt that
  -- was lost, must find the invoice it was asked about. Once it is issued what the provider answered is fixed too; the status, the version and the bookkeeping of the attempts and of the payments are what moves.
  IF OLD.status <> 'Draft'
     AND (NEW.tenant_id, NEW.id, NEW.subscription_id, NEW.invoice_code, NEW.period_start, NEW.period_end, NEW.kind, NEW.related_invoice_id, NEW.correction_reason,
          NEW.agreement_document_ref, NEW.subtotal_vnd, NEW.vat_vnd, NEW.total_vnd, NEW.currency, NEW.buyer_snapshot, NEW.due_at)
         IS DISTINCT FROM
         (OLD.tenant_id, OLD.id, OLD.subscription_id, OLD.invoice_code, OLD.period_start, OLD.period_end, OLD.kind, OLD.related_invoice_id, OLD.correction_reason,
          OLD.agreement_document_ref, OLD.subtotal_vnd, OLD.vat_vnd, OLD.total_vnd, OLD.currency, OLD.buyer_snapshot, OLD.due_at) THEN
    RAISE EXCEPTION 'EINVOICE_IMMUTABLE: an invoice that went out for issue is never edited' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = ANY (v_sealed)
     AND (NEW.einvoice_provider, NEW.einvoice_template_code, NEW.einvoice_series, NEW.einvoice_number, NEW.tax_authority_code, NEW.lookup_code, NEW.provider_ref, NEW.issued_at)
         IS DISTINCT FROM
         (OLD.einvoice_provider, OLD.einvoice_template_code, OLD.einvoice_series, OLD.einvoice_number, OLD.tax_authority_code, OLD.lookup_code, OLD.provider_ref, OLD.issued_at) THEN
    RAISE EXCEPTION 'EINVOICE_IMMUTABLE: an issued invoice is never edited' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'Draft' AND NEW.status IN ('PendingIssue', 'Discarded'))
    OR (OLD.status = 'PendingIssue' AND NEW.status IN ('Issued', 'IssueFailed'))
    OR (OLD.status = 'IssueFailed' AND NEW.status = 'PendingIssue')
    OR (OLD.status = 'Issued' AND NEW.status IN ('Sent', 'PartiallyPaid', 'Paid', 'Overdue', 'Adjusted', 'Replaced'))
    OR (OLD.status = 'Sent' AND NEW.status IN ('PartiallyPaid', 'Paid', 'Overdue', 'Adjusted', 'Replaced'))
    OR (OLD.status = 'PartiallyPaid' AND NEW.status IN ('Paid', 'Overdue', 'Adjusted', 'Replaced'))
    OR (OLD.status = 'Overdue' AND NEW.status IN ('PartiallyPaid', 'Paid', 'Adjusted', 'Replaced'))
    OR (OLD.status = 'Paid' AND NEW.status IN ('Adjusted', 'Replaced'))
    OR (OLD.status = 'Adjusted' AND NEW.status = 'Replaced')
  ) THEN
    RAISE EXCEPTION 'EINVOICE_STATE_INVALID: an invoice does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- An invoice goes out for issue only when its lines add up to what it says (the lines are final from here on).
  IF OLD.status = 'Draft' AND NEW.status = 'PendingIssue' THEN
    SELECT count(*), COALESCE(sum(amount_vnd), 0), COALESCE(sum(vat_vnd), 0) INTO v_lines, v_lines_amount, v_lines_vat
      FROM machvon.invoice_line WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id;
    IF v_lines = 0 OR v_lines_amount <> NEW.subtotal_vnd OR v_lines_vat <> NEW.vat_vnd THEN
      RAISE EXCEPTION 'EINVOICE_STATE_INVALID: the lines of the invoice do not add up to its totals' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER invoice_guard BEFORE UPDATE OR DELETE ON machvon.invoice
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_invoice();

CREATE FUNCTION machvon.guard_invoice_line() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_status text;
BEGIN
  -- A line never moves to another invoice: the draft it left and the invoice it would join would both change.
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.invoice_id) IS DISTINCT FROM (OLD.tenant_id, OLD.invoice_id) THEN
    RAISE EXCEPTION 'EINVOICE_IMMUTABLE: a line stays on its invoice' USING ERRCODE = '23514';
  END IF;
  -- The row of the invoice is held shared to the end of the transaction of the line: the invoice cannot go out for issue (and have its totals checked against the lines) between this look and the commit of the line,
  -- and a line is refused once it has.
  SELECT status INTO v_status FROM machvon.invoice
    WHERE tenant_id = CASE WHEN TG_OP = 'INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END AND id = CASE WHEN TG_OP = 'INSERT' THEN NEW.invoice_id ELSE OLD.invoice_id END
    FOR SHARE;
  IF v_status IS DISTINCT FROM 'Draft' THEN
    RAISE EXCEPTION 'EINVOICE_IMMUTABLE: the lines of an invoice are written while it is a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.invoice_line
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_invoice_line();

-- The issue of an invoice names only the invoice, so the control plane finds the tenant to act as through this function, as it does for a subscription: it names each tenant
-- in app.tenant_id while it looks, then puts the caller's setting back exactly as it found it. It answers a uuid and nothing else.
CREATE FUNCTION machvon.invoice_tenant_of(p_invoice uuid)
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
    IF EXISTS (SELECT 1 FROM machvon.invoice i WHERE i.tenant_id = one_tenant.id AND i.id = p_invoice) THEN
      owner_id := one_tenant.id;
      EXIT;
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
  RETURN owner_id;
END;
$fn$;
REVOKE ALL ON FUNCTION machvon.invoice_tenant_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.invoice_tenant_of(uuid) TO machvon_control;
