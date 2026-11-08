-- Authored by hand (not generated): the push log of the reports sent to HPM (ENT-2, eng-review R8 and R17; the adapter is a file writer, PENDING-EXTERNAL under R18).
--   * `hpm_push`: one row per IDEMPOTENCY KEY (tenant, organisation, layout, period, revision): the key is unique, so a retry after a timeout can never become a second push. The row keeps the hash of the request
--     (the same key with other content is refused), the answer of the adapter, the number of attempts and the receipt the receiver gave. The person who recorded the receipt is never the person who pushed it.
--   * `hpm_push_attempt`: every try of a key, append-only: what was done, when, by whom and how it ended.
-- A push is accepted only when a person records the receipt of HPM; until then the most it can be is WRITTEN (the package was handed to the file sink).

CREATE TABLE machvon.hpm_push (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  org_unit_id uuid NOT NULL,
  layout_code text NOT NULL,
  period text NOT NULL,
  revision integer NOT NULL,
  sha256 char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  file_object_key text NOT NULL,
  snapshot_id uuid,
  snapshot_revision integer,
  snapshot_cutoff date,
  form_status text,
  demo_mark text,
  package_format text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  response jsonb,
  correction_id uuid,
  overwrites boolean NOT NULL DEFAULT false,
  pushed_by uuid NOT NULL,
  receipt_reference text,
  receipt_note text,
  receipt_by uuid,
  receipt_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hpm_push_key_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT hpm_push_key_chk CHECK (idempotency_key = btrim(idempotency_key) AND idempotency_key <> '' AND char_length(idempotency_key) <= 300),
  CONSTRAINT hpm_push_layout_chk CHECK (layout_code ~ '^[A-Z][A-Z0-9_-]{1,59}$'),
  CONSTRAINT hpm_push_period_chk CHECK (period ~ '^\d{4}(-(M(0[1-9]|1[0-2])|Q[1-4]|H[12]|(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])))?$'),
  CONSTRAINT hpm_push_revision_chk CHECK (revision BETWEEN 1 AND 10000),
  CONSTRAINT hpm_push_hash_chk CHECK (sha256 ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hpm_push_object_chk CHECK (file_object_key = btrim(file_object_key) AND file_object_key <> '' AND char_length(file_object_key) <= 500),
  CONSTRAINT hpm_push_snapshot_chk CHECK ((snapshot_id IS NULL) = (snapshot_revision IS NULL) AND (snapshot_id IS NULL) = (snapshot_cutoff IS NULL) AND (snapshot_revision IS NULL OR snapshot_revision >= 1)),
  CONSTRAINT hpm_push_marks_chk CHECK (form_status IS NULL OR form_status IN ('PENDING_EXTERNAL', 'DEMO', 'DRAFT', 'READY')),
  CONSTRAINT hpm_push_status_chk CHECK (status IN ('PENDING', 'WRITTEN', 'FAILED', 'ACCEPTED', 'REJECTED')),
  CONSTRAINT hpm_push_attempts_chk CHECK (attempts >= 1),
  CONSTRAINT hpm_push_error_chk CHECK ((status = 'FAILED') = (last_error_code IS NOT NULL)),
  CONSTRAINT hpm_push_response_chk CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
  CONSTRAINT hpm_push_receipt_chk CHECK (
    (status IN ('ACCEPTED', 'REJECTED')) = (receipt_by IS NOT NULL AND receipt_at IS NOT NULL AND receipt_reference IS NOT NULL)
    AND (status IN ('ACCEPTED', 'REJECTED') OR (receipt_reference IS NULL AND receipt_note IS NULL AND receipt_by IS NULL AND receipt_at IS NULL))
    AND (status <> 'REJECTED' OR (receipt_note IS NOT NULL AND char_length(receipt_note) >= 10))
  ),
  CONSTRAINT hpm_push_maker_checker_chk CHECK (receipt_by IS NULL OR receipt_by <> pushed_by),
  CONSTRAINT hpm_push_demo_chk CHECK (NOT (status = 'ACCEPTED' AND form_status = 'DEMO')),
  CONSTRAINT hpm_push_version_chk CHECK (version >= 1)
);

CREATE INDEX hpm_push_series_idx ON machvon.hpm_push (tenant_id, org_unit_id, layout_code, period, revision DESC);
CREATE INDEX hpm_push_status_idx ON machvon.hpm_push (tenant_id, status, last_attempt_at DESC, id);
CREATE INDEX hpm_push_correction_idx ON machvon.hpm_push (tenant_id, correction_id) WHERE correction_id IS NOT NULL;
CREATE INDEX hpm_push_snapshot_idx ON machvon.hpm_push (tenant_id, snapshot_id) WHERE snapshot_id IS NOT NULL;
CREATE INDEX hpm_push_actor_idx ON machvon.hpm_push (tenant_id, pushed_by, created_at DESC);

CREATE TABLE machvon.hpm_push_attempt (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  push_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  error_code text,
  package_sha256 char(64),
  actor_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, push_id) REFERENCES machvon.hpm_push (tenant_id, id),
  CONSTRAINT hpm_push_attempt_uq UNIQUE (tenant_id, push_id, attempt_no),
  CONSTRAINT hpm_push_attempt_no_chk CHECK (attempt_no >= 1),
  CONSTRAINT hpm_push_attempt_outcome_chk CHECK (outcome IN ('WRITTEN', 'FAILED')),
  CONSTRAINT hpm_push_attempt_error_chk CHECK ((outcome = 'FAILED') = (error_code IS NOT NULL)),
  CONSTRAINT hpm_push_attempt_hash_chk CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX hpm_push_attempt_actor_idx ON machvon.hpm_push_attempt (tenant_id, actor_id, attempted_at DESC);

CREATE FUNCTION machvon.hpm_push_attempt_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the attempts of a push are append-only' USING ERRCODE = '23514';
END;
$fn$;

CREATE TRIGGER hpm_push_attempt_append_only BEFORE UPDATE OR DELETE ON machvon.hpm_push_attempt FOR EACH ROW EXECUTE FUNCTION machvon.hpm_push_attempt_append_only();

-- A push keeps what identifies it for ever; its state moves along the edges of the life of a push only, and the attempts never go back.
CREATE FUNCTION machvon.guard_hpm_push() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id OR NEW.layout_code IS DISTINCT FROM OLD.layout_code
     OR NEW.period IS DISTINCT FROM OLD.period OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.file_object_key IS DISTINCT FROM OLD.file_object_key OR NEW.pushed_by IS DISTINCT FROM OLD.pushed_by OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.form_status IS DISTINCT FROM OLD.form_status OR NEW.demo_mark IS DISTINCT FROM OLD.demo_mark OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
    RAISE EXCEPTION 'a push keeps its key, its report and its origin' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'the attempts of a push never go back' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('ACCEPTED', 'REJECTED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a push the receiver answered is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('WRITTEN', 'FAILED'))
    OR (OLD.status = 'FAILED' AND NEW.status IN ('WRITTEN', 'FAILED'))
    OR (OLD.status = 'WRITTEN' AND NEW.status IN ('FAILED', 'ACCEPTED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'a push does not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hpm_push_guard BEFORE UPDATE ON machvon.hpm_push FOR EACH ROW EXECUTE FUNCTION machvon.guard_hpm_push();

ALTER TABLE machvon.hpm_push ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hpm_push FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hpm_push AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hpm_push AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.hpm_push_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hpm_push_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hpm_push_attempt AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hpm_push_attempt AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE ON TABLE machvon.hpm_push FROM machvon_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.hpm_push_attempt FROM machvon_app;

COMMENT ON TABLE machvon.hpm_push IS 'ENT-2: the push of an issued report to HPM, one row per idempotency key (organisation, layout, period, revision); the receipt is recorded by a person other than the pusher; PENDING-EXTERNAL.';
COMMENT ON TABLE machvon.hpm_push_attempt IS 'ENT-2: every try of a push key; append-only.';
