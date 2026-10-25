-- Authored by hand (not generated): the sealed proposal and the declaration of conflict of interest (ST-BID-004, BID 3 F3). The tables proposal, proposal_document and
-- bid_conflict_declaration come from the generated schema (V002) with their foreign keys and indexes; this adds what the commands and the reads rely on: a proposal is
-- received sealed and its contents are released at the opening of the bids of its package and never sealed again; the files of a proposal are a record; a declaration
-- says which contractor the relation is with, keeps what the member declared and only gains a decision.

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A proposal: received with its time, its release time and its maker; a later revision of the same contractor replaces the live one.
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.proposal
  ADD CONSTRAINT proposal_status_chk CHECK (status IN ('RECEIVED', 'SUPERSEDED', 'WITHDRAWN')),
  ADD CONSTRAINT proposal_revision_chk CHECK (revision >= 1),
  ADD CONSTRAINT proposal_dossier_chk CHECK (submitted_at IS NOT NULL AND access_released_at IS NOT NULL AND created_by IS NOT NULL),
  ADD CONSTRAINT proposal_withdrawn_chk CHECK ((status = 'WITHDRAWN') = (withdrawn_reason IS NOT NULL AND btrim(withdrawn_reason) <> '')),
  ADD CONSTRAINT proposal_versions_chk CHECK (jsonb_typeof(document_version_ids) = 'array');

CREATE UNIQUE INDEX proposal_revision_uq ON machvon.proposal (tenant_id, package_id, contractor_id, revision);
CREATE UNIQUE INDEX proposal_one_live_uq ON machvon.proposal (tenant_id, package_id, contractor_id) WHERE status = 'RECEIVED';

CREATE FUNCTION machvon.guard_proposal() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM machvon.procurement_package k WHERE k.id = NEW.package_id AND k.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'a proposal is for a package of its project' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'RECEIVED' THEN
      RAISE EXCEPTION 'a proposal starts received' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.package_id IS DISTINCT FROM OLD.package_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.contractor_id IS DISTINCT FROM OLD.contractor_id
     OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.bid_price_vnd IS DISTINCT FROM OLD.bid_price_vnd
     OR NEW.document_version_ids IS DISTINCT FROM OLD.document_version_ids OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a proposal keeps what the bidder handed in' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'RECEIVED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a proposal that is replaced or withdrawn stays so' USING ERRCODE = '23514';
  END IF;
  -- Once the contents are released they are not sealed again, whatever the date of the opening becomes.
  IF NEW.access_released_at IS DISTINCT FROM OLD.access_released_at AND OLD.access_released_at <= now() THEN
    RAISE EXCEPTION 'a proposal that was unsealed is not sealed again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER proposal_guard BEFORE INSERT OR UPDATE ON machvon.proposal
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_proposal();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The opening of the bids: the contents of the live proposals of a package are released at its effective opening (the actual date when there is one, else the planned
-- one). A date that moves the opening is followed by the sealed proposals, so a postponement keeps them sealed; one that would seal again a proposal that was already
-- released is refused.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION machvon.align_proposal_release() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  opening timestamptz;
BEGIN
  opening := coalesce(NEW.actual_at, NEW.planned_at);
  IF EXISTS (
    SELECT 1 FROM machvon.proposal p
     WHERE p.package_id = NEW.package_id AND p.status = 'RECEIVED' AND p.access_released_at <= now() AND p.access_released_at < opening
  ) THEN
    RAISE EXCEPTION 'the bids of the package were unsealed at the earlier opening' USING ERRCODE = '23514', HINT = 'OPENING_ALREADY_RELEASED';
  END IF;
  UPDATE machvon.proposal
     SET access_released_at = opening, version = version + 1
   WHERE package_id = NEW.package_id AND status = 'RECEIVED' AND access_released_at > now() AND access_released_at IS DISTINCT FROM opening;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER procurement_milestone_opening AFTER INSERT OR UPDATE ON machvon.procurement_milestone
  FOR EACH ROW WHEN (NEW.milestone_kind = 'BID_OPENING') EXECUTE FUNCTION machvon.align_proposal_release();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- The files of a proposal: a record, written with the proposal. Each is a confidential attachment document about that proposal.
-- ---------------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION machvon.guard_proposal_document() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the files of a proposal are a record' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM machvon.document_version v JOIN machvon.document d ON d.tenant_id = v.tenant_id AND d.id = v.document_id
     WHERE v.id = NEW.document_version_id AND d.doc_kind = 'ATTACHMENT' AND d.classification = 'CONFIDENTIAL'
       AND d.subject_module = 'BID_PROPOSAL' AND d.subject_id = NEW.proposal_id AND v.scan_status = 'CLEAN'
  ) THEN
    RAISE EXCEPTION 'a file of a proposal is a clean confidential attachment about it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER proposal_document_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.proposal_document
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_proposal_document();

-- ---------------------------------------------------------------------------------------------------------------------------------------
-- A declaration: what the member declared stays; a conflict names its relation, may name the contractor it is with, and is decided by someone else, with the words.
-- ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machvon.bid_conflict_declaration ADD COLUMN contractor_id uuid;
ALTER TABLE machvon.bid_conflict_declaration ADD FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id);
CREATE INDEX bid_conflict_declaration_contractor_id_idx ON machvon.bid_conflict_declaration (tenant_id, contractor_id);

ALTER TABLE machvon.bid_conflict_declaration
  ADD CONSTRAINT bid_conflict_relation_chk CHECK (
    (has_conflict = false OR (relation_text IS NOT NULL AND btrim(relation_text) <> ''))
    AND (relation_text IS NULL OR char_length(relation_text) <= 2000)
  ),
  ADD CONSTRAINT bid_conflict_none_chk CHECK (has_conflict OR (contractor_id IS NULL AND decision IS NULL AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  ADD CONSTRAINT bid_conflict_decided_chk CHECK (
    (decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decision_reason IS NULL)
  ),
  ADD CONSTRAINT bid_conflict_reason_chk CHECK (decision_reason IS NULL OR (char_length(btrim(decision_reason)) >= 20 AND char_length(decision_reason) <= 2000));

CREATE FUNCTION machvon.guard_bid_conflict_declaration() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.package_id IS DISTINCT FROM OLD.package_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.has_conflict IS DISTINCT FROM OLD.has_conflict
     OR NEW.relation_text IS DISTINCT FROM OLD.relation_text OR NEW.contractor_id IS DISTINCT FROM OLD.contractor_id OR NEW.declared_at IS DISTINCT FROM OLD.declared_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a declaration keeps what the member declared' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER bid_conflict_declaration_guard BEFORE UPDATE ON machvon.bid_conflict_declaration
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_bid_conflict_declaration();

-- No command deletes a proposal, a file of one or a declaration: they are the dossier of the choice of the contractor, kept under the retention of the project.
REVOKE DELETE, TRUNCATE ON TABLE machvon.proposal FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.proposal_document FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.bid_conflict_declaration FROM machvon_app;
