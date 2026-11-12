import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { clipPlan } from './plan.ts';
import TEXTS from '../data/enterprise-bi2.json' with { type: 'json' };

/**
 * Group `clip-ent-bi2`: the BI screens of the enterprise edition that `clip-ent-bi` leaves empty, made with the real commands only (BI-01..30).
 *
 * What it does, in order: it opens the two datasets (DS-DISB, DS-CTR) to the three people of the board by access policies (drafted by the owner, decided by the leader: a policy asks a second person),
 * certifies the datasets (confirmed by the officer, certified by the leader), registers a second commit of metrics (BI-15) and drafts the metrics of the company (`t_` metrics), makes more dashboards
 * (published, pending, rejected: BI-11), shares them to named people, opens every dashboard through the API as the people (the query log, BI-13), asks for exports and export schedules (BI-12, BI-16),
 * and writes the decision log (BI-22) and the notes and complaints on the ranking (BI-26).
 *
 * What it cannot fill: the screens that divide by the plan assigned by the Prime Minister (BI-21 outlook, BI-25 rate, BI-29 heat map) or replay weeks of early-warning scores (BI-30): the enterprise snapshots
 * carry no such plan (`plan_pm_assigned_vnd` is 0) and one unit holds all projects; the screens say so by themselves.
 *
 * Idempotent: every object is looked up first (by code, by grantee, by text) and a second run changes nothing. It makes no assumption on the clock of the stack.
 */

const OWNER = 'owner';
const MAKER = 'projectManager';
const LEADER = 'capApprover';
const T = TEXTS as unknown as Record<string, string>;

