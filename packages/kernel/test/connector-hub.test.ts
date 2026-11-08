import { DomainError } from '../src/errors';
import {
  BUILT_IN_CONNECTORS,
  HUB_HEALTH_STATUSES,
  HUB_POLICY_DEFAULTS,
  assertConnectorDescriptor,
  agentHealthOf,
  agentHeartbeatOf,
  agentRegistrationOf,
  assertRunLayoutKnown,
  connectorAcceptance,
  connectorAlertTypes,
  connectorConformanceProblems,
  connectorDescriptor,
  connectorDescriptors,
  connectorHealth,
  connectorOfPosition,
  connectorScreenRoute,
  consecutiveFailuresOf,
  hubFreshnessOf,
  hubPolicyOf,
  hubRunOf,
  hubStateMove,
  incidentKindOfAlert,
  incidentMove,
  manualIncidentOf,
  registerAllGovernanceRules,
  registerBuiltInConnectors,
  registerConnector,
  registerRuleDefaults,
  runWithNetworkWatch,
  snapshotBucketOf,
  summarizeHub,
  unregisterConnector,
} from '../src/index';
import type { ConnectorDescriptor, HubHealthInput, HubConnectorFact } from '../src/index';
import { HUB_KPI_CODES } from '../src/connector-hub-defaults';
import { connectorFreshnessParams } from '../src/connector-hub';
import { ruleTypeOf } from '../src/governance-rules';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const NOW = new Date('2026-11-08T03:00:00Z');
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

const PROBE: ConnectorDescriptor = {
  code: 'probe.files',
  name: 'Probe file connector',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  layouts: [{ code: 'MAIN', version: '1.0', acceptance: 'ACCEPTED' }],
  freshness: { ruleCode: 'PROBE_FILE', defaults: { maxAgeHours: 48, warnAfterHours: 24, staleSeverity: 'ACTION', figuresBlockedWhenStale: false }, unverified: true },
  credentials: { kind: 'NONE' },
  consumers: ['BID'],
  alertTypes: [],
  ownerRole: 'INTEGRATION_ADMINISTRATOR',
  egress: { policy: 'NONE' },
  screens: ['BID-22'],
  ledger: { kind: 'FILE_FRAMEWORK', positions: ['PROBE_FILE'], sourceSystems: [], stateOwner: 'HUB' },
  sources: ['packages/kernel/src/connector-hub.ts'],
};

const policy = { failingAfterRuns: 1, failingSeverity: 'ACTION' as const };
const freshness = { maxAgeHours: 168, warnAfterHours: 120, staleSeverity: 'WATCH' as const, figuresBlockedWhenStale: false };

const input = (patch: Partial<HubHealthInput> = {}): HubHealthInput => ({
  descriptor: { freshness: PROBE.freshness, layouts: PROBE.layouts },
  enabled: true,
  lastSuccessAt: hoursAgo(10),
  lastRun: { outcome: 'SUCCEEDED', at: hoursAgo(10) },
  consecutiveFailures: 0,
  now: NOW,
  freshness,
  policy,
  ...patch,
});

