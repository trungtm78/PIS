import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { HUB_AGENT_FIXTURES } from './hub.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';

/**
 * The foreign-id case of the Integration Hub beyond the decisions on incidents, mappings and rejects (they are in the main list of the suite): the heartbeat of a collector agent. The agent belongs to the tenant that
 * registered it, so a TNT-A caller naming the code of an agent of TNT-B finds none. The codes of the connectors in the paths of the other operations are entries of the registry of the platform, the same for every tenant
 * (`endpoint-enumerator.ts`), so they have no foreign object to name.
 */
export const HUB_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'heartbeatHubAgent', method: 'POST', id: HUB_AGENT_FIXTURES[FOREIGN].code, body: { agent_version: '1.0.0', spool_depth: 0 } },
];

/** Every operation of the Integration Hub: the test role of the suite holds the permission of each. */
export const HUB_OPERATIONS: readonly string[] = [
  'listHubConnectors',
  'getHubConnector',
  'listHubConnectorRuns',
  'recordHubRun',
  'listHubRejects',
  'listHubIncidents',
  'openHubIncident',
  'getHubHealthSummary',
  'listHubAgents',
  'registerHubAgent',
  'setHubConnectorState',
  'decideHubIncident',
  'captureHubSnapshot',
  'proposeHubMapping',
  'decideHubMapping',
  'decideHubReject',
  'heartbeatHubAgent',
];

/** The tables the seed fills that the snapshot reads, and that no read of these operations changes. */
export const HUB_SNAPSHOT_TABLES: readonly string[] = ['hub_collector_agent'];

const INSERT_AGENT = `insert into machvon.hub_collector_agent (tenant_id, id, agent_code, os, cpu_arch, agent_version, connectors, spool_depth, registered_by)
  select $1::uuid, $2::uuid, $3::text, 'linux', 'amd64', '1.0.0', array['treasury.statement'], 0, $4::uuid
   where not exists (select 1 from machvon.hub_collector_agent where id = $2::uuid)`;

export async function seedHub(client: Client, context: SeedContext): Promise<void> {
  const agent = HUB_AGENT_FIXTURES[context.tenant];
  await client.query(INSERT_AGENT, [context.tenantId, agent.id, agent.code, context.membershipId]);
}
