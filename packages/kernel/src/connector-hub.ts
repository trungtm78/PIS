import { DomainError } from './errors.ts';
import { hasControlChar, hasControlCharExceptWhitespace } from './control-chars.ts';
import { protocolDefinition } from './connector-protocols.ts';
import { assertSchedule } from './etl-pipeline.ts';
import type { PipelineSpec } from './etl-pipeline.ts';

/**
 * The Integration Hub (HUB-1): every connection to an outside system, whatever it carries and however it arrives, is one entry of one registry and is managed the same way. A connector plugs in by a
 * `ConnectorDescriptor` (plain data: its code, direction, transports, layouts with their acceptance, the freshness rule, what it needs as a credential, who reads its data, the alerts it can raise, its owner,
 * whether it may open a network connection, the screens it owns and where its run history lives). The hub reads that, never the code of the connector.
 *
 * This module is pure: the vocabulary, the validation of a descriptor, the open registry (the same idea as the governance rule type registry), the health of a connector from its last runs and its freshness policy,
 * the summary of the whole hub, the rules of an incident, of a run record and of a snapshot. It reads no database and opens no connection (the test `connector-hub.test.ts` and the conformance helper prove it).
 * The numbers that decide anything (how many failures make a connector FAILING, when the whole hub counts as stale) are the rule `INTEGRATION_HUB_POLICY`, never constants here; the freshness of each connector is
 * the rule `CONNECTOR_FRESHNESS` under the `ruleCode` of its descriptor.
 */

export const CONNECTOR_DIRECTIONS = ['INBOUND', 'OUTBOUND', 'BOTH'] as const;
export type ConnectorDirection = (typeof CONNECTOR_DIRECTIONS)[number];

/** How the data moves: a file a person hands over, a pull or a push over an API, or a generator that produces a file for the other side. */
export const CONNECTOR_TRANSPORTS = ['FILE', 'API_PULL', 'API_PUSH', 'GENERATOR'] as const;
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

/** The acceptance of a layout: a working assumption waits for the sample and the confirmation of the other side (eng-review R18). */
export const LAYOUT_ACCEPTANCES = ['PENDING_EXTERNAL', 'ACCEPTED', 'NOT_APPLICABLE'] as const;
export type LayoutAcceptance = (typeof LAYOUT_ACCEPTANCES)[number];

export const CONNECTOR_CREDENTIAL_KINDS = ['NONE', 'VAULT_REFERENCE', 'MACHINE_ACCOUNT'] as const;
export type ConnectorCredentialKind = (typeof CONNECTOR_CREDENTIAL_KINDS)[number];

export const CONNECTOR_LEDGER_KINDS = ['FILE_FRAMEWORK', 'HUB_RUNS', 'ADAPTER'] as const;
export type ConnectorLedgerKind = (typeof CONNECTOR_LEDGER_KINDS)[number];

/** The health words of the hub. NEVER_RUN and PENDING_EXTERNAL are not faults: a connector nobody has used, and one that waits for the other side, are shown as what they are, never as "no data" or as fine. */
export const HUB_HEALTH_STATUSES = ['HEALTHY', 'STALE', 'FAILING', 'DISABLED', 'PENDING_EXTERNAL', 'NEVER_RUN'] as const;
export type HubHealthStatus = (typeof HUB_HEALTH_STATUSES)[number];

export const HUB_FRESHNESS_BANDS = ['FRESH', 'AGING', 'STALE', 'UNKNOWN'] as const;
export type HubFreshnessBand = (typeof HUB_FRESHNESS_BANDS)[number];

export type HubSeverity = 'URGENT' | 'ACTION' | 'WATCH';
const SEVERITIES: readonly string[] = ['URGENT', 'ACTION', 'WATCH'];

/** The rule type of the freshness of each connector and the rule type of the hub policy. */
export const CONNECTOR_FRESHNESS_RULE_TYPE = 'CONNECTOR_FRESHNESS';
export const HUB_POLICY_RULE_TYPE = 'INTEGRATION_HUB_POLICY';
export const HUB_POLICY_RULE_CODE = 'DEFAULT';

/** The alerts every connector of the hub can raise, whatever its descriptor says. */
export const HUB_ALERT_FAILING = 'CONNECTOR_FAILING';
export const HUB_ALERT_STALE = 'CONNECTOR_STALE';
export const HUB_ALERT_HUB_STALE = 'CONNECTOR_HUB_STALE';

/** The permission-free role every connector names as owner unless its descriptor says another one. */
export const HUB_DEFAULT_OWNER_ROLE = 'INTEGRATION_ADMINISTRATOR';

export const HUB_MIN_REASON = 10;
export const HUB_MAX_REASON = 2000;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The descriptor.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ConnectorLayout {
  /** The code of the layout inside the connector (KHLCNT, TBMT, STATEMENT ...): upper case. */
  code: string;
  /** The version label the files are read under (WORKING-ASSUMPTION-2026.2). A layout without a version is not a layout. */
  version: string;
  acceptance: LayoutAcceptance;
  /** What the layout waits for while it is PENDING_EXTERNAL (codes of the connector's pending items). */
  pending?: readonly string[];
}

export interface ConnectorFreshnessDefaults {
  maxAgeHours: number;
  warnAfterHours: number;
  staleSeverity: HubSeverity;
  figuresBlockedWhenStale: boolean;
}

