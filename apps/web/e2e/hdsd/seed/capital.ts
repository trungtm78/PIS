import type { SeedContext } from './context.ts';
import { planOfTheYear, registerAppropriations } from './capital-plan.ts';
import { PROJECTS, advanceAfterPlan, advanceToPipeline, projectByCode, projectNow, publishMoreAreas, registerPortfolioProject } from './capital-projects.ts';
import type { PortfolioProject } from './capital-projects.ts';

/**
 * Group `capital`: the portfolio of projects in every stage of the life cycle, the capital of the year 2026 (assignments, plan of the year published),
 * the extras of PRJ (leaders, milestones, risks, task forces...), and the reporting of disbursement (DIS) with its warnings, rankings and alerts.
 * Builds on `base`; every step skips what exists.
 */
export async function seedCapital(ctx: SeedContext): Promise<void> {
  await ctx.step('MDM', 'wards and communes of the portfolio', () => publishMoreAreas(ctx));
  const portfolio: PortfolioProject[] = [];
  for (const spec of PROJECTS) {
    const id = await ctx.step('PRJ', `register ${spec.code}`, () => registerPortfolioProject(ctx, spec));
    portfolio.push({ ...spec, id });
  }
  for (const project of portfolio) await ctx.step('PRJ', `appraise ${project.code}`, () => advanceToPipeline(ctx, project));
  await ctx.step('CAP', 'assignments of capital (appropriations)', () => registerAppropriations(ctx));
  await ctx.step('CAP', 'capital plan of the year', () => planOfTheYear(ctx));
  await ctx.step('PRJ', 'projects funded by the plan become BUDGETED', async () => {
    const funded = portfolio.filter((project) => project.planBillions !== undefined);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const states = await Promise.all(funded.map(async (project) => String((await projectNow(ctx, project.id)).status)));
      if (states.every((status) => status !== 'PIPELINE')) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    }
    throw new Error('the projects the plan funds did not become BUDGETED within 30 s (is the event consumer of the stack running?)');
  });
  for (const project of portfolio) await ctx.step('PRJ', `stage of ${project.code}`, () => advanceAfterPlan(ctx, project));
  for (const project of portfolio) {
    const row = await projectByCode(ctx, project.code);
    ctx.record({ module: 'PRJ', screen: 'PRJ-01', kind: 'project-stage', id: project.id, code: project.code, note: String(row?.status) });
  }
}
