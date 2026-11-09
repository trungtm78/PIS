import type { Obj, SeedContext } from '../context.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-public-alerts`: the early-warning rules of the disbursement module, made by the officer and published by the leader (maker is not checker), BEFORE the
 * period snapshots are frozen. The warnings themselves are not made here: the platform evaluates the published rules when a snapshot is frozen (the event consumer),
 * so the alerts of the leader come from the real source and carry the three severities (information, warning, critical) by how far a project is behind the line.
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';

export interface RuleSpec {
  rule_code: string;
  name: string;
  metric_code: string;
  comparator: string;
  threshold_json: Obj;
  severity: string;
}

export async function seedClipAlerts(ctx: SeedContext): Promise<void> {
  const block = clipPlan()?.alerts as { rules: RuleSpec[]; legalBasis: string } | undefined;
  if (block === undefined) {
    ctx.warn('no clip plan with alert rules: nothing to do');
    return;
  }
  await publishAlertRules(ctx, block);
}

/** The rules of a block made by the officer and published by the leader; a rule in force is left alone (the enterprise group uses it with its own rules). */
export async function publishAlertRules(ctx: SeedContext, block: { rules: RuleSpec[]; legalBasis: string }): Promise<void> {
  const known = await ctx.list<Obj>(MAKER, '/early-warning-rules');
  for (const rule of block.rules) {
    const inForce = known.find((row) => row.rule_code === rule.rule_code && String(row.status).toUpperCase() === 'PUBLISHED' && String(row.effective_from) <= ctx.today);
    if (inForce !== undefined) continue;
    const draft = known.find((row) => row.rule_code === rule.rule_code && String(row.status).toUpperCase() === 'DRAFT' && String(row.effective_from) <= ctx.today);
    let id: string;
    let version: number;
    if (draft === undefined) {
      const made = await ctx.command(MAKER, '/early-warning-rules', { ...rule, scope_kind: 'PROJECT', legal_basis: block.legalBasis, effective_from: ctx.day(-200) });
      id = made.resource_id;
      version = made.resource_version;
    } else {
      id = String(draft.id);
      version = Number(draft.version);
    }
    await ctx.step('DIS', `rule ${rule.rule_code} published`, async () => {
      await ctx.command(LEADER, `/early-warning-rules/${id}/publish`, {}, { version });
    });
  }
}
