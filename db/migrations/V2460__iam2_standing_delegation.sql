-- Authored by hand (not generated): the permanent (standing) delegation of IAM-2. It is a delegation_grant of a new kind: so that the approval engine, the door of the decision and the signing authority, which all read delegation_grant
-- live, honour it without a change. The date it works until is its review date (valid_until = the next review): a delegation that is not reviewed in time stops working at that instant, as a time-boxed one that ran out. A review
-- moves valid_until forward; nothing else of what it grants changes. Additions only; a delegation made before this migration is a TIMEBOXED one and stays as it was.

-- The report periods a role grant, a delegation or an acting grant is limited to (`2026-Q3`, `2026-M03`, `2026-H1`, `2026`); null is not limited.
CREATE FUNCTION machvon.period_codes_ok(codes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT coalesce(cardinality(codes) BETWEEN 1 AND 24 AND NOT EXISTS (SELECT 1 FROM unnest(codes) AS c WHERE c !~ '^[0-9]{4}(-(M(0[1-9]|1[0-2])|Q[1-4]|H[12]))?$'), false)
$fn$;

ALTER TABLE machvon.delegation_grant
  ADD COLUMN kind text NOT NULL DEFAULT 'TIMEBOXED',
  ADD COLUMN period_codes text[],
  -- How a permanent delegation ends besides the review: SOURCE_HOLDS (the delegator loses the authority), UNTIL_EVENT (a named event, ended by a person who records it), UNTIL_DATE (at end_on).
  ADD COLUMN end_condition_kind text,
  ADD COLUMN end_condition_text text,
  ADD COLUMN end_on timestamptz,
  ADD COLUMN last_reviewed_at timestamptz,
  ADD COLUMN last_reviewed_by uuid,
  ADD COLUMN review_count integer NOT NULL DEFAULT 0,
  -- When the delegator was told that the review falls due: once for each review date.
  ADD COLUMN review_reminded_at timestamptz,
  -- The request that was approved to make it (permanent delegations only; the request names the second approver).
  ADD COLUMN request_id uuid;

-- The 90 days limit stays for a time-boxed delegation; a permanent one has no length of its own, only a review date at most a year ahead (kernel rule).
DO $do$
DECLARE
  existing text;
BEGIN
  FOR existing IN SELECT conname FROM pg_constraint WHERE conrelid = 'machvon.delegation_grant'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%90 days%' LOOP
    EXECUTE format('ALTER TABLE machvon.delegation_grant DROP CONSTRAINT %I', existing);
  END LOOP;
END
$do$;

ALTER TABLE machvon.delegation_grant
  DROP CONSTRAINT delegation_end_chk,
  ADD CONSTRAINT delegation_window_chk CHECK (valid_from < valid_until AND (kind <> 'TIMEBOXED' OR valid_until <= valid_from + interval '90 days')),
  ADD CONSTRAINT delegation_kind_chk CHECK (kind IN ('TIMEBOXED', 'PERMANENT')),
  ADD CONSTRAINT delegation_period_chk CHECK (period_codes IS NULL OR machvon.period_codes_ok(period_codes)),
  ADD CONSTRAINT delegation_standing_chk CHECK (
    CASE kind
      WHEN 'TIMEBOXED' THEN end_condition_kind IS NULL AND end_condition_text IS NULL AND end_on IS NULL AND request_id IS NULL AND review_count = 0
      ELSE end_condition_kind IS NOT NULL AND end_condition_kind IN ('SOURCE_HOLDS', 'UNTIL_EVENT', 'UNTIL_DATE')
        AND end_condition_text IS NOT NULL AND char_length(btrim(end_condition_text)) BETWEEN 10 AND 500
        AND ((end_condition_kind = 'UNTIL_DATE') = (end_on IS NOT NULL))
        AND (end_on IS NULL OR valid_until <= end_on)
        AND request_id IS NOT NULL
    END
  ),
  ADD CONSTRAINT delegation_end_chk CHECK (
    (status = 'Ended') = (end_reason IS NOT NULL AND ended_at IS NOT NULL)
    AND (end_reason IS NULL OR end_reason IN ('EXPIRED', 'SOURCE_ENDED', 'REVIEW_LAPSED', 'END_CONDITION_MET'))
    AND (end_reason IS NULL OR (end_reason IN ('REVIEW_LAPSED', 'END_CONDITION_MET')) = (kind = 'PERMANENT') OR end_reason = 'SOURCE_ENDED')
  ),
  ADD CONSTRAINT delegation_reviewer_fk FOREIGN KEY (tenant_id, last_reviewed_by) REFERENCES machvon.membership (tenant_id, id);

-- What a delegation grants does not change, except that the review of a permanent one moves its end (valid_until) forward and counts the review. Its state moves forward only, as before.
CREATE OR REPLACE FUNCTION machvon.guard_delegation_grant() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.delegator_membership_id, NEW.delegate_membership_id, NEW.permissions, NEW.scope_json, NEW.valid_from, NEW.reason, NEW.legal_basis_ref, NEW.created_at, NEW.kind, NEW.period_codes, NEW.end_condition_kind, NEW.end_condition_text, NEW.end_on, NEW.request_id)
     IS DISTINCT FROM (OLD.delegator_membership_id, OLD.delegate_membership_id, OLD.permissions, OLD.scope_json, OLD.valid_from, OLD.reason, OLD.legal_basis_ref, OLD.created_at, OLD.kind, OLD.period_codes, OLD.end_condition_kind, OLD.end_condition_text, OLD.end_on, OLD.request_id) THEN
    RAISE EXCEPTION 'what a delegation grants is not changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.valid_until IS DISTINCT FROM OLD.valid_until AND NOT (OLD.kind = 'PERMANENT' AND OLD.status IN ('Scheduled', 'Active') AND NEW.valid_until > OLD.valid_until AND NEW.status = OLD.status) THEN
    RAISE EXCEPTION 'what a delegation grants is not changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('Ended', 'Revoked') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a delegation that is over is not changed' USING ERRCODE = '23514', DETAIL = 'DELEGATION_STATE_INVALID';
    END IF;
  ELSIF NEW.status <> OLD.status AND NOT ((OLD.status = 'Scheduled' AND NEW.status IN ('Active', 'Ended', 'Revoked')) OR (OLD.status = 'Active' AND NEW.status IN ('Ended', 'Revoked'))) THEN
    RAISE EXCEPTION 'a delegation does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514', DETAIL = 'DELEGATION_STATE_INVALID';
  END IF;
  RETURN NEW;
END;
$fn$;

-- The request is in the table that follows; the delegation points at it.
CREATE INDEX delegation_grant_request_idx ON machvon.delegation_grant (tenant_id, request_id) WHERE request_id IS NOT NULL;
-- The pass of the job reads the permanent delegations by the date their review falls due.
CREATE INDEX delegation_grant_review_idx ON machvon.delegation_grant (tenant_id, valid_until) WHERE kind = 'PERMANENT' AND status IN ('Scheduled', 'Active');
