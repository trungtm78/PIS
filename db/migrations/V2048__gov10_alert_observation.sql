-- Authored by hand (not generated): what the alert centre has seen, and when it stopped seeing it (governance deepening, lane GOV-10, roadmap G2-8). The items of the alert centre are read live from the tables of their modules, so
-- the centre has no memory of its own: an item that stops being produced simply vanishes. This table is that memory. A pass over the lists of the people of the tenant records every item it sees (`OPEN`), closes an item that
-- was seen before and is not produced any more (`RESOLVED_BY_SYSTEM`) only when the source of the item answered in that pass (a source that failed never closes anything), and opens it again when its condition returns
-- (`reopen_count` + 1). `decisions_before_close` is how many decisions of people the item had when the system closed it: 0 is the item that "closed with no record" of the report of G2-9/G2-8.
-- Closing and reopening are rows of `alert_observation_event` (append-only), so the times of closing, the reopen rate and the time an item stayed open are measured from facts, never from a counter.

CREATE TABLE machvon.alert_observation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  source_id text NOT NULL CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  alert_type_code text CHECK (alert_type_code IS NULL OR alert_type_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  cause_key text CHECK (cause_key IS NULL OR (cause_key = btrim(cause_key) AND char_length(cause_key) BETWEEN 1 AND 200)),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED_BY_SYSTEM')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  closed_at timestamptz,
  last_reopened_at timestamptz,
  reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  decisions_before_close integer CHECK (decisions_before_close IS NULL OR decisions_before_close >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT alert_observation_item_uq UNIQUE (tenant_id, source, source_id),
  CONSTRAINT alert_observation_state_chk CHECK ((state = 'OPEN' AND closed_at IS NULL AND decisions_before_close IS NULL) OR (state = 'RESOLVED_BY_SYSTEM' AND closed_at IS NOT NULL AND decisions_before_close IS NOT NULL)),
  CONSTRAINT alert_observation_seen_chk CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX alert_observation_state_idx ON machvon.alert_observation (tenant_id, state, last_seen_at DESC, id);
CREATE INDEX alert_observation_type_idx ON machvon.alert_observation (tenant_id, alert_type_code, state);
CREATE INDEX alert_observation_first_seen_idx ON machvon.alert_observation (tenant_id, first_seen_at DESC);
CREATE INDEX alert_observation_source_id_idx ON machvon.alert_observation (tenant_id, source_id);

ALTER TABLE machvon.alert_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_observation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_observation AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_observation AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- What an item was (its source, its id, when it was first seen) never changes; only the state, the times and the counters do.
REVOKE DELETE, TRUNCATE ON TABLE machvon.alert_observation FROM machvon_app;
REVOKE UPDATE ON TABLE machvon.alert_observation FROM machvon_app;
GRANT UPDATE (kind, alert_type_code, severity, cause_key, state, last_seen_at, closed_at, last_reopened_at, reopen_count, decisions_before_close, version) ON TABLE machvon.alert_observation TO machvon_app;

COMMENT ON TABLE machvon.alert_observation IS 'What the alert centre has seen: one row per item (source, id); closed by the system when its source condition cleared, reopened when it returned; never deleted.';

CREATE TABLE machvon.alert_observation_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('OPENED', 'CLOSED', 'REOPENED')),
  occurred_at timestamptz NOT NULL,
  -- The pass that made the row: a pass that runs twice records each change once.
  pass_key text NOT NULL CHECK (pass_key = btrim(pass_key) AND char_length(pass_key) BETWEEN 1 AND 120),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, observation_id) REFERENCES machvon.alert_observation (tenant_id, id),
  CONSTRAINT alert_observation_event_pass_uq UNIQUE (tenant_id, observation_id, pass_key, event_type)
);

CREATE INDEX alert_observation_event_item_idx ON machvon.alert_observation_event (tenant_id, observation_id, occurred_at DESC);
CREATE INDEX alert_observation_event_time_idx ON machvon.alert_observation_event (tenant_id, event_type, occurred_at DESC);

ALTER TABLE machvon.alert_observation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.alert_observation_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.alert_observation_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.alert_observation_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.alert_observation_event FROM machvon_app;

COMMENT ON TABLE machvon.alert_observation_event IS 'Opening, closing and reopening of an observed alert item; append-only.';
