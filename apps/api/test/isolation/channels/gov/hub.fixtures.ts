import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the collector agents of the Integration Hub (HUB-1) in the ids of its fixtures. */
const GROUP = 0xf;

const FAMILY = { agent: 0x01 } as const;

const LOWER: Readonly<Record<TenantName, string>> = { 'TNT-A': 'alpha', 'TNT-B': 'beta' };

/** A collector agent registered by the tenant: its code belongs to the tenant, so another tenant cannot send a heartbeat for it. */
export interface HubAgentFixture {
  id: string;
  code: string;
}

function agentOf(tenant: TenantName): HubAgentFixture {
  return { id: fixtureId(tenant, GROUP, FAMILY.agent), code: `${LOWER[tenant]}-isolation-agent-0001` };
}

export const HUB_AGENT_FIXTURES: Readonly<Record<TenantName, HubAgentFixture>> = { 'TNT-A': agentOf('TNT-A'), 'TNT-B': agentOf('TNT-B') };

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function hubAgentMarkers(tenant: TenantName): Marker[] {
  const agent = HUB_AGENT_FIXTURES[tenant];
  return [
    { kind: 'hub agent id', value: agent.id },
    { kind: 'hub agent code', value: agent.code },
  ];
}
