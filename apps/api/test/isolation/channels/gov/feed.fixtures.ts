import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the finance feed fragment in the ids of its fixtures. */
const GROUP = 0xe;

const FAMILY = {
  connection: 0x01,
  connectionEvent: 0x02,
  run: 0x10,
  record: 0x11,
  decideMapping: 0x20,
  retireMapping: 0x21,
  difference: 0x30,
} as const;

const LABEL: Readonly<Record<TenantName, string>> = { 'TNT-A': 'Alpha', 'TNT-B': 'Beta' };

export interface FeedFixture {
  connection: { id: string; eventId: string; stateReason: string };
  run: { id: string; recordId: string; digest: string; feedProjectCode: string; projectName: string };
  decideMapping: { id: string; externalCode: string; reason: string };
  retireMapping: { id: string; externalCode: string; reason: string };
  difference: { id: string; feedProjectCode: string };
}

function feedOf(tenant: TenantName): FeedFixture {
  const label = LABEL[tenant];
  const upper = label.toUpperCase();
  const hex = tenant === 'TNT-A' ? 'ae' : 'be';
  return {
    connection: { id: fixtureId(tenant, GROUP, FAMILY.connection), eventId: fixtureId(tenant, GROUP, FAMILY.connectionEvent), stateReason: `${label} tenant switched the finance feed on again after the first batch 0001` },
    run: {
      id: fixtureId(tenant, GROUP, FAMILY.run),
      recordId: fixtureId(tenant, GROUP, FAMILY.record),
      digest: `${hex}f1`.repeat(16),
      feedProjectCode: `${upper}-FEED-PRJ-0001`,
      projectName: `${label} tenant road to the river port that the Finance Department lists 0001`,
    },
    decideMapping: { id: fixtureId(tenant, GROUP, FAMILY.decideMapping), externalCode: `${upper}-FEED-MAP-0001`, reason: `${label} tenant proposes the code of the Finance Department for the project of the bridge 0001` },
    retireMapping: { id: fixtureId(tenant, GROUP, FAMILY.retireMapping), externalCode: `${upper}-FEED-MAP-0002`, reason: `${label} tenant approved the code of the Finance Department for the project of the bridge 0002` },
    difference: { id: fixtureId(tenant, GROUP, FAMILY.difference), feedProjectCode: `${upper}-FEED-DIFF-0001` },
  };
}

export const FEED_FIXTURES: Readonly<Record<TenantName, FeedFixture>> = { 'TNT-A': feedOf('TNT-A'), 'TNT-B': feedOf('TNT-B') };

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function feedMarkers(tenant: TenantName): Marker[] {
  const fixture = FEED_FIXTURES[tenant];
  return [
    { kind: 'feed connection id', value: fixture.connection.id },
    { kind: 'feed connection event id', value: fixture.connection.eventId },
    { kind: 'feed connection state reason', value: fixture.connection.stateReason },
    { kind: 'feed run id', value: fixture.run.id },
    { kind: 'feed record id', value: fixture.run.recordId },
    { kind: 'feed run digest', value: fixture.run.digest },
    { kind: 'feed project code', value: fixture.run.feedProjectCode },
    { kind: 'feed project name', value: fixture.run.projectName },
    { kind: 'feed decide mapping id', value: fixture.decideMapping.id },
    { kind: 'feed decide mapping external code', value: fixture.decideMapping.externalCode },
    { kind: 'feed decide mapping proposal reason', value: fixture.decideMapping.reason },
    { kind: 'feed retire mapping id', value: fixture.retireMapping.id },
    { kind: 'feed retire mapping external code', value: fixture.retireMapping.externalCode },
    { kind: 'feed retire mapping decision reason', value: fixture.retireMapping.reason },
    { kind: 'feed difference id', value: fixture.difference.id },
    { kind: 'feed difference project code', value: fixture.difference.feedProjectCode },
  ];
}
