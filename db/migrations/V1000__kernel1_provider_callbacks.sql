-- Authored by hand (not generated): the provider callback kernel (ST-KERNEL-071, NFR-SECURITY-10, NFR-OPERABILITY-05).
-- A callback is verified, then written once to integration_event_inbox (V002; unique per tenant, provider and event key), then applied to
-- a tracked item whose status only moves forward. This slice adds what that needs to be provable from the database alone:
--   * provider_status_item: the status of one thing a provider reports on (a message, a payment, a signing request) per tenant and
--     provider, with a version that grows with every change and a guard that keeps its identity for good.
--   * provider_status_history: one row per change of status, never changed or removed. A duplicate or late callback adds none.
--   * provider_reconciliation_task: the work item that a lost acknowledgement (UNCERTAIN) or two callbacks that disagree leave behind;
--     one open task per item and reason, closed by a person with a note.
--   * a guard on the inbox: the identity of an event (provider, key, hash, signing key) never changes, and a processed event stays so.

CREATE TABLE machvon.provider_status_item (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  last_event_id uuid,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT provider_status_item_provider_chk CHECK (provider = btrim(provider) AND provider <> '' AND char_length(provider) <= 80),
  CONSTRAINT provider_status_item_subject_type_chk CHECK (subject_type ~ '^[a-z][a-z0-9_]*$' AND char_length(subject_type) <= 80),
  CONSTRAINT provider_status_item_status_chk CHECK (status ~ '^[A-Z][A-Z0-9_]*$' AND char_length(status) <= 50),
  CONSTRAINT provider_status_item_version_chk CHECK (version >= 1),
  CONSTRAINT provider_status_item_event_chk CHECK (last_event_id IS NULL OR last_event_at IS NOT NULL)
);

CREATE UNIQUE INDEX provider_status_item_subject_uq ON machvon.provider_status_item (tenant_id, provider, subject_type, subject_id);
CREATE INDEX provider_status_item_status_idx ON machvon.provider_status_item (tenant_id, status, updated_at);
CREATE INDEX provider_status_item_subject_idx ON machvon.provider_status_item (tenant_id, subject_id);
CREATE INDEX provider_status_item_last_event_idx ON machvon.provider_status_item (tenant_id, last_event_id);

CREATE TABLE machvon.provider_status_history (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  item_version bigint NOT NULL,
  from_status text,
  to_status text NOT NULL,
  cause text NOT NULL,
  inbox_event_id uuid,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT provider_status_history_cause_chk CHECK (cause IN ('CREATED', 'CALLBACK', 'UNCERTAIN', 'RECONCILED')),
  CONSTRAINT provider_status_history_from_chk CHECK ((cause = 'CREATED') = (from_status IS NULL)),
  CONSTRAINT provider_status_history_event_chk CHECK ((cause = 'CALLBACK') = (inbox_event_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, item_id) REFERENCES machvon.provider_status_item (tenant_id, id)
);

-- One row per version of an item, and one per callback event: a replay of the same event cannot add a second change.
CREATE UNIQUE INDEX provider_status_history_version_uq ON machvon.provider_status_history (tenant_id, item_id, item_version);
CREATE UNIQUE INDEX provider_status_history_event_uq ON machvon.provider_status_history (tenant_id, item_id, inbox_event_id) WHERE inbox_event_id IS NOT NULL;
CREATE INDEX provider_status_history_inbox_event_idx ON machvon.provider_status_history (tenant_id, inbox_event_id);

CREATE TABLE machvon.provider_reconciliation_task (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  detail text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  resolved_status text,
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT provider_reconciliation_task_reason_chk CHECK (reason IN ('RESULT_UNCERTAIN', 'STATUS_CONFLICT')),
  CONSTRAINT provider_reconciliation_task_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT provider_reconciliation_task_due_chk CHECK (due_at >= opened_at),
  CONSTRAINT provider_reconciliation_task_resolved_chk CHECK (
    (status = 'RESOLVED') = (resolved_status IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, item_id) REFERENCES machvon.provider_status_item (tenant_id, id)
);

-- One open task per item and reason: a second lost acknowledgement joins the open task instead of piling up.
CREATE UNIQUE INDEX provider_reconciliation_task_open_uq ON machvon.provider_reconciliation_task (tenant_id, item_id, reason) WHERE status = 'OPEN';
CREATE INDEX provider_reconciliation_task_item_idx ON machvon.provider_reconciliation_task (tenant_id, item_id);
CREATE INDEX provider_reconciliation_task_due_idx ON machvon.provider_reconciliation_task (tenant_id, due_at, id) WHERE status = 'OPEN';

ALTER TABLE machvon.provider_status_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.provider_status_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.provider_status_item AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.provider_status_item AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.provider_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.provider_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.provider_status_history AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.provider_status_history AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE machvon.provider_reconciliation_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.provider_reconciliation_task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.provider_reconciliation_task AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.provider_reconciliation_task AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The history is append-only and nothing here is ever deleted: what a provider told us, and when, is evidence.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.provider_status_history FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.provider_status_item FROM machvon_app;
REVOKE DELETE, TRUNCATE ON TABLE machvon.provider_reconciliation_task FROM machvon_app;

-- An item keeps its identity. Its version grows by exactly one with every change, and only its status, its last event and its times change.
CREATE FUNCTION machvon.provider_status_item_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a tracked provider item keeps its identity' USING ERRCODE = '23514';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'the version of a tracked provider item grows by one with every change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER provider_status_item_guard BEFORE UPDATE ON machvon.provider_status_item
  FOR EACH ROW EXECUTE FUNCTION machvon.provider_status_item_guard();

-- A task keeps its facts once it is resolved: a closed task is never reopened or rewritten.
CREATE FUNCTION machvon.provider_reconciliation_task_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'a reconciliation task keeps its item, reason and dates' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved reconciliation task is not changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER provider_reconciliation_task_guard BEFORE UPDATE ON machvon.provider_reconciliation_task
  FOR EACH ROW EXECUTE FUNCTION machvon.provider_reconciliation_task_guard();

-- The identity of a received event is fixed (it is what makes a redelivery recognisable), and a processed event is never processed again.
CREATE FUNCTION machvon.integration_event_inbox_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.event_key IS DISTINCT FROM OLD.event_key OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.signature_key_id IS DISTINCT FROM OLD.signature_key_id OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'an inbox event keeps its identity' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PROCESSED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a processed inbox event stays processed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER integration_event_inbox_guard BEFORE UPDATE ON machvon.integration_event_inbox
  FOR EACH ROW EXECUTE FUNCTION machvon.integration_event_inbox_guard();
