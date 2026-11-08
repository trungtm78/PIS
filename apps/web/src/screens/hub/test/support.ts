import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import type { WebRoute } from '../../../routes/types';

export { mount } from '../../bid/test-support';
export type { Harness };
export { harness };

export const ALL = ['hub.read', 'hub.state.manage', 'hub.incident.manage', 'hub.mapping.propose', 'hub.mapping.approve', 'hub.reject.manage', 'hub.snapshot.capture'];

export const routeOf = (id: string, req: string): WebRoute => ({ id, path: `/hub/${id.toLowerCase()}`, title: id, kind: 'table', area: 'data', module: 'HUB', group: 'Kết nối', role: 'workspace', parent: null, req });

export const AS_OF = '2026-11-08T03:00:00.000Z';
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const never = (): Promise<never> => new Promise<never>(() => undefined);

export const connector = (over: Record<string, unknown> = {}) => ({
  code: 'treasury.statement',
  name: 'State Treasury statement file',
  direction: 'INBOUND',
  protocols: ['FILE_DROP'],
  planned_protocols: [],
  acceptance: 'PENDING_EXTERNAL',
  status: 'HEALTHY',
  freshness: 'FRESH',
  age_hours: 10,
  enabled: true,
  last_success_at: '2026-11-07T17:00:00.000Z',
  last_run_at: '2026-11-07T17:00:00.000Z',
  last_run_outcome: 'SUCCEEDED',
  alert: null,
  figures_blocked: false,
  failed_runs_7d: 0,
  discrepancy_backlog: 2,
  pending_mappings: 0,
  consumers: ['PAY'],
  owner_role: 'INTEGRATION_ADMINISTRATOR',
  egress_policy: 'NONE',
  screens: [{ code: 'PAY-13', route: '/pay/pay-13' }],
  registry: {
    transports: ['FILE'],
    layouts: [{ code: 'STATEMENT', version: 'ASSUMED-2026.1', acceptance: 'PENDING_EXTERNAL' }],
    freshness_rule: 'TREASURY_STATEMENT',
    max_age_hours: 72,
    warn_after_hours: 36,
    rule_source: 'DEFAULT',
    credential_kind: 'NONE',
    scopes: [],
    alert_types: ['CONNECTOR_FAILING', 'CONNECTOR_STALE', 'TREASURY_RECON_ITEM_OVERDUE'],
    state_owner: 'HUB',
    history: 'FILE_FRAMEWORK',
  },
  ...over,
});

export const waiting = () => connector({ code: 'egp.muasamcong', name: 'National e-procurement network', status: 'PENDING_EXTERNAL', age_hours: null, last_success_at: null, last_run_at: null, last_run_outcome: null, discrepancy_backlog: 0, screens: [{ code: 'BID-22', route: '/bid/bid-22' }] });
export const failing = () => connector({ code: 'procurement.milestones', name: 'Procurement milestone file', status: 'FAILING', alert: { code: 'CONNECTOR_FAILING', severity: 'ACTION' }, last_run_outcome: 'FAILED', failed_runs_7d: 2 });

export const summary = (over: Record<string, unknown> = {}) => ({
  total: 3,
  monitored: 2,
  healthy: 1,
  counts: { HEALTHY: 1, STALE: 0, FAILING: 1, DISABLED: 0, PENDING_EXTERNAL: 1, NEVER_RUN: 0 },
  healthy_percent: 50,
  oldest_data_age_hours: 10,
  oldest_data_connector: 'treasury.statement',
  failed_runs_7d: 2,
  discrepancy_backlog: 2,
  pending_mappings: 0,
  hub_alert: null,
  ...over,
});

export const list = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, summary: summary(), as_of: AS_OF, ...over });

const kpi = (code: string, name: string, over: Record<string, unknown> = {}) => ({
  code,
  name,
  formula: `Formula of ${name}`,
  numerator: null,
  denominator: null,
  exclusions: [],
  source: 'Hub run history',
  owner: 'INTEGRATION_ADMINISTRATOR',
  unit: 'COUNT',
  decimals: 0,
  value: 1,
  as_of: AS_OF,
  unverified: true,
  rule_version: 0,
  ...over,
});

export const health = () => ({
  summary: summary(),
  kpis: [
    kpi('HUB_CONNECTORS_HEALTHY_PCT', 'Healthy share', { numerator: 'Healthy connectors', denominator: 'Monitored connectors', exclusions: ['Disabled'] }),
    kpi('HUB_OLDEST_DATA_AGE_DAYS', 'Oldest data'),
    kpi('HUB_FAILED_RUNS_7D', 'Failed runs'),
    kpi('HUB_DISCREPANCY_BACKLOG', 'Differences'),
    kpi('HUB_PENDING_MAPPINGS', 'Mappings'),
  ],
  trend: [],
  policy: { failing_after_runs: 1, failing_severity: 'ACTION', hub_stale_ratio_percent: 50, hub_stale_min_connectors: 2, hub_stale_severity: 'URGENT', incident_auto_open: true, snapshot_retention_days: 400, agent_stale_after_minutes: 15, source: 'DEFAULT', unverified: true },
  as_of: AS_OF,
});

export const run = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  origin: 'FILE_IMPORT',
  kind: 'IMPORT',
  outcome: 'SUCCEEDED',
  started_at: '2026-11-07T17:00:00.000Z',
  finished_at: '2026-11-07T17:01:00.000Z',
  layout_version: 'ASSUMED-2026.1',
  position: 'TREASURY_STATEMENT_FILE',
  pipeline_code: null,
  rows_total: 10,
  rows_applied: 9,
  rows_rejected: 1,
  error_code: null,
  source_ref: null,
  dry_run: false,
  stage_counts: null,
  ...over,
});

