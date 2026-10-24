-- Authored by hand (not generated): the appropriation register (ST-CAP-001, CAP 3.1 F1, BR-CAP-02 and BR-CAP-04).
-- V002 gave `appropriation` its columns, its ceiling CHECK (allocated <= amount), the carry-over and extension CHECKs and the
-- four-eyes CHECK. An appropriation is the capital assigned to the province by one decision document: the denominator every plan
-- line is drawn from, so the database holds what the application checked first:
--   * the text of the issuing authority and the years are well formed, and a source year is the plan year unless the capital is carried over;
--   * an amount is above zero, and a revision (revision > 1) always names the appropriation it replaces;
--   * a decision line (document, fund source, program, year, origin, level) is registered once, and an appropriation has one live revision;
--   * the document that backs the assignment and the one that allows an extension are documents of the tenant;
--   * the content of an appropriation is never edited (a change of amount is a new revision), a decision is final, and the allocated
--     total changes only through the allocation command, which says so with the transaction setting `app.cap_allocation_write`.

-- A decision can also reject a draft: REJECTED is final.
ALTER TABLE machvon.appropriation DROP CONSTRAINT appropriation_status_check;
ALTER TABLE machvon.appropriation
  ADD CONSTRAINT appropriation_status_check CHECK (status IN ('DRAFT', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED'));

ALTER TABLE machvon.appropriation
  ADD CONSTRAINT appropriation_amount_positive_chk CHECK (amount_vnd > 0),
  ADD CONSTRAINT appropriation_authority_text_chk CHECK (issuing_authority = btrim(issuing_authority) AND char_length(issuing_authority) BETWEEN 2 AND 300),
  ADD CONSTRAINT appropriation_year_range_chk CHECK (plan_year BETWEEN 1990 AND 2100 AND source_year BETWEEN 1990 AND 2100),
  ADD CONSTRAINT appropriation_source_year_chk CHECK (origin = 'CARRYOVER' OR source_year = plan_year),
  ADD CONSTRAINT appropriation_revision_chain_chk CHECK ((revision = 1) = (supersedes_id IS NULL) AND supersedes_id IS DISTINCT FROM id),
  ADD CONSTRAINT appropriation_approver_chk CHECK (status IN ('DRAFT', 'REJECTED') OR approved_by IS NOT NULL);

ALTER TABLE machvon.appropriation
  ADD CONSTRAINT appropriation_decision_document_fk FOREIGN KEY (tenant_id, decision_document_id) REFERENCES machvon.document (tenant_id, id),
  ADD CONSTRAINT appropriation_extension_document_fk FOREIGN KEY (tenant_id, extension_document_id) REFERENCES machvon.document (tenant_id, id);

-- One decision line is registered once. A revision carries the line of the appropriation it replaces and is not a second registration of it;
-- a rejected draft frees the line for a corrected registration.
CREATE UNIQUE INDEX appropriation_decision_line_uq ON machvon.appropriation
  (tenant_id, decision_document_id, fund_source_version_id, coalesce(program_master_version_id, '00000000-0000-0000-0000-000000000000'::uuid), plan_year, origin, budget_level)
  WHERE supersedes_id IS NULL AND status <> 'REJECTED';

-- An appropriation has one live revision at a time: a second revision of it, while one is a draft or published, is refused.
CREATE UNIQUE INDEX appropriation_live_successor_uq ON machvon.appropriation (tenant_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL AND status <> 'REJECTED';

CREATE FUNCTION machvon.guard_appropriation_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.capital_plan_id IS DISTINCT FROM OLD.capital_plan_id
     OR NEW.fund_source_version_id IS DISTINCT FROM OLD.fund_source_version_id
     OR NEW.plan_year IS DISTINCT FROM OLD.plan_year
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.budget_level IS DISTINCT FROM OLD.budget_level
     OR NEW.program_master_version_id IS DISTINCT FROM OLD.program_master_version_id
     OR NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd
     OR NEW.decision_document_id IS DISTINCT FROM OLD.decision_document_id
     OR NEW.issuing_authority IS DISTINCT FROM OLD.issuing_authority
     OR NEW.is_extended IS DISTINCT FROM OLD.is_extended
     OR NEW.extended_to IS DISTINCT FROM OLD.extended_to
     OR NEW.extension_document_id IS DISTINCT FROM OLD.extension_document_id
     OR NEW.source_year IS DISTINCT FROM OLD.source_year
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an appropriation is never edited: a change of amount is a new revision' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('SUPERSEDED', 'REJECTED') THEN
    RAISE EXCEPTION 'a superseded or rejected appropriation never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (('DRAFT', 'PUBLISHED'), ('DRAFT', 'APPROVED'), ('APPROVED', 'PUBLISHED'), ('DRAFT', 'REJECTED'), ('APPROVED', 'REJECTED'), ('PUBLISHED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'the state transition of the appropriation is not allowed' USING ERRCODE = '23514';
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'the approver of an appropriation is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.allocated_total_vnd IS DISTINCT FROM OLD.allocated_total_vnd
     AND (coalesce(current_setting('app.cap_allocation_write', true), '') <> 'on' OR NEW.status <> 'PUBLISHED') THEN
    RAISE EXCEPTION 'the allocated total of a published appropriation changes only through the allocation command' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER appropriation_guard BEFORE UPDATE ON machvon.appropriation
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_appropriation_update();

-- An appropriation is capital that was assigned: it is kept for good, and a mistake is corrected by a revision.
REVOKE DELETE, TRUNCATE ON TABLE machvon.appropriation FROM machvon_app;

-- Reading the register by year and origin, and a revision to its predecessor, goes by index (the foreign key indexes come from V002).
CREATE INDEX appropriation_year_origin_idx ON machvon.appropriation (tenant_id, plan_year, origin, status);
