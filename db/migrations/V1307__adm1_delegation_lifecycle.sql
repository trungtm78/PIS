-- ST-ADM-014: the life of a time-boxed delegation of approval authority (ADM 3.5, BR-ADM-06). Additions only.

ALTER TABLE machvon.delegation_grant ADD COLUMN ended_at timestamptz;
-- Why a delegation ended by itself: its window ran out, or the delegator no longer holds what it passed on (the source grant ended, the membership lapsed).
ALTER TABLE machvon.delegation_grant ADD COLUMN end_reason text;
ALTER TABLE machvon.delegation_grant ADD COLUMN revoke_reason text;
-- When the job last looked at the delegation: a pass that cannot take them all takes the ones it looked at longest ago first, so none is starved.
ALTER TABLE machvon.delegation_grant ADD COLUMN checked_at timestamptz;

-- Only business permissions are delegated: never iam.* or adm.*, never a bare wildcard (BR-ADM-06).
CREATE FUNCTION machvon.delegation_permissions_ok(permissions text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT coalesce(cardinality(permissions) >= 1 AND bool_and(p <> '*' AND p !~ '^(iam|adm)\.'), false) FROM unnest(permissions) AS p
$fn$;

-- A delegation made before this rule that passes on a wildcard or an administrative permission is ended here, or the check and the guard below would stop it being revoked or swept (it ends as if its source were gone).
UPDATE machvon.delegation_grant SET status = 'Ended', ended_at = now(), end_reason = 'SOURCE_ENDED', version = version + 1
 WHERE status IN ('Scheduled', 'Active') AND NOT machvon.delegation_permissions_ok(permissions);

ALTER TABLE machvon.delegation_grant
  ADD CONSTRAINT delegation_permissions_chk CHECK (machvon.delegation_permissions_ok(permissions)) NOT VALID,
  ADD CONSTRAINT delegation_end_chk CHECK ((status = 'Ended') = (end_reason IS NOT NULL AND ended_at IS NOT NULL) AND (end_reason IS NULL OR end_reason IN ('EXPIRED', 'SOURCE_ENDED'))) NOT VALID,
  ADD CONSTRAINT delegation_revoked_chk CHECK ((status = 'Revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)) NOT VALID;

-- What a delegation is does not change; only its state moves, forward: Scheduled to Active, Ended or Revoked; Active to Ended or Revoked. Once over it is final.
CREATE FUNCTION machvon.guard_delegation_grant() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.delegator_membership_id, NEW.delegate_membership_id, NEW.permissions, NEW.scope_json, NEW.valid_from, NEW.valid_until, NEW.reason, NEW.legal_basis_ref, NEW.created_at)
     IS DISTINCT FROM (OLD.delegator_membership_id, OLD.delegate_membership_id, OLD.permissions, OLD.scope_json, OLD.valid_from, OLD.valid_until, OLD.reason, OLD.legal_basis_ref, OLD.created_at) THEN
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
CREATE TRIGGER delegation_grant_guard BEFORE UPDATE ON machvon.delegation_grant FOR EACH ROW EXECUTE FUNCTION machvon.guard_delegation_grant();
REVOKE DELETE, TRUNCATE ON TABLE machvon.delegation_grant FROM machvon_app;

-- The pass of the job reads the delegations that are not over, by the end of their window.
CREATE INDEX delegation_grant_open_idx ON machvon.delegation_grant (tenant_id, valid_until) WHERE status IN ('Scheduled', 'Active');
