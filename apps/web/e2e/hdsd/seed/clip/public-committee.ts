import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-public-committee`: the steering committee of the province (BAN-1). The committee is registered and its members appointed by the officer;
 * the head is the clip account `docHead` (the docs stack grants it the system role COMMITTEE_HEAD at start); the workspace then reads the latest frozen snapshot of
 * the period (group `clip-public-disbursement`). Alerts of the committee are evaluated by its own command, and the head acknowledges one.
 * Directives of the committee are added through the steering meetings of the directive module.
 */

const MAKER = 'projectManager';

interface CommitteeBlock {
  code: string;
  name: string;
  legalBasis: string;
  headAgency: string;
  headAgencyCode: string;
  meetingReason: string;
  members: Array<{ person: string; role: string; agency: string; code: string }>;
}

export async function seedClipCommittee(ctx: SeedContext): Promise<void> {
  const block = clipPlan()?.committee as CommitteeBlock | undefined;
  if (block === undefined) {
    ctx.warn('no clip plan with a committee block: nothing to do');
    return;
  }
  const roster = await ctx.get<Obj>(MAKER, '/committee/roster');
  const committees = (Array.isArray(roster.committees) ? roster.committees : []) as Obj[];
  let committee = committees.find((row) => row.code === block.code);
  if (committee === undefined) {
    const made = await ctx.command(MAKER, '/committee/roster', { code: block.code, name: block.name, legal_basis: block.legalBasis });
    committee = { id: made.resource_id };
  }
  const members = block.members;
  for (const member of members) {
    const reply = await ctx.attempt(MAKER, 'POST', '/committee/roster/members', {
      committee_id: String(committee.id),
      membership_id: ctx.person(member.person).membershipId,
      committee_role: member.role,
      valid_from: ctx.day(-60),
      agency_code: member.code,
      agency_name: member.agency,
    });
    if (reply.ok) ctx.record({ module: 'BAN', kind: 'committee-member', id: String(reply.json.resource_id), code: member.person, note: member.role });
  }
  const evaluated = await ctx.attempt<Obj>(MAKER, 'POST', '/committee/alerts/evaluate', {});
  if (evaluated.ok) ctx.log(`  [committee] alerts opened ${String(evaluated.json.opened)} kept ${String(evaluated.json.kept)}`);
  const workspace = await ctx.attempt<Obj>('docHead', 'GET', '/committee/workspace');
  if (workspace.ok) ctx.log(`  [committee] workspace feed empty ${String(asObj(workspace.json.feed).empty)} projects ${String(asObj(workspace.json.feed).projects)} attention ${String(workspace.json.attention_total)}`);
  else ctx.warn(`the head cannot read the workspace: HTTP ${workspace.status}`);
}
