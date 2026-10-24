-- Authored by hand (not generated): the support ticket of a member (ST-IAM-007, IAM 3.6).
-- V002 gave `support_ticket` (code, requester, category, subject, a reference to the description, priority, status, assignee, SLA time) with the
-- row-level security of the tenant, the unique code per tenant and the foreign key to the requester. The platform operator sees the metadata of a ticket
-- and its SLA but never the business data of the tenant (NFR-PRIVACY-02), so what the member writes is kept apart from the metadata:
--   * the description is in its own table, which a view of the metadata never reads; `description_ref` of the ticket points at it;
--   * the code is SUP-YYYY-NNNNNN, the number counted per tenant and year by a counter that two tickets never share (the row of the counter is the lock);
--   * the metadata is checked: the subject is trimmed and between 5 and 200 characters, the code has its shape, the SLA time is after the creation;
--   * what the member wrote and the ticket's identity (code, requester, category, subject, priority, SLA time, creation) never change, and a ticket is never
--     deleted; its status, its assignee and its version are what the operator's side moves.

CREATE TABLE machvon.support_ticket_counter (
  tenant_id uuid NOT NULL,
  ticket_year integer NOT NULL CHECK (ticket_year BETWEEN 2000 AND 9999),
  last_value integer NOT NULL CHECK (last_value >= 1),
  PRIMARY KEY (tenant_id, ticket_year)
);

CREATE TABLE machvon.support_ticket_body (
  tenant_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 10 AND 10000),
  PRIMARY KEY (tenant_id, ticket_id),
  CONSTRAINT support_ticket_body_ticket_fk FOREIGN KEY (tenant_id, ticket_id) REFERENCES machvon.support_ticket (tenant_id, id)
);

CREATE TABLE machvon.support_ticket_attachment (
  tenant_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, ticket_id, document_version_id),
  CONSTRAINT support_ticket_attachment_ticket_fk FOREIGN KEY (tenant_id, ticket_id) REFERENCES machvon.support_ticket (tenant_id, id),
  CONSTRAINT support_ticket_attachment_document_fk FOREIGN KEY (tenant_id, document_version_id) REFERENCES machvon.document_version (tenant_id, id)
);
CREATE INDEX support_ticket_attachment_document_idx ON machvon.support_ticket_attachment (tenant_id, document_version_id);

ALTER TABLE machvon.support_ticket_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.support_ticket_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.support_ticket_counter AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.support_ticket_counter AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.support_ticket_body ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.support_ticket_body FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.support_ticket_body AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.support_ticket_body AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.support_ticket_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.support_ticket_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.support_ticket_attachment AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.support_ticket_attachment AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.support_ticket
  ADD CONSTRAINT support_ticket_code_chk CHECK (ticket_code ~ '^SUP-[0-9]{4}-[0-9]{6}$'),
  ADD CONSTRAINT support_ticket_subject_chk CHECK (subject = btrim(subject) AND char_length(subject) BETWEEN 5 AND 200),
  ADD CONSTRAINT support_ticket_sla_chk CHECK (sla_due_at > created_at);

CREATE INDEX support_ticket_listing_idx ON machvon.support_ticket (tenant_id, requester_membership_id, created_at DESC, id DESC);

CREATE FUNCTION machvon.guard_support_ticket() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a support ticket is never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'Open' THEN
      RAISE EXCEPTION 'a support ticket starts open' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.ticket_code, NEW.requester_membership_id, NEW.category, NEW.subject, NEW.description_ref, NEW.priority, NEW.sla_due_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.ticket_code, OLD.requester_membership_id, OLD.category, OLD.subject, OLD.description_ref, OLD.priority, OLD.sla_due_at, OLD.created_at) THEN
    RAISE EXCEPTION 'a support ticket keeps what the member asked for and its SLA' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER support_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON machvon.support_ticket
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_support_ticket();

CREATE FUNCTION machvon.guard_support_ticket_body() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'what the member wrote in a support ticket is never changed or deleted' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER support_ticket_body_guard BEFORE UPDATE OR DELETE ON machvon.support_ticket_body
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_support_ticket_body();
CREATE TRIGGER support_ticket_attachment_guard BEFORE UPDATE OR DELETE ON machvon.support_ticket_attachment
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_support_ticket_body();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.support_ticket_body FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.support_ticket_attachment FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.support_ticket FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.support_ticket_counter FROM machvon_app;
