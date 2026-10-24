-- Authored by hand (not generated): composing an outgoing document, its review and the lock on its content (ST-DOC-007, BR-DOC-16, DOC F1 and F3).
--   * Once an outgoing document leaves the draft, its text, its signer, its recipients and its urgency are fixed (BR-DOC-16): only the return to
--     DRAFT opens them again. The statement that moves a document out of the draft cannot change them either. The template, the layout and
--     the source of a document never change after it is written, and the title of the document anchor follows the same lock.
--   * A cancelled draft is not a candidate for anything any more: its anchor is EXPIRED, which needs no symbol or number, and the unique
--     (source_ref, payload_sha256) of an open document frees the source to ask again.
--   * The status history of an outgoing document is kept for good: one row per transition, written in the command transaction, never
--     changed and never deleted. The review comment, the format checklist and the reason of a return live in it.
--   * Listing indexes for the queues of the screens (DOC-03, DOC-04).

CREATE OR REPLACE FUNCTION machvon.guard_outgoing_document() RETURNS trigger
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
    RAISE EXCEPTION 'outgoing documents are never deleted (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
      USING ERRCODE = '42501';
  END IF;
  IF NEW.document_id <> OLD.document_id
     OR NEW.drafter_user_id <> OLD.drafter_user_id
     OR NEW.drafting_unit_id <> OLD.drafting_unit_id
     OR NEW.layout_profile_id <> OLD.layout_profile_id THEN
    RAISE EXCEPTION 'the document, the drafter, the drafting unit and the layout of an outgoing document never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.source_module IS DISTINCT FROM OLD.source_module
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.issue_request_id IS DISTINCT FROM OLD.issue_request_id THEN
    RAISE EXCEPTION 'the template and the source of an outgoing document never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'DRAFT'
     AND (NEW.payload_json IS DISTINCT FROM OLD.payload_json
          OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
          OR NEW.signer_user_id IS DISTINCT FROM OLD.signer_user_id
          OR NEW.signer_title IS DISTINCT FROM OLD.signer_title
          OR NEW.signing_mode IS DISTINCT FROM OLD.signing_mode
          OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
          OR NEW.recipients IS DISTINCT FROM OLD.recipients
          OR NEW.urgency IS DISTINCT FROM OLD.urgency
          OR NEW.circulation IS DISTINCT FROM OLD.circulation) THEN
    RAISE EXCEPTION 'the content, the signer and the recipients of an outgoing document are fixed once it leaves the draft' USING ERRCODE = '23514';
  END IF;
  IF OLD.leader_signed_at IS NOT NULL AND NEW.leader_signed_at IS DISTINCT FROM OLD.leader_signed_at THEN
    RAISE EXCEPTION 'the instant of the leader signature never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at THEN
    RAISE EXCEPTION 'the instant of the organisation seal never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('SIGNED', 'NUMBERED', 'SEALED') AND NEW.status IN ('DRAFT', 'IN_REVIEW', 'SUBMITTED') THEN
    RAISE EXCEPTION 'a signed outgoing document does not go back to a state before the signature' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION machvon.guard_document_title() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' OR NEW.title IS NOT DISTINCT FROM OLD.title THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM machvon.outgoing_document o WHERE o.tenant_id = OLD.tenant_id AND o.document_id = OLD.id AND o.status <> 'DRAFT') THEN
    RAISE EXCEPTION 'the title of a document that left the draft is fixed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER document_title_guard BEFORE UPDATE ON machvon.document
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_document_title();

ALTER TABLE machvon.document DROP CONSTRAINT document_kind_chk;
ALTER TABLE machvon.document
  ADD CONSTRAINT document_kind_chk CHECK (doc_kind = 'ATTACHMENT' OR effect_status IN ('PENDING', 'EXPIRED') OR (symbol IS NOT NULL AND issued_on IS NOT NULL));
ALTER TABLE machvon.document DROP CONSTRAINT document_number_chk;
ALTER TABLE machvon.document
  ADD CONSTRAINT document_number_chk CHECK (doc_kind NOT IN ('OUTGOING', 'INCOMING') OR effect_status IN ('PENDING', 'EXPIRED') OR (document_number IS NOT NULL AND number_year IS NOT NULL));

-- A delegation named on a document is a delegation of the tenant; the index serves that reference.
ALTER TABLE machvon.outgoing_document
  ADD CONSTRAINT outgoing_document_delegation_fk FOREIGN KEY (tenant_id, delegation_id) REFERENCES machvon.delegation_grant (tenant_id, id);
CREATE INDEX outgoing_document_delegation_idx ON machvon.outgoing_document (tenant_id, delegation_id) WHERE delegation_id IS NOT NULL;

CREATE INDEX outgoing_document_unit_status_idx ON machvon.outgoing_document (tenant_id, drafting_unit_id, status);
CREATE INDEX outgoing_document_status_recent_idx ON machvon.outgoing_document (tenant_id, status, created_at DESC, id DESC);

CREATE TABLE machvon.outgoing_document_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  outgoing_document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z_]{2,39}$'),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid NOT NULL,
  comment text,
  details jsonb NOT NULL DEFAULT '{}',
  document_version bigint NOT NULL CHECK (document_version >= 1),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outgoing_document_id) REFERENCES machvon.outgoing_document (tenant_id, id)
);

CREATE INDEX outgoing_document_event_document_idx ON machvon.outgoing_document_event (tenant_id, outgoing_document_id, seq);
CREATE INDEX outgoing_document_event_actor_idx ON machvon.outgoing_document_event (tenant_id, actor_id);

ALTER TABLE machvon.outgoing_document_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.outgoing_document_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.outgoing_document_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.outgoing_document_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The history is written once: the runtime role may add rows and read them, nothing else.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.outgoing_document_event FROM machvon_app;

CREATE FUNCTION machvon.guard_outgoing_document_event() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_user = 'machvon_owner' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the status history of an outgoing document is never changed (% on %.% by %)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
    USING ERRCODE = '42501';
END;
$fn$;

CREATE TRIGGER outgoing_document_event_immutable BEFORE UPDATE OR DELETE ON machvon.outgoing_document_event
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_outgoing_document_event();
CREATE TRIGGER outgoing_document_event_no_truncate BEFORE TRUNCATE ON machvon.outgoing_document_event
  FOR EACH STATEMENT EXECUTE FUNCTION machvon.guard_outgoing_document_event();
