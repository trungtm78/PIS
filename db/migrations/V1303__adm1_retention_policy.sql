-- Authored by hand (not generated): retention policy versions and the review list of the retention job (ST-ADM-017, ADM 3.12, BR-ADM-11).
-- V002 gave data_retention_policy its columns, the unique (record_class, revision), the rule that PERMANENT holds exactly when no number
-- of years is given, and the first four-eyes check (the approver is not the author). This slice adds what the workflow needs to be
-- provable from the database alone:
--   * published_at, and the facts that go with each status (a draft has no approver, a published version has one and a time);
--   * the classes and end actions: a job purges a technical class and only a technical class (BR-ADM-11), and nothing but the five
--     technical classes is purged; the code of the platform (packages/kernel/src/retention.ts) holds the same list and a test compares them;
--   * one version in force and one open draft per record class;
--   * a guard that keeps the content of a version for good and lets its status move along Draft, Published, Superseded only;
--   * the runtime role may not delete a version: the rules a record was kept under are themselves records.
-- It also adds the review list: what the daily job finds expired in a business class lands there, it is never deleted.

ALTER TABLE machvon.data_retention_policy ADD COLUMN published_at timestamptz;

ALTER TABLE machvon.data_retention_policy
  ADD CONSTRAINT data_retention_policy_class_chk CHECK (record_class ~ '^[a-z][a-z0-9_]{1,79}$'),
  ADD CONSTRAINT data_retention_policy_years_chk CHECK (retention_years IS NULL OR retention_years BETWEEN 1 AND 100),
  ADD CONSTRAINT data_retention_policy_legal_basis_chk CHECK (legal_basis_ref = btrim(legal_basis_ref) AND char_length(legal_basis_ref) BETWEEN 5 AND 500),
  ADD CONSTRAINT data_retention_policy_draft_chk CHECK (status <> 'Draft' OR (approved_by IS NULL AND published_at IS NULL)),
  ADD CONSTRAINT data_retention_policy_published_chk CHECK (status <> 'Published' OR (approved_by IS NOT NULL AND published_at IS NOT NULL)),
  -- BR-ADM-11: AUTO_PURGE_TECHNICAL only for a technical class, and a technical class is only purged.
  ADD CONSTRAINT data_retention_policy_purge_chk CHECK (
    (end_action = 'AUTO_PURGE_TECHNICAL') = (record_class IN ('idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'delivery_attempt'))),
  ADD CONSTRAINT data_retention_policy_technical_basis_chk CHECK (
    record_class NOT IN ('idempotency_record', 'outbox_event', 'integration_event_inbox', 'user_session', 'delivery_attempt')
    OR retention_basis IN ('FROM_CREATED', 'PERMANENT'));

CREATE UNIQUE INDEX data_retention_policy_published_uq ON machvon.data_retention_policy (tenant_id, record_class) WHERE status = 'Published';
CREATE UNIQUE INDEX data_retention_policy_draft_uq ON machvon.data_retention_policy (tenant_id, record_class) WHERE status = 'Draft';
CREATE INDEX data_retention_policy_list_idx ON machvon.data_retention_policy (tenant_id, record_class, revision DESC);

REVOKE DELETE, TRUNCATE ON TABLE machvon.data_retention_policy FROM machvon_app;

-- Transitions: Draft to Published (publish) or to Superseded (a newer draft replaced it), and Published to Superseded. Superseded is final.
-- Identity and content never change; the approver and the time are set by the publication and never again.
CREATE FUNCTION machvon.guard_retention_policy_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.record_class IS DISTINCT FROM OLD.record_class OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.retention_years IS DISTINCT FROM OLD.retention_years OR NEW.retention_basis IS DISTINCT FROM OLD.retention_basis
     OR NEW.legal_basis_ref IS DISTINCT FROM OLD.legal_basis_ref OR NEW.end_action IS DISTINCT FROM OLD.end_action
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'a retention policy version never changes its content' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'Superseded' THEN
    RAISE EXCEPTION 'a superseded retention policy version never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'Draft' AND NEW.status IN ('Published', 'Superseded'))
    OR (OLD.status = 'Published' AND NEW.status = 'Superseded')) THEN
    RAISE EXCEPTION 'this change of the state of a retention policy version is not allowed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND NOT (OLD.status = 'Draft' AND NEW.status = 'Published') THEN
    RAISE EXCEPTION 'the approver and the time of publication are set by the publication only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER retention_policy_guard BEFORE UPDATE ON machvon.data_retention_policy
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_retention_policy_update();

-- The review list: a record of a business class whose period has run out. The job lists it once (the unique key makes a second run
-- change nothing); a person decides what happens to it (the council of the Law on Archives, ADM.md section 3.12). The runtime role
-- cannot remove an item: that a record was due for review is itself evidence.
CREATE TABLE machvon.retention_review_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  record_class text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  basis_date date NOT NULL,
  due_on date NOT NULL,
  end_action text NOT NULL CHECK (end_action IN ('REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER')),
  status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW')),
  listed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, record_class, resource_id),
  CHECK (due_on > basis_date)
);

CREATE INDEX retention_review_item_resource_idx ON machvon.retention_review_item (tenant_id, resource_id);
CREATE INDEX retention_review_item_policy_idx ON machvon.retention_review_item (tenant_id, policy_id);
CREATE INDEX retention_review_item_list_idx ON machvon.retention_review_item (tenant_id, due_on, id);

ALTER TABLE machvon.retention_review_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.retention_review_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.retention_review_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.retention_review_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.retention_review_item FROM machvon_app;

-- The payload of an inbox event is removed after 90 days (BR-ADM-11) while its metadata stays two years: the key (provider, event_key)
-- that rejects a repeated delivery must outlive the payload. A purged payload has no reference and a time of purge.
ALTER TABLE machvon.integration_event_inbox ALTER COLUMN payload_reference DROP NOT NULL;
ALTER TABLE machvon.integration_event_inbox ADD COLUMN payload_purged_at timestamptz;
ALTER TABLE machvon.integration_event_inbox
  ADD CONSTRAINT integration_event_inbox_payload_chk CHECK ((payload_reference IS NULL) = (payload_purged_at IS NOT NULL));
