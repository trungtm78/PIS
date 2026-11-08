import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the ids of the reserve and investment appraisal fixtures. */
const GROUP = 1;

/** One investment appraisal of a tenant: the code is `FIN-2026-` and a number, so the words that make it distinctive are in the title. */
export interface AppraisalFixture {
  id: string;
  code: string;
  title: string;
}

/** The kinds of appraisal the fixtures hold: each one is the object of one command, so that every command finds the state it starts from. */
export const APPRAISAL_KINDS = [
  'draft',
  'run',
  'export',
  'submit',
  'approve',
  'return',
] as const;
export type AppraisalKind = (typeof APPRAISAL_KINDS)[number];

export interface ReserveFixture {
  /** A live risk of the project that the contingency is drawn for (the code and the title are distinctive). */
  riskId: string;
  riskCode: string;
  riskTitle: string;
  /** The contingency fund of the project, the entry that filled it and a drawdown that waits for its decision. */
  fundId: string;
  ledgerEntryId: string;
  ledgerReason: string;
  drawdownId: string;
  drawdownReason: string;
  /** The words of the source of the assumptions of every appraisal. */
  assumptionSource: string;
  appraisals: Readonly<Record<AppraisalKind, AppraisalFixture>>;
}

const LABEL: Readonly<Record<TenantName, string>> = {
  'TNT-A': 'Alpha',
  'TNT-B': 'Beta',
};
const CODE_BASE: Readonly<Record<TenantName, number>> = {
  'TNT-A': 9100,
  'TNT-B': 9200,
};
const SUBJECT: Readonly<Record<AppraisalKind, string>> = {
  draft: 'a draft that is read and edited',
  run: 'a draft that is computed',
  export: 'a draft whose results are carried out',
  submit: 'a draft that is submitted',
  approve: 'a submission that is approved',
  return: 'a submission that is sent back',
};

function appraisalOf(
  tenant: TenantName,
  kind: AppraisalKind,
): AppraisalFixture {
  const index = APPRAISAL_KINDS.indexOf(kind) + 1;
  return {
    id: fixtureId(tenant, GROUP, 0x10 + index),
    code: `FIN-2026-${CODE_BASE[tenant] + index}`,
    title: `${LABEL[tenant]} tenant appraisal of the investment in the bridge, ${SUBJECT[kind]} 0001`,
  };
}

function reserveOf(tenant: TenantName): ReserveFixture {
  const label = LABEL[tenant];
  return {
    riskId: fixtureId(tenant, GROUP, 0x01),
    riskCode: `${label.toUpperCase()}-RSV-0001`,
    riskTitle: `${label} tenant risk of the contingency that is drawn for the flood of the site 0001`,
    fundId: fixtureId(tenant, GROUP, 0x02),
    ledgerEntryId: fixtureId(tenant, GROUP, 0x03),
    ledgerReason: `${label} tenant filling of the contingency on the decision that allots it 0001`,
    drawdownId: fixtureId(tenant, GROUP, 0x04),
    drawdownReason: `${label} tenant request to draw on the contingency for the flood of the site 0001`,
    assumptionSource: `${label} tenant estimate of the cost of the bridge 0001`,
    appraisals: {
      draft: appraisalOf(tenant, 'draft'),
      run: appraisalOf(tenant, 'run'),
      export: appraisalOf(tenant, 'export'),
      submit: appraisalOf(tenant, 'submit'),
      approve: appraisalOf(tenant, 'approve'),
      return: appraisalOf(tenant, 'return'),
    },
  };
}

/** The contingency of the project of each tenant (a fund, its ledger, a drawdown that waits for its decision and the risk it is for) and six investment appraisals, one for each command that moves one. */
export const RESERVE_FIXTURES: Readonly<Record<TenantName, ReserveFixture>> = {
  'TNT-A': reserveOf('TNT-A'),
  'TNT-B': reserveOf('TNT-B'),
};

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function reserveMarkers(tenant: TenantName): Marker[] {
  const fixture = RESERVE_FIXTURES[tenant];
  const markers: Marker[] = [
    { kind: 'reserve risk id', value: fixture.riskId },
    { kind: 'reserve risk code', value: fixture.riskCode },
    { kind: 'reserve risk title', value: fixture.riskTitle },
    { kind: 'reserve fund id', value: fixture.fundId },
    { kind: 'reserve ledger entry id', value: fixture.ledgerEntryId },
    { kind: 'reserve ledger entry reason', value: fixture.ledgerReason },
    { kind: 'reserve drawdown id', value: fixture.drawdownId },
    { kind: 'reserve drawdown reason', value: fixture.drawdownReason },
    { kind: 'appraisal assumption source', value: fixture.assumptionSource },
  ];
  for (const kind of APPRAISAL_KINDS) {
    const appraisal = fixture.appraisals[kind];
    markers.push(
      { kind: `appraisal ${kind} id`, value: appraisal.id },
      { kind: `appraisal ${kind} code`, value: appraisal.code },
      { kind: `appraisal ${kind} title`, value: appraisal.title },
    );
  }
  return markers;
}
