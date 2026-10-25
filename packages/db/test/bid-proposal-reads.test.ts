import { randomUUID } from 'node:crypto';
import { BidConflictStore } from '../src/bid-conflict-store';
import { BidProposalReads } from '../src/bid-proposal-reads';
import type { ProposalViewer } from '../src/bid-proposal-reads';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { DEPARTMENT, OTHER_PROJECT_UNIT, PROVINCE, hoursFromNow, nothing, onProjects, seedBidPackage, seedContractor, seedProposal } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const reads = new BidProposalReads();
const conflicts = new BidConflictStore();
const CLERK = 1;
const E1 = 2;
const E2 = 3;
const APPROVER = 4;
const REASON = 'The relation was examined and decided by the authority.';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member: number): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);

/** The viewer is the member with the right to evaluate on the given projects and to receive on the others. */
const viewer = (member: number, rights: { evaluate?: ScopeBuilder; receive?: ScopeBuilder }): ProposalViewer => ({
  membershipId: memberId(member),
  evaluate: rights.evaluate ?? nothing,
  receive: rights.receive ?? nothing,
  now: new Date(),
});

const list = (v: ProposalViewer, packageId?: string, limit = 50, after?: { code: string; id: string }) => as((tx) => reads.list(tx, v, { packageId }, { limit, after }), CLERK);
const find = (v: ProposalViewer, id: string) => as((tx) => reads.find(tx, id, v), 1);

const declare = (seeded: SeededPackage, member: number, body: { hasConflict: boolean; relationText?: string; contractorId?: string }) =>
  as((tx) => conflicts.declare(tx, { packageId: seeded.packageId, ...body }, memberId(member), () => ({ sql: 'true', params: [] })), member);
const decide = (id: string, decision: string) => as((tx) => conflicts.decide(tx, id, 1, decision, REASON, memberId(APPROVER), () => ({ sql: 'true', params: [] })), APPROVER);

