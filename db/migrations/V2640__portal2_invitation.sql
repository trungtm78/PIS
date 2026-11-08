-- Authored by hand (not generated): access to the contractor portal bound to the contractor registry, not to a contract (PORTAL-2; docs/plans/portal2.md, docs/vendor-investigation.md section 13).
-- ADM-17 invites a guest through contracts, so a contractor with no contract had no way in. An invitation here names the REGISTRY ENTRY: staff propose a contact of the contractor with the proof that the contact is the
-- contractor's (the address on the entry, or a reference to a paper), a different person approves (two-person rule, a CHECK), the access has a proposal expiry and an access end, and it can be revoked at once with a reason.
--   * Only one live (PROPOSED or APPROVED) invitation exists for a contractor and an e-mail address.
--   * The e-mail is kept normalised (lower case); it is data of a person and never goes to an audit row or an event.
--   * The portal path never reads this table (V2643): a contractor sees its own data, not how it was let in.

CREATE TABLE machvon.contractor_portal_invitation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  tax_identifier text NOT NULL CHECK (char_length(tax_identifier) BETWEEN 3 AND 40),
  contact_email text NOT NULL CHECK (contact_email = lower(btrim(contact_email)) AND char_length(contact_email) BETWEEN 5 AND 254 AND position('@' in contact_email) > 1),
  contact_name text NOT NULL CHECK (contact_name = btrim(contact_name) AND char_length(contact_name) BETWEEN 2 AND 200),
  contact_basis text NOT NULL CHECK (contact_basis IN ('REGISTRY_EMAIL', 'REPRESENTATIVE_LETTER', 'TAX_AUTHORITY_RECORD', 'OTHER_EVIDENCE')),
  basis_reference text CHECK (basis_reference IS NULL OR (basis_reference = btrim(basis_reference) AND char_length(basis_reference) BETWEEN 6 AND 300)),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED')),
  unit_id uuid NOT NULL,
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  proposal_expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (decision_note = btrim(decision_note) AND char_length(decision_note) BETWEEN 5 AND 1000)),
  membership_id uuid,
  access_valid_until timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND char_length(revoke_reason) BETWEEN 5 AND 1000)),
  expired_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES machvon.organization_unit (tenant_id, id),
  FOREIGN KEY (tenant_id, proposed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT portal_invitation_basis_chk CHECK ((contact_basis = 'REGISTRY_EMAIL') = (basis_reference IS NULL)),
  CONSTRAINT portal_invitation_sod_chk CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CONSTRAINT portal_invitation_decision_chk CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT portal_invitation_account_chk CHECK ((membership_id IS NULL) = (access_valid_until IS NULL) AND (status <> 'APPROVED' OR membership_id IS NOT NULL) AND (status NOT IN ('PROPOSED', 'REJECTED') OR membership_id IS NULL)),
  CONSTRAINT portal_invitation_decided_chk CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_by IS NOT NULL),
  CONSTRAINT portal_invitation_revoked_chk CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT portal_invitation_expired_chk CHECK ((status = 'EXPIRED') = (expired_at IS NOT NULL)),
  CONSTRAINT portal_invitation_window_chk CHECK (proposal_expires_at > proposed_at)
);
CREATE UNIQUE INDEX portal_invitation_live_uq ON machvon.contractor_portal_invitation (tenant_id, contractor_id, contact_email) WHERE status IN ('PROPOSED', 'APPROVED');
CREATE INDEX portal_invitation_contractor_idx ON machvon.contractor_portal_invitation (tenant_id, contractor_id, status, proposed_at DESC);
CREATE INDEX portal_invitation_due_idx ON machvon.contractor_portal_invitation (tenant_id, status, proposal_expires_at) WHERE status = 'PROPOSED';
CREATE INDEX portal_invitation_access_idx ON machvon.contractor_portal_invitation (tenant_id, access_valid_until) WHERE status = 'APPROVED';
CREATE INDEX portal_invitation_unit_idx ON machvon.contractor_portal_invitation (tenant_id, unit_id);
CREATE INDEX portal_invitation_proposer_idx ON machvon.contractor_portal_invitation (tenant_id, proposed_by);
CREATE INDEX portal_invitation_decider_idx ON machvon.contractor_portal_invitation (tenant_id, decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX portal_invitation_revoker_idx ON machvon.contractor_portal_invitation (tenant_id, revoked_by) WHERE revoked_by IS NOT NULL;
CREATE INDEX portal_invitation_membership_idx ON machvon.contractor_portal_invitation (tenant_id, membership_id) WHERE membership_id IS NOT NULL;

ALTER TABLE machvon.contractor_portal_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_portal_invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_portal_invitation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_portal_invitation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_portal_invitation FROM machvon_app;

COMMENT ON TABLE machvon.contractor_portal_invitation IS 'PORTAL-2: an invitation of a contact of a registered contractor to the portal, proposed by one person, approved by another, with an expiry and a revocation; independent of contracts.';
