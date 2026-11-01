-- ST-LLM-008 (LLM.md F3, BR-LLM-06, LLM-21, UAT-AC462): the reconciliation of the invoice of a provider against the attempts that were made through it. The report of a run is kept; a variance has an owner; an attempt is never
-- edited to make the figures agree.

CREATE TABLE machvon.ai_invoice_reconciliation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  provider_id uuid NOT NULL,
  invoice_ref text NOT NULL CHECK (char_length(btrim(invoice_ref)) BETWEEN 1 AND 120),
  invoice_amount numeric(26, 8) NOT NULL CHECK (invoice_amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_from date NOT NULL,
  period_to date NOT NULL,
  attempts_total numeric(26, 8) NOT NULL CHECK (attempts_total >= 0),
  variance numeric(26, 8) NOT NULL,
  tolerance_pct numeric(5, 2) NOT NULL CHECK (tolerance_pct >= 0),
  attempt_count integer NOT NULL CHECK (attempt_count >= 0),
  pending_attempt_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reconciled_attempt_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reservations_settled integer NOT NULL DEFAULT 0 CHECK (reservations_settled >= 0),
  status text NOT NULL CHECK (status IN ('VARIANCE', 'RECONCILED')),
  owner_id uuid NOT NULL,
  run_count integer NOT NULL DEFAULT 1 CHECK (run_count >= 1),
  last_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_id, invoice_ref),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES machvon.ai_provider (tenant_id, id),
  CHECK (period_to >= period_from)
);
ALTER TABLE machvon.ai_invoice_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_invoice_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_invoice_reconciliation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_invoice_reconciliation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX ai_invoice_reconciliation_provider_idx ON machvon.ai_invoice_reconciliation (tenant_id, provider_id);
CREATE INDEX ai_invoice_reconciliation_owner_idx ON machvon.ai_invoice_reconciliation (tenant_id, owner_id);

-- What the invoice said and who owns the variance never change; a run may only move VARIANCE to VARIANCE or RECONCILED, and a reconciled invoice stays reconciled.
CREATE FUNCTION machvon.guard_ai_invoice_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a reconciliation is kept for good' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.invoice_ref IS DISTINCT FROM OLD.invoice_ref
     OR NEW.invoice_amount IS DISTINCT FROM OLD.invoice_amount OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.period_from IS DISTINCT FROM OLD.period_from OR NEW.period_to IS DISTINCT FROM OLD.period_to
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what an invoice said and who owns its variance do not change' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'RECONCILED' THEN
    RAISE EXCEPTION 'a reconciled invoice stays reconciled' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_invoice_reconciliation_guard BEFORE UPDATE OR DELETE ON machvon.ai_invoice_reconciliation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_invoice_reconciliation();
CREATE TRIGGER ai_invoice_reconciliation_no_truncate BEFORE TRUNCATE ON machvon.ai_invoice_reconciliation
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_ai_invoice_reconciliation();
REVOKE DELETE, TRUNCATE ON TABLE machvon.ai_invoice_reconciliation FROM machvon_app;

-- No reconciliation edits what an attempt cost: the figures of an attempt (tokens, price, cost) are fixed when it is written; the application may only say why it was not used (outcome) and how its
-- reconciliation stands (reconcile_status, invoice_ref).
CREATE FUNCTION machvon.guard_llm_attempt_figures() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'machvon_owner' THEN RETURN NEW; END IF;
  IF NEW.input_total IS DISTINCT FROM OLD.input_total OR NEW.cached_input IS DISTINCT FROM OLD.cached_input OR NEW.output_total IS DISTINCT FROM OLD.output_total
     OR NEW.cost IS DISTINCT FROM OLD.cost OR NEW.cost_vnd IS DISTINCT FROM OLD.cost_vnd OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.pricing_version_id IS DISTINCT FROM OLD.pricing_version_id
     OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.ai_request_id IS DISTINCT FROM OLD.ai_request_id THEN
    RAISE EXCEPTION 'what an attempt cost does not change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER llm_attempt_figures_guard BEFORE UPDATE ON machvon.llm_attempt
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_llm_attempt_figures();
