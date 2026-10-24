import { CapAvcPolicyStore } from '../src/cap-avc-policy-store';
import type { AvcPolicyRecord, NewAvcPolicy } from '../src/cap-avc-policy-store';
import { BQL1, CapWorld, MAKER, APPROVER, PUBLISHER, ROOT, money } from './support/cap-fixtures';
import { memberId, unitId } from './support/authz-fixtures';

const world = new CapWorld();
const policies = new CapAvcPolicyStore();

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
};

let counter = 0;
/** A policy of its own year unless the test names the dates, so two published tenant policies of the tests never overlap by accident. */
const tenantPolicy = (overrides: Partial<NewAvcPolicy> = {}): NewAvcPolicy => {
  counter += 1;
  const year = 2040 + counter;
  const period = overrides.effectiveFrom === undefined ? { effectiveUntil: `${year}-12-31` } : {};
  return {
    policyCode: `AVC-${counter}`,
    scopeKind: 'TENANT',
    controlObject: 'ALLOCATION_LINE',
    warnPct: '90',
    blockPct: '100',
    legalBasis: 'Quyết định 12/QĐ-UBND về kiểm soát vốn',
    ...period,
    ...overrides,
    effectiveFrom: overrides.effectiveFrom ?? `${year}-01-01`,
  };
};

const create = (input: NewAvcPolicy, member = MAKER): Promise<AvcPolicyRecord> => world.as((tx) => policies.create(tx, input, memberId(member)), member);
const publish = (id: string, version: number, member = APPROVER) => world.as((tx) => policies.publish(tx, id, version, memberId(member)), member);
const published = async (input: NewAvcPolicy): Promise<AvcPolicyRecord> => {
  const draft = await create(input);
  return (await publish(draft.id, draft.version)).policy;
};
const find = (id: string) => world.as((tx) => policies.find(tx, id));
const governing = (context: Parameters<CapAvcPolicyStore['governing']>[1], date = '2026-06-15') => world.as((tx) => policies.governing(tx, context, date));

beforeAll(() => world.start(), 240_000);
afterAll(() => world.stop(), 60_000);
jest.setTimeout(240_000);

