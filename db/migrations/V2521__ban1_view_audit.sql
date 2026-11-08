-- Authored by hand (not generated): the audit of every view of a sensitive screen of the committee workspace (BAN-1, docs/committee-workspace.md "Access and audit").
-- The head of the committee belongs to a security service and the workspace shows the figures of every investor of the province: who looked, when, at which screen, with which filters and on which feed is written for EVERY
-- view, in the same transaction as the read (a read that cannot be recorded does not answer). The row never holds a figure, only counts and filters; it is append-only (the database refuses a change or a removal) and
-- anonymous access cannot happen: `membership_id` is required. `assurance_level` is the hook for the infrastructure phase (SSO and MFA): UNKNOWN or PASSWORD today, MFA once the identity provider is wired.

CREATE TABLE machvon.committee_view_audit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  committee_role text CHECK (committee_role IS NULL OR committee_role IN ('HEAD', 'DEPUTY', 'MEMBER', 'SECRETARIAT')),
  screen text NOT NULL CHECK (screen IN ('WORKSPACE', 'ATTENTION', 'MEETING_PACK', 'DIRECTIVE_TRACKER', 'ALERTS', 'ROSTER', 'VIEW_AUDIT')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  as_of date,
  record_count integer CHECK (record_count IS NULL OR record_count >= 0),
  feed_basis text CHECK (feed_basis IS NULL OR feed_basis IN ('DIS_SNAPSHOT', 'CORE_LIVE')),
  feed_reference text CHECK (feed_reference IS NULL OR char_length(feed_reference) <= 200),
  classification text NOT NULL CHECK (classification IN ('CONFIDENTIAL', 'PERSONAL')),
  assurance_level text NOT NULL DEFAULT 'UNKNOWN' CHECK (assurance_level IN ('UNKNOWN', 'PASSWORD', 'MFA')),
  mfa_required boolean NOT NULL DEFAULT false,
  request_id text CHECK (request_id IS NULL OR char_length(request_id) <= 100),
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES machvon.membership (tenant_id, id)
);

CREATE INDEX committee_view_audit_recent_idx ON machvon.committee_view_audit (tenant_id, viewed_at DESC, id DESC);
CREATE INDEX committee_view_audit_member_idx ON machvon.committee_view_audit (tenant_id, membership_id, viewed_at DESC);
CREATE INDEX committee_view_audit_screen_idx ON machvon.committee_view_audit (tenant_id, screen, viewed_at DESC);

CREATE FUNCTION machvon.committee_view_audit_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the audit of views of the committee workspace is append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER committee_view_audit_guard BEFORE UPDATE OR DELETE ON machvon.committee_view_audit FOR EACH ROW EXECUTE FUNCTION machvon.committee_view_audit_guard();

ALTER TABLE machvon.committee_view_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.committee_view_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.committee_view_audit AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.committee_view_audit AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.committee_view_audit FROM machvon_app;

COMMENT ON TABLE machvon.committee_view_audit IS 'BAN-1: one row per view of a sensitive screen of the committee workspace (who, when, screen, filters, feed, assurance level); append-only.';
