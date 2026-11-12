import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { CHECKER, MAKER } from '../procurement-finance/shared.ts';
import { seedOpenData } from './open-data.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-public-contractor-portal` and `clip-ent-contractor-portal`: the vendor portal (VND-16) has a contractor to open on.
 * Real commands of the registry: the officer proposes a contact of a verified contractor (with the paper that proves the contact), a second person approves it (which makes the invited guest),
 * the officer puts two requests to the contractor (information, a certificate). The contractor accepting the invitation is an act of its own identity provider: the stack stands in for it
 * (`ctx.bindPortalAccount`), the guest account `contractorUser` of the docs people becomes the guest of that contractor; it answers one of the requests through the portal, as the contractor would.
 */

interface PortalTexts {
  contactName: string;
  contactEmail: string;
  contactPaper: string;
  approveNote: string;
  requests: Array<{ kind: string; title: string; body: string; dueInDays: number }>;
  answer: string;
}

function textsOf(): PortalTexts {
  const plan = clipPlan() as unknown as { texts?: Record<string, string> } | undefined;
  const table = plan?.texts ?? {};
  const read = (key: string): string => {
    const value = table[key];
    if (value === undefined) throw new Error(`the text ${key} is not in the dataset (is CLIP_PLAN_FILE set?)`);
    return value;
  };
  return {
    contactName: read('portal.contactName'),
    contactEmail: read('portal.contactEmail'),
    contactPaper: read('portal.contactPaper'),
    approveNote: read('portal.approveNote'),
    requests: [
      { kind: 'INFORMATION', title: read('portal.request1.title'), body: read('portal.request1.body'), dueInDays: 10 },
      { kind: 'CERTIFICATE_UPLOAD', title: read('portal.request2.title'), body: read('portal.request2.body'), dueInDays: 21 },
    ],
    answer: read('portal.answer'),
  };
}

export async function seedClipContractorPortal(ctx: SeedContext): Promise<void> {
  if (clipPlan() === undefined) {
    ctx.warn('no clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  // The last group of both datasets: the open-data portal and the baseline the budget of the customer measures are made after everything they read.
  await seedOpenData(ctx);
  const texts = textsOf();
  const contractors = await ctx.list<Obj>(MAKER, '/resources/contractor');
  const contractor = contractors.find((row) => String(row.verification_status) === 'VERIFIED');
  if (contractor === undefined) {
    ctx.warn('no verified contractor: the vendor portal has nobody to be opened for');
    return;
  }
  const contractorId = String(contractor.id);
  const invitations = await ctx.list<Obj>(MAKER, '/vendor/portal/invitations');
  const known = invitations.find((row) => String(row.contractor_id) === contractorId && String(row.contact_email) === texts.contactEmail);
  await ctx.step('VND', `portal invitation for ${String(contractor.legal_name)}`, async () => {
    if (known !== undefined) return;
    const proposed = await ctx.command(MAKER, '/vendor/portal/invitations', { contractor_id: contractorId, contact_email: texts.contactEmail, contact_name: texts.contactName, contact_basis: 'REPRESENTATIVE_LETTER', basis_reference: texts.contactPaper });
    await ctx.command(CHECKER, `/vendor/portal/invitations/${proposed.resource_id}/approval`, { note: texts.approveNote }, { version: proposed.resource_version });
  });
  const bound = await ctx.bindPortalAccount('contractorUser', String(contractor.tax_identifier));
  if (!bound) {
    ctx.warn(`the guest account contractorUser could not be bound to ${String(contractor.legal_name)}: is the stack the docs stack of this branch?`);
    return;
  }
  const requests = await ctx.list<Obj>(MAKER, '/vendor/portal/requests');
  const asked = new Set(requests.filter((row) => String(row.contractor_id) === contractorId).map((row) => String(row.title)));
  const made: CommandReply[] = [];
  for (const request of texts.requests) {
    if (asked.has(request.title)) continue;
    made.push(await ctx.command(MAKER, `/vendor/contractors/${contractorId}/portal-requests`, { kind: request.kind, title: request.title, body: request.body, due_on: ctx.day(request.dueInDays) }));
  }
  const first = made[0];
  if (first !== undefined) {
    await ctx.step('VND', 'the contractor answers the first request through the portal', async () => {
      await ctx.attempt('contractorUser', 'POST', `/portal/requests/${first.resource_id}/response`, { text: texts.answer }, { version: first.resource_version });
    });
  }
  ctx.record({ module: 'VND', screen: 'VND-16', kind: 'portal-account', id: contractorId, code: String(contractor.legal_name), note: `${made.length} requests, guest contractorUser` });
}
