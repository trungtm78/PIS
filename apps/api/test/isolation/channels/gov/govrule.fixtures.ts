import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the governance rule fragment in the ids of its fixtures. */
const GROUP = 3;

/**
 * The families of ids: the governance rules, the exceptions to the separation of duties with their approvals and uses, the line of the certification of a figure, and the pieces of the baseline of the project
 * (a work package, version 0 with its line, a request to appraise again and an alert to the auditors).
 */
const FAMILY = {
  rule: 1,
  sod: 2,
  sodApproval: 3,
  sodUse: 4,
  certification: 5,
  component: 6,
  baseline: 7,
  baselineLine: 8,
  reappraisal: 9,
  alert: 10,
} as const;

/**
 * The versions of the thresholds (rule type `RAG_THRESHOLDS`) the isolation suite seeds, each for one command or read, so that a command of the owner changes the version of its own case only:
 * `submit` and `retire` (a draft), `withdraw` and `approve` (submitted by the maker, so that the principal may take the next move), and `read` (an approved version in force, read, listed and compared).
 */
export type RuleRole = 'submit' | 'withdraw' | 'approve' | 'retire' | 'read';

export interface RuleFixture {
  id: string;
  code: string;
  reason: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED';
  /** The first day of the version; the one that is approved by the owner begins in the far future, because a version never begins in the past. */
  effectiveFrom: string;
}

/** The exceptions to the separation of duties: `approve`, `reject` and `revoke` are asked for and wait; `read` is approved by two people and was used. */
export type SodRole = 'approve' | 'reject' | 'revoke' | 'read';

export interface SodFixture {
  id: string;
  reason: string;
  status: 'REQUESTED' | 'APPROVED';
  /** How many approvals the row holds (the approved one holds the two the matrix asks for). */
  approvals: number;
  /** The only day the exception covers (the days differ, so that no two exceptions of the same person and pair overlap). */
  day: string;
}

export interface GovruleFixtures {
  rules: Readonly<Record<RuleRole, RuleFixture>>;
  /** The alert type the tenant approved for itself: a code that no other tenant and no built-in type has. */
  alertType: { id: string; code: string; reason: string; consequence: string; expectedAction: string; reasonToExist: string };
  sod: Readonly<Record<SodRole, SodFixture>>;
  /** The two approvals of the `read` exception and the two lines of its use by the auditors' register. */
  sodDecisions: {
    byMaker: { id: string; comment: string };
    byPrincipal: { id: string; comment: string };
  };
  sodUses: { used: { id: string; command: string }; blocked: { id: string; command: string } };
  /** The log of a figure of the KPI register that has been confirmed and certified: the key is the one the foreign case reads; the notes are what must never reach the other tenant. */
  certification: { key: string; version: number; confirmed: { id: string; note: string }; certified: { id: string; note: string } };
  /** The pieces that the request to appraise again and the alert to the auditors hang on. */
  baseline: {
    componentId: string;
    componentCode: string;
    componentName: string;
    baselineId: string;
    baselineLineId: string;
    reappraisalId: string;
    alertId: string;
  };
}

const RULES: ReadonlyArray<{ role: RuleRole; status: 'DRAFT' | 'SUBMITTED' | 'APPROVED'; effectiveFrom: string; why: string }> = [
  { role: 'submit', status: 'DRAFT', effectiveFrom: '2099-01-01', why: 'to ask for the first line of the disbursement ratio' },
  { role: 'withdraw', status: 'SUBMITTED', effectiveFrom: '2099-01-01', why: 'to ask for a stricter line of the disbursement ratio' },
  { role: 'approve', status: 'SUBMITTED', effectiveFrom: '2099-01-01', why: 'to ask for a line of the disbursement ratio that suits the second half' },
  { role: 'retire', status: 'DRAFT', effectiveFrom: '2099-01-01', why: 'to ask for a line that nobody needs any more' },
  { role: 'read', status: 'APPROVED', effectiveFrom: '2026-01-01', why: 'to hold the line of the disbursement ratio that governs today' },
];

const SOD: ReadonlyArray<{ role: SodRole; status: 'REQUESTED' | 'APPROVED'; approvals: number; day: string; why: string }> = [
  { role: 'approve', status: 'REQUESTED', approvals: 0, day: '2099-01-01', why: 'to let the officer prepare and approve the revision of the same project' },
  { role: 'reject', status: 'REQUESTED', approvals: 0, day: '2099-01-02', why: 'to let the officer prepare and approve the package of the same project' },
  { role: 'revoke', status: 'REQUESTED', approvals: 0, day: '2099-01-03', why: 'to let the officer verify and send the payment of the same project' },
  { role: 'read', status: 'APPROVED', approvals: 2, day: '2099-01-04', why: 'to let the officer record and confirm the acceptance of the same project' },
];

