import { assertStatus, codeOf, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';
import { UatWorld } from '../uat/uat-world';

/**
 * The life of a collector agent of the Integration Hub as docs/uat/hub/uat.json asks it (case UAT-HUB-AGT-01): it registers with its platform, is judged by its heartbeat (online, then stale once the heartbeat is older
 * than the rule says), and a repeat code is refused. The case says an unknown connector is a 404; the contract of `registerHubAgent` (openapi.json: VALIDATION_FAILED and HUB_AGENT_CODE_TAKEN, no RESOURCE_NOT_FOUND) and
 * the product answer 422 for a connector code in the body, so the case id is not named here (finding in the report of the lane): this suite proves what the contract says and the part of the case that agrees with it.
 */
jest.setTimeout(240_000);

const PERSONAS = {
  'hub-admin': ['hub.read', 'hub.agent.manage', 'hub.agent.heartbeat'],
  'hub-reader': ['hub.read'],
};

describe('the collector agents of the Integration Hub (HUB-03)', () => {
  const world = new UatWorld();

  beforeAll(async () => {
    await world.start(PERSONAS, { 'hub-admin': PERSONAS['hub-admin'] });
  }, 300_000);

  afterAll(() => world.stop(), 60_000);

  const agents = async (): Promise<Array<Record<string, unknown>>> => (await world.as('hub-reader', 'GET', '/integration-hub/agents')).json.items as Array<Record<string, unknown>>;
  const beat = (code: string): Promise<Reply> => world.as('hub-admin', 'POST', `/integration-hub/agents/${code}/heartbeat`, { body: { agent_version: '1.4.3', spool_depth: 7 } });

  it('registers an agent, refuses its code a second time (409) and an unknown connector (422 VALIDATION_FAILED), and judges it by its heartbeat: never seen, online, stale after the rule of the hub, online again', async () => {
    const body = { agent_code: 'collector-uat-01', os: 'linux', cpu_arch: 'arm64', agent_version: '1.4.2', connectors: ['egp.muasamcong', 'treasury.statement'] };
    const registered = await world.as('hub-admin', 'POST', '/integration-hub/agents', { body });
    assertStatus(registered, 200);
    assertStatus(await world.as('hub-admin', 'POST', '/integration-hub/agents', { body }), 409, 'HUB_AGENT_CODE_TAKEN');
    const unknown = await world.as('hub-admin', 'POST', '/integration-hub/agents', { body: { ...body, agent_code: 'collector-uat-02', connectors: ['no.such.connector'] } });
    assertStatus(unknown, 422, 'VALIDATION_FAILED');
    expect(unknown.json).toMatchObject({ detail: 'connectors' });
    expect((await agents()).map((agent) => agent.agent_code)).toEqual(['collector-uat-01']);

    expect((await agents())[0]).toMatchObject({ health: 'NEVER_SEEN', platform: 'linux/arm64' });
    assertStatus(await beat('collector-uat-01'), 200);
    expect((await agents())[0]).toMatchObject({ health: 'ONLINE', agent_version: '1.4.3', spool_depth: 7 });
    // The rule gives 15 minutes by default: a heartbeat of twenty minutes ago is stale, one of ten minutes ago is not.
    const minutesAgo = async (minutes: number): Promise<void> => world.seedAsAdmin([[`update machvon.hub_collector_agent set last_heartbeat_at = now() - ($1::int * interval '1 minute') where agent_code = 'collector-uat-01'`, [minutes]]]);
    await minutesAgo(10);
    expect((await agents())[0]).toMatchObject({ health: 'ONLINE' });
    await minutesAgo(20);
    expect((await agents())[0]).toMatchObject({ health: 'STALE' });
    assertStatus(await beat('collector-uat-01'), 200);
    expect((await agents())[0]).toMatchObject({ health: 'ONLINE' });
    const missing = await beat('collector-nobody');
    expect([missing.status, codeOf(missing)]).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'HUB_AGENT_CODE_TAKEN'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'OTHER' } }, 409, 'HUB_AGENT_CODE_TAKEN'));
  });
});