function text(key: string, values: Record<string, string> = {}): string {
  const found = T[key];
  if (typeof found !== 'string') throw new Error(`the text ${key} is not in enterprise-bi2.json`);
  return found.replace(/\{(\w+)\}/gu, (_marker, name: string) => values[name] ?? '');
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

// ---- access policies and certification -------------------------------------------------------------------------------------------------------

/** Opens a dataset to a person: the owner drafts the policy, asks for it, the leader decides it. */
async function openDataset(ctx: SeedContext, datasetId: string, person: string): Promise<void> {
  const membershipId = ctx.person(person).membershipId;
  const policies = await ctx.list<Obj>(OWNER, '/bi/access-policies', { dataset_id: datasetId });
  const mine = policies.filter((row) => row.grantee_ref_id === membershipId);
  if (mine.some((row) => row.status === 'ACTIVE')) return;
  let policyId: string;
  const draft = mine.find((row) => row.status === 'DRAFT');
  if (draft !== undefined) policyId = String(draft.id);
  else policyId = (await ctx.command(OWNER, '/bi/access-policies', { dataset_id: datasetId, grantee_kind: 'MEMBERSHIP', grantee_ref_id: membershipId, row_predicate_ast: { op: 'unit_in_scope' }, column_masks: {} })).resource_id;
  const pending = (await ctx.list<Obj>(LEADER, '/bi/publication-requests', { status: 'PENDING', object_kind: 'ACCESS_POLICY' })).find((row) => row.object_id === policyId);
  let requestId: string;
  let requestVersion: number;
  if (pending !== undefined) {
    requestId = String(pending.id);
    requestVersion = Number(pending.version ?? 1);
  } else {
    const asked = await ctx.attempt<CommandReply>(OWNER, 'POST', '/bi/publication-requests', { object_kind: 'ACCESS_POLICY', object_id: policyId });
    if (!asked.ok) return;
    requestId = asked.json.resource_id;
    requestVersion = asked.json.resource_version;
  }
  await ctx.attempt(LEADER, 'POST', `/bi/publication-requests/${requestId}/decision`, { decision: 'APPROVED', comment: text('policy.comment', { name: ctx.nameOf(person) }) }, { version: requestVersion });
}

/** Moves a dataset to CERTIFIED: the officer confirms (the owner), the leader certifies (a second pair of eyes). */
async function certifyDataset(ctx: SeedContext, dataset: Obj): Promise<void> {
  const key = String(dataset.id);
  const read = await ctx.call<Obj>(OWNER, 'GET', '/bi/certifications');
  const rows = [...(((read.json.datasets as Obj[] | undefined) ?? []) as Obj[]), ...(((read.json.items as Obj[] | undefined) ?? []) as Obj[])];
  const current = rows.find((row) => row.key === key || row.id === key || row.dataset_id === key);
  const status = asText(current?.status);
  const version = Number(dataset.version ?? 1);
  if (status === 'CERTIFIED') return;
  if (status !== 'CONFIRMED') await ctx.attempt(OWNER, 'POST', '/bi/certifications/transitions', { subject: 'DATASET', key, version, to: 'CONFIRMED', note: text('certify.note') });
  await ctx.attempt(LEADER, 'POST', '/bi/certifications/transitions', { subject: 'DATASET', key, version, to: 'CERTIFIED', note: text('certify.note') });
}

// ---- metrics ---------------------------------------------------------------------------------------------------------------------------------

type BundleBuilder = (directory: string) => Promise<{ ok: boolean; bytes?: Buffer; problems?: string[] }>;

/** The bundle of the repository plus the metrics of the company (a second commit): the registry keeps each metric under the commit that brought it. */
async function registerSecondCommit(ctx: SeedContext): Promise<void> {
  const root = join(process.cwd(), '..', '..');
  const module = (await import(pathToFileURL(join(root, 'scripts', 'bi-metrics-bundle.mjs')).href)) as { buildBundle: BundleBuilder };
  const built = await module.buildBundle(join(root, 'metrics'));
  if (!built.ok || built.bytes === undefined) {
    ctx.warn(`the metric files are not valid: ${(built.problems ?? []).join('; ')}`);
    return;
  }
  const bundle = JSON.parse(built.bytes.toString('utf8')) as { version: unknown; metrics: Obj[] };
  const dimensions = ['unit', 'project', 'fund_source', 'investor', 'contractor', 'contract_status', 'contract_type'];
  const field = (name: string): Obj => ({ op: 'sum', args: [{ op: 'field', name }] });
  const effectiveFrom = String(bundle.metrics[0]?.effective_from ?? ctx.day(-2));
  const extra: Obj[] = [
    { code: 'ctr_active_to_original', grain: 'contract', aggregation_type: 'ratio', numerator: field('ACTIVE_VALUE'), denominator: field('ORIGINAL_VALUE'), unit: 'percent', null_policy: 'NULL_NOT_ZERO', dimensions, effective_from: effectiveFrom },
    { code: 'ctr_original_value', grain: 'contract', aggregation_type: 'semi_additive', expression: field('ORIGINAL_VALUE'), unit: 'VND', null_policy: 'NULL_NOT_ZERO', dimensions, effective_from: effectiveFrom },
  ];
  const known = new Set(bundle.metrics.map((metric) => metric.code));
  const merged = { ...bundle, metrics: [...bundle.metrics, ...extra.filter((metric) => !known.has(metric.code))].sort((a, b) => String(a.code).localeCompare(String(b.code))) };
  const done = await ctx.attempt<Obj>(OWNER, 'POST', '/bi/metric-registry-syncs', { source_commit: text('registry.commit'), bundle: merged });
  if (done.ok) ctx.log(`  [bi2] registry ${asText(done.json.status)} added ${String(done.json.added)} revised ${String(done.json.revised)}`);
}

/** Ids of the certified metrics by code. */
async function certifiedMetrics(ctx: SeedContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const row of await ctx.list<Obj>(OWNER, '/resources/metric_definition')) if (row.status === 'CERTIFIED' && typeof row.code === 'string') out.set(row.code, String(row.id));
  return out;
}

interface TenantMetric {
  code: string;
  aggregation: 'additive' | 'distinct' | 'ratio';
  /** The measure: a field summed (additive), a field counted apart (distinct) or the numerator of a ratio. */
  field: string;
  /** The denominator field of a ratio. */
  over?: string;
  unit: string;
  decide: 'APPROVED' | 'PENDING';
}

/**
 * The metrics the company drafts itself, over the disbursement dataset DS-DISB: the board of the certified metrics (BI-02) asks every certified metric of the stack over the latest snapshot of DS-DISB only, so a company
 * metric that is to show a figure there must read that dataset. Two are decided (certified through BI-11), one is left waiting for the leader (its denominator is the plan, which the enterprise snapshots do not carry).
 */
