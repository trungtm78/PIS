import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the ids of the GOV-12 fixtures (the family numbers start at 0x11: the rating lane holds 0x01 to 0x05 of the same group; community monitoring, transmittals, portal, anonymous channel, gifts, photo findings). */
const GROUP = 0xc;

const FAMILY = {
  file: 0x11,
  feedback: 0x12,
  packItem: 0x13,
  container: 0x14,
  transmittal: 0x15,
  transmittalItem: 0x16,
  recipient: 0x17,
  portalSetting: 0x18,
  portalRecord: 0x19,
  whistle: 0x1a,
  gift: 0x1b,
  photoFirst: 0x1c,
  photoSecond: 0x1d,
  finding: 0x1e,
  lock: 0x1f,
  session: 0x20,
} as const;

const LABEL: Readonly<Record<TenantName, string>> = { 'TNT-A': 'Alpha', 'TNT-B': 'Beta' };
const BASE: Readonly<Record<TenantName, number>> = { 'TNT-A': 7100, 'TNT-B': 7200 };

export interface Gov12Fixture {
  fileId: string;
  feedbackId: string;
  feedbackReference: string;
  feedbackSummary: string;
  packItemId: string;
  packItemTitle: string;
  containerId: string;
  containerTitle: string;
  transmittalId: string;
  transmittalNumber: string;
  transmittalSubject: string;
  transmittalItemId: string;
  recipientRowId: string;
  portalSettingId: string;
  portalSlug: string;
  portalTitle: string;
  portalRecordId: string;
  portalRecordTitle: string;
  whistleId: string;
  whistleBody: string;
  whistleCodeHash: string;
  giftId: string;
  giftGiver: string;
  photoFirstId: string;
  photoSecondId: string;
  photoSha256: string;
  findingId: string;
  /** Ids of rows that are not seeded (the lock and the session need an issued copy): the cases for them prove that a foreign id is refused, the control proves nothing for them. */
  lockId: string;
  sessionId: string;
  issueId: string;
}

function fixtureOf(tenant: TenantName): Gov12Fixture {
  const label = LABEL[tenant];
  const base = BASE[tenant];
  return {
    fileId: fixtureId(tenant, GROUP, FAMILY.file),
    feedbackId: fixtureId(tenant, GROUP, FAMILY.feedback),
    feedbackReference: `PH-${base}`,
    feedbackSummary: `${label} community words about spoil that blocks the access road of the hamlet`,
    packItemId: fixtureId(tenant, GROUP, FAMILY.packItem),
    packItemTitle: `${label} notice text of the community monitoring pack`,
    containerId: fixtureId(tenant, GROUP, FAMILY.container),
    containerTitle: `${label} design report held in the document container`,
    transmittalId: fixtureId(tenant, GROUP, FAMILY.transmittal),
    transmittalNumber: `TR-${base}`,
    transmittalSubject: `${label} transmittal of the design report for information`,
    transmittalItemId: fixtureId(tenant, GROUP, FAMILY.transmittalItem),
    recipientRowId: fixtureId(tenant, GROUP, FAMILY.recipient),
    portalSettingId: fixtureId(tenant, GROUP, FAMILY.portalSetting),
    portalSlug: `iso-${label.toLowerCase()}`,
    portalTitle: `${label} public investment portal`,
    portalRecordId: fixtureId(tenant, GROUP, FAMILY.portalRecord),
    portalRecordTitle: `${label} published project of the isolation suite`,
    whistleId: fixtureId(tenant, GROUP, FAMILY.whistle),
    whistleBody: `${label} anonymous report about a package that was split below the threshold of open bidding`,
    whistleCodeHash: (tenant === 'TNT-A' ? 'a' : 'b').repeat(64),
    giftId: fixtureId(tenant, GROUP, FAMILY.gift),
    giftGiver: `${label} Construction Joint Stock Company`,
    photoFirstId: fixtureId(tenant, GROUP, FAMILY.photoFirst),
    photoSecondId: fixtureId(tenant, GROUP, FAMILY.photoSecond),
    photoSha256: (tenant === 'TNT-A' ? '1' : '2').repeat(64),
    findingId: fixtureId(tenant, GROUP, FAMILY.finding),
    lockId: fixtureId(tenant, GROUP, FAMILY.lock),
    sessionId: fixtureId(tenant, GROUP, FAMILY.session),
    issueId: fixtureId(tenant, GROUP, FAMILY.lock, 2),
  };
}

export const GOV12_FIXTURES: Readonly<Record<TenantName, Gov12Fixture>> = { 'TNT-A': fixtureOf('TNT-A'), 'TNT-B': fixtureOf('TNT-B') };

/** The values of the rows of one tenant that must never reach the other tenant. */
export function gov12Markers(tenant: TenantName): Marker[] {
  const fixture = GOV12_FIXTURES[tenant];
  return [
    { kind: 'gov12 monitoring file id', value: fixture.fileId },
    { kind: 'gov12 monitoring feedback id', value: fixture.feedbackId },
    { kind: 'gov12 monitoring feedback words', value: fixture.feedbackSummary },
    { kind: 'gov12 monitoring pack item title', value: fixture.packItemTitle },
    { kind: 'gov12 document container id', value: fixture.containerId },
    { kind: 'gov12 document container title', value: fixture.containerTitle },
    { kind: 'gov12 transmittal id', value: fixture.transmittalId },
    { kind: 'gov12 transmittal number', value: fixture.transmittalNumber },
    { kind: 'gov12 transmittal subject', value: fixture.transmittalSubject },
    { kind: 'gov12 portal record title', value: fixture.portalRecordTitle },
    { kind: 'gov12 portal title', value: fixture.portalTitle },
    { kind: 'gov12 whistle report id', value: fixture.whistleId },
    { kind: 'gov12 whistle report words', value: fixture.whistleBody },
    { kind: 'gov12 gift id', value: fixture.giftId },
    { kind: 'gov12 gift giver', value: fixture.giftGiver },
    { kind: 'gov12 photo finding id', value: fixture.findingId },
  ];
}
