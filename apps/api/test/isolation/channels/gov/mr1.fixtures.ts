import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the MR-1 fragment in the ids of its fixtures. */
const GROUP = 0xa;

/** The families of ids: the signal line, the alert, the two target sets, their indicators and the assessment. */
const FAMILY = { signal: 1, alert: 2, fixedSet: 3, draftSet: 4, indicator: 5, assessment: 6 } as const;

export interface Mr1Fixtures {
  signal: { id: string };
  alert: { id: string };
  /** The set that stands FIXED (the assessment rests on it) and the draft that replaces it. */
  fixedSet: { id: string; basis: string };
  draftSet: { id: string; basis: string; reason: string };
  indicators: { fixed: { id: string; code: string; name: string }; draft: { id: string; code: string; name: string } };
  assessment: { id: string; summary: string };
}

function build(tenant: TenantName): Mr1Fixtures {
  const label = tenant === 'TNT-A' ? 'Alpha' : 'Beta';
  const prefix = tenant === 'TNT-A' ? 'ALPHA' : 'BETA';
  return {
    signal: { id: fixtureId(tenant, GROUP, FAMILY.signal) },
    alert: { id: fixtureId(tenant, GROUP, FAMILY.alert) },
    fixedSet: { id: fixtureId(tenant, GROUP, FAMILY.fixedSet), basis: `${label} decision 11/QD-${prefix} approving the investment` },
    draftSet: { id: fixtureId(tenant, GROUP, FAMILY.draftSet), basis: `${label} decision 12/QD-${prefix} amending the investment`, reason: `${label} reason: the decision on the investment was amended` },
    indicators: {
      fixed: { id: fixtureId(tenant, GROUP, FAMILY.indicator, 1), code: `${prefix}_OUTPUT`, name: `${label} yearly output of the plant` },
      draft: { id: fixtureId(tenant, GROUP, FAMILY.indicator, 2), code: `${prefix}_LOSS`, name: `${label} loss rate of the grid` },
    },
    assessment: { id: fixtureId(tenant, GROUP, FAMILY.assessment), summary: `${label} assessment: the plant reached most of its output target` },
  };
}

export const MR1_FIXTURES: Readonly<Record<TenantName, Mr1Fixtures>> = {
  'TNT-A': build('TNT-A'),
  'TNT-B': build('TNT-B'),
};

/** Every id and every distinctive text of the MR-1 fixtures of a tenant: none of them may reach an answer given to the other tenant. */
export function mr1Markers(tenant: TenantName): Marker[] {
  const fixtures = MR1_FIXTURES[tenant];
  return [
    { kind: 'risk signal id', value: fixtures.signal.id },
    { kind: 'risk alert id', value: fixtures.alert.id },
    { kind: 'effect target set id', value: fixtures.fixedSet.id },
    { kind: 'effect target basis', value: fixtures.fixedSet.basis },
    { kind: 'effect target draft id', value: fixtures.draftSet.id },
    { kind: 'effect target draft basis', value: fixtures.draftSet.basis },
    { kind: 'effect target draft reason', value: fixtures.draftSet.reason },
    { kind: 'effect indicator id', value: fixtures.indicators.fixed.id },
    { kind: 'effect indicator code', value: fixtures.indicators.fixed.code },
    { kind: 'effect indicator name', value: fixtures.indicators.fixed.name },
    { kind: 'effect draft indicator id', value: fixtures.indicators.draft.id },
    { kind: 'effect draft indicator name', value: fixtures.indicators.draft.name },
    { kind: 'effect assessment id', value: fixtures.assessment.id },
    { kind: 'effect assessment summary', value: fixtures.assessment.summary },
  ];
}
