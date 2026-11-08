-- Authored by hand (not generated): the master profile of a contractor (VND-1, research V1; docs/vendor-management.md section 2).
-- `contractor` (BID, V002 and V1340) holds the identity: tax id, legal name, verification. This adds what the law and the research ask a register of contractors to know (NĐ 214/2025 Điều 19): the legal
-- representative, the registered address, the contact, the business registration number and a declaration about ownership, each with the normal-form key that the duplicate check compares (a hash of the folded value,
-- never the value), the date the telephone number was put on file (a call-back to a number set the day before proves nothing), and the day the profile is to be looked at again.
--   * `contractor_owner`: who holds the contractor (a person or an organisation), the share, whether the owner is a beneficial owner, the basis of control and the paper it rests on. An owner is never rewritten: a
--     change ends the row (`ended_on`) and adds a new one, so the history of ownership at the date of a bid stays answerable.
--   * `contractor_duplicate_suggestion`: a pair of contractors the signals say may be one party, with the score and the signals found. A person dismisses it or sends it to the merge of master data (MDM F5); the
--     register never merges by itself and never by name.

ALTER TABLE machvon.contractor
  ADD COLUMN legal_rep_name text,
  ADD COLUMN legal_rep_position text,
  ADD COLUMN legal_rep_key char(64),
  ADD COLUMN registered_address text,
  ADD COLUMN address_key char(64),
  ADD COLUMN phone text,
  ADD COLUMN phone_key char(64),
  ADD COLUMN phone_set_at timestamptz,
  ADD COLUMN email text,
  ADD COLUMN email_key char(64),
  ADD COLUMN business_registration_no text,
  ADD COLUMN ownership_declaration text,
  ADD COLUMN ownership_declared_by uuid,
  ADD COLUMN ownership_declared_at timestamptz,
  ADD COLUMN profile_reviewed_at timestamptz,
  ADD COLUMN next_review_due date;

ALTER TABLE machvon.contractor
  ADD CONSTRAINT contractor_profile_text_chk CHECK (
    (legal_rep_name IS NULL OR (legal_rep_name = btrim(legal_rep_name) AND char_length(legal_rep_name) BETWEEN 2 AND 300))
    AND (legal_rep_position IS NULL OR (legal_rep_position = btrim(legal_rep_position) AND char_length(legal_rep_position) BETWEEN 2 AND 200))
    AND (registered_address IS NULL OR (registered_address = btrim(registered_address) AND char_length(registered_address) BETWEEN 8 AND 500))
    AND (phone IS NULL OR phone ~ '^0[0-9]{8,10}$')
    AND (email IS NULL OR (email = lower(btrim(email)) AND char_length(email) BETWEEN 6 AND 254))
    AND (business_registration_no IS NULL OR (business_registration_no = btrim(business_registration_no) AND char_length(business_registration_no) BETWEEN 3 AND 40))
  ),
  ADD CONSTRAINT contractor_profile_key_chk CHECK (
    (legal_rep_key IS NULL OR legal_rep_key ~ '^[0-9a-f]{64}$')
    AND (address_key IS NULL OR address_key ~ '^[0-9a-f]{64}$')
    AND (phone_key IS NULL OR phone_key ~ '^[0-9a-f]{64}$')
    AND (email_key IS NULL OR email_key ~ '^[0-9a-f]{64}$')
    AND (phone IS NULL) = (phone_key IS NULL)
    AND (phone IS NULL) = (phone_set_at IS NULL)
    AND (email IS NULL) = (email_key IS NULL)
  ),
  ADD CONSTRAINT contractor_ownership_declaration_chk CHECK (
    ownership_declaration IS NULL OR (ownership_declaration IN ('OWNERS_LISTED', 'NO_OWNER_ABOVE_THRESHOLD') AND ownership_declared_by IS NOT NULL AND ownership_declared_at IS NOT NULL)
  );

CREATE INDEX contractor_address_key_idx ON machvon.contractor (tenant_id, address_key) WHERE address_key IS NOT NULL;
CREATE INDEX contractor_phone_key_idx ON machvon.contractor (tenant_id, phone_key) WHERE phone_key IS NOT NULL;
CREATE INDEX contractor_email_key_idx ON machvon.contractor (tenant_id, email_key) WHERE email_key IS NOT NULL;
CREATE INDEX contractor_legal_rep_key_idx ON machvon.contractor (tenant_id, legal_rep_key) WHERE legal_rep_key IS NOT NULL;
CREATE INDEX contractor_review_due_idx ON machvon.contractor (tenant_id, next_review_due) WHERE next_review_due IS NOT NULL;

