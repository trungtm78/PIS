import { seedBase } from './base.ts';
import { seedCapital } from './capital.ts';
import type { SeedContext } from './context.ts';
import { seedFieldAssurance } from './field-assurance.ts';
import { seedIntelligence } from './intelligence.ts';
import { applyClipPlan } from './clip/plan.ts';
import { ensureDoaMatrix } from './clip/doa.ts';
import { seedClipEnterpriseDirectives, seedClipEnterpriseEbs, seedClipEnterpriseFunding, seedClipEnterpriseProjects } from './clip/enterprise.ts';
import { seedClipProcurement } from './clip/public-procurement.ts';
import { seedDoc } from './platform-records/doc.ts';
import { seedProcurementFinance } from './procurement-finance.ts';

/**
 * The ordered registry of the groups of seed data. A group builds on the ones before it by QUERYING what exists (list endpoints), never by ids
 * written in the code. To add a group: write `<group>.ts` exporting `seed<Group>(ctx)`, import it here and append a line to GROUPS (keep the order
 * of dependencies: `base` and `capital` come first). The runner (run.ts) and the Playwright spec (04-du-lieu.hdsd.ts) both run the registry.
 */
export interface SeedGroup {
  name: string;
  seed: (ctx: SeedContext) => Promise<void>;
}

export const GROUPS: SeedGroup[] = [
  { name: 'base', seed: seedBase },
  { name: 'capital', seed: seedCapital },
  // -- append the groups of the other agents below this line, one line each --
  { name: 'field-assurance', seed: seedFieldAssurance },
  { name: 'procurement-finance', seed: seedProcurementFinance },
  { name: 'intelligence', seed: seedIntelligence },
  { name: 'clip-public-documents', seed: async (ctx) => { await ctx.step('ADM', 'delegation of authority matrix', () => ensureDoaMatrix(ctx)); try { await seedDoc(ctx); } catch (error) { ctx.warn(`the document seed of the guide stopped: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`); } } },
  { name: 'clip-public-procurement', seed: seedClipProcurement },
  { name: 'clip-ent-projects', seed: seedClipEnterpriseProjects },
  { name: 'clip-ent-funding', seed: seedClipEnterpriseFunding },
  { name: 'clip-ent-directives', seed: seedClipEnterpriseDirectives },
  { name: 'clip-ent-ebs', seed: seedClipEnterpriseEbs },
];

export interface SeedSummary {
  groups: Array<{ name: string; ms: number; ledger: string }>;
  warnings: string[];
  calls: number;
  ms: number;
}

/**
 * Runs the named groups (all of them when `names` is undefined) in the order of the registry, whatever the order of the names.
 * The ledger of each group is written when the group ends, even when it failed (what it made up to there is on it).
 */
export async function runSeed(ctx: SeedContext, names?: readonly string[]): Promise<SeedSummary> {
  applyClipPlan();
  const known = GROUPS.map((group) => group.name);
  for (const name of names ?? []) if (!known.includes(name)) throw new Error(`unknown seed group "${name}" (known: ${known.join(', ')})`);
  const chosen = GROUPS.filter((group) => names === undefined || names.includes(group.name));
  const started = Date.now();
  const done: SeedSummary['groups'] = [];
  for (const group of chosen) {
    ctx.group = group.name;
    ctx.module = '';
    ctx.log(`seed group ${group.name}`);
    const groupStarted = Date.now();
    try {
      await group.seed(ctx);
    } finally {
      done.push({ name: group.name, ms: Date.now() - groupStarted, ledger: ctx.flushLedger(group.name) });
    }
  }
  return { groups: done, warnings: ctx.warnings, calls: ctx.callCount, ms: Date.now() - started };
}
