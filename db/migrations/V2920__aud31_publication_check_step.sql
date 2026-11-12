-- Authored by hand (not generated): the check step of a publication request (BC.02, lane AUD3; docs/bi-dashboards.md). A management report that a person made themself (a version of a dashboard, the certified metric of an export)
-- carries three signatures: who prepared it, who checked it, who approved it. The request to publish already records who asked and who decided (V002, V1582); this adds the person in between.
--   * `checked_by`, `checked_at`, `check_comment`: written once, while the request is PENDING, by somebody who is neither the one who asked nor (later) the one who decides. The step is optional: a tenant that never checks
--     publishes with the two people it always had, and the block then shows the check as not taken (nobody is invented as the checker).
--   * the database holds the separation whatever the application checked first: checked_by <> requested_by, checked_by <> decided_by, the person and the instant come together, and a comment needs a checker.
--   * the guard of the request lets the check columns move once, from empty to written, while the request is PENDING; after that, or once the request is decided or withdrawn, they never change.

ALTER TABLE machvon.bi_publication_request
  ADD COLUMN checked_by uuid,
  ADD COLUMN checked_at timestamptz,
  ADD COLUMN check_comment text;

ALTER TABLE machvon.bi_publication_request
  ADD CONSTRAINT bi_publication_request_check_pair_chk CHECK ((checked_by IS NULL) = (checked_at IS NULL)),
  ADD CONSTRAINT bi_publication_request_check_maker_chk CHECK (checked_by IS NULL OR checked_by <> requested_by),
  ADD CONSTRAINT bi_publication_request_check_decider_chk CHECK (checked_by IS NULL OR decided_by IS NULL OR checked_by <> decided_by),
  ADD CONSTRAINT bi_publication_request_check_comment_chk CHECK (check_comment IS NULL OR (checked_by IS NOT NULL AND check_comment = btrim(check_comment) AND char_length(check_comment) BETWEEN 1 AND 2000));

CREATE OR REPLACE FUNCTION machvon.guard_bi_publication_request() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'publication requests are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.object_kind, NEW.object_id, NEW.requested_by, NEW.checks_json, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.object_kind, OLD.object_id, OLD.requested_by, OLD.checks_json, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a publication request asks, who asked and the checks it was made with never change' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'PENDING' AND NEW.status IN ('DECIDED', 'WITHDRAWN'))) THEN
    RAISE EXCEPTION 'a publication request cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'PENDING' AND (NEW.decision, NEW.decided_by, NEW.decided_at, NEW.comment) IS DISTINCT FROM (OLD.decision, OLD.decided_by, OLD.decided_at, OLD.comment) THEN
    RAISE EXCEPTION 'the decision on a publication request is written once' USING ERRCODE = '42501';
  END IF;
  IF (NEW.checked_by, NEW.checked_at, NEW.check_comment) IS DISTINCT FROM (OLD.checked_by, OLD.checked_at, OLD.check_comment)
     AND (OLD.status <> 'PENDING' OR OLD.checked_by IS NOT NULL) THEN
    RAISE EXCEPTION 'the check of a publication request is written once, while it is pending' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;
