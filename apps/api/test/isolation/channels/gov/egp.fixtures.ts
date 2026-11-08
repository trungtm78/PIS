import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the e-GP fragment in the ids of its fixtures. */
const GROUP = 6;

/** The families of ids: the connection and its events, the import run with its rows, the mappings, the package the suggestion points at, the frozen contract fact and the change order. */
const FAMILY = {
  connection: 0x01,
  connectionCreated: 0x02,
  connectionEnabled: 0x03,
  run: 0x10,
  claim: 0x11,
  record: 0x12,
  quarantine: 0x13,
  decideMapping: 0x20,
  retireMapping: 0x21,
  package: 0x30,
  factSnapshot: 0x40,
  changeOrder: 0x50,
} as const;

const LABEL: Readonly<Record<TenantName, string>> = {
  'TNT-A': 'Alpha',
  'TNT-B': 'Beta',
};
const HEX_PREFIX: Readonly<Record<TenantName, string>> = {
  'TNT-A': 'a6',
  'TNT-B': 'b6',
};
const PRICE_BASE: Readonly<Record<TenantName, number>> = {
  'TNT-A': 7300001,
  'TNT-B': 7300002,
};

/** The e-GP connection of a tenant: it is switched on again with a reason, so that the row has a history of two events (the reason is distinctive). */
export interface EgpConnectionFixture {
  id: string;
  createdEventId: string;
  enabledEventId: string;
  stateReason: string;
}

/**
 * The import run of a file of the plans of the contractor selection (a run that was applied, with one row of the file taken and one row refused), the row the framework claimed, the typed record of the
 * taken row, and the refused row.
 */
export interface EgpRunFixture {
  id: string;
  fileSha256: string;
  /** The key the run keeps for its file: no handler of the suite reads the file (the lookup of a run does not), the key is a distinctive text. */
  fileObjectKey: string;
  claimId: string;
  recordId: string;
  recordBusinessKey: string;
  rowHash: string;
  packageExternalCode: string;
  packageName: string;
  planCode: string;
  estimatedPriceVnd: string;
  quarantineId: string;
  quarantineBusinessKey: string;
  quarantinePreview: string;
}

/** A mapping of a code of the network to a row of ours: the one that waits for its decision and the one in force that is retired. */
export interface EgpMappingFixture {
  id: string;
  externalCode: string;
  reason: string;
}

/** The package of ours the imported package is suggested to be: the price is the same to the unit and the name is the same. */
export interface EgpPackageFixture {
  id: string;
  code: string;
  title: string;
  budgetVnd: string;
}

/** The contract fact frozen with the snapshot of the period (the hash of its content is distinctive). */
export interface EgpFactSnapshotFixture {
  id: string;
  payloadSha256: string;
}

/** A change order that was assessed and waits for the check of the project adjustment (its cost is more than a tenth of the price of the contract, so the check is called for). */
export interface EgpChangeOrderFixture {
  id: string;
  code: string;
  reason: string;
  fundingNote: string;
  deltaVnd: string;
}

export interface EgpFixture {
  connection: EgpConnectionFixture;
  run: EgpRunFixture;
  decideMapping: EgpMappingFixture;
  retireMapping: EgpMappingFixture;
  package: EgpPackageFixture;
  factSnapshot: EgpFactSnapshotFixture;
  changeOrder: EgpChangeOrderFixture;
}

