-- Authored by hand (not generated): the contractor portal (VND-3, research V15; docs/vendor-investigation.md section 5).
-- A contractor is a guest member bound to one contractor (membership_type GUEST_CONTRACTOR, ADM-17). The portal gives it a channel of requests and answers, and the yearly confirmation of its profile with the declaration of integrity.
--   * contractor_portal_request: staff ask the contractor for something (an answer to an evaluation, a certificate, an update of the profile, information, a clarification of a screening hit, an answer on a plan of remediation)
--     with a time limit counted by the rule VENDOR_PORTAL; the contractor answers once per round (a returned request opens again for another round); a late answer is kept and marked late, never refused; staff accept it or
--     return it with a reason. The person who answers is never the person who accepts.
--   * contractor_portal_request_event: the append-only history of a request.
--   * contractor_reconfirmation: one row per confirmation of the profile by the contractor (append-only): the day it satisfied, the next day it falls due, the version and the SHA-256 of the declaration text it signed, the SHA-256 of the
--     profile as it was shown, and what the contractor said had changed.

CREATE TABLE machvon.contractor_portal_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EVALUATION_RESPONSE', 'CERTIFICATE_UPLOAD', 'PROFILE_UPDATE', 'INFORMATION', 'SCREENING_CLARIFICATION', 'REMEDIATION_RESPONSE', 'OTHER')),
  subject_type text CHECK (subject_type IS NULL OR subject_type IN ('CONTRACT', 'PERFORMANCE', 'QUALIFICATION', 'SCREENING_HIT', 'REMEDIATION_PLAN', 'RESTRICTION_CASE', 'PACKAGE')),
  subject_id uuid,
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 3 AND 200),
  body text NOT NULL CHECK (char_length(body) <= 4000),
  due_at timestamptz NOT NULL,
  deadline_policy_version text NOT NULL,
  remind_before_days integer NOT NULL CHECK (remind_before_days BETWEEN 0 AND 60),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESPONDED', 'ACCEPTED', 'CANCELLED')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  response_text text CHECK (response_text IS NULL OR (response_text = btrim(response_text) AND char_length(response_text) BETWEEN 1 AND 4000)),
  response_document_id uuid,
  response_qualification_id uuid,
  responded_by uuid,
  responded_at timestamptz,
  response_late boolean,
  round integer NOT NULL DEFAULT 1 CHECK (round >= 1),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR (review_note = btrim(review_note) AND char_length(review_note) BETWEEN 1 AND 2000)),
  cancelled_reason text CHECK (cancelled_reason IS NULL OR (cancelled_reason = btrim(cancelled_reason) AND char_length(cancelled_reason) BETWEEN 5 AND 500)),
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, responded_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, response_qualification_id) REFERENCES machvon.contractor_qualification (tenant_id, id),
  CONSTRAINT portal_request_answer_chk CHECK ((responded_at IS NULL) = (responded_by IS NULL) AND (responded_at IS NULL) = (response_late IS NULL)),
  CONSTRAINT portal_request_status_chk CHECK (status NOT IN ('RESPONDED', 'ACCEPTED') OR responded_at IS NOT NULL),
  CONSTRAINT portal_request_review_chk CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL) AND (status <> 'ACCEPTED' OR reviewed_at IS NOT NULL)),
  CONSTRAINT portal_request_sod_chk CHECK (reviewed_by IS NULL OR responded_by IS NULL OR reviewed_by <> responded_by),
  CONSTRAINT portal_request_cancel_chk CHECK ((status = 'CANCELLED') = (cancelled_reason IS NOT NULL))
);
CREATE INDEX portal_request_contractor_idx ON machvon.contractor_portal_request (tenant_id, contractor_id, status, due_at);
CREATE INDEX portal_request_open_idx ON machvon.contractor_portal_request (tenant_id, status, due_at) WHERE status IN ('OPEN', 'RESPONDED');
CREATE INDEX portal_request_requester_idx ON machvon.contractor_portal_request (tenant_id, requested_by);
CREATE INDEX portal_request_responder_idx ON machvon.contractor_portal_request (tenant_id, responded_by) WHERE responded_by IS NOT NULL;
CREATE INDEX portal_request_reviewer_idx ON machvon.contractor_portal_request (tenant_id, reviewed_by) WHERE reviewed_by IS NOT NULL;
CREATE INDEX portal_request_subject_idx ON machvon.contractor_portal_request (tenant_id, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX portal_request_qualification_idx ON machvon.contractor_portal_request (tenant_id, response_qualification_id) WHERE response_qualification_id IS NOT NULL;
CREATE INDEX portal_request_document_idx ON machvon.contractor_portal_request (tenant_id, response_document_id) WHERE response_document_id IS NOT NULL;

ALTER TABLE machvon.contractor_portal_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_portal_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_portal_request AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_portal_request AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.contractor_portal_request FROM machvon_app;

COMMENT ON TABLE machvon.contractor_portal_request IS 'VND-3: a request of staff to a contractor and its answer through the portal, with a time limit; a late answer is kept and marked late.';

CREATE TABLE machvon.contractor_portal_request_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('OPEN', 'RESPOND', 'ACCEPT', 'RETURN', 'CANCEL')),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES machvon.contractor_portal_request (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES machvon.membership (tenant_id, id)
);
CREATE INDEX portal_event_request_idx ON machvon.contractor_portal_request_event (tenant_id, request_id, at);
CREATE INDEX portal_event_contractor_idx ON machvon.contractor_portal_request_event (tenant_id, contractor_id);
CREATE INDEX portal_event_actor_idx ON machvon.contractor_portal_request_event (tenant_id, actor_id, at DESC);

