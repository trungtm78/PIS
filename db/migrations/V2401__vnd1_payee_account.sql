-- Authored by hand (not generated): the accounts a contractor is paid into and the control of a change of account (VND-1, research V12; docs/vendor-management.md section 3).
-- An account is never changed in place. A change is a request (`contractor_bank_change_request`) with the letter of the contractor as evidence; it is approved by two people in two roles (the match of the request with the
-- contract file, the match of the account with its holder), neither of them the person who asked and not the same person twice; it is confirmed by a call to the number the profile already held (never one in the request);
-- and it takes effect only after the waiting period of the rule `VENDOR_PAYEE_ACCOUNT`. When the last of the three is done the application activates the new account (`contractor_bank_account`) and the account it replaces is
-- SUPERSEDED. A payment looks at the account that is valid now. The number of an account is sealed (`account_no_enc`, the field cipher) and indexed blind (`account_no_key`, HMAC) so that one account used for two
-- contractors is found without anyone reading the number. Every step is in `contractor_bank_event`, append-only.

CREATE TABLE machvon.contractor_bank_change_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  bank_name text NOT NULL CHECK (bank_name = btrim(bank_name) AND char_length(bank_name) BETWEEN 2 AND 200),
  account_holder text NOT NULL CHECK (account_holder = btrim(account_holder) AND char_length(account_holder) BETWEEN 2 AND 300),
  holder_matches_legal_name boolean NOT NULL,
  account_no_enc bytea NOT NULL,
  account_no_masked text NOT NULL CHECK (char_length(account_no_masked) BETWEEN 4 AND 40),
  account_no_key char(64) NOT NULL CHECK (account_no_key ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 500),
  evidence_document_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'ACTIVATED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  profile_phone_key char(64),
  contract_match_by uuid,
  contract_match_at timestamptz,
  contract_match_note text CHECK (contract_match_note IS NULL OR (contract_match_note = btrim(contract_match_note) AND char_length(contract_match_note) BETWEEN 1 AND 500)),
  account_match_by uuid,
  account_match_at timestamptz,
  account_match_note text CHECK (account_match_note IS NULL OR (account_match_note = btrim(account_match_note) AND char_length(account_match_note) BETWEEN 1 AND 500)),
  callback_by uuid,
  callback_at timestamptz,
  callback_outcome text CHECK (callback_outcome IS NULL OR callback_outcome IN ('CONFIRMED', 'NOT_CONFIRMED')),
  callback_number_last4 text CHECK (callback_number_last4 IS NULL OR callback_number_last4 ~ '^[0-9]{4}$'),
  callback_note text CHECK (callback_note IS NULL OR (callback_note = btrim(callback_note) AND char_length(callback_note) BETWEEN 1 AND 500)),
  closed_by uuid,
  closed_at timestamptz,
  closed_reason text CHECK (closed_reason IS NULL OR (closed_reason = btrim(closed_reason) AND char_length(closed_reason) BETWEEN 5 AND 500)),
  resulting_account_id uuid,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT bank_change_expiry_chk CHECK (expires_at > requested_at),
  CONSTRAINT bank_change_approval_pairs_chk CHECK (
    (contract_match_by IS NULL) = (contract_match_at IS NULL)
    AND (account_match_by IS NULL) = (account_match_at IS NULL)
    AND (callback_by IS NULL) = (callback_at IS NULL)
    AND (callback_by IS NULL) = (callback_outcome IS NULL)
    AND (callback_by IS NULL) = (callback_number_last4 IS NULL)
  ),
  -- Separation of duties kept by the database too: nobody approves or confirms their own request, and the two approvals are two people.
  CONSTRAINT bank_change_sod_chk CHECK (
    (contract_match_by IS NULL OR contract_match_by <> requested_by)
    AND (account_match_by IS NULL OR account_match_by <> requested_by)
    AND (callback_by IS NULL OR callback_by <> requested_by)
    AND (contract_match_by IS NULL OR account_match_by IS NULL OR contract_match_by <> account_match_by)
  ),
  CONSTRAINT bank_change_activated_chk CHECK (
    status <> 'ACTIVATED' OR (contract_match_by IS NOT NULL AND account_match_by IS NOT NULL AND callback_outcome = 'CONFIRMED' AND resulting_account_id IS NOT NULL)
  ),
  CONSTRAINT bank_change_closed_chk CHECK ((status IN ('REJECTED', 'CANCELLED', 'EXPIRED')) = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_reason IS NULL))
);
-- One change in work per contractor at a time: a second request waits for the first to end.
CREATE UNIQUE INDEX bank_change_open_uq ON machvon.contractor_bank_change_request (tenant_id, contractor_id) WHERE status = 'REQUESTED';
CREATE INDEX bank_change_contractor_idx ON machvon.contractor_bank_change_request (tenant_id, contractor_id, requested_at DESC);
CREATE INDEX bank_change_document_idx ON machvon.contractor_bank_change_request (tenant_id, evidence_document_id);
CREATE INDEX bank_change_account_idx ON machvon.contractor_bank_change_request (tenant_id, resulting_account_id) WHERE resulting_account_id IS NOT NULL;
CREATE INDEX bank_change_waiting_idx ON machvon.contractor_bank_change_request (tenant_id, requested_at) WHERE status = 'REQUESTED';