export interface ConnectorFreshness {
  /** The code under the rule type `CONNECTOR_FRESHNESS` the tenant's rule is read from. */
  ruleCode: string;
  /** What the code defaults to when the platform has to create it (a lane registers these with `registerRuleDefaults`); our own operational choice. */
  defaults: ConnectorFreshnessDefaults;
  /** True while nobody confirmed the numbers: the screen shows the flag beside the figure. */
  unverified: boolean;
}

export interface ConnectorCredentials {
  kind: ConnectorCredentialKind;
  /** For MACHINE_ACCOUNT: the scopes the account of the outside system gets (the secret itself never lives in the database, only a vault reference). */
  scopes?: readonly string[];
}

export type ConnectorEgress = { policy: 'NONE' } | { policy: 'DECLARED'; hosts: readonly string[]; reason: string };

export interface ConnectorLedger {
  kind: ConnectorLedgerKind;
  /** The `connector_code` values this connector uses in the file import framework (file_import, integration_cursor): FILE_FRAMEWORK needs at least one. */
  positions: readonly string[];
  /** The `source_system` words of the crosswalk that its mappings use (pending mappings are counted there). */
  sourceSystems: readonly string[];
  /** Who owns the on/off switch: the connector's own command (CONNECTOR) or the hub (HUB). */
  stateOwner: 'CONNECTOR' | 'HUB';
  /** True when the import path of the connector keeps no `integration_cursor` row for its positions (the framework is used without a cursor scope): the database half of the conformance check then does not ask for one. */
  cursorless?: boolean;
}

export interface ConnectorDescriptor {
  /** The code of the connector as the registry of connectors (ADM) and the tenant know it: `^[a-z0-9_.-]{3,60}$`. */
  code: string;
  /** The English name; the screens translate it by the key `hub.connector.<code>.name` and fall back to this. */
  name: string;
  direction: ConnectorDirection;
  /** The transport protocols that run today (codes of the protocol registry, `connector-protocols.ts`). A protocol whose egress class is not NONE is listed only when `egress` is DECLARED. */
  protocols: readonly string[];
  /** Protocols the connector is waiting to get (it opens no connection with them today). */
  plannedProtocols?: readonly string[];
  /** The ETL pipelines of the connector (extract, validate, transform, load): one per layout is the usual shape. */
  pipelines?: readonly PipelineSpec[];
  layouts: readonly ConnectorLayout[];
  /** Null when the age of the data is not judged (a generator that is run on demand). */
  freshness: ConnectorFreshness | null;
  credentials: ConnectorCredentials;
  /** The module codes that read this data. */
  consumers: readonly string[];
  /** The alert types it can raise besides the two every connector has. */
  alertTypes: readonly string[];
  ownerRole: string;
  egress: ConnectorEgress;
  /** The screens it owns (BID-22 ...): the hub links to them by route. */
  screens: readonly string[];
  ledger: ConnectorLedger;
  /** The repo-relative source files that implement the connector: the conformance test proves they open no network client unless the egress is declared. */
  sources: readonly string[];
}

const CODE = /^[a-z0-9_.-]{3,60}$/;
const WORD = /^[A-Z][A-Z0-9_]*$/;
const MODULE = /^[A-Z]{2,6}$/;
const SCREEN = /^[A-Z]{2,6}-\d{2}$/;
const SCOPE = /^[a-z][a-z0-9_.-]{1,60}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const SOURCE_FILE = /^[A-Za-z0-9_./-]{3,200}$/;

const flaw = (code: string, message: string): Error => new Error(`connector descriptor ${code}: ${message}`);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const textOk = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= max && !hasControlChar(value);

/**
 * Judges a descriptor and throws a plain Error (a defect of the lane that wrote it, found when the process starts or in the conformance test, never an answer to a caller) naming the first fault.
 * Returns the descriptor so that a lane can write `registerConnector(assertConnectorDescriptor({...}))`.
 */
