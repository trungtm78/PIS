import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the GOV-10 fragment (the red flags of procurement and the reports that an alert is wrong) in the ids of its fixtures. */
const GROUP = 0xd;

const FAMILY = {
  flagRead: 0x01,
  flagTake: 0x02,
  flagRefer: 0x03,
  flagPropose: 0x04,
  flagConfirm: 0x05,
  flagReject: 0x06,
  feedbackReview: 0x07,
  feedbackWithdraw: 0x08,
} as const;

const LABEL: Readonly<Record<TenantName, string>> = { 'TNT-A': 'Alpha', 'TNT-B': 'Beta' };
const UPPER: Readonly<Record<TenantName, string>> = { 'TNT-A': 'ALPHA', 'TNT-B': 'BETA' };

/** A finding of the red flags in the state its command starts from; each command has a finding of its own, so what the owner does in the control run never takes the object of another case away. */
export interface RedFlagFixture {
  id: string;
  /** The package the finding is about (one finding per subject). */
  subjectId: string;
  subjectCode: string;
  status: 'NEW' | 'IN_REVIEW' | 'CLEAR_PROPOSED';
}

/** A report that an alert is wrong. */
export interface AlertFeedbackFixture {
  id: string;
  sourceId: string;
  note: string;
}

export interface Gov10Fixture {
  flagRead: RedFlagFixture;
  flagTake: RedFlagFixture;
  flagRefer: RedFlagFixture;
  flagPropose: RedFlagFixture;
  flagConfirm: RedFlagFixture;
  flagReject: RedFlagFixture;
  feedbackReview: AlertFeedbackFixture;
  feedbackWithdraw: AlertFeedbackFixture;
}

function gov10Of(tenant: TenantName): Gov10Fixture {
  const upper = UPPER[tenant];
  const flag = (family: keyof typeof FAMILY, status: RedFlagFixture['status'], serial: number): RedFlagFixture => ({
    id: fixtureId(tenant, GROUP, FAMILY[family]),
    subjectId: fixtureId(tenant, GROUP, FAMILY[family], 2),
    subjectCode: `${upper}-RF-PACKAGE-${serial}`,
    status,
  });
  const feedback = (family: keyof typeof FAMILY, serial: number): AlertFeedbackFixture => ({
    id: fixtureId(tenant, GROUP, FAMILY[family]),
    sourceId: fixtureId(tenant, GROUP, FAMILY[family], 2),
    note: `${LABEL[tenant]} tenant says the alert about the package is wrong number ${serial}`,
  });
  return {
    flagRead: flag('flagRead', 'NEW', 1),
    flagTake: flag('flagTake', 'NEW', 2),
    flagRefer: flag('flagRefer', 'IN_REVIEW', 3),
    flagPropose: flag('flagPropose', 'IN_REVIEW', 4),
    flagConfirm: flag('flagConfirm', 'CLEAR_PROPOSED', 5),
    flagReject: flag('flagReject', 'CLEAR_PROPOSED', 6),
    feedbackReview: feedback('feedbackReview', 1),
    feedbackWithdraw: feedback('feedbackWithdraw', 2),
  };
}

export const GOV10_FIXTURES: Readonly<Record<TenantName, Gov10Fixture>> = { 'TNT-A': gov10Of('TNT-A'), 'TNT-B': gov10Of('TNT-B') };

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function gov10Markers(tenant: TenantName): Marker[] {
  const fixture = GOV10_FIXTURES[tenant];
  const flags = (['flagRead', 'flagTake', 'flagRefer', 'flagPropose', 'flagConfirm', 'flagReject'] as const).flatMap((name) => [
    { kind: `red flag ${name} id`, value: fixture[name].id },
    { kind: `red flag ${name} subject`, value: fixture[name].subjectId },
    { kind: `red flag ${name} subject code`, value: fixture[name].subjectCode },
  ]);
  const feedback = (['feedbackReview', 'feedbackWithdraw'] as const).flatMap((name) => [
    { kind: `alert feedback ${name} id`, value: fixture[name].id },
    { kind: `alert feedback ${name} note`, value: fixture[name].note },
  ]);
  return [...flags, ...feedback];
}
