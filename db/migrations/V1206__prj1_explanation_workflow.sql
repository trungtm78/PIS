-- ST-PRJ-006: explanation requests with due dates, overdue handling and review (PRJ 3.1 F10, BR-PRJ-08).
--
-- V002 gave the table its columns, the subject check, the four-eyes check (the reviewer is not the one who answered) and the rule that a response must have a text.
-- This migration makes the database say the rest:
--   * the first due date is kept: when a review returns the request with a new date, `due_at` moves and `original_due_at` stays, so "overdue" is told with the date it was first asked for;
--   * one request is open at a time for a subject, a trigger and a period (409 EXPLANATION_ALREADY_OPEN), and a warning has one request, however often its event is delivered;
--   * the jobs and the list read by due date and by the person asked.

ALTER TABLE machvon.explanation_request ADD COLUMN original_due_at timestamptz;
UPDATE machvon.explanation_request SET original_due_at = due_at;

-- A request that does not name its first date is asked for on the date it gives: the column is filled from `due_at`, and never left empty.
CREATE FUNCTION machvon.explanation_original_due() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.original_due_at := coalesce(NEW.original_due_at, NEW.due_at);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER explanation_original_due BEFORE INSERT ON machvon.explanation_request FOR EACH ROW EXECUTE FUNCTION machvon.explanation_original_due();

ALTER TABLE machvon.explanation_request
  ADD CONSTRAINT explanation_original_due_chk CHECK (original_due_at IS NOT NULL),
  ADD CONSTRAINT explanation_review_chk CHECK ((status NOT IN ('ACCEPTED', 'RETURNED')) OR (reviewed_by IS NOT NULL AND review_note IS NOT NULL)),
  ADD CONSTRAINT explanation_text_chk CHECK (char_length(question) BETWEEN 10 AND 2000 AND (response_text IS NULL OR char_length(response_text) BETWEEN 20 AND 2000));

CREATE UNIQUE INDEX explanation_open_uq ON machvon.explanation_request
  (tenant_id, subject_kind, coalesce(project_id, unit_id), trigger_code, coalesce(period_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('REQUESTED', 'OVERDUE', 'RESPONDED', 'RETURNED');
CREATE UNIQUE INDEX explanation_warning_uq ON machvon.explanation_request (tenant_id, warning_id) WHERE warning_id IS NOT NULL AND status <> 'CANCELLED';
CREATE INDEX explanation_due_idx ON machvon.explanation_request (tenant_id, due_at) WHERE status IN ('REQUESTED', 'RETURNED');
CREATE INDEX explanation_assignee_idx ON machvon.explanation_request (tenant_id, requested_from_membership_id, status);
CREATE INDEX explanation_list_idx ON machvon.explanation_request (tenant_id, created_at DESC, id DESC);
