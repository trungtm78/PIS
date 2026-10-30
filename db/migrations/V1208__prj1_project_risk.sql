-- Authored by hand (not generated): the risk register of a project (ST-PRJ-010, PRJ 3.1 F8, BR-PRJ-07, PRJ-16).
-- The table project_risk comes from the generated schema (V002): its score is a generated column, its code is unique inside the project and a closed or accepted risk names a reason.
-- This adds what the register relies on: the shape of the words, the reason of an end being a real reason and only on an ended risk, a guard that keeps an ended risk as it was and
-- lets a live one move on towards escalation but never back, the read by project, and the loss of the right to delete (a risk is kept for good, 10 years after it ended).

ALTER TABLE machvon.project_risk
  ADD CONSTRAINT project_risk_words_chk CHECK (
    code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$'
    AND title = btrim(title) AND char_length(title) BETWEEN 3 AND 300
    AND description = btrim(description) AND char_length(description) BETWEEN 3 AND 2000
    AND mitigation = btrim(mitigation) AND char_length(mitigation) BETWEEN 3 AND 2000
  ),
  ADD CONSTRAINT project_risk_reason_chk CHECK (
    (status IN ('CLOSED', 'ACCEPTED')) = (closed_reason IS NOT NULL)
    AND (closed_reason IS NULL OR (closed_reason = btrim(closed_reason) AND char_length(closed_reason) BETWEEN 10 AND 2000))
  );

CREATE INDEX project_risk_status_idx ON machvon.project_risk (tenant_id, project_id, status);

-- A risk goes OPEN -> MITIGATING -> ESCALATED and ends CLOSED or ACCEPTED from any of those; an ended risk never changes again, and what places the risk
-- (its project, who wrote it and when) never changes at all.
CREATE FUNCTION machvon.guard_project_risk_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  order_old int;
  order_new int;
BEGIN
  IF OLD.status IN ('CLOSED', 'ACCEPTED') THEN
    RAISE EXCEPTION 'a closed or accepted risk is never changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a risk keeps its project and its author' USING ERRCODE = '23514';
  END IF;
  order_old := CASE OLD.status WHEN 'OPEN' THEN 0 WHEN 'MITIGATING' THEN 1 ELSE 2 END;
  order_new := CASE NEW.status WHEN 'OPEN' THEN 0 WHEN 'MITIGATING' THEN 1 WHEN 'ESCALATED' THEN 2 ELSE 3 END;
  IF order_new < order_old THEN
    RAISE EXCEPTION 'a risk does not go back to an earlier status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER project_risk_update_guard BEFORE UPDATE ON machvon.project_risk
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_project_risk_update();

REVOKE DELETE, TRUNCATE ON machvon.project_risk FROM machvon_app;
