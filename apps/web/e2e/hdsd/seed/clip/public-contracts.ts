import { vndMillions } from '../context.ts';
import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { PLANS, packageOf, projectOf } from '../procurement-finance/bid.ts';
import type { PackageSpec } from '../procurement-finance/bid.ts';
import { seedPlans, seedTenders } from '../procurement-finance/bid.ts';
import { CHECKER, LEADER, MAKER, contractorsByNumber, paper } from '../procurement-finance/shared.ts';
import { clipText } from './plan.ts';

/**
 * Group `clip-public-contracts`: the tenders of the five projects of the guide (the plans were approved by the leader on an issued decision, the proposals are
 * sealed until the opening, the result is approved and the package awarded), then the contract of each awarded package taken to ACTIVE through the real
 * lifecycle: the officer drafts it, the bill of quantities and the performance guarantee are registered (the owner verifies the guarantee, a second person), the leader
 * submits it for review, the owner signs and activates it (the creator and the submitter never do). On the first contract a claim and a periodic
 * evaluation of the contractor are recorded and decided by a second person.
 *
 * Not done by this group (see docs/clip-data.md): measurements, payments and advances need four published payment forms (templates) that no seed makes yet.
 */

const CONTRACT_TYPE = 'UNIT_PRICE';
/** Only a joint venture has parties (the lead and at least one member), and a payment is made to a party: so the contracts that are paid (and take the advance) are joint ventures. */
export const ADVANCE_PACKAGE = 'DT205-XL02';
export const JOINT_VENTURE_PACKAGES: readonly string[] = ['DT205-XL01', ADVANCE_PACKAGE, 'NN031-XL01'];
const ADVANCE_CATEGORY: Record<PackageSpec['category'], string> = { CONSTRUCTION: 'CONSTRUCTION', EQUIPMENT: 'EQUIPMENT', CONSULTING: 'CONSULTING', OTHER: 'OTHER' };

async function contractOf(ctx: SeedContext, code: string): Promise<Obj | undefined> {
  return ctx.find(MAKER, '/resources/contract', (row) => row.code === code);
}