async function tenantMetrics(ctx: SeedContext, datasetId: string): Promise<void> {
  const specs: TenantMetric[] = [
    { code: 't_dpm_disbursed_treasury', aggregation: 'additive', field: 'GIAI_NGAN', unit: 'VND', decide: 'APPROVED' },
    { code: 't_dpm_project_count', aggregation: 'distinct', field: 'DU_AN', unit: 'count', decide: 'APPROVED' },
    { code: 't_dpm_disbursed_to_total_plan', aggregation: 'ratio', field: 'GIAI_NGAN', over: 'KE_HOACH_TONG', unit: 'percent', decide: 'PENDING' },
  ];
  const all = await ctx.list<Obj>(OWNER, '/resources/metric_definition');
  const dimensions = ['unit', 'project', 'fund_source'];
  const sum = (name: string): Obj => ({ op: 'sum', args: [{ op: 'field', name }] });
  const denominatorOf = (spec: TenantMetric): Obj => sum(spec.over ?? '');
  for (const spec of specs) {
    let metric = all.find((row) => row.code === spec.code);
    if (metric === undefined) {
      const expression: Obj = spec.aggregation === 'distinct' ? { op: 'count_distinct', args: [{ op: 'field', name: spec.field }] } : spec.aggregation === 'ratio' ? { op: 'div', args: [sum(spec.field), denominatorOf(spec)] } : sum(spec.field);
      const made = await ctx.attempt<CommandReply>(MAKER, 'POST', '/bi/metric-definitions', {
        code: spec.code,
        grain: 'project',
        aggregation_type: spec.aggregation,
        expression_ast: expression,
        ...(spec.aggregation === 'ratio' ? { numerator_ast: sum(spec.field), denominator_ast: denominatorOf(spec) } : {}),
        unit: spec.unit,
        null_policy: spec.aggregation === 'distinct' ? 'ZERO_IF_NO_ROWS' : 'NULL_NOT_ZERO',
        dimension_codes: dimensions,
        dataset_id: datasetId,
        effective_from: ctx.day(-1),
      });
      if (!made.ok) continue;
      metric = { id: made.json.resource_id, status: 'DRAFT' };
    }
    if (metric.status !== 'DRAFT') continue;
    const requests = await ctx.list<Obj>(LEADER, '/bi/publication-requests', { object_kind: 'METRIC' });
    if (requests.some((row) => row.object_id === metric.id)) continue;
    const asked = await ctx.attempt<CommandReply>(MAKER, 'POST', '/bi/publication-requests', { object_kind: 'METRIC', object_id: String(metric.id) });
    if (asked.ok && spec.decide === 'APPROVED') await ctx.attempt(LEADER, 'POST', `/bi/publication-requests/${asked.json.resource_id}/decision`, { decision: 'APPROVED', comment: text('metric.approve') }, { version: asked.json.resource_version });
  }
}

// ---- dashboards ------------------------------------------------------------------------------------------------------------------------------

interface DashboardSpec {
  code: string;
  title: string;
  metrics: string[];
  dimension: string;
  fate: 'PUBLISH' | 'PENDING' | 'REJECT';
}

const DASHBOARDS: DashboardSpec[] = [
  { code: 'BD-TAM-UNG-BAO-LANH', title: text('dash.advance.title'), metrics: ['ctr_advance_outstanding', 'ctr_advance_outstanding_ratio', 'ctr_advance_recovered_ratio', 'ctr_retention_held', 'ctr_guarantee_coverage'], dimension: 'project', fate: 'PUBLISH' },
  { code: 'BD-NHA-THAU', title: text('dash.contractor.title'), metrics: ['ctr_hhi', 'ctr_top5_share', 'ctr_single_bidder_rate', 'ctr_bid_price_variance'], dimension: 'contractor', fate: 'PUBLISH' },
  { code: 'BD-THANH-TOAN-DU-AN', title: text('dash.payment.title'), metrics: ['ctr_paid_value', 'ctr_accepted_value', 'ctr_paid_to_accepted', 'ctr_accepted_to_requested'], dimension: 'project', fate: 'PENDING' },
  { code: 'BD-BIEN-DONG-HOP-DONG', title: text('dash.change.title'), metrics: ['ctr_change_growth', 'ctr_portfolio_value', 'ctr_contract_count'], dimension: 'contract_status', fate: 'REJECT' },
];

