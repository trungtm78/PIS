import { vndMillions } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import TEXTS from '../data/enterprise-equipment.json' with { type: 'json' };
import { clipPlan } from './plan.ts';

/**
 * Group `clip-ent-equipment`: the equipment procurement of the projects of the Ban Thuong mai (CN.02, EQP-01 and EQP-02, ENT-4e), made with the commands of the product only.
 *
 * A line of the register is what the plan expects to buy as equipment; the stage it is at is read from BID, CTR and PAY (one read path), so the lines are tied to the packages and contracts the
 * procurement groups already made, and the stages come out as the tenders left them: a package being tendered (PACKAGED), an award waiting for its contract (SELECTED), a contract signed (CONTRACTED).
 * Lines with no package yet stay PLANNED, one was dropped from the plan (CANCELLED). The packages of the lines are the equipment ones of the plan (the codes end in -TB01, -TB02).
 *
 * Idempotent: a line that exists (by project and code) is not made again, a link already set is left alone. A line whose command is refused is written in the warnings and the rest go on.
 */

const MAKER = 'projectManager';

interface LineText {
  code: string;
  name: string;
  planRef: string;
  /** The project the equipment belongs to: the name of a line is paired with the package of that project, never by position. */
  project?: string;
  bump?: number;
}
interface PlannedText extends LineText {
  millions: number;
}

const LINES = TEXTS['equipment.lines'] as LineText[];
const PLANNED = TEXTS['equipment.planned'] as PlannedText[];
const CANCELLED = TEXTS['equipment.cancelled'] as PlannedText & { reason: string };

/** The project a package belongs to: the read of the packages names it as an object. */
const projectIdOf = (pack: Obj): string => String(pack.project_id ?? (pack.project as Obj | undefined)?.id);

/** Whole dong rounded down to a million: the value the plan carries is a round figure. */
function roundedMillions(vnd: string, percent: number): string {
  const millions = (BigInt(vnd.split('.')[0] ?? '0') * BigInt(percent)) / 100n / 1_000_000n;
  return (millions * 1_000_000n).toString();
}

async function existingLine(ctx: SeedContext, projectId: string, code: string): Promise<Obj | undefined> {
  const lines = await ctx.list<Obj>(MAKER, '/equipment-procurement', { project_id: projectId, include_cancelled: 'true' });
  return lines.find((line) => line.code === code);
}

/** Makes one line (or finds it), then ties it to its package and contract. Returns the stage it reads at, or undefined when the line could not be made. */
async function ensureLine(ctx: SeedContext, input: { projectId: string; projectCode: string; text: LineText; plannedVnd: string; packageId?: string; contractId?: string }): Promise<string | undefined> {
  let line = await existingLine(ctx, input.projectId, input.text.code);
  if (line === undefined) {
    const made = await ctx.attempt(MAKER, 'POST', '/equipment-procurement', { project_id: input.projectId, code: input.text.code, name: input.text.name, planned_value_vnd: input.plannedVnd, plan_ref: input.text.planRef });
    if (!made.ok) return undefined;
    line = await existingLine(ctx, input.projectId, input.text.code);
  }
  if (line === undefined) return undefined;
  const id = String(line.id);
  const linked = line.package !== null && line.package !== undefined;
  if (input.packageId !== undefined && !linked) {
    const link: Obj = { package_id: input.packageId };
    if (input.contractId !== undefined) link.contract_id = input.contractId;
    await ctx.attempt(MAKER, 'PATCH', `/equipment-procurement/${id}`, link, { version: Number(line.version) });
  } else if (input.packageId !== undefined && input.contractId !== undefined && (line.contract === null || line.contract === undefined)) {
    await ctx.attempt(MAKER, 'PATCH', `/equipment-procurement/${id}`, { contract_id: input.contractId }, { version: Number(line.version) });
  }
  const read = await ctx.get<Obj>(MAKER, `/equipment-procurement/${id}`);
  const stage = String(((read.line ?? {}) as Obj).stage ?? '');
  ctx.record({ module: 'EQP', screen: 'EQP-01', kind: 'equipment-line', id, code: input.text.code, note: `${input.projectCode} ${stage}` });
  return stage;
}

