-- Authored by hand (not generated): the availability control policy and the commitment of capital against it (ST-CAP-005, CAP.md F4, BR-CAP-06).
-- V002 gave `avc_policy` (the thresholds with warn <= block, one revision per code, the maker never the approver). What the policy needs to be a record that spending
-- can rely on is put into the database here, whatever the application checked first:
--   * the scope names what it says: a tenant policy has no reference, a unit policy a unit, a fund source policy the business key of the fund source and a project group
--     policy one of the groups QTQG, A, B and C; a policy has a code and a legal basis as written (trimmed), and its period never ends before it starts;
--   * a policy is never deleted and what it says never changes: a different threshold is the next revision. The only thing that moves is its end date, once, when a later
--     revision of the same code takes over, and only earlier, never later; it is DRAFT until another person publishes it (approved_by is set exactly when it is published);
--   * two published policies of the same scope and control object never overlap in time, so the policy that governs a day is never a matter of order;
--   * the ledger takes the commitment of a contract: `capital_ledger_entry.source_ref_kind` gains CONTRACT, so the activation of a contract is a business fact that can be
--     posted once (the dedupe key of V002 already holds it).

ALTER TABLE machvon.avc_policy
  ADD CONSTRAINT avc_policy_scope_shape_chk CHECK (
    (scope_kind = 'TENANT' AND scope_ref_id IS NULL AND scope_value IS NULL)
    OR (scope_kind = 'UNIT' AND scope_ref_id IS NOT NULL AND scope_value IS NULL)
    OR (scope_kind = 'FUND_SOURCE' AND scope_ref_id IS NULL AND scope_value ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$')
    OR (scope_kind = 'PROJECT_GROUP' AND scope_ref_id IS NULL AND scope_value IN ('QTQG', 'A', 'B', 'C'))),
  ADD CONSTRAINT avc_policy_period_chk CHECK (effective_until IS NULL OR effective_until >= effective_from),
  ADD CONSTRAINT avc_policy_approval_chk CHECK ((status = 'DRAFT') = (approved_by IS NULL)),
  ADD CONSTRAINT avc_policy_code_chk CHECK (policy_code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$'),
  ADD CONSTRAINT avc_policy_basis_chk CHECK (legal_basis = btrim(legal_basis) AND char_length(legal_basis) BETWEEN 3 AND 2000);

REVOKE DELETE, TRUNCATE ON TABLE machvon.avc_policy FROM machvon_app;

CREATE INDEX avc_policy_resolve_idx ON machvon.avc_policy (tenant_id, control_object, scope_kind, effective_from) WHERE status = 'PUBLISHED';

CREATE FUNCTION machvon.guard_avc_policy() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an availability control policy is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.policy_code, NEW.scope_kind, NEW.scope_ref_id, NEW.scope_value, NEW.control_object, NEW.warn_pct, NEW.block_pct, NEW.include_reservations,
      NEW.legal_basis, NEW.effective_from, NEW.revision, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.policy_code, OLD.scope_kind, OLD.scope_ref_id, OLD.scope_value, OLD.control_object, OLD.warn_pct, OLD.block_pct, OLD.include_reservations,
      OLD.legal_basis, OLD.effective_from, OLD.revision, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a policy says never changes: the next revision says something else' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'a policy moves from DRAFT to PUBLISHED and no other way (% to %)', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.effective_until IS DISTINCT FROM OLD.effective_until THEN
    RAISE EXCEPTION 'the period of a draft is fixed with it' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.effective_until IS DISTINCT FROM OLD.effective_until
     AND (NEW.effective_until IS NULL OR (OLD.effective_until IS NOT NULL AND NEW.effective_until > OLD.effective_until)) THEN
    RAISE EXCEPTION 'the period of a published policy only ends earlier' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'the approver of a published policy never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'PUBLISHED' AND EXISTS (
       SELECT 1 FROM machvon.avc_policy other
        WHERE other.tenant_id = NEW.tenant_id AND other.id <> NEW.id AND other.status = 'PUBLISHED'
          AND other.control_object = NEW.control_object AND other.scope_kind = NEW.scope_kind
          AND other.scope_ref_id IS NOT DISTINCT FROM NEW.scope_ref_id AND other.scope_value IS NOT DISTINCT FROM NEW.scope_value
          AND other.effective_from <= coalesce(NEW.effective_until, 'infinity'::date)
          AND NEW.effective_from <= coalesce(other.effective_until, 'infinity'::date)) THEN
    RAISE EXCEPTION 'two published policies of one scope never overlap in time' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER avc_policy_guard BEFORE UPDATE OR DELETE ON machvon.avc_policy
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_avc_policy();

ALTER TABLE machvon.capital_ledger_entry DROP CONSTRAINT capital_ledger_entry_source_ref_kind_check;
ALTER TABLE machvon.capital_ledger_entry ADD CONSTRAINT capital_ledger_entry_source_ref_kind_check
  CHECK (source_ref_kind IN ('CAPITAL_PLAN', 'APPROPRIATION', 'RESERVATION', 'PAYMENT_REQUEST', 'TREASURY_TRANSACTION', 'REALLOCATION', 'EXTENSION', 'YEAR_CLOSE', 'CONTRACT'));