async function dashboard(ctx: SeedContext, spec: DashboardSpec, metricIds: Map<string, string>): Promise<void> {
  const known = (await ctx.list<Obj>(MAKER, '/bi/dashboards')).find((row) => row.code === spec.code);
  if (known !== undefined && known.current_version !== null && known.current_version !== undefined) return;
  const ids = spec.metrics.map((code) => metricIds.get(code)).filter((id): id is string => id !== undefined);
  if (ids.length === 0) {
    ctx.warn(`the dashboard ${spec.code}: none of its metrics is certified`);
    return;
  }
  let id: string;
  let version: number;
  if (known === undefined) {
    const made = await ctx.command(MAKER, '/bi/dashboards', { code: spec.code, title: spec.title });
    id = made.resource_id;
    version = made.resource_version;
  } else {
    id = String(known.id);
    version = Number(known.version);
  }
  const saved = await ctx.attempt<CommandReply & { version_id?: string }>(
    MAKER,
    'POST',
    `/bi/dashboards/${id}/versions`,
    {
      layout_json: { widgets: ids.map((metric, index) => ({ id: `w${index + 1}`, kind: 'BAR', metric_version_id: metric, dimension_code: spec.dimension, grid: { x: (index % 2) * 6, y: Math.floor(index / 2) * 4, w: 6, h: 4 } })) },
      breakpoints: { sm: 640, md: 1024 },
      metric_versions: ids,
      filter_mappings: { period: 'bucket' },
      dataset_version_policy: 'LATEST_FROZEN',
    },
    { version },
  );
  if (!saved.ok) return;
  const asked = await ctx.attempt<CommandReply>(MAKER, 'POST', '/bi/publication-requests', { object_kind: 'DASHBOARD', object_id: String(saved.json.version_id ?? '') });
  if (!asked.ok || spec.fate === 'PENDING') return;
  const decision = spec.fate === 'PUBLISH' ? { decision: 'APPROVED', comment: text('dash.approve') } : { decision: 'REJECTED', comment: text('dash.reject') };
  await ctx.attempt(LEADER, 'POST', `/bi/publication-requests/${asked.json.resource_id}/decision`, decision, { version: asked.json.resource_version });
  ctx.record({ module: 'BI', screen: 'BI-05', kind: 'dashboard', id, code: spec.code, note: spec.title });
}

/** Every dashboard that is published or that its maker owns is shared with the named people of the company (the owner of a dashboard shares it). */
async function shareDashboards(ctx: SeedContext): Promise<void> {
  const readers = ['owner', 'capApprover', 'docHead', 'auditor', 'unitAdmin', 'treasuryMaker'];
  for (const row of await ctx.list<Obj>(MAKER, '/bi/dashboards')) {
    if (row.mine !== true || !String(row.code).startsWith('BD-')) continue;
    for (const person of readers) {
      const current = await ctx.get<Obj>(MAKER, `/bi/dashboards/${String(row.id)}`);
      const shares = Array.isArray(current.shares) ? (current.shares as Obj[]) : undefined;
      const membershipId = ctx.person(person).membershipId;
      if (shares?.some((share) => share.grantee_ref_id === membershipId || (share.grantee as Obj | undefined)?.id === membershipId) === true) continue;
      await ctx.call(MAKER, 'POST', `/bi/dashboards/${String(row.id)}/shares`, { grantee_kind: 'USER', grantee_ref_id: membershipId, permission: 'VIEW' }, { version: Number(current.version) });
    }
  }
}

// ---- the query log: dashboards opened through the API as the people -------------------------------------------------------------------------

interface Version {
  id: string;
  as_of_period: string;
}

async function latestVersions(ctx: SeedContext, datasetId: string): Promise<Version[]> {
  return (await ctx.list<Version & { status: string }>(OWNER, `/bi/datasets/${datasetId}/versions`)).filter((row) => row.status === 'FROZEN');
}

