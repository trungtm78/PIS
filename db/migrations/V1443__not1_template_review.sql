-- Authored by hand (not generated), ST-NOT-005 (NOT 3.4, BR-NOT-10, BR-NOT-11): the templates of the messages, their review and the test sends.
--   * a template revision is written as a Draft and then only moves forward (Draft → InReview or PendingProvider → Active or Rejected, Active → Retired); what it says (code, channel, locale, revision, content, variables, purpose,
--     lock-screen flag, who wrote it) never changes once it leaves Draft, and a revision is never deleted: TEMPLATE_IMMUTABLE;
--   * a template that goes to a provider (ZALO_ZNS, WHATSAPP) is not Active without the approval of the provider (V002 has the check);
--   * the people a test message may be sent to are listed by the tenant, at most ten (notification_test_recipient).

-- When the revision was written: the order of the pages of the editor.
ALTER TABLE machvon.notification_template_version ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION machvon.guard_notification_template() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TEMPLATE_IMMUTABLE: a template revision is kept and never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'TEMPLATE_IMMUTABLE: what a revision is does not change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'Draft' AND (
       NEW.code IS DISTINCT FROM OLD.code OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.locale IS DISTINCT FROM OLD.locale OR NEW.revision IS DISTINCT FROM OLD.revision
       OR NEW.content_ast IS DISTINCT FROM OLD.content_ast OR NEW.variable_schema IS DISTINCT FROM OLD.variable_schema OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.lockscreen_safe IS DISTINCT FROM OLD.lockscreen_safe OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id) THEN
    RAISE EXCEPTION 'TEMPLATE_IMMUTABLE: a revision that has left Draft does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (
       ('Draft', 'InReview'), ('Draft', 'PendingProvider'), ('InReview', 'Active'), ('InReview', 'Rejected'), ('InReview', 'Draft'),
       ('PendingProvider', 'Active'), ('PendingProvider', 'Rejected'), ('PendingProvider', 'Draft'), ('Active', 'Retired'))) THEN
    RAISE EXCEPTION 'TEMPLATE_IMMUTABLE: a revision does not go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER notification_template_guard BEFORE UPDATE OR DELETE ON machvon.notification_template_version
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_notification_template();
REVOKE DELETE, TRUNCATE ON TABLE machvon.notification_template_version FROM machvon_app;

-- One Active revision for each code × channel × locale, whatever the order the approvals come in.
CREATE UNIQUE INDEX notification_template_active_uq ON machvon.notification_template_version (tenant_id, code, channel, locale) WHERE status = 'Active';

-- The revisions of a code, newest first (the editor and the pickers).
CREATE INDEX notification_template_page_idx ON machvon.notification_template_version (tenant_id, code, channel, locale, revision DESC);

CREATE TABLE machvon.notification_test_recipient (
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  added_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX notification_test_recipient_added_by_idx ON machvon.notification_test_recipient (tenant_id, added_by);

ALTER TABLE machvon.notification_test_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.notification_test_recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.notification_test_recipient AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.notification_test_recipient AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE TRUNCATE ON TABLE machvon.notification_test_recipient FROM machvon_app;