function egpOf(tenant: TenantName): EgpFixture {
  const label = LABEL[tenant];
  const upper = label.toUpperCase();
  const hex = HEX_PREFIX[tenant];
  const price = String(PRICE_BASE[tenant]);
  const packageName = `${label} tenant package of the road to the river port that the national network lists 0001`;
  return {
    connection: {
      id: fixtureId(tenant, GROUP, FAMILY.connection),
      createdEventId: fixtureId(tenant, GROUP, FAMILY.connectionCreated),
      enabledEventId: fixtureId(tenant, GROUP, FAMILY.connectionEnabled),
      stateReason: `${label} tenant switched the connection on again after the check of the first file 0001`,
    },
    run: {
      id: fixtureId(tenant, GROUP, FAMILY.run),
      fileSha256: `${hex}e1`.repeat(16),
      fileObjectKey: `isolation/egp/${label.toLowerCase()}-tenant-khlcnt-file-0001.xlsx`,
      claimId: fixtureId(tenant, GROUP, FAMILY.claim),
      recordId: fixtureId(tenant, GROUP, FAMILY.record),
      recordBusinessKey: `${upper}-EGP-KHLCNT-0001`,
      rowHash: `${hex}e2`.repeat(16),
      packageExternalCode: `${upper}-EGP-PKG-0001`,
      packageName,
      planCode: `${upper}-EGP-PLAN-0001`,
      estimatedPriceVnd: price,
      quarantineId: fixtureId(tenant, GROUP, FAMILY.quarantine),
      quarantineBusinessKey: `${upper}-EGP-KHLCNT-0002`,
      quarantinePreview: `${label} tenant refused line of the plans with a price that is not a number 0001`,
    },
    decideMapping: {
      id: fixtureId(tenant, GROUP, FAMILY.decideMapping),
      externalCode: `${upper}-EGP-PRJ-0001`,
      reason: `${label} tenant proposes the code of the network for the project of the bridge 0001`,
    },
    retireMapping: {
      id: fixtureId(tenant, GROUP, FAMILY.retireMapping),
      externalCode: `${upper}-EGP-CTR-0001`,
      reason: `${label} tenant approved the code of the network for the contract of the bridge 0001`,
    },
    package: {
      id: fixtureId(tenant, GROUP, FAMILY.package),
      code: `${upper}-EGP-PKG-0001-OURS`,
      title: packageName,
      budgetVnd: price,
    },
    factSnapshot: {
      id: fixtureId(tenant, GROUP, FAMILY.factSnapshot),
      payloadSha256: `${hex}e5`.repeat(16),
    },
    changeOrder: {
      id: fixtureId(tenant, GROUP, FAMILY.changeOrder),
      code: `${upper}-EGP-CO-0001`,
      reason: `${label} tenant change order that raises the cost of the contract beyond a tenth 0001`,
      fundingNote: `${label} tenant funding note of the assessment that calls for the adjustment check 0001`,
      deltaVnd: '500',
    },
  };
}

/** The e-GP connection with its import run and mappings, the frozen contract fact and the change order that call for a check, one set for each tenant. */
export const EGP_FIXTURES: Readonly<Record<TenantName, EgpFixture>> = {
  'TNT-A': egpOf('TNT-A'),
  'TNT-B': egpOf('TNT-B'),
};

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function egpMarkers(tenant: TenantName): Marker[] {
  const fixture = EGP_FIXTURES[tenant];
  const { connection, run, decideMapping, retireMapping, changeOrder } = fixture;
  return [
    { kind: 'egp connection id', value: connection.id },
    { kind: 'egp connection created event id', value: connection.createdEventId },
    { kind: 'egp connection enabled event id', value: connection.enabledEventId },
    { kind: 'egp connection state reason', value: connection.stateReason },
    { kind: 'egp import run id', value: run.id },
    { kind: 'egp import file hash', value: run.fileSha256 },
    { kind: 'egp import file object key', value: run.fileObjectKey },
    { kind: 'egp import claimed row id', value: run.claimId },
    { kind: 'egp record id', value: run.recordId },
    { kind: 'egp record business key', value: run.recordBusinessKey },
    { kind: 'egp record row hash', value: run.rowHash },
    { kind: 'egp package external code', value: run.packageExternalCode },
    { kind: 'egp package name', value: run.packageName },
    { kind: 'egp plan code', value: run.planCode },
    { kind: 'egp refused row id', value: run.quarantineId },
    { kind: 'egp refused row business key', value: run.quarantineBusinessKey },
    { kind: 'egp refused row preview', value: run.quarantinePreview },
    { kind: 'egp decide mapping id', value: decideMapping.id },
    { kind: 'egp decide mapping external code', value: decideMapping.externalCode },
    { kind: 'egp decide mapping proposal reason', value: decideMapping.reason },
    { kind: 'egp retire mapping id', value: retireMapping.id },
    { kind: 'egp retire mapping external code', value: retireMapping.externalCode },
    { kind: 'egp retire mapping decision reason', value: retireMapping.reason },
    { kind: 'egp suggested package id', value: fixture.package.id },
    { kind: 'egp suggested package code', value: fixture.package.code },
    { kind: 'contract fact snapshot id', value: fixture.factSnapshot.id },
    { kind: 'contract fact snapshot hash', value: fixture.factSnapshot.payloadSha256 },
    { kind: 'assessed change order id', value: changeOrder.id },
    { kind: 'assessed change order code', value: changeOrder.code },
    { kind: 'assessed change order reason', value: changeOrder.reason },
    { kind: 'assessed change order funding note', value: changeOrder.fundingNote },
  ];
}
