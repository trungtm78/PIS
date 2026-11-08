import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the executive analytics fragment (GOV-11b) in the ids of its fixtures. */
const GROUP = 11;
const FAMILY = { decision: 1, annotation: 2, complaint: 3, dossier: 4, step: 5 } as const;

/**
 * The rows the isolation suite seeds for the executive analytics of a tenant: a decision of the leader, a note on the ranking, a complaint about a figure, and a halt dossier with one step of its restart plan. Every one has
 * words that only the tenant has, so that a list or a read that leaked a row of the other tenant is seen.
 */
export interface AnalyticsFixtures {
  decision: { id: string; title: string; reason: string };
  annotation: { id: string; evidence: string };
  complaint: { id: string; claim: string };
  dossier: { id: string; reason: string; stepId: string; stepTitle: string };
}

function build(tenant: TenantName): AnalyticsFixtures {
  const label = tenant === 'TNT-A' ? 'Alpha' : 'Beta';
  return {
    decision: { id: fixtureId(tenant, GROUP, FAMILY.decision), title: `${label} decision subject of the weekly meeting`, reason: `${label} decision reason: wait for the figures of the second bank` },
    annotation: { id: fixtureId(tenant, GROUP, FAMILY.annotation), evidence: `${label} annotation evidence: the compensation of the households of the east bank is not paid` },
    complaint: { id: fixtureId(tenant, GROUP, FAMILY.complaint), claim: `${label} complaint claim: the Treasury paid more on the ninth than the ranking shows` },
    dossier: { id: fixtureId(tenant, GROUP, FAMILY.dossier), reason: `${label} halt reason: the quarry of the works lost its permit for the season`, stepId: fixtureId(tenant, GROUP, FAMILY.step), stepTitle: `${label} restart step: renew the permit of the quarry` },
  };
}

export const ANALYTICS_FIXTURES: Readonly<Record<TenantName, AnalyticsFixtures>> = {
  'TNT-A': build('TNT-A'),
  'TNT-B': build('TNT-B'),
};

/** Every id and every distinctive text of the analytics fixtures of a tenant: none of them may reach an answer given to the other tenant. */
export function analyticsMarkers(tenant: TenantName): Marker[] {
  const fixtures = ANALYTICS_FIXTURES[tenant];
  return [
    { kind: 'analytics decision id', value: fixtures.decision.id },
    { kind: 'analytics decision title', value: fixtures.decision.title },
    { kind: 'analytics decision reason', value: fixtures.decision.reason },
    { kind: 'analytics annotation id', value: fixtures.annotation.id },
    { kind: 'analytics annotation evidence', value: fixtures.annotation.evidence },
    { kind: 'analytics complaint id', value: fixtures.complaint.id },
    { kind: 'analytics complaint claim', value: fixtures.complaint.claim },
    { kind: 'analytics halt dossier id', value: fixtures.dossier.id },
    { kind: 'analytics halt reason', value: fixtures.dossier.reason },
    { kind: 'analytics restart step id', value: fixtures.dossier.stepId },
    { kind: 'analytics restart step title', value: fixtures.dossier.stepTitle },
  ];
}
