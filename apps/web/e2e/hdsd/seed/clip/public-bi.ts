import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-public-bi`: the metrics of the platform and the dashboards of the leaders, through the real commands. The bundle of the metrics is built from the files of the repository
 * (scripts/bi-metrics-bundle.mjs, judged by the validator the server uses) and given INLINE to the sync (`syncMetricRegistry` takes the document itself when no pipeline stores the file);
 * the platform metrics arrive CERTIFIED. A dashboard is created and given a version over certified metrics by the officer, and published by the leader on a document (maker is not checker).
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';
const OWNER = 'owner';

interface DashboardSpec {
  code: string;
  title: string;
  metrics: string[];
}

interface BiBlock {
  sourceCommit: string;
  dashboards: DashboardSpec[];
  publishReason: string;
  evidence: { symbol: string; title: string; sender: string };
}

type BundleBuilder = (directory: string) => Promise<{ ok: boolean; bytes?: Buffer; problems?: string[]; count?: number }>;

async function bundleOfRepository(): Promise<Record<string, unknown>> {
  // The seed runs from apps/web; the repository root is two folders up.
  const root = join(process.cwd(), '..', '..');
  const module = (await import(pathToFileURL(join(root, 'scripts', 'bi-metrics-bundle.mjs')).href)) as { buildBundle: BundleBuilder };
  const built = await module.buildBundle(join(root, 'metrics'));
  if (!built.ok || built.bytes === undefined) throw new Error(`the metric files are not valid: ${(built.problems ?? []).join('; ')}`);
  return JSON.parse(built.bytes.toString('utf8')) as Record<string, unknown>;
}

async function dashboardWithVersion(ctx: SeedContext, spec: DashboardSpec, metricIds: Map<string, string>, block: BiBlock): Promise<void> {
  const known = (await ctx.list<Obj>(MAKER, '/bi/dashboards')).find((row) => row.code === spec.code);
  if (known !== undefined && known.status === 'PUBLISHED') return;
  const ids = spec.metrics.map((code) => metricIds.get(code)).filter((id): id is string => id !== undefined);
  if (ids.length === 0) {
    ctx.warn(`the dashboard ${spec.code}: none of its metrics is registered`);
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
  const saved = await ctx.attempt<CommandReply>(MAKER, 'POST', `/bi/dashboards/${id}/versions`, {
    layout_json: { widgets: ids.map((metric, index) => ({ id: `w${index + 1}`, kind: 'BAR', metric_version_id: metric, dimension_code: 'unit', grid: { x: 0, y: index * 4, w: 12, h: 4 } })) },
    breakpoints: { sm: 640, md: 1024 },
    metric_versions: ids,
    filter_mappings: { period: 'bucket' },
    dataset_version_policy: 'LATEST_FROZEN',
  }, { version });
  if (!saved.ok) return;
  const evidence = await ctx.letter({ symbol: block.evidence.symbol, title: block.evidence.title, sender: block.evidence.sender, issuedOn: ctx.day(-5) });
  const dashboard = await ctx.get<Obj>(LEADER, `/bi/dashboards/${id}`);
  await ctx.attempt(LEADER, 'POST', `/dashboards/${id}/publish`, { decision: 'approve', reason: block.publishReason, evidence_ids: [evidence.documentId] }, { version: Number(dashboard.version) });
  ctx.record({ module: 'BI', screen: 'BI-05', kind: 'dashboard', id, code: spec.code, note: spec.title });
}

export async function seedClipBi(ctx: SeedContext): Promise<void> {
  const block = clipPlan()?.bi as BiBlock | undefined;
  if (block === undefined) {
    ctx.warn('no clip plan with a bi block: nothing to do');
    return;
  }
  const bundle = await ctx.step('BI', 'bundle of the metric files', () => bundleOfRepository());
  const synced = await ctx.step('BI', 'sync of the registry (inline bundle)', () => ctx.attempt<Obj>(OWNER, 'POST', '/bi/metric-registry-syncs', { source_commit: block.sourceCommit, bundle }));
  if (synced.ok) ctx.log(`  [bi] registry ${String(synced.json.status)} added ${String(synced.json.added)} revised ${String(synced.json.revised)}`);
  const definitions = await ctx.list<Obj>(MAKER, '/resources/metric_definition');
  const metricIds = new Map<string, string>();
  for (const row of definitions) if (row.status === 'CERTIFIED' && typeof row.code === 'string') metricIds.set(row.code, String(row.id));
  for (const spec of block.dashboards) await ctx.step('BI', `dashboard ${spec.code}`, () => dashboardWithVersion(ctx, spec, metricIds, block));
}
