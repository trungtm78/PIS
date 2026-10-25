import { randomUUID } from 'node:crypto';
import { BidConflictStore } from '../src/bid-conflict-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { DEPARTMENT, PROVINCE, everything, nothing, onProjects, seedAs, seedBidPackage, seedContractor } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const conflicts = new BidConflictStore();
const E1 = 2;
const E2 = 3;
const APPROVER = 4;
const REASON = 'The relation was examined and it does not affect the evaluation.';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = E1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error('expected the database to refuse');
};

const declare = (seeded: SeededPackage, body: { hasConflict: boolean; relationText?: string; contractorId?: string }, member = E1, scope: ScopeBuilder = everything) =>
  as((tx) => conflicts.declare(tx, { packageId: seeded.packageId, ...body }, memberId(member), scope), member);

const decide = (id: string, version: number, decision: string, reason = REASON, member = APPROVER, scope: ScopeBuilder = everything) =>
  as((tx) => conflicts.decide(tx, id, version, decision, reason, memberId(member), scope), member);

const row = async (id: string) =>
  (
    await owner<{ decision: string | null; decided_by: string | null; decision_reason: string | null; decided_at: string | null; version: string; has_conflict: boolean; relation_text: string | null; contractor_id: string | null }>(
      'select decision, decided_by, decision_reason, decided_at::text, version::text, has_conflict, relation_text, contractor_id from machvon.bid_conflict_declaration where id = $1::uuid',
      [id],
    )
  )[0];

