-- Authored by hand (not generated): guards for the delegation-of-authority matrix (ST-ADM-011, ADM 3.6, BR-ADM-01, BR-ADM-04).
-- A matrix version is the regulation that decides who may approve what amount, so it is kept for good, it is never edited
-- once it has left the draft state, and the person who touched it can never be the person who approves it.
REVOKE DELETE, TRUNCATE ON TABLE machvon.doa_matrix_version FROM machvon_app;

-- The last person who wrote the draft (created, edited or submitted it). The table keeps the author only; BR-ADM-01 asks that
-- whoever made the version in force is not the one who approved it, and a colleague who edited the draft made it too.
ALTER TABLE machvon.doa_matrix_version ADD COLUMN last_edited_by uuid;

-- The row of the rule in the draft as it was written, counted from 0: the findings of a submission and of an approval name rules by
-- this position (`rules[3].amount_min_vnd`), which is the row the administrator sees. Nullable, as an added column must be; the
-- store always sets it.
ALTER TABLE machvon.doa_rule ADD COLUMN position integer CHECK (position >= 0);
CREATE UNIQUE INDEX doa_rule_position_uq ON machvon.doa_rule (tenant_id, matrix_version_id, position);

ALTER TABLE machvon.doa_matrix_version
  ADD CONSTRAINT doa_matrix_published_ck CHECK (status IN ('Draft', 'PendingApproval', 'Rejected') OR (approved_by IS NOT NULL AND published_at IS NOT NULL)),
  ADD CONSTRAINT doa_matrix_editor_four_eyes_ck CHECK (approved_by IS NULL OR last_edited_by IS NULL OR approved_by <> last_edited_by);

-- One matrix is in force at a time; the ones it replaced are Superseded and keep the range of days they covered.
CREATE UNIQUE INDEX doa_matrix_one_published_uq ON machvon.doa_matrix_version (tenant_id) WHERE status = 'Published';
-- The resolver reads the version that covers a day.
CREATE INDEX doa_matrix_effective_idx ON machvon.doa_matrix_version (tenant_id, effective_from) WHERE status IN ('Published', 'Superseded');

-- Transitions: Draft to PendingApproval (submit), PendingApproval to Published (approve), to Draft (return) or to Rejected, and
-- Published to Superseded. Rejected and Superseded are final. Identity never changes; the dates and the legal basis change only
-- while the version stays a draft, except that a version that is superseded gets its end date; the approver and the time are
-- set by the approval and never again.
CREATE FUNCTION machvon.guard_doa_matrix_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'a matrix version keeps its revision and its author' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('Rejected', 'Superseded') THEN
    RAISE EXCEPTION 'a rejected or superseded matrix version never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'Draft' AND NEW.status = 'PendingApproval')
    OR (OLD.status = 'PendingApproval' AND NEW.status IN ('Published', 'Draft', 'Rejected'))
    OR (OLD.status = 'Published' AND NEW.status = 'Superseded')) THEN
    RAISE EXCEPTION 'this change of the state of a matrix version is not allowed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.legal_basis_ref IS DISTINCT FROM OLD.legal_basis_ref)
     AND NOT (OLD.status = 'Draft' AND NEW.status = 'Draft') THEN
    RAISE EXCEPTION 'the start and the legal basis of a matrix version change only while it is a draft' USING ERRCODE = '23514';
  END IF;
  IF NEW.effective_until IS DISTINCT FROM OLD.effective_until
     AND NOT ((OLD.status = 'Draft' AND NEW.status = 'Draft') OR (OLD.status = 'Published' AND NEW.status = 'Superseded')) THEN
    RAISE EXCEPTION 'the end of a matrix version changes only while it is a draft or when it is superseded' USING ERRCODE = '23514';
  END IF;
  IF (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND NOT (OLD.status = 'PendingApproval' AND NEW.status = 'Published') THEN
    RAISE EXCEPTION 'the approver and the time of publication are set by the approval only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER doa_matrix_guard BEFORE UPDATE ON machvon.doa_matrix_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_doa_matrix_update();

-- The rules of a version change only while the version is a draft (the draft is replaced as a whole by an update).
CREATE FUNCTION machvon.guard_doa_rule_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO parent_status FROM machvon.doa_matrix_version WHERE tenant_id = OLD.tenant_id AND id = OLD.matrix_version_id;
    IF parent_status IS DISTINCT FROM 'Draft' THEN
      RAISE EXCEPTION 'the rules of a matrix version change only while it is a draft' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO parent_status FROM machvon.doa_matrix_version WHERE tenant_id = NEW.tenant_id AND id = NEW.matrix_version_id;
    IF parent_status IS DISTINCT FROM 'Draft' THEN
      RAISE EXCEPTION 'the rules of a matrix version change only while it is a draft' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER doa_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.doa_rule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_doa_rule_change();
