import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FieldCipher, staticKeyProvider } from '@machvon/kernel';
import { HomeVendorInvestigationSources } from '../src/home-vendor-investigation-sources';
import { VendorGate } from '../src/vendor-gate';
import { VendorLeadStore } from '../src/vnd-lead-store';
import { VendorLinkStore } from '../src/vnd-link-store';
import { VendorScreeningStore } from '../src/vnd-screening-store';
import { VendorTraceStore } from '../src/vnd-trace-store';
import { WorkCalendarStore } from '../src/work-calendar-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
const leads = new VendorLeadStore();
const links = new VendorLinkStore();
const screening = new VendorScreeningStore();
const traces = new VendorTraceStore(cipher);
const gate = new VendorGate();
const calendars = new WorkCalendarStore();

const [M1, M2, M3, M4, M5] = [1, 2, 3, 4, 5];
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = M1): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const NOW = new Date('2026-11-09T03:00:00Z');
const TODAY = '2026-11-09';
const day = (offset: number): Date => new Date(NOW.getTime() + offset * 86_400_000);
const dayText = (offset: number): string => day(offset).toISOString().slice(0, 10);
const key = (seed: string): string => seed.repeat(64).slice(0, 64);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

/** Seeds a row of a table this story only reads (a project) with the foreign keys it has to other modules switched off. */
async function seedReplica(sql: string, params: unknown[]): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function document(): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', '12/QD', date '2026-01-01', 'EFFECTIVE', $3, $3)`,
    [TENANT_A, id, memberId(M1)],
  );
  return id;
}

let counter = 0;
async function contractor(name: string, taxId?: string): Promise<string> {
  counter += 1;
  const id = randomUUID();
  const profile = await document();
  await owner(
    `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by, verified_by, verified_at, verification_evidence_document_id, verification_basis)
     values ($1, $2, $3, $4, 'VERIFIED', $5, $6, $6, $7, now(), $8, 'EVIDENCE_DOCUMENT')`,
    [TENANT_A, id, taxId ?? `05${String(counter).padStart(8, '0')}`, name, profile, memberId(M1), memberId(M2), await document()],
  );
  return id;
}

const setKeys = (id: string, keys: { rep?: string; address?: string; phone?: string; email?: string }): Promise<unknown> =>
  owner(
    `update machvon.contractor set legal_rep_key = $2, address_key = $3, phone = case when $4::text is null then null else '0912345678' end, phone_key = $4, phone_set_at = case when $4::text is null then null else now() end,
       email = case when $5::text is null then null else 'contact@firm.vn' end, email_key = $5 where id = $1`,
    [id, keys.rep ?? null, keys.address ?? null, keys.phone ?? null, keys.email ?? null],
  );

interface Bid {
  contractor: string;
  price: string;
  files?: string[];
}

