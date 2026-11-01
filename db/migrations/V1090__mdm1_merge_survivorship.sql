-- Authored by hand (not generated): the merge of master records and its rules of survivorship (ST-MDM-010, MDM.md F5, BR-MDM-05).
-- V002 gave master_merge and survivorship_rule their columns and a unique active merge for each merged record. What the merge stands on is put into the database here, whatever the application checked first:
--   * a rule of survivorship never changes what it says (its type, attribute, strategy, order of sources, revision, the day it takes effect); it is DRAFT, then PUBLISHED by somebody other than who drafted it, then
--     RETIRED when the next revision for the attribute is published; one revision of a rule is published for a type and an attribute at a time;
--   * a merge never changes what it recorded - who survived, who was merged, how each attribute was settled, the old names, the references that were pointed again, the reason - and moves one way only: APPLIED to
--     REVERTED, once, with who undid it, when and why; and nothing is deleted.
-- A merge is undone by a second merge row never: the record that was merged away comes back under the same row, which is why the row stays.

ALTER TABLE machvon.survivorship_rule
  ADD CONSTRAINT survivorship_rule_text_chk CHECK (char_length(btrim(master_type)) BETWEEN 1 AND 50 AND char_length(btrim(attribute_name)) BETWEEN 1 AND 100) NOT VALID,
  ADD CONSTRAINT survivorship_rule_published_chk CHECK (status = 'DRAFT' OR approved_by IS NOT NULL) NOT VALID,
  ADD CONSTRAINT survivorship_rule_sod_chk CHECK (approved_by IS NULL OR approved_by <> created_by) NOT VALID,
  ADD CONSTRAINT survivorship_rule_sources_chk CHECK (strategy <> 'STEWARD_DECISION' OR coalesce(cardinality(source_priority), 0) = 0) NOT VALID;

-- A merge and an unmerge are done by the checker in one command, on the authority of the rule and the reason they record, so the change request they stand on is APPLIED without a decision document (the table asked
-- for one for every applied change, which a publication of an entry names). The request of a merge or an unmerge is the only one that may be applied without it.
ALTER TABLE machvon.master_change_request DROP CONSTRAINT master_cr_publish_chk;
ALTER TABLE machvon.master_change_request ADD CONSTRAINT master_cr_publish_chk
  CHECK ((status = 'APPLIED') = (published_by IS NOT NULL AND published_at IS NOT NULL AND (decision_document_id IS NOT NULL OR change_kind IN ('MERGE', 'UNMERGE'))));

-- A revision published for a later day leaves the one in force alone until its day comes, so several can be PUBLISHED; two never share a day.
CREATE UNIQUE INDEX survivorship_rule_published_uq ON machvon.survivorship_rule (tenant_id, master_type, attribute_name, effective_from) WHERE status = 'PUBLISHED';

ALTER TABLE machvon.master_merge
  ADD CONSTRAINT master_merge_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000) NOT VALID,
  ADD CONSTRAINT master_merge_json_chk CHECK (jsonb_typeof(survivorship_json) = 'object' AND jsonb_typeof(alias_json) = 'object' AND jsonb_typeof(repointed_refs_json) = 'array') NOT VALID;

CREATE FUNCTION machvon.guard_survivorship_rule() RETURNS trigger
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
    RAISE EXCEPTION 'a rule of survivorship is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.master_type, NEW.attribute_name, NEW.strategy, NEW.source_priority, NEW.revision, NEW.effective_from, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.master_type, OLD.attribute_name, OLD.strategy, OLD.source_priority, OLD.revision, OLD.effective_from, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a rule of survivorship says never changes' USING ERRCODE = '42501';
  END IF;
  IF NOT (OLD.status = NEW.status OR (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'a rule of survivorship cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'who published a rule of survivorship never changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER survivorship_rule_guard BEFORE UPDATE OR DELETE ON machvon.survivorship_rule
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_survivorship_rule();
CREATE TRIGGER survivorship_rule_no_truncate BEFORE TRUNCATE ON machvon.survivorship_rule
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_survivorship_rule();

CREATE FUNCTION machvon.guard_master_merge() RETURNS trigger
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
    RAISE EXCEPTION 'a merge of master records is never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user USING ERRCODE = '42501';
  END IF;
  IF (NEW.survivor_record_id, NEW.merged_record_id, NEW.survivorship_json, NEW.alias_json, NEW.repointed_refs_json, NEW.reason, NEW.change_request_id, NEW.applied_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.survivor_record_id, OLD.merged_record_id, OLD.survivorship_json, OLD.alias_json, OLD.repointed_refs_json, OLD.reason, OLD.change_request_id, OLD.applied_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'what a merge of master records recorded never changes' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'REVERTED' AND (NEW.status, NEW.reverted_by, NEW.reverted_at, NEW.revert_reason) IS DISTINCT FROM (OLD.status, OLD.reverted_by, OLD.reverted_at, OLD.revert_reason) THEN
    RAISE EXCEPTION 'a merge is undone once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER master_merge_guard BEFORE UPDATE OR DELETE ON machvon.master_merge
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_master_merge();
CREATE TRIGGER master_merge_no_truncate BEFORE TRUNCATE ON machvon.master_merge
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_master_merge();

REVOKE DELETE, TRUNCATE ON TABLE machvon.survivorship_rule FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.master_merge FROM machvon_app;