export function assertConnectorDescriptor(descriptor: ConnectorDescriptor): ConnectorDescriptor {
  const code = String(descriptor.code);
  if (!CODE.test(code)) throw flaw(code, 'code must match ^[a-z0-9_.-]{3,60}$');
  if (!textOk(descriptor.name, 120)) throw flaw(code, 'name is required');
  if (!oneOf(CONNECTOR_DIRECTIONS, descriptor.direction)) throw flaw(code, 'direction is unknown');
  if (!Array.isArray(descriptor.protocols) || descriptor.protocols.length === 0 || new Set(descriptor.protocols).size !== descriptor.protocols.length) throw flaw(code, 'protocols must be a non-empty list without repeats');
  for (const protocol of descriptor.protocols) if (protocolDefinition(protocol) === undefined) throw flaw(code, `protocol ${protocol} is not registered`);
  for (const planned of descriptor.plannedProtocols ?? []) {
    if (protocolDefinition(planned) === undefined || descriptor.protocols.includes(planned)) throw flaw(code, 'plannedProtocols must be registered and not already running');
  }
  const transports = connectorTransports(descriptor);
  const directions = new Set(descriptor.protocols.flatMap((protocol) => protocolDefinition(protocol)?.directions ?? []));
  if (descriptor.direction === 'INBOUND' && !directions.has('INBOUND')) throw flaw(code, 'an inbound connector needs a protocol that can bring data in');
  if (descriptor.direction === 'OUTBOUND' && !directions.has('OUTBOUND')) throw flaw(code, 'an outbound connector needs a protocol that can send data out');
  const seenLayouts = new Set<string>();
  for (const layout of descriptor.layouts) {
    if (!WORD.test(layout.code) || layout.code.length > 60) throw flaw(code, 'layout code must be an upper case word');
    if (!textOk(layout.version, 40)) throw flaw(code, `layout ${layout.code} has no version`);
    if (!oneOf(LAYOUT_ACCEPTANCES, layout.acceptance)) throw flaw(code, `layout ${layout.code} has an unknown acceptance`);
    if (layout.acceptance === 'PENDING_EXTERNAL' && (layout.pending ?? []).some((item) => !WORD.test(item))) throw flaw(code, `layout ${layout.code} names a pending item that is not a code`);
    const key = `${layout.code}@${layout.version}`;
    if (seenLayouts.has(key)) throw flaw(code, `layout ${key} repeats`);
    seenLayouts.add(key);
  }
  if (transports.includes('FILE') && descriptor.layouts.length === 0) throw flaw(code, 'a file connector declares at least one versioned layout');
  const freshness = descriptor.freshness;
  if (freshness !== null) {
    if (!WORD.test(freshness.ruleCode) || freshness.ruleCode.length > 60) throw flaw(code, 'freshness.ruleCode must be an upper case word');
    const defaults = freshness.defaults;
    const hours = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8760;
    if (!hours(defaults.maxAgeHours) || !hours(defaults.warnAfterHours) || defaults.warnAfterHours > defaults.maxAgeHours) throw flaw(code, 'freshness defaults: warnAfterHours must not exceed maxAgeHours, both 1 to 8760');
    if (!SEVERITIES.includes(defaults.staleSeverity)) throw flaw(code, 'freshness defaults: unknown severity');
    if (typeof defaults.figuresBlockedWhenStale !== 'boolean' || typeof freshness.unverified !== 'boolean') throw flaw(code, 'freshness flags must be booleans');
  }
  if (!oneOf(CONNECTOR_CREDENTIAL_KINDS, descriptor.credentials.kind)) throw flaw(code, 'credentials.kind is unknown');
  const scopes = descriptor.credentials.scopes ?? [];
  if (descriptor.credentials.kind === 'MACHINE_ACCOUNT' ? scopes.length === 0 : scopes.length > 0) throw flaw(code, 'scopes belong to MACHINE_ACCOUNT credentials and only to them');
  if (!scopes.every((scope) => SCOPE.test(scope))) throw flaw(code, 'a scope is malformed');
  if (descriptor.consumers.length === 0 || !descriptor.consumers.every((module) => MODULE.test(module))) throw flaw(code, 'consumers must name at least one module code');
  if (!descriptor.alertTypes.every((alert) => WORD.test(alert))) throw flaw(code, 'an alert type is not a code');
  if (freshness !== null && !connectorAlertTypes(descriptor).includes(HUB_ALERT_STALE)) throw flaw(code, 'a connector with a freshness rule can raise CONNECTOR_STALE');
  if (!WORD.test(descriptor.ownerRole)) throw flaw(code, 'ownerRole must be a role code');
  if (!oneOf(['NONE', 'DECLARED'] as const, descriptor.egress.policy)) throw flaw(code, 'egress.policy is unknown');
  const leavesTheMachine = descriptor.protocols.some((protocol) => protocolDefinition(protocol)?.egress !== 'NONE');
  if (descriptor.egress.policy === 'NONE' && leavesTheMachine) throw flaw(code, 'a protocol that reaches another host needs a declared egress (hosts and reason)');
  if (descriptor.egress.policy === 'DECLARED' && !leavesTheMachine) throw flaw(code, 'a declared egress belongs to a connector that has a protocol reaching another host');
  if (descriptor.egress.policy === 'DECLARED') {
    const { hosts, reason } = descriptor.egress;
    if (hosts.length === 0 || hosts.length > 10 || !hosts.every((host) => HOST.test(host))) throw flaw(code, 'a declared egress names one to ten lower case hosts');
    if (typeof reason !== 'string' || reason.trim().length < HUB_MIN_REASON || hasControlCharExceptWhitespace(reason)) throw flaw(code, 'a declared egress states its reason');
  }
  const pipelineCodes = new Set<string>();
  for (const pipeline of descriptor.pipelines ?? []) {
    if (!WORD.test(pipeline.code) || pipelineCodes.has(pipeline.code)) throw flaw(code, 'a pipeline code is an upper case word, once');
    pipelineCodes.add(pipeline.code);
    if (!textOk(pipeline.name, 120) || !descriptor.protocols.includes(pipeline.protocol)) throw flaw(code, `pipeline ${pipeline.code} must name one of the running protocols`);
    if (!descriptor.layouts.some((layout) => layout.code === pipeline.layoutCode && layout.version === pipeline.layoutVersion)) throw flaw(code, `pipeline ${pipeline.code} names a layout the descriptor does not declare`);
    if (!textOk(pipeline.target, 120)) throw flaw(code, `pipeline ${pipeline.code} names no load target`);
    try {
      assertSchedule(pipeline.schedule);
    } catch {
      throw flaw(code, `pipeline ${pipeline.code} has an invalid schedule`);
    }
  }
  if (!descriptor.screens.every((screen) => SCREEN.test(screen))) throw flaw(code, 'a screen is not a screen id');
  const ledger = descriptor.ledger;
  if (!oneOf(CONNECTOR_LEDGER_KINDS, ledger.kind)) throw flaw(code, 'ledger.kind is unknown');
  if (!oneOf(['CONNECTOR', 'HUB'] as const, ledger.stateOwner)) throw flaw(code, 'ledger.stateOwner is unknown');
  if (ledger.cursorless !== undefined && typeof ledger.cursorless !== 'boolean') throw flaw(code, 'ledger.cursorless must be a boolean');
  if (!ledger.positions.every((position) => WORD.test(position) && position.length <= 80)) throw flaw(code, 'a ledger position must be an upper case word');
  if (ledger.kind === 'FILE_FRAMEWORK' && ledger.positions.length === 0) throw flaw(code, 'a file framework connector names its positions');
  if (ledger.kind !== 'FILE_FRAMEWORK' && ledger.positions.length > 0) throw flaw(code, 'only a file framework connector has positions');
  if (!ledger.sourceSystems.every((system) => WORD.test(system))) throw flaw(code, 'a source system must be an upper case word');
  if (descriptor.sources.length === 0 || !descriptor.sources.every((file) => SOURCE_FILE.test(file) && !file.includes('..'))) throw flaw(code, 'sources must list the repo-relative files of the connector');
  return descriptor;
}

