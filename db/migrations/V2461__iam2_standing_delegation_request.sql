-- Authored by hand (not generated): the request for a permanent delegation (IAM-2). A permanent delegation is a standing authority, so the delegator only asks for it and a second person (never the delegator, never the delegate)
-- approves it; the approval makes the delegation_grant of kind PERMANENT. The request keeps what was asked, who decided and why, and the delegation it became.

CREATE TABLE machvon.standing_delegation_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  delegator_membership_id uuid NOT NULL,
  delegate_membership_id uuid NOT NULL,
  permissions text[] NOT NULL,
  scope_json jsonb NOT NULL,
  period_codes text[],
  starts_at timestamptz NOT NULL,
  review_due_at timestamptz NOT NULL,
  end_condition_kind text NOT NULL,
  end_condition_text text NOT NULL,
  end_on timestamptz,
  reason text NOT NULL,
  legal_basis_ref text,
  status text NOT NULL DEFAULT 'Pending',
  -- A request nobody decided by then is dead (7 days).
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  delegation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, delegator_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, delegate_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, delegation_id) REFERENCES machvon.delegation_grant (tenant_id, id),
  CONSTRAINT standing_request_parties_chk CHECK (delegator_membership_id <> delegate_membership_id AND (decided_by IS NULL OR (decided_by <> delegator_membership_id AND decided_by <> delegate_membership_id))),
  CONSTRAINT standing_request_permissions_chk CHECK (machvon.delegation_permissions_ok(permissions)),
  CONSTRAINT standing_request_period_chk CHECK (period_codes IS NULL OR machvon.period_codes_ok(period_codes)),
  CONSTRAINT standing_request_review_chk CHECK (review_due_at > starts_at AND review_due_at <= starts_at + interval '366 days'),
  CONSTRAINT standing_request_end_chk CHECK (
    end_condition_kind IN ('SOURCE_HOLDS', 'UNTIL_EVENT', 'UNTIL_DATE')
    AND char_length(btrim(end_condition_text)) BETWEEN 10 AND 500
    AND ((end_condition_kind = 'UNTIL_DATE') = (end_on IS NOT NULL))
    AND (end_on IS NULL OR (end_on > starts_at AND review_due_at <= end_on))
  ),
  CONSTRAINT standing_request_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT standing_request_status_chk CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
  CONSTRAINT standing_request_decision_chk CHECK (
    CASE status
      WHEN 'Pending' THEN decided_by IS NULL AND decided_at IS NULL AND delegation_id IS NULL
      WHEN 'Approved' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND delegation_id IS NOT NULL
      WHEN 'Rejected' THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND delegation_id IS NULL
      ELSE decided_at IS NOT NULL AND delegation_id IS NULL
    END
  )
);

CREATE INDEX standing_request_delegator_idx ON machvon.standing_delegation_request (tenant_id, delegator_membership_id, created_at DESC);
CREATE INDEX standing_request_delegate_idx ON machvon.standing_delegation_request (tenant_id, delegate_membership_id);
CREATE INDEX standing_request_decided_by_idx ON machvon.standing_delegation_request (tenant_id, decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX standing_request_delegation_idx ON machvon.standing_delegation_request (tenant_id, delegation_id);
CREATE INDEX standing_request_status_idx ON machvon.standing_delegation_request (tenant_id, status, created_at DESC);

-- The delegation points back at the request that made it.
ALTER TABLE machvon.delegation_grant ADD CONSTRAINT delegation_request_fk FOREIGN KEY (tenant_id, request_id) REFERENCES machvon.standing_delegation_request (tenant_id, id);

ALTER TABLE machvon.standing_delegation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.standing_delegation_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.standing_delegation_request AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.standing_delegation_request AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.standing_delegation_request FROM machvon_app;

-- What was asked never changes; a request is decided once (Pending to Approved, Rejected or Cancelled) and then it is final.
CREATE FUNCTION machvon.guard_standing_delegation_request() RETURNS trigger
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
    RAISE EXCEPTION 'a request for a permanent delegation is never deleted (% by %)', TG_OP, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.delegator_membership_id, NEW.delegate_membership_id, NEW.permissions, NEW.scope_json, NEW.period_codes, NEW.starts_at, NEW.review_due_at, NEW.end_condition_kind, NEW.end_condition_text, NEW.end_on, NEW.reason, NEW.legal_basis_ref, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.delegator_membership_id, OLD.delegate_membership_id, OLD.permissions, OLD.scope_json, OLD.period_codes, OLD.starts_at, OLD.review_due_at, OLD.end_condition_kind, OLD.end_condition_text, OLD.end_on, OLD.reason, OLD.legal_basis_ref, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'what a request for a permanent delegation asks never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'Pending' THEN
    RAISE EXCEPTION 'a request that was decided never changes' USING ERRCODE = '42501', DETAIL = 'DELEGATION_STATE_INVALID';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER standing_delegation_request_guard BEFORE UPDATE OR DELETE ON machvon.standing_delegation_request
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_standing_delegation_request();
