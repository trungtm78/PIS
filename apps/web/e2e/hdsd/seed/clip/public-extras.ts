import type { Obj, SeedContext } from '../context.ts';
import { clipText } from './plan.ts';

/**
 * Group `clip-public-extras`: data that the weak scenes of the clips needed. The tenant owner passes the right to decide approvals to the unit administrator for thirty days
 * (the delegation screen ADM-04 and the escalation story then have a real delegation to show), through the real command.
 */

const OWNER = 'owner';
const DELEGATE = 'unitAdmin';

async function delegation(ctx: SeedContext): Promise<void> {
  const known = await ctx.list<Obj>(OWNER, '/resources/delegation_grant', { role: 'delegator' }).catch(() => [] as Obj[]);
  if (known.some((row) => String(row.status) === 'ACTIVE')) return;
  const from = new Date(ctx.asOf.getTime() + 20_000).toISOString();
  const until = new Date(ctx.asOf.getTime() + 30 * 86_400_000).toISOString();
  await ctx.command(OWNER, '/delegations', {
    delegate_membership_id: ctx.person(DELEGATE).membershipId,
    permissions: ['approval.decide'],
    scope_kind: 'UNIT_SUBTREE',
    scope_ref_ids: [ctx.unitId('CB-HQ')],
    valid_from: from,
    valid_until: until,
    reason: clipText('extras.delegationReason'),
  });
}

export async function seedClipExtras(ctx: SeedContext): Promise<void> {
  await ctx.step('ADM', 'delegation of the approval right for thirty days', () => delegation(ctx));
}
