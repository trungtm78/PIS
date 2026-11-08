import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the ids of the payment control fixtures. */
const GROUP = 4;

/** The kinds of disbursement exception the fixtures hold: each one is the object of one command, so that every command finds the state it starts from. */
export const EXCEPTION_KINDS = ['approve', 'reject', 'revoke'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** The items of difference of the daily reconciliation the fixtures hold: one that is only read, one that is given an owner and one that is resolved. */
export const RECON_ITEM_KINDS = ['read', 'assign', 'resolve'] as const;
export type ReconItemKind = (typeof RECON_ITEM_KINDS)[number];

export interface ExceptionFixture {
  id: string;
  /** The words of the person who asked for the exception (distinctive). */
  reason: string;
}

export interface ReconItemFixture {
  id: string;
  /** The line of the pass that opened the item. */
  lineId: string;
  /** The fund of the line and of the item (the key and the label are distinctive). */
  fundKey: string;
  fundLabel: string;
}

export interface PayctlFixture {
  /** A draft request for an advance that the seed adds, so that a second exception can be live on a request (one live exception for a request and a ceiling). */
  draftRequestId: string;
  draftRequestNo: string;
  /** One check of the payment request of the fixtures that found a ceiling, and the finding it made (the words of the finding are distinctive). */
  integrityRunId: string;
  findingId: string;
  findingNote: string;
  exceptions: Readonly<Record<ExceptionKind, ExceptionFixture>>;
  /** The pass of the daily reconciliation that opened the items. */
  reconRunId: string;
  reconItems: Readonly<Record<ReconItemKind, ReconItemFixture>>;
  /** The cap of the advance the tenant published: the record, its version, the category it is for and the words of its legal basis. */
  capRecordId: string;
  capVersionId: string;
  capCategory: string;
  capBasis: string;
}

const LABEL: Readonly<Record<TenantName, string>> = {
  'TNT-A': 'Alpha',
  'TNT-B': 'Beta',
};

const EXCEPTION_REASON: Readonly<Record<ExceptionKind, string>> = {
  approve: 'that waits for its approval',
  reject: 'that waits for its refusal',
  revoke: 'that was approved and is taken back',
};

function reconItemOf(tenant: TenantName, kind: ReconItemKind): ReconItemFixture {
  const index = RECON_ITEM_KINDS.indexOf(kind) + 1;
  const label = LABEL[tenant];
  return {
    id: fixtureId(tenant, GROUP, 0x20 + index),
    lineId: fixtureId(tenant, GROUP, 0x10 + index),
    fundKey: `${label.toUpperCase()}-TREASURY-FUND-${kind.toUpperCase()}-0001`,
    fundLabel: `${label} tenant treasury fund of the item that is ${kind === 'read' ? 'read' : kind === 'assign' ? 'given an owner' : 'resolved'} 0001`,
  };
}

function payctlOf(tenant: TenantName): PayctlFixture {
  const label = LABEL[tenant];
  const exceptionOf = (kind: ExceptionKind): ExceptionFixture => ({
    id: fixtureId(tenant, GROUP, 0x04 + EXCEPTION_KINDS.indexOf(kind)),
    reason: `${label} tenant exception to a ceiling of disbursement ${EXCEPTION_REASON[kind]} 0001`,
  });
  return {
    draftRequestId: fixtureId(tenant, GROUP, 0x01),
    draftRequestNo: `${label.toUpperCase()}-PAYCTL-REQUEST-0001`,
    integrityRunId: fixtureId(tenant, GROUP, 0x02),
    findingId: fixtureId(tenant, GROUP, 0x03),
    findingNote: `${label} tenant finding of the check that the claim stands above the ceiling 0001`,
    exceptions: {
      approve: exceptionOf('approve'),
      reject: exceptionOf('reject'),
      revoke: exceptionOf('revoke'),
    },
    reconRunId: fixtureId(tenant, GROUP, 0x07),
    reconItems: {
      read: reconItemOf(tenant, 'read'),
      assign: reconItemOf(tenant, 'assign'),
      resolve: reconItemOf(tenant, 'resolve'),
    },
    capRecordId: fixtureId(tenant, GROUP, 0x0e),
    capVersionId: fixtureId(tenant, GROUP, 0x0f),
    capCategory: `${label.toUpperCase()}-ISOLATION-CAP-0001`,
    capBasis: `${label} tenant decision on the cap of the advance for the bridge 0001`,
  };
}

/** The payment control of each tenant: a check with a finding, three exceptions to a ceiling of disbursement (one for each command that decides one), a pass of the daily reconciliation with three items, and the cap of an advance. */
export const PAYCTL_FIXTURES: Readonly<Record<TenantName, PayctlFixture>> = {
  'TNT-A': payctlOf('TNT-A'),
  'TNT-B': payctlOf('TNT-B'),
};

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function payctlMarkers(tenant: TenantName): Marker[] {
  const fixture = PAYCTL_FIXTURES[tenant];
  const markers: Marker[] = [
    { kind: 'payctl draft request id', value: fixture.draftRequestId },
    { kind: 'payctl draft request number', value: fixture.draftRequestNo },
    { kind: 'payctl integrity run id', value: fixture.integrityRunId },
    { kind: 'payctl integrity finding id', value: fixture.findingId },
    { kind: 'payctl integrity finding note', value: fixture.findingNote },
    { kind: 'payctl recon run id', value: fixture.reconRunId },
    { kind: 'payctl advance cap record id', value: fixture.capRecordId },
    { kind: 'payctl advance cap version id', value: fixture.capVersionId },
    { kind: 'payctl advance cap category', value: fixture.capCategory },
    { kind: 'payctl advance cap legal basis', value: fixture.capBasis },
  ];
  for (const kind of EXCEPTION_KINDS) {
    const exception = fixture.exceptions[kind];
    markers.push({ kind: `payctl exception ${kind} id`, value: exception.id }, { kind: `payctl exception ${kind} reason`, value: exception.reason });
  }
  for (const kind of RECON_ITEM_KINDS) {
    const item = fixture.reconItems[kind];
    markers.push(
      { kind: `payctl recon item ${kind} id`, value: item.id },
      { kind: `payctl recon line ${kind} id`, value: item.lineId },
      { kind: `payctl recon fund ${kind} key`, value: item.fundKey },
      { kind: `payctl recon fund ${kind} label`, value: item.fundLabel },
    );
  }
  return markers;
}
