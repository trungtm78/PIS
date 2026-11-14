import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { tolerate } from '../field-assurance/shared.ts';

/**
 * Group `clip-public-approvals`: the person who signs in on the phone (the owner) has something waiting in the approval inbox of the public dataset (MOB-23, MOB-24, and the inbox of the web). Before this
 * group the inbox of the public dataset was empty for everybody: the only way to fill it was to change the rule that accepts the reports of the province to several steps, which other scenarios stand on.
 *
 * This group changes no rule another scenario uses. It publishes the approval workflow of a business type nothing had one for, `score.response` (the response of a person to their score, PWF R43: one step,
 * decided by the owner), and then the officer answers their score of the locked period (`submitStaffScoreResponse`). With a workflow published the response is not handled directly: an instance of the approval
 * engine starts and the owner holds its task. Real commands only, the way people do it on the web; idempotent: a workflow already published is kept, and no second response is sent while one waits.
 *
 * It runs after `clip-public-pwf-review` (which locks the period, and whose own response of the officer was handled directly, before any workflow existed).
 */

const OWNER = 'owner';
const PUBLISHER = 'capApprover';
const OFFICER = 'projectManager';
const BUSINESS_TYPE = 'score.response';

/** Publishes the one-step workflow of `score.response` (the owner decides), unless one is in force. */
async function ensureWorkflow(ctx: SeedContext): Promise<boolean> {
  const versions = await ctx.list<Obj>(OWNER, '/resources/workflow_version');
  if (versions.some((row) => row.business_type === BUSINESS_TYPE && row.status === 'Published')) return true;
  const definition = {
    steps: [
      {
        id: 'review',
        name: 'Xem xét phản hồi về điểm đánh giá',
        assignee_rule: { type: 'SPECIFIC', membership_ids: [ctx.person(OWNER).membershipId] },
        min_approvals: 1,
        sla_working_hours: 24,
        on_timeout: 'REMIND',
      },
    ],
    terminal: { approved: 'upholdStaffScoreResponse', returned: 'returnStaffScoreResponse', rejected: 'keepStaffScore' },
  };
  let draft = versions.find((row) => row.business_type === BUSINESS_TYPE && row.status === 'Draft');
  if (draft === undefined) {
    const made = await ctx.attempt<CommandReply>(OWNER, 'POST', '/workflow-definitions', { business_type: BUSINESS_TYPE, definition });
    if (!made.ok) {
      ctx.warn(`the approval workflow of ${BUSINESS_TYPE} could not be drafted (HTTP ${made.status} ${String(made.json.code ?? '')}): the approval inbox of the phone stays empty`);
      return false;
    }
    draft = { id: made.json.resource_id, version: made.json.resource_version };
  }
  const published = await ctx.attempt<CommandReply>(PUBLISHER, 'POST', `/workflow-definitions/${String(draft.id)}/publish`, { reason: 'Phản hồi về điểm đánh giá do lãnh đạo đơn vị xem xét qua quy trình duyệt' }, { version: Number(draft.version) });
  if (!published.ok) ctx.warn(`the approval workflow of ${BUSINESS_TYPE} could not be published (HTTP ${published.status} ${String(published.json.code ?? '')}): the approval inbox of the phone stays empty`);
  return published.ok;
}

/** The officer answers their score of a locked period, once: the answer waits for the owner in the approval inbox. */
async function respond(ctx: SeedContext): Promise<void> {
  const mine = await ctx.get<{ items: Obj[] }>(OFFICER, '/me/staff-scores', { limit: 5 });
  const line = mine.items.find((item) => item.period_status === 'LOCKED');
  if (line === undefined) {
    ctx.warn(`${OFFICER} has no line in a locked scoring period: nothing to answer, the approval inbox of the phone stays empty`);
    return;
  }
  const detail = await ctx.get<Obj>(OFFICER, `/staff-score-lines/${String(line.id)}`);
  const responses = Array.isArray(detail.responses) ? (detail.responses as Obj[]) : [];
  if (responses.some((one) => one.status === 'OPEN')) return;
  const sent = await ctx.attempt<CommandReply>(OFFICER, 'POST', `/staff-score-lines/${String(line.id)}/responses`, {
    body: 'Đề nghị xem xét lại điểm của việc lập hồ sơ: việc bị trả lại do thay đổi mẫu biểu giữa kỳ, không do chất lượng hồ sơ của người thực hiện.',
  });
  if (!sent.ok) {
    ctx.warn(`the response of ${OFFICER} to their score was refused (HTTP ${sent.status} ${String(sent.json.code ?? '')}): the approval inbox of the phone stays empty`);
    return;
  }
  ctx.record({ module: 'PWF', kind: 'score-response', id: String(sent.json.resource_id), code: BUSINESS_TYPE, note: 'waits for the owner in the approval inbox', screen: 'MOB-23' });
}

export async function seedClipPublicApprovals(ctx: SeedContext): Promise<void> {
  await ctx.step('ADM', `the approval workflow of ${BUSINESS_TYPE}, and a response that waits for the person of the phone (MOB-23, MOB-24)`, async () => {
    const ready = await tolerate(ctx, `the approval workflow of ${BUSINESS_TYPE}`, () => ensureWorkflow(ctx));
    if (ready === true) await tolerate(ctx, 'the response of the officer to their score', () => respond(ctx));
  });
}