/** A closed package: a project of unit 1, a package drafted by `drafter`, bids as proposals, and an approved result. */
async function closedPackage(code: string, bids: Bid[], winner: string, drafter = M4): Promise<{ packageId: string; proposals: Map<string, string> }> {
  const projectId = randomUUID();
  const packageId = randomUUID();
  await seedReplica(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
     values ($1, $2, $3, 'Investigation project', $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
    [TENANT_A, projectId, `P-${code}`, unitId(1), randomUUID()],
  );
  await owner(
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by)
     values ($1, $2, $3, $4, 5000000000, 'OPEN_BIDDING', 1, 'AWARDED', 'Package', $5)`,
    [TENANT_A, packageId, projectId, code, memberId(drafter)],
  );
  const proposals = new Map<string, string>();
  for (const bid of bids) {
    const id = randomUUID();
    proposals.set(bid.contractor, id);
    await owner(
      `insert into machvon.proposal (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, bid_price_vnd, submitted_at, access_released_at, created_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, 1, 'RECEIVED', $7::numeric, $8::timestamptz, $8::timestamptz, $9)`,
      [TENANT_A, id, projectId, packageId, bid.contractor, JSON.stringify(bid.files ?? []), bid.price, day(-20).toISOString(), memberId(M1)],
    );
  }
  await owner(
    `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, decision_document_id, outcome, status, submitted_by, approved_by, approved_at, created_by, updated_by)
     values ($1, $2, $3, $4, 1000, $5, 'AWARDED', 'APPROVED', $6, $7, $8::timestamptz, $6, $6)`,
    [TENANT_A, randomUUID(), packageId, winner, await document(), memberId(M1), memberId(M2), day(-10).toISOString()],
  );
  return { packageId, proposals };
}

describe('the investigation and the screening of contractors (VND-3)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    for (const member of [M1, M2, M3, M4, M5]) await harness.seedMembership(TENANT_A, member, 1);
    for (const year of [2026, 2027, 2028]) {
      await as(async (tx) => {
        const draft = await calendars.createDraft(tx, { calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code' }, memberId(M1));
        const locked = await calendars.lockDraft(tx, draft.id, draft.version);
        await calendars.publish(tx, locked, memberId(M1));
      });
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the related-party links and the leads', () => {
    it('builds a link and a lead from shared keys, is idempotent, and marks a link stale when the shared keys go', async () => {
      const a = await contractor('Cty Lien Ket A');
      const b = await contractor('Cty Lien Ket B');
      const c = await contractor('Cty Lien Ket C');
      await setKeys(a, { rep: key('1'), address: key('2'), phone: key('3') });
      await setKeys(b, { rep: key('1'), address: key('2'), phone: key('3') });
      await setKeys(c, { address: key('2') });
      const first = await as((tx) => leads.scan(tx, memberId(M1), 'MANUAL', NOW, TODAY, 'first scan'));
      expect(first).toMatchObject({ links: 1, clusters: 1, leadsNew: 1, leadsReopened: 0 });
      const [lead] = await as((tx) => leads.list(tx, memberId(M1), { limit: 10, kind: 'LINK_CLUSTER' }));
      expect(lead).toMatchObject({ kind: 'LINK_CLUSTER', status: 'NEW', rank: 88, contractorIds: [a, b].sort(), evaluationCount: 1, version: 1 });
      expect(JSON.stringify(lead?.evidence)).not.toContain(key('1'));
      const second = await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      expect(second).toMatchObject({ leadsNew: 0, leadsUpdated: 1 });
      const [again] = await as((tx) => leads.list(tx, memberId(M1), { limit: 10, kind: 'LINK_CLUSTER' }));
      expect(again).toMatchObject({ id: lead?.id, evaluationCount: 2, version: 1 });
      expect((await owner<{ status: string }>('select status from machvon.contractor_party_link')).map((row) => row.status)).toEqual(['ACTIVE']);
      expect((await as((tx) => links.linksOf(tx, [a], false))).length).toBe(1);
      await setKeys(b, {});
      await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      expect((await owner<{ status: string }>('select status from machvon.contractor_party_link')).map((row) => row.status)).toEqual(['STALE']);
      expect((await as((tx) => leads.list(tx, memberId(M1), { limit: 10, kind: 'LINK_CLUSTER' }))).length).toBe(1);
      await expect(as((tx) => tx.query('delete from machvon.contractor_party_link'))).rejects.toThrow();
      await expect(owner('update machvon.vendor_link_scan set links = 99')).rejects.toThrow(/appended once/);
    });

    it('reviews a lead in two steps by two auditors, keeps the history, and reopens a dismissed lead only on a new kind of evidence', async () => {
      const a = await contractor('Cty Duyet A');
      const b = await contractor('Cty Duyet B');
      await setKeys(a, { rep: key('4'), address: key('5'), phone: key('6') });
      await setKeys(b, { rep: key('4'), address: key('5'), phone: key('6') });
      await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      const found = (await as((tx) => leads.list(tx, memberId(M4), { limit: 50, kind: 'LINK_CLUSTER', contractorId: a })))[0];
      const id = (found as NonNullable<typeof found>).id;
      const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);
      const taken = await as((tx) => leads.move(tx, memberId(M4), id, 1, 'TAKE', undefined, at(1)), M4);
      expect(taken).toMatchObject({ status: 'IN_REVIEW', reviewerId: memberId(M4), version: 2 });
      expect((await refusal(as((tx) => leads.move(tx, memberId(M4), id, 1, 'TAKE', undefined, NOW), M4))).code).toBe('VERSION_CONFLICT');
      expect((await refusal(as((tx) => leads.move(tx, memberId(M4), id, 2, 'PROPOSE_DISMISS', 'no', NOW), M4))).code).toBe('VALIDATION_FAILED');
      await as((tx) => leads.move(tx, memberId(M4), id, 2, 'PROPOSE_DISMISS', 'the address is a shared accounting office', at(2)), M4);
      expect((await refusal(as((tx) => leads.move(tx, memberId(M4), id, 3, 'CONFIRM_DISMISS', undefined, NOW), M4))).code).toBe('SELF_APPROVAL_DENIED');
      const dismissed = await as((tx) => leads.move(tx, memberId(M5), id, 3, 'CONFIRM_DISMISS', undefined, at(3)), M5);
      expect(dismissed).toMatchObject({ status: 'DISMISSED', decidedRank: dismissed.rank });
      expect((await refusal(as((tx) => leads.move(tx, memberId(M5), id, 4, 'REFER', 'send it to the inspectorate', NOW), M5))).code).toBe('LEAD_STATE_INVALID');
      expect((await as((tx) => leads.historyOf(tx, id))).map((row) => row.move)).toEqual(['SCAN_NEW', 'TAKE', 'PROPOSE_DISMISS', 'CONFIRM_DISMISS']);
      await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      expect((await as((tx) => leads.findOne(tx, memberId(M1), id)))?.status).toBe('DISMISSED');
      await setKeys(a, { rep: key('4'), address: key('5'), phone: key('6'), email: key('7') });
      await setKeys(b, { rep: key('4'), address: key('5'), phone: key('6'), email: key('7') });
      const reopened = await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      expect(reopened.leadsReopened).toBe(1);
      expect(await as((tx) => leads.findOne(tx, memberId(M1), id))).toMatchObject({ status: 'NEW', reopenedCount: 1, dismissProposedBy: null, evidenceKinds: expect.arrayContaining(['EMAIL']) });
    });

    it('finds a cover bid in a closed package and hides the lead from the people who took part in the package', async () => {
      const x = await contractor('Cty Thau X');
      const y = await contractor('Cty Thau Y');
      const z = await contractor('Cty Thau Z');
      const made = await closedPackage('GT-COVER', [
        { contractor: x, price: '1000000000' },
        { contractor: y, price: '1003000000' },
        { contractor: z, price: '1500000000' },
      ], x, M3);
      const summary = await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      expect(summary.packages).toBeGreaterThanOrEqual(1);
      const mine = await as((tx) => leads.list(tx, memberId(M5), { limit: 50, kind: 'COVER_BID' }), M5);
      const lead = mine.find((row) => row.packageIds.includes(made.packageId));
      expect(lead).toMatchObject({ kind: 'COVER_BID', rank: 75, contractorIds: [x, y, z].sort() });
      expect(await as((tx) => leads.findOne(tx, memberId(M3), (lead as NonNullable<typeof lead>).id), M3)).toBeUndefined();
      expect((await as((tx) => leads.list(tx, memberId(M3), { limit: 50, kind: 'COVER_BID' }), M3)).some((row) => row.packageIds.includes(made.packageId))).toBe(false);
      expect((await refusal(as((tx) => leads.move(tx, memberId(M3), (lead as NonNullable<typeof lead>).id, 1, 'TAKE', undefined, NOW), M3))).code).toBe('RESOURCE_NOT_FOUND');
      const counts = await as((tx) => leads.counts(tx, memberId(M3)), M3);
      const all = await as((tx) => leads.counts(tx, memberId(M5)), M5);
      expect(counts.NEW).toBeLessThan(all.NEW);
      const rows = await as((tx) => new HomeVendorInvestigationSources().items({ tx, membershipId: memberId(M3), now: NOW, today: TODAY, view: 'scope', rules: {}, counting: false, holds: () => true } as never), M3);
      expect(rows.some((row) => row.id === lead?.id)).toBe(false);
      const visible = await as((tx) => new HomeVendorInvestigationSources().items({ tx, membershipId: memberId(M5), now: NOW, today: TODAY, view: 'scope', rules: {}, counting: false, holds: () => true } as never), M5);
      expect(visible.find((row) => row.id === lead?.id)).toMatchObject({ kind: 'VENDOR_LINK_LEAD', severity: 'ACTION' });
      const nobody = await as((tx) => new HomeVendorInvestigationSources().items({ tx, membershipId: memberId(M5), now: NOW, today: TODAY, view: 'scope', rules: {}, counting: false, holds: () => false } as never), M5);
      expect(nobody.some((row) => row.kind === 'VENDOR_LINK_LEAD')).toBe(false);
    });

    it('records the trace of a submission once, keeps only keys, and finds the same file fingerprint in two proposals', async () => {
      const p = await contractor('Cty Tep P');
      const q = await contractor('Cty Tep Q');
      const fileP = randomUUID();
      const fileQ = randomUUID();
      const made = await closedPackage('GT-FILES', [
        { contractor: p, price: '2000000000', files: [fileP] },
        { contractor: q, price: '2400000000', files: [fileQ] },
      ], p, M4);
      const tracing = (proposal: string, file: string) =>
        as((tx) => traces.record(tx, TENANT_A, proposal, { origin: '203.0.113.7', device: 'device-77', agent: 'Mozilla/5.0', submittedAt: day(-20).toISOString(), files: [{ documentVersionId: file, author: 'Nguyen Van A', producer: 'Microsoft Word 16', createdStamp: '2026-10-01T08:00:00Z' }] }, memberId(M1)));
      const traceP = await tracing(made.proposals.get(p) as string, fileP);
      expect(traceP.files).toBe(1);
      expect((await refusal(tracing(made.proposals.get(p) as string, fileP))).code).toBe('SUBMISSION_TRACE_EXISTS');
      expect((await refusal(as((tx) => traces.record(tx, TENANT_A, made.proposals.get(q) as string, { origin: '1.2.3.4', files: [{ documentVersionId: randomUUID(), author: 'x' }] }, memberId(M1))))).code).toBe('VALIDATION_FAILED');
      expect((await refusal(as((tx) => traces.record(tx, TENANT_A, randomUUID(), { origin: '1.2.3.4' }, memberId(M1))))).code).toBe('RESOURCE_NOT_FOUND');
      await tracing(made.proposals.get(q) as string, fileQ);
      const stored = await owner<{ origin_key: string; device_key: string }>('select origin_key, device_key from machvon.proposal_submission_trace where proposal_id = $1', [made.proposals.get(p)]);
      expect(stored[0]?.origin_key).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain('203.0.113.7');
      await expect(owner("update machvon.proposal_submission_trace set origin_key = repeat('a', 64)")).rejects.toThrow(/appended once/);
      await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      const found = (await as((tx) => leads.list(tx, memberId(M5), { limit: 100 }), M5)).filter((row) => row.packageIds.includes(made.packageId)).map((row) => row.kind).sort();
      expect(found).toEqual(expect.arrayContaining(['FILE_METADATA', 'SHARED_ORIGIN']));
      const coverage = await as((tx) => leads.traceCoverage(tx, [made.packageId]));
      expect(coverage).toEqual({ bids: 2, withOrigin: 2, withFiles: 2 });
    });

    it('opens a lead about a new company of a banned party', async () => {
      const banned = await contractor('Cty Bi Cam');
      const fresh = await contractor('Cty Moi Lap');
      await setKeys(banned, { rep: key('b'), address: key('c'), phone: key('d') });
      await setKeys(fresh, { rep: key('b'), address: key('c'), phone: key('d') });
      await owner(
        `insert into machvon.contractor_restriction (tenant_id, id, contractor_id, kind, source, effective_from, decision_document_id, created_by, updated_by) values ($1, $2, $3, 'DEBARMENT', 'DECISION', '2026-01-01', $4, $5, $5)`,
        [TENANT_A, randomUUID(), banned, await document(), memberId(M1)],
      );
      await as((tx) => leads.scan(tx, null, 'JOB', NOW, TODAY));
      const found = (await as((tx) => leads.list(tx, memberId(M1), { limit: 100, kind: 'RESTRICTED_AFFILIATE', contractorId: fresh })))[0];
      expect(found).toMatchObject({ kind: 'RESTRICTED_AFFILIATE', evidence: { restricted: [banned], affiliates: [fresh] } });
    });
  });

  describe('the screening', () => {
    let seed = 0;
    async function nationalRecord(taxCode: string, name: string, validFrom = '2026-10-01', validUntil = '2027-12-31'): Promise<string> {
      seed += 1;
      const importId = randomUUID();
      await owner(
        `insert into machvon.file_import (tenant_id, id, connector_code, format_version, file_sha256, file_object_key, status, rows_total, rows_applied, imported_by, completed_at)
         values ($1, $2, 'EGP_RESTRICTION_FILE', 'V1', $3, 'k', 'APPLIED', 1, 1, $4, now())`,
        [TENANT_A, importId, String(seed).padStart(64, '0'), memberId(M1)],
      );
      const id = randomUUID();
      await owner(
        `insert into machvon.egp_record (tenant_id, id, kind, business_key, layout_version, import_id, line, row_hash, record, applied_by)
         values ($1, $2, 'RESTRICTION', $3, 'WORKING-ASSUMPTION-2026.2', $4, 1, $5, $6::jsonb, $7)`,
        [TENANT_A, id, `R${seed}|${taxCode}`, importId, String(seed).padStart(64, 'c'), JSON.stringify({ restrictionCode: `R${seed}`, contractorTaxCode: taxCode, contractorName: name, restrictionKind: 'DEBARMENT', scope: 'NATIONWIDE', validFrom, validUntil, decisionNo: `QD-${seed}`, decisionDate: validFrom, legalBasis: null }), memberId(M1)],
      );
      return id;
    }

    it('finds a contractor on the national list by its tax code, holds it, and the gate refuses until a person decides', async () => {
      const id = await contractor('Cty Sang Loc A', '0600000001');
      await nationalRecord('0600000001', 'Cong ty Sang Loc A');
      const run = await as((tx) => screening.run(tx, memberId(M1), 'MANUAL', NOW, TODAY));
      expect(run).toMatchObject({ hitsNew: 1, holds: 1 });
      const [hit] = await as((tx) => screening.list(tx, { contractorId: id, limit: 10 }));
      expect(hit).toMatchObject({ contractorId: id, source: 'NATIONAL_DEBARMENT', score: 100, hold: true, status: 'PENDING', basis: expect.arrayContaining(['TAX_CODE']) });
      const refused = await refusal(as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: id, now: NOW })));
      expect(refused).toMatchObject({ code: 'CONTRACTOR_SCREENING_HOLD', status: 422, extensions: { hit_ids: [(hit as NonNullable<typeof hit>).id], sources: ['NATIONAL_DEBARMENT'] } });
      const second = await as((tx) => screening.run(tx, null, 'NIGHTLY', NOW, TODAY));
      expect(second).toMatchObject({ hitsNew: 0, hitsReopened: 0 });
      expect((await as((tx) => screening.list(tx, { contractorId: id, limit: 10 }))).length).toBe(1);
      expect((await refusal(as((tx) => screening.dismiss(tx, (hit as NonNullable<typeof hit>).id, 1, 'too short', memberId(M2), NOW), M2))).code).toBe('VALIDATION_FAILED');
      const dismissed = await as((tx) => screening.dismiss(tx, (hit as NonNullable<typeof hit>).id, 1, 'a different company: other founders, other address, other registration day', memberId(M2), NOW), M2);
      expect(dismissed).toMatchObject({ status: 'DISMISSED', hold: false, decidedBy: memberId(M2) });
      await expect(as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: id, now: NOW }))).resolves.toBeDefined();
      expect((await refusal(as((tx) => screening.confirm(tx, dismissed.id, dismissed.version, { violationGroups: ['GROUP_2'] }, memberId(M2), NOW), M2))).code).toBe('SCREENING_HIT_STATE_INVALID');
      expect((await as((tx) => screening.events(tx, dismissed.id))).map((row) => row.move)).toEqual(['FOUND', 'DISMISS']);
      const quiet = await as((tx) => screening.run(tx, null, 'NIGHTLY', day(30), dayText(30)));
      expect(quiet.hitsReopened).toBe(0);
      const later = await as((tx) => screening.run(tx, null, 'NIGHTLY', day(400), dayText(400)));
      expect(later.hitsReopened).toBe(1);
      expect((await as((tx) => screening.find(tx, dismissed.id)))).toMatchObject({ status: 'PENDING', reopenedCount: 1, hold: true });
    });

    it('confirms a hit on the national list by opening the debarment case, keeps the hold, and resolves it when the case has its decision', async () => {
      const id = await contractor('Cty Sang Loc B', '0600000002');
      await nationalRecord('0600000002', 'Cong ty Sang Loc B');
      await as((tx) => screening.run(tx, null, 'NIGHTLY', NOW, TODAY));
      const [hit] = await as((tx) => screening.list(tx, { contractorId: id, limit: 10 }));
      const target = hit as NonNullable<typeof hit>;
      expect((await refusal(as((tx) => screening.confirm(tx, target.id, target.version, {}, memberId(M1), NOW)))).detail).toBe('violation_groups');
      const confirmed = await as((tx) => screening.confirm(tx, target.id, target.version, { violationGroups: ['GROUP_2'], note: 'checked against the decision' }, memberId(M1), NOW));
      expect(confirmed).toMatchObject({ status: 'CONFIRMED', hold: true });
      expect(confirmed.caseId).not.toBeNull();
      const [opened] = await owner<{ trigger_kind: string; contractor_id: string; egp_record_id: string }>('select trigger_kind, contractor_id, egp_record_id from machvon.restriction_case where id = $1', [confirmed.caseId]);
      expect(opened).toMatchObject({ trigger_kind: 'EGP_IMPORT', contractor_id: id, egp_record_id: target.egpRecordId });
      expect((await refusal(as((tx) => gate.assertAllowed(tx, 'RESULT', { contractorId: id, now: NOW })))).code).toBe('CONTRACTOR_SCREENING_HOLD');
    });

    it('imports a list once, upserts entries, withdraws the ones a later import drops, and resolves a pending hit whose entry left', async () => {
      const id = await contractor('Cty Sang Loc C', '0600000003');
      const input = { source: 'WORLD_BANK' as const, asOf: TODAY, reference: 'WB sanctions list 2026-11-09', entries: [{ ref: 'WB-1', name: 'Sang Loc C Construction', taxCode: '0600000003' }, { ref: 'WB-2', name: 'Unrelated Trading', taxCode: '0777777777' }] };
      const first = await as((tx) => screening.importList(tx, input, memberId(M1)));
      expect(first).toMatchObject({ entries: 2, withdrawn: 0, replayed: false });
      expect(await as((tx) => screening.importList(tx, input, memberId(M1)))).toMatchObject({ importId: first.importId, replayed: true });
      expect((await refusal(as((tx) => screening.importList(tx, { ...input, source: 'NATIONAL_DEBARMENT' }, memberId(M1))))).code).toBe('VALIDATION_FAILED');
      expect((await refusal(as((tx) => screening.importList(tx, { ...input, entries: [{ ref: 'a' }] }, memberId(M1))))).detail).toBe('entries');
      await as((tx) => screening.run(tx, memberId(M1), 'LIST_IMPORT', NOW, TODAY));
      const [hit] = await as((tx) => screening.list(tx, { contractorId: id, source: 'WORLD_BANK', limit: 10 }));
      expect(hit).toMatchObject({ source: 'WORLD_BANK', entryRef: 'WB-1', hold: true, status: 'PENDING', egpRecordId: null });
      const sources = await as((tx) => screening.sources(tx));
      expect(sources.find((row) => row.source === 'WORLD_BANK')).toMatchObject({ entries: 2, reference: 'WB sanctions list 2026-11-09' });
      const next = await as((tx) => screening.importList(tx, { ...input, asOf: dayText(1), reference: 'WB sanctions list 2026-11-10', entries: [{ ref: 'WB-2', name: 'Unrelated Trading', taxCode: '0777777777' }] }, memberId(M1)));
      expect(next).toMatchObject({ entries: 1, withdrawn: 1 });
      const run = await as((tx) => screening.run(tx, null, 'LIST_IMPORT', NOW, TODAY));
      expect(run.hitsResolved).toBe(1);
      expect((await as((tx) => screening.find(tx, (hit as NonNullable<typeof hit>).id)))).toMatchObject({ status: 'RESOLVED', hold: false });
      await expect(as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: id, now: NOW }))).resolves.toBeDefined();
      const timeliness = await as((tx) => screening.timeliness(tx, 5, NOW));
      expect(timeliness.inTime + timeliness.late + timeliness.overduePending).toBeGreaterThanOrEqual(1);
    });

    it('an empty list retires a source, and a hit that was resolved comes back when the entry is listed again', async () => {
      const id = await contractor('Cty Tai Hien D', '0600000005');
      const entries = [{ ref: 'ADB-9', name: 'Tai Hien D', taxCode: '0600000005' }];
      await as((tx) => screening.importList(tx, { source: 'ADB', asOf: TODAY, reference: 'ADB list one', entries }, memberId(M1)));
      await as((tx) => screening.run(tx, null, 'LIST_IMPORT', NOW, TODAY));
      const [first] = await as((tx) => screening.list(tx, { contractorId: id, source: 'ADB', limit: 10 }));
      expect(first).toMatchObject({ status: 'PENDING', hold: true });
      expect(await as((tx) => screening.importList(tx, { source: 'ADB', asOf: dayText(1), reference: 'ADB list two', entries: [] }, memberId(M1)))).toMatchObject({ entries: 0, withdrawn: 1 });
      await as((tx) => screening.run(tx, null, 'LIST_IMPORT', NOW, TODAY));
      expect(await as((tx) => screening.find(tx, (first as NonNullable<typeof first>).id))).toMatchObject({ status: 'RESOLVED', hold: false });
      await as((tx) => screening.importList(tx, { source: 'ADB', asOf: dayText(2), reference: 'ADB list three', entries }, memberId(M1)));
      await as((tx) => screening.run(tx, null, 'LIST_IMPORT', NOW, TODAY));
      expect(await as((tx) => screening.find(tx, (first as NonNullable<typeof first>).id))).toMatchObject({ status: 'PENDING', hold: true });
    });

    it('a name alone is never a hold and appears as a pending hit below the hold line', async () => {
      const id = await contractor('Xay dung Hoa Mai', '0600000004');
      await as((tx) => screening.importList(tx, { source: 'OTHER_LIST', asOf: TODAY, reference: 'list of the tenant', entries: [{ ref: 'T-1', name: 'Cong ty Xay dung Hoa Mai' }] }, memberId(M1)));
      await as((tx) => screening.run(tx, null, 'MANUAL', NOW, TODAY));
      const [hit] = await as((tx) => screening.list(tx, { contractorId: id, source: 'OTHER_LIST', limit: 10 }));
      expect(hit).toMatchObject({ basis: ['NAME'], hold: false, status: 'PENDING' });
      await expect(as((tx) => gate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: id, now: NOW }))).resolves.toBeDefined();
      const rows = await as((tx) => new HomeVendorInvestigationSources().items({ tx, membershipId: memberId(M1), now: NOW, today: TODAY, view: 'scope', rules: {}, counting: false, holds: () => true } as never));
      expect(rows.find((row) => row.id === (hit as NonNullable<typeof hit>).id)).toMatchObject({ kind: 'VENDOR_SCREENING_HIT', severity: 'ACTION' });
    });
  });
});