/** The alerts the connector can raise: the two every connector has (failing; stale when its age is judged) and its own, once each. */
export function connectorAlertTypes(descriptor: Pick<ConnectorDescriptor, 'freshness' | 'alertTypes'>): string[] {
  return [...new Set([HUB_ALERT_FAILING, ...(descriptor.freshness === null ? [] : [HUB_ALERT_STALE]), ...descriptor.alertTypes])];
}

/** The transports of the connector's running protocols (FILE, API_PULL, API_PUSH, GENERATOR), once each. */
export function connectorTransports(descriptor: Pick<ConnectorDescriptor, 'protocols'>): ConnectorTransport[] {
  return [...new Set(descriptor.protocols.map((protocol) => protocolDefinition(protocol)?.transport).filter((value): value is ConnectorTransport => value !== undefined))];
}

/** The acceptance of the connector as a whole: PENDING_EXTERNAL while any layout waits, ACCEPTED when every layout is accepted, NOT_APPLICABLE when it has no format of its own. */
export function connectorAcceptance(descriptor: Pick<ConnectorDescriptor, 'layouts'>): LayoutAcceptance {
  const judged = descriptor.layouts.filter((layout) => layout.acceptance !== 'NOT_APPLICABLE');
  if (judged.length === 0) return 'NOT_APPLICABLE';
  return judged.some((layout) => layout.acceptance === 'PENDING_EXTERNAL') ? 'PENDING_EXTERNAL' : 'ACCEPTED';
}

