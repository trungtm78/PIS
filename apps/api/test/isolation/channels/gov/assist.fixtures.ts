import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the AI assistant fragment in the ids of its fixtures. */
const GROUP = 8;

/** The families of ids: the run, the checklist, the set of criteria and the exception. */
const FAMILY = { run: 1, checklist: 2, criteria: 3, exception: 4 } as const;

const LABEL: Readonly<Record<TenantName, string>> = { 'TNT-A': 'Alpha', 'TNT-B': 'Beta' };

export interface AssistFixture {
  runId: string;
  runQuestion: string;
  checklistId: string;
  checklistTitle: string;
  criteriaSetId: string;
  criteriaTitle: string;
  exceptionId: string;
  exceptionReason: string;
}

function build(tenant: TenantName): AssistFixture {
  const label = LABEL[tenant];
  return {
    runId: fixtureId(tenant, GROUP, FAMILY.run),
    runQuestion: `${label} tenant question of the assistant about the bridge of the river port 0001`,
    checklistId: fixtureId(tenant, GROUP, FAMILY.checklist),
    checklistTitle: `${label} tenant checklist of the weekly report before it is sent up 0001`,
    criteriaSetId: fixtureId(tenant, GROUP, FAMILY.criteria),
    criteriaTitle: `${label} tenant criteria of the performance of a contract 0001`,
    exceptionId: fixtureId(tenant, GROUP, FAMILY.exception),
    exceptionReason: `${label} tenant exception reason for a provider outside the servers 0001`,
  };
}

export const ASSIST_FIXTURES: Readonly<Record<TenantName, AssistFixture>> = { 'TNT-A': build('TNT-A'), 'TNT-B': build('TNT-B') };

/** The values of the assistant rows of a tenant: one of TNT-B in an answer to TNT-A is a leak. */
export function assistMarkers(tenant: TenantName): Marker[] {
  const fixture = ASSIST_FIXTURES[tenant];
  return [
    { kind: 'ai assist run id', value: fixture.runId },
    { kind: 'ai assist run question', value: fixture.runQuestion },
    { kind: 'ai review checklist id', value: fixture.checklistId },
    { kind: 'ai review checklist title', value: fixture.checklistTitle },
    { kind: 'ai criteria set id', value: fixture.criteriaSetId },
    { kind: 'ai criteria set title', value: fixture.criteriaTitle },
    { kind: 'ai external exception id', value: fixture.exceptionId },
    { kind: 'ai external exception reason', value: fixture.exceptionReason },
  ];
}
