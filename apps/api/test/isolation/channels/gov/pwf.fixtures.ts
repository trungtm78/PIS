import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the workflow of a project and the scores of staff (PWF-1 to PWF-3) in the ids of its fixtures; the families start at 0x40, the hub of the same group holds 0x01. */
const GROUP = 0xf;

const FAMILY = {
  workflow: 0x40,
  task: 0x41,
  exception: 0x42,
  proposal: 0x43,
  period: 0x44,
  line: 0x45,
  adjustment: 0x46,
  response: 0x47,
  signal: 0x48,
  lockPeriod: 0x49,
  lockedPeriod: 0x4a,
  lockedLine: 0x4b,
  ownLine: 0x4c,
} as const;

const LABEL: Readonly<Record<TenantName, string>> = { 'TNT-A': 'Alpha', 'TNT-B': 'Beta' };

/** The code of the one task of the workflow of the fixtures, and of its one checklist item: the same for both tenants (codes of a template are not secrets), the rest of the fixture is distinctive. */
export const PWF_TASK_CODE = 'ISOLATION_TASK';
export const PWF_CHECKLIST_CODE = 'DOSSIER';

/** What a tenant owns of the workflow of a project and of the scores of staff, so that a foreign-id case names a real object of the other tenant (its owner finds it). */
export interface PwfFixture {
  workflowId: string;
  taskId: string;
  taskName: string;
  exceptionId: string;
  exceptionReason: string;
  proposalId: string;
  proposalReason: string;
  /** A draft period with a rated line and a signal: the reads, and the commands on a line. */
  periodId: string;
  lineId: string;
  /** A draft period of its own, so that locking it as its owner does not take the lines of the others away. */
  lockPeriodId: string;
  /** A locked period with one line that carries an adjustment and a response (they exist only after the lock). */
  lockedPeriodId: string;
  lockedLineId: string;
  /** The line of the member the suite acts as in the locked period: only the person scored answers a score, and a stranger is told there is none. */
  ownLineId: string;
  adjustmentId: string;
  adjustmentReason: string;
  responseId: string;
  responseBody: string;
  signalId: string;
}

function pwfOf(tenant: TenantName): PwfFixture {
  const label = LABEL[tenant];
  return {
    workflowId: fixtureId(tenant, GROUP, FAMILY.workflow),
    taskId: fixtureId(tenant, GROUP, FAMILY.task),
    taskName: `${label} tenant task: check the dossier of the permit of the bridge 0001`,
    exceptionId: fixtureId(tenant, GROUP, FAMILY.exception),
    exceptionReason: `${label} tenant request to waive the dossier check until the survey of the second bank is back`,
    proposalId: fixtureId(tenant, GROUP, FAMILY.proposal),
    proposalReason: `${label} tenant proposal to move the start of the works by two weeks for the flood season`,
    periodId: fixtureId(tenant, GROUP, FAMILY.period),
    lineId: fixtureId(tenant, GROUP, FAMILY.line),
    lockPeriodId: fixtureId(tenant, GROUP, FAMILY.lockPeriod),
    lockedPeriodId: fixtureId(tenant, GROUP, FAMILY.lockedPeriod),
    lockedLineId: fixtureId(tenant, GROUP, FAMILY.lockedLine),
    ownLineId: fixtureId(tenant, GROUP, FAMILY.ownLine),
    adjustmentId: fixtureId(tenant, GROUP, FAMILY.adjustment),
    adjustmentReason: `${label} tenant request to add points because the agency answered the letter late`,
    responseId: fixtureId(tenant, GROUP, FAMILY.response),
    responseBody: `${label} tenant answer of the person scored: the delay came from the agency, the letter is attached`,
    signalId: fixtureId(tenant, GROUP, FAMILY.signal),
  };
}

export const PWF_FIXTURES: Readonly<Record<TenantName, PwfFixture>> = { 'TNT-A': pwfOf('TNT-A'), 'TNT-B': pwfOf('TNT-B') };

/** Every id and every distinctive text of the fixtures of a tenant: none of them may appear in an answer given to the other tenant. */
export function pwfMarkers(tenant: TenantName): Marker[] {
  const fixture = PWF_FIXTURES[tenant];
  return [
    { kind: 'pwf workflow id', value: fixture.workflowId },
    { kind: 'pwf task id', value: fixture.taskId },
    { kind: 'pwf task name', value: fixture.taskName },
    { kind: 'pwf exception id', value: fixture.exceptionId },
    { kind: 'pwf exception reason', value: fixture.exceptionReason },
    { kind: 'pwf reschedule proposal id', value: fixture.proposalId },
    { kind: 'pwf reschedule proposal reason', value: fixture.proposalReason },
    { kind: 'staff score period id', value: fixture.periodId },
    { kind: 'staff score line id', value: fixture.lineId },
    { kind: 'staff score lock period id', value: fixture.lockPeriodId },
    { kind: 'staff score locked period id', value: fixture.lockedPeriodId },
    { kind: 'staff score locked line id', value: fixture.lockedLineId },
    { kind: 'staff score own line id', value: fixture.ownLineId },
    { kind: 'staff score adjustment id', value: fixture.adjustmentId },
    { kind: 'staff score adjustment reason', value: fixture.adjustmentReason },
    { kind: 'staff score response id', value: fixture.responseId },
    { kind: 'staff score response body', value: fixture.responseBody },
    { kind: 'staff score signal id', value: fixture.signalId },
  ];
}
