import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the GOV-11a fragment in the ids of its fixtures. */
const GROUP = 8;

const FAMILY = {
  draftPlan: 0x01,
  livePlan: 0x02,
  raiseItem: 0x03,
  outcomeItem: 0x04,
  draftItem: 0x05,
  constraint: 0x06,
  lesson: 0x07,
  waiver: 0x08,
  adjustment: 0x09,
} as const;

const LABEL: Readonly<Record<TenantName, string>> = { 'TNT-A': 'Alpha', 'TNT-B': 'Beta' };

/** The rows of the look-ahead of a project (a draft plan, a published plan with the items each command starts from and one open constraint), a lesson that waits for a decision and a waiver that waits for a decision. */
export interface Gov11aFixture {
  draftPlan: { id: string; weekStart: string };
  livePlan: { id: string; weekStart: string };
  raiseItem: { id: string; description: string };
  outcomeItem: { id: string; description: string };
  draftItem: { id: string; description: string };
  constraint: { id: string; description: string };
  lesson: { id: string; title: string };
  waiver: { id: string; reason: string };
  adjustment: { id: string; note: string };
}

function gov11aOf(tenant: TenantName): Gov11aFixture {
  const label = LABEL[tenant];
  return {
    draftPlan: { id: fixtureId(tenant, GROUP, FAMILY.draftPlan), weekStart: '2026-02-02' },
    livePlan: { id: fixtureId(tenant, GROUP, FAMILY.livePlan), weekStart: '2026-02-09' },
    raiseItem: { id: fixtureId(tenant, GROUP, FAMILY.raiseItem), description: `${label} tenant item of the look-ahead that gets a constraint 0001` },
    outcomeItem: { id: fixtureId(tenant, GROUP, FAMILY.outcomeItem), description: `${label} tenant item of the look-ahead that gets its outcome 0001` },
    draftItem: { id: fixtureId(tenant, GROUP, FAMILY.draftItem), description: `${label} tenant item of the draft look-ahead plan 0001` },
    constraint: { id: fixtureId(tenant, GROUP, FAMILY.constraint), description: `${label} tenant constraint of the rebar delivery of the look-ahead 0001` },
    lesson: { id: fixtureId(tenant, GROUP, FAMILY.lesson), title: `${label} tenant lesson about the early clearing of the site access 0001` },
    waiver: { id: fixtureId(tenant, GROUP, FAMILY.waiver), reason: `${label} tenant waiver of the lessons because the work was a short repair 0001` },
    adjustment: { id: fixtureId(tenant, GROUP, FAMILY.adjustment), note: `${label} tenant adjustment version note 0001` },
  };
}

export const GOV11A_FIXTURES: Readonly<Record<TenantName, Gov11aFixture>> = {
  'TNT-A': gov11aOf('TNT-A'),
  'TNT-B': gov11aOf('TNT-B'),
};

/** What a tenant writes in these rows is internal to it: a value of TNT-B in an answer to TNT-A is a leak. */
export function gov11aMarkers(tenant: TenantName): Marker[] {
  const fixture = GOV11A_FIXTURES[tenant];
  return [
    { kind: 'look-ahead draft plan id', value: fixture.draftPlan.id },
    { kind: 'look-ahead published plan id', value: fixture.livePlan.id },
    { kind: 'look-ahead item id', value: fixture.raiseItem.id },
    { kind: 'look-ahead item description', value: fixture.raiseItem.description },
    { kind: 'look-ahead outcome item description', value: fixture.outcomeItem.description },
    { kind: 'look-ahead draft item description', value: fixture.draftItem.description },
    { kind: 'look-ahead constraint id', value: fixture.constraint.id },
    { kind: 'look-ahead constraint description', value: fixture.constraint.description },
    { kind: 'lesson learned id', value: fixture.lesson.id },
    { kind: 'lesson learned title', value: fixture.lesson.title },
    { kind: 'lesson waiver id', value: fixture.waiver.id },
    { kind: 'lesson waiver reason', value: fixture.waiver.reason },
    { kind: 'contract adjustment id', value: fixture.adjustment.id },
    { kind: 'contract adjustment note', value: fixture.adjustment.note },
  ];
}