async function toActive(ctx: SeedContext, spec: PackageSpec, projectCode: string): Promise<string | undefined> {
  const contractors = await contractorsByNumber(ctx);
  const winner = contractors.get(spec.bidders?.[0] ?? -1);
  const pack = await packageOf(ctx, spec.code);
  const project = await projectOf(ctx, projectCode);
  if (winner === undefined || pack === undefined || project === undefined) {
    ctx.warn(`the contract of ${spec.code}: contractor, package or project is missing`);
    return undefined;
  }
  const code = `HD-${spec.code}`;
  const existing = await contractOf(ctx, code);
  if (existing !== undefined && existing.status === 'ACTIVE') return String(existing.id);
  const valueVnd = vndMillions(spec.awardMillions ?? spec.millions);
  let id: string;
  let version: number;
  if (existing === undefined) {
    const document = await paper(ctx, { symbol: `HD-${spec.code}/2026`, title: clipText('contract.paper', spec.code), docType: 'HD', sender: String(winner.legal_name), issuedOn: ctx.day(-60) });
    const made = await ctx.command(MAKER, '/contracts', {
      project_id: String(project.id),
      package_id: String(pack.id),
      contractor_id: String(winner.id),
      code,
      title: clipText('contract.title', spec.code),
      type: CONTRACT_TYPE,
      advance_category: ADVANCE_CATEGORY[spec.category],
      contract_value_vnd: valueVnd,
      completion_due: ctx.day(spec.days ?? 300),
      document_version_id: document.versionId,
      requires_quality_acceptance: false,
      is_joint_venture: JOINT_VENTURE_PACKAGES.includes(spec.code),
    });
    id = made.resource_id;
    version = made.resource_version;
  } else {
    id = String(existing.id);
    version = Number(existing.version);
  }
  if (JOINT_VENTURE_PACKAGES.includes(spec.code)) {
    // A joint venture has a lead and at least one more member: the runner-up of the tender is the partner (70 and 30 per cent of the work).
    const partner = contractors.get(spec.bidders?.[1] ?? -1);
    const leadValue = String(Math.round(Number(valueVnd) * 0.7));
    const parties =
      partner === undefined
        ? [{ contractor_id: String(winner.id), role: 'LEAD', share_pct: '100', work_value_vnd: valueVnd }]
        : [
            { contractor_id: String(winner.id), role: 'LEAD', share_pct: '70', work_value_vnd: leadValue },
            { contractor_id: String(partner.id), role: 'MEMBER', share_pct: '30', work_value_vnd: String(Number(valueVnd) - Number(leadValue)) },
          ];
    await ctx.attempt(MAKER, 'POST', `/contracts/${id}/parties`, { parties }, { version });
    version = Number((await ctx.get<Obj>(MAKER, `/resources/contract/${id}`)).version);
  }
  // The bill of quantities: one line that adds up to the value of the contract.
  const revision = (await ctx.list<Obj>(MAKER, '/resources/contract_revision')).find((row) => String(row.contract_id) === id);
  if (revision !== undefined) {
    const boq = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contract-revisions/${String(revision.id)}/boq-lines`, { mode: 'REPLACE', lines: [{ business_key: 'B01', description: clipText('contract.boq', spec.code), unit_code: 'M3', quantity: '1000', unit_price: String(Number(valueVnd) / 1000) }] }, { version: Number(revision.version) });
    if (!boq.ok) ctx.warn(`the bill of quantities of ${spec.code} was not saved`);
  }
  if (spec.category !== 'CONSULTING') {
    const evidence = await paper(ctx, { symbol: `BL-${spec.code}/2026`, title: clipText('guarantee.paper', spec.code), docType: 'BL', sender: clipText('guarantee.issuer'), issuedOn: ctx.day(-58) });
    const guarantee = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${id}/guarantees`, {
      kind: 'PERFORMANCE',
      issuer: clipText('guarantee.issuer'),
      guarantee_no: `BL-${spec.code}`,
      amount_vnd: String(Math.round(Number(valueVnd) * 0.05)),
      valid_from: ctx.day(-58),
      expires_at: new Date(Date.parse(`${ctx.day(400)}T00:00:00+07:00`)).toISOString(),
      document_version_id: evidence.versionId,
    });
    if (guarantee.ok) await ctx.attempt(CHECKER, 'POST', `/guarantees/${guarantee.json.resource_id}/verify`, { outcome: 'VERIFIED', method: clipText('guarantee.method'), evidence_document_version_id: evidence.versionId }, { version: guarantee.json.resource_version });
    const current = await ctx.get<Obj>(MAKER, `/resources/contract/${id}`);
    version = Number(current.version);
  }
  version = Number((await ctx.get<Obj>(MAKER, `/resources/contract/${id}`)).version);
  const reviewed = await ctx.attempt<CommandReply>(LEADER, 'POST', `/contracts/${id}/submit-review`, { note: clipText('contract.review') }, { version });
  if (!reviewed.ok) return undefined;
  const signedCopy = await paper(ctx, { symbol: `HD-KY-${spec.code}/2026`, title: clipText('contract.signedPaper', spec.code), docType: 'HD', sender: String(winner.legal_name), issuedOn: ctx.day(-55) });
  const signed = await ctx.attempt<CommandReply>(CHECKER, 'POST', `/contracts/${id}/sign`, { signed_on: ctx.day(-55), signed_document_version_id: signedCopy.versionId }, { version: reviewed.json.resource_version });
  if (!signed.ok) return undefined;
  const activated = await ctx.attempt<CommandReply>(CHECKER, 'POST', `/contracts/${id}/activate`, { decision: 'approve', reason: clipText('contract.activate'), evidence_ids: [], effective_from: ctx.day(-54) }, { version: signed.json.resource_version });
  return activated.ok ? id : undefined;
}

async function claimAndEvaluation(ctx: SeedContext, contractId: string): Promise<void> {
  await ctx.attempt(MAKER, 'POST', `/contracts/${contractId}/claims`, {
    claimant_side: 'CONTRACTOR',
    kind: 'EXTENSION_OF_TIME',
    title: clipText('claim.title'),
    event_description: clipText('claim.description'),
    event_on: ctx.day(-30),
    awareness_on: ctx.day(-29),
    claimed_days: 11,
  });
  const evaluation = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${contractId}/performance-evaluations`, {
    evaluation_kind: 'PERIODIC',
    period_label: '2026-Q3',
    score_quality: 88,
    score_schedule: 72,
    score_safety_env: 90,
    score_cooperation: 85,
    score_financial: 80,
  });
  if (evaluation.ok) await ctx.attempt(LEADER, 'POST', `/performance-evaluations/${evaluation.json.resource_id}/approve`, { note: clipText('evaluation.approve') }, { version: evaluation.json.resource_version });
}

export async function seedClipContracts(ctx: SeedContext): Promise<void> {
  await ctx.step('BID', 'procurement plans of the guide projects', () => seedPlans(ctx));
  await ctx.step('BID', 'tenders', () => seedTenders(ctx));
  let first: string | undefined;
  for (const plan of PLANS) {
    for (const spec of plan.packages) {
      if (spec.fate !== 'AWARDED' || spec.contract !== 'ACTIVE') continue;
      const id = await ctx.step('CTR', `contract of ${spec.code}`, () => toActive(ctx, spec, plan.project));
      if (id !== undefined) {
        ctx.record({ module: 'CTR', screen: 'CTR-01', kind: 'contract', id, code: `HD-${spec.code}`, note: 'ACTIVE' });
        first ??= id;
      }
    }
  }
  if (first !== undefined) await ctx.step('CTR', 'claim and evaluation', () => claimAndEvaluation(ctx, first));
}
