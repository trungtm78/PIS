-- Authored by hand (not generated): the Integration Hub (HUB-1), part 6: the registration of collector agents (a small program that runs next to a source, on any operating system and processor, ARM included, and hands data to the hub).
-- `hub_collector_agent`: the agent id (a code chosen at registration), the platform it runs on (operating system and processor architecture, for example linux/arm64 or windows/amd64), its version, the connectors it serves,
-- the depth of its local spool and the time of its last heartbeat. The health of an agent is judged from the heartbeat against the rule INTEGRATION_HUB_POLICY (`agent_stale_after_minutes`). The secret of an agent is never here.

CREATE TABLE machvon.hub_collector_agent (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  agent_code text NOT NULL,
  os text NOT NULL,
  cpu_arch text NOT NULL,
  agent_version text NOT NULL,
  connectors text[] NOT NULL DEFAULT '{}',
  spool_depth integer NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz,
  state text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  registered_by uuid NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT hub_collector_agent_code_chk CHECK (agent_code ~ '^[a-z0-9][a-z0-9_.-]{2,59}$'),
  CONSTRAINT hub_collector_agent_os_chk CHECK (os IN ('linux', 'windows', 'darwin', 'freebsd', 'other')),
  CONSTRAINT hub_collector_agent_arch_chk CHECK (cpu_arch IN ('amd64', 'arm64', 'arm', '386', 'riscv64', 'ppc64le', 's390x', 'other')),
  CONSTRAINT hub_collector_agent_version_text_chk CHECK (agent_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$'),
  CONSTRAINT hub_collector_agent_spool_chk CHECK (spool_depth >= 0),
  CONSTRAINT hub_collector_agent_state_chk CHECK (state IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT hub_collector_agent_row_version_chk CHECK (version >= 1),
  CONSTRAINT hub_collector_agent_uq UNIQUE (tenant_id, agent_code)
);
CREATE INDEX hub_collector_agent_list_idx ON machvon.hub_collector_agent (tenant_id, state, agent_code);
CREATE INDEX hub_collector_agent_registrar_idx ON machvon.hub_collector_agent (tenant_id, registered_by);

CREATE FUNCTION machvon.guard_hub_collector_agent() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.agent_code IS DISTINCT FROM OLD.agent_code OR NEW.registered_by IS DISTINCT FROM OLD.registered_by OR NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
    RAISE EXCEPTION 'an agent keeps its code and its origin' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'RETIRED' THEN
    RAISE EXCEPTION 'a retired agent does not change' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_heartbeat_at IS NOT NULL AND OLD.last_heartbeat_at IS NOT NULL AND NEW.last_heartbeat_at < OLD.last_heartbeat_at THEN
    RAISE EXCEPTION 'a heartbeat does not go back in time' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every change of an agent moves its version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER hub_collector_agent_guard BEFORE UPDATE ON machvon.hub_collector_agent FOR EACH ROW EXECUTE FUNCTION machvon.guard_hub_collector_agent();

ALTER TABLE machvon.hub_collector_agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.hub_collector_agent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.hub_collector_agent AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.hub_collector_agent AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE DELETE, TRUNCATE ON TABLE machvon.hub_collector_agent FROM machvon_app;

COMMENT ON TABLE machvon.hub_collector_agent IS 'HUB-1: a collector agent: platform (os and cpu architecture), version, connectors served, spool depth and last heartbeat.';
