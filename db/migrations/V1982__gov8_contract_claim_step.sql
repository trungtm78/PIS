-- Authored by hand (not generated): the timeline of a claim (GOV-8, roadmap G1-9, docs/ctr-claims.md).
-- Each step of a claim (the event, the notice, the particulars, a response, a settlement proposal and its decision, a withdrawal, a referral, a declaration that the claim is barred, the binding of a term) is one row.
-- The timeline is the evidence of what was done and on which day of the contract world (`occurred_on`: the day the notice was served, the day the response is dated) as opposed to the moment it was recorded
-- (`created_at`): the limits of a contract are counted on the first. Append-only for every role, so nobody can rewrite when a notice was served; a correction is a new step that says so.

CREATE TABLE machvon.contract_claim_step (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  ordinal integer NOT NULL,
  kind text NOT NULL,
  occurred_on date NOT NULL,
  note text NOT NULL,
  decision text,
  claimed_amount_vnd numeric(24,0),
  claimed_days integer,
  settled_amount_vnd numeric(24,0),
  granted_days integer,
  evidence_document_version_id uuid,
  term_id uuid,
  actor_id uuid NOT NULL,
  claim_version_after bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES machvon.contract_claim (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_document_version_id) REFERENCES machvon.document_version (tenant_id, id),
  FOREIGN KEY (tenant_id, term_id) REFERENCES machvon.contract_claim_term (tenant_id, id),
  CONSTRAINT contract_claim_step_kind_chk CHECK (kind IN ('EVENT', 'NOTICE', 'PARTICULARS', 'RESPONSE', 'SETTLEMENT_PROPOSAL', 'SETTLEMENT_APPROVED', 'SETTLEMENT_REJECTED', 'WITHDRAWAL', 'REFERRAL', 'BAR_DECLARED', 'TERM_BOUND')),
  CONSTRAINT contract_claim_step_ordinal_chk CHECK (ordinal >= 1),
  CONSTRAINT contract_claim_step_note_chk CHECK (note = btrim(note) AND char_length(note) BETWEEN 5 AND 2000),
  CONSTRAINT contract_claim_step_decision_chk CHECK ((kind = 'RESPONSE') = (decision IS NOT NULL) AND (decision IS NULL OR decision IN ('ACCEPTED', 'PARTLY_ACCEPTED', 'REJECTED', 'MORE_INFORMATION_REQUESTED'))),
  CONSTRAINT contract_claim_step_amounts_chk CHECK (
    (claimed_amount_vnd IS NULL OR claimed_amount_vnd >= 0) AND (settled_amount_vnd IS NULL OR settled_amount_vnd >= 0) AND (claimed_days IS NULL OR claimed_days >= 0) AND (granted_days IS NULL OR granted_days >= 0)
  ),
  CONSTRAINT contract_claim_step_term_chk CHECK ((kind = 'TERM_BOUND') = (term_id IS NOT NULL)),
  CONSTRAINT contract_claim_step_version_chk CHECK (claim_version_after >= 1),
  CONSTRAINT contract_claim_step_order_uq UNIQUE (tenant_id, claim_id, ordinal)
);

CREATE INDEX contract_claim_step_evidence_document_version_id_idx ON machvon.contract_claim_step (tenant_id, evidence_document_version_id) WHERE evidence_document_version_id IS NOT NULL;
CREATE INDEX contract_claim_step_term_id_idx ON machvon.contract_claim_step (tenant_id, term_id) WHERE term_id IS NOT NULL;
CREATE INDEX contract_claim_step_actor_idx ON machvon.contract_claim_step (tenant_id, actor_id, created_at DESC);

CREATE FUNCTION machvon.contract_claim_step_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the timeline of a claim is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER contract_claim_step_append_only BEFORE UPDATE OR DELETE ON machvon.contract_claim_step FOR EACH ROW EXECUTE FUNCTION machvon.contract_claim_step_append_only();

ALTER TABLE machvon.contract_claim_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contract_claim_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contract_claim_step AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contract_claim_step AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contract_claim_step FROM machvon_app;

COMMENT ON TABLE machvon.contract_claim_step IS 'GOV-8: the timeline of a claim: what was done, on which day of the contract world, by whom; append-only.';