/** Opens each published dashboard as each person of the board: every widget is one query of the log. A person asks the question once a day at most (a run is a line), so a rerun adds nothing. */
async function openDashboards(ctx: SeedContext, ctrVersions: Version[], disbVersions: Version[]): Promise<void> {
  const existing = await ctx.call<Obj>(OWNER, 'GET', '/bi/query-runs', undefined, { query: { limit: 1 } });
  const logged = Array.isArray(existing.json.items) ? (existing.json.items as Obj[]).length : 0;
  if (logged > 0) {
    const runs = await ctx.list<Obj>(OWNER, '/bi/query-runs');
    if (runs.length >= 40) return;
  }
  const dashboards = (await ctx.list<Obj>(OWNER, '/bi/dashboards')).filter((row) => row.status === 'PUBLISHED' || row.current_version !== null);
  const widgetsOf = async (person: string, id: string): Promise<Array<{ metric: string; dimension: string }>> => {
    const read = await ctx.call<Obj>(person, 'GET', `/bi/dashboards/${id}`);
    const versionId = asText((read.json.current_version as Obj | undefined)?.id);
    const layout = ((read.json.current_version as Obj | undefined)?.layout_json ?? (read.json.layout_json as Obj | undefined) ?? {}) as Obj;
    const widgets = Array.isArray(layout.widgets) ? (layout.widgets as Obj[]) : [];
    if (widgets.length === 0 && versionId !== '') return [];
    return widgets.map((widget) => ({ metric: asText(widget.metric_version_id), dimension: asText(widget.dimension_code) }));
  };
  const people = [OWNER, MAKER, LEADER];
  for (const board of dashboards) {
    for (const person of people) {
      const widgets = await widgetsOf(person, String(board.id));
      for (const widget of widgets) {
        for (const version of widget.dimension === '' ? [] : [...ctrVersions.slice(0, person === OWNER ? 2 : 1)]) {
          await ctx.call(person, 'POST', '/dashboard-queries', { metric_version_id: widget.metric, snapshot_id: version.id, dimensions: [widget.dimension], filters: [] });
        }
      }
    }
  }
  // The workbench: each person reads the headline figures of the contract portfolio by the cuts the dataset offers, on the two latest periods.
  const catalogue = await certifiedMetrics(ctx);
  const headline: Array<[string, string]> = [
    ['ctr_portfolio_value', 'unit'],
    ['ctr_portfolio_value', 'contractor'],
    ['ctr_paid_value', 'project'],
    ['ctr_paid_to_accepted', 'contractor'],
    ['ctr_contract_count', 'contract_status'],
    ['ctr_guarantee_valid', 'project'],
  ];
  for (const person of [OWNER, MAKER, LEADER]) {
    for (const [code, dimension] of headline) {
      const metric = catalogue.get(code);
      if (metric === undefined) continue;
      for (const version of ctrVersions.slice(0, 2)) await ctx.call(person, 'POST', '/dashboard-queries', { metric_version_id: metric, snapshot_id: version.id, dimensions: [dimension], filters: [] });
    }
  }
  // The company metrics over the disbursement dataset, as the board of the certified metrics (BI-02) reads them.
  for (const person of [OWNER, MAKER, LEADER]) {
    for (const code of ['t_dpm_disbursed_treasury', 't_dpm_project_count']) {
      const metric = catalogue.get(code);
      if (metric === undefined) continue;
      for (const version of disbVersions.slice(0, 2)) for (const dimension of ['project', 'unit']) await ctx.call(person, 'POST', '/dashboard-queries', { metric_version_id: metric, snapshot_id: version.id, dimensions: [dimension], filters: [] });
    }
  }
  // The disbursement figures of the unit, as the leader reads them in the workbench.
  const disbursement = (await certifiedMetrics(ctx)).get('disbursement_rate');
  if (disbursement !== undefined) for (const person of people) for (const version of disbVersions.slice(0, 2)) await ctx.call(person, 'POST', '/dashboard-queries', { metric_version_id: disbursement, snapshot_id: version.id, dimensions: ['unit'], filters: [] });
}

