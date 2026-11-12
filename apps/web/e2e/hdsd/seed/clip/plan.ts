import { readFileSync } from 'node:fs';
import { AREAS } from '../base.ts';
import { APPROPRIATIONS } from '../capital-plan.ts';
import type { AppropriationSpec, LineSpec } from '../capital-plan.ts';
import { LINES } from '../capital-plan.ts';
import { MORE_AREAS, PROJECTS } from '../capital-projects.ts';
import type { ProjectSpec } from '../capital-projects.ts';
import { PLANS } from '../procurement-finance/bid.ts';
import type { PlanSpec } from '../procurement-finance/bid.ts';
import { CONTRACTORS } from '../procurement-finance/shared.ts';
import type { ContractorSpec } from '../procurement-finance/shared.ts';

/**
 * The plan of a clip dataset (scripts/clip-seed-lib.mjs, written by `node scripts/clip-seed.mjs apply`): the seed layer reads it from the file named by
 * CLIP_PLAN_FILE and grows its own tables with it (the portfolio, the lines of capital, the appropriations, the wards), so the groups of the guide run
 * unchanged on a bigger province. Without the variable nothing changes.
 */
export interface ClipPlan {
  schema: 'clip-plan/1';
  dataset: 'public' | 'enterprise';
  edition: string;
  seed: number;
  areas: Array<{ key: string; name: string }>;
  areaDecision: { symbol: string; title: string };
  appropriationOverrides: Record<string, number>;
  extraAppropriations: Array<{ key: string; fund: string; origin: AppropriationSpec['origin']; level: AppropriationSpec['level']; billions: number; sourceYear: number; authority: string; symbol: string; title: string; issuedOn: string }>;
  projects: ProjectSpec[];
  lines: Array<{ project: string; appropriation: string; billions: number; bucket?: LineSpec['bucket'] }>;
  [more: string]: unknown;
}

let loaded: ClipPlan | undefined;
let applied = false;

/** The plan named by CLIP_PLAN_FILE, or undefined when the variable is not set. */
export function clipPlan(): ClipPlan | undefined {
  const file = process.env.CLIP_PLAN_FILE;
  if (file === undefined || file === '') return undefined;
  loaded ??= JSON.parse(readFileSync(file, 'utf8')) as ClipPlan;
  return loaded;
}

/** A text of the dataset (Vietnamese, in the fixture): the groups hold keys, never words. `{0}`, `{1}` are replaced by the arguments in order. */
export function clipText(key: string, ...args: readonly unknown[]): string {
  const table = (clipPlan()?.texts ?? {}) as Record<string, string>;
  const template = table[key];
  if (template === undefined) throw new Error(`the text ${key} is not in the dataset (is CLIP_PLAN_FILE set?)`);
  return template.replace(/\{(\d+)\}/gu, (_match, index: string) => String(args[Number(index)]));
}

/**
 * The enterprise dataset REPLACES the tables of the guide (the province's projects, assignments, lines of capital, tenders and contractors): the same groups then
 * run unchanged on the projects and contractors of the enterprise, and nothing of the province is written into the product.
 */
function applyEnterprisePlan(plan: ClipPlan): void {
  const capital = plan.capital as { appropriations: Array<ClipPlan['extraAppropriations'][number] & { decisionKind?: string }>; lines: Array<{ project: string; appropriation: string; billions: number; bucket?: LineSpec['bucket'] }> };
  MORE_AREAS.length = 0;
  // The three wards of the province belong to the guide's base group: the enterprise publishes the areas of its own plan only.
  AREAS.length = 0;
  PROJECTS.length = 0;
  PROJECTS.push(...plan.projects);
  APPROPRIATIONS.length = 0;
  for (const extra of capital.appropriations) {
    APPROPRIATIONS.push({
      key: extra.key,
      fund: extra.fund,
      origin: extra.origin,
      level: extra.level,
      billions: extra.billions,
      authority: extra.authority,
      sourceYear: extra.sourceYear,
      letter: { symbol: extra.symbol, title: extra.title, issuedOn: extra.issuedOn, sender: extra.authority },
      // The enterprise pack requires the kind of the document that backs the assignment (ENT-3e); the public one binds none.
      ...(extra.decisionKind === undefined ? {} : { decisionKind: extra.decisionKind }),
      decide: 'approve',
    });
  }
  LINES.length = 0;
  for (const line of capital.lines) LINES.push({ project: line.project, appropriation: line.appropriation, billions: line.billions, ...(line.bucket === undefined ? {} : { bucket: line.bucket }) } satisfies LineSpec);
  PLANS.length = 0;
  PLANS.push(...(plan.tenders as PlanSpec[]));
  CONTRACTORS.length = 0;
  CONTRACTORS.push(...(plan.contractors as ContractorSpec[]));
}

/** Grows the tables of the capital groups with the plan (once per process). */
export function applyClipPlan(): ClipPlan | undefined {
  const plan = clipPlan();
  if (plan === undefined || applied) return plan;
  applied = true;
  if (plan.dataset === 'enterprise') {
    applyEnterprisePlan(plan);
    return plan;
  }
  if (plan.dataset !== 'public') return plan;
  MORE_AREAS.push(...plan.areas.filter((area) => !MORE_AREAS.some((known) => known.key === area.key)));
  for (const [key, billions] of Object.entries(plan.appropriationOverrides)) {
    const spec = APPROPRIATIONS.find((candidate) => candidate.key === key);
    if (spec !== undefined) spec.billions = billions;
  }
  for (const extra of plan.extraAppropriations) {
    if (APPROPRIATIONS.some((spec) => spec.key === extra.key)) continue;
    APPROPRIATIONS.push({
      key: extra.key,
      fund: extra.fund,
      origin: extra.origin,
      level: extra.level,
      billions: extra.billions,
      authority: extra.authority,
      sourceYear: extra.sourceYear,
      letter: { symbol: extra.symbol, title: extra.title, issuedOn: extra.issuedOn, sender: extra.authority },
      decide: 'approve',
    });
  }
  for (const project of plan.projects) if (!PROJECTS.some((known) => known.code === project.code)) PROJECTS.push(project);
  for (const line of plan.lines) LINES.push({ project: line.project, appropriation: line.appropriation, billions: line.billions } satisfies LineSpec);
  return plan;
}
