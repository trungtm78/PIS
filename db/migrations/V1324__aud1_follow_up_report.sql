-- ST-AUD-005: the report of the results of the recommendations, issued through DOC, and the closure of an engagement (AUD 3.6, BR-AUD-04, BR-AUD-10).
--
-- 1. A report freezes its figures on the day it asks DOC to issue it: the totals, the payload that carries them (kept in the file store under `payload_ref`) and the SHA-256 of that payload never
--    change afterwards, so what DOC issues is what was frozen. Only the status and what DOC answers move (ISSUE_REQUESTED to ISSUED or REJECTED, ISSUED to RECALLED), and a report is never deleted.
-- 2. A report asks for one issue of one day for one conclusion at a time: while one is waiting for DOC or issued, another for the same conclusion and day is refused; a rejected or recalled report
--    is followed by a new revision.
-- 3. The person who approved the report (the signer DOC names) is never the person who asked for it (V002 `audit_follow_up_report_sod_chk`).

ALTER TABLE machvon.audit_follow_up_report ADD COLUMN payload_ref text;
-- The event the request was sent under: DOC makes one request of one event, so a repeated send is one request.
ALTER TABLE machvon.audit_follow_up_report ADD COLUMN issue_event_id uuid;
-- The unit that drafts the report for DOC.
ALTER TABLE machvon.audit_follow_up_report ADD COLUMN drafting_unit_id uuid;
-- Why DOC did not issue it (the reject code of DOC), and when it was issued.
ALTER TABLE machvon.audit_follow_up_report ADD COLUMN reject_code text;
ALTER TABLE machvon.audit_follow_up_report ADD COLUMN issued_at timestamptz;

ALTER TABLE machvon.audit_follow_up_report ADD CONSTRAINT audit_follow_up_report_request_chk
  CHECK (status = 'DRAFT' OR (payload_ref IS NOT NULL AND issue_event_id IS NOT NULL AND drafting_unit_id IS NOT NULL));
ALTER TABLE machvon.audit_follow_up_report ADD CONSTRAINT audit_follow_up_report_reject_chk
  CHECK ((status = 'REJECTED') = (reject_code IS NOT NULL));
ALTER TABLE machvon.audit_follow_up_report ADD CONSTRAINT audit_follow_up_report_issued_at_chk
  CHECK ((status IN ('ISSUED', 'RECALLED')) = (issued_at IS NOT NULL));

-- One live report for a conclusion and a day; the revision of the next one comes after a rejection or a recall.
CREATE UNIQUE INDEX audit_follow_up_report_live_uq ON machvon.audit_follow_up_report (tenant_id, conclusion_id, as_of_date) WHERE status IN ('DRAFT', 'ISSUE_REQUESTED', 'ISSUED');
CREATE UNIQUE INDEX audit_follow_up_report_event_uq ON machvon.audit_follow_up_report (tenant_id, issue_event_id) WHERE issue_event_id IS NOT NULL;

CREATE FUNCTION machvon.audit_follow_up_report_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a report of results is kept: it is replaced by a new revision, never deleted' USING ERRCODE = '23514', CONSTRAINT = 'audit_follow_up_report_guard';
  END IF;
  IF NEW.engagement_id <> OLD.engagement_id OR NEW.conclusion_id <> OLD.conclusion_id OR NEW.as_of_date <> OLD.as_of_date OR NEW.revision <> OLD.revision
     OR NEW.totals_json IS DISTINCT FROM OLD.totals_json OR NEW.payload_sha256 <> OLD.payload_sha256 OR NEW.payload_ref IS DISTINCT FROM OLD.payload_ref
     OR NEW.issue_event_id IS DISTINCT FROM OLD.issue_event_id OR NEW.drafting_unit_id IS DISTINCT FROM OLD.drafting_unit_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'the figures of a report and what it was asked to issue are frozen' USING ERRCODE = '23514', CONSTRAINT = 'audit_follow_up_report_frozen_guard';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'ISSUE_REQUESTED')
    OR (OLD.status = 'ISSUE_REQUESTED' AND NEW.status IN ('ISSUED', 'REJECTED'))
    OR (OLD.status = 'ISSUED' AND NEW.status = 'RECALLED')) THEN
    RAISE EXCEPTION 'a report does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'audit_follow_up_report_edges_guard';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_follow_up_report_guard
  BEFORE UPDATE OR DELETE ON machvon.audit_follow_up_report
  FOR EACH ROW EXECUTE FUNCTION machvon.audit_follow_up_report_guard();
