import { randomUUID } from 'node:crypto';
import { vietnamDateOf } from '@machvon/kernel';
import { applyBaseline, sealPack } from '../src/master-baseline';
import { DISBURSEMENT_DOMAIN, DISBURSEMENT_TERMS, GlossaryStore } from '../src/glossary-store';
import type { GlossaryTermInput } from '../src/glossary-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const glossary = new GlossaryStore();
const STEWARD = 1; // proposes
const OWNER = 2; // the owner of the domain, and the first tenant owner
const OUTSIDER = 3; // holds no ownership
const SECOND_OWNER = 4; // a tenant owner granted after OWNER
const WORKER = 9; // the actor of the baseline job
const LEFT = 5; // a membership that ended

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const DEFINITION = 'Giải ngân lũy kế từ đầu năm kế hoạch tới cuối kỳ báo cáo.';
let counter = 0;
const codeOf = (): string => {
  counter += 1;
  return `TERM_${counter}_${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
};
const input = (termCode: string, extra: Partial<GlossaryTermInput> = {}): GlossaryTermInput => ({
  termCode,
  termVi: 'Giải ngân lũy kế',
  definition: DEFINITION,
  formulaRef: 'ytd = SUM(paid)',
  domain: 'TESTING',
  ownerMembershipId: memberId(OWNER),
  ...extra,
});
const propose = (data: GlossaryTermInput, member = STEWARD, tenant = TENANT_A) => as(member, (tx) => glossary.propose(tx, data, memberId(member)), tenant);
const find = (id: string, tenant = TENANT_A) => as(OWNER, (tx) => glossary.find(tx, id), tenant);
const submit = (id: string, version: number, member = STEWARD) => as(member, (tx) => glossary.submit(tx, id, version, memberId(member)));
const decide = (id: string, version: number, decision: 'approve' | 'reject' | 'return', member = OWNER, reason = 'Reviewed by the owner') =>
  as(member, (tx) => glossary.decide(tx, id, version, decision, reason, memberId(member)));
const publish = (id: string, version: number, member = OWNER, on?: string) => as(member, (tx) => glossary.publish(tx, id, version, memberId(member), on));

/** A term of the steward carried to APPROVED (version 3) by the owner. */
async function approved(termCode: string, extra: Partial<GlossaryTermInput> = {}): Promise<string> {
  const created = await propose(input(termCode, extra));
  await submit(created.id, 1);
  await decide(created.id, 2, 'approve');
  return created.id;
}

describe('GlossaryStore (terms with an approval workflow, ST-MDM-008)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, STEWARD, 1);
      await harness.seedMembership(tenant, OWNER, 1);
    }
    await harness.seedMembership(TENANT_A, OUTSIDER, 1);
    await harness.seedMembership(TENANT_A, SECOND_OWNER, 1);
    await harness.seedMembership(TENANT_A, LEFT, 1, { status: 'Suspended' });
    await harness.seedRole(TENANT_A, 1, 'TENANT_OWNER', ['*'], 80);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OWNER, role: 1, kind: 'TENANT', from: '2026-01-01T00:00:00Z' },
      { n: 2, member: SECOND_OWNER, role: 1, kind: 'TENANT', from: '2026-02-01T00:00:00Z' },
    ]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('approval and supersession', () => {
    it('refuses the proposer, and the next revision published by the domain owner deprecates the previous one (AC-ST-MDM-008-1)', async () => {
      const termCode = 'GIAI_NGAN_YTD_AC1';
      // Revision 1 goes the whole way.
      const first = await propose(input(termCode));
      expect(first).toMatchObject({ version: 1, revision: 1 });
      await submit(first.id, 1);
      await decide(first.id, 2, 'approve');
      const r1 = await publish(first.id, 3);
      expect(r1).toMatchObject({ version: 4, deprecatedId: null });

      // Revision 2: the steward who made it cannot approve it; the owner of the domain can, and publishes it.
      const second = await propose(input(termCode, { definition: `${DEFINITION} Phiên bản hai.` }));
      expect(second.revision).toBe(2);
      expect(await find(second.id)).toMatchObject({ status: 'DRAFT', supersedesId: first.id });
      await submit(second.id, 1);
      expect(await refusal(decide(second.id, 2, 'approve', STEWARD))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await find(second.id)).toMatchObject({ status: 'IN_REVIEW', approvedBy: null, version: 2 });
      await decide(second.id, 2, 'approve');
      expect(await refusal(publish(second.id, 3, STEWARD))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const published = await publish(second.id, 3);
      expect(published.deprecatedId).toBe(first.id);

      expect(await find(second.id)).toMatchObject({ status: 'PUBLISHED', revision: 2, publishedBy: memberId(OWNER), approvedBy: memberId(OWNER), effectiveFrom: vietnamDateOf(new Date()) });
      expect(await find(first.id)).toMatchObject({ status: 'DEPRECATED', revision: 1 });
      const rows = await owner<{ status: string }>("select status from machvon.glossary_term where term_code = $1 and status = 'PUBLISHED'", [termCode]);
      expect(rows).toHaveLength(1);
    });

    it('starts a published term at the date it is given and keeps the term code to one PUBLISHED revision in the database', async () => {
      const id = await approved(codeOf());
      await publish(id, 3, OWNER, '2027-01-15');
      expect(await find(id)).toMatchObject({ status: 'PUBLISHED', effectiveFrom: '2027-01-15' });
      const termCode = (await find(id))?.termCode as string;
      const forged = owner(
        `insert into machvon.glossary_term (tenant_id, id, term_code, term_vi, definition, domain, owner_membership_id, revision, status, approved_by, decided_by, decided_at, published_by, published_at, effective_from, created_by, updated_by)
         values ($1, $2, $3, 'x', $4, 'TESTING', $5, 9, 'PUBLISHED', $6, $6, now(), $6, now(), '2027-02-01', $7, $7)`,
        [TENANT_A, randomUUID(), termCode, DEFINITION, memberId(OWNER), memberId(OWNER), memberId(STEWARD)],
      );
      await expect(forged).rejects.toMatchObject({ code: '23505' });
    });

    it('rejects a term for good, then accepts a new revision of the code that supersedes nothing', async () => {
      const termCode = codeOf();
      const first = await propose(input(termCode));
      await submit(first.id, 1);
      const rejected = await decide(first.id, 2, 'reject', OWNER, 'The definition is not the one in the decision');
      expect(rejected).toMatchObject({ status: 'REJECTED', version: 3 });
      expect(await find(first.id)).toMatchObject({ status: 'REJECTED', approvedBy: null, decidedBy: memberId(OWNER), decisionReason: 'The definition is not the one in the decision' });
      expect(await refusal(submit(first.id, 3))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'REJECTED->submit' });

      const again = await propose(input(termCode));
      expect(again.revision).toBe(2);
      expect((await find(again.id))?.supersedesId).toBeNull();
    });

    it('sends a returned term back to its author as a DRAFT with the reason, and the author submits it again', async () => {
      const created = await propose(input(codeOf()));
      await submit(created.id, 1);
      const returned = await decide(created.id, 2, 'return', OWNER, 'Add the legal basis first');
      expect(returned.status).toBe('DRAFT');
      expect(await find(created.id)).toMatchObject({ status: 'DRAFT', approvedBy: null, decisionReason: 'Add the legal basis first', decidedBy: memberId(OWNER) });
      await submit(created.id, 3);
      expect((await find(created.id))?.status).toBe('IN_REVIEW');
    });
  });

  describe('who may decide and publish', () => {
    it('refuses a person who is not the owner of the term with SCOPE_DENIED, and the term stays in review', async () => {
      const created = await propose(input(codeOf()));
      await submit(created.id, 1);
      expect(await refusal(decide(created.id, 2, 'approve', OUTSIDER))).toEqual({ code: 'SCOPE_DENIED', status: 403, detail: 'domain' });
      expect(await refusal(decide(created.id, 2, 'reject', SECOND_OWNER))).toEqual({ code: 'SCOPE_DENIED', status: 403, detail: 'domain' });
      expect(await find(created.id)).toMatchObject({ status: 'IN_REVIEW', version: 2, decidedBy: null });
      await decide(created.id, 2, 'approve');
      expect(await refusal(publish(created.id, 3, OUTSIDER))).toEqual({ code: 'SCOPE_DENIED', status: 403, detail: 'domain' });
      expect((await find(created.id))?.status).toBe('APPROVED');
    });

    it('tells the proposer SELF_APPROVAL_DENIED before it looks at the owner, whoever the owner is', async () => {
      const created = await propose(input(codeOf()));
      await submit(created.id, 1);
      expect(await refusal(decide(created.id, 2, 'approve', STEWARD))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(created.id, 2, 'reject', STEWARD))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    });

    it('refuses a decision on a term that is not in review, a stale version and an unknown or foreign term', async () => {
      const draft = await propose(input(codeOf()));
      expect(await refusal(decide(draft.id, 1, 'approve'))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'DRAFT->approve' });
      expect(await refusal(publish(draft.id, 1))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'DRAFT->publish' });
      await submit(draft.id, 1);
      expect(await refusal(submit(draft.id, 2))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'IN_REVIEW->submit' });
      await expect(decide(draft.id, 1, 'approve')).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await expect(submit(draft.id, 9)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await expect(publish(draft.id, 9)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(decide(randomUUID(), 1, 'approve'))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as(OWNER, (tx) => glossary.decide(tx, draft.id, 2, 'approve', 'Reviewed by the owner', memberId(OWNER)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(decide(draft.id, 2, 'approve', OWNER, 'no'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      await decide(draft.id, 2, 'approve');
      expect(await refusal(decide(draft.id, 3, 'approve'))).toEqual({ code: 'STAGE_TRANSITION_DENIED', status: 409, detail: 'APPROVED->approve' });
    });
  });

  describe('proposing', () => {
    it('refuses a code that already has an open proposal, whether it is a DRAFT, in review or approved (GLOSSARY_TERM_DUPLICATE)', async () => {
      const termCode = codeOf();
      const created = await propose(input(termCode));
      expect(await refusal(propose(input(termCode)))).toEqual({ code: 'GLOSSARY_TERM_DUPLICATE', status: 409 });
      await submit(created.id, 1);
      expect(await refusal(propose(input(termCode)))).toEqual({ code: 'GLOSSARY_TERM_DUPLICATE', status: 409 });
      await decide(created.id, 2, 'approve');
      expect(await refusal(propose(input(termCode)))).toEqual({ code: 'GLOSSARY_TERM_DUPLICATE', status: 409 });
      // The same code in another tenant is another term.
      expect((await propose(input(termCode), STEWARD, TENANT_B)).revision).toBe(1);
    });

    it('serialises two proposals of one code: one wins, the other is a duplicate', async () => {
      const termCode = codeOf();
      const results = await Promise.allSettled([propose(input(termCode)), propose(input(termCode))]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'GLOSSARY_TERM_DUPLICATE', status: 409 });
    });

    it('trims what it stores and refuses codes, texts and links that are malformed', async () => {
      const created = await propose(input(codeOf(), { termVi: '  Giải ngân  ', formulaRef: '   ', legalBasis: '  Luật Đầu tư công  ' }));
      expect(await find(created.id)).toMatchObject({ termVi: 'Giải ngân', formulaRef: null, legalBasis: 'Luật Đầu tư công', status: 'DRAFT', createdBy: memberId(STEWARD) });
      const bad = (extra: Partial<GlossaryTermInput>, detail: string) => expect(refusal(propose(input(codeOf(), extra)))).resolves.toEqual({ code: 'VALIDATION_FAILED', status: 422, detail });
      await bad({ termCode: 'lower_case' }, 'term_code');
      await bad({ termCode: '   ' }, 'term_code');
      await bad({ termCode: `A${'B'.repeat(80)}` }, 'term_code');
      await bad({ domain: 'not a domain' }, 'domain');
      await bad({ termVi: ' ' }, 'term_vi');
      await bad({ termVi: 'x'.repeat(301) }, 'term_vi');
      await bad({ definition: 'too short' }, 'definition');
      await bad({ definition: `${DEFINITION}\u0000` }, 'definition');
      await bad({ definition: 'x'.repeat(2001) }, 'definition');
      await bad({ formulaRef: 'x'.repeat(121) }, 'formula_ref');
      await bad({ legalBasis: 'x'.repeat(2001) }, 'legal_basis');
    });

    it('refuses an owner who is the proposer, who does not exist, who is another tenant, or whose membership ended', async () => {
      const bad = (member: string) => expect(refusal(propose(input(codeOf(), { ownerMembershipId: member })))).resolves.toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_membership_id' });
      await bad(memberId(STEWARD));
      await bad(memberId(STEWARD).toUpperCase());
      await bad(randomUUID());
      await bad(memberId(LEFT));
      await bad(memberId(OUTSIDER).replace(/.$/, '9'));
    });

    it('takes the supersedes link from the published revision, and refuses one that is not that revision or a domain that changes', async () => {
      const termCode = codeOf();
      const firstId = await approved(termCode);
      await publish(firstId, 3);
      expect(await refusal(propose(input(termCode, { supersedesId: randomUUID() })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'supersedes_id' });
      expect(await refusal(propose(input(termCode, { domain: 'OTHER_DOMAIN' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'domain' });
      const second = await propose(input(termCode, { supersedesId: firstId.toUpperCase() }));
      expect(await find(second.id)).toMatchObject({ revision: 2, supersedesId: firstId });
      // A new code names nothing to supersede.
      expect(await refusal(propose(input(codeOf(), { supersedesId: firstId })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'supersedes_id' });
    });
  });

  describe('listing', () => {
    it('filters by domain, status and code, newest first, in pages, inside the tenant', async () => {
      const domain = `LIST_${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
      const ids: string[] = [];
      for (let n = 0; n < 3; n += 1) ids.push((await propose(input(codeOf(), { domain }))).id);
      await submit(ids[0] as string, 1);
      const other = await propose(input(codeOf(), { domain: `${domain}_B` }));

      const all = await as(OWNER, (tx) => glossary.list(tx, { domain }, { limit: 50, after: undefined }));
      expect(all.map((row) => row.id)).toEqual([...ids].reverse());
      expect((await as(OWNER, (tx) => glossary.list(tx, { domain, status: 'IN_REVIEW' }, { limit: 50, after: undefined }))).map((row) => row.id)).toEqual([ids[0]]);
      expect((await as(OWNER, (tx) => glossary.list(tx, { termCode: all[0]?.termCode }, { limit: 50, after: undefined }))).map((row) => row.id)).toEqual([ids[2]]);
      expect((await as(OWNER, (tx) => glossary.list(tx, { domain: `${domain}_B` }, { limit: 50, after: undefined }))).map((row) => row.id)).toEqual([other.id]);

      const first = await as(OWNER, (tx) => glossary.list(tx, { domain }, { limit: 2, after: undefined }));
      const last = first[first.length - 1];
      const next = await as(OWNER, (tx) => glossary.list(tx, { domain }, { limit: 2, after: { code: last?.createdAt as string, id: last?.id as string } }));
      expect([...first, ...next].map((row) => row.id)).toEqual(all.map((row) => row.id));
      expect(await as(OWNER, (tx) => glossary.list(tx, { domain }, { limit: 50, after: undefined }), TENANT_B)).toEqual([]);
      expect(await refusal(as(OWNER, (tx) => glossary.list(tx, {}, { limit: 5, after: { code: 'not-a-time', id: randomUUID() } })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor' });
    });
  });

  describe('the disbursement terms to be signed', () => {
    const asWorker = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => as(WORKER, work, tenant);

    it('seeds the five terms in review for the tenant owner, and a user outside the capital owner scope is refused with SCOPE_DENIED and the terms stay IN_REVIEW (AC-ST-MDM-008-2)', async () => {
      const created = await asWorker((tx) => glossary.ensureDisbursementTerms(tx, memberId(WORKER)));
      expect(created).toBe(DISBURSEMENT_TERMS.length);
      const terms = await as(OWNER, (tx) => glossary.list(tx, { domain: DISBURSEMENT_DOMAIN }, { limit: 50, after: undefined }));
      expect(terms.map((term) => term.termCode).sort()).toEqual(DISBURSEMENT_TERMS.map((term) => term.termCode).sort());
      for (const term of terms) {
        expect(term).toMatchObject({ status: 'IN_REVIEW', revision: 1, ownerMembershipId: memberId(OWNER), createdBy: memberId(WORKER), approvedBy: null, publishedBy: null, effectiveFrom: null });
        expect(term.formulaRef).not.toBeNull();
        expect(term.legalBasis).toContain('D03');
      }

      // A user outside the capital owner scope cannot decide any of them; the terms stay in review.
      const target = terms[0] as (typeof terms)[number];
      expect(await refusal(decide(target.id, target.version, 'approve', OUTSIDER))).toEqual({ code: 'SCOPE_DENIED', status: 403, detail: 'domain' });
      expect(await refusal(decide(target.id, target.version, 'approve', SECOND_OWNER))).toEqual({ code: 'SCOPE_DENIED', status: 403, detail: 'domain' });
      // The job that seeded them proposed them: it decides nothing either.
      expect(await refusal(decide(target.id, target.version, 'approve', WORKER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const after = await as(OWNER, (tx) => glossary.list(tx, { domain: DISBURSEMENT_DOMAIN, status: 'IN_REVIEW' }, { limit: 50, after: undefined }));
      expect(after).toHaveLength(DISBURSEMENT_TERMS.length);
      expect(after.every((term) => term.version === 1)).toBe(true);
      expect(await as(OWNER, (tx) => glossary.definitionStatus(tx, DISBURSEMENT_DOMAIN))).toEqual({ status: 'PROPOSED_PENDING_SIGNOFF', missing: DISBURSEMENT_TERMS.map((term) => term.termCode) });
    });

    it('seeds nothing twice and nothing that was decided, and keeps the seed definitions inside the contract limits', async () => {
      expect(await asWorker((tx) => glossary.ensureDisbursementTerms(tx, memberId(WORKER)))).toBe(0);
      const terms = await as(OWNER, (tx) => glossary.list(tx, { domain: DISBURSEMENT_DOMAIN }, { limit: 50, after: undefined }));
      const rejected = terms.find((term) => term.termCode === 'GIAI_NGAN_PTD') as (typeof terms)[number];
      await decide(rejected.id, rejected.version, 'reject', OWNER, 'Waiting for the signed definition');
      expect(await asWorker((tx) => glossary.ensureDisbursementTerms(tx, memberId(WORKER)))).toBe(0);
      expect(await as(OWNER, (tx) => glossary.find(tx, rejected.id))).toMatchObject({ status: 'REJECTED' });
      for (const term of DISBURSEMENT_TERMS) {
        expect(term.definition.length).toBeGreaterThanOrEqual(20);
        expect(term.definition.length).toBeLessThanOrEqual(2000);
        expect(term.formulaRef.length).toBeLessThanOrEqual(120);
        expect(term.termCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    });

    it('is applied with the baseline of the platform, and the baseline applied again changes nothing', async () => {
      const before = await as(OWNER, (tx) => glossary.list(tx, { domain: DISBURSEMENT_DOMAIN }, { limit: 50, after: undefined }));
      await asWorker((tx) => applyBaseline(tx, sealPack('EMPTY', []), memberId(WORKER)));
      const again = await as(OWNER, (tx) => glossary.list(tx, { domain: DISBURSEMENT_DOMAIN }, { limit: 50, after: undefined }));
      expect(again.map((term) => term.id)).toEqual(before.map((term) => term.id));
    });

    it('seeds none for a tenant without an owner who is not the actor, and the terms arrive once the owner exists', async () => {
      expect(await asWorker((tx) => glossary.ensureDisbursementTerms(tx, memberId(WORKER)), TENANT_B)).toBe(0);
      // The only owner is the actor: nobody else could decide, so nothing is seeded.
      await harness.seedMembership(TENANT_B, WORKER, 1);
      await harness.seedRole(TENANT_B, 1, 'TENANT_OWNER', ['*'], 80);
      await harness.seedGrants(TENANT_B, [{ n: 1, member: WORKER, role: 1, kind: 'TENANT' }]);
      expect(await asWorker((tx) => glossary.ensureDisbursementTerms(tx, memberId(WORKER)), TENANT_B)).toBe(0);
      await harness.seedGrants(TENANT_B, [{ n: 2, member: OWNER, role: 1, kind: 'TENANT' }]);
      expect(await asWorker((tx) => applyBaseline(tx, sealPack('EMPTY', []), memberId(WORKER)), TENANT_B)).toEqual({ created: 0, superseded: 0, unchanged: 0 });
      const terms = await as(OWNER, (tx) => glossary.list(tx, { domain: DISBURSEMENT_DOMAIN }, { limit: 50, after: undefined }), TENANT_B);
      expect(terms).toHaveLength(DISBURSEMENT_TERMS.length);
      expect(terms.every((term) => term.ownerMembershipId === memberId(OWNER) && term.status === 'IN_REVIEW')).toBe(true);
    });

    it('signs the disbursement definitions only when every required term is published', async () => {
      // Tenant B: the owner approves and publishes all five seeded terms one after the other.
      const terms = await as(OWNER, (tx) => glossary.list(tx, { domain: DISBURSEMENT_DOMAIN }, { limit: 50, after: undefined }), TENANT_B);
      for (const [index, term] of terms.entries()) {
        await as(OWNER, (tx) => glossary.decide(tx, term.id, 1, 'approve', 'Signed by the capital owner', memberId(OWNER)), TENANT_B);
        await as(OWNER, (tx) => glossary.publish(tx, term.id, 2, memberId(OWNER)), TENANT_B);
        const status = await as(OWNER, (tx) => glossary.definitionStatus(tx, DISBURSEMENT_DOMAIN), TENANT_B);
        expect(status.status).toBe(index === terms.length - 1 ? 'SIGNED' : 'PROPOSED_PENDING_SIGNOFF');
        expect(status.missing).toHaveLength(terms.length - index - 1);
      }
      expect(await as(OWNER, (tx) => glossary.definitionStatus(tx, 'NO_SIGNOFF_DOMAIN'), TENANT_B)).toEqual({ status: 'PROPOSED_PENDING_SIGNOFF', missing: [] });
    });
  });

  describe('what the database holds whatever the store does', () => {
    it('does not change the content of a revision, nor move a status off the state machine, nor delete a term', async () => {
      const id = await approved(codeOf());
      await expect(owner("update machvon.glossary_term set definition = definition || ' changed' where id = $1::uuid", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.glossary_term set owner_membership_id = $2::uuid where id = $1::uuid", [id, memberId(OUTSIDER)])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.glossary_term set status = 'DRAFT' where id = $1::uuid", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.glossary_term set status = 'DEPRECATED' where id = $1::uuid", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(as(OWNER, (tx) => tx.query('delete from machvon.glossary_term where id = $1::uuid', [id]))).rejects.toMatchObject({ code: '42501' });
    });

    it('holds four-eyes and the facts of each status as CHECKs', async () => {
      const id = await approved(codeOf());
      const created = (await find(id))?.createdBy as string;
      await expect(owner('update machvon.glossary_term set approved_by = created_by where id = $1::uuid', [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner('update machvon.glossary_term set decided_by = created_by where id = $1::uuid', [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.glossary_term set status = 'PUBLISHED' where id = $1::uuid", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.glossary_term set status = 'PUBLISHED', published_by = $2::uuid, published_at = now(), effective_from = '2027-01-01' where id = $1::uuid", [id, created])).rejects.toMatchObject({
        code: '23514',
      });
      await expect(owner('update machvon.glossary_term set approved_by = null where id = $1::uuid', [id])).rejects.toMatchObject({ code: '23514' });
    });

    it('lets a revision supersede only an earlier revision of the same term and domain', async () => {
      const firstId = await approved(codeOf());
      const other = await approved(codeOf());
      const insert = (code: string, revision: number, supersedes: string, domain = 'TESTING') =>
        owner(
          `insert into machvon.glossary_term (tenant_id, id, term_code, term_vi, definition, domain, owner_membership_id, revision, status, supersedes_id, created_by, updated_by)
           values ($1, $2, $3, 'x', $4, $5, $6, $7, 'DRAFT', $8::uuid, $9, $9)`,
          [TENANT_A, randomUUID(), code, DEFINITION, domain, memberId(OWNER), revision, supersedes, memberId(STEWARD)],
        );
      const firstCode = (await find(firstId))?.termCode as string;
      await expect(insert(firstCode, 2, other)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(firstCode, 1, firstId)).rejects.toMatchObject({ code: '23514' });
      await expect(insert(firstCode, 2, firstId, 'ELSEWHERE')).rejects.toMatchObject({ code: '23514' });
      await expect(insert(firstCode, 2, randomUUID())).rejects.toMatchObject({ code: '23514' });
    });
  });
});