CREATE TABLE machvon.contractor_owner (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('PERSON', 'ORGANISATION')),
  owner_name text NOT NULL CHECK (owner_name = btrim(owner_name) AND char_length(owner_name) BETWEEN 1 AND 300),
  name_key char(64) NOT NULL CHECK (name_key ~ '^[0-9a-f]{64}$'),
  identity_key char(64) CHECK (identity_key IS NULL OR identity_key ~ '^[0-9a-f]{64}$'),
  share_pct numeric(5,2) CHECK (share_pct IS NULL OR (share_pct >= 0 AND share_pct <= 100)),
  beneficial_owner boolean NOT NULL DEFAULT false,
  control_basis text CHECK (control_basis IS NULL OR control_basis IN ('SHARE_CAPITAL', 'VOTING_RIGHTS', 'APPOINTS_MANAGEMENT', 'OTHER_CONTROL')),
  source_document_id uuid,
  since_on date NOT NULL DEFAULT current_date,
  ended_on date,
  ended_reason text CHECK (ended_reason IS NULL OR (ended_reason = btrim(ended_reason) AND char_length(ended_reason) BETWEEN 5 AND 500)),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  CONSTRAINT contractor_owner_basis_chk CHECK (share_pct IS NOT NULL OR control_basis IS NOT NULL),
  CONSTRAINT contractor_owner_period_chk CHECK ((ended_on IS NULL) = (ended_reason IS NULL) AND (ended_on IS NULL OR ended_on >= since_on))
);
CREATE INDEX contractor_owner_contractor_idx ON machvon.contractor_owner (tenant_id, contractor_id, ended_on);
CREATE INDEX contractor_owner_document_idx ON machvon.contractor_owner (tenant_id, source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX contractor_owner_name_key_idx ON machvon.contractor_owner (tenant_id, name_key) WHERE ended_on IS NULL;
CREATE INDEX contractor_owner_identity_key_idx ON machvon.contractor_owner (tenant_id, identity_key) WHERE identity_key IS NOT NULL AND ended_on IS NULL;

-- What an owner is, who it is and what it holds never changes; the row only ends. A change is a new row.
CREATE FUNCTION machvon.guard_contractor_owner() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an owner of a contractor is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.contractor_id, NEW.owner_kind, NEW.owner_name, NEW.name_key, NEW.identity_key, NEW.share_pct, NEW.beneficial_owner, NEW.control_basis, NEW.source_document_id, NEW.since_on, NEW.created_by)
     IS DISTINCT FROM
     (OLD.contractor_id, OLD.owner_kind, OLD.owner_name, OLD.name_key, OLD.identity_key, OLD.share_pct, OLD.beneficial_owner, OLD.control_basis, OLD.source_document_id, OLD.since_on, OLD.created_by) THEN
    RAISE EXCEPTION 'an owner of a contractor is not rewritten: it ends and a new one is added' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_on IS NOT NULL AND (NEW.ended_on IS DISTINCT FROM OLD.ended_on OR NEW.ended_reason IS DISTINCT FROM OLD.ended_reason) THEN
    RAISE EXCEPTION 'an owner that has ended stays ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER contractor_owner_guard BEFORE UPDATE OR DELETE ON machvon.contractor_owner FOR EACH ROW EXECUTE FUNCTION machvon.guard_contractor_owner();

CREATE TABLE machvon.contractor_duplicate_suggestion (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_a_id uuid NOT NULL,
  contractor_b_id uuid NOT NULL,
  score integer NOT NULL CHECK (score >= 0),
  signals text[] NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DISMISSED', 'MERGE_REQUESTED')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 5 AND 500)),
  dismissed_score integer,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_scored_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_a_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_b_id) REFERENCES machvon.contractor (tenant_id, id),
  CONSTRAINT contractor_duplicate_pair_chk CHECK (contractor_a_id < contractor_b_id),
  CONSTRAINT contractor_duplicate_pair_uq UNIQUE (tenant_id, contractor_a_id, contractor_b_id),
  CONSTRAINT contractor_duplicate_decision_chk CHECK ((status = 'OPEN') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (decision_reason IS NULL))
);
CREATE INDEX contractor_duplicate_b_idx ON machvon.contractor_duplicate_suggestion (tenant_id, contractor_b_id);
CREATE INDEX contractor_duplicate_open_idx ON machvon.contractor_duplicate_suggestion (tenant_id, score DESC) WHERE status = 'OPEN';

ALTER TABLE machvon.contractor_owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_owner FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_owner AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_owner AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.contractor_duplicate_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_duplicate_suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_duplicate_suggestion AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_duplicate_suggestion AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_owner FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_duplicate_suggestion FROM machvon_app;

COMMENT ON TABLE machvon.contractor_owner IS 'VND-1: an owner of a contractor (PERSONAL for a person): share, beneficial-owner flag, basis of control; ended, never rewritten.';
COMMENT ON TABLE machvon.contractor_duplicate_suggestion IS 'VND-1: a pair of contractors the signals say may be one party; a person dismisses it or sends it to the merge of master data.';
COMMENT ON COLUMN machvon.contractor.legal_rep_name IS 'VND-1 (PERSONAL): the legal representative as the registration certificate names them.';
COMMENT ON COLUMN machvon.contractor.phone IS 'VND-1 (PERSONAL): the telephone number on file; a call-back for a change of account goes to this number only.';
