import { randomUUID } from 'node:crypto';
import { BidConflictStore } from '../src/bid-conflict-store';
import { BidReportIssueStore } from '../src/bid-report-issue-store';
import { BidReportStore } from '../src/bid-report-store';
import type { ReportViewer } from '../src/bid-report-store';
import { BidReviewStore } from '../src/bid-review-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { seedAnalysisProfile, seedCriteria } from './support/bid-analysis-fixtures';
import { DEPARTMENT, OTHER_PROJECT_UNIT, PROVINCE, nothing, onProjects, seedAs, seedBidPackage, seedContractor } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';
import { seedAnalysedProposal } from './support/bid-review-fixtures';
import type { AnalysedProposal } from './support/bid-review-fixtures';

const harness = new AuthzHarness();
const reports = new BidReportStore();
const issuing = new BidReportIssueStore();
const reviews = new BidReviewStore();
const conflicts = new BidConflictStore();
const E1 = 2;
const E2 = 3;
const E3 = 4;
const APPROVER = 5;
const GUEST = 6; // holds the right to evaluate, as the guest of a contractor
const BYSTANDER = 7; // staff with a role that does not carry the right
const LAPSED = 8; // staff whose grant of the right has ended
const WHY = 'The contract of the bridge was examined by the team and found as said.';
const CONCLUSION = 'The team finds that both proposals were evaluated on the same criteria and states what each met.';
const DISSENT = 'I do not agree with the score given to the experience of the second contractor.';
const TENANT_PATH = `tenants/${TENANT_A}/`;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = E1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const viewer = (member: number, evaluate: ScopeBuilder = nothing): ReportViewer => ({ membershipId: memberId(member), evaluate, receive: nothing, now: new Date(), teamPermission: 'bid.evaluate' });
const rows = <R extends object>(sql: string, params: unknown[] = []) => harness.owner<R>(TENANT_A, [[sql, params]]);