export async function seedClipEnterpriseEquipment(ctx: SeedContext): Promise<void> {
  const plan = clipPlan() as unknown as { dataset: string; projects: Array<{ code: string; kind: string }> } | undefined;
  if (plan === undefined || plan.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  await ctx.step('EQP', 'equipment procurement lines', async () => {
    const projects = await ctx.list<Obj>(MAKER, '/resources/project');
    const projectByCode = new Map(projects.map((row) => [String(row.code), row]));
    const packages = (await ctx.list<Obj>(MAKER, '/resources/procurement_package')).filter((row) => /-TB\d+$/u.test(String(row.code)) && String(row.status) !== 'CANCELLED');
    const contracts = await ctx.list<Obj>(MAKER, '/resources/contract');
    // Packages that were awarded and have a contract go first (they read as ordered), then the ones in the tender, so the stages are spread over the list whatever order the codes come in.
    const rank = (pack: Obj): number => (contracts.some((contract) => String(contract.package_id) === String(pack.id)) ? 0 : 1);
    const ordered = [...packages].sort((a, b) => rank(a) - rank(b) || String(a.code).localeCompare(String(b.code)));
    const stages: string[] = [];
    const taken = new Set<LineText>();
    for (const pack of ordered.slice(0, LINES.length)) {
      const project = projects.find((row) => String(row.id) === projectIdOf(pack));
      if (project === undefined) continue;
      // The name that belongs to the project of the package; a package of a project the texts do not know takes the next free name.
      const text = LINES.find((line) => line.project === String(project.code) && !taken.has(line)) ?? LINES.find((line) => !taken.has(line));
      if (text === undefined) break;
      taken.add(text);
      const contract = contracts.find((row) => String(row.package_id) === String(pack.id) && String(row.status) !== 'CANCELLED');
      const stage = await ensureLine(ctx, {
        projectId: String(project.id),
        projectCode: String(project.code),
        text,
        plannedVnd: roundedMillions(String(pack.budget_vnd), text.bump ?? 100),
        packageId: String(pack.id),
        ...(contract === undefined ? {} : { contractId: String(contract.id) }),
      });
      if (stage !== undefined) stages.push(stage);
    }
    // Lines still on the plan, with no package: on the equipment projects (the ones with no package first, then the others).
    const equipmentCodes = plan.projects.filter((project) => project.kind === 'EQUIPMENT').map((project) => project.code);
    const carrying = new Set(ordered.map(projectIdOf));
    const free = equipmentCodes.map((code) => projectByCode.get(code)).filter((row): row is Obj => row !== undefined);
    const targets = [...free.filter((row) => !carrying.has(String(row.id))), ...free.filter((row) => carrying.has(String(row.id)))];
    for (const [index, text] of PLANNED.entries()) {
      const project = (text.project === undefined ? undefined : projectByCode.get(text.project)) ?? targets[index % Math.max(1, targets.length)];
      if (project === undefined) break;
      const stage = await ensureLine(ctx, { projectId: String(project.id), projectCode: String(project.code), text, plannedVnd: vndMillions(text.millions) });
      if (stage !== undefined) stages.push(stage);
    }
    // One line the plan dropped: made, then cancelled with the reason (the list hides it until "show cancelled" is ticked).
    const dropped = (CANCELLED.project === undefined ? undefined : projectByCode.get(CANCELLED.project)) ?? targets[targets.length - 1] ?? targets[0];
    if (dropped !== undefined && (await existingLine(ctx, String(dropped.id), CANCELLED.code)) === undefined) {
      const made = await ctx.attempt(MAKER, 'POST', '/equipment-procurement', { project_id: String(dropped.id), code: CANCELLED.code, name: CANCELLED.name, planned_value_vnd: vndMillions(CANCELLED.millions), plan_ref: CANCELLED.planRef });
      const created = made.ok ? await existingLine(ctx, String(dropped.id), CANCELLED.code) : undefined;
      if (created !== undefined) await ctx.attempt(MAKER, 'PATCH', `/equipment-procurement/${String(created.id)}`, { cancel_reason: CANCELLED.reason }, { version: Number(created.version) });
    }
    ctx.log(`  [eqp] ${stages.length} lines on the register, stages: ${stages.join(', ')}`);
    if (stages.length < 6) ctx.warn(`only ${stages.length} equipment lines could be made (the plan wants 6 or more)`);
  });
}
