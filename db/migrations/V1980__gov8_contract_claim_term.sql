-- Authored by hand (not generated): the limitation terms of the claims of a contract (GOV-8, roadmap G1-9, docs/ctr-claims.md).
-- Most contracts give each side a limited time to notify a claim and to detail it, and some say a late notice loses the claim. The periods are different in every contract, so they are never a constant of the
-- application and never a default borrowed from an international form: a term is entered from the clauses of the signed contract (the clause is named, the signed document may be attached), proposed by one person and
-- approved by another (maker is not checker, the CHECK keeps it true whatever the application does), and only an APPROVED term gives a claim a limitation clock. A contract without one has none and says so.
--   * one APPROVED term per (contract, claimant side) at any time and at most one PROPOSED: a new approval supersedes the previous one (it keeps its history, nothing is deleted);
--   * a period that is NULL is a period the contract does not give (no clock for that step);
--   * `template_code` records which template of the rule `CLAIM_TERM_TEMPLATE` the proposer copied the numbers from (null when typed from the contract): a template is an example, never applied by itself.

CREATE TABLE machvon.contract_claim_term (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  claimant_side text NOT NULL,
  notice_days integer,
  particulars_days integer,
  response_days integer,
  settlement_days integer,
  basis text NOT NULL DEFAULT 'CALENDAR_DAYS',
  particulars_from text NOT NULL DEFAULT 'NOTICE',
  bar_effect text NOT NULL DEFAULT 'NOT_STATED',
  clause_reference text NOT NULL,
  basis_document_version_id uuid,
  template_code text,
  status text NOT NULL DEFAULT 'PROPOSED',
  decision_note text,
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  superseded_by_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES machvon.contract (tenant_id, id),
  FOREIGN KEY (tenant_id, basis_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  FOREIGN KEY (tenant_id, superseded_by_id) REFERENCES machvon.contract_claim_term (tenant_id, id),
  CONSTRAINT contract_claim_term_side_chk CHECK (claimant_side IN ('CONTRACTOR', 'OWNER')),
  CONSTRAINT contract_claim_term_status_chk CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  CONSTRAINT contract_claim_term_basis_chk CHECK (basis IN ('CALENDAR_DAYS', 'WORKING_DAYS')),
  CONSTRAINT contract_claim_term_from_chk CHECK (particulars_from IN ('AWARENESS', 'NOTICE')),
  CONSTRAINT contract_claim_term_effect_chk CHECK (bar_effect IN ('BARS_CLAIM', 'REDUCES_RELIEF', 'NONE', 'NOT_STATED')),
  CONSTRAINT contract_claim_term_periods_chk CHECK (
    (notice_days IS NULL OR notice_days BETWEEN 1 AND 3650) AND (particulars_days IS NULL OR particulars_days BETWEEN 1 AND 3650)
    AND (response_days IS NULL OR response_days BETWEEN 1 AND 3650) AND (settlement_days IS NULL OR settlement_days BETWEEN 1 AND 3650)
    AND (notice_days IS NOT NULL OR particulars_days IS NOT NULL OR response_days IS NOT NULL OR settlement_days IS NOT NULL)
  ),
  CONSTRAINT contract_claim_term_bar_needs_period_chk CHECK (bar_effect NOT IN ('BARS_CLAIM', 'REDUCES_RELIEF') OR notice_days IS NOT NULL OR particulars_days IS NOT NULL),
  CONSTRAINT contract_claim_term_clause_chk CHECK (clause_reference = btrim(clause_reference) AND char_length(clause_reference) BETWEEN 3 AND 200),
  CONSTRAINT contract_claim_term_template_chk CHECK (template_code IS NULL OR template_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT contract_claim_term_note_chk CHECK (decision_note IS NULL OR (decision_note = btrim(decision_note) AND char_length(decision_note) BETWEEN 5 AND 2000)),
  CONSTRAINT contract_claim_term_decided_chk CHECK ((status = 'PROPOSED') = (decided_by IS NULL AND decided_at IS NULL)),
  CONSTRAINT contract_claim_term_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT contract_claim_term_version_chk CHECK (version >= 1)
);

CREATE UNIQUE INDEX contract_claim_term_approved_uq ON machvon.contract_claim_term (tenant_id, contract_id, claimant_side) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX contract_claim_term_proposed_uq ON machvon.contract_claim_term (tenant_id, contract_id, claimant_side) WHERE status = 'PROPOSED';
CREATE INDEX contract_claim_term_contract_id_idx ON machvon.contract_claim_term (tenant_id, contract_id, proposed_at DESC, id DESC);
CREATE INDEX contract_claim_term_basis_document_version_id_idx ON machvon.contract_claim_term (tenant_id, basis_document_version_id) WHERE basis_document_version_id IS NOT NULL;
CREATE INDEX contract_claim_term_superseded_by_id_idx ON machvon.contract_claim_term (tenant_id, superseded_by_id) WHERE superseded_by_id IS NOT NULL;

-- A term is never edited once it has been proposed: only its decision moves (PROPOSED to APPROVED or REJECTED, APPROVED to SUPERSEDED), and the numbers, the clause and the people stay as they were written.
CREATE FUNCTION machvon.guard_contract_claim_term() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.claimant_side IS DISTINCT FROM OLD.claimant_side
     OR NEW.notice_days IS DISTINCT FROM OLD.notice_days OR NEW.particulars_days IS DISTINCT FROM OLD.particulars_days
     OR NEW.response_days IS DISTINCT FROM OLD.response_days OR NEW.settlement_days IS DISTINCT FROM OLD.settlement_days
     OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.particulars_from IS DISTINCT FROM OLD.particulars_from OR NEW.bar_effect IS DISTINCT FROM OLD.bar_effect
     OR NEW.clause_reference IS DISTINCT FROM OLD.clause_reference OR NEW.basis_document_version_id IS DISTINCT FROM OLD.basis_document_version_id
     OR NEW.template_code IS DISTINCT FROM OLD.template_code OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
    RAISE EXCEPTION 'a proposed term of claims is never edited: propose a new one' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'PROPOSED' AND NEW.status IN ('PROPOSED', 'APPROVED', 'REJECTED')) OR (OLD.status = 'APPROVED' AND NEW.status IN ('APPROVED', 'SUPERSEDED'))
          OR (OLD.status = NEW.status)) THEN
    RAISE EXCEPTION 'a term of claims moves from proposed to approved or rejected, and from approved to superseded, and no other way' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contract_claim_term_guard BEFORE UPDATE ON machvon.contract_claim_term FOR EACH ROW EXECUTE FUNCTION machvon.guard_contract_claim_term();

ALTER TABLE machvon.contract_claim_term ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_claim_term FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_claim_term AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_claim_term AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contract_claim_term FROM machvon_app;

COMMENT ON TABLE machvon.contract_claim_term IS 'GOV-8: the limits a contract gives the claims of one side (notice, particulars, response, settlement), entered from its clauses, proposed by one person and approved by another; none is a default.';