// ---- exports and schedules -------------------------------------------------------------------------------------------------------------------

interface ExportSpec {
  metric: string;
  dimension: string;
  format: string;
  period: number;
}

interface ScheduleSpec {
  metric: string;
  dimension: string;
  cron: string;
  format: string;
  to: string[];
}

/** What each person asks for: the exports and schedules are listed for the person who made them, so the officer and the leader have their own (they hold the right to export too). */
const EXPORTS: Record<string, ExportSpec[]> = {
  [OWNER]: [
    { metric: 'ctr_paid_value', dimension: 'project', format: 'XLSX', period: 0 },
    { metric: 'ctr_paid_to_accepted', dimension: 'project', format: 'CSV', period: 0 },
    { metric: 'ctr_portfolio_value', dimension: 'contractor', format: 'XLSX', period: 0 },
    { metric: 'ctr_advance_outstanding', dimension: 'project', format: 'CSV', period: 0 },
    { metric: 'ctr_guarantee_coverage', dimension: 'project', format: 'PDF', period: 0 },
    { metric: 'ctr_paid_value', dimension: 'project', format: 'CSV', period: 1 },
    { metric: 'ctr_accepted_value', dimension: 'contract_status', format: 'CSV', period: 1 },
  ],
  [MAKER]: [
    { metric: 'ctr_paid_to_accepted', dimension: 'project', format: 'XLSX', period: 0 },
    { metric: 'ctr_advance_outstanding', dimension: 'project', format: 'CSV', period: 0 },
    { metric: 'ctr_retention_held', dimension: 'project', format: 'CSV', period: 1 },
  ],
  [LEADER]: [
    { metric: 'ctr_portfolio_value', dimension: 'contractor', format: 'PDF', period: 0 },
    { metric: 'ctr_paid_value', dimension: 'project', format: 'XLSX', period: 0 },
    { metric: 'ctr_guarantee_valid', dimension: 'project', format: 'CSV', period: 0 },
  ],
};

const SCHEDULES: Record<string, ScheduleSpec[]> = {
  [OWNER]: [
    { metric: 'ctr_paid_to_accepted', dimension: 'project', cron: '0 7 * * 1', format: 'XLSX', to: [LEADER, OWNER, MAKER] },
    { metric: 'ctr_advance_outstanding', dimension: 'project', cron: '30 7 * * 5', format: 'CSV', to: [LEADER, 'docHead'] },
    { metric: 'ctr_portfolio_value', dimension: 'contractor', cron: '0 8 1 * *', format: 'PDF', to: [LEADER, OWNER, 'auditor'] },
    { metric: 'ctr_guarantee_coverage', dimension: 'project', cron: '0 6 * * 1-5', format: 'LINK_ONLY', to: [OWNER, 'unitAdmin'] },
  ],
  [MAKER]: [{ metric: 'ctr_paid_value', dimension: 'project', cron: '0 9 * * 1', format: 'CSV', to: [LEADER] }],
  [LEADER]: [{ metric: 'ctr_paid_value', dimension: 'project', cron: '0 9 * * 1', format: 'CSV', to: [LEADER] }],
};

async function exportsAndSchedules(ctx: SeedContext, metricIds: Map<string, string>, ctrVersions: Version[]): Promise<void> {
  if (ctrVersions[0] === undefined) return;
  for (const actor of [OWNER, MAKER, LEADER]) {
    const made = await ctx.list<Obj>(actor, '/bi/exports');
    for (const spec of EXPORTS[actor] ?? []) {
      const metric = metricIds.get(spec.metric);
      const period = ctrVersions[spec.period] ?? ctrVersions[0];
      if (metric === undefined || period === undefined) continue;
      const text = (row: Obj): string => JSON.stringify(row);
      if (made.some((row) => text(row).includes(metric) && row.format === spec.format && text(row).includes(period.as_of_period) && text(row).includes(spec.dimension))) continue;
      await ctx.attempt(actor, 'POST', '/bi/exports', { query_spec: { metric_version_id: metric, dimensions: [spec.dimension] }, as_of_period: period.as_of_period, snapshot_id: period.id, format: spec.format });
    }
    const schedules = await ctx.list<Obj>(actor, '/bi/export-schedules');
    for (const item of SCHEDULES[actor] ?? []) {
      const metric = metricIds.get(item.metric);
      if (metric === undefined) continue;
      if (schedules.some((row) => JSON.stringify(row).includes(metric) && row.cron === item.cron)) continue;
      await ctx.attempt(actor, 'POST', '/bi/export-schedules', { query_spec: { metric_version_id: metric, dimensions: [item.dimension] }, cron: item.cron, format: item.format, recipients: item.to.map((person) => ctx.person(person).membershipId) });
    }
  }
}