export const mapping = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  pipeline_code: 'STATEMENT',
  mapping_version: 'M1',
  fields: [{ source: 'code', target: 'project_code', required: true, transform: { kind: 'UPPER' } }],
  state: 'PROPOSED',
  proposed_by: uuid(801),
  proposed_at: '2026-11-07T01:00:00.000Z',
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  version: 1,
  ...over,
});

export const reject = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  pipeline_code: 'STATEMENT',
  run_id: uuid(700),
  stage: 'VALIDATE',
  reject_code: 'CODE_REQUIRED',
  field: 'code',
  source_ref: 'f.csv#3',
  record_key: 'REC-3',
  line: 3,
  record: { code: '' },
  state: 'OPEN',
  resolved_by: null,
  resolved_at: null,
  resolution: null,
  version: 1,
  created_at: '2026-11-07T17:00:00.000Z',
  ...over,
});

export const agent = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  agent_code: 'collector-hn-01',
  os: 'linux',
  cpu_arch: 'arm64',
  platform: 'linux/arm64',
  agent_version: '1.4.2',
  connectors: ['treasury.statement'],
  spool_depth: 7,
  last_heartbeat_at: '2026-11-08T02:55:00.000Z',
  state: 'ACTIVE',
  health: 'ONLINE',
  version: 2,
  ...over,
});

export const detail = (over: Record<string, unknown> = {}) => ({
  summary: connector(),
  state: { enabled: true, version: 1, reason: null, changed_at: null, owner: 'HUB' },
  layouts: [{ code: 'STATEMENT', version: 'ASSUMED-2026.1', acceptance: 'PENDING_EXTERNAL', pending: ['SAMPLE_STATEMENT'] }],
  freshness_rule: { rule_code: 'TREASURY_STATEMENT', source: 'DEFAULT', version: 0, unverified: true, formula: 'Statement older than 36 hours warns', source_text: 'Starting value', as_of: '2026-11-08', max_age_hours: 72, warn_after_hours: 36, stale_severity: 'ACTION', figures_blocked_when_stale: true },
  protocol_details: [
    { code: 'FILE_DROP', name: 'Drop folder', status: 'ACTIVE', egress: 'NONE', auth: ['NONE'], tls: 'NOT_APPLICABLE', signature: 'OPTIONAL', implementation: 'END_TO_END', retry: 'REDELIVERY_BY_SENDER', delivery: 'EXACTLY_ONCE_BY_KEY', formats: ['CSV'] },
    { code: 'SFTP', name: 'SFTP', status: 'PLANNED', egress: 'ALLOWLISTED_HOST', auth: ['SSH_KEY'], tls: 'NOT_APPLICABLE', signature: 'OPTIONAL', implementation: 'PORT_ONLY', retry: 'BACKOFF', delivery: 'AT_LEAST_ONCE', formats: ['CSV'] },
  ],
  credentials: { kind: 'NONE', scopes: [], secret_store: 'VAULT' },
  egress: { policy: 'NONE', hosts: [], reason: null },
  alert_types: [
    { code: 'CONNECTOR_FAILING', owner: 'INTEGRATION_ADMINISTRATOR', expected_action: 'Open the connector and read the last failed run', consequence: 'Figures stop at the last successful run', response_hours: 24, default_severity: 'ACTION' },
    { code: 'CONNECTOR_STALE', owner: 'INTEGRATION_ADMINISTRATOR', expected_action: 'Fetch the latest file', consequence: 'Figures are older than allowed', response_hours: 24, default_severity: 'ACTION' },
  ],
  pipelines: [
    {
      code: 'STATEMENT',
      name: 'STATEMENT file',
      protocol: 'FILE_DROP',
      mode: 'INCREMENTAL',
      layout_code: 'STATEMENT',
      layout_version: 'ASSUMED-2026.1',
      target: 'file-import.apply',
      stages: ['EXTRACT', 'VALIDATE', 'TRANSFORM', 'LOAD'],
      schedule: { kind: 'MANUAL', hours: null, at: null, working_days_only: false, backfill_window_days: 31, max_concurrency: 1, rate_per_minute: 60, next_run_at: null },
      watermark: '2026-11.csv',
      approved_mapping_version: null,
      pending_mapping_proposals: 1,
      open_rejects: 1,
      last_run: run(5, { origin: 'HUB', pipeline_code: 'STATEMENT' }),
    },
  ],
  mappings: [mapping(60)],
  agents: [],
  state_events: [],
  trend: [],
  open_incidents: 1,
  as_of: AS_OF,
  ...over,
});

export const incident = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  connector_code: 'procurement.milestones',
  kind: 'FAILING',
  severity: 'ACTION',
  state: 'OPEN',
  summary: null,
  opened_by: null,
  opened_at: '2026-11-08T01:00:00.000Z',
  acknowledged_by: null,
  acknowledged_at: null,
  resolved_by: null,
  resolved_at: null,
  resolution: null,
  version: 1,
  alert: { code: 'CONNECTOR_FAILING', owner: 'INTEGRATION_ADMINISTRATOR', expected_action: 'Fix the cause and run again', consequence: 'Figures stop at the last successful run', response_hours: 24, default_severity: 'ACTION' },
  ...over,
});

export const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, next_cursor: null, as_of: AS_OF, ...over });
