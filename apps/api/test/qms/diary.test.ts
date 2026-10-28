import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { diaryHashOf, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { qmsModule } from '../../src/modules/qms';
import { DiaryController, DiaryReadsController } from '../../src/modules/qms/diary.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const DRAFTER = 21; // staff who may write a diary and correct it
const SUPERVISOR = 22; // signs as the supervisor and locks
const SUPERVISOR_TWO = 23; // another supervisor
const OWNER = 24; // signs as the owner
const READER = 25; // site_diary.read
const NOBODY = 26;
const ELSEWHERE = 27; // the rights of DRAFTER over another branch
const OTHER_BRANCH = 5;
const MEMBERS = [DRAFTER, SUPERVISOR, SUPERVISOR_TWO, OWNER, READER, NOBODY, ELSEWHERE];
const FIRST_GUEST = 40;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const CONTENT = { summary: 'Concrete poured on the second floor', weather_code: 'SUNNY', workforce_count: 12, equipment: ['crane', 'mixer'] };

describe('the electronic site diary over HTTP (ST-QMS-001)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let grants = 60;
  let guests = FIRST_GUEST;
  let contractor = '';
  let operations = 0;

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const operation = (): string => `00000000-0000-4000-8000-${String((operations += 1)).padStart(12, '0')}`;

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [aggregateId, type]);
  const stored = async (diaryId: string) =>
    (
      await rows<{ status: string; version: string; content_hash: string | null; supervisor_remark: string | null; owner_note: string | null; correction_of_id: string | null; diary_no: string }>(
        'select status, version::text, content_hash, supervisor_remark, owner_note, correction_of_id, diary_no from machvon.site_diary where id = $1',
        [diaryId],
      )
    )[0];
  const signatures = (diaryId: string) =>
    rows<{ signer_role: string; method: string; legal_effect: string; cert_serial: string | null; signed_content_hash: string; membership_id: string }>(
      "select signer_role, method, legal_effect, cert_serial, signed_content_hash, membership_id from machvon.qms_signature where subject_kind = 'SITE_DIARY' and subject_id = $1 order by signed_at, created_at",
      [diaryId],
    );

  interface Contract {
    id: string;
    code: string;
    projectId: string;
  }

  async function contract(status = 'ACTIVE', codeOf?: (n: number) => string): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const code = codeOf === undefined ? `HD-D-${String(counter).padStart(4, '0')}` : codeOf(counter);
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'OTHER', false, true, 1000000, $8, $8, date '2026-01-01', date '2026-01-02', null, null)`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, code, status, memberId(DRAFTER)],
      ],
    ]);
    return { id: contractId, code, projectId: line.projectId };
  }

  /** A guest of the contractor, invited to one contract: the member number. */
  async function guestOf(target: Contract): Promise<number> {
    guests += 1;
    grants += 1;
    await harness.seedMembership(TENANT_A, guests, ROOT);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guests), contractor]);
    await harness.seedGrants(TENANT_A, [{ n: grants, member: guests, role: 104, kind: 'CONTRACT', refs: [target.id] }]);
    return guests;
  }

  const save = (member: number, target: Contract, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/site-diaries', { member, ...(key === undefined ? {} : { key }), body: { contract_id: target.id, record_date: '2026-10-20', client_operation_id: operation(), content: CONTENT, ...overrides } });
  const revise = (member: number, diaryId: string, version: number | string, content: Record<string, unknown> = { ...CONTENT, summary: 'Revised' }, operationId?: string, key?: string) =>
    call('POST', `/site-diaries/${diaryId}/draft`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { content, client_operation_id: operationId ?? operation() } });
  const contractorSign = (member: number, diaryId: string, version: number | string, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/site-diaries/${diaryId}/contractor-sign`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { signature_method: 'IN_APP_OTP', client_operation_id: operation(), ...overrides } });
  const remark = (member: number, diaryId: string, version: number | string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/site-diaries/${diaryId}/supervisor-remark`, { member, ifMatch: `"${version}"`, body: { remark: 'Checked on site, the work matches the plan.', signature_method: 'IN_APP_OTP', client_operation_id: operation(), ...overrides } });
  const confirm = (member: number, diaryId: string, version: number | string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/site-diaries/${diaryId}/owner-confirm`, { member, ifMatch: `"${version}"`, body: { note: 'Seen and confirmed.', signature_method: 'IN_APP_OTP', client_operation_id: operation(), ...overrides } });
  const lock = (member: number, diaryId: string, version: number | string, reason?: string) => call('POST', `/site-diaries/${diaryId}/lock`, { member, ifMatch: `"${version}"`, body: reason === undefined ? {} : { reason } });
  const correct = (member: number, diaryId: string, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/site-diaries/${diaryId}/corrections`, { member, ...(key === undefined ? {} : { key }), body: { content: { ...CONTENT, summary: 'Corrected' }, correction_reason: 'The quantity of concrete was written wrong.', client_operation_id: operation(), ...overrides } });
  const list = (member: number, query = '') => call('GET', `/resources/site_diary${query}`, { member });
  const read = (member: number, diaryId: string) => call('GET', `/resources/site_diary/${diaryId}`, { member });

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'QMS_DRAFTER', ['diary.write', 'diary.correct', 'site_diary.read'], 40],
      [2, 'QMS_SUPERVISOR', ['diary.sign.supervisor', 'diary.lock', 'site_diary.read'], 40],
      [3, 'QMS_OWNER', ['diary.sign.owner', 'site_diary.read'], 40],
      [4, 'QMS_GUEST', ['diary.write', 'diary.sign.contractor', 'diary.correct', 'site_diary.read'], 5],
      [5, 'QMS_READER', ['site_diary.read'], 10],
      [6, 'QMS_STAFF_CONTRACTOR', ['diary.sign.contractor', 'site_diary.read'], 40],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE'; refs?: string[] } = {}) => ({ n, member, role: 100 + role, kind: extra.kind ?? 'TENANT', ...(extra.refs === undefined ? {} : { refs: extra.refs }) });
    await harness.seedGrants(TENANT_A, [grant(1, DRAFTER, 1), grant(2, SUPERVISOR, 2), grant(3, SUPERVISOR_TWO, 2), grant(4, OWNER, 3), grant(5, READER, 5), grant(6, ELSEWHERE, 1, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] })]);
    // The staff member that holds the right to sign for the contractor: the right is not enough, because a member of the staff is not the contractor.
    await harness.seedMembership(TENANT_A, 19, ROOT);
    await harness.seedGrants(TENANT_A, [grant(7, 19, 6)]);
    contractor = await seedContractor(harness);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DiaryController, DiaryReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  beforeEach(async () => {
    await world.owner('delete from machvon.permit_gate_rule');
  });

  it('is registered in the module of QMS', () => {
    expect(qmsModule.controllers).toEqual(expect.arrayContaining([DiaryController, DiaryReadsController]));
  });

  it('AC-ST-QMS-001-1, UAT-AC356: goes from the draft through the three signatures to the lock, blocks every edit after a signature, and replaces a locked diary only by a correction with a reason', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const sameOperation = { client_operation_id: '00000000-0000-4000-8000-0000000000b1' };
    const made = await save(guest, target, sameOperation, 'draft-once-for-this-key');
    expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    expect(await save(guest, target, sameOperation, 'draft-once-for-this-key')).toEqual(made);
    const id = made.json.resource_id as string;
    expect(await stored(id)).toMatchObject({ status: 'DRAFT', content_hash: null, diary_no: `NK-${target.code}-20261020` });
    expect((await audits(id, 'site_diary.drafted'))[0]).toMatchObject({ actor_id: memberId(guest), safe_diff: { to_status: 'DRAFT', record_date: '2026-10-20', contract_id: target.id } });
    expect((await events(id, 'qms.site_diary.drafted.v1'))[0]?.payload).toMatchObject({ site_diary_id: id, contract_id: target.id, status: 'DRAFT' });
    expect(JSON.stringify((await events(id, 'qms.site_diary.drafted.v1'))[0]?.payload)).not.toContain('Concrete poured');

    // The draft is edited at the version it was read at.
    const revised = await revise(guest, id, 1, { ...CONTENT, summary: 'Concrete poured and cured on the second floor' });
    expect(revised).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2 } });
    expect(await revise(guest, id, 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });

    // The contractor signs: the hash of what the diary says is kept with the signature, and nothing is edited any more.
    const signed = await contractorSign(guest, id, 2);
    expect(signed).toMatchObject({ status: 200, json: { status: 'CONTRACTOR_SIGNED', resource_version: 3 } });
    const hash = diaryHashOf({ contractId: target.id, recordDate: '2026-10-20', correctionOfId: null, content: { ...CONTENT, summary: 'Concrete poured and cured on the second floor' } });
    expect((await stored(id))?.content_hash).toBe(hash);
    expect(await signatures(id)).toEqual([expect.objectContaining({ signer_role: 'CONTRACTOR', method: 'IN_APP_OTP', legal_effect: 'INTERNAL_RECORD', cert_serial: null, signed_content_hash: hash, membership_id: memberId(guest) })]);
    expect(await revise(guest, id, 3)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    expect(await save(guest, target, {}, undefined)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    await expect(world.owner('update machvon.site_diary set content = \'{"summary": "sneaky"}\'::jsonb where id = $1', [id])).rejects.toThrow(/DIARY_STATE_INVALID/);
    expect(await contractorSign(guest, id, 3)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });

    // The supervisor remarks and signs; the owner confirms; the diary is locked.
    expect(await lock(SUPERVISOR, id, 3)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    const supervised = await remark(SUPERVISOR, id, 3);
    expect(supervised).toMatchObject({ status: 200, json: { status: 'SUPERVISED', resource_version: 4 } });
    expect(await stored(id)).toMatchObject({ supervisor_remark: 'Checked on site, the work matches the plan.', content_hash: hash });
    const owned = await confirm(OWNER, id, 4);
    expect(owned).toMatchObject({ status: 200, json: { status: 'OWNER_CONFIRMED', resource_version: 5 } });
    expect((await stored(id))?.owner_note).toBe('Seen and confirmed.');
    expect((await signatures(id)).map((row) => [row.signer_role, row.signed_content_hash])).toEqual([
      ['CONTRACTOR', hash],
      ['SUPERVISOR', hash],
      ['OWNER', hash],
    ]);
    // The note of the owner and the reason of the lock are kept as they are, whoever writes them (Codex review of ST-QMS-001).
    await expect(world.owner("update machvon.site_diary set owner_note = 'changed' where id = $1", [id])).rejects.toThrow(/note of the owner/);
    await expect(world.owner('update machvon.site_diary set owner_note = null where id = $1', [id])).rejects.toThrow(/note of the owner/);
    const locked = await lock(SUPERVISOR, id, 5, 'The period of the diary has passed.');
    expect(locked).toMatchObject({ status: 200, json: { status: 'LOCKED', resource_version: 6 } });
    expect(await stored(id)).toMatchObject({ status: 'LOCKED' });
    await expect(world.owner("update machvon.site_diary set lock_reason = 'changed' where id = $1", [id])).rejects.toThrow(/lock of a diary/);
    await expect(world.owner("update machvon.site_diary set owner_note = 'late' where id = $1", [id])).rejects.toThrow(/note of the owner/);
    expect((await audits(id, 'site_diary.locked'))[0]).toMatchObject({ reason: 'The period of the diary has passed.', actor_id: memberId(SUPERVISOR) });
    for (const type of ['contractor_signed', 'supervised', 'owner_confirmed', 'locked']) expect(await events(id, `qms.site_diary.${type}.v1`)).toHaveLength(1);
    // A locked diary is not edited, signed again or locked again, and the database says the same.
    expect(await revise(guest, id, 6)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    expect(await lock(SUPERVISOR, id, 6)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });

    // The correction is a new revision with its reason; the diary it corrects is kept as it is until the correction is locked.
    expect(await correct(guest, id, { correction_reason: '' })).toMatchObject({ status: 422 });
    const sameCorrection = { client_operation_id: '00000000-0000-4000-8000-0000000000b2' };
    const corrected = await correct(guest, id, sameCorrection, 'correct-once-for-this-key');
    expect(corrected).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    expect(await correct(guest, id, sameCorrection, 'correct-once-for-this-key')).toEqual(corrected);
    const revisionId = corrected.json.resource_id as string;
    expect(await stored(revisionId)).toMatchObject({ status: 'DRAFT', correction_of_id: id, diary_no: `NK-${target.code}-20261020-R1` });
    expect((await stored(id))?.status).toBe('LOCKED');
    expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid', [target.id])).toHaveLength(2);
    expect((await audits(revisionId, 'site_diary.corrected'))[0]).toMatchObject({ reason: 'The quantity of concrete was written wrong.', safe_diff: { correction_of_id: id } });
    // One correction is open at a time, and a draft is not corrected.
    expect(await correct(guest, id)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    expect(await correct(guest, revisionId)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    // The correction is signed again by every role, over its own hash, and when it is locked it replaces the diary.
    const again = await contractorSign(guest, revisionId, 1);
    expect(again.status).toBe(200);
    const revisionHash = (await stored(revisionId))?.content_hash;
    expect(revisionHash).not.toBe(hash);
    await remark(SUPERVISOR, revisionId, again.json.resource_version as number);
    expect((await lock(SUPERVISOR, revisionId, 3)).status).toBe(200);
    expect((await stored(id))?.status).toBe('SUPERSEDED');
    // The day of a diary that was replaced is not a day with no diary: saving it is refused with the state of the diary, not with a server error (Codex review of ST-QMS-001).
    expect(await save(guest, target, {}, undefined)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    expect(await save(guest, target, { base_server_version: 1 }, undefined)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    expect(await revise(guest, id, 7)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    expect(await correct(guest, id)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    // The correction can be corrected in its turn, and its number follows.
    const second = await correct(guest, revisionId);
    expect(second.status).toBe(200);
    expect((await stored(second.json.resource_id as string))?.diary_no).toBe(`NK-${target.code}-20261020-R2`);
  });

  it('AC-ST-QMS-001-2, UAT-AC357: keeps the method of a signature, takes a certificate only with its serial, and says on every diary that the legal value of an in-app signature is not settled (CXN-EXE-05)', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const id = (await save(guest, target)).json.resource_id as string;
    // A certificate needs its serial, and only a certificate carries one.
    expect(await contractorSign(guest, id, 1, { signature_method: 'DIGITAL_CERT' })).toMatchObject({ status: 422, json: { code: 'SIGNATURE_METHOD_NOT_ACCEPTED' } });
    expect(await contractorSign(guest, id, 1, { signature_method: 'IN_APP_WEBAUTHN', cert_serial: 'SN-1' })).toMatchObject({ status: 422, json: { code: 'SIGNATURE_METHOD_NOT_ACCEPTED' } });
    expect(await contractorSign(guest, id, 1, { signature_method: 'MAGIC' })).toMatchObject({ status: 422 });
    expect(await signatures(id)).toEqual([]);

    // An in-app confirmation is an internal record; the diary says that its legal value waits for the business.
    const first = await contractorSign(guest, id, 1);
    expect(first.status).toBe(200);
    const shown = (await read(READER, id)).json;
    expect(shown.signature_value).toEqual({ cxn: 'CXN-EXE-05', awaiting_confirmation: true });
    expect(shown.signatures).toEqual([expect.objectContaining({ role: 'CONTRACTOR', method: 'IN_APP_OTP', legal_effect: 'INTERNAL_RECORD', cert_serial: null, valid: true })]);
    expect((await audits(id, 'site_diary.contractor_signed'))[0]?.safe_diff).toMatchObject({ signature_method: 'IN_APP_OTP', legal_effect: 'INTERNAL_RECORD', signer_role: 'CONTRACTOR' });

    // A certificate is a legal electronic signature, with its serial.
    const second = await remark(SUPERVISOR, id, 2, { signature_method: 'DIGITAL_CERT', cert_serial: 'SN-0099' });
    expect(second.status).toBe(200);
    expect((await signatures(id))[1]).toMatchObject({ signer_role: 'SUPERVISOR', method: 'DIGITAL_CERT', legal_effect: 'LEGAL_E_SIGNATURE', cert_serial: 'SN-0099' });
    const owner = await confirm(OWNER, id, 3, { signature_method: 'IN_APP_WEBAUTHN', note: undefined });
    expect(owner.status).toBe(200);
    expect((await signatures(id))[2]).toMatchObject({ signer_role: 'OWNER', method: 'IN_APP_WEBAUTHN', legal_effect: 'INTERNAL_RECORD' });
    expect((await stored(id))?.owner_note).toBeNull();
  });

  it('AC-ST-QMS-001-3, UAT-AC365: refuses a guest on a foreign contract (404), a signature for another role (403) and a right that is not the side of the signer', async () => {
    const own = await contract();
    const foreign = await contract();
    const guest = await guestOf(own);
    expect(await save(guest, foreign)).toMatchObject({ status: 404 });
    expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid', [foreign.id])).toHaveLength(0);
    const id = (await save(guest, own)).json.resource_id as string;
    const foreignDiary = (await save(DRAFTER, foreign, { record_date: '2026-10-19' })).json.resource_id as string;
    expect(await read(guest, foreignDiary)).toMatchObject({ status: 404 });
    expect(await revise(guest, foreignDiary, 1)).toMatchObject({ status: 404 });
    expect(await contractorSign(guest, foreignDiary, 1)).toMatchObject({ status: 404 });
    expect((await list(guest, `?contract_id=${foreign.id}`)).json.items).toEqual([]);

    // The guest of the contractor does not sign for the supervisor, the owner, or lock the diary.
    expect(await contractorSign(guest, id, 1)).toMatchObject({ status: 200 });
    expect(await remark(guest, id, 2)).toMatchObject({ status: 403 });
    expect(await confirm(guest, id, 2)).toMatchObject({ status: 403 });
    expect(await lock(guest, id, 2)).toMatchObject({ status: 403 });
    // A member of the staff who holds the right to sign for the contractor is not the contractor: nobody signs for the other side.
    const draftId = (await save(DRAFTER, own, { record_date: '2026-10-18' })).json.resource_id as string;
    expect(await contractorSign(19, draftId, 1)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await contractorSign(DRAFTER, draftId, 1)).toMatchObject({ status: 403 });
    // The staff do not sign as the contractor and the contractor does not sign as the staff: the supervisor cannot confirm for the owner either.
    const supervised = await remark(SUPERVISOR, id, 2);
    expect(supervised.status).toBe(200);
    expect(await confirm(SUPERVISOR, id, 3)).toMatchObject({ status: 403 });
    expect(await remark(SUPERVISOR_TWO, id, 3)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
    expect(await signatures(id)).toHaveLength(2);
    // Who holds no right, or holds it over another branch, is refused or sees nothing.
    expect(await save(READER, own)).toMatchObject({ status: 403 });
    expect(await save(NOBODY, own)).toMatchObject({ status: 403 });
    expect(await save(ELSEWHERE, own, { record_date: '2026-10-17' })).toMatchObject({ status: 404 });
    expect(await read(NOBODY, id)).toMatchObject({ status: 403 });
  });

  it('AC-ST-QMS-001-4, UAT-AC366: refuses the second of two supervisors who write with the same If-Match, and tells them to reload; nothing is overwritten', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const id = (await save(guest, target)).json.resource_id as string;
    const signed = await contractorSign(guest, id, 1);
    const version = signed.json.resource_version as number;
    const both = await Promise.all([remark(SUPERVISOR, id, version, { remark: 'First supervisor: the work matches the plan.' }), remark(SUPERVISOR_TWO, id, version, { remark: 'Second supervisor: the work does not match.' })]);
    const statuses = both.map((reply) => reply.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = both.find((reply) => reply.status === 409) as Reply;
    expect(['VERSION_CONFLICT', 'DIARY_STATE_INVALID']).toContain(refused.json.code);
    const winner = both.find((reply) => reply.status === 200) as Reply;
    expect(winner.json).toMatchObject({ status: 'SUPERVISED', resource_version: version + 1 });
    expect(await signatures(id)).toHaveLength(2);
    // Sequentially, the late one with the old version is told which version to reload.
    const late = await remark(SUPERVISOR_TWO, id, version);
    expect(late).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(JSON.stringify(late.json)).toContain(String(version + 1));
    // The remark that stands is the one of the winner, whole.
    expect((await stored(id))?.supervisor_remark).toMatch(/^(First|Second) supervisor: /);
  });

  it('keeps one main diary for a contract and a day: another is refused unless it was read at its version, a stale device is told of the conflict, and a client operation seen before answers what it did', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const first = await save(guest, target, { client_operation_id: '00000000-0000-4000-8000-0000000000aa' });
    expect(first.status).toBe(200);
    const id = first.json.resource_id as string;
    // A second diary for the day without having read the first.
    expect(await save(guest, target)).toMatchObject({ status: 409, json: { code: 'DIARY_DAY_EXISTS' } });
    // Read at another version: nothing is overwritten.
    expect(await save(guest, target, { base_server_version: 5 })).toMatchObject({ status: 409, json: { code: 'DIARY_SYNC_CONFLICT' } });
    expect((await stored(id))?.version).toBe('1');
    // Read at its version: the draft is updated.
    const updated = await save(guest, target, { base_server_version: 1, content: { ...CONTENT, summary: 'Updated from the device' } });
    expect(updated).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 2 } });
    expect((await audits(id, 'site_diary.revised')).length).toBe(1);
    // The device that did not hear the answer to the update asks again with another key: it is told what the update did, and nothing is written twice (Codex review of ST-QMS-001).
    const op = '00000000-0000-4000-8000-0000000000ab';
    const second = await save(guest, target, { base_server_version: 2, client_operation_id: op, content: { ...CONTENT, summary: 'Updated twice' } }, '00000000-0000-4000-8000-0000000000e1');
    expect(second).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 3 } });
    expect(await save(guest, target, { base_server_version: 2, client_operation_id: op, content: { ...CONTENT, summary: 'Updated twice' } }, '00000000-0000-4000-8000-0000000000e2')).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 3 } });
    expect((await stored(id))?.version).toBe('3');
    expect((await audits(id, 'site_diary.revised')).length).toBe(2);
    // The same operation for another contract is a mistake, as it is for the operation that made the diary.
    const elsewhere = await contract();
    expect(await save(await guestOf(elsewhere), elsewhere, { client_operation_id: op })).toMatchObject({ status: 422 });
    // The device that did not hear the answer asks again with another key: the diary it made is what it is told.
    const again = await save(guest, target, { client_operation_id: '00000000-0000-4000-8000-0000000000aa' });
    expect(again).toMatchObject({ status: 200, json: { resource_id: id, status: 'DRAFT', resource_version: 1 } });
    expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid and conflict_of_id is null', [target.id])).toHaveLength(1);
    expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid and conflict_of_id = $2::uuid', [target.id, id])).toHaveLength(1);
    // The same operation on another contract is a mistake.
    const other = await contract();
    const guestTwo = await guestOf(other);
    expect(await save(guestTwo, other, { client_operation_id: '00000000-0000-4000-8000-0000000000aa' })).toMatchObject({ status: 422 });
    // Another day is another diary.
    expect((await save(guest, target, { record_date: '2026-10-21' })).status).toBe(200);
  });

  it('refuses a diary of a day that has not come, of a contract that is not being performed, and content that is not a diary', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    expect(await save(guest, target, { record_date: '2999-01-01' })).toMatchObject({ status: 422, json: { detail: 'record_date' } });
    expect(await save(guest, target, { record_date: '2026-02-30' })).toMatchObject({ status: 422 });
    for (const content of [{}, { weather_code: 'sunny day!' }, { workforce_count: -1 }, { workforce_count: 1.5 }, { workforce_count: '12' }, { note: 'x'.repeat(70_000) }]) {
      expect([JSON.stringify(content).slice(0, 40), (await save(guest, target, { content })).status]).toEqual([JSON.stringify(content).slice(0, 40), 422]);
    }
    expect((await save(guest, target, { content: 'text' })).status).toBe(400);
    const suspended = await contract('DRAFT');
    expect(await save(DRAFTER, suspended)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    await world.owner('delete from machvon.permit_gate_rule');
    expect(await rows('select 1 from machvon.site_diary where contract_id = any($1::uuid[])', [[target.id, suspended.id]])).toHaveLength(0);
  });

  describe('ST-QMS-002: two devices, the conflict between them, and the place', () => {
    const copiesOf = (diaryId: string) =>
      rows<{ id: string; diary_no: string; conflict_state: string; content: Record<string, unknown>; device_id: string | null; conflict_resolution: string | null; conflict_note: string | null; conflict_discarded: Record<string, unknown> | null; status: string }>(
        'select id, diary_no, conflict_state, content, device_id, conflict_resolution, conflict_note, conflict_discarded, status from machvon.site_diary where conflict_of_id = $1::uuid order by created_at, id',
        [diaryId],
      );
    const resolve = (member: number, diaryId: string, version: number | string, body: Record<string, unknown>, key?: string) => call('POST', `/site-diaries/${diaryId}/resolve-conflict`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body });
    const mine = '00000000-0000-4000-8000-0000000000d1';
    const theirs = '00000000-0000-4000-8000-0000000000d2';

    /** The diary of a day that device one wrote and device two had not read: the diary stands at version 2, and device two left a copy of its own. */
    async function conflicted(day: string) {
      const target = await contract();
      const guest = await guestOf(target);
      const first = await save(guest, target, { record_date: day, device_id: mine, content: { ...CONTENT, summary: 'Written on the first device' } });
      const id = first.json.resource_id as string;
      expect(await save(guest, target, { record_date: day, device_id: mine, base_server_version: 1, content: { ...CONTENT, summary: 'Written on the first device, then edited' } })).toMatchObject({ status: 200, json: { resource_version: 2 } });
      const stale = await save(guest, target, { record_date: day, device_id: theirs, base_server_version: 1, content: { ...CONTENT, summary: 'Written on the second device' } });
      return { target, guest, id, stale };
    }

    it('AC-ST-QMS-002-1: UAT-AC62 keeps the copy of a device that wrote over a draft it had not read, shows it, and does not touch the diary of the day', async () => {
      const { target, guest, id, stale } = await conflicted('2026-10-20');
      expect(stale).toMatchObject({ status: 409, json: { code: 'DIARY_SYNC_CONFLICT' } });
      const [copy] = await copiesOf(id);
      expect(stale.json).toMatchObject({ diary_id: id, conflict_diary_id: copy?.id, server_version: 2 });
      expect(copy).toMatchObject({ conflict_state: 'CONFLICT_PENDING', status: 'DRAFT', device_id: theirs, content: { summary: 'Written on the second device' }, diary_no: `NK-${target.code}-20261020-C1` });
      // No duplicate: one diary of the day, still as the first device left it, and the list shows the day once.
      expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid and conflict_of_id is null', [target.id])).toHaveLength(1);
      expect((await rows<{ content: Record<string, unknown>; version: string }>('select content, version::text from machvon.site_diary where id = $1', [id]))[0]).toMatchObject({ content: { summary: 'Written on the first device, then edited' }, version: '2' });
      expect((await list(guest, `?contract_id=${target.id}`)).json.items).toHaveLength(1);
      // The conflict is shown on the diary, with what each device said, and the one who may write may settle it.
      const shown = (await read(guest, id)).json;
      expect(shown).toMatchObject({ conflict_state: 'NONE', conflict_of_id: null, actions: { resolveConflict: true } });
      expect(shown.conflicts).toEqual([expect.objectContaining({ id: copy?.id, state: 'CONFLICT_PENDING', device_id: theirs, resolution: null, content: expect.objectContaining({ summary: 'Written on the second device' }) })]);
      expect((await read(READER, id)).json).toMatchObject({ actions: { resolveConflict: false } });
      expect((await audits(copy?.id as string, 'site_diary.conflict_stored'))[0]?.safe_diff).toMatchObject({ conflict_of_id: id, server_version: 2 });
      expect(JSON.stringify((await audits(copy?.id as string, 'site_diary.conflict_stored'))[0]?.safe_diff)).not.toContain('second device');
      // The copy is not a diary to edit, sign or lock by itself.
      expect(await revise(guest, copy?.id as string, 1)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
      expect(await contractorSign(guest, copy?.id as string, 1)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
      expect(await lock(SUPERVISOR, copy?.id as string, 1)).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
      await expect(world.owner('update machvon.site_diary set content = \'{"summary": "sneaky"}\'::jsonb where id = $1', [copy?.id])).rejects.toThrow(/only settled/);
    });

    it('AC-ST-QMS-002-2: UAT-AC358 delivers the same operation twice and creates one revision, for the first save, for an update and for a copy that was kept', async () => {
      const target = await contract();
      const guest = await guestOf(target);
      const created = '00000000-0000-4000-8000-0000000000e1';
      const updated = '00000000-0000-4000-8000-0000000000e2';
      const stale = '00000000-0000-4000-8000-0000000000e3';
      const content = { ...CONTENT, summary: 'Offline' };
      const first = await save(guest, target, { record_date: '2026-10-21', client_operation_id: created, content }, '00000000-0000-4000-8000-0000000001a1');
      const id = first.json.resource_id as string;
      expect(await save(guest, target, { record_date: '2026-10-21', client_operation_id: created, content }, '00000000-0000-4000-8000-0000000001a2')).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 1 } });
      const one = { record_date: '2026-10-21', client_operation_id: updated, base_server_version: 1, content: { ...content, summary: 'Offline, edited' } };
      expect(await save(guest, target, one, '00000000-0000-4000-8000-0000000001a3')).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 2 } });
      expect(await save(guest, target, one, '00000000-0000-4000-8000-0000000001a4')).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 2 } });
      const two = { record_date: '2026-10-21', client_operation_id: stale, base_server_version: 1, content: { ...content, summary: 'Another device' } };
      const kept = await save(guest, target, two, '00000000-0000-4000-8000-0000000001a5');
      expect(kept).toMatchObject({ status: 409, json: { code: 'DIARY_SYNC_CONFLICT' } });
      expect(await save(guest, target, two, '00000000-0000-4000-8000-0000000001a6')).toMatchObject({ status: 409, json: { code: 'DIARY_SYNC_CONFLICT', conflict_diary_id: kept.json.conflict_diary_id } });
      expect((await stored(id))?.version).toBe('2');
      expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid', [target.id])).toHaveLength(2);
      expect(await copiesOf(id)).toHaveLength(1);
    });

    it('AC-ST-QMS-002-1: UAT-AC62 settles a conflict by keeping the diary, taking the copy or merging them, and keeps what was set aside', async () => {
      const { target, guest, id, stale } = await conflicted('2026-10-22');
      const [kept] = await copiesOf(id);
      // Keep the diary: the copy is set aside with the reason, and the diary is as it was.
      const keep = await resolve(guest, id, 2, { conflict_diary_id: kept?.id, resolution: 'KEEP_PRIMARY', note: 'The first device is the engineer on site.' });
      expect(keep).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 2 } });
      expect((await stored(id))?.version).toBe('2');
      expect((await copiesOf(id))[0]).toMatchObject({ conflict_state: 'RESOLVED', conflict_resolution: 'KEEP_PRIMARY', conflict_note: 'The first device is the engineer on site.', conflict_discarded: { summary: 'Written on the second device' } });
      expect((await rows<{ content: Record<string, unknown> }>('select content from machvon.site_diary where id = $1', [id]))[0]?.content).toMatchObject({ summary: 'Written on the first device, then edited' });
      expect((await audits(id, 'site_diary.conflict_resolved'))[0]?.safe_diff).toMatchObject({ resolution: 'KEEP_PRIMARY', conflict_diary_id: kept?.id });
      expect((await events(id, 'qms.site_diary.conflict_resolved.v1'))[0]?.payload).toMatchObject({ resolution: 'KEEP_PRIMARY', conflict_diary_id: kept?.id });
      expect(JSON.stringify((await events(id, 'qms.site_diary.conflict_resolved.v1'))[0]?.payload)).not.toContain('device');
      // A settled copy is not settled again, and nothing edits it.
      expect(await resolve(guest, id, 2, { conflict_diary_id: kept?.id, resolution: 'KEEP_PRIMARY', note: 'Again.' })).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
      await expect(world.owner("update machvon.site_diary set conflict_note = 'changed' where id = $1", [kept?.id])).rejects.toThrow(/settled conflict/);
      expect((await read(guest, id)).json).toMatchObject({ actions: { resolveConflict: false }, conflicts: [expect.objectContaining({ state: 'RESOLVED', resolution: 'KEEP_PRIMARY' })] });
      expect(stale.status).toBe(409);

      // Take the copy: the diary becomes what the device wrote, and what it said before is kept on the copy.
      const second = await save(guest, target, { record_date: '2026-10-22', device_id: theirs, base_server_version: 1, content: { ...CONTENT, summary: 'Second device, again', workforce_count: 30 } });
      expect(second.status).toBe(409);
      const copy = (await copiesOf(id))[1];
      expect(copy?.diary_no).toBe(`NK-${target.code}-20261022-C2`);
      const adopt = await resolve(guest, id, 2, { conflict_diary_id: copy?.id, resolution: 'ADOPT_CONFLICT', note: 'The second device has the head count.' });
      expect(adopt).toMatchObject({ status: 200, json: { resource_version: 3 } });
      expect((await rows<{ content: Record<string, unknown>; workforce_count: number }>('select content, workforce_count from machvon.site_diary where id = $1', [id]))[0]).toMatchObject({ content: { summary: 'Second device, again' }, workforce_count: 30 });
      expect((await copiesOf(id))[1]).toMatchObject({ conflict_state: 'RESOLVED', conflict_discarded: { summary: 'Written on the first device, then edited' } });

      // Merge: the diary becomes what the person wrote.
      expect((await save(guest, target, { record_date: '2026-10-22', device_id: theirs, base_server_version: 1, content: { ...CONTENT, summary: 'Third device' } })).status).toBe(409);
      const third = (await copiesOf(id))[2];
      const merge = await resolve(guest, id, 3, { conflict_diary_id: third?.id, resolution: 'MERGED', merged_content: { ...CONTENT, summary: 'Both said it; the pour was at noon' }, note: 'Both are right.' });
      expect(merge).toMatchObject({ status: 200, json: { resource_version: 4 } });
      expect((await rows<{ content: Record<string, unknown> }>('select content from machvon.site_diary where id = $1', [id]))[0]?.content).toMatchObject({ summary: 'Both said it; the pour was at noon' });
      expect((await copiesOf(id))[2]).toMatchObject({ conflict_resolution: 'MERGED', content: { summary: 'Third device' }, conflict_discarded: { summary: 'Second device, again' } });
    });

    it('refuses what does not settle a conflict: a resolution that is not one, merged content where there is no merge, a copy of another diary, a stale version, and a diary that was signed meanwhile', async () => {
      const { target, guest, id } = await conflicted('2026-10-23');
      const [copy] = await copiesOf(id);
      const other = await conflicted('2026-10-24');
      const [foreign] = await copiesOf(other.id);
      const note = 'A note.';
      expect(await resolve(guest, id, 2, { conflict_diary_id: copy?.id, resolution: 'OVERWRITE', note })).toMatchObject({ status: 422 });
      expect(await resolve(guest, id, 2, { conflict_diary_id: copy?.id, resolution: 'KEEP_PRIMARY', merged_content: { summary: 'x' }, note })).toMatchObject({ status: 422 });
      expect(await resolve(guest, id, 2, { conflict_diary_id: copy?.id, resolution: 'MERGED', note })).toMatchObject({ status: 422 });
      expect(await resolve(guest, id, 2, { conflict_diary_id: copy?.id, resolution: 'KEEP_PRIMARY', note: '  ' })).toMatchObject({ status: 422 });
      expect(await resolve(guest, id, 2, { conflict_diary_id: foreign?.id, resolution: 'KEEP_PRIMARY', note })).toMatchObject({ status: 422 });
      expect(await resolve(guest, id, 2, { conflict_diary_id: id, resolution: 'KEEP_PRIMARY', note })).toMatchObject({ status: 422 });
      expect(await resolve(guest, id, 1, { conflict_diary_id: copy?.id, resolution: 'KEEP_PRIMARY', note })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await resolve(READER, id, 2, { conflict_diary_id: copy?.id, resolution: 'KEEP_PRIMARY', note })).toMatchObject({ status: 403 });
      expect((await copiesOf(id))[0]?.conflict_state).toBe('CONFLICT_PENDING');
      // The contractor signed the diary of the day meanwhile: it is not written over, and the diary is kept as it is.
      expect((await contractorSign(guest, id, 2)).status).toBe(200);
      expect(await resolve(guest, id, 3, { conflict_diary_id: copy?.id, resolution: 'ADOPT_CONFLICT', note })).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
      expect(await resolve(guest, id, 3, { conflict_diary_id: copy?.id, resolution: 'MERGED', merged_content: { summary: 'x' }, note })).toMatchObject({ status: 409, json: { code: 'DIARY_STATE_INVALID' } });
      expect(await resolve(guest, id, 3, { conflict_diary_id: copy?.id, resolution: 'KEEP_PRIMARY', note })).toMatchObject({ status: 200, json: { status: 'CONTRACTOR_SIGNED' } });
      expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid and conflict_of_id is null', [target.id])).toHaveLength(1);
    });

    it('finds the diaries with a copy that waits whatever state they are in, and settles one by keeping a diary that was replaced since (Codex review of ST-QMS-002)', async () => {
      const { target, guest, id } = await conflicted('2026-10-27');
      const calm = (await save(guest, target, { record_date: '2026-10-28' })).json.resource_id as string;
      const waiting = async () => ((await list(guest, `?contract_id=${target.id}&has_conflict=true`)).json.items as Array<{ id: string }>).map((item) => item.id);
      expect(await waiting()).toEqual([id]);
      expect((await list(guest, `?contract_id=${target.id}`)).json.items).toHaveLength(2);
      expect((await list(guest, '?has_conflict=maybe')).status).toBe(422);
      // The diary is signed, locked and replaced by a correction that is locked in its turn: the copy still waits, and the diary can still be kept.
      expect((await contractorSign(guest, id, 2)).status).toBe(200);
      expect((await remark(SUPERVISOR, id, 3)).status).toBe(200);
      expect((await lock(SUPERVISOR, id, 4)).status).toBe(200);
      expect(await waiting()).toEqual([id]);
      const revision = (await correct(guest, id)).json.resource_id as string;
      expect((await contractorSign(guest, revision, 1)).status).toBe(200);
      expect((await remark(SUPERVISOR, revision, 2)).status).toBe(200);
      expect((await lock(SUPERVISOR, revision, 3)).status).toBe(200);
      expect((await stored(id))?.status).toBe('SUPERSEDED');
      expect(await waiting()).toEqual([id]);
      const [copy] = await copiesOf(id);
      const version = Number((await stored(id))?.version);
      const kept = await resolve(guest, id, version, { conflict_diary_id: copy?.id, resolution: 'KEEP_PRIMARY', note: 'The diary was replaced since.' });
      expect(kept).toMatchObject({ status: 200, json: { status: 'SUPERSEDED', resource_version: version } });
      expect((await stored(id))?.version).toBe(String(version));
      expect((await copiesOf(id))[0]).toMatchObject({ conflict_state: 'RESOLVED', conflict_resolution: 'KEEP_PRIMARY' });
      expect(await waiting()).toEqual([]);
      expect(calm).not.toBe(id);
    });

    it('AC-ST-QMS-002-3: UAT-AC367 does not keep a place without the consent to it, and keeps one with it', async () => {
      const target = await contract();
      const guest = await guestOf(target);
      const place = { lat: 10.8, lng: 106.7 };
      const refused = await save(guest, target, { record_date: '2026-10-25', content: { ...CONTENT, location: place } });
      expect(refused).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'content.geo_consent' } });
      expect(await save(guest, target, { record_date: '2026-10-25', content: { ...CONTENT, location: place, geo_consent: false } })).toMatchObject({ status: 422 });
      expect(await save(guest, target, { record_date: '2026-10-25', content: { ...CONTENT, location: { lat: 100, lng: 0 }, geo_consent: true } })).toMatchObject({ status: 422, json: { detail: 'content.location' } });
      expect(await rows('select 1 from machvon.site_diary where contract_id = $1::uuid', [target.id])).toHaveLength(0);
      const kept = await save(guest, target, { record_date: '2026-10-25', content: { ...CONTENT, location: place, geo_consent: true } });
      expect(kept.status).toBe(200);
      expect((await rows<{ content: Record<string, unknown> }>('select content from machvon.site_diary where id = $1', [kept.json.resource_id as string]))[0]?.content).toMatchObject({ location: place, geo_consent: true });
      // A revision and the content of a settled conflict follow the same rule.
      expect(await revise(guest, kept.json.resource_id as string, 1, { ...CONTENT, location: place })).toMatchObject({ status: 422 });
    });
  });

  it('answers a revision that was made before with what it did, at whatever version the retry names, and does not apply it twice (Codex review of ST-QMS-001)', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const id = (await save(guest, target, { record_date: '2026-10-23' })).json.resource_id as string;
    const op = '00000000-0000-4000-8000-0000000000ac';
    const content = { ...CONTENT, summary: 'Third text' };
    expect(await revise(guest, id, 1, content, op, '00000000-0000-4000-8000-0000000000f1')).toMatchObject({ status: 200, json: { resource_version: 2 } });
    expect(await revise(guest, id, 1, content, op, '00000000-0000-4000-8000-0000000000f2')).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 2 } });
    expect(await revise(guest, id, 2, content, op, '00000000-0000-4000-8000-0000000000f3')).toMatchObject({ status: 200, json: { resource_id: id, resource_version: 2 } });
    expect((await stored(id))?.version).toBe('2');
    expect((await audits(id, 'site_diary.revised')).length).toBe(1);
    // The same operation for another diary is a mistake.
    const other = await contract();
    const otherId = (await save(await guestOf(other), other, { record_date: '2026-10-23' })).json.resource_id as string;
    expect(await revise(await guestOf(other), otherId, 1, content, op)).toMatchObject({ status: 422 });
  });

  it('answers the operation of a correction only for the diary it corrects (Codex review of ST-QMS-001)', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const draftOp = '00000000-0000-4000-8000-0000000000ad';
    expect((await save(guest, target, { record_date: '2026-10-25', client_operation_id: draftOp })).status).toBe(200);
    const id = (await save(guest, target, { record_date: '2026-10-26' })).json.resource_id as string;
    expect((await contractorSign(guest, id, 1)).status).toBe(200);
    expect((await remark(SUPERVISOR, id, 2)).status).toBe(200);
    expect((await lock(SUPERVISOR, id, 3)).status).toBe(200);
    expect(await correct(guest, id, { client_operation_id: draftOp })).toMatchObject({ status: 422 });
    const corrected = await correct(guest, id, { client_operation_id: '00000000-0000-4000-8000-0000000000ae' });
    expect(corrected.status).toBe(200);
    expect(await correct(guest, id, { client_operation_id: '00000000-0000-4000-8000-0000000000ae' }, '00000000-0000-4000-8000-0000000000f9')).toMatchObject({ status: 200, json: { resource_id: corrected.json.resource_id } });
  });

  it('numbers the corrections of a diary whose contract code has a backslash, a percent sign or an underscore (Codex review of ST-QMS-001)', async () => {
    const target = await contract('ACTIVE', (n) => `HD_%\\${n}`);
    const guest = await guestOf(target);
    const id = (await save(guest, target, { record_date: '2026-10-24' })).json.resource_id as string;
    expect((await contractorSign(guest, id, 1)).status).toBe(200);
    expect((await remark(SUPERVISOR, id, 2)).status).toBe(200);
    expect((await lock(SUPERVISOR, id, 3)).status).toBe(200);
    const first = await correct(guest, id);
    expect(first.status).toBe(200);
    const firstId = first.json.resource_id as string;
    expect((await contractorSign(guest, firstId, 1)).status).toBe(200);
    expect((await remark(SUPERVISOR, firstId, 2)).status).toBe(200);
    expect((await lock(SUPERVISOR, firstId, 3)).status).toBe(200);
    const second = await correct(guest, firstId);
    expect(second.status).toBe(200);
    expect((await stored(firstId))?.diary_no).toBe(`NK-${target.code}-20261024-R1`);
    expect((await stored(second.json.resource_id as string))?.diary_no).toBe(`NK-${target.code}-20261024-R2`);
  });

  it('does not edit a draft any more than it saves one once the contract is no longer being performed (Codex review of ST-QMS-001)', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const id = (await save(guest, target, { record_date: '2026-10-22' })).json.resource_id as string;
    expect((await revise(guest, id, 1)).status).toBe(200);
    await world.owner('alter table machvon.contract disable trigger contract_status_guard');
    await world.owner("update machvon.contract set status = 'IN_REVIEW' where id = $1", [target.id]);
    await world.owner('alter table machvon.contract enable trigger contract_status_guard');
    expect(await revise(guest, id, 2, { ...CONTENT, summary: 'Edited after the suspension' })).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    expect(await rows<{ content: Record<string, unknown> }>('select content from machvon.site_diary where id = $1', [id])).toEqual([{ content: expect.objectContaining({ summary: 'Revised' }) }]);
  });

  it('reads the diaries in the scope of the caller, newest day first, in pages, narrowed by contract, state and day, and offers each reader only what they may do', async () => {
    const target = await contract();
    const other = await contract();
    const guest = await guestOf(target);
    const days = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'];
    const ids: string[] = [];
    for (const day of days) ids.push((await save(guest, target, { record_date: day })).json.resource_id as string);
    await save(DRAFTER, other, { record_date: '2026-10-12' });
    const signed = await contractorSign(guest, ids[0] as string, 1);
    expect(signed.status).toBe(200);

    const all = await list(READER, `?contract_id=${target.id}`);
    expect((all.json.items as Array<{ record_date: string }>).map((item) => item.record_date)).toEqual(['2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']);
    const first = await list(READER, `?contract_id=${target.id}&limit=3`);
    expect((first.json.items as unknown[]).length).toBe(3);
    const next = await list(READER, `?contract_id=${target.id}&limit=3&cursor=${encodeURIComponent(first.json.next_cursor as string)}`);
    expect((next.json.items as Array<{ record_date: string }>).map((item) => item.record_date)).toEqual(['2026-10-10']);
    expect(next.json.next_cursor).toBeNull();
    expect(((await list(READER, `?contract_id=${target.id}&status=CONTRACTOR_SIGNED`)).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([ids[0]]);
    expect(((await list(READER, `?contract_id=${target.id}&from=2026-10-11&to=2026-10-12`)).json.items as unknown[]).length).toBe(2);
    const impossible = Buffer.from(JSON.stringify(['2026-02-30', '00000000-0000-4000-8000-000000000001']), 'utf8').toString('base64url');
    for (const bad of ['status=NOPE', 'from=2026-13-01', 'contract_id=x', 'limit=0', 'cursor=bad', `cursor=${impossible}`]) expect([bad, (await list(READER, `?${bad}`)).status]).toEqual([bad, 422]);
    // The guest sees the diaries of its own contract only, and what it may do with each.
    const mine = await list(guest);
    expect((mine.json.items as Array<{ contract: { id: string } }>).every((item) => item.contract.id === target.id)).toBe(true);
    const draft = (mine.json.items as Array<{ id: string; actions: Record<string, boolean>; signable_roles: string[] }>).find((item) => item.id === ids[1]) as { actions: Record<string, boolean>; signable_roles: string[] };
    expect(draft.actions).toMatchObject({ revise: true, contractorSign: true, supervise: false, ownerConfirm: false, lock: false, correct: false });
    expect(draft.signable_roles).toEqual(['CONTRACTOR']);
    const signedLine = (mine.json.items as Array<{ id: string; actions: Record<string, boolean>; signable_roles: string[] }>).find((item) => item.id === ids[0]) as { actions: Record<string, boolean>; signable_roles: string[] };
    expect(signedLine.actions).toMatchObject({ revise: false, contractorSign: false, supervise: false });
    expect(signedLine.signable_roles).toEqual([]);
    // The supervisor is offered the remark on the diary that the contractor signed, and the reader nothing.
    expect((await read(SUPERVISOR, ids[0] as string)).json).toMatchObject({ signable_roles: ['SUPERVISOR'], actions: { supervise: true, lock: false } });
    expect((await read(READER, ids[0] as string)).json).toMatchObject({ signable_roles: [], actions: { revise: false, supervise: false, lock: false } });
    expect((await read(NOBODY, ids[0] as string)).status).toBe(403);
    expect((await read(READER, randomUUID())).status).toBe(404);
    // What is read is the diary and not the machine: no author id of a device, no hash of a draft.
    const shown = (await read(READER, ids[1] as string)).json;
    expect(shown.content_hash).toBeNull();
    expect(JSON.stringify(shown)).not.toMatch(/client_operation_id|device_id|updated_by/);
  });

  it('keeps the rules in the database too: a signature out of turn, over another hash, or twice by one person is refused', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const id = (await save(guest, target)).json.resource_id as string;
    const insert = (role: string, hash: string, member = guest) =>
      world.owner(
        `insert into machvon.qms_signature (tenant_id, id, subject_kind, subject_id, signer_role, membership_id, signer_name_snapshot, method, legal_effect, signed_content_hash, signed_at, client_operation_id, created_by)
         values ($1, gen_random_uuid(), 'SITE_DIARY', $2, $3, $4, 'Someone', 'IN_APP_OTP', 'INTERNAL_RECORD', $5, now(), gen_random_uuid(), $4)`,
        [TENANT_A, id, role, memberId(member), hash],
      );
    // A draft has no hash yet, and the supervisor does not sign it.
    await expect(insert('CONTRACTOR', 'a'.repeat(64))).rejects.toThrow(/signature is over the hash/);
    await expect(insert('SUPERVISOR', 'a'.repeat(64), SUPERVISOR)).rejects.toThrow(/DIARY_STATE_INVALID/);
    await contractorSign(guest, id, 1);
    const hash = (await stored(id))?.content_hash as string;
    await expect(insert('SUPERVISOR', 'b'.repeat(64), SUPERVISOR)).rejects.toThrow(/signature is over the hash/);
    await expect(insert('OWNER', hash, OWNER)).rejects.toThrow(/DIARY_STATE_INVALID/);
    await expect(insert('SUPERVISOR', hash, guest)).rejects.toThrow(/qms_signature_person_diary_uq/);
    await expect(world.owner("update machvon.site_diary set status = 'LOCKED', locked_at = now(), locked_by = $2 where id = $1", [id, memberId(SUPERVISOR)])).rejects.toThrow(/DIARY_STATE_INVALID/);
    await expect(world.owner("update machvon.site_diary set record_date = '2026-01-01' where id = $1", [id])).rejects.toThrow(/do not change/);
  });
});
