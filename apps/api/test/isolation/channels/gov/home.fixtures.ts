import type { TenantName } from '../../suite';
import { fixtureId } from './support';
import type { Marker } from './support';

/** The group digit of the home fragment in the ids of its fixtures. */
const GROUP = 7;

/** The families of ids: the work items (explanation requests), the decisions about them, the governance rules, the override of a colour and the weekly score. */
const FAMILY = { item: 1, action: 2, rule: 3, override: 4, score: 5 } as const;

/**
 * The work items the isolation suite seeds for the alert centre, each for one read or one command, so that a command of the owner changes the item of its own case only. They are explanation requests of the first
 * project that the suite principal has to answer, which is the simplest source of the alert centre: `read` is only listed, `snoozed` is overdue and has been put off by another member, `claim`, `assign`, `snooze`
 * and `pause` are the objects of the commands of that name, and `resume` has a pause of its clocks that holds.
 */
export type HomeItemRole = 'read' | 'snoozed' | 'claim' | 'assign' | 'snooze' | 'pause' | 'resume';

export interface HomeItemFixture {
  /** The id of the explanation request, which is the `source_id` of the work item. */
  id: string;
  /** The words of the work item (the question that was asked). */
  question: string;
  /** Distinct for each request: one open request may exist for a project and a trigger. */
  triggerCode: string;
  /** The day the request is due, counted from the day the suite runs on: negative is overdue. */
  dueInDays: number;
}

export interface HomeFixtures {
  items: Readonly<Record<HomeItemRole, HomeItemFixture>>;
  /** The postponement of the `snoozed` item (by a member who is not the suite principal) and the pause of the clocks of the `resume` item. */
  snooze: { id: string; note: string };
  pause: { id: string; note: string };
  /** An approved rule of the clock policy and one of the snooze policy, each with a reason code that only the tenant has (the policies are read back by the list of the policies). */
  policies: { clockRuleId: string; snoozeRuleId: string; pauseReason: string; snoozeReason: string };
  /** An approved definition of an indicator that only the tenant has (the register of the indicators lists every definition in force). */
  kpi: { ruleId: string; code: string; name: string; formula: string; numerator: string; denominator: string; source: string; owner: string };
  /** An override of the colour of the first unit that is in force: the reading of the colours shows it with its reason. */
  override: { id: string; reason: string };
  /** The score of the first unit for the week before the one of the frozen snapshot: the reading of the colours shows it in the trend. */
  score: { id: string; value: string };
}

const ROLES: ReadonlyArray<{ role: HomeItemRole; subject: string; dueInDays: number }> = [
  { role: 'read', subject: 'to explain the delay of the culvert works', dueInDays: 10 },
  { role: 'snoozed', subject: 'to explain the cost of the temporary access road', dueInDays: -3 },
  { role: 'claim', subject: 'to explain the change of the pile design', dueInDays: 10 },
  { role: 'assign', subject: 'to explain the shortage of the survey crew', dueInDays: 10 },
  { role: 'snooze', subject: 'to explain the gap in the site diary', dueInDays: 10 },
  { role: 'pause', subject: 'to explain the delay of the permit of the quarry', dueInDays: 10 },
  { role: 'resume', subject: 'to explain the dispute over the access to the yard', dueInDays: 10 },
];

function build(tenant: TenantName): HomeFixtures {
  const label = tenant === 'TNT-A' ? 'Alpha' : 'Beta';
  const upper = label.toUpperCase();
  const entries = ROLES.map((entry, index) => {
    const fixture: HomeItemFixture = {
      id: fixtureId(tenant, GROUP, FAMILY.item, index + 1),
      question: `${label} work item ${entry.role}: please explain ${entry.subject}`,
      triggerCode: `HOME-ISO-${entry.role.toUpperCase()}`,
      dueInDays: entry.dueInDays,
    };
    return [entry.role, fixture] as const;
  });
  return {
    items: Object.fromEntries(entries) as Record<HomeItemRole, HomeItemFixture>,
    snooze: { id: fixtureId(tenant, GROUP, FAMILY.action, 1), note: `${label} snooze note: the answer waits for the survey of the second bank` },
    pause: { id: fixtureId(tenant, GROUP, FAMILY.action, 2), note: `${label} pause note: the clocks stop while the quarry waits for its permit` },
    policies: {
      clockRuleId: fixtureId(tenant, GROUP, FAMILY.rule, 1),
      snoozeRuleId: fixtureId(tenant, GROUP, FAMILY.rule, 2),
      pauseReason: `${upper}_ISOLATION_HOLD`,
      snoozeReason: `${upper}_ISOLATION_LEAVE`,
    },
    kpi: {
      ruleId: fixtureId(tenant, GROUP, FAMILY.rule, 3),
      code: `${upper}_ISOLATION_KPI`,
      name: `${label} isolation indicator of the culvert works`,
      formula: `${label} formula: culverts finished over culverts planned`,
      numerator: `${label} numerator: culverts finished`,
      denominator: `${label} denominator: culverts planned`,
      source: `${label} source: the site register of the province`,
      owner: `${label} owner: the unit of the road works`,
    },
    override: { id: fixtureId(tenant, GROUP, FAMILY.override), reason: `${label} override reason: the unit is waiting for the figures of the Treasury` },
    score: { id: fixtureId(tenant, GROUP, FAMILY.score), value: tenant === 'TNT-A' ? '58.26' : '73.41' },
  };
}

export const HOME_FIXTURES: Readonly<Record<TenantName, HomeFixtures>> = {
  'TNT-A': build('TNT-A'),
  'TNT-B': build('TNT-B'),
};

/** Every id and every distinctive text of the home fixtures of a tenant: none of them may reach an answer given to the other tenant. */
export function homeMarkers(tenant: TenantName): Marker[] {
  const fixtures = HOME_FIXTURES[tenant];
  const markers: Marker[] = [
    { kind: 'home snooze id', value: fixtures.snooze.id },
    { kind: 'home snooze note', value: fixtures.snooze.note },
    { kind: 'home pause id', value: fixtures.pause.id },
    { kind: 'home pause note', value: fixtures.pause.note },
    { kind: 'home clock policy rule id', value: fixtures.policies.clockRuleId },
    { kind: 'home snooze policy rule id', value: fixtures.policies.snoozeRuleId },
    { kind: 'home clock policy pause reason', value: fixtures.policies.pauseReason },
    { kind: 'home snooze policy reason', value: fixtures.policies.snoozeReason },
    { kind: 'home indicator rule id', value: fixtures.kpi.ruleId },
    { kind: 'home indicator code', value: fixtures.kpi.code },
    { kind: 'home indicator name', value: fixtures.kpi.name },
    { kind: 'home indicator formula', value: fixtures.kpi.formula },
    { kind: 'home indicator numerator', value: fixtures.kpi.numerator },
    { kind: 'home indicator denominator', value: fixtures.kpi.denominator },
    { kind: 'home indicator source', value: fixtures.kpi.source },
    { kind: 'home indicator owner', value: fixtures.kpi.owner },
    { kind: 'home colour override id', value: fixtures.override.id },
    { kind: 'home colour override reason', value: fixtures.override.reason },
    { kind: 'home weekly score id', value: fixtures.score.id },
    { kind: 'home weekly score', value: fixtures.score.value },
  ];
  for (const item of Object.values(fixtures.items)) {
    markers.push({ kind: 'home work item id', value: item.id }, { kind: 'home work item question', value: item.question });
  }
  return markers;
}
