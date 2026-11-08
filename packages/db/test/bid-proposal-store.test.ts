import { randomUUID } from 'node:crypto';
import { BidMilestoneStore } from '../src/bid-milestone-store';
import { ProcurementImportAdapter } from '../src/bid-procurement-import';
import { BidProposalStore, PROPOSAL_FILE_DOC_TYPE } from '../src/bid-proposal-store';
import { DocumentStore } from '../src/document-store';
import type { NewProposalInput, ProposalFileInput } from '../src/bid-proposal-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId } from './support/authz-fixtures';
import { DEPARTMENT, OTHER_PROJECT_UNIT, PROVINCE, everything, hoursFromNow, nothing, onProjects, seedBidPackage, seedContractor, seedMilestone, seedProposal } from './support/bid-proposal-fixtures';
import type { SeededPackage } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const proposals = new BidProposalStore();
const milestones = new BidMilestoneStore();
const CLERK = 1;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = CLERK): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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

const fileOf = (n: number, part: ProposalFileInput['part'] = 'TECHNICAL'): ProposalFileInput => ({
  part,
  title: `Volume ${n}`,
  objectKey: `tenants/${TENANT_A}/document/${randomUUID()}`,
  checksum: n.toString(16).padStart(64, 'a'),
  mime: 'application/pdf',
  pageCount: 10 + n,
  byteLength: 1000 + n,
});

interface Setup {
  seeded: SeededPackage;
  contractorId: string;
}

/** An approved package whose bids open in 48 hours and close in 36, and a verified contractor. */
async function open(options: { opening?: { planned?: string; actual?: string } | null; closing?: { planned?: string; actual?: string } | null } = {}): Promise<Setup> {
  const seeded = await seedBidPackage(harness);
  const opening = options.opening === undefined ? { planned: hoursFromNow(48) } : options.opening;
  const closing = options.closing === undefined ? { planned: hoursFromNow(36) } : options.closing;
  if (opening !== null) await seedMilestone(harness, seeded.packageId, 'BID_OPENING', opening);
  if (closing !== null) await seedMilestone(harness, seeded.packageId, 'BID_CLOSING', closing);
  return { seeded, contractorId: await seedContractor(harness) };
}

const receive = (setup: Setup, overrides: Partial<NewProposalInput> = {}, scope: ScopeBuilder = everything, now = new Date()) =>
  as((tx) => proposals.receive(tx, { packageId: setup.seeded.packageId, contractorId: setup.contractorId, submittedAt: hoursFromNow(-1), bidPriceVnd: '1500000000', files: [fileOf(1), fileOf(2, 'FINANCIAL')], ...overrides }, memberId(CLERK), scope, now));

const proposalRow = (proposalId: string) =>
  owner<{ status: string; revision: number; classification: string; access_released_at: string; submitted_at: string; bid_price_vnd: string | null; version: string; document_version_ids: string[]; created_by: string }>(
    `select status, revision, classification, to_char(access_released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as access_released_at,
            to_char(submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at, bid_price_vnd::text, version::text, document_version_ids, created_by
       from machvon.proposal where id = $1::uuid`,
    [proposalId],
  ).then((rows) => rows[0]);
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const countProposals = async (packageId: string) => Number((await owner<{ n: string }>('select count(*)::text as n from machvon.proposal where package_id = $1::uuid', [packageId]))[0]?.n);