interface Refusal {
  code?: string;
  status?: number;
  detail?: string;
  extensions?: Record<string, unknown>;
  message: string;
}
const failure = async (work: Promise<unknown>): Promise<Refusal> => {
  try {
    await work;
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('expected a refusal');
};

describe('the evaluation report and its sign-off (ST-BID-012, BID 3 F6, BR-BID-03/09, BID-13)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_PROJECT_UNIT, path: '/u3/' },
    ]);
    for (const n of [1, E1, E2, E3, APPROVER, GUEST, BYSTANDER, LAPSED]) await harness.seedMembership(TENANT_A, n, PROVINCE);
    // The evaluation team is whoever holds bid.evaluate over the project now, on the staff: three experts and nobody else. The others around them are not waited for.
    await harness.seedRole(TENANT_A, 1, 'EVALUATOR', ['bid.evaluate'], 40);
    await harness.seedRole(TENANT_A, 2, 'READER', ['bid.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: E1, role: 1, kind: 'TENANT' },
      { n: 2, member: E2, role: 1, kind: 'TENANT' },
      { n: 3, member: E3, role: 1, kind: 'TENANT' },
      { n: 4, member: GUEST, role: 1, kind: 'TENANT' },
      { n: 5, member: BYSTANDER, role: 2, kind: 'TENANT' },
      { n: 6, member: LAPSED, role: 1, kind: 'TENANT', from: '2026-01-01T00:00:00Z', until: '2026-02-01T00:00:00Z' },
    ]);
    const contractor = await seedContractor(harness, { name: 'Guest firm' });
    await harness.owner(TENANT_A, [["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), contractor]]]);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  interface Fixture {
    seeded: SeededPackage;
    criteria: { id: string };
    profile: { id: string };
    evaluate: ScopeBuilder;
  }

  /** A package with approved criteria and the three experts, each having declared that no conflict stands. */
  async function fixture(declared: number[] = [E1, E2, E3]): Promise<Fixture> {
    const seeded = await seedBidPackage(harness);
    for (const member of declared) await as((tx) => conflicts.declare(tx, { packageId: seeded.packageId, hasConflict: false }, memberId(member), everything), member);
    return { seeded, criteria: await seedCriteria(harness, seeded.packageId, { codes: ['C1', 'C2', 'C3'] }), profile: await seedAnalysisProfile(harness), evaluate: onProjects(seeded.projectId) };
  }

  const analysed = (fx: Fixture, name: string, criteriaId = fx.criteria.id): Promise<AnalysedProposal> =>
    seedAnalysedProposal(harness, { seeded: fx.seeded, profileId: fx.profile.id, evaluator: { membershipId: memberId(E1), evaluate: fx.evaluate, receive: nothing, now: new Date() }, member: E1 }, name, criteriaId);

  const decide = (fx: Fixture, run: AnalysedProposal, code: string, version = 1, status: 'SUPPORTED' | 'CONTRADICTED' | 'MISSING' = 'SUPPORTED', score?: string) =>
    as((tx) => reviews.review(tx, { findingId: run.findings.get(code) as string, expectedVersion: version, target: { kind: 'STATUS', status, score }, reason: WHY, checkedEvidenceIds: [] }, { ...viewer(E1, fx.evaluate) }, memberId(E1)));

  /** Every finding of the run decided by the experts: C1 met, C2 scored 8, C3 scored 5. */
  async function decideAll(fx: Fixture, run: AnalysedProposal, except: string[] = []): Promise<void> {
    if (!except.includes('C1')) await decide(fx, run, 'C1');
    if (!except.includes('C2')) await decide(fx, run, 'C2', 1, 'SUPPORTED', '8');
    if (!except.includes('C3')) await decide(fx, run, 'C3', 1, 'MISSING', '5');
  }

  const create = (fx: Fixture, runs: AnalysedProposal[], over: { criteriaVersionId?: string; conclusion?: string; member?: number; evaluate?: ScopeBuilder } = {}) =>
    as(
      (tx) => reports.create(tx, { packageId: fx.seeded.packageId, criteriaVersionId: over.criteriaVersionId ?? fx.criteria.id, runIds: runs.map((run) => run.runId), conclusion: over.conclusion ?? CONCLUSION }, viewer(over.member ?? E1, over.evaluate ?? fx.evaluate), memberId(over.member ?? E1)),
      over.member ?? E1,
    );
  const sign = (fx: Fixture, reportId: string, member: number, version: number, dissent: string | null = null) =>
    as((tx) => reports.signOff(tx, { id: reportId, expectedVersion: version, dissent, tenantId: TENANT_A }, viewer(member, fx.evaluate), memberId(member)), member);
  const stored = async (id: string) =>
    ((await rows<{ status: string; version: string; signed_off_by: Array<Record<string, unknown>>; dissenting_opinions: Array<Record<string, unknown>>; payload_sha256: string | null; payload_ref: string | null; report_document_id: string | null; issue_event_id: string | null }>(
      'select status, version::text, signed_off_by, dissenting_opinions, payload_sha256, payload_ref, report_document_id, issue_event_id from machvon.evaluation_report where id = $1::uuid',
      [id],
    ))[0]) as { status: string; version: string; signed_off_by: Array<Record<string, unknown>>; dissenting_opinions: Array<Record<string, unknown>>; payload_sha256: string | null; payload_ref: string | null; report_document_id: string | null; issue_event_id: string | null };
  const reportRows = async (packageId: string): Promise<number> => (await rows<{ n: number }>('select count(*)::int as n from machvon.evaluation_report where package_id = $1::uuid', [packageId]))[0]?.n ?? -1;

  /** A team of three and two proposals with every finding decided, and the draft made from them. */
  async function drafted() {
    const fx = await fixture();
    const alpha = await analysed(fx, 'Alpha Builders');
    const beta = await analysed(fx, 'Beta Builders');
    await decideAll(fx, alpha);
    await decideAll(fx, beta);
    const made = await create(fx, [alpha, beta]);
    return { fx, alpha, beta, report: made.report };
  }

  async function seedDocument(): Promise<string> {
    const documentId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
         values ($1, $2, 'OUTGOING', 'BB', 'Minutes of the evaluation', 'CONFIDENTIAL', $3, $3)`,
        [TENANT_A, documentId, memberId(1)],
      ],
    ]);
    return documentId;
  }

  describe('AC-ST-BID-012-1, UAT-AC453: from the unreviewed finding to the minutes DOC issued', () => {
    it('AC-ST-BID-012-1, UAT-AC453: refuses 422 UNREVIEWED_FINDINGS with one of six findings undecided, makes a DRAFT once it is, asks DOC after the third signature and is ISSUED with the document after doc.issued', async () => {
      const fx = await fixture();
      const alpha = await analysed(fx, 'Alpha Builders');
      const beta = await analysed(fx, 'Beta Builders');
      await decideAll(fx, alpha);
      await decideAll(fx, beta, ['C3']);

      const refused = await failure(create(fx, [alpha, beta]));
      expect(refused).toMatchObject({ code: 'UNREVIEWED_FINDINGS', status: 422, extensions: { unreviewed_count: 1, finding_ids: [beta.findings.get('C3')] } });
      expect(await reportRows(fx.seeded.packageId)).toBe(0);

      await decide(fx, beta, 'C3', 1, 'MISSING', '5');
      const { report } = await create(fx, [alpha, beta]);
      expect(report).toMatchObject({ status: 'DRAFT', version: 1, package: { id: fx.seeded.packageId }, runIds: [alpha.runId, beta.runId].sort(), signedOffBy: [], stale: false, reportDocumentId: null, payloadSha256: null });
      expect(report.awaiting.map((member) => member.membershipId).sort()).toEqual([memberId(E1), memberId(E2), memberId(E3)]);

      const first = await sign(fx, report.id, E1, 1);
      expect(first.issue).toBeUndefined();
      expect(first.report).toMatchObject({ status: 'DRAFT', version: 2, signedOffBy: [{ membershipId: memberId(E1), withDissent: false }] });
      const second = await sign(fx, report.id, E2, 2, DISSENT);
      expect(second.report.status).toBe('DRAFT');
      expect(second.report.awaiting.map((member) => member.membershipId)).toEqual([memberId(E3)]);
      const third = await sign(fx, report.id, E3, 3);
      expect(third.report).toMatchObject({ status: 'ISSUE_REQUESTED', version: 5, reportDocumentId: null, awaiting: [] });
      expect(third.report.signedOffBy.map((signature) => signature.membershipId)).toEqual([memberId(E1), memberId(E2), memberId(E3)]);
      const ask = third.issue;
      expect(ask).toMatchObject({ sourceRef: `BID:evaluation_report:${report.id}`, payloadSha256: third.report.payloadSha256, draftingUnitId: expect.any(String) });
      expect(ask?.payloadRef.startsWith(`${TENANT_PATH}bid/reports/${report.id}/`)).toBe(true);
      expect(await stored(report.id)).toMatchObject({ status: 'ISSUE_REQUESTED', payload_sha256: ask?.payloadSha256, payload_ref: ask?.payloadRef, issue_event_id: ask?.eventId, report_document_id: null });
      expect(ask?.payload.body).toContain('Alpha Builders');
      expect(ask?.payload.body).toContain(DISSENT);
      expect(ask?.payload.body).toContain(CONCLUSION);
      expect(ask?.payload.body).toMatch(/Các thành viên đã ký:\n {3}- User 2 \(\d{4}-.*\)\n {3}- User 3 \(.*\)\n {3}- User 4 \(.*\)/);

      // The module never marks the report issued by itself: DOC's answer does, with the document.
      const documentId = await seedDocument();
      const head = await as((tx) => issuing.lockHead(tx, report.id));
      expect(head).toMatchObject({ status: 'ISSUE_REQUESTED', payloadSha256: ask?.payloadSha256, issueEventId: ask?.eventId });
      const issued = await as((tx) => issuing.markIssued(tx, head as NonNullable<typeof head>, { documentId, issuedAt: new Date().toISOString() }));
      expect(issued.version).toBe(6);
      expect(await stored(report.id)).toMatchObject({ status: 'ISSUED', report_document_id: documentId });
      const read = await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate)));
      expect(read).toMatchObject({ status: 'ISSUED', reportDocumentId: documentId, awaiting: [], dissentingOpinions: [{ membershipId: memberId(E2), text: DISSENT }] });
    });

    it('freezes what the experts decided, cell by cell, with the weighted score of each proposal and nothing of what the model said or of a winner', async () => {
      const { report } = await drafted();
      expect(report.summary.proposals.map((proposal) => [proposal.contractor.legal_name, proposal.weighted_score, proposal.decided_count, proposal.criteria_count])).toEqual([
        ['Alpha Builders', '52.00', 3, 3],
        ['Beta Builders', '52.00', 3, 3],
      ]);
      expect(report.summary.conclusion).toBe(CONCLUSION);
      expect(report.summary.not_covered).toEqual([]);
      const cell = report.summary.rows.find((row) => row.criterion.code === 'C3')?.cells[0];
      expect(cell).toMatchObject({ decided: { status: 'MISSING', score: '5.00', decision: 'ACCEPTED_WITH_CHANGE' }, risk: 'ATTENTION' });
      expect(JSON.stringify(report.summary)).not.toContain('on C2.');
      expect(Object.keys(report.summary)).not.toEqual(expect.arrayContaining(['winner']));
    });

    it('names the proposals the report does not cover: the one nobody chose, the one without an analysis', async () => {
      const fx = await fixture();
      const alpha = await analysed(fx, 'Alpha Builders');
      const beta = await analysed(fx, 'Beta Builders');
      await decideAll(fx, alpha);
      await decideAll(fx, beta);
      const { report } = await create(fx, [alpha]);
      expect(report.summary.proposals.map((proposal) => proposal.contractor.legal_name)).toEqual(['Alpha Builders']);
      expect(report.summary.not_covered).toEqual([{ proposal_id: beta.proposalId, contractor: { id: beta.contractorId, legal_name: 'Beta Builders' }, reason: 'NOT_SELECTED' }]);
    });
  });

  describe('making the draft', () => {
    it('is refused for a run that ran on other criteria (422 CRITERIA_VERSION_MISMATCH) and nothing is written', async () => {
      const fx = await fixture();
      const alpha = await analysed(fx, 'Alpha Builders');
      await decideAll(fx, alpha);
      const next = await seedCriteria(harness, fx.seeded.packageId, { codes: ['C1', 'C2', 'C3'], revision: 2 });
      const refused = await failure(create(fx, [alpha], { criteriaVersionId: next.id }));
      expect(refused).toMatchObject({ code: 'CRITERIA_VERSION_MISMATCH', status: 422, extensions: { run_ids: [alpha.runId] } });
      expect(await reportRows(fx.seeded.packageId)).toBe(0);
    });

    it('is refused for a run that does not wait for the experts (422 RUN_NOT_COMPLETED)', async () => {
      const fx = await fixture();
      const alpha = await analysed(fx, 'Alpha Builders');
      await rows("update machvon.analysis_run set status = 'RUNNING', finished_at = null where id = $1::uuid", [alpha.runId]);
      expect(await failure(create(fx, [alpha]))).toMatchObject({ code: 'RUN_NOT_COMPLETED', status: 422 });
    });

    it('does not find a run that is not the analysis standing for a proposal of the package, or a package the caller does not evaluate (404)', async () => {
      const fx = await fixture();
      const alpha = await analysed(fx, 'Alpha Builders');
      await decideAll(fx, alpha);
      const stranger = { ...alpha, runId: randomUUID() };
      expect(await failure(create(fx, [stranger]))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404, detail: 'run_ids' });
      expect(await failure(create(fx, [alpha], { evaluate: nothing }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(create(fx, [alpha], { criteriaVersionId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('finds nothing of a package the caller does not evaluate, whether or not they declared (404 before the declaration is asked)', async () => {
      const fx = await fixture([E1]);
      expect(await failure(create(fx, [], { member: APPROVER, evaluate: nothing }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('asks the member who has not declared for the declaration (403 CONFLICT_UNDECLARED) and shuts out one whose conflict stands or was decided (404)', async () => {
      const fx = await fixture([E1, E2]);
      const alpha = await analysed(fx, 'Alpha Builders');
      await decideAll(fx, alpha);
      expect(await failure(create(fx, [alpha], { member: E3 }))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      const declared = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'A relative works for Alpha Builders.' }, memberId(E3), everything), E3);
      expect(await failure(create(fx, [alpha], { member: E3 }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await as((tx) => conflicts.decide(tx, declared.id, 1, 'RECUSED', 'The relation was examined and decided by the authority.', memberId(APPROVER), everything), APPROVER);
      expect(await failure(create(fx, [alpha], { member: E3 }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await reportRows(fx.seeded.packageId)).toBe(0);
    });
  });

  describe('signing', () => {
    it('refuses a second signature of the same member (422 ALREADY_SIGNED_OFF), a stale version (409 VERSION_CONFLICT) and a report that is not a draft (409 REPORT_STATE_INVALID)', async () => {
      const { fx, report } = await drafted();
      await sign(fx, report.id, E1, 1);
      expect(await failure(sign(fx, report.id, E1, 2))).toMatchObject({ code: 'ALREADY_SIGNED_OFF', status: 422 });
      expect(await failure(sign(fx, report.id, E2, 1))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 2 } });
      await sign(fx, report.id, E2, 2);
      await sign(fx, report.id, E3, 3);
      expect(await failure(sign(fx, report.id, E1, 5))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409, extensions: { report_status: 'ISSUE_REQUESTED' } });
      expect((await stored(report.id)).signed_off_by).toHaveLength(3);
    });

    it('checks the dissent through the same rule as the command and keeps it in the words of the member who signed with it', async () => {
      const { fx, report } = await drafted();
      const signed = await sign(fx, report.id, E1, 1, DISSENT);
      expect(signed.report.signedOffBy).toEqual([expect.objectContaining({ membershipId: memberId(E1), withDissent: true, displayName: 'User 2' })]);
      expect(signed.report.dissentingOpinions).toEqual([expect.objectContaining({ membershipId: memberId(E1), displayName: 'User 2', text: DISSENT })]);
      expect(await stored(report.id)).toMatchObject({ dissenting_opinions: [{ membership_id: memberId(E1), text: DISSENT }], signed_off_by: [{ membership_id: memberId(E1), dissent: true }] });
    });

    it('does not find a report of a package the caller does not evaluate (404), asks the undeclared for the declaration (403) and shuts out the member whose conflict stands (404)', async () => {
      const { fx, report } = await drafted();
      expect(await failure(sign({ ...fx, evaluate: nothing }, report.id, E1, 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(sign(fx, randomUUID(), E1, 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await failure(sign(fx, report.id, APPROVER, 1))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      const declared = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'A relative works for Beta Builders.' }, memberId(APPROVER), everything), APPROVER);
      expect(await failure(sign(fx, report.id, APPROVER, 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(declared.hasConflict).toBe(true);
      expect((await stored(report.id)).signed_off_by).toEqual([]);
    });

    it('refuses with 409 REPORT_OUT_OF_DATE a report whose decisions the experts took again after the draft, and makes no signature', async () => {
      const { fx, alpha, report } = await drafted();
      await decide(fx, alpha, 'C2', 2, 'CONTRADICTED', '2');
      expect(await failure(sign(fx, report.id, E1, 1))).toMatchObject({ code: 'REPORT_OUT_OF_DATE', status: 409 });
      const read = await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate)));
      expect(read).toMatchObject({ stale: true, status: 'DRAFT', signedOffBy: [], mayChange: false });
      // A new report from what stands now is signed.
      const fresh = await create(fx, [alpha]);
      expect((await sign(fx, fresh.report.id, E1, 1)).report.signedOffBy).toHaveLength(1);
    });

    it('does not wait for a member a decision on a conflict shut out, and waits for one whose conflict is not decided or who has not declared', async () => {
      const fx = await fixture([E1, E2]);
      const alpha = await analysed(fx, 'Alpha Builders');
      await decideAll(fx, alpha);
      const { report } = await create(fx, [alpha]);
      expect(report.awaiting.map((member) => [member.membershipId, member.standing]).sort()).toEqual([[memberId(E1), 'CLEAR'], [memberId(E2), 'CLEAR'], [memberId(E3), 'UNDECLARED']].sort());
      await sign(fx, report.id, E1, 1);
      const second = await sign(fx, report.id, E2, 2);
      expect(second.report).toMatchObject({ status: 'DRAFT', awaiting: [{ membershipId: memberId(E3), standing: 'UNDECLARED' }] });
      expect(second.issue).toBeUndefined();

      const declared = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'A relative works for Alpha Builders.' }, memberId(E3), everything), E3);
      const pending = await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate)));
      expect(pending?.awaiting).toEqual([expect.objectContaining({ membershipId: memberId(E3), standing: 'PENDING' })]);
      await as((tx) => conflicts.decide(tx, declared.id, 1, 'RECUSED', 'The relation was examined and decided by the authority.', memberId(APPROVER), everything), APPROVER);
      const settled = await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate)));
      expect(settled).toMatchObject({ status: 'DRAFT', awaiting: [] });

      // Nobody is left to wait for and the signatures are all there, but nothing signed since: a member who signed confirms, adds no second signature, and the report asks DOC.
      const confirmed = await sign(fx, report.id, E2, settled?.version as number);
      expect(confirmed.report).toMatchObject({ status: 'ISSUE_REQUESTED' });
      expect(confirmed.report.signedOffBy.map((signature) => signature.membershipId)).toEqual([memberId(E1), memberId(E2)]);
      expect(confirmed.issue).toBeDefined();
    });

    it('offers the sign-off to a member who signed once a decision on a conflict left nobody to wait for, the same call the command allows, and not while others are awaited or the report is stale (AC-ST-BID-012-1)', async () => {
      const fx = await fixture([E1, E2]);
      const alpha = await analysed(fx, 'Alpha Builders');
      await decideAll(fx, alpha);
      const { report } = await create(fx, [alpha]);
      await sign(fx, report.id, E1, 1);
      await sign(fx, report.id, E2, 2);
      const mayChange = async (member: number): Promise<boolean | undefined> => (await as((tx) => reports.find(tx, report.id, viewer(member, fx.evaluate)), member))?.mayChange;
      // E3 has not declared and is awaited: the member who signed has nothing to do but wait.
      expect([await mayChange(E1), await mayChange(E2)]).toEqual([false, false]);

      const declared = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'A relative works for Alpha Builders.' }, memberId(E3), everything), E3);
      await as((tx) => conflicts.decide(tx, declared.id, 1, 'RECUSED', 'The relation was examined and decided by the authority.', memberId(APPROVER), everything), APPROVER);
      // Nobody is awaited any more and nobody is left to complete the report: every member who signed may confirm.
      expect([await mayChange(E1), await mayChange(E2)]).toEqual([true, true]);
      // The member who is shut out finds nothing at all.
      expect(await failure(as((tx) => reports.find(tx, report.id, viewer(E3, fx.evaluate)), E3))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });

      // The experts decide again: the draft is stale and nobody confirms it.
      await decide(fx, alpha, 'C2', 2, 'CONTRADICTED', '2');
      expect([await mayChange(E1), await mayChange(E2)]).toEqual([false, false]);
    });

    it('refuses the confirmation of a member who signed when others are still awaited, and a confirmation that brings a dissent', async () => {
      const { fx, report } = await drafted();
      await sign(fx, report.id, E1, 1);
      expect(await failure(sign(fx, report.id, E1, 2))).toMatchObject({ code: 'ALREADY_SIGNED_OFF', status: 422 });
      expect(await failure(sign(fx, report.id, E1, 2, DISSENT))).toMatchObject({ code: 'ALREADY_SIGNED_OFF', status: 422 });
    });

    it('takes a member whose conflict is decided against them after they signed out of the signatures, as the decision on the conflict does, and no longer waits for them', async () => {
      const fx = await fixture([E1, E2]);
      const alpha = await analysed(fx, 'Alpha Builders');
      await decideAll(fx, alpha);
      const declared = await as((tx) => conflicts.declare(tx, { packageId: fx.seeded.packageId, hasConflict: true, relationText: 'A relative works for Alpha Builders.' }, memberId(E3), everything), E3);
      await as((tx) => conflicts.decide(tx, declared.id, 1, 'ALLOWED', 'The relation was examined and found harmless.', memberId(APPROVER), everything), APPROVER);
      const { report } = await create(fx, [alpha]);
      await sign(fx, report.id, E3, 1);
      await sign(fx, report.id, E1, 2);
      const before = await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate)));
      expect(before).toMatchObject({ status: 'DRAFT', awaiting: [{ membershipId: memberId(E2) }] });
      await as((tx) => conflicts.decide(tx, declared.id, 2, 'RECUSED', 'New facts came to light about the relation.', memberId(APPROVER), everything), APPROVER);
      const after = await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate)));
      expect(after).toMatchObject({ status: 'DRAFT', signedOffBy: [{ membershipId: memberId(E1) }], awaiting: [{ membershipId: memberId(E2) }] });
      expect(after?.version).toBe((before?.version ?? 0) + 1);
    });
  });

  describe('reading', () => {
    it('lists the reports of a package, newest first, for the caller who evaluates it with the gate of the declaration; a package the caller does not evaluate is nothing', async () => {
      const { fx, report } = await drafted();
      const alpha = await analysed(fx, 'Gamma Builders');
      await decideAll(fx, alpha);
      const later = await create(fx, [alpha]);
      const listed = await as((tx) => reports.list(tx, fx.seeded.packageId, viewer(E1, fx.evaluate)));
      expect(listed?.map((line) => line.id)).toEqual([later.report.id, report.id]);
      expect(await as((tx) => reports.list(tx, fx.seeded.packageId, viewer(E1, nothing)))).toBeUndefined();
      expect(await failure(as((tx) => reports.list(tx, fx.seeded.packageId, viewer(APPROVER, fx.evaluate)), APPROVER))).toMatchObject({ code: 'CONFLICT_UNDECLARED', status: 403 });
      expect(await as((tx) => reports.find(tx, randomUUID(), viewer(E1, fx.evaluate)))).toBeUndefined();
      expect(await as((tx) => reports.find(tx, report.id, viewer(E1, nothing)))).toBeUndefined();
    });

    it('says the caller may sign a draft only while they have not and nothing changed since', async () => {
      const { fx, report } = await drafted();
      const before = await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate)));
      expect(before?.mayChange).toBe(true);
      await sign(fx, report.id, E1, 1);
      expect((await as((tx) => reports.find(tx, report.id, viewer(E1, fx.evaluate))))?.mayChange).toBe(false);
      expect((await as((tx) => reports.find(tx, report.id, viewer(E2, fx.evaluate)), E2))?.mayChange).toBe(true);
    });
  });

  describe('what DOC answers', () => {
    type Head = NonNullable<Awaited<ReturnType<BidReportIssueStore['lockHead']>>>;
    const headOf = async (id: string): Promise<Head> => (await as((tx) => issuing.lockHead(tx, id))) as Head;

    /** A report every member signed, waiting for DOC. */
    async function requested() {
      const world = await drafted();
      await sign(world.fx, world.report.id, E1, 1);
      await sign(world.fx, world.report.id, E2, 2);
      const done = await sign(world.fx, world.report.id, E3, 3);
      return { ...world, done };
    }

    it('puts the report back to SIGNED_OFF when DOC refuses, keeps the signatures, and refuses the answer that does not fit the state (409 REPORT_STATE_INVALID)', async () => {
      const world = await requested();
      const rejected = await as(async (tx) => issuing.markIssueRejected(tx, await headOf(world.report.id)));
      expect(rejected.version).toBe(world.done.report.version + 1);
      expect(await stored(world.report.id)).toMatchObject({ status: 'SIGNED_OFF', report_document_id: null });
      expect((await stored(world.report.id)).signed_off_by).toHaveLength(3);
      const head = await headOf(world.report.id);
      expect(await failure(as((tx) => issuing.markIssued(tx, head, { documentId: randomUUID(), issuedAt: new Date().toISOString() })))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
      expect(await failure(as((tx) => issuing.markIssueRejected(tx, head)))).toMatchObject({ code: 'REPORT_STATE_INVALID', status: 409 });
    });

    it('supersedes the minutes issued before for the package when a later report is issued, once, and marks minutes recalled only after they were issued', async () => {
      const first = await requested();
      await as(async (tx) => issuing.markIssued(tx, await headOf(first.report.id), { documentId: await seedDocument(), issuedAt: new Date().toISOString() }));
      expect((await stored(first.report.id)).status).toBe('ISSUED');

      // A second report of the package: the findings of the first are frozen, so it is made from the run of another proposal.
      const gamma = await analysed(first.fx, 'Gamma Builders');
      await decideAll(first.fx, gamma);
      const second = await create(first.fx, [gamma]);
      await sign(first.fx, second.report.id, E1, 1);
      await sign(first.fx, second.report.id, E2, 2);
      await sign(first.fx, second.report.id, E3, 3);
      const head = await headOf(second.report.id);
      await as(async (tx) => issuing.markIssued(tx, head, { documentId: await seedDocument(), issuedAt: new Date().toISOString() }));
      const moved = await as((tx) => issuing.supersedeEarlier(tx, head));
      expect(moved.map((entry) => entry.id)).toEqual([first.report.id]);
      expect((await stored(first.report.id)).status).toBe('SUPERSEDED');
      expect((await stored(second.report.id)).status).toBe('ISSUED');
      expect(await as((tx) => issuing.supersedeEarlier(tx, head))).toEqual([]);

      await as(async (tx) => issuing.markRecalled(tx, await headOf(second.report.id), new Date().toISOString()));
      expect((await headOf(second.report.id)).recalledAt).not.toBeNull();
      const draft = await create(first.fx, [gamma]);
      expect(await failure(as(async (tx) => issuing.markRecalled(tx, await headOf(draft.report.id), new Date().toISOString())))).toMatchObject({ code: 'REPORT_STATE_INVALID' });
      expect(await as((tx) => issuing.lockHead(tx, randomUUID()))).toBeUndefined();
    });
  });

  describe('what the database keeps', () => {
    it('freezes the decisions once the report asked DOC for the minutes: a finding of its runs is not decided again (409 REPORT_FROZEN), and the table says the same', async () => {
      const world = await (async () => {
        const base = await drafted();
        await sign(base.fx, base.report.id, E1, 1);
        await sign(base.fx, base.report.id, E2, 2);
        await sign(base.fx, base.report.id, E3, 3);
        return base;
      })();
      expect(await failure(decide(world.fx, world.alpha, 'C2', 2, 'CONTRADICTED', '1'))).toMatchObject({ code: 'REPORT_FROZEN', status: 409 });
      const direct = await failure(as((tx) => tx.query(`insert into machvon.analysis_finding_review (tenant_id, id, finding_id, reviewer_user_id, from_status, to_status, reason, decision, ai_decision_record_id)
        select tenant_id, gen_random_uuid(), finding_id, reviewer_user_id, from_status, to_status, reason, decision, ai_decision_record_id from machvon.analysis_finding_review where finding_id = $1::uuid limit 1`, [world.alpha.findings.get('C2')])));
      expect(direct.message).toBe('REPORT_FROZEN');
    });

    it('keeps what the report is made from, its signatures once DOC was asked, and the report itself: no change of the summary, no unsigning, no deletion', async () => {
      const { fx, report } = await drafted();
      const attempt = (sql: string, params: unknown[] = []) => failure(as((tx) => tx.query(sql, params)));
      expect((await attempt("update machvon.evaluation_report set summary_json = '{}'::jsonb where id = $1::uuid", [report.id])).message).toBe('what an evaluation report is made from never changes');
      expect((await attempt("update machvon.evaluation_report set status = 'ISSUED' where id = $1::uuid", [report.id])).message).toBe('the state transition of the evaluation report is not allowed');
      expect((await attempt('delete from machvon.evaluation_report where id = $1::uuid', [report.id])).message).toBeDefined();
      expect((await attempt('truncate machvon.evaluation_report')).message).toBeDefined();
      await sign(fx, report.id, E1, 1);
      await sign(fx, report.id, E2, 2);
      await sign(fx, report.id, E3, 3);
      expect((await attempt("update machvon.evaluation_report set signed_off_by = '[]'::jsonb where id = $1::uuid", [report.id])).message).toBe('the signatures of a report that asked DOC for the minutes are kept');
      expect((await attempt("update machvon.evaluation_report set payload_sha256 = repeat('a', 64) where id = $1::uuid", [report.id])).message).toBe('an evaluation report keeps the payload it was frozen with and the minutes it was issued as');
      expect((await attempt("insert into machvon.evaluation_report (tenant_id, id, package_id, criteria_version_id, run_ids, summary_json, status, created_by, updated_by, version) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, '[]'::jsonb, '{}'::jsonb, 'DRAFT', $3::uuid, $3::uuid, 1)", [fx.seeded.packageId, fx.criteria.id, memberId(E1)])).message).toBe(
        'an evaluation report is written as a draft that nobody signed, made from at least one run',
      );
      expect(await stored(report.id)).toMatchObject({ status: 'ISSUE_REQUESTED' });
    });

    it('ties a report that asked DOC, and one that was issued, to what it asked with and what it was answered with', async () => {
      const { report } = await drafted();
      const owner = (sql: string, params: unknown[] = []) => failure(rows(sql, params));
      expect((await owner("update machvon.evaluation_report set status = 'ISSUE_REQUESTED' where id = $1::uuid", [report.id])).message).toContain('evaluation_report_requested_chk');
      expect((await owner("update machvon.evaluation_report set status = 'DRAFT', report_document_id = $2::uuid where id = $1::uuid", [report.id, randomUUID()])).message).toContain('evaluation_report_document_chk');
      expect((await owner("update machvon.evaluation_report set status = 'SIGNED_OFF' where id = $1::uuid", [report.id])).message).toContain('evaluation_report_signed_chk');
      expect((await owner("update machvon.evaluation_report set payload_sha256 = 'XYZ' where id = $1::uuid", [report.id])).message).toContain('evaluation_report_hash_chk');
      expect((await owner("update machvon.evaluation_report set signed_off_by = '{}'::jsonb where id = $1::uuid", [report.id])).message).toContain('evaluation_report_json_chk');
      expect((await owner("update machvon.evaluation_report set recalled_at = now() where id = $1::uuid", [report.id])).message).toContain('evaluation_report_recalled_chk');
    });
  });
});