// ---- the decision log (BI-22) and the notes on the ranking (BI-26) -------------------------------------------------------------------------

interface DecisionSpec {
  key: string;
  person: string;
  kind: string;
  dueInDays: number;
  owner: string;
  /** The figure of the command center the decision is about (KPI_TILE); the server freezes the figures as they are. */
  tile?: string;
  outcome?: { person: string; outcome: 'RESOLVED' | 'STILL_OPEN'; key: string };
}

const DECISIONS: DecisionSpec[] = [
  { key: 'one', person: LEADER, kind: 'DIRECT_ACTION', dueInDays: 14, owner: MAKER, outcome: { person: MAKER, outcome: 'RESOLVED', key: 'one.outcome' } },
  { key: 'two', person: LEADER, kind: 'ACCEPT_RISK', dueInDays: 30, owner: MAKER, outcome: { person: LEADER, outcome: 'STILL_OPEN', key: 'two.outcome' } },
  { key: 'three', person: OWNER, kind: 'ESCALATE', dueInDays: 7, owner: LEADER },
  { key: 'four', person: LEADER, kind: 'REALLOCATE', dueInDays: 21, owner: OWNER, outcome: { person: OWNER, outcome: 'RESOLVED', key: 'four.outcome' } },
  { key: 'five', person: OWNER, kind: 'DEFER', dueInDays: 45, owner: MAKER },
  { key: 'six', person: LEADER, kind: 'NO_ACTION', dueInDays: 10, owner: OWNER },
  { key: 'seven', person: LEADER, kind: 'DIRECT_ACTION', dueInDays: 14, owner: MAKER, tile: 'DISBURSED_TREASURY' },
];

async function decisionLog(ctx: SeedContext): Promise<void> {
  const known = (((await ctx.get<Obj>(OWNER, '/home/decisions')).items as Obj[] | undefined) ?? []);
  for (const spec of DECISIONS) {
    const title = text(`decision.${spec.key}.title`);
    const reason = text(`decision.${spec.key}.reason`);
    let row = known.find((item) => asText(item.reason) === reason);
    if (row === undefined) {
      const done = await ctx.attempt<CommandReply>(spec.person, 'POST', '/home/decisions', {
        subject: spec.tile === undefined ? { kind: 'FREE', title } : { kind: 'KPI_TILE', metric_code: spec.tile },
        kind: spec.kind,
        reason,
        follow_up: { due_on: ctx.day(spec.dueInDays), owner_id: ctx.person(spec.owner).membershipId },
      });
      if (!done.ok) continue;
      row = { id: done.json.resource_id };
      if (spec.outcome !== undefined) await ctx.attempt(spec.outcome.person, 'POST', `/home/decisions/${done.json.resource_id}/outcomes`, { outcome: spec.outcome.outcome, note: text(`decision.${spec.outcome.key}`) });
    }
  }
}