describe('the sealed proposal (ST-BID-004)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_PROJECT_UNIT, path: '/u3/' },
    ]);
    for (const n of [1, 2, 3, 4]) await harness.seedMembership(TENANT_A, n, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('receiveProposal', () => {
    it('stores the proposal sealed until the opening: received, confidential, released at the opening, its files confidential attachments about it (AC-ST-BID-004-1)', async () => {
      const setup = await open();
      const opening = (await owner<{ at: string }>(`select ${ISO('planned_at')} as at from machvon.procurement_milestone where package_id = $1::uuid and milestone_kind = 'BID_OPENING'`, [setup.seeded.packageId]))[0]?.at;
      const submittedAt = hoursFromNow(-2);
      const received = await receive(setup, { submittedAt });
      expect(received).toMatchObject({
        packageId: setup.seeded.packageId,
        packageCode: setup.seeded.packageCode,
        projectId: setup.seeded.projectId,
        contractorId: setup.contractorId,
        revision: 1,
        version: 1,
        accessReleasedAt: opening,
        fileCount: 2,
        hasPrice: true,
        supersededId: null,
      });
      const row = await proposalRow(received.id);
      expect(row).toMatchObject({ status: 'RECEIVED', revision: 1, classification: 'CONFIDENTIAL', access_released_at: opening, bid_price_vnd: '1500000000', version: '1', created_by: memberId(CLERK) });
      expect(row?.submitted_at).toBe(received.submittedAt);
      const files = await owner<{ part: string; doc_kind: string; classification: string; subject_module: string; subject_id: string; doc_type_code: string; scan_status: string; stage: string; id: string; title: string }>(
        `select pd.part, d.doc_kind, d.classification, d.subject_module, d.subject_id, d.doc_type_code, v.scan_status, v.stage, v.id, d.title
           from machvon.proposal_document pd join machvon.document_version v on v.id = pd.document_version_id join machvon.document d on d.id = v.document_id
          where pd.proposal_id = $1::uuid order by d.title`,
        [received.id],
      );
      expect(files.map((file) => ({ ...file, id: undefined }))).toEqual([
        { part: 'TECHNICAL', doc_kind: 'ATTACHMENT', classification: 'CONFIDENTIAL', subject_module: 'BID_PROPOSAL', subject_id: received.id, doc_type_code: PROPOSAL_FILE_DOC_TYPE, scan_status: 'CLEAN', stage: 'ATTACHMENT', title: 'Volume 1' },
        { part: 'FINANCIAL', doc_kind: 'ATTACHMENT', classification: 'CONFIDENTIAL', subject_module: 'BID_PROPOSAL', subject_id: received.id, doc_type_code: PROPOSAL_FILE_DOC_TYPE, scan_status: 'CLEAN', stage: 'ATTACHMENT', title: 'Volume 2' },
      ]);
      expect([...(row?.document_version_ids ?? [])].sort()).toEqual(files.map((file) => file.id).sort());
    });

    it('releases the proposal at the day the opening happened when the package has one, else at the day it is planned for', async () => {
      const setup = await open({ opening: { planned: hoursFromNow(48), actual: hoursFromNow(40) } });
      const received = await receive(setup);
      const actual = (await owner<{ at: string }>(`select ${ISO('actual_at')} as at from machvon.procurement_milestone where package_id = $1::uuid and milestone_kind = 'BID_OPENING'`, [setup.seeded.packageId]))[0]?.at;
      expect(received.accessReleasedAt).toBe(actual);
    });

    it('takes a proposal for a package in PLANNED, the status that approving its plan gives it', async () => {
      const setup = await open();
      await owner('update machvon.procurement_package set status = $2 where id = $1::uuid', [setup.seeded.packageId, 'PLANNED']);
      expect((await receive(setup)).revision).toBe(1);
    });

    it('takes a proposal without a price', async () => {
      const setup = await open();
      const received = await receive(setup, { bidPriceVnd: undefined });
      expect(received.hasPrice).toBe(false);
      expect((await proposalRow(received.id))?.bid_price_vnd).toBeNull();
    });

    it('refuses without a date for the opening (422 BID_OPENING_UNSET), because there is no moment to unseal it at', async () => {
      const setup = await open({ opening: null });
      expect(await refusal(receive(setup))).toMatchObject({ code: 'BID_OPENING_UNSET', status: 422 });
      expect(await countProposals(setup.seeded.packageId)).toBe(0);
    });

    it('refuses once the bids are opened (422 BID_CLOSED), and a proposal handed in after the closing (422 BID_CLOSED)', async () => {
      const opened = await open({ opening: { planned: hoursFromNow(-1) }, closing: { planned: hoursFromNow(-2) } });
      expect(await refusal(receive(opened, { submittedAt: hoursFromNow(-5) }))).toMatchObject({ code: 'BID_CLOSED', status: 422 });
      const late = await open({ closing: { planned: hoursFromNow(-2) } });
      expect(await refusal(receive(late, { submittedAt: hoursFromNow(-1) }))).toMatchObject({ code: 'BID_CLOSED', status: 422 });
      expect((await receive(late, { submittedAt: hoursFromNow(-3) })).revision).toBe(1);
      expect(await countProposals(opened.seeded.packageId)).toBe(0);
      expect(await countProposals(late.seeded.packageId)).toBe(1);
    });

    it('refuses a hand-in time that is not a moment or lies in the future (422 VALIDATION_FAILED)', async () => {
      const setup = await open({ closing: { planned: hoursFromNow(47) } });
      expect(await refusal(receive(setup, { submittedAt: '2026-02-30T10:00:00Z' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'submitted_at' });
      expect(await refusal(receive(setup, { submittedAt: '2026-11-11 09:00' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'submitted_at' });
      expect(await refusal(receive(setup, { submittedAt: hoursFromNow(2) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'submitted_at' });
    });

    it('refuses a package outside the scope of the caller with 404, and a package that is not open for bids with 409 PACKAGE_STATE_INVALID', async () => {
      const setup = await open();
      expect(await refusal(receive(setup, {}, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(receive(setup, {}, onProjects(randomUUID())))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      for (const status of ['DRAFT', 'IN_REVIEW', 'SUPERSEDED', 'CANCELLED']) {
        const closed = await seedBidPackage(harness, { status });
        await seedMilestone(harness, closed.packageId, 'BID_OPENING', { planned: hoursFromNow(48) });
        expect(await refusal(receive({ seeded: closed, contractorId: setup.contractorId }))).toMatchObject({ code: 'PACKAGE_STATE_INVALID', status: 409, extensions: { package_status: status } });
      }
    });

    it('refuses a contractor that is restricted (422 CONTRACTOR_RESTRICTED), one that is not verified (422 CONTRACTOR_NOT_VERIFIED) and one that does not exist (422 VALIDATION_FAILED)', async () => {
      const setup = await open();
      const restricted = await seedContractor(harness, { restricted: true });
      expect(await refusal(receive({ ...setup, contractorId: restricted }))).toMatchObject({ code: 'CONTRACTOR_RESTRICTED', status: 422, extensions: { restriction_kind: 'DEBARMENT' } });
      const unverified = await seedContractor(harness, { status: 'UNVERIFIED' });
      expect(await refusal(receive({ ...setup, contractorId: unverified }))).toMatchObject({ code: 'CONTRACTOR_NOT_VERIFIED', status: 422 });
      expect(await refusal(receive({ ...setup, contractorId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
      expect(await countProposals(setup.seeded.packageId)).toBe(0);
    });

    it('refuses a request whose files are not what a proposal is made of, and writes nothing', async () => {
      const setup = await open();
      const documents = async () => Number((await owner<{ n: string }>(`select count(*)::text as n from machvon.document where subject_module = 'BID_PROPOSAL'`))[0]?.n);
      const before = await documents();
      expect(await refusal(receive(setup, { files: [] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'documents' });
      expect(await refusal(receive(setup, { files: Array.from({ length: 501 }, (_, n) => fileOf(n + 1)) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'documents' });
      expect(await refusal(receive(setup, { files: [{ ...fileOf(1), part: 'SECRET' as never }] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'documents' });
      expect(await refusal(receive(setup, { files: [{ ...fileOf(1), title: '  ' }] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'documents' });
      expect(await refusal(receive(setup, { files: [{ ...fileOf(1), title: 'x'.repeat(201) }] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'documents' });
      expect(await refusal(receive(setup, { files: [fileOf(1), fileOf(1)] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'documents', extensions: { reason: 'DUPLICATE_FILE' } });
      expect(await refusal(receive(setup, { bidPriceVnd: '12.5' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'bid_price_vnd' });
      expect(await refusal(receive(setup, { bidPriceVnd: '-1' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'bid_price_vnd' });
      expect(await countProposals(setup.seeded.packageId)).toBe(0);
      expect(await documents()).toBe(before);
    });

    it('takes the proposal of the same contractor again as the next revision and sets the live one aside, while another contractor has a proposal of its own', async () => {
      const setup = await open();
      const first = await receive(setup);
      const second = await receive(setup, { bidPriceVnd: '1400000000' });
      expect(second).toMatchObject({ revision: 2, supersededId: first.id });
      expect((await proposalRow(first.id))?.status).toBe('SUPERSEDED');
      expect(Number((await proposalRow(first.id))?.version)).toBe(2);
      expect((await proposalRow(second.id))?.status).toBe('RECEIVED');
      const other = await receive({ ...setup, contractorId: await seedContractor(harness) });
      expect(other).toMatchObject({ revision: 1, supersededId: null });
      expect((await proposalRow(second.id))?.status).toBe('RECEIVED');
    });
  });

  describe('the opening of the bids follows the milestone', () => {
    const recordOpening = (setup: Setup, version: number, body: { plannedAt?: string; actualAt?: string }) =>
      as((tx) => milestones.record(tx, { packageId: setup.seeded.packageId, expectedVersion: version, kind: 'BID_OPENING', ...body }, memberId(CLERK), everything, new Date()));
    const releasedAt = async (proposalId: string) => (await proposalRow(proposalId))?.access_released_at;

    it('keeps the sealed proposals sealed when the opening is postponed, and follows it when it comes earlier', async () => {
      const setup = await open({ opening: { planned: hoursFromNow(48) } });
      const sealed = await receive(setup);
      const aside = await receive({ ...setup, contractorId: await seedContractor(harness) });
      await owner(`update machvon.proposal set status = 'SUPERSEDED' where id = $1::uuid`, [aside.id]);
      const later = hoursFromNow(72);
      await recordOpening(setup, 1, { plannedAt: later });
      expect(await releasedAt(sealed.id)).toBe(later);
      expect(Number((await proposalRow(sealed.id))?.version)).toBe(2);
      expect(await releasedAt(aside.id)).not.toBe(later);
      const earlier = hoursFromNow(40);
      await recordOpening(setup, 2, { plannedAt: earlier });
      expect(await releasedAt(sealed.id)).toBe(earlier);
    });

    it('refuses an opening that would seal again a proposal that was released (409 OPENING_ALREADY_RELEASED), and the database refuses it too', async () => {
      const setup = await open({ opening: { actual: hoursFromNow(-3) }, closing: null });
      const released = await seedProposal(harness, setup.seeded, setup.contractorId, { releasedAt: hoursFromNow(-3) });
      expect(await refusal(recordOpening(setup, 1, { actualAt: hoursFromNow(-1) }))).toMatchObject({ code: 'OPENING_ALREADY_RELEASED', status: 409, detail: 'actual_at' });
      expect(await databaseRefusal(owner(`update machvon.procurement_milestone set actual_at = now() - interval '1 hour' where package_id = $1::uuid and milestone_kind = 'BID_OPENING'`, [setup.seeded.packageId]))).toContain('unsealed at the earlier opening');
      expect(await databaseRefusal(owner(`update machvon.proposal set access_released_at = now() + interval '1 day' where id = $1::uuid`, [released.id]))).toContain('not sealed again');
      // An earlier opening is not a postponement: the release stands as it was.
      expect(await recordOpening(setup, 1, { actualAt: hoursFromNow(-4) })).toMatchObject({ kind: 'BID_OPENING' });
      expect(await releasedAt(released.id)).not.toBeUndefined();
    });

    it('refuses a postponement on a planned date as well, naming the field', async () => {
      const setup = await open({ opening: { planned: hoursFromNow(-3) }, closing: null });
      await seedProposal(harness, setup.seeded, setup.contractorId, { releasedAt: hoursFromNow(-3) });
      expect(await refusal(recordOpening(setup, 1, { plannedAt: hoursFromNow(-1) }))).toMatchObject({ code: 'OPENING_ALREADY_RELEASED', detail: 'planned_at' });
    });

    it('refuses a row of the file of the national network that would postpone the opening past the release, as a row error', async () => {
      const setup = await open({ opening: { planned: hoursFromNow(-3) }, closing: null });
      await seedProposal(harness, setup.seeded, setup.contractorId, { releasedAt: hoursFromNow(-3) });
      const adapter = new ProcurementImportAdapter({ scope: everything, actor: memberId(2), now: new Date() });
      const record = { packageCode: setup.seeded.packageCode, externalCode: 'EXT-1', milestoneKind: 'BID_OPENING' as const, actualAt: hoursFromNow(-1) };
      const rejected = await as((tx) => adapter.examine(tx, { record, businessKey: 'k', line: 2 } as never));
      expect(rejected).toEqual({ code: 'OPENING_ALREADY_RELEASED', field: 'actual_at' });
      const fine = await as((tx) => adapter.examine(tx, { record: { ...record, actualAt: hoursFromNow(-4) }, businessKey: 'k', line: 2 } as never));
      expect(fine).toBeUndefined();
    });
  });

  describe('what the database keeps', () => {
    it('keeps what the bidder handed in and does not delete a proposal', async () => {
      const setup = await open();
      const received = await receive(setup);
      for (const change of [`package_id = '${randomUUID()}'`, `contractor_id = '${randomUUID()}'`, 'revision = 9', `submitted_at = now()`, 'bid_price_vnd = 1', `document_version_ids = '[]'::jsonb`, `classification = 'INTERNAL'`]) {
        expect(await databaseRefusal(owner(`update machvon.proposal set ${change} where id = $1::uuid`, [received.id]))).toMatch(/keeps what the bidder handed in|violates foreign key/);
      }
      expect(await databaseRefusal(as((tx) => tx.query('delete from machvon.proposal where id = $1::uuid', [received.id])))).toContain('permission denied');
      expect(await databaseRefusal(owner(`update machvon.proposal set status = 'ARCHIVED' where id = $1::uuid`, [received.id]))).toContain('proposal_status_chk');
    });

    it('does not take a replaced or withdrawn proposal back, and withdrawing needs its reason', async () => {
      const setup = await open();
      const received = await receive(setup);
      expect(await databaseRefusal(owner(`update machvon.proposal set status = 'WITHDRAWN' where id = $1::uuid`, [received.id]))).toContain('proposal_withdrawn_chk');
      await owner(`update machvon.proposal set status = 'WITHDRAWN', withdrawn_reason = 'The bidder withdrew.' where id = $1::uuid`, [received.id]);
      expect(await databaseRefusal(owner(`update machvon.proposal set status = 'RECEIVED', withdrawn_reason = null where id = $1::uuid`, [received.id]))).toContain('stays so');
    });

    it('refuses a proposal for a package of another project, one that starts in another state, and a second live proposal of one contractor', async () => {
      const setup = await open();
      const other = await seedBidPackage(harness);
      const insert = (projectId: string, packageId: string, status: string, contractorId = setup.contractorId, revision = 1) =>
        owner(
          `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, access_released_at, created_by)
           values ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, now(), now() + interval '1 day', $8)`,
          [TENANT_A, randomUUID(), projectId, packageId, contractorId, revision, status, memberId(CLERK)],
        );
      expect(await databaseRefusal(insert(other.projectId, setup.seeded.packageId, 'RECEIVED'))).toContain('a package of its project');
      expect(await databaseRefusal(insert(setup.seeded.projectId, setup.seeded.packageId, 'SUPERSEDED'))).toContain('starts received');
      await insert(setup.seeded.projectId, setup.seeded.packageId, 'RECEIVED');
      expect(await databaseRefusal(insert(setup.seeded.projectId, setup.seeded.packageId, 'RECEIVED', setup.contractorId, 2))).toContain('proposal_one_live_uq');
      expect(await databaseRefusal(insert(setup.seeded.projectId, setup.seeded.packageId, 'RECEIVED', setup.contractorId, 1))).toMatch(/proposal_revision_uq|proposal_one_live_uq/);
    });

    it('keeps the files of a proposal as a record and takes only a clean confidential attachment about the proposal', async () => {
      const setup = await open();
      const received = await receive(setup);
      const [file] = await owner<{ id: string; document_version_id: string }>('select id, document_version_id from machvon.proposal_document where proposal_id = $1::uuid limit 1', [received.id]);
      expect(await databaseRefusal(owner(`update machvon.proposal_document set part = 'OTHER' where id = $1::uuid`, [file?.id]))).toContain('a record');
      expect(await databaseRefusal(as((tx) => tx.query('delete from machvon.proposal_document where id = $1::uuid', [file?.id])))).toContain('permission denied');
      const another = await receive({ ...setup, contractorId: await seedContractor(harness) });
      // A version of the other proposal, one that is not clean and one of an ordinary document are not files of this proposal.
      expect(await databaseRefusal(owner(`insert into machvon.proposal_document (tenant_id, id, proposal_id, document_version_id, part, received_by) values ($1, $2, $3, $4, 'OTHER', $5)`, [TENANT_A, randomUUID(), another.id, file?.document_version_id, memberId(CLERK)]))).toContain('a clean confidential attachment');
      expect(await databaseRefusal(owner(`insert into machvon.proposal_document (tenant_id, id, proposal_id, document_version_id, part, received_by) values ($1, $2, $3, $4, 'SECRET', $5)`, [TENANT_A, randomUUID(), another.id, randomUUID(), memberId(CLERK)]))).toMatch(/proposal_document_part_check|violates|clean confidential/);
    });

    it('does not serve the files of a sealed proposal through the reads of the document module', async () => {
      const documents = new DocumentStore();
      const setup = await open();
      const received = await receive(setup);
      const [file] = await owner<{ document_version_id: string }>('select document_version_id from machvon.proposal_document where proposal_id = $1::uuid limit 1', [received.id]);
      expect(await as((tx) => documents.findVersion(tx, file?.document_version_id ?? '', everything))).toBeUndefined();
      const listed = await as((tx) => documents.listVersions(tx, { limit: 500, after: undefined }, everything));
      expect(listed.some((version) => version.id === file?.document_version_id)).toBe(false);
    });
  });
});