/** The route of a screen: `/<module>/<id>` in lower case, the way the route table derives it. */
export const connectorScreenRoute = (screen: string): string => `/${screen.slice(0, screen.indexOf('-')).toLowerCase()}/${screen.toLowerCase()}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The open registry.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const REGISTRY = new Map<string, ConnectorDescriptor>();

/**
 * Adds a connector to the hub. A code registers once, and a position of the file import framework belongs to one connector only (two connectors writing under the same position would share a history and a
 * freshness), so a second claim is a defect of the lane that makes it. The descriptor is judged first.
 */
export function registerConnector(descriptor: ConnectorDescriptor): void {
  assertConnectorDescriptor(descriptor);
  if (REGISTRY.has(descriptor.code)) throw flaw(descriptor.code, 'is already registered');
  for (const other of REGISTRY.values()) {
    const clash = descriptor.ledger.positions.find((position) => other.ledger.positions.includes(position));
    if (clash !== undefined) throw flaw(descriptor.code, `position ${clash} already belongs to ${other.code}`);
  }
  REGISTRY.set(descriptor.code, descriptor);
}

/** Removes a connector (a test that registered a probe removes it again; nothing in the platform calls this). */
export function unregisterConnector(code: string): boolean {
  return REGISTRY.delete(code);
}

/** Every connector in the order it was registered. */
export const connectorDescriptors = (): ConnectorDescriptor[] => [...REGISTRY.values()];

export const connectorDescriptor = (code: string): ConnectorDescriptor | undefined => REGISTRY.get(code);

export const isConnectorCode = (value: unknown): value is string => typeof value === 'string' && REGISTRY.has(value);

/** The connector that owns a position of the file import framework, or undefined. */
export const connectorOfPosition = (position: string): ConnectorDescriptor | undefined => [...REGISTRY.values()].find((descriptor) => descriptor.ledger.positions.includes(position));

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The policy of the hub (the rule INTEGRATION_HUB_POLICY, code DEFAULT).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface HubPolicy {
  /** How many failed runs in a row make a connector FAILING. */
  failingAfterRuns: number;
  failingSeverity: HubSeverity;
  /** The share of monitored connectors that are STALE, in percent, from which the whole hub counts as stale. */
  hubStaleRatioPercent: number;
  /** The smallest number of monitored connectors for a hub-wide judgement (one connector is not a hub). */
  hubStaleMinConnectors: number;
  hubStaleSeverity: HubSeverity;
  /** Whether a failing or stale connector opens an incident of its own. */
  incidentAutoOpen: boolean;
  snapshotRetentionDays: number;
  /** Minutes without a heartbeat after which a collector agent counts as STALE. */
  agentStaleAfterMinutes: number;
}

/** What the rule says when nobody has approved one: our own operational choice, flagged UNVERIFIED in the rule. */
export const HUB_POLICY_DEFAULTS: HubPolicy = {
  failingAfterRuns: 1,
  failingSeverity: 'ACTION',
  hubStaleRatioPercent: 50,
  hubStaleMinConnectors: 2,
  hubStaleSeverity: 'URGENT',
  incidentAutoOpen: true,
  snapshotRetentionDays: 400,
  agentStaleAfterMinutes: 15,
};

/** The policy a rule of the governance store gives (the params object of the resolved rule); a member that is missing or malformed is 422 `VALIDATION_FAILED` naming it. */
export function hubPolicyOf(params: Readonly<Record<string, unknown>>): HubPolicy {
  const int = (name: string, min: number, max: number): number => {
    const value = params[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(name);
    return value;
  };
  const severity = (name: string): HubSeverity => {
    const value = params[name];
    if (typeof value !== 'string' || !SEVERITIES.includes(value)) throw invalid(name);
    return value as HubSeverity;
  };
  if (typeof params.incident_auto_open !== 'boolean') throw invalid('incident_auto_open');
  return {
    failingAfterRuns: int('failing_after_runs', 1, 10),
    failingSeverity: severity('failing_severity'),
    hubStaleRatioPercent: int('hub_stale_ratio_percent', 1, 100),
    hubStaleMinConnectors: int('hub_stale_min_connectors', 1, 50),
    hubStaleSeverity: severity('hub_stale_severity'),
    incidentAutoOpen: params.incident_auto_open,
    snapshotRetentionDays: int('snapshot_retention_days', 30, 3650),
    agentStaleAfterMinutes: int('agent_stale_after_minutes', 1, 10080),
  };
}

/** The params of `CONNECTOR_FRESHNESS` as the health function reads them (the same members as the rule). */
export interface HubFreshnessParams {
  maxAgeHours: number;
  warnAfterHours: number;
  staleSeverity: HubSeverity;
  figuresBlockedWhenStale: boolean;
}

/** The freshness a rule of the governance store gives (`max_age_hours`, `warn_after_hours`, `stale_severity`, `figures_blocked_when_stale`). */
export function hubFreshnessOf(params: Readonly<Record<string, unknown>>): HubFreshnessParams {
  const hours = (name: string): number => {
    const value = params[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8760) throw invalid(name);
    return value;
  };
  const severity = params.stale_severity;
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) throw invalid('stale_severity');
  if (typeof params.figures_blocked_when_stale !== 'boolean') throw invalid('figures_blocked_when_stale');
  return { maxAgeHours: hours('max_age_hours'), warnAfterHours: hours('warn_after_hours'), staleSeverity: severity as HubSeverity, figuresBlockedWhenStale: params.figures_blocked_when_stale };
}

/** The params object of the freshness rule for a descriptor (what a lane passes to `registerRuleDefaults('CONNECTOR_FRESHNESS', { [ruleCode]: ... })`). */
export function connectorFreshnessParams(freshness: ConnectorFreshness): Record<string, unknown> {
  return {
    max_age_hours: freshness.defaults.maxAgeHours,
    warn_after_hours: freshness.defaults.warnAfterHours,
    stale_severity: freshness.defaults.staleSeverity,
    figures_blocked_when_stale: freshness.defaults.figuresBlockedWhenStale,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Health.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const RUN_OUTCOMES = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'RUNNING', 'SKIPPED'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const RUN_KINDS = ['IMPORT', 'PULL', 'PUSH', 'GENERATE', 'READ', 'CHECK'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** A run that moved data (a file applied, even with rows set aside) counts as a success for the age of the data; one that failed does not; a run that is still going or was skipped is neither. */
export const isSuccessfulRun = (outcome: RunOutcome): boolean => outcome === 'SUCCEEDED' || outcome === 'PARTIAL';

export interface HubHealthInput {
  descriptor: Pick<ConnectorDescriptor, 'freshness' | 'layouts'>;
  /** The switch: the connector's own when it owns it, the hub's otherwise. */
  enabled: boolean;
  /** The time of the newest successful run (SUCCEEDED or PARTIAL), or null when there has been none. */
  lastSuccessAt: Date | null;
  /** The newest run of any outcome. */
  lastRun: { outcome: RunOutcome; at: Date } | null;
  /** Failed runs since the last run that was not failed (0 when the newest run did not fail). */
  consecutiveFailures: number;
  now: Date;
  /** The freshness rule in force for the descriptor's rule code; null when the connector's age is not judged. */
  freshness: HubFreshnessParams | null;
  policy: Pick<HubPolicy, 'failingAfterRuns' | 'failingSeverity'>;
}

export interface HubAlert {
  code: string;
  severity: HubSeverity;
}

export interface ConnectorHealth {
  status: HubHealthStatus;
  freshness: HubFreshnessBand;
  /** Hours since the last successful run, or null when none. */
  ageHours: number | null;
  acceptance: LayoutAcceptance;
  alert: HubAlert | null;
  /** The figures that rest on this connector are shown as not up to date (the rule says so and the connector is stale). */
  figuresBlocked: boolean;
  consecutiveFailures: number;
}

/**
 * Formula (the "i" of the status): in this order, DISABLED when the switch is off; FAILING when the last `failing_after_runs` runs failed in a row (alert CONNECTOR_FAILING at `failing_severity`); with no successful
 * run yet, PENDING_EXTERNAL when the layouts wait for the other side and nothing has run, else NEVER_RUN; otherwise by the age of the last successful run against the rule CONNECTOR_FRESHNESS of the connector: STALE
 * beyond `max_age_hours` (alert CONNECTOR_STALE at `stale_severity`), HEALTHY otherwise (with the band AGING past `warn_after_hours`). A connector whose age is not judged is HEALTHY once it has a success.
 * The acceptance of the layouts is carried beside the status and never changes it: data that rests on a working assumption is HEALTHY and says PENDING_EXTERNAL next to it.
 */
export function connectorHealth(input: HubHealthInput): ConnectorHealth {
  const acceptance = connectorAcceptance(input.descriptor);
  const base = { acceptance, consecutiveFailures: input.consecutiveFailures };
  const age = input.lastSuccessAt === null ? null : Math.round((Math.max(0, input.now.getTime() - input.lastSuccessAt.getTime()) / 3_600_000) * 10) / 10;
  const band = (): HubFreshnessBand => {
    if (age === null || input.freshness === null) return 'UNKNOWN';
    return age <= input.freshness.warnAfterHours ? 'FRESH' : age <= input.freshness.maxAgeHours ? 'AGING' : 'STALE';
  };
  if (!input.enabled) return { ...base, status: 'DISABLED', freshness: band(), ageHours: age, alert: null, figuresBlocked: false };
  if (input.consecutiveFailures >= input.policy.failingAfterRuns) {
    return { ...base, status: 'FAILING', freshness: band(), ageHours: age, alert: { code: HUB_ALERT_FAILING, severity: input.policy.failingSeverity }, figuresBlocked: false };
  }
  if (input.lastSuccessAt === null) {
    const waiting = acceptance === 'PENDING_EXTERNAL' && input.lastRun === null;
    return { ...base, status: waiting ? 'PENDING_EXTERNAL' : 'NEVER_RUN', freshness: 'UNKNOWN', ageHours: null, alert: null, figuresBlocked: false };
  }
  const found = band();
  if (found === 'STALE' && input.freshness !== null) {
    return { ...base, status: 'STALE', freshness: found, ageHours: age, alert: { code: HUB_ALERT_STALE, severity: input.freshness.staleSeverity }, figuresBlocked: input.freshness.figuresBlockedWhenStale };
  }
  return { ...base, status: 'HEALTHY', freshness: found, ageHours: age, alert: null, figuresBlocked: false };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The summary of the hub (the KPI set).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface HubConnectorFact {
  code: string;
  health: ConnectorHealth;
  failedRuns7d: number;
  /** Open differences left by the connector's files (file_import_reconciliation_item with status OPEN). */
  discrepancyBacklog: number;
  /** Mappings proposed by the connector and not yet decided (crosswalk status PROPOSED). */
  pendingMappings: number;
}

export interface HubSummary {
  total: number;
  /** Enabled connectors that have run at least once and are not waiting for the other side: the denominator of the healthy share. */
  monitored: number;
  healthy: number;
  counts: Record<HubHealthStatus, number>;
  /** healthy / monitored in percent, one decimal; null when nothing is monitored (no figure is better than a false 100). */
  healthyPercent: number | null;
  /** The oldest age in hours among enabled connectors that have had a success; null when none has. */
  oldestDataAgeHours: number | null;
  oldestDataConnector: string | null;
  failedRuns7d: number;
  discrepancyBacklog: number;
  pendingMappings: number;
  /** CONNECTOR_HUB_STALE when the share of STALE connectors among those monitored reaches the policy. */
  hubAlert: HubAlert | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Formula of each figure: see the KPI definitions `HUB_*` (kernel `connector-hub-defaults.ts`); this is the one place that computes them. */
export function summarizeHub(facts: readonly HubConnectorFact[], policy: Pick<HubPolicy, 'hubStaleRatioPercent' | 'hubStaleMinConnectors' | 'hubStaleSeverity'>): HubSummary {
  const counts = Object.fromEntries(HUB_HEALTH_STATUSES.map((status) => [status, 0])) as Record<HubHealthStatus, number>;
  let oldest: { hours: number; code: string } | null = null;
  let failed = 0;
  let backlog = 0;
  let pending = 0;
  for (const fact of facts) {
    counts[fact.health.status] += 1;
    failed += fact.failedRuns7d;
    backlog += fact.discrepancyBacklog;
    pending += fact.pendingMappings;
    if (fact.health.status !== 'DISABLED' && fact.health.ageHours !== null && (oldest === null || fact.health.ageHours > oldest.hours)) oldest = { hours: fact.health.ageHours, code: fact.code };
  }
  // A connector nobody has used yet is neither fine nor a fault (HUB-2): it is left out of the healthy share like one that waits for the other side or is switched off.
  const monitored = facts.length - counts.DISABLED - counts.PENDING_EXTERNAL - counts.NEVER_RUN;
  const stale = counts.STALE;
  const hubAlert: HubAlert | null = monitored >= policy.hubStaleMinConnectors && stale > 0 && (stale / monitored) * 100 >= policy.hubStaleRatioPercent ? { code: HUB_ALERT_HUB_STALE, severity: policy.hubStaleSeverity } : null;
  return {
    total: facts.length,
    monitored,
    healthy: counts.HEALTHY,
    counts,
    healthyPercent: monitored === 0 ? null : round1((counts.HEALTHY / monitored) * 100),
    oldestDataAgeHours: oldest === null ? null : oldest.hours,
    oldestDataConnector: oldest === null ? null : oldest.code,
    failedRuns7d: failed,
    discrepancyBacklog: backlog,
    pendingMappings: pending,
    hubAlert,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Reasons, runs, incidents, snapshots.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The reason of a decision: ten characters at least, at most 2000, no control character other than line breaks (422 `VALIDATION_FAILED` naming the field). */
export function hubReasonOf(value: unknown, field = 'reason'): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text.length < HUB_MIN_REASON || text.length > HUB_MAX_REASON || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

/** The switch of a connector: a boolean and a reason, and never a move to the state it is already in (so an event always means a change). */
export function hubStateMove(current: { enabled: boolean }, target: { enabled: unknown; reason: unknown }): { enabled: boolean; reason: string } {
  if (typeof target.enabled !== 'boolean') throw invalid('enabled');
  if (target.enabled === current.enabled) throw invalid('enabled');
  return { enabled: target.enabled, reason: hubReasonOf(target.reason) };
}

export interface HubRunRecord {
  kind: RunKind;
  outcome: RunOutcome;
  startedAt: Date;
  finishedAt: Date | null;
  layoutCode: string | null;
  layoutVersion: string | null;
  rowsTotal: number;
  rowsApplied: number;
  rowsRejected: number;
  errorCode: string | null;
  /** The reference of the thing the run was about (the sha of a file, the id of a batch): a run with a reference is recorded once. */
  sourceRef: string | null;
}

const RUN_REF = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,119}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const MAX_FUTURE_MS = 5 * 60_000;

/**
 * A run as a connector or a machine account reports it (`POST .../runs`), judged field by field (422 `VALIDATION_FAILED` naming the field). A run that ended has a finish time not before its start and not in the
 * future; a failed run names a stable error code and nothing else says why (no free text: a message can carry data of the other side); a run that did not fail names no error. Counts are whole and the parts
 * never exceed the total.
 */
export function hubRunOf(body: Readonly<Record<string, unknown>>, now: Date): HubRunRecord {
  if (!oneOf(RUN_KINDS, body.kind)) throw invalid('kind');
  if (!oneOf(RUN_OUTCOMES, body.outcome)) throw invalid('outcome');
  const moment = (value: unknown, field: string): Date => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid(field);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime() + MAX_FUTURE_MS) throw invalid(field);
    return parsed;
  };
  const startedAt = moment(body.started_at, 'started_at');
  const ended = body.outcome !== 'RUNNING';
  let finishedAt: Date | null = null;
  if (ended) {
    finishedAt = moment(body.finished_at, 'finished_at');
    if (finishedAt.getTime() < startedAt.getTime()) throw invalid('finished_at');
  } else if (body.finished_at !== undefined && body.finished_at !== null) throw invalid('finished_at');
  const count = (field: string): number => {
    const value = body[field];
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) throw invalid(field);
    return value;
  };
  const rowsTotal = count('rows_total');
  const rowsApplied = count('rows_applied');
  const rowsRejected = count('rows_rejected');
  if (rowsApplied + rowsRejected > rowsTotal) throw invalid('rows_total');
  const optionalText = (value: unknown, field: string, pattern: RegExp): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !pattern.test(value)) throw invalid(field);
    return value;
  };
  const errorCode = optionalText(body.error_code, 'error_code', ERROR_CODE);
  if ((body.outcome === 'FAILED') !== (errorCode !== null)) throw invalid('error_code');
  const layoutCode = optionalText(body.layout_code, 'layout_code', WORD);
  const layoutVersion = optionalText(body.layout_version, 'layout_version', /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
  if ((layoutCode === null) !== (layoutVersion === null)) throw invalid('layout_version');
  return { kind: body.kind, outcome: body.outcome, startedAt, finishedAt, layoutCode, layoutVersion, rowsTotal, rowsApplied, rowsRejected, errorCode, sourceRef: optionalText(body.source_ref, 'source_ref', RUN_REF) };
}

/** A run must name a layout the descriptor declares, under a version it declares (422 `VALIDATION_FAILED`, `layout_version`): a run under an unknown layout is evidence of a file nobody reviewed. */
export function assertRunLayoutKnown(descriptor: Pick<ConnectorDescriptor, 'layouts'>, run: Pick<HubRunRecord, 'layoutCode' | 'layoutVersion'>): void {
  if (run.layoutCode === null) return;
  if (!descriptor.layouts.some((layout) => layout.code === run.layoutCode && layout.version === run.layoutVersion)) throw invalid('layout_version');
}

export const INCIDENT_KINDS = ['FAILING', 'STALE', 'HUB_STALE', 'MANUAL'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const INCIDENT_STATES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];
export const INCIDENT_ACTIONS = ['OPENED', 'ACKNOWLEDGED', 'NOTED', 'RESOLVED', 'AUTO_RESOLVED'] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

/** The incident kind that an alert of the hub stands for. */
export function incidentKindOfAlert(alert: HubAlert | null): IncidentKind | null {
  if (alert === null) return null;
  if (alert.code === HUB_ALERT_FAILING) return 'FAILING';
  if (alert.code === HUB_ALERT_STALE) return 'STALE';
  if (alert.code === HUB_ALERT_HUB_STALE) return 'HUB_STALE';
  return null;
}

export type IncidentMove = 'ACKNOWLEDGE' | 'RESOLVE';

const INCIDENT_EDGES: Readonly<Record<IncidentMove, { from: readonly IncidentState[]; to: IncidentState; action: IncidentAction }>> = {
  ACKNOWLEDGE: { from: ['OPEN'], to: 'ACKNOWLEDGED', action: 'ACKNOWLEDGED' },
  RESOLVE: { from: ['OPEN', 'ACKNOWLEDGED'], to: 'RESOLVED', action: 'RESOLVED' },
};

/**
 * One step of an incident. An incident not in a state the move starts from is 409 `HUB_INCIDENT_STATE_INVALID` (a stale screen sees the conflict first); both moves need a reason, so the log says why. The person who
 * opened a manual incident may resolve it (nobody else may have seen it); a machine-opened incident has no opener.
 */
export function incidentMove(incident: { state: IncidentState }, step: { move: IncidentMove; reason: unknown }): { to: IncidentState; action: IncidentAction; reason: string } {
  const edge = INCIDENT_EDGES[step.move];
  if (edge === undefined) throw invalid('move');
  if (!edge.from.includes(incident.state)) throw new DomainError('HUB_INCIDENT_STATE_INVALID', 409, 'state');
  return { to: edge.to, action: edge.action, reason: hubReasonOf(step.reason) };
}

/** A manual incident: the connector and a short text of what the person saw, 10 to 2000 characters. */
export function manualIncidentOf(body: Readonly<Record<string, unknown>>): { severity: HubSeverity; summary: string } {
  const severity = body.severity === undefined ? 'ACTION' : body.severity;
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) throw invalid('severity');
  return { severity: severity as HubSeverity, summary: hubReasonOf(body.summary, 'summary') };
}

/** The hour a snapshot belongs to (UTC, to the hour): one snapshot per scope and hour, so a repeated sweep inside the hour finds the one taken. */
export const snapshotBucketOf = (at: Date): string => `${at.toISOString().slice(0, 13)}:00:00Z`;

export interface HubTrendPoint {
  at: string;
  status: HubHealthStatus;
  ageHours: number | null;
  failedRuns7d: number;
}

/** The consecutive failures at the head of a newest-first list of outcomes (0 when the newest run did not fail; RUNNING and SKIPPED runs are skipped over, they say nothing). */
export function consecutiveFailuresOf(outcomesNewestFirst: readonly RunOutcome[]): number {
  let count = 0;
  for (const outcome of outcomesNewestFirst) {
    if (outcome === 'RUNNING' || outcome === 'SKIPPED') continue;
    if (outcome !== 'FAILED') break;
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Collector agents (owner clarification 2026-11-08: collectors may run on ARM hardware and any operating system).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const AGENT_OS = ['linux', 'windows', 'darwin', 'freebsd', 'other'] as const;
export type AgentOs = (typeof AGENT_OS)[number];
export const AGENT_ARCHITECTURES = ['amd64', 'arm64', 'arm', '386', 'riscv64', 'ppc64le', 's390x', 'other'] as const;
export type AgentArchitecture = (typeof AGENT_ARCHITECTURES)[number];
export const AGENT_HEALTH = ['ONLINE', 'STALE', 'NEVER_SEEN', 'RETIRED'] as const;
export type AgentHealth = (typeof AGENT_HEALTH)[number];

export interface AgentRegistration {
  agentCode: string;
  os: AgentOs;
  cpuArch: AgentArchitecture;
  agentVersion: string;
  connectors: string[];
}

const AGENT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

/** The registration of an agent as asked (422 VALIDATION_FAILED naming the field): a code, the platform (os and cpu_arch, so linux/arm64 and windows/amd64 are both plain data), a version and the connectors it serves. */
export function agentRegistrationOf(body: Readonly<Record<string, unknown>>): AgentRegistration {
  const agentCode = body.agent_code;
  if (typeof agentCode !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,59}$/.test(agentCode)) throw invalid('agent_code');
  if (!oneOf(AGENT_OS, body.os)) throw invalid('os');
  if (!oneOf(AGENT_ARCHITECTURES, body.cpu_arch)) throw invalid('cpu_arch');
  if (typeof body.agent_version !== 'string' || !AGENT_VERSION.test(body.agent_version)) throw invalid('agent_version');
  const connectors = body.connectors;
  if (!Array.isArray(connectors) || connectors.length === 0 || connectors.length > 20 || new Set(connectors).size !== connectors.length || !connectors.every((code) => typeof code === 'string' && CODE.test(code))) throw invalid('connectors');
  return { agentCode, os: body.os, cpuArch: body.cpu_arch, agentVersion: body.agent_version, connectors: connectors as string[] };
}

/** A heartbeat: the version the agent runs now and the depth of its spool (records waiting on the agent to be handed over). */
export function agentHeartbeatOf(body: Readonly<Record<string, unknown>>): { agentVersion: string; spoolDepth: number } {
  if (typeof body.agent_version !== 'string' || !AGENT_VERSION.test(body.agent_version)) throw invalid('agent_version');
  const depth = body.spool_depth;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > 1_000_000_000) throw invalid('spool_depth');
  return { agentVersion: body.agent_version, spoolDepth: depth };
}

/** The health of an agent: RETIRED when retired; NEVER_SEEN before the first heartbeat; STALE when the last heartbeat is older than the policy; ONLINE otherwise. */
export function agentHealthOf(input: { state: 'ACTIVE' | 'RETIRED'; lastHeartbeatAt: Date | null; now: Date; staleAfterMinutes: number }): AgentHealth {
  if (input.state === 'RETIRED') return 'RETIRED';
  if (input.lastHeartbeatAt === null) return 'NEVER_SEEN';
  return input.now.getTime() - input.lastHeartbeatAt.getTime() > input.staleAfterMinutes * 60_000 ? 'STALE' : 'ONLINE';
}