describe('CapAvcPolicyStore.create (createAvcPolicyVersion)', () => {
  it('drafts a policy with the thresholds, the scope, the object and the legal basis it was given, as revision 1', async () => {
    const draft = await create(tenantPolicy({ policyCode: 'TENANT-DEFAULT', includeReservations: false, effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' }));
    expect(draft).toMatchObject({
      policyCode: 'TENANT-DEFAULT',
      revision: 1,
      scopeKind: 'TENANT',
      scopeRefId: null,
      scopeValue: null,
      controlObject: 'ALLOCATION_LINE',
      warnPct: '90.00',
      blockPct: '100.00',
      includeReservations: false,
      effectiveFrom: '2026-01-01',
      effectiveUntil: '2026-12-31',
      status: 'DRAFT',
      approvedBy: null,
      version: 1,
    });
    expect(draft.legalBasis).toBe('Quyết định 12/QĐ-UBND về kiểm soát vốn');
  });

  it('numbers the revisions of a code, and keeps the code to one scope and one object', async () => {
    const first = await create(tenantPolicy({ policyCode: 'ONE-CODE' }));
    const second = await create(tenantPolicy({ policyCode: 'ONE-CODE', warnPct: '80' }));
    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(await refusal(create(tenantPolicy({ policyCode: 'ONE-CODE', scopeKind: 'PROJECT_GROUP', scopeValue: 'A' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'policy_code', extensions: { reason: 'CODE_HAS_OTHER_SCOPE' } });
    expect(await refusal(create(tenantPolicy({ policyCode: 'ONE-CODE', controlObject: 'APPROPRIATION' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'policy_code' });
  });

  it('refuses thresholds that let spending through twice over or warn after the block (AC-ST-CAP-005-2)', async () => {
    expect(await refusal(create(tenantPolicy({ warnPct: '95', blockPct: '90' })))).toMatchObject({ code: 'AVC_THRESHOLD_INVALID', status: 422, detail: 'warn_pct', extensions: { threshold_problem: 'WARN_ABOVE_BLOCK' } });
    expect(await refusal(create(tenantPolicy({ blockPct: '100.5' })))).toMatchObject({ code: 'AVC_THRESHOLD_INVALID', status: 422, detail: 'block_pct' });
    expect(await refusal(create(tenantPolicy({ blockPct: '150' })))).toMatchObject({ code: 'AVC_THRESHOLD_INVALID', status: 422, detail: 'block_pct' });
    expect(await world.owner("select count(*)::text as n from machvon.avc_policy where warn_pct > block_pct or block_pct > 100")).toEqual([{ n: '0' }]);
  });

  it('refuses a scope that does not say what it should, a unit or a fund source that does not exist, a code, a legal basis and a period that are not right', async () => {
    const cases: Array<[Partial<NewAvcPolicy>, string]> = [
      [{ scopeKind: 'TENANT', scopeValue: 'A' }, 'scope_value'],
      [{ scopeKind: 'TENANT', scopeRefId: unitId(BQL1) }, 'scope_ref_id'],
      [{ scopeKind: 'UNIT' }, 'scope_ref_id'],
      [{ scopeKind: 'UNIT', scopeRefId: 'not-a-uuid' }, 'scope_ref_id'],
      [{ scopeKind: 'UNIT', scopeRefId: unitId(BQL1), scopeValue: 'A' }, 'scope_value'],
      [{ scopeKind: 'FUND_SOURCE' }, 'scope_value'],
      [{ scopeKind: 'FUND_SOURCE', scopeValue: 'NO SUCH KEY', scopeRefId: unitId(BQL1) }, 'scope_ref_id'],
      [{ scopeKind: 'FUND_SOURCE', scopeValue: 'MISSING-KEY' }, 'scope_value'],
      [{ scopeKind: 'PROJECT_GROUP' }, 'scope_value'],
      [{ scopeKind: 'PROJECT_GROUP', scopeValue: 'D' }, 'scope_value'],
      [{ scopeKind: 'PROJECT_GROUP', scopeValue: 'A', scopeRefId: unitId(BQL1) }, 'scope_ref_id'],
      [{ policyCode: 'not valid' }, 'policy_code'],
      [{ legalBasis: '  ' }, 'legal_basis'],
      [{ effectiveFrom: '2026-02-30' }, 'effective_from'],
      [{ effectiveUntil: '2025-12-31' }, 'effective_until'],
    ];
    for (const [overrides, field] of cases) expect(await refusal(create(tenantPolicy(overrides)))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    expect(await refusal(create(tenantPolicy({ scopeKind: 'UNIT', scopeRefId: '00000000-0000-4000-8000-0000000fffff' })))).toMatchObject({ extensions: { reason: 'UNIT_NOT_FOUND' } });
  });

  it('keeps the scope it was given: a unit, a fund source and a project group', async () => {
    const key = await world.businessKeyOf(world.defaultFundVersionId);
    const unit = await create(tenantPolicy({ scopeKind: 'UNIT', scopeRefId: unitId(BQL1).toUpperCase() }));
    const fund = await create(tenantPolicy({ scopeKind: 'FUND_SOURCE', scopeValue: key }));
    const group = await create(tenantPolicy({ scopeKind: 'PROJECT_GROUP', scopeValue: 'QTQG' }));
    expect([unit.scopeRefId, unit.scopeValue]).toEqual([unitId(BQL1), null]);
    expect([fund.scopeRefId, fund.scopeValue]).toEqual([null, key]);
    expect([group.scopeRefId, group.scopeValue]).toEqual([null, 'QTQG']);
  });
});

describe('CapAvcPolicyStore.publish (publishAvcPolicy)', () => {
  it('is refused to the person who drafted the policy (AC-ST-CAP-005-2), and published by another with the version that was read', async () => {
    const draft = await create(tenantPolicy());
    expect(await refusal(publish(draft.id, draft.version, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(await refusal(publish(draft.id, draft.version + 5))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    expect((await find(draft.id))?.status).toBe('DRAFT');
    const done = await publish(draft.id, draft.version);
    expect(done.policy).toMatchObject({ status: 'PUBLISHED', approvedBy: memberId(APPROVER), version: 2 });
    expect(done.endedPolicyIds).toEqual([]);
  });

  it('judges the maker before the state, refuses a policy that is not a draft and a policy that does not exist', async () => {
    const policy = await published(tenantPolicy());
    expect(await refusal(publish(policy.id, policy.version, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    expect(await refusal(publish(policy.id, policy.version, PUBLISHER))).toMatchObject({ code: 'AVC_POLICY_STATE_INVALID', status: 409, extensions: { policy_status: 'PUBLISHED' } });
    expect(await refusal(publish('00000000-0000-4000-8000-0000000fffff', 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
  });

  it('ends the earlier revision of the code the day before the later one starts, and keeps both published', async () => {
    const code = 'REVISED-POLICY';
    const earlier = await published(tenantPolicy({ policyCode: code, effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' }));
    const later = await create(tenantPolicy({ policyCode: code, warnPct: '85', effectiveFrom: '2026-07-01', effectiveUntil: '2026-12-31' }));
    const done = await publish(later.id, later.version);
    expect(done.endedPolicyIds).toEqual([earlier.id]);
    expect((await find(earlier.id))?.effectiveUntil).toBe('2026-06-30');
    expect((await find(later.id))?.status).toBe('PUBLISHED');
    // The earlier one governs until the day the later one starts.
    expect((await governing({ controlObject: 'ALLOCATION_LINE' }, '2026-06-30'))?.policyId).toBe(earlier.id);
    expect((await governing({ controlObject: 'ALLOCATION_LINE' }, '2026-07-01'))?.policyId).toBe(later.id);
  });

  it('refuses a publication that overlaps another policy of the same scope, naming it (AVC_POLICY_OVERLAP)', async () => {
    const scope = { scopeKind: 'FUND_SOURCE' as const, scopeValue: await world.businessKeyOf(await world.fundSource('ODA')) };
    const first = await published(tenantPolicy({ ...scope, effectiveFrom: '2026-01-01', effectiveUntil: '2026-12-31' }));
    const other = await create(tenantPolicy({ ...scope, effectiveFrom: '2026-06-01' }));
    expect(await refusal(publish(other.id, other.version))).toMatchObject({ code: 'AVC_POLICY_OVERLAP', status: 409, extensions: { conflicting_policy_id: first.id, conflicting_policy_code: first.policyCode } });
    expect((await find(other.id))?.status).toBe('DRAFT');
    // A revision of the same code that starts before the one in force cannot take over from a later day either.
    const earlierStart = await create(tenantPolicy({ policyCode: first.policyCode, ...scope, effectiveFrom: '2025-06-01', effectiveUntil: '2026-03-31' }));
    expect(await refusal(publish(earlierStart.id, earlierStart.version))).toMatchObject({ code: 'AVC_POLICY_OVERLAP' });
    // After the period, or for another scope or object, nothing overlaps.
    const after = await create(tenantPolicy({ ...scope, effectiveFrom: '2027-01-01' }));
    expect((await publish(after.id, after.version)).policy.status).toBe('PUBLISHED');
    const otherObject = await create(tenantPolicy({ ...scope, controlObject: 'APPROPRIATION', effectiveFrom: '2026-06-01' }));
    expect((await publish(otherObject.id, otherObject.version)).policy.status).toBe('PUBLISHED');
  });
});

describe('the policy that governs a check', () => {
  it('is the most specific one in force on the day: a project group before a unit before a fund source before the tenant', async () => {
    const key = await world.businessKeyOf(await world.fundSource('VAYUUDAI'));
    const tenant = await published(tenantPolicy({ effectiveFrom: '2030-01-01', effectiveUntil: '2030-12-31' }));
    const fund = await published(tenantPolicy({ scopeKind: 'FUND_SOURCE', scopeValue: key, effectiveFrom: '2030-01-01', effectiveUntil: '2030-12-31' }));
    const unit = await published(tenantPolicy({ scopeKind: 'UNIT', scopeRefId: unitId(BQL1), effectiveFrom: '2030-01-01', effectiveUntil: '2030-12-31' }));
    const group = await published(tenantPolicy({ scopeKind: 'PROJECT_GROUP', scopeValue: 'A', effectiveFrom: '2030-01-01', effectiveUntil: '2030-12-31' }));
    const day = '2030-03-01';
    const all = { controlObject: 'ALLOCATION_LINE' as const, projectGroup: 'A', unitId: unitId(BQL1), fundSourceKey: key };
    expect((await governing(all, day))?.policyId).toBe(group.id);
    expect((await governing({ ...all, projectGroup: 'B' }, day))?.policyId).toBe(unit.id);
    expect((await governing({ ...all, projectGroup: 'B', unitId: unitId(ROOT) }, day))?.policyId).toBe(fund.id);
    expect((await governing({ ...all, projectGroup: 'B', unitId: unitId(ROOT), fundSourceKey: 'OTHER' }, day))?.policyId).toBe(tenant.id);
    expect((await governing({ ...all, projectGroup: null, unitId: null, fundSourceKey: null }, day))?.policyId).toBe(tenant.id);
    // Before any of them is in force there is none, and a line then falls back to the tenant default.
    expect(await governing(all, '2029-12-31')).toBeUndefined();
    expect(await world.as((tx) => policies.governingLine(tx, { projectGroup: 'A' }, '2029-12-31'))).toEqual({ policyId: null, warnPct: '90.00', blockPct: '100.00', includeReservations: true });
    // The thresholds are those of the policy, with its reservations setting.
    expect(await governing({ controlObject: 'ALLOCATION_LINE' }, day)).toEqual({ policyId: tenant.id, warnPct: '90.00', blockPct: '100.00', includeReservations: true });
    // A policy of the object APPROPRIATION never governs a line.
    expect(await governing({ controlObject: 'APPROPRIATION' }, day)).toBeUndefined();
  });

  it('does not reach back after the end of a policy', async () => {
    const policy = await published(tenantPolicy({ scopeKind: 'PROJECT_GROUP', scopeValue: 'C', effectiveFrom: '2031-01-01', effectiveUntil: '2031-06-30' }));
    expect((await governing({ controlObject: 'ALLOCATION_LINE', projectGroup: 'C' }, '2031-06-30'))?.policyId).toBe(policy.id);
    expect(await governing({ controlObject: 'ALLOCATION_LINE', projectGroup: 'C' }, '2031-07-01')).toBeUndefined();
  });
});

describe('the policies in the database (V1365)', () => {
  it('never deletes a policy, never changes what it says, moves DRAFT to PUBLISHED only and never extends the period', async () => {
    const draft = await create(tenantPolicy({ effectiveFrom: '2032-01-01', effectiveUntil: '2032-12-31' }));
    expect(await sqlState(world.as((tx) => tx.query('delete from machvon.avc_policy where id = $1::uuid', [draft.id])))).toBe('42501');
    expect(await sqlState(world.owner('delete from machvon.avc_policy where id = $1::uuid', [draft.id]))).toBe('23514');
    for (const change of ['warn_pct = 10', 'block_pct = 99', "legal_basis = 'changed basis'", "policy_code = 'RENAMED'", 'include_reservations = false', 'revision = 9', "effective_from = '2032-02-01'", "control_object = 'APPROPRIATION'"]) {
      expect(await sqlState(world.owner(`update machvon.avc_policy set ${change} where id = $1::uuid`, [draft.id]))).toBe('23514');
    }
    expect(await sqlState(world.owner("update machvon.avc_policy set status = 'RETIRED' where id = $1::uuid", [draft.id]))).toBe('23514');
    expect(await sqlState(world.owner("update machvon.avc_policy set effective_until = '2032-06-30' where id = $1::uuid", [draft.id]))).toBe('23514');
    const policy = (await publish(draft.id, draft.version)).policy;
    expect(await sqlState(world.owner("update machvon.avc_policy set status = 'DRAFT' where id = $1::uuid", [policy.id]))).toBe('23514');
    expect(await sqlState(world.owner("update machvon.avc_policy set approved_by = created_by, status = 'PUBLISHED' where id = $1::uuid", [policy.id]))).toBe('23514');
    expect(await sqlState(world.owner("update machvon.avc_policy set effective_until = '2033-06-30' where id = $1::uuid", [policy.id]))).toBe('23514');
    expect(await sqlState(world.owner('update machvon.avc_policy set effective_until = null where id = $1::uuid', [policy.id]))).toBe('23514');
    await world.owner("update machvon.avc_policy set effective_until = '2032-06-30' where id = $1::uuid", [policy.id]);
    expect((await find(policy.id))?.effectiveUntil).toBe('2032-06-30');
  });

  it('holds the shape of the scope, the thresholds and the approver by itself, whatever the application checked', async () => {
    const insert = (overrides: Record<string, unknown>) => {
      const values = { code: `RAW-${(counter += 1)}`, kind: 'TENANT', ref: null, value: null, warn: 90, block: 100, from: '2026-01-01', until: null, status: 'DRAFT', approver: null, basis: 'A legal basis', ...overrides };
      return world.owner(
        `insert into machvon.avc_policy (tenant_id, id, policy_code, scope_kind, scope_ref_id, scope_value, control_object, warn_pct, block_pct, legal_basis, effective_from, effective_until, revision, status, approved_by, created_by, updated_by)
         values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1, $2, $3::uuid, $4, 'ALLOCATION_LINE', $5, $6, $7, $8::date, $9::date, 1, $10, $11::uuid, $12::uuid, $12::uuid)`,
        [values.code, values.kind, values.ref, values.value, values.warn, values.block, values.basis, values.from, values.until, values.status, values.approver, memberId(MAKER)],
      );
    };
    expect(await sqlState(insert({ block: 101 }))).toBe('23514');
    expect(await sqlState(insert({ warn: 95, block: 90 }))).toBe('23514');
    expect(await sqlState(insert({ kind: 'UNIT' }))).toBe('23514');
    expect(await sqlState(insert({ kind: 'PROJECT_GROUP', value: 'Z' }))).toBe('23514');
    expect(await sqlState(insert({ until: '2025-01-01' }))).toBe('23514');
    expect(await sqlState(insert({ basis: ' padded ' }))).toBe('23514');
    expect(await sqlState(insert({ status: 'PUBLISHED' }))).toBe('23514');
    expect(await sqlState(insert({ status: 'PUBLISHED', approver: memberId(MAKER) }))).toBe('23514');
    expect(await sqlState(insert({ code: 'bad code' }))).toBe('23514');
  });

  it('refuses at the database two published policies of one scope that overlap, even when the application was skipped', async () => {
    const first = await published(tenantPolicy({ scopeKind: 'PROJECT_GROUP', scopeValue: 'B', effectiveFrom: '2034-01-01' }));
    const second = await create(tenantPolicy({ scopeKind: 'PROJECT_GROUP', scopeValue: 'B', effectiveFrom: '2034-03-01' }));
    expect(await sqlState(world.owner("update machvon.avc_policy set status = 'PUBLISHED', approved_by = $2::uuid where id = $1::uuid", [second.id, memberId(APPROVER)]))).toBe('23P01');
    expect((await find(first.id))?.status).toBe('PUBLISHED');
  });
});

describe('CapAvcPolicyStore.list and preview (CAP-17)', () => {
  it('lists the policies newest first with a filter by state and object, in pages', async () => {
    const draft = await create(tenantPolicy({ policyCode: 'LIST-DRAFT', controlObject: 'APPROPRIATION' }));
    const all = await world.as((tx) => policies.list(tx, {}, { limit: 500 }));
    expect(all.length).toBeGreaterThan(5);
    expect(all[0]?.id).toBe(draft.id);
    const drafts = await world.as((tx) => policies.list(tx, { status: 'DRAFT', controlObject: 'APPROPRIATION' }, { limit: 500 }));
    expect(drafts.every((row) => row.status === 'DRAFT' && row.controlObject === 'APPROPRIATION')).toBe(true);
    const page = await world.as((tx) => policies.list(tx, {}, { limit: 2 }));
    const next = await world.as((tx) => policies.list(tx, {}, { limit: 2, after: { code: page[1]?.createdAtKey ?? '', id: page[1]?.id ?? '' } }));
    expect(next.map((row) => row.id)).not.toContain(page[0]?.id);
    expect(next.map((row) => row.id)).not.toContain(page[1]?.id);
    expect(await refusal(world.as((tx) => policies.list(tx, {}, { limit: 2, after: { code: 'junk', id: page[0]?.id ?? '' } })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cursor' });
    expect(await refusal(world.as((tx) => policies.list(tx, {}, { limit: 2, after: { code: page[1]?.createdAtKey ?? '', id: 'not-an-id' } })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cursor' });
  });

  it('counts the lines in force that the policy would put in WARN and in BLOCK (AC-ST-CAP-005-3), and the appropriations for an appropriation policy', async () => {
    const unitNumber = BQL1;
    const key = await world.businessKeyOf(await world.fundSource('PREVIEW'));
    const fundVersion = (await world.owner<{ id: string }>("select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where r.business_key = $1", [key]))[0]?.id;
    const ok = await world.publishedLine({ allocated: '1000', fundVersionId: fundVersion, group: 'A', unitNumber });
    const warn = await world.publishedLine({ allocated: '1000', fundVersionId: fundVersion, group: 'A', unitNumber });
    const block = await world.publishedLine({ allocated: '1000', fundVersionId: fundVersion, group: 'A', unitNumber });
    const zero = await world.publishedLine({ allocated: '1000', fundVersionId: fundVersion, group: 'A', unitNumber });
    const outside = await world.publishedLine({ allocated: '1000', group: 'B' });
    await world.setFigures(ok.balanceId, { committed: '100' });
    await world.setFigures(warn.balanceId, { committed: '800', reserved: '150' });
    await world.setFigures(block.balanceId, { committed: '600', disbursed: '400' });
    await world.owner('update machvon.allocation_balance set allocated_vnd = 0, committed_vnd = 0, disbursed_vnd = 0 where id = $1::uuid', [zero.balanceId]);
    await world.setFigures(outside.balanceId, { committed: '999' });
    const draft = await create(tenantPolicy({ scopeKind: 'FUND_SOURCE', scopeValue: key, warnPct: '90', blockPct: '99' }));
    const preview = await world.as((tx) => policies.preview(tx, draft));
    expect(preview).toMatchObject({ policyId: draft.id, controlObject: 'ALLOCATION_LINE', total: 4, ok: 1, warn: 1, block: 2 });
    // Without a reservation in the count, the line that waits on reservations is OK.
    const apart = await create(tenantPolicy({ scopeKind: 'FUND_SOURCE', scopeValue: key, warnPct: '90', blockPct: '99', includeReservations: false }));
    expect(await world.as((tx) => policies.preview(tx, apart))).toMatchObject({ total: 4, ok: 2, warn: 0, block: 2 });
    // A project group policy counts the lines of that group; a tenant policy all of them.
    const group = await create(tenantPolicy({ scopeKind: 'PROJECT_GROUP', scopeValue: 'B' }));
    expect((await world.as((tx) => policies.preview(tx, group))).total).toBeGreaterThanOrEqual(1);
    const unit = await create(tenantPolicy({ scopeKind: 'UNIT', scopeRefId: unitId(ROOT) }));
    expect((await world.as((tx) => policies.preview(tx, unit))).total).toBe(0);
    const tenant = await create(tenantPolicy());
    expect((await world.as((tx) => policies.preview(tx, tenant))).total).toBeGreaterThanOrEqual(5);
    // An appropriation policy counts appropriations: 4 lines of 1000 are well below 10 billion.
    const appropriations = await create(tenantPolicy({ controlObject: 'APPROPRIATION', scopeKind: 'FUND_SOURCE', scopeValue: key }));
    expect(await world.as((tx) => policies.preview(tx, appropriations))).toMatchObject({ controlObject: 'APPROPRIATION', total: 4, ok: 4, warn: 0, block: 0 });
    const tenantAppropriation = await create(tenantPolicy({ controlObject: 'APPROPRIATION' }));
    expect((await world.as((tx) => policies.preview(tx, tenantAppropriation))).total).toBeGreaterThanOrEqual(5);
    const groupAppropriation = await create(tenantPolicy({ controlObject: 'APPROPRIATION', scopeKind: 'PROJECT_GROUP', scopeValue: 'A' }));
    expect(await world.as((tx) => policies.preview(tx, groupAppropriation))).toMatchObject({ total: 0, ok: 0, warn: 0, block: 0 });
    expect(money(1)).toBe('1000000000');
  });
});
