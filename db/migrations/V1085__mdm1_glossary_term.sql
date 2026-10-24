-- Authored by hand (not generated): the glossary of business terms with an approval workflow (ST-MDM-008, MDM 3.1 F6).
-- V002 gave the table its columns, the unique (term_code, revision), the single PUBLISHED term and the first SoD check. This slice
-- adds what the workflow needs to be provable from the database alone:
--   * decided_by / decided_at / decision_reason: who took the last review decision (approve, reject or return) and why. approved_by only
--     says who approved; a rejection and a return need a decider too, and the decider is never the proposer.
--   * published_by / published_at: who published the revision and when. The publisher is never the proposer.
--   * One open revision per term_code: a term is worked on by one proposal at a time (DRAFT, IN_REVIEW or APPROVED).
--   * Status and revision consistency as CHECKs, and a guard trigger: the content of a revision never changes after it is written (a change
--     is a new revision), a status only moves along the state machine, and a revision supersedes an earlier revision of the same term.
--   * Listing indexes, and the runtime role may not delete or truncate terms: the glossary is kept for good (MDM.md section 6).

ALTER TABLE machvon.glossary_term ADD COLUMN decided_by uuid;
ALTER TABLE machvon.glossary_term ADD COLUMN decided_at timestamptz;
ALTER TABLE machvon.glossary_term ADD COLUMN decision_reason text;
ALTER TABLE machvon.glossary_term ADD COLUMN published_by uuid;
ALTER TABLE machvon.glossary_term ADD COLUMN published_at timestamptz;

ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_code_chk CHECK (term_code ~ '^[A-Z][A-Z0-9_]*$' AND char_length(term_code) <= 80);
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_domain_chk CHECK (domain ~ '^[A-Z][A-Z0-9_]*$' AND char_length(domain) <= 50);
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_definition_chk CHECK (char_length(definition) BETWEEN 20 AND 2000);

-- Four-eyes: the proposer approves, rejects, returns and publishes nothing (glossary_term_sod_chk of V002 covers approved_by).
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_decider_sod_chk CHECK (decided_by IS NULL OR decided_by <> created_by);
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_publisher_sod_chk CHECK (published_by IS NULL OR published_by <> created_by);

-- Status and the facts that go with it. Approval facts exist exactly from APPROVED on; a rejection or a return has its decider;
-- publication facts exist exactly for a revision that is or was PUBLISHED.
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_approval_chk
  CHECK ((approved_by IS NOT NULL) = (status IN ('APPROVED', 'PUBLISHED', 'DEPRECATED')));
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_decision_chk
  CHECK (status IN ('DRAFT', 'IN_REVIEW') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_publication_chk
  CHECK ((status IN ('PUBLISHED', 'DEPRECATED')) = (published_by IS NOT NULL AND published_at IS NOT NULL AND effective_from IS NOT NULL));
ALTER TABLE machvon.glossary_term ADD CONSTRAINT glossary_term_supersedes_chk
  CHECK (supersedes_id IS NULL OR (revision > 1 AND supersedes_id <> id));

-- One open proposal per term: a second one would be decided against a state that the first one is about to change.
CREATE UNIQUE INDEX glossary_term_open_uq ON machvon.glossary_term (tenant_id, term_code) WHERE status IN ('DRAFT', 'IN_REVIEW', 'APPROVED');

-- The list: newest first, optionally by domain and status.
CREATE INDEX glossary_term_created_idx ON machvon.glossary_term (tenant_id, created_at DESC, id DESC);
CREATE INDEX glossary_term_domain_status_idx ON machvon.glossary_term (tenant_id, domain, status, created_at DESC, id DESC);

CREATE FUNCTION machvon.glossary_term_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  earlier machvon.glossary_term%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO earlier FROM machvon.glossary_term WHERE tenant_id = NEW.tenant_id AND id = NEW.supersedes_id;
      IF NOT FOUND OR earlier.term_code <> NEW.term_code OR earlier.revision >= NEW.revision OR earlier.domain <> NEW.domain THEN
        RAISE EXCEPTION 'a glossary revision supersedes an earlier revision of the same term and domain' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.term_code IS DISTINCT FROM OLD.term_code OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.term_vi IS DISTINCT FROM OLD.term_vi OR NEW.definition IS DISTINCT FROM OLD.definition OR NEW.formula_ref IS DISTINCT FROM OLD.formula_ref
     OR NEW.domain IS DISTINCT FROM OLD.domain OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
     OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'the content of a glossary revision does not change: a change is a new revision' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'IN_REVIEW')
    OR (OLD.status = 'IN_REVIEW' AND NEW.status IN ('APPROVED', 'REJECTED', 'DRAFT'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'PUBLISHED')
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'DEPRECATED')) THEN
    RAISE EXCEPTION 'a glossary term does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER glossary_term_guard BEFORE INSERT OR UPDATE ON machvon.glossary_term
  FOR EACH ROW EXECUTE FUNCTION machvon.glossary_term_guard();

-- Terms are kept for good: a revision that was published is the history of what a figure meant on a date.
REVOKE DELETE, TRUNCATE ON TABLE machvon.glossary_term FROM machvon_app;