async function rankingNotes(ctx: SeedContext): Promise<void> {
  const ranking = await ctx.call<Obj>(OWNER, 'GET', '/home/rankings/multi');
  const asOf = asText(ranking.json.as_of_date);
  if (asOf === '') return;
  const unit = ctx.unitId('CB-SKHDT-QLDA');
  const annotations = (((await ctx.get<Obj>(OWNER, '/home/rankings/annotations')).items as Obj[] | undefined) ?? []);
  const notes = [
    { key: 'one', reason: 'LAND_CLEARANCE', metrics: ['RATE', 'PHYSICAL'], days: 14, decision: 'APPROVE' },
    { key: 'two', reason: 'CAPITAL_NOT_RELEASED', metrics: ['RATE'], days: 10, decision: 'REJECT' },
    { key: 'three', reason: 'AWAITING_DECISION', metrics: ['EXPLANATIONS'], days: 12, decision: '' },
  ];
  for (const note of notes) {
    const evidence = text(`note.${note.key}.evidence`);
    if (annotations.some((row) => JSON.stringify(row).includes(evidence))) continue;
    const proposed = await ctx.attempt<CommandReply>(MAKER, 'POST', '/home/rankings/annotations', { unit_id: unit, reason_code: note.reason, metric_codes: note.metrics, evidence, valid_to: ctx.day(note.days) });
    if (proposed.ok && note.decision !== '') await ctx.attempt(LEADER, 'POST', `/home/rankings/annotations/${proposed.json.resource_id}/decision`, { decision: note.decision, note: text(`note.${note.key}.decision`) });
  }
  const complaints = (((await ctx.get<Obj>(OWNER, '/home/rankings/complaints')).items as Obj[] | undefined) ?? []);
  const claims = [
    { key: 'one', metric: 'COMPLETENESS', action: 'UPHOLD' },
    { key: 'two', metric: 'EXPLANATIONS', action: 'REJECT' },
    { key: 'three', metric: 'WARNINGS', action: '' },
  ];
  for (const claim of claims) {
    const words = text(`complaint.${claim.key}.claim`);
    if (complaints.some((row) => JSON.stringify(row).includes(words))) continue;
    const filed = await ctx.attempt<CommandReply>(MAKER, 'POST', '/home/rankings/complaints', { unit_id: unit, metric_code: claim.metric, as_of_date: asOf, claim: words });
    if (!filed.ok || claim.action === '') continue;
    await ctx.attempt(LEADER, 'POST', `/home/rankings/complaints/${filed.json.resource_id}/resolution`, { action: 'START_REVIEW' });
    await ctx.attempt(LEADER, 'POST', `/home/rankings/complaints/${filed.json.resource_id}/resolution`, { action: claim.action, resolution: text(`complaint.${claim.key}.resolution`) });
  }
}

// ---- the group -------------------------------------------------------------------------------------------------------------------------------

export async function seedClipEnterpriseBi2(ctx: SeedContext): Promise<void> {
  if (clipPlan()?.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  const datasets = await ctx.list<Obj>(OWNER, '/bi/datasets');
  const disb = datasets.find((row) => row.dataset_code === 'DS-DISB');
  const ctr = datasets.find((row) => row.dataset_code === 'DS-CTR');
  if (disb === undefined || ctr === undefined) {
    ctx.warn('the datasets DS-DISB and DS-CTR do not exist yet: the group has nothing to do');
    return;
  }
  await ctx.step('BI', 'access policies of the board', async () => {
    for (const dataset of [ctr, disb]) for (const person of [OWNER, MAKER, LEADER]) await openDataset(ctx, String(dataset.id), person);
  });
  await ctx.step('BI', 'certification of the datasets', async () => {
    for (const dataset of [ctr, disb]) await certifyDataset(ctx, dataset);
  });
  await ctx.step('BI', 'second commit of metrics (BI-15)', () => registerSecondCommit(ctx));
  await ctx.step('BI', 'metrics of the company', () => tenantMetrics(ctx, String(disb.id)));
  const metricIds = await certifiedMetrics(ctx);
  for (const spec of DASHBOARDS) await ctx.step('BI', `dashboard ${spec.code}`, () => dashboard(ctx, spec, metricIds));
  await ctx.step('BI', 'shares of the dashboards', () => shareDashboards(ctx));
  const ctrVersions = await latestVersions(ctx, String(ctr.id));
  const disbVersions = await latestVersions(ctx, String(disb.id));
  await ctx.step('BI', 'dashboards opened as the people (query log)', () => openDashboards(ctx, ctrVersions, disbVersions));
  await ctx.step('BI', 'exports and schedules', () => exportsAndSchedules(ctx, metricIds, ctrVersions));
  await ctx.step('ANA', 'decision log', () => decisionLog(ctx));
  await ctx.step('ANA', 'notes and complaints on the ranking', () => rankingNotes(ctx));
}