function build(tenant: TenantName): GovruleFixtures {
  const label = tenant === 'TNT-A' ? 'Alpha' : 'Beta';
  const prefix = tenant === 'TNT-A' ? 'ALPHA' : 'BETA';
  const rules = Object.fromEntries(
    RULES.map((entry, index) => [
      entry.role,
      {
        id: fixtureId(tenant, GROUP, FAMILY.rule, index + 1),
        code: `${prefix}_RAG_${entry.role.toUpperCase()}`,
        reason: `${label} rule ${entry.role}: ${entry.why}`,
        status: entry.status,
        effectiveFrom: entry.effectiveFrom,
      } satisfies RuleFixture,
    ]),
  ) as Record<RuleRole, RuleFixture>;
  const sod = Object.fromEntries(
    SOD.map((entry, index) => [
      entry.role,
      {
        id: fixtureId(tenant, GROUP, FAMILY.sod, index + 1),
        reason: `${label} exception ${entry.role}: ${entry.why}`,
        status: entry.status,
        approvals: entry.approvals,
        day: entry.day,
      } satisfies SodFixture,
    ]),
  ) as Record<SodRole, SodFixture>;
  return {
    rules,
    alertType: {
      id: fixtureId(tenant, GROUP, FAMILY.rule, 50),
      code: `${prefix}_ISOLATION_ALERT`,
      reason: `${label} alert type: the tenant keeps its own registry entry for the quarterly review`,
      consequence: `${label} consequence: the review of the quarter is reported to the board`,
      expectedAction: `${label} expected action: the unit answers the reviewer in writing`,
      reasonToExist: `${label} reason to exist: the board asked for a quarterly review`,
    },
    sod,
    sodDecisions: {
      byMaker: { id: fixtureId(tenant, GROUP, FAMILY.sodApproval, 1), comment: `${label} approval comment of the officer who asked` },
      byPrincipal: { id: fixtureId(tenant, GROUP, FAMILY.sodApproval, 2), comment: `${label} approval comment of the second approver` },
    },
    sodUses: {
      used: { id: fixtureId(tenant, GROUP, FAMILY.sodUse, 1), command: `${label}IsolationUsedCommand` },
      blocked: { id: fixtureId(tenant, GROUP, FAMILY.sodUse, 2), command: `${label}IsolationBlockedCommand` },
    },
    certification: {
      key: `${prefix}-ISOLATION-KPI`,
      version: 1,
      confirmed: { id: fixtureId(tenant, GROUP, FAMILY.certification, 1), note: `${label} confirmation note of the figure` },
      certified: { id: fixtureId(tenant, GROUP, FAMILY.certification, 2), note: `${label} certification note of the figure` },
    },
    baseline: {
      componentId: fixtureId(tenant, GROUP, FAMILY.component),
      componentCode: `${prefix}-WP-01`,
      componentName: `${label} first work package of the baseline`,
      baselineId: fixtureId(tenant, GROUP, FAMILY.baseline),
      baselineLineId: fixtureId(tenant, GROUP, FAMILY.baselineLine),
      reappraisalId: fixtureId(tenant, GROUP, FAMILY.reappraisal),
      alertId: fixtureId(tenant, GROUP, FAMILY.alert),
    },
  };
}

export const GOVRULE_FIXTURES: Readonly<Record<TenantName, GovruleFixtures>> = {
  'TNT-A': build('TNT-A'),
  'TNT-B': build('TNT-B'),
};

/**
 * Every id and every distinctive text of the governance rule fixtures of a tenant: none of them may reach an answer given to the other tenant. The key of the certification is not listed: the log answers with the key
 * it was asked for, so the key of TNT-B is in every answer to a request that names it; its notes and its lines are what the other tenant must not read.
 */
export function govruleMarkers(tenant: TenantName): Marker[] {
  const fixtures = GOVRULE_FIXTURES[tenant];
  const markers: Marker[] = [
    { kind: 'alert type rule id', value: fixtures.alertType.id },
    { kind: 'alert type code', value: fixtures.alertType.code },
    { kind: 'alert type rule reason', value: fixtures.alertType.reason },
    { kind: 'alert type consequence', value: fixtures.alertType.consequence },
    { kind: 'alert type expected action', value: fixtures.alertType.expectedAction },
    { kind: 'alert type reason to exist', value: fixtures.alertType.reasonToExist },
    { kind: 'sod approval id', value: fixtures.sodDecisions.byMaker.id },
    { kind: 'sod approval comment', value: fixtures.sodDecisions.byMaker.comment },
    { kind: 'sod second approval id', value: fixtures.sodDecisions.byPrincipal.id },
    { kind: 'sod second approval comment', value: fixtures.sodDecisions.byPrincipal.comment },
    { kind: 'sod use id', value: fixtures.sodUses.used.id },
    { kind: 'sod use command', value: fixtures.sodUses.used.command },
    { kind: 'sod blocked use id', value: fixtures.sodUses.blocked.id },
    { kind: 'sod blocked use command', value: fixtures.sodUses.blocked.command },
    { kind: 'certification confirmed line id', value: fixtures.certification.confirmed.id },
    { kind: 'certification confirmation note', value: fixtures.certification.confirmed.note },
    { kind: 'certification certified line id', value: fixtures.certification.certified.id },
    { kind: 'certification certificate note', value: fixtures.certification.certified.note },
    { kind: 'baseline component id', value: fixtures.baseline.componentId },
    { kind: 'baseline component code', value: fixtures.baseline.componentCode },
    { kind: 'baseline component name', value: fixtures.baseline.componentName },
    { kind: 'baseline id', value: fixtures.baseline.baselineId },
    { kind: 'baseline line id', value: fixtures.baseline.baselineLineId },
    { kind: 'reappraisal request id', value: fixtures.baseline.reappraisalId },
    { kind: 'governance alert id', value: fixtures.baseline.alertId },
  ];
  for (const rule of Object.values(fixtures.rules)) {
    markers.push({ kind: 'governance rule id', value: rule.id }, { kind: 'governance rule code', value: rule.code }, { kind: 'governance rule reason', value: rule.reason });
  }
  for (const exception of Object.values(fixtures.sod)) {
    markers.push({ kind: 'sod exception id', value: exception.id }, { kind: 'sod exception reason', value: exception.reason });
  }
  return markers;
}