CREATE TABLE machvon.contractor_bank_account (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  bank_name text NOT NULL CHECK (bank_name = btrim(bank_name) AND char_length(bank_name) BETWEEN 2 AND 200),
  account_holder text NOT NULL CHECK (account_holder = btrim(account_holder) AND char_length(account_holder) BETWEEN 2 AND 300),
  holder_matches_legal_name boolean NOT NULL,
  account_no_enc bytea NOT NULL,
  account_no_masked text NOT NULL CHECK (char_length(account_no_masked) BETWEEN 4 AND 40),
  account_no_key char(64) NOT NULL CHECK (account_no_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'SUPERSEDED', 'CLOSED')),
  effective_after timestamptz NOT NULL,
  change_request_id uuid NOT NULL,
  superseded_by_id uuid,
  superseded_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  closed_reason text CHECK (closed_reason IS NULL OR (closed_reason = btrim(closed_reason) AND char_length(closed_reason) BETWEEN 5 AND 500)),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, change_request_id) REFERENCES machvon.contractor_bank_change_request (tenant_id, id),
  CONSTRAINT bank_account_state_chk CHECK (
    ((state = 'SUPERSEDED') = (superseded_at IS NOT NULL))
    AND ((state = 'CLOSED') = (closed_at IS NOT NULL))
    AND ((closed_at IS NULL) = (closed_reason IS NULL))
    AND ((closed_at IS NULL) = (closed_by IS NULL))
  )
);
-- One account is valid at a time: the one in force, or the new one in its waiting period.
CREATE UNIQUE INDEX bank_account_active_uq ON machvon.contractor_bank_account (tenant_id, contractor_id) WHERE state = 'ACTIVE';
CREATE INDEX bank_account_contractor_idx ON machvon.contractor_bank_account (tenant_id, contractor_id, created_at DESC);
CREATE INDEX bank_account_key_idx ON machvon.contractor_bank_account (tenant_id, account_no_key);
CREATE INDEX bank_account_request_idx ON machvon.contractor_bank_account (tenant_id, change_request_id);
CREATE INDEX bank_account_superseded_by_idx ON machvon.contractor_bank_account (tenant_id, superseded_by_id) WHERE superseded_by_id IS NOT NULL;

ALTER TABLE machvon.contractor_bank_change_request
  ADD CONSTRAINT bank_change_resulting_fk FOREIGN KEY (tenant_id, resulting_account_id) REFERENCES machvon.contractor_bank_account (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE machvon.contractor_bank_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  change_request_id uuid,
  account_id uuid,
  action text NOT NULL CHECK (action IN ('REQUESTED', 'CONTRACT_MATCHED', 'ACCOUNT_MATCHED', 'CALLBACK_CONFIRMED', 'CALLBACK_FAILED', 'ACTIVATED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'ACCOUNT_CLOSED')),
  actor_id uuid NOT NULL,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id)
);
CREATE INDEX bank_event_contractor_idx ON machvon.contractor_bank_event (tenant_id, contractor_id, occurred_at DESC, id DESC);
CREATE INDEX bank_event_request_idx ON machvon.contractor_bank_event (tenant_id, change_request_id) WHERE change_request_id IS NOT NULL;
CREATE INDEX bank_event_account_idx ON machvon.contractor_bank_event (tenant_id, account_id) WHERE account_id IS NOT NULL;

CREATE FUNCTION machvon.contractor_bank_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the history of the accounts of a contractor is append-only' USING ERRCODE = '23514';
END;
$fn$;
CREATE TRIGGER contractor_bank_event_append_only BEFORE UPDATE OR DELETE ON machvon.contractor_bank_event FOR EACH ROW EXECUTE FUNCTION machvon.contractor_bank_event_append_only();

-- What an account is (its number, holder, bank and origin) never changes; only its state, its end and its version do.
CREATE FUNCTION machvon.guard_contractor_bank_account() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an account of a contractor is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contractor_id, NEW.bank_name, NEW.account_holder, NEW.account_no_enc, NEW.account_no_key, NEW.effective_after, NEW.change_request_id, NEW.created_by)
     IS DISTINCT FROM
     (OLD.contractor_id, OLD.bank_name, OLD.account_holder, OLD.account_no_enc, OLD.account_no_key, OLD.effective_after, OLD.change_request_id, OLD.created_by) THEN
    RAISE EXCEPTION 'an account of a contractor is not rewritten: a change is a new account' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'ACTIVE' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'an account that is superseded or closed stays so' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER contractor_bank_account_guard BEFORE UPDATE OR DELETE ON machvon.contractor_bank_account FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_bank_account();

ALTER TABLE machvon.contractor_bank_change_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_bank_change_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_bank_change_request AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_bank_change_request AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contractor_bank_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_bank_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_bank_account AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_bank_account AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contractor_bank_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_bank_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_bank_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_bank_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_bank_change_request FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_bank_account FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contractor_bank_event FROM machvon_app;

COMMENT ON TABLE machvon.contractor_bank_change_request IS 'VND-1: a request to change the account a contractor is paid into: two approvers in two roles, a call-back to the number on file, a waiting period (PERSONAL: the account is sealed).';
COMMENT ON TABLE machvon.contractor_bank_account IS 'VND-1: an account a contractor is paid into; sealed number, blind index, valid after its waiting period; never rewritten (PERSONAL).';
COMMENT ON TABLE machvon.contractor_bank_event IS 'VND-1: the append-only chain of what was done to the accounts of a contractor.';
