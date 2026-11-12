import type { Obj, SeedContext } from '../context.ts';
import { clipPlan } from './plan.ts';

/**
 * What the performance budget of the customer (docs/qa/perf-budget.json) and the reports read, and a demo that has none of it cannot measure (UAT run r6: PB-R014 answered 409 on both editions, PB-R004 422 on the public one):
 *  - the open-data portal is configured (the settings are saved and the portal is on), so the OC4IDS export of what is published has a portal to export;
 *  - one project under way has a work breakdown and a baseline version 0, so the S-curve export has a baseline to draw. A tenant that has a baseline already is left as it is.
 * Real commands, as the owner (the person who holds the settings and the baseline of every project). Idempotent: a second run finds the portal and the baseline and changes nothing.
 */
const OWNER = 'owner';
const SHARES = [40n, 60n];

function text(key: string): string {
  const table = ((clipPlan() as unknown as { texts?: Record<string, string> } | undefined)?.texts ?? {}) as Record<string, string>;
  const value = table[key];
  if (value === undefined) throw new Error(`the text ${key} is not in the dataset (is CLIP_PLAN_FILE set?)`);
  return value;
}

async function portal(ctx: SeedContext): Promise<void> {
  const current = await ctx.get<Obj>(OWNER, '/portal/settings');
  if (current.settings !== null && current.settings !== undefined) return;
  await ctx.command(OWNER, '/portal/settings', {
    expected_version: 0,
    slug: text('openData.portalSlug'),
    enabled: true,
    whistle_enabled: false,
    title: text('openData.portalTitle'),
    publisher_name: text('openData.publisher'),
    id_prefix: text('openData.idPrefix'),
    license_uri: text('openData.licenseUri'),
    policy_uri: text('openData.policyUri'),
  });
}

async function baseline(ctx: SeedContext): Promise<void> {
  const projects = await ctx.list<Obj>(OWNER, '/resources/project', { limit: 200 });
  const living = projects.filter((row) => String(row.status) === 'IMPLEMENTATION');
  for (const row of living) {
    const known = await ctx.get<Obj>(OWNER, `/projects/${String(row.id)}/baseline`);
    if (known.has_baseline === true) return;
  }
  const project = living[0];
  if (project === undefined) {
    ctx.warn('no project is under way: there is nothing to take a baseline of');
    return;
  }
  const id = String(project.id);
  const detail = await ctx.get<Obj>(OWNER, `/resources/project/${id}`);
  const total = BigInt(String(detail.total_investment_vnd ?? '0'));
  if (total <= 0n) {
    ctx.warn(`the project ${String(project.code)} states no investment: its work breakdown cannot be valued`);
    return;
  }
  const listed = await ctx.get<Obj>(OWNER, `/projects/${id}/components`);
  const rows = (Array.isArray(listed) ? listed : (listed.items ?? listed.components ?? [])) as Obj[];
  const known = new Set(rows.map((row) => String(row.code)));
  for (const [index, share] of SHARES.entries()) {
    const code = `${text('openData.componentCode')}${index + 1}`;
    if (known.has(code)) continue;
    await ctx.command(OWNER, `/projects/${id}/components`, { code, name: `${text('openData.componentName')} ${index + 1}`, planned_value_vnd: String((total * share) / 100n), valid_from: ctx.day(-400), sort_order: index + 1 });
  }
  const taken = await ctx.call(OWNER, 'POST', `/projects/${id}/baseline`, {});
  if (!taken.ok && taken.json.code !== 'BASELINE_ALREADY_TAKEN') ctx.expectOk(taken, 'take the baseline');
}

export async function seedOpenData(ctx: SeedContext): Promise<void> {
  if (clipPlan() === undefined) {
    ctx.warn('no clip plan (CLIP_PLAN_FILE): the open data has nothing to do');
    return;
  }
  await ctx.step('PRJ', 'the open-data portal is configured', () => portal(ctx));
  await ctx.step('PRJ', 'a project under way has a baseline', () => baseline(ctx));
}