describe('the declaration of conflict of interest (ST-BID-004)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
    ]);
    for (const n of [1, E1, E2, APPROVER]) await harness.seedMembership(TENANT_A, n, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('declareConflictOfInterest', () => {
    it('records a declaration of no conflict, and a conflict with the contractor it is with', async () => {
      const seeded = await seedBidPackage(harness);
      const contractorId = await seedContractor(harness);
      const clear = await declare(seeded, { hasConflict: false });
      expect(clear).toMatchObject({ packageId: seeded.packageId, packageCode: seeded.packageCode, projectId: seeded.projectId, hasConflict: false, contractorId: null, version: 1 });
      expect(await row(clear.id)).toMatchObject({ has_conflict: false, relation_text: null, contractor_id: null, decision: null, version: '1' });
      const conflict = await declare(seeded, { hasConflict: true, relationText: '  The director is my cousin.  ', contractorId }, E2);
      expect(conflict).toMatchObject({ hasConflict: true, contractorId, version: 1 });
      expect(await row(conflict.id)).toMatchObject({ has_conflict: true, relation_text: 'The director is my cousin.', contractor_id: contractorId, decision: null });
    });

    it('records a conflict against the whole package when no contractor is named', async () => {
      const seeded = await seedBidPackage(harness);
      const made = await declare(seeded, { hasConflict: true, relationText: 'I hold shares in several of the bidders.' });
      expect(made.contractorId).toBeNull();
    });

    it('refuses a second declaration of the same member for the same package (422 ALREADY_DECLARED), and lets another member and another package declare', async () => {
      const seeded = await seedBidPackage(harness);
      await declare(seeded, { hasConflict: false });
      expect(await refusal(declare(seeded, { hasConflict: true, relationText: 'Changed my mind about it.' }))).toMatchObject({ code: 'ALREADY_DECLARED', status: 422 });
      expect(await declare(seeded, { hasConflict: false }, E2)).toMatchObject({ version: 1 });
      expect(await declare(await seedBidPackage(harness), { hasConflict: false })).toMatchObject({ version: 1 });
    });

    it('refuses a conflict without its relation in words, a relation that is too long, and a declaration of no conflict that carries a relation or a contractor (422 VALIDATION_FAILED)', async () => {
      const seeded = await seedBidPackage(harness);
      const contractorId = await seedContractor(harness);
      expect(await refusal(declare(seeded, { hasConflict: true }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'relation_text' });
      expect(await refusal(declare(seeded, { hasConflict: true, relationText: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'relation_text' });
      expect(await refusal(declare(seeded, { hasConflict: true, relationText: 'x'.repeat(2001) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'relation_text' });
      expect(await refusal(declare(seeded, { hasConflict: false, relationText: 'A relation I do not have.' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'relation_text' });
      expect(await refusal(declare(seeded, { hasConflict: false, contractorId }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
      expect(await refusal(declare(seeded, { hasConflict: true, relationText: 'A relation with nobody.', contractorId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
      expect(Number((await owner<{ n: string }>('select count(*)::text as n from machvon.bid_conflict_declaration where package_id = $1::uuid', [seeded.packageId]))[0]?.n)).toBe(0);
    });

    it('refuses a package outside the scope with 404, and a package that has no tender yet with 409 PACKAGE_STATE_INVALID', async () => {
      const seeded = await seedBidPackage(harness);
      expect(await refusal(declare(seeded, { hasConflict: false }, E1, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(declare(seeded, { hasConflict: false }, E1, onProjects(randomUUID())))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      for (const status of ['DRAFT', 'IN_REVIEW', 'SUPERSEDED', 'CANCELLED']) {
        expect(await refusal(declare(await seedBidPackage(harness, { status }), { hasConflict: false }))).toMatchObject({ code: 'PACKAGE_STATE_INVALID', status: 409, extensions: { package_status: status } });
      }
    });
  });

  describe('decideConflictOfInterest', () => {
    const conflicted = async (options: { contractorId?: string } = {}) => {
      const seeded = await seedBidPackage(harness);
      const made = await declare(seeded, { hasConflict: true, relationText: 'The director is my cousin.', ...options });
      return { seeded, made };
    };

    it('decides ALLOWED, RECUSED or BLOCKED with the words, by someone else, and bumps the version (AC-ST-BID-004-2)', async () => {
      for (const decision of ['ALLOWED', 'RECUSED', 'BLOCKED'] as const) {
        const { seeded, made } = await conflicted();
        const decided = await decide(made.id, 1, decision, `  ${REASON}  `);
        expect(decided).toMatchObject({ id: made.id, packageId: seeded.packageId, packageCode: seeded.packageCode, projectId: seeded.projectId, memberId: memberId(E1), decision, previousDecision: null, version: 2, reportsReopened: 0 });
        expect(await row(made.id)).toMatchObject({ decision, decided_by: memberId(APPROVER), decision_reason: REASON, version: '2' });
        expect((await row(made.id))?.decided_at).not.toBeNull();
      }
    });

    it('refuses the member who declared (403 SELF_APPROVAL_DENIED) and writes nothing', async () => {
      const { made } = await conflicted();
      expect(await refusal(decide(made.id, 1, 'ALLOWED', REASON, E1))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await row(made.id)).toMatchObject({ decision: null, version: '1' });
    });

    it('refuses a stale version (409 VERSION_CONFLICT) before anything else', async () => {
      const { made } = await conflicted();
      expect(await refusal(decide(made.id, 7, 'ALLOWED', REASON, E1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    });

    it('refuses a declaration of no conflict (422 NO_CONFLICT_DECLARED), an unknown decision and reasons that are too short or too long (422 VALIDATION_FAILED)', async () => {
      const seeded = await seedBidPackage(harness);
      const clear = await declare(seeded, { hasConflict: false });
      expect(await refusal(decide(clear.id, 1, 'ALLOWED'))).toMatchObject({ code: 'NO_CONFLICT_DECLARED', status: 422 });
      const { made } = await conflicted();
      expect(await refusal(decide(made.id, 1, 'FORGIVEN'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(decide(made.id, 1, 'ALLOWED', 'Too short.'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_reason' });
      expect(await refusal(decide(made.id, 1, 'ALLOWED', `${'x'.repeat(19)}   `))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_reason' });
      expect(await refusal(decide(made.id, 1, 'ALLOWED', 'x'.repeat(2001)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_reason' });
      expect(await row(made.id)).toMatchObject({ decision: null, version: '1' });
    });

    it('refuses a declaration outside the scope of the decider with 404, and one that does not exist', async () => {
      const { made } = await conflicted();
      expect(await refusal(decide(made.id, 1, 'ALLOWED', REASON, APPROVER, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(decide(randomUUID(), 1, 'ALLOWED'))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('takes a decision again under the new version, and says what it replaced', async () => {
      const { made } = await conflicted();
      await decide(made.id, 1, 'ALLOWED');
      const again = await decide(made.id, 2, 'RECUSED', 'New facts came to light about the relation.');
      expect(again).toMatchObject({ decision: 'RECUSED', previousDecision: 'ALLOWED', version: 3 });
    });

    it('takes the member out of the sign-off of the evaluation reports that are not issued, and a fully signed report goes back to a draft', async () => {
      const { seeded, made } = await conflicted();
      const other = memberId(E2);
      const report = async (status: string, signed: unknown[]): Promise<string> => {
        const id = randomUUID();
        await seedAs(harness, [
          [
            `insert into machvon.evaluation_report (tenant_id, id, package_id, criteria_version_id, summary_json, status, signed_off_by, report_document_id, created_by, updated_by)
             values ($1, $2, $3, $4, '{}'::jsonb, $5, $6::jsonb, $8, $7, $7)`,
            [TENANT_A, id, seeded.packageId, randomUUID(), status, JSON.stringify(signed), memberId(1), status === 'ISSUED' ? randomUUID() : null],
          ],
        ]);
        return id;
      };
      const draft = await report('DRAFT', [{ membership_id: memberId(E1), signed_at: '2026-11-13T01:00:00Z' }, other]);
      const signed = await report('SIGNED_OFF', [memberId(E1), { membership_id: other }]);
      const untouched = await report('DRAFT', [{ membership_id: other }]);
      const issued = await report('ISSUED', [memberId(E1)]);
      const decided = await decide(made.id, 1, 'RECUSED');
      expect(decided.reportsReopened).toBe(2);
      const state = async (id: string) => (await owner<{ status: string; signed_off_by: unknown[]; version: string }>('select status, signed_off_by, version::text from machvon.evaluation_report where id = $1::uuid', [id]))[0];
      expect(await state(draft)).toMatchObject({ status: 'DRAFT', signed_off_by: [other], version: '2' });
      expect(await state(signed)).toMatchObject({ status: 'DRAFT', signed_off_by: [{ membership_id: other }], version: '2' });
      expect(await state(untouched)).toMatchObject({ status: 'DRAFT', signed_off_by: [{ membership_id: other }], version: '1' });
      expect(await state(issued)).toMatchObject({ status: 'ISSUED', signed_off_by: [memberId(E1)], version: '1' });
    });

    it('leaves the sign-off alone when the conflict is allowed', async () => {
      const { seeded, made } = await conflicted();
      await seedAs(harness, [
        [
          `insert into machvon.evaluation_report (tenant_id, id, package_id, criteria_version_id, summary_json, status, signed_off_by, created_by, updated_by)
           values ($1, $2, $3, $4, '{}'::jsonb, 'DRAFT', $5::jsonb, $6, $6)`,
          [TENANT_A, randomUUID(), seeded.packageId, randomUUID(), JSON.stringify([memberId(E1)]), memberId(1)],
        ],
      ]);
      expect((await decide(made.id, 1, 'ALLOWED')).reportsReopened).toBe(0);
      expect((await owner<{ signed_off_by: unknown[] }>('select signed_off_by from machvon.evaluation_report where package_id = $1::uuid', [seeded.packageId]))[0]?.signed_off_by).toEqual([memberId(E1)]);
    });
  });

  describe('reading the declarations', () => {
    it('shows whoever decides every declaration of the package, with the names and what each means, and a member only their own', async () => {
      const seeded = await seedBidPackage(harness);
      const contractorId = await seedContractor(harness, { name: 'Cao Bang Builders' });
      const clear = await declare(seeded, { hasConflict: false }, E1);
      const conflict = await declare(seeded, { hasConflict: true, relationText: 'My brother works for them.', contractorId }, E2);
      await decide(conflict.id, 1, 'RECUSED');
      const all = await as((tx) => conflicts.list(tx, seeded.packageId, { membershipId: memberId(APPROVER), mayDecide: true }, everything), APPROVER);
      expect(all.map((line) => [line.id, line.member.membershipId, line.standing])).toEqual([
        [clear.id, memberId(E1), 'CLEAR'],
        [conflict.id, memberId(E2), 'RECUSED'],
      ]);
      expect(all[1]).toMatchObject({
        hasConflict: true,
        relationText: 'My brother works for them.',
        contractor: { id: contractorId, legalName: 'Cao Bang Builders' },
        decision: 'RECUSED',
        decisionReason: REASON,
        decidedBy: { membershipId: memberId(APPROVER) },
        version: 2,
      });
      expect(all[0]?.member.displayName).toBe('User 2');
      const own = await as((tx) => conflicts.list(tx, seeded.packageId, { membershipId: memberId(E2), mayDecide: false }, everything), E2);
      expect(own.map((line) => line.id)).toEqual([conflict.id]);
      const nobody = await as((tx) => conflicts.list(tx, seeded.packageId, { membershipId: memberId(1), mayDecide: false }, everything), 1);
      expect(nobody).toEqual([]);
    });

    it('shows nothing of a package outside the scope', async () => {
      const seeded = await seedBidPackage(harness);
      await declare(seeded, { hasConflict: false });
      expect(await as((tx) => conflicts.list(tx, seeded.packageId, { membershipId: memberId(APPROVER), mayDecide: true }, nothing), APPROVER)).toEqual([]);
      expect(await as((tx) => conflicts.list(tx, seeded.packageId, { membershipId: memberId(APPROVER), mayDecide: true }, onProjects(seeded.projectId)), APPROVER)).toHaveLength(1);
    });

    it('answers what a member declared for the reads of the proposals', async () => {
      const seeded = await seedBidPackage(harness);
      expect(await as((tx) => conflicts.declarationOf(tx, seeded.packageId, memberId(E1)))).toBeUndefined();
      await declare(seeded, { hasConflict: true, relationText: 'A relation with the whole field.' });
      expect(await as((tx) => conflicts.declarationOf(tx, seeded.packageId, memberId(E1)))).toEqual({ hasConflict: true, decision: null, contractorId: null });
    });
  });

  describe('what the database keeps', () => {
    it('keeps what the member declared, and only a decision follows', async () => {
      const seeded = await seedBidPackage(harness);
      const contractorId = await seedContractor(harness);
      const made = await declare(seeded, { hasConflict: true, relationText: 'The director is my cousin.', contractorId });
      for (const change of [`package_id = '${randomUUID()}'`, `user_id = '${memberId(E2)}'`, 'has_conflict = false', `relation_text = 'Never mind.'`, 'contractor_id = null', `declared_at = now() + interval '1 day'`]) {
        expect(await databaseRefusal(owner(`update machvon.bid_conflict_declaration set ${change} where id = $1::uuid`, [made.id]))).toMatch(/keeps what the member declared|violates/);
      }
      expect(await databaseRefusal(as((tx) => tx.query('delete from machvon.bid_conflict_declaration where id = $1::uuid', [made.id])))).toContain('permission denied');
    });

    it('refuses a conflict without its relation, a clear declaration that carries a decision, a decision without its words or its maker, and a decision by the member themselves', async () => {
      const seeded = await seedBidPackage(harness);
      const insert = (columns: string, values: string, member = E1) =>
        owner(`insert into machvon.bid_conflict_declaration (tenant_id, id, package_id, user_id, created_by, updated_by, ${columns}) values ($1, $2, $3, $4, $4, $4, ${values})`, [TENANT_A, randomUUID(), seeded.packageId, memberId(member)]);
      expect(await databaseRefusal(insert('has_conflict', 'true'))).toContain('bid_conflict_relation_chk');
      expect(await databaseRefusal(insert('has_conflict, relation_text', `true, ' '`))).toContain('bid_conflict_relation_chk');
      expect(await databaseRefusal(insert('has_conflict, decision', `false, 'ALLOWED'`))).toContain('bid_conflict_decided_chk');
      expect(await databaseRefusal(insert('has_conflict, decision, decided_by, decided_at, decision_reason', `false, 'ALLOWED', '${memberId(APPROVER)}', now(), 'A reason that is long enough.'`))).toContain('bid_conflict_none_chk');
      expect(await databaseRefusal(insert('has_conflict, relation_text, decision', `true, 'A relation.', 'ALLOWED'`))).toContain('bid_conflict_decided_chk');
      expect(await databaseRefusal(insert('has_conflict, relation_text, decision, decided_by, decided_at, decision_reason', `true, 'A relation.', 'ALLOWED', '${memberId(E1)}', now(), 'A reason that is long enough.'`))).toContain('bid_conflict_declaration_decision_chk');
      expect(await databaseRefusal(insert('has_conflict, relation_text, decision, decided_by, decided_at, decision_reason', `true, 'A relation.', 'ALLOWED', '${memberId(APPROVER)}', now(), 'Short'`))).toContain('bid_conflict_reason_chk');
    });
  });
});