ALTER TABLE machvon.contractor_portal_request_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_portal_request_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_portal_request_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_portal_request_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contractor_portal_request_event FROM machvon_app;
CREATE TRIGGER contractor_portal_request_event_append_only BEFORE UPDATE OR DELETE ON machvon.contractor_portal_request_event FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.contractor_portal_request_event IS 'VND-3: the append-only history of a request to a contractor.';

CREATE TABLE machvon.contractor_reconfirmation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  confirmed_by uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_on date NOT NULL,
  satisfied_due_on date,
  next_due_on date NOT NULL,
  declaration_version text NOT NULL CHECK (char_length(declaration_version) BETWEEN 1 AND 40),
  declaration_sha256 char(64) NOT NULL CHECK (declaration_sha256 ~ '^[0-9a-f]{64}$'),
  profile_sha256 char(64) NOT NULL CHECK (profile_sha256 ~ '^[0-9a-f]{64}$'),
  changes_note text CHECK (changes_note IS NULL OR (changes_note = btrim(changes_note) AND char_length(changes_note) BETWEEN 1 AND 2000)),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES machvon.contractor (tenant_id, id),
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT reconfirmation_period_chk CHECK (next_due_on > confirmed_on)
);
CREATE INDEX reconfirmation_contractor_idx ON machvon.contractor_reconfirmation (tenant_id, contractor_id, confirmed_at DESC);
CREATE INDEX reconfirmation_actor_idx ON machvon.contractor_reconfirmation (tenant_id, confirmed_by);

ALTER TABLE machvon.contractor_reconfirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.contractor_reconfirmation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.contractor_reconfirmation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.contractor_reconfirmation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.contractor_reconfirmation FROM machvon_app;
CREATE TRIGGER contractor_reconfirmation_append_only BEFORE UPDATE OR DELETE ON machvon.contractor_reconfirmation FOR EACH ROW EXECUTE FUNCTION machvon.vnd3_append_only();

COMMENT ON TABLE machvon.contractor_reconfirmation IS 'VND-3: one yearly confirmation of the profile by the contractor, with the declaration of integrity it signed (version and hash of the text).';