describe('the descriptor of a connector', () => {
  it('accepts the built-in descriptors and nothing is wrong with them', () => {
    registerAllGovernanceRules();
    registerBuiltInConnectors();
    expect(BUILT_IN_CONNECTORS.length).toBeGreaterThanOrEqual(4);
    for (const descriptor of BUILT_IN_CONNECTORS) {
      expect(() => assertConnectorDescriptor(descriptor)).not.toThrow();
      expect(connectorConformanceProblems(descriptor)).toEqual([]);
    }
  });

  it('refuses each kind of fault by naming it', () => {
    const bad = (patch: Partial<ConnectorDescriptor>): string => {
      try {
        assertConnectorDescriptor({ ...PROBE, ...patch });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    expect(bad({ code: 'Bad Code' })).toContain('code must match');
    expect(bad({ protocols: [] })).toContain('protocols');
    expect(bad({ protocols: ['NO_SUCH'] })).toContain('not registered');
    expect(bad({ protocols: ['HTTPS_REST'] })).toContain('declared egress');
    expect(bad({ egress: { policy: 'DECLARED', hosts: ['api.example.org'], reason: 'Needed for the feed' } })).toContain('declared egress belongs');
    expect(bad({ layouts: [{ code: 'MAIN', version: '', acceptance: 'ACCEPTED' }] })).toContain('no version');
    expect(bad({ layouts: [] })).toContain('versioned layout');
    expect(bad({ freshness: { ruleCode: 'X', defaults: { maxAgeHours: 10, warnAfterHours: 20, staleSeverity: 'WATCH', figuresBlockedWhenStale: false }, unverified: true } })).toContain('warnAfterHours');
    expect(bad({ credentials: { kind: 'MACHINE_ACCOUNT' } })).toContain('scopes');
    expect(bad({ consumers: [] })).toContain('consumers');
    expect(bad({ ledger: { kind: 'FILE_FRAMEWORK', positions: [], sourceSystems: [], stateOwner: 'HUB' } })).toContain('positions');
    expect(bad({ screens: ['bad'] })).toContain('screen');
    expect(bad({ sources: ['../outside.ts'] })).toContain('sources');
    expect(bad({ direction: 'OUTBOUND', protocols: ['WEBHOOK_INBOUND'], layouts: [] })).toContain('send data out');
  });

  it('accepts a declared egress with hosts and a reason for a protocol that reaches another host', () => {
    expect(() =>
      assertConnectorDescriptor({
        ...PROBE,
        code: 'probe.api',
        protocols: ['HTTPS_REST'],
        layouts: [],
        egress: { policy: 'DECLARED', hosts: ['api.example.org'], reason: 'Pull of the feed agreed with the department' },
        credentials: { kind: 'MACHINE_ACCOUNT', scopes: ['feed.read'] },
        ledger: { kind: 'HUB_RUNS', positions: [], sourceSystems: [], stateOwner: 'HUB' },
      }),
    ).not.toThrow();
  });

  it('registers once, refuses a repeated code and a position another connector owns, and can be removed', () => {
    registerConnector(PROBE);
    try {
      expect(connectorDescriptor('probe.files')).toBe(PROBE);
      expect(connectorOfPosition('PROBE_FILE')?.code).toBe('probe.files');
      expect(() => registerConnector(PROBE)).toThrow('already registered');
      expect(() => registerConnector({ ...PROBE, code: 'probe.twin' })).toThrow('already belongs');
      expect(connectorDescriptors().map((d) => d.code)).toContain('probe.files');
    } finally {
      expect(unregisterConnector('probe.files')).toBe(true);
    }
    expect(connectorDescriptor('probe.files')).toBeUndefined();
  });

  it('gives every connector the failing alert and the stale alert when its age is judged', () => {
    expect(connectorAlertTypes(PROBE)).toEqual(['CONNECTOR_FAILING', 'CONNECTOR_STALE']);
    expect(connectorAlertTypes({ freshness: null, alertTypes: ['X_ALERT'] })).toEqual(['CONNECTOR_FAILING', 'X_ALERT']);
  });

  it('judges the acceptance of the layouts as a whole and derives the route of a screen', () => {
    expect(connectorAcceptance({ layouts: [{ code: 'A', version: '1', acceptance: 'ACCEPTED' }, { code: 'B', version: '1', acceptance: 'PENDING_EXTERNAL' }] })).toBe('PENDING_EXTERNAL');
    expect(connectorAcceptance({ layouts: [{ code: 'A', version: '1', acceptance: 'ACCEPTED' }] })).toBe('ACCEPTED');
    expect(connectorAcceptance({ layouts: [] })).toBe('NOT_APPLICABLE');
    expect(connectorScreenRoute('BID-22')).toBe('/bid/bid-22');
  });

  it('checks a run against the layouts and versions the descriptor declares', () => {
    expect(() => assertRunLayoutKnown(PROBE, { layoutCode: 'MAIN', layoutVersion: '1.0' })).not.toThrow();
    expect(() => assertRunLayoutKnown(PROBE, { layoutCode: null, layoutVersion: null })).not.toThrow();
    expect(refusal(() => assertRunLayoutKnown(PROBE, { layoutCode: 'MAIN', layoutVersion: '9.9' })).detail).toBe('layout_version');
  });
});

describe('the registered rules of the hub', () => {
  it('registers the policy, the alert types, the freshness codes and the five KPI definitions', () => {
    registerAllGovernanceRules();
    const policyType = ruleTypeOf('INTEGRATION_HUB_POLICY');
    expect(hubPolicyOf(policyType.defaults.DEFAULT?.params as Record<string, unknown>)).toEqual(HUB_POLICY_DEFAULTS);
    expect(policyType.defaults.DEFAULT?.legalStatus).toBe('UNVERIFIED');
    for (const code of ['CONNECTOR_FAILING', 'CONNECTOR_HUB_STALE']) {
      const params = ruleTypeOf('ALERT_TYPE').defaults[code]?.params as Record<string, unknown>;
      expect(String(params.owner)).toBe('INTEGRATION_ADMINISTRATOR');
      expect(String(params.expected_action).length).toBeGreaterThan(10);
      expect(String(params.consequence).length).toBeGreaterThan(10);
    }
    for (const code of ['NATIONAL_PIM_FILE', 'PROCUREMENT_FILE', 'EGP_FILE', 'TREASURY_STATEMENT']) expect(ruleTypeOf('CONNECTOR_FRESHNESS').defaults[code]).toBeDefined();
    for (const code of HUB_KPI_CODES) {
      const entry = ruleTypeOf('KPI_DEFINITION').defaults[code];
      expect(entry?.unverified).toBe(true);
      expect(String(entry?.formula).length).toBeGreaterThan(10);
      expect(String(entry?.source).length).toBeGreaterThan(5);
    }
  });

  it('lets a lane register the freshness code of its descriptor from the descriptor itself', () => {
    registerAllGovernanceRules();
    registerRuleDefaults('CONNECTOR_FRESHNESS', { PROBE_FILE_FOR_TEST: { params: connectorFreshnessParams(PROBE.freshness as NonNullable<ConnectorDescriptor['freshness']>) } });
    const params = ruleTypeOf('CONNECTOR_FRESHNESS').defaults.PROBE_FILE_FOR_TEST?.params as Record<string, unknown>;
    expect(hubFreshnessOf(params)).toEqual({ maxAgeHours: 48, warnAfterHours: 24, staleSeverity: 'ACTION', figuresBlockedWhenStale: false });
  });

  it('refuses a malformed policy or freshness by naming the member', () => {
    expect(refusal(() => hubPolicyOf({ ...(ruleTypeOf('INTEGRATION_HUB_POLICY').defaults.DEFAULT?.params as Record<string, unknown>), failing_after_runs: 0 })).detail).toBe('failing_after_runs');
    expect(refusal(() => hubFreshnessOf({ max_age_hours: 10, warn_after_hours: 5, stale_severity: 'LOUD', figures_blocked_when_stale: false })).detail).toBe('stale_severity');
  });
});

describe('the health of a connector', () => {
  it('is DISABLED whatever else is true while the switch is off, and raises nothing', () => {
    expect(connectorHealth(input({ enabled: false, consecutiveFailures: 3 }))).toMatchObject({ status: 'DISABLED', alert: null });
  });

  it('is FAILING after the policy number of failed runs in a row, with the alert at the policy severity', () => {
    expect(connectorHealth(input({ consecutiveFailures: 1 }))).toMatchObject({ status: 'FAILING', alert: { code: 'CONNECTOR_FAILING', severity: 'ACTION' } });
    expect(connectorHealth(input({ consecutiveFailures: 1, policy: { failingAfterRuns: 3, failingSeverity: 'URGENT' } })).status).toBe('HEALTHY');
    expect(connectorHealth(input({ consecutiveFailures: 3, policy: { failingAfterRuns: 3, failingSeverity: 'URGENT' } })).alert).toEqual({ code: 'CONNECTOR_FAILING', severity: 'URGENT' });
  });

  it('is PENDING_EXTERNAL when the layouts wait for the other side and nothing has run, and NEVER_RUN otherwise', () => {
    const pending = { freshness: PROBE.freshness, layouts: [{ code: 'MAIN', version: 'WORKING-ASSUMPTION-1', acceptance: 'PENDING_EXTERNAL' as const }] };
    expect(connectorHealth(input({ descriptor: pending, lastSuccessAt: null, lastRun: null })).status).toBe('PENDING_EXTERNAL');
    expect(connectorHealth(input({ lastSuccessAt: null, lastRun: null })).status).toBe('NEVER_RUN');
    expect(connectorHealth(input({ descriptor: pending, lastSuccessAt: null, lastRun: { outcome: 'SKIPPED', at: hoursAgo(1) } })).status).toBe('NEVER_RUN');
  });

  it('is judged by the age of the last success: FRESH, AGING (still HEALTHY) and STALE with the alert and the blocked figures', () => {
    expect(connectorHealth(input({ lastSuccessAt: hoursAgo(10) }))).toMatchObject({ status: 'HEALTHY', freshness: 'FRESH', ageHours: 10 });
    expect(connectorHealth(input({ lastSuccessAt: hoursAgo(130) }))).toMatchObject({ status: 'HEALTHY', freshness: 'AGING' });
    expect(connectorHealth(input({ lastSuccessAt: hoursAgo(200) }))).toMatchObject({ status: 'STALE', alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' }, figuresBlocked: false });
    expect(connectorHealth(input({ lastSuccessAt: hoursAgo(200), freshness: { ...freshness, figuresBlockedWhenStale: true } })).figuresBlocked).toBe(true);
    expect(connectorHealth(input({ lastSuccessAt: hoursAgo(168) })).status).toBe('HEALTHY');
  });

  it('carries the acceptance beside the status and never lets it change the status', () => {
    const pending = { freshness: PROBE.freshness, layouts: [{ code: 'MAIN', version: 'WORKING-ASSUMPTION-1', acceptance: 'PENDING_EXTERNAL' as const }] };
    expect(connectorHealth(input({ descriptor: pending }))).toMatchObject({ status: 'HEALTHY', acceptance: 'PENDING_EXTERNAL' });
  });

  it('is HEALTHY with a success when the age is not judged', () => {
    expect(connectorHealth(input({ descriptor: { freshness: null, layouts: [] }, freshness: null, lastSuccessAt: hoursAgo(9000) }))).toMatchObject({ status: 'HEALTHY', freshness: 'UNKNOWN' });
  });

  it('counts the failures at the head of the runs and skips runs that say nothing', () => {
    expect(consecutiveFailuresOf(['FAILED', 'FAILED', 'SUCCEEDED', 'FAILED'])).toBe(2);
    expect(consecutiveFailuresOf(['RUNNING', 'FAILED', 'SKIPPED', 'FAILED', 'PARTIAL'])).toBe(2);
    expect(consecutiveFailuresOf(['SUCCEEDED', 'FAILED'])).toBe(0);
    expect(consecutiveFailuresOf([])).toBe(0);
  });
});

describe('the summary of the hub', () => {
  const fact = (code: string, patch: Partial<HubHealthInput>, extra: Partial<HubConnectorFact> = {}): HubConnectorFact => ({
    code,
    health: connectorHealth(input(patch)),
    failedRuns7d: 0,
    discrepancyBacklog: 0,
    pendingMappings: 0,
    ...extra,
  });
  const pending = { freshness: PROBE.freshness, layouts: [{ code: 'MAIN', version: 'WORKING-ASSUMPTION-1', acceptance: 'PENDING_EXTERNAL' as const }] };
  const sums = { hubStaleRatioPercent: 50, hubStaleMinConnectors: 2, hubStaleSeverity: 'URGENT' as const };

  it('counts what is monitored without the disabled and the pending, and sums the figures', () => {
    const summary = summarizeHub(
      [
        fact('a', {}, { failedRuns7d: 1, discrepancyBacklog: 4, pendingMappings: 2 }),
        fact('b', { lastSuccessAt: hoursAgo(200) }, { discrepancyBacklog: 1 }),
        fact('c', { enabled: false }),
        fact('d', { descriptor: pending, lastSuccessAt: null, lastRun: null }),
        fact('e', { consecutiveFailures: 2 }, { failedRuns7d: 2 }),
      ],
      sums,
    );
    expect(summary).toMatchObject({ total: 5, monitored: 3, healthy: 1, healthyPercent: 33.3, failedRuns7d: 3, discrepancyBacklog: 5, pendingMappings: 2, oldestDataConnector: 'b', oldestDataAgeHours: 200 });
    expect(summary.counts).toEqual({ HEALTHY: 1, STALE: 1, FAILING: 1, DISABLED: 1, PENDING_EXTERNAL: 1, NEVER_RUN: 0 });
    expect(Object.keys(summary.counts)).toEqual([...HUB_HEALTH_STATUSES]);
  });

  it('gives no percentage when nothing is monitored (no figure beats a false 100)', () => {
    expect(summarizeHub([], sums)).toMatchObject({ monitored: 0, healthyPercent: null, oldestDataAgeHours: null, hubAlert: null });
    expect(summarizeHub([fact('c', { enabled: false })], sums).healthyPercent).toBeNull();
  });

  it('raises the hub-wide stale alert only from the policy ratio and the minimum number of connectors', () => {
    const stale = (code: string): HubConnectorFact => fact(code, { lastSuccessAt: hoursAgo(300) });
    expect(summarizeHub([stale('a'), stale('b'), fact('c', {})], sums).hubAlert).toEqual({ code: 'CONNECTOR_HUB_STALE', severity: 'URGENT' });
    expect(summarizeHub([stale('a'), fact('b', {}), fact('c', {})], sums).hubAlert).toBeNull();
    expect(summarizeHub([stale('a')], sums).hubAlert).toBeNull();
  });
});

describe('the switch, the run record, the incident and the snapshot', () => {
  it('moves the switch only with a boolean, a reason and a real change', () => {
    expect(hubStateMove({ enabled: true }, { enabled: false, reason: 'Waiting for the sample file' })).toEqual({ enabled: false, reason: 'Waiting for the sample file' });
    expect(refusal(() => hubStateMove({ enabled: true }, { enabled: true, reason: 'No change at all here' })).detail).toBe('enabled');
    expect(refusal(() => hubStateMove({ enabled: true }, { enabled: false, reason: 'short' })).detail).toBe('reason');
  });

  const run = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'IMPORT', outcome: 'SUCCEEDED', started_at: '2026-11-08T02:00:00Z', finished_at: '2026-11-08T02:01:00Z', rows_total: 10, rows_applied: 8, rows_rejected: 2, ...patch });

  it('reads a run field by field and refuses what does not hold together', () => {
    expect(hubRunOf(run({ layout_code: 'MAIN', layout_version: '1.0', source_ref: 'sha:abc' }), NOW)).toMatchObject({ kind: 'IMPORT', outcome: 'SUCCEEDED', rowsTotal: 10, layoutCode: 'MAIN', sourceRef: 'sha:abc' });
    expect(refusal(() => hubRunOf(run({ outcome: 'FAILED' }), NOW)).detail).toBe('error_code');
    expect(hubRunOf(run({ outcome: 'FAILED', error_code: 'IMPORT_SCHEMA_INVALID' }), NOW).errorCode).toBe('IMPORT_SCHEMA_INVALID');
    expect(refusal(() => hubRunOf(run({ error_code: 'X_ERROR' }), NOW)).detail).toBe('error_code');
    expect(refusal(() => hubRunOf(run({ finished_at: '2026-11-08T01:00:00Z' }), NOW)).detail).toBe('finished_at');
    expect(refusal(() => hubRunOf(run({ started_at: '2026-12-01T00:00:00Z', finished_at: '2026-12-01T00:01:00Z' }), NOW)).detail).toBe('started_at');
    expect(refusal(() => hubRunOf(run({ rows_applied: 9, rows_rejected: 2 }), NOW)).detail).toBe('rows_total');
    expect(refusal(() => hubRunOf(run({ layout_code: 'MAIN' }), NOW)).detail).toBe('layout_version');
    expect(refusal(() => hubRunOf(run({ kind: 'TELEPORT' }), NOW)).detail).toBe('kind');
    expect(hubRunOf({ kind: 'PULL', outcome: 'RUNNING', started_at: '2026-11-08T02:00:00Z' }, NOW).finishedAt).toBeNull();
  });

  it('moves an incident from open to acknowledged to resolved, each step with a reason, and refuses the wrong start', () => {
    expect(incidentMove({ state: 'OPEN' }, { move: 'ACKNOWLEDGE', reason: 'Taken by the administrator' })).toMatchObject({ to: 'ACKNOWLEDGED', action: 'ACKNOWLEDGED' });
    expect(incidentMove({ state: 'ACKNOWLEDGED' }, { move: 'RESOLVE', reason: 'Fixed the file layout' })).toMatchObject({ to: 'RESOLVED', action: 'RESOLVED' });
    expect(incidentMove({ state: 'OPEN' }, { move: 'RESOLVE', reason: 'Not a real problem at all' }).to).toBe('RESOLVED');
    expect(refusal(() => incidentMove({ state: 'RESOLVED' }, { move: 'RESOLVE', reason: 'Again and again here' })).code).toBe('HUB_INCIDENT_STATE_INVALID');
    expect(refusal(() => incidentMove({ state: 'ACKNOWLEDGED' }, { move: 'ACKNOWLEDGE', reason: 'Again and again here' })).code).toBe('HUB_INCIDENT_STATE_INVALID');
    expect(refusal(() => incidentMove({ state: 'OPEN' }, { move: 'ACKNOWLEDGE', reason: 'no' })).detail).toBe('reason');
  });

  it('maps an alert to an incident kind and reads a manual incident', () => {
    expect(incidentKindOfAlert({ code: 'CONNECTOR_FAILING', severity: 'ACTION' })).toBe('FAILING');
    expect(incidentKindOfAlert({ code: 'CONNECTOR_STALE', severity: 'WATCH' })).toBe('STALE');
    expect(incidentKindOfAlert({ code: 'CONNECTOR_HUB_STALE', severity: 'URGENT' })).toBe('HUB_STALE');
    expect(incidentKindOfAlert(null)).toBeNull();
    expect(manualIncidentOf({ summary: 'The file arrived with another layout' })).toEqual({ severity: 'ACTION', summary: 'The file arrived with another layout' });
    expect(refusal(() => manualIncidentOf({ severity: 'LOUD', summary: 'The file arrived with another layout' })).detail).toBe('severity');
  });

  it('puts every snapshot in the hour it was taken', () => {
    expect(snapshotBucketOf(new Date('2026-11-08T03:59:59Z'))).toBe('2026-11-08T03:00:00Z');
    expect(snapshotBucketOf(new Date('2026-11-08T04:00:00Z'))).toBe('2026-11-08T04:00:00Z');
  });
});

describe('the conformance helper', () => {
  it('reports a connector that is not registered, a missing source and a network import while the egress is NONE', () => {
    registerAllGovernanceRules();
    expect(connectorConformanceProblems(PROBE).join('|')).toContain('not registered');
    expect(connectorConformanceProblems({ ...PROBE, sources: ['packages/kernel/src/does-not-exist.ts'] }, { requireRegistered: false }).join('|')).toContain('does not exist');
    // The protocol module itself is not a connector source, but it shows the rule: it imports node:crypto only, never a network module.
    expect(connectorConformanceProblems({ ...PROBE, freshness: null, alertTypes: [], sources: ['packages/kernel/src/connector-protocols.ts'] }, { requireRegistered: false })).toEqual([]);
  });

  it('flags a fetch call or a net import in the source of a connector whose egress is NONE', () => {
    registerAllGovernanceRules();
    const problems = connectorConformanceProblems({ ...PROBE, freshness: null, alertTypes: [], sources: ['packages/kernel/test/support/network-offender.fixture.ts'] }, { requireRegistered: false });
    expect(problems.join('|')).toContain('imports node:net');
    expect(problems.join('|')).toContain('uses fetch(');
  });

  it('catches every way out in the network watch and proves the watch itself', async () => {
    expect(await runWithNetworkWatch(async () => undefined)).toEqual([]);
    const attempts = await runWithNetworkWatch(async () => {
      await fetch('https://example.invalid/');
    });
    expect(attempts).toEqual(['fetch']);
  });
});

describe('collector agents (any operating system, ARM included)', () => {
  const body = { agent_code: 'collector-hn-01', os: 'linux', cpu_arch: 'arm64', agent_version: '1.4.2', connectors: ['egp.muasamcong', 'treasury.statement'] };

  it('registers a platform as plain data and refuses what does not fit', () => {
    expect(agentRegistrationOf(body)).toEqual({ agentCode: 'collector-hn-01', os: 'linux', cpuArch: 'arm64', agentVersion: '1.4.2', connectors: ['egp.muasamcong', 'treasury.statement'] });
    expect(agentRegistrationOf({ ...body, os: 'windows', cpu_arch: 'amd64' }).cpuArch).toBe('amd64');
    for (const [field, patch] of [['agent_code', { agent_code: 'X' }], ['os', { os: 'beos' }], ['cpu_arch', { cpu_arch: 'x87' }], ['agent_version', { agent_version: '' }], ['connectors', { connectors: [] }], ['connectors', { connectors: ['a.b', 'a.b'] }]] as const) {
      expect(refusal(() => agentRegistrationOf({ ...body, ...patch })).detail).toBe(field);
    }
  });

  it('reads a heartbeat and judges health from it against the policy minutes', () => {
    expect(agentHeartbeatOf({ agent_version: '1.4.3', spool_depth: 12 })).toEqual({ agentVersion: '1.4.3', spoolDepth: 12 });
    expect(refusal(() => agentHeartbeatOf({ agent_version: '1.4.3', spool_depth: -1 })).detail).toBe('spool_depth');
    const base = { state: 'ACTIVE' as const, now: NOW, staleAfterMinutes: 15 };
    expect(agentHealthOf({ ...base, lastHeartbeatAt: null })).toBe('NEVER_SEEN');
    expect(agentHealthOf({ ...base, lastHeartbeatAt: new Date(NOW.getTime() - 10 * 60_000) })).toBe('ONLINE');
    expect(agentHealthOf({ ...base, lastHeartbeatAt: new Date(NOW.getTime() - 16 * 60_000) })).toBe('STALE');
    expect(agentHealthOf({ ...base, state: 'RETIRED', lastHeartbeatAt: NOW })).toBe('RETIRED');
  });
});
