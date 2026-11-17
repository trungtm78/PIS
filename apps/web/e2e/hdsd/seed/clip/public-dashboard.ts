import { readFileSync } from 'node:fs';
import type { Obj, SeedContext } from '../context.ts';
import { clipPlan } from './plan.ts';

/**
 * The demo data of the leader dashboard of the province of Cà Mau (HOME-01 of that tenant): the projects of the dataset are registered under one unit, and the dashboard
 * reads the province by investor unit (the ranking of units, the heat map by month, the scorecard). This group gives each project the investor unit the dashboard names
 * for it (scripts/fixtures/clip-data/camau-dashboard.json), with the command of the product for it: the transfer of a project between units (PRJ-20), asked by the project
 * manager and decided by the leader. Only the investor unit moves: the owner unit, and with it who may work on the project, stays.
 *
 * Idempotent: a project that already has its investor is left alone, and a transfer left waiting by a run that stopped half-way is decided instead of asked again.
 */
const FIXTURE = new URL('../../../../../../scripts/fixtures/clip-data/camau-dashboard.json', import.meta.url);
const REQUESTER = 'projectManager';
const DECIDER = 'capApprover';
/** The states a project cannot be transferred in (the product refuses them): they keep the investor they have. */
const SETTLED = new Set(['COMPLETED', 'REJECTED', 'CANCELLED', 'CLOSED']);

interface DashboardFixture {
  reason: string;
  decisionReason: string;
  /** The code of the investor unit of each project, by project code. */
  investors: Record<string, string>;
}

export async function seedClipDashboard(ctx: SeedContext): Promise<void> {
  const plan = clipPlan();
  if (plan === undefined || plan.variant !== 'camau') {
    ctx.warn('the dashboard data belongs to the dataset of Cà Mau: nothing to do for another dataset');
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as DashboardFixture;
  const unitByCode = new Map((await ctx.list<Obj>(REQUESTER, '/resources/organization_unit')).map((unit) => [String(unit.code), String(unit.id)]));
  const projects = await ctx.list<Obj>(REQUESTER, '/resources/project');
  const waiting = new Map((await ctx.list<Obj>(DECIDER, '/project-transfers', { status: 'REQUESTED' })).map((transfer) => [String((transfer.project as Obj | undefined)?.id), transfer]));
  let moved = 0;
  let kept = 0;
  for (const project of projects) {
    const code = String(project.code);
    const unitCode = fixture.investors[code];
    if (unitCode === undefined) continue;
    const target = unitByCode.get(unitCode);
    if (target === undefined) {
      ctx.warn(`the unit ${unitCode} of the project ${code} is not a unit of the tenant`);
      continue;
    }
    if (String(project.investor_unit_id) === target || SETTLED.has(String(project.status))) {
      kept += 1;
      continue;
    }
    const id = String(project.id);
    let transfer = waiting.get(id);
    if (transfer === undefined) {
      const asked = await ctx.attempt(REQUESTER, 'POST', `/projects/${id}/transfers`, { to_unit_id: target, transfer_scope: 'INVESTOR_UNIT', effective_date: ctx.day(0), reason: fixture.reason }, { version: Number(project.version) });
      if (!asked.ok) continue;
      transfer = { id: asked.json.resource_id, version: asked.json.resource_version };
    }
    const decided = await ctx.attempt(DECIDER, 'POST', `/project-transfers/${String(transfer.id)}/decision`, { decision: 'approve', reason: fixture.decisionReason }, { version: Number(transfer.version) });
    if (!decided.ok) continue;
    moved += 1;
    ctx.record({ module: 'PRJ', screen: 'PRJ-20', kind: 'project-transfer', id: String(transfer.id), code, note: `investor unit ${unitCode}` });
  }
  ctx.record({ module: 'PRJ', screen: 'PRJ-20', kind: 'dashboard-investors', id: 'summary', code: 'dashboard', note: `${moved} projects given their investor unit, ${kept} left as they were` });
}
