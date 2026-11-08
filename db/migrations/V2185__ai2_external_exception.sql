-- Authored by hand (not generated): the approved exceptions that let data go to a provider outside the customer servers, and the log of every use (lane AI-2, eng-review R5, KT.02, requirement AI.07).
-- Where an edition keeps processing on the servers of the customer (the kernel module `ai-edition-policy` says so for the edition the process serves), a request that the routes would send to any other provider is refused
-- unless an exception of that provider stands: asked for by one person with a reason, approved by another with a validity of at most 90 days, and logged each time it is used. The exception names the provider, the highest
-- class of data it covers and, optionally, the one task it is for; it ends by its date or when a person revokes it. Nothing is deleted: the history of who allowed what, until when, and every request that used it, stays.
--   * `ai_external_exception`: one row per exception with a version (the commands send If-Match); the person who approves is not the one who asked (a check), an approval carries its validity and a reference of the
--     paper of the approval, and an approved exception that is revoked keeps who revoked it and why;
--   * `ai_external_exception_use`: what a request that went out under an exception wrote, append-only for every role (the request, the provider, the class, the route, the moment).

CREATE TABLE machvon.ai_external_exception (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL,
  task_type text,
  max_classification text NOT NULL,
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_valid_days integer NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED',
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  approval_ref text,
  valid_from timestamptz,
  valid_until timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  revoke_reason text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES machvon.ai_provider (tenant_id, id),
  CONSTRAINT ai_external_exception_task_chk CHECK (task_type IS NULL OR task_type ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  CONSTRAINT ai_external_exception_class_chk CHECK (max_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE')),
  CONSTRAINT ai_external_exception_reason_chk CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 20 AND 2000),
  CONSTRAINT ai_external_exception_days_chk CHECK (requested_valid_days BETWEEN 1 AND 90),
  CONSTRAINT ai_external_exception_status_chk CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED')),
  CONSTRAINT ai_external_exception_decision_chk CHECK ((status = 'REQUESTED') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT ai_external_exception_note_chk CHECK (decision_note IS NULL OR (decision_note = btrim(decision_note) AND char_length(decision_note) BETWEEN 10 AND 2000)),
  CONSTRAINT ai_external_exception_maker_checker_chk CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT ai_external_exception_validity_chk CHECK ((status IN ('APPROVED', 'REVOKED') AND valid_from IS NOT NULL AND valid_until IS NOT NULL AND approval_ref IS NOT NULL AND valid_until > valid_from AND valid_until <= valid_from + interval '90 days' + interval '1 minute')
    OR (status IN ('REQUESTED', 'REJECTED') AND valid_from IS NULL AND valid_until IS NULL)),
  CONSTRAINT ai_external_exception_approval_ref_chk CHECK (approval_ref IS NULL OR (approval_ref = btrim(approval_ref) AND char_length(approval_ref) BETWEEN 3 AND 300)),
  CONSTRAINT ai_external_exception_revoke_chk CHECK ((status = 'REVOKED') = (revoked_by IS NOT NULL) AND (revoked_by IS NULL) = (revoked_at IS NULL) AND (revoked_by IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT ai_external_exception_revoke_reason_chk CHECK (revoke_reason IS NULL OR (revoke_reason = btrim(revoke_reason) AND char_length(revoke_reason) BETWEEN 10 AND 2000)),
  CONSTRAINT ai_external_exception_version_chk CHECK (version >= 1)
);
CREATE INDEX ai_external_exception_provider_idx ON machvon.ai_external_exception (tenant_id, provider_id, status, valid_until);
CREATE INDEX ai_external_exception_status_idx ON machvon.ai_external_exception (tenant_id, status, requested_at DESC, id DESC);

CREATE FUNCTION machvon.guard_ai_external_exception() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an exception is never deleted: its history stays' USING ERRCODE = '23514', CONSTRAINT = 'ai_external_exception_guard';
  END IF;
  IF NEW.provider_id <> OLD.provider_id OR NEW.task_type IS DISTINCT FROM OLD.task_type OR NEW.max_classification <> OLD.max_classification OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at OR NEW.requested_valid_days <> OLD.requested_valid_days THEN
    RAISE EXCEPTION 'what an exception allows does not change: a new request is made' USING ERRCODE = '23514', CONSTRAINT = 'ai_external_exception_guard';
  END IF;
  IF OLD.status IN ('REJECTED', 'REVOKED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a rejected or revoked exception is closed' USING ERRCODE = '23514', CONSTRAINT = 'ai_external_exception_guard';
  END IF;
  IF OLD.status = 'APPROVED' AND (NEW.status NOT IN ('APPROVED', 'REVOKED') OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.approval_ref IS DISTINCT FROM OLD.approval_ref) THEN
    RAISE EXCEPTION 'an approved exception can only be revoked' USING ERRCODE = '23514', CONSTRAINT = 'ai_external_exception_guard';
  END IF;
  IF OLD.status = 'REQUESTED' AND NEW.status = 'REVOKED' THEN
    RAISE EXCEPTION 'only an approved exception is revoked' USING ERRCODE = '23514', CONSTRAINT = 'ai_external_exception_guard';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ai_external_exception_guard BEFORE UPDATE OR DELETE ON machvon.ai_external_exception FOR EACH ROW EXECUTE FUNCTION machvon.guard_ai_external_exception();

CREATE TABLE machvon.ai_external_exception_use (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  exception_id uuid NOT NULL,
  ai_request_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  task_type text NOT NULL,
  data_classification text NOT NULL,
  route_class text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, exception_id) REFERENCES machvon.ai_external_exception (tenant_id, id),
  FOREIGN KEY (tenant_id, ai_request_id) REFERENCES machvon.ai_request (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_id) REFERENCES machvon.ai_provider (tenant_id, id),
  CONSTRAINT ai_external_exception_use_class_chk CHECK (data_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE')),
  CONSTRAINT ai_external_exception_use_route_chk CHECK (route_class IN ('DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL')),
  CONSTRAINT ai_external_exception_use_uq UNIQUE (tenant_id, ai_request_id, exception_id)
);
CREATE INDEX ai_external_exception_use_exception_idx ON machvon.ai_external_exception_use (tenant_id, exception_id, used_at DESC, id DESC);
CREATE INDEX ai_external_exception_use_provider_idx ON machvon.ai_external_exception_use (tenant_id, provider_id, used_at DESC);

CREATE FUNCTION machvon.ai_external_exception_use_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the log of the use of an exception is append-only' USING ERRCODE = '23514', CONSTRAINT = 'ai_external_exception_use_append_only';
END;
$fn$;

CREATE TRIGGER ai_external_exception_use_append_only BEFORE UPDATE OR DELETE ON machvon.ai_external_exception_use FOR EACH ROW EXECUTE FUNCTION machvon.ai_external_exception_use_append_only();

ALTER TABLE machvon.ai_external_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_external_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_external_exception AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_external_exception AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.ai_external_exception_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.ai_external_exception_use FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.ai_external_exception_use AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.ai_external_exception_use AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.ai_external_exception FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.ai_external_exception_use FROM machvon_app;

COMMENT ON TABLE machvon.ai_external_exception IS 'AI-2 (R5, KT.02): an approved, time-limited exception that lets data go to a provider outside the customer servers; asked for and approved by two people.';
COMMENT ON TABLE machvon.ai_external_exception_use IS 'AI-2 (R5): every request that went out under an exception; append-only.';
