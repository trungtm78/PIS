-- ST-AUD-002: conclusions, findings and recommendations of an engagement, with the financial total check (AUD 3.2, BR-AUD-01, BR-AUD-05, BR-AUD-06).
--
-- 1. A conclusion carries a summary in words, and dates that do not come before the day it was issued; a revision has at most one successor.
-- 2. A recommendation that is not financial carries no money (nothing to recover, nothing to add up); a financial one carries it (V002).
-- 3. The financial recommendations of a conclusion never add up to more than its total (BR-AUD-05). The command checks it under a lock of the conclusion and tells the caller (422
--    FINANCIAL_TOTAL_MISMATCH); this guard is the same rule at the table, so that no other writer (a job, a consumer, a later story) can break it. A cancelled recommendation does not count.

ALTER TABLE machvon.audit_conclusion
  ADD CONSTRAINT audit_conclusion_summary_chk CHECK (length(trim(summary)) >= 10),
  ADD CONSTRAINT audit_conclusion_due_chk CHECK ((implementation_due_on IS NULL OR implementation_due_on >= issued_on) AND (report_due_on IS NULL OR report_due_on >= issued_on));

CREATE UNIQUE INDEX audit_conclusion_successor_uq ON machvon.audit_conclusion (tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

ALTER TABLE machvon.audit_finding
  ADD CONSTRAINT audit_finding_code_chk CHECK (length(trim(finding_code)) >= 1),
  ADD CONSTRAINT audit_finding_description_chk CHECK (length(trim(description)) >= 10);

ALTER TABLE machvon.audit_recommendation
  ADD CONSTRAINT audit_recommendation_code_chk CHECK (length(trim(rec_code)) >= 1),
  ADD CONSTRAINT audit_recommendation_description_chk CHECK (length(trim(description)) >= 10),
  ADD CONSTRAINT audit_recommendation_amount_kind_chk CHECK (rec_type IN ('FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT') OR (amount_vnd IS NULL AND recovered_vnd = 0));

CREATE FUNCTION machvon.audit_recommendation_total_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  total numeric(24,0);
  others numeric(24,0);
BEGIN
  IF NEW.rec_type NOT IN ('FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT') OR NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;
  -- The conclusion is locked first, so that two recommendations added at the same time are added up one after the other.
  SELECT c.total_financial_vnd INTO total FROM machvon.audit_conclusion c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.conclusion_id FOR UPDATE;
  IF total IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(r.amount_vnd), 0) INTO others
    FROM machvon.audit_recommendation r
   WHERE r.tenant_id = NEW.tenant_id AND r.conclusion_id = NEW.conclusion_id AND r.id <> NEW.id
     AND r.rec_type IN ('FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT') AND r.status <> 'CANCELLED';
  IF others + NEW.amount_vnd > total THEN
    RAISE EXCEPTION 'the financial recommendations of a conclusion exceed its total' USING ERRCODE = '23514', CONSTRAINT = 'audit_recommendation_total_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_recommendation_total_guard
  BEFORE INSERT OR UPDATE OF amount_vnd, rec_type, status, conclusion_id ON machvon.audit_recommendation
  FOR EACH ROW EXECUTE FUNCTION machvon.audit_recommendation_total_guard();