describe('what a caller sees of a sealed proposal (ST-BID-004, BR-BID-03)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_PROJECT_UNIT, path: '/u3/' },
    ]);
    for (const n of [CLERK, E1, E2, APPROVER]) await harness.seedMembership(TENANT_A, n, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  /** A package with a sealed proposal of NT-1 and a released one of NT-2 (by the clock of the database). */
  async function fixture() {
    const seeded = await seedBidPackage(harness);
    const nt1 = await seedContractor(harness, { name: 'NT-1' });
    const nt2 = await seedContractor(harness, { name: 'NT-2' });
    const sealed1 = await seedProposal(harness, seeded, nt1, { releasedAt: hoursFromNow(24), price: '900000000' });
    const sealed2 = await seedProposal(harness, seeded, nt2, { releasedAt: hoursFromNow(24), price: '950000000' });
    return { seeded, nt1, nt2, sealed1, sealed2 };
  }
  const release = (proposalId: string) => harness.owner(TENANT_A, [[`update machvon.proposal set access_released_at = now() - interval '1 hour' where id = $1::uuid`, [proposalId]]]);

  it('shows the clerk the metadata at all times: the contractor, the time it was received and the number of files, with neither the price nor a file (UAT-AC448 step 2)', async () => {
    const { seeded, nt1, sealed1 } = await fixture();
    const clerk = viewer(CLERK, { receive: onProjects(seeded.projectId) });
    const found = await find(clerk, sealed1.id);
    expect(found.kind).toBe('SEEN');
    if (found.kind !== 'SEEN') return;
    expect(found.line).toMatchObject({
      id: sealed1.id,
      package: { id: seeded.packageId, code: seeded.packageCode },
      project: { id: seeded.projectId },
      contractor: { id: nt1, legalName: 'NT-1' },
      revision: 1,
      status: 'RECEIVED',
      released: false,
      fileCount: 1,
      classification: 'CONFIDENTIAL',
      view: 'METADATA',
      bidPriceVnd: null,
    });
    expect(found.files).toEqual([]);
    await release(sealed1.id);
    const after = await find(clerk, sealed1.id);
    expect(after).toMatchObject({ kind: 'SEEN', line: { released: true, view: 'METADATA', bidPriceVnd: null }, files: [] });
  });

  it('hides a sealed proposal from a member of the evaluation team before the opening, however they declared (UAT-AC448 step 1: 404)', async () => {
    const { seeded, sealed1 } = await fixture();
    await declare(seeded, E1, { hasConflict: false });
    const evaluator = viewer(E1, { evaluate: onProjects(seeded.projectId) });
    expect(await find(evaluator, sealed1.id)).toEqual({ kind: 'HIDDEN' });
    expect((await list(evaluator, seeded.packageId)).lines).toEqual([]);
  });

  it('shows a member who declared the whole proposal from the opening: the price and the files, never where they are stored (UAT-AC448 step 3)', async () => {
    const { seeded, nt1, sealed1 } = await fixture();
    await declare(seeded, E1, { hasConflict: false });
    await release(sealed1.id);
    const evaluator = viewer(E1, { evaluate: onProjects(seeded.projectId) });
    const found = await find(evaluator, sealed1.id);
    expect(found).toMatchObject({ kind: 'SEEN', line: { id: sealed1.id, contractor: { id: nt1 }, released: true, view: 'FULL', standing: 'CLEAR', bidPriceVnd: '900000000' } });
    if (found.kind !== 'SEEN') return;
    expect(found.files).toHaveLength(1);
    expect(found.files[0]).toMatchObject({ part: 'TECHNICAL', title: 'Technical proposal', mime: 'application/pdf', pageCount: 12, sizeBytes: 2048 });
    expect(JSON.stringify(found)).not.toContain('tenants/');
    const page = await list(evaluator, seeded.packageId);
    expect(page.lines.map((line) => [line.id, line.view])).toEqual([[sealed1.id, 'FULL']]);
  });

  it('asks a member who has not declared to declare, and shows them no price and no file in the meantime (AC-ST-BID-004-2)', async () => {
    const { seeded, sealed1 } = await fixture();
    await release(sealed1.id);
    const evaluator = viewer(E2, { evaluate: onProjects(seeded.projectId) });
    expect(await find(evaluator, sealed1.id)).toEqual({ kind: 'DECLARATION_REQUIRED' });
    const page = await list(evaluator, seeded.packageId);
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]).toMatchObject({ id: sealed1.id, view: 'DECLARATION_REQUIRED', standing: 'UNDECLARED', bidPriceVnd: null });
  });

  it('shuts a member out of the bidder they declared a relation with from the moment they declare, and opens it again only if the conflict is allowed', async () => {
    const { seeded, nt1, sealed1, sealed2 } = await fixture();
    await release(sealed1.id);
    await release(sealed2.id);
    const made = await declare(seeded, E1, { hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: nt1 });
    const evaluator = viewer(E1, { evaluate: onProjects(seeded.projectId) });
    // Waiting for the decision: NT-1 does not exist for them, NT-2 does.
    expect(await find(evaluator, sealed1.id)).toEqual({ kind: 'HIDDEN' });
    expect(await find(evaluator, sealed2.id)).toMatchObject({ kind: 'SEEN', line: { view: 'FULL', standing: 'CLEAR' } });
    await decide(made.id, 'RECUSED');
    expect(await find(evaluator, sealed1.id)).toEqual({ kind: 'HIDDEN' });
    expect((await list(evaluator, seeded.packageId)).lines.map((line) => line.id)).toEqual([sealed2.id]);
    await as((tx) => conflicts.decide(tx, made.id, 2, 'ALLOWED', REASON, memberId(APPROVER), () => ({ sql: 'true', params: [] })), APPROVER);
    expect(await find(evaluator, sealed1.id)).toMatchObject({ kind: 'SEEN', line: { view: 'FULL', standing: 'ALLOWED' } });
  });

  it('shuts a member out of every proposal of the package when they are blocked, and of every contractor when the conflict names none', async () => {
    const { seeded, sealed1, sealed2 } = await fixture();
    await release(sealed1.id);
    await release(sealed2.id);
    const blocked = await declare(seeded, E1, { hasConflict: true, relationText: 'I advised the investor on this tender.' });
    const evaluator = viewer(E1, { evaluate: onProjects(seeded.projectId) });
    expect((await list(evaluator, seeded.packageId)).lines).toEqual([]);
    await decide(blocked.id, 'BLOCKED');
    expect(await find(evaluator, sealed1.id)).toEqual({ kind: 'HIDDEN' });
    expect(await find(evaluator, sealed2.id)).toEqual({ kind: 'HIDDEN' });
  });

  it('shows the evaluators a live proposal only: a replaced one is hidden from them and still metadata for the clerk', async () => {
    const seeded = await seedBidPackage(harness);
    const nt1 = await seedContractor(harness);
    const replaced = await seedProposal(harness, seeded, nt1, { releasedAt: hoursFromNow(-2), status: 'SUPERSEDED', revision: 1 });
    const live = await seedProposal(harness, seeded, nt1, { releasedAt: hoursFromNow(-2), revision: 2 });
    await declare(seeded, E1, { hasConflict: false });
    const evaluator = viewer(E1, { evaluate: onProjects(seeded.projectId) });
    expect((await list(evaluator, seeded.packageId)).lines.map((line) => line.id)).toEqual([live.id]);
    expect(await find(evaluator, replaced.id)).toEqual({ kind: 'HIDDEN' });
    const clerk = viewer(CLERK, { receive: onProjects(seeded.projectId) });
    expect((await list(clerk, seeded.packageId)).lines.map((line) => [line.id, line.status, line.view])).toEqual(
      expect.arrayContaining([
        [live.id, 'RECEIVED', 'METADATA'],
        [replaced.id, 'SUPERSEDED', 'METADATA'],
      ]),
    );
  });

  it('shows nothing of a project outside the rights of the caller, and nothing to a caller with neither right', async () => {
    const { seeded, sealed1 } = await fixture();
    await release(sealed1.id);
    await declare(seeded, E1, { hasConflict: false });
    const elsewhere = viewer(E1, { evaluate: onProjects(randomUUID()), receive: onProjects(randomUUID()) });
    expect(await find(elsewhere, sealed1.id)).toEqual({ kind: 'HIDDEN' });
    expect((await list(elsewhere, seeded.packageId)).lines).toEqual([]);
    expect(await find(viewer(E1, {}), sealed1.id)).toEqual({ kind: 'HIDDEN' });
    expect(await find(viewer(E1, { evaluate: onProjects(seeded.projectId) }), randomUUID())).toEqual({ kind: 'HIDDEN' });
  });

  it('gives the caller who both receives and evaluates the full view when they may, and the metadata when they may not', async () => {
    const { seeded, nt1, sealed1, sealed2 } = await fixture();
    await release(sealed1.id);
    await release(sealed2.id);
    const both = viewer(E1, { evaluate: onProjects(seeded.projectId), receive: onProjects(seeded.projectId) });
    expect(await find(both, sealed1.id)).toMatchObject({ kind: 'SEEN', line: { view: 'METADATA', standing: 'UNDECLARED' } });
    await declare(seeded, E1, { hasConflict: true, relationText: 'The director of NT-1 is my cousin.', contractorId: nt1 });
    expect(await find(both, sealed1.id)).toMatchObject({ kind: 'SEEN', line: { view: 'METADATA', bidPriceVnd: null } });
    expect(await find(both, sealed2.id)).toMatchObject({ kind: 'SEEN', line: { view: 'FULL' } });
  });

  it('pages the proposals newest first, keeping the cursor when the next ones are hidden from the caller', async () => {
    const seeded = await seedBidPackage(harness);
    const made: string[] = [];
    for (let n = 0; n < 3; n += 1) made.push((await seedProposal(harness, seeded, await seedContractor(harness), { releasedAt: hoursFromNow(-1) })).id);
    await declare(seeded, E1, { hasConflict: false });
    const evaluator = viewer(E1, { evaluate: onProjects(seeded.projectId) });
    const first = await list(evaluator, seeded.packageId, 2);
    expect(first.lines).toHaveLength(2);
    expect(first.more).toBe(true);
    const second = await list(evaluator, seeded.packageId, 2, first.last);
    expect(second.more).toBe(false);
    expect([...first.lines, ...second.lines].map((line) => line.id).sort()).toEqual([...made].sort());
  });

  it('filters by package', async () => {
    const one = await fixture();
    const two = await fixture();
    await release(one.sealed1.id);
    await release(two.sealed1.id);
    const clerk = viewer(CLERK, { receive: () => ({ sql: 'true', params: [] }) });
    const ids = (await list(clerk, two.seeded.packageId)).lines.map((line) => line.id);
    expect(ids).toEqual(expect.arrayContaining([two.sealed1.id, two.sealed2.id]));
    expect(ids).not.toContain(one.sealed1.id);
    expect((await list(clerk)).lines.map((line) => line.id)).toEqual(expect.arrayContaining([one.sealed1.id, two.sealed1.id]));
  });
});
