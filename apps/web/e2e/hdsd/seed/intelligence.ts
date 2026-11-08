import { createHash } from 'node:crypto';
import { vnd } from './context.ts';
import type { SeedContext } from './context.ts';
import TEXTS from './data/intelligence.json' with { type: 'json' };
import { textsOf } from '../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * Group `intelligence`: the data of the modules that read, govern and report on what the others made: BI (metrics, datasets, dashboards, exports),
 * MNE (monitoring calendar, forms, reports, evaluations), DGV (data governance: catalogue, contracts, quality, lineage, maturity) and LLM (providers,
 * models, routing, budgets, usage). Everything goes through the commands of the product as one of the seven people of the guide; nothing is written
 * to the database. The group builds on `base` and `capital` by QUERYING what exists (projects, units, snapshots of the periods).
 *
 * The story, in the words of the Department of Planning and Investment of Cao Bang:
 *  - the AI board of the Department (the project manager as administrator, the leader as approver) opens the use of language models: a provider in the
 *    country, a self-hosted server of the Department and an international service for public data only; the classification policy decides which data
 *    may go where; each model is approved and priced; prompts are approved, evaluated on synthetic cases and signed; profiles are published; budgets
 *    are set; staff then send real requests through the gateway and the usage, cost and routing screens fill from them.
 */

// ---- people and roles ----------------------------------------------------------------------------------------------------------------

/** The roles of the AI board: the units of a tenant do not hold the permissions of LLM, so the owner makes two roles and grants them (IAM commands). */
const AI_ADMIN_ROLE = {
  code: 'QUAN_TRI_AI',
  name: tx('name.001'),
  rank: 44,
  permissions: [
    'llm.provider.manage', 'llm.provider.read', 'llm.policy.manage', 'llm.policy.read', 'llm.finops', 'llm.eval.manage', 'llm.eval.read',
    'llm.knowledge.manage', 'llm.knowledge.read', 'llm.prompt.manage', 'llm.prompt.read', 'llm.key.manage', 'llm.key.read', 'llm.profile.manage',
    'llm.audit.read', 'llm.emergency', 'ai_eval_run.read', 'llm_attempt.read', 'model_profile_version.read',
  ],
};
const AI_APPROVER_ROLE = {
  code: 'DUYET_AI',
  name: tx('name.002'),
  rank: 64,
  permissions: [
    'llm.provider.approve', 'llm.provider.read', 'llm.policy.approve', 'llm.policy.read', 'llm.prompt.approve', 'llm.prompt.read', 'llm.eval.sign',
    'llm.eval.read', 'llm.publish', 'llm.audit.read', 'llm.finops', 'llm.key.read', 'llm.knowledge.read', 'ai_eval_run.read', 'llm_attempt.read',
    'model_profile_version.read',
  ],
};

/** A role by code: found, or made by the owner. Returns its id. */
async function ensureRole(ctx: SeedContext, role: typeof AI_ADMIN_ROLE): Promise<string> {
  const existing = await ctx.find('owner', '/roles', (row) => row.code === role.code);
  if (existing !== undefined) return String(existing.id);
  const made = await ctx.command('owner', '/roles', { code: role.code, name: role.name, permissions: role.permissions, rank: role.rank });
  ctx.record({ module: 'IAM', kind: 'role', id: made.resource_id, code: role.code, note: 'made for the AI board' });
  return made.resource_id;
}

/** The person holds the role over the whole tenant: asked first, then granted by the owner. */
async function ensureGrant(ctx: SeedContext, person: string, roleId: string, reason: string): Promise<void> {
  const membershipId = ctx.person(person).membershipId;
  const existing = await ctx.find('owner', '/role-grants', (row) => row.membership_id === membershipId && row.role_id === roleId && row.status === 'Active');
  if (existing !== undefined) return;
  await ctx.command('owner', '/role-grants', { membership_id: membershipId, role_id: roleId, scope_kind: 'TENANT', reason });
}

async function setUpAiBoard(ctx: SeedContext): Promise<void> {
  const admin = await ensureRole(ctx, AI_ADMIN_ROLE);
  const approver = await ensureRole(ctx, AI_APPROVER_ROLE);
  await ensureGrant(ctx, 'projectManager', admin, tx('setUpAiBoard.003'));
  await ensureGrant(ctx, 'capApprover', approver, tx('setUpAiBoard.004'));
}

// ---- small helpers -------------------------------------------------------------------------------------------------------------------

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function seedIntelligence(ctx: SeedContext): Promise<void> {
  await ctx.step('IAM', 'roles of the AI board', () => setUpAiBoard(ctx));
  void vnd;
}
