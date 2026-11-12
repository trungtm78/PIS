import { randomUUID } from 'node:crypto';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertNoOutbound, recordConnections } from './case-d-support';
import type { Doc } from './case-d-support';
import { assertStatus, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * The design cases of the reconciliation with Oracle EBS that no suite named (docs/uat/ebs/uat.json): PLAN-173 (the commands of the file import), PLAN-149 (the commands of the reconciliation), EBS-E2E-03 (a code of EBS
 * that is not ours, read through the mappings of INT-03 made by the real commands of two people) and EBS-PX-01 (the labels of a result while the layout of the file is a working assumption, PENDING-EXTERNAL PX-04).
 * The world is the whole enterprise edition over a real database; no mock stands in for a behaviour. "No outbound network call" is measured: the connections the process opens during a case are recorded and
 * every one that is not to this machine fails it.
 */
jest.setTimeout(600_000);

const HEADER = 'project_code,period,extract_date,disbursed_vnd,committed_vnd';
const ASSUMED_LAYOUT = 'WORKING-ASSUMPTION-2026.1';
const REASON = 'The ministry asked for this mapping in writing.';
const PERSONAS = {
  'ebs-admin': ['ebs.read', 'ebs.admin', 'ebs.import', 'ebs.import.preview', 'ebs.reconcile'],
  'ebs-reconciler': ['ebs.read', 'ebs.reconcile'],
  'ebs-previewer': ['ebs.read', 'ebs.import.preview'],
  'ebs-reader': ['ebs.read'],
  'ebs-owner': ['ebs.read', 'ebs.reconcile'],
  'ebs-owner2': ['ebs.read', 'ebs.reconcile'],
  'int-admin': ['int.account.read', 'int.account.manage', 'int.access.read', 'int.dataset.read', 'int.dataset.manage', 'int.bi.read', 'int.bi.manage', 'int.codes.read', 'int.codes.propose', 'int.codes.approve', 'int.system.manage'],
  'int-checker': ['int.codes.read', 'int.codes.approve'],
};
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

describe('UAT cases of the reconciliation with Oracle EBS (PLAN-173, PLAN-149, EBS-E2E-03, EBS-PX-01)', () => {
  const world = new UatWorld();
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, { 'ebs-admin': PERSONAS['ebs-admin'] }, async (w) => {
      // The published working calendar of three years: the items of a reconciliation get a due time from it.
      const year = new Date().getUTCFullYear();
      await w.seedAsAdmin(
        [year - 1, year, year + 1].map((value): [string, unknown[]] => [
          `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
           values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
          [TENANT_A, value, memberId(1)],
        ]),
      );
    });
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  /** A project of ours with the money the Treasury paid, so that a statement can differ from it. */
  async function project(paid: string): Promise<{ id: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const code = `UAT-EBSC-P${String(counter).padStart(3, '0')}`;
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Plant project', $4, $4, $5, 'INTERNAL', 1000000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(ROOT_UNIT), id(0x98, 90)],
      ],
      [
        `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, reversal_of_id, import_id)
         values ($1, gen_random_uuid(), $2, $3, 'TREASURY', $4::numeric, '2026-10-01T08:00:00+07:00', $5, 'PAYMENT', null, gen_random_uuid())`,
        [TENANT_A, projectId, `EXT-${code}`, paid, 'd'.repeat(64)],
      ],
    ]);
    return { id: projectId, code };
  }

  const door = (bytes: Uint8Array): Promise<{ key: string; sha: string }> => world.store(bytes, 'import', 'text/csv', 'ebs-admin');
  const body = (file: { key: string; sha: string }): Record<string, unknown> => ({ file_object_key: file.key, file_sha256: file.sha });
  const items = (reply: Reply): Array<Doc> => reply.json.items as Array<Doc>;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await world.rows<{ n: string }>(`select count(*)::text as n from (${sql}) t`, params))[0]?.n);

  it('UAT-PLAN-173 the commands of the file import: a file of three rows (one invalid) is previewed and applied, the same key repeats the first answer without new rows, the same file under a new key or a conflicting request is refused with its code, the audit rows name the actor and no connection leaves the machine', async () => {
    const log = recordConnections();
    try {
      const mine = await project('600');
      const file = await door(csv(HEADER, `${mine.code},2026-09,2026-10-02,100,200`, 'UAT-EBSC-UNKNOWN,2026-09,2026-10-02,5,5', `${mine.code},2026-09,bad-day,1,1`));
      // Step 1: the dry run writes nothing; the apply writes the two good rows and quarantines the bad one.
      const previewKey = `uat-${randomUUID()}`;
      const dry = await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { key: previewKey, body: body(file) });
      assertStatus(dry, 200);
      expect(dry.json).toMatchObject({ status: 'DRY_RUN', acceptance: 'PENDING_EXTERNAL', already_applied: false, counts: { total: 3, valid: 2, errors: 1 } });
      expect(await count('select 1 from machvon.ebs_record where project_code = $1', [mine.code])).toBe(0);
      const key = `uat-${randomUUID()}`;
      const done = await world.as('ebs-admin', 'POST', '/ebs/imports', { key, body: body(file) });
      assertStatus(done, 200);
      expect(done.json).toMatchObject({ status: 'APPLIED', counts: { total: 3, applied: 2, quarantined: 1 }, unknown_projects: 1 });
      const importId = done.json.resource_id as string;
      expect(await count('select 1 from machvon.ebs_record where import_id = $1', [importId])).toBe(2);
      // Step 2: the same key repeats the first answer; nothing new is written, audited or announced.
      const replay = await world.as('ebs-admin', 'POST', '/ebs/imports', { key, body: body(file) });
      assertStatus(replay, 200);
      expect(replay.json).toMatchObject({ status: 'APPLIED', resource_id: importId, counts: { total: 3, applied: 2, quarantined: 1 } });
      expect(await count('select 1 from machvon.ebs_record where import_id = $1', [importId])).toBe(2);
      expect(await count('select 1 from machvon.file_import where file_sha256 = $1', [file.sha])).toBe(1);
      expect(await world.audits(importId, 'ebs.import_applied')).toHaveLength(1);
      expect(await world.events(importId, 'ebs.import.applied.v1')).toHaveLength(1);
      const previewAgain = await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { key: previewKey, body: body(file) });
      assertStatus(previewAgain, 200);
      expect(previewAgain.json).toMatchObject({ status: 'DRY_RUN', counts: { total: 3, valid: 2, errors: 1 } });
      // The same file under a new key is the same file hash: refused, and nothing is written.
      assertStatus(await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) }), 409, 'IMPORT_FILE_ALREADY_APPLIED');
      expect(await count('select 1 from machvon.ebs_record where import_id = $1', [importId])).toBe(2);
      expect(await count('select 1 from machvon.file_import where file_sha256 = $1', [file.sha])).toBe(1);
      // Step 3: a conflicting request: the key of the first command with another file, and a file whose hash is not the one named.
      const other = await door(csv(HEADER, `${mine.code},2026-08,2026-09-02,7,7`));
      const conflicting = await world.as('ebs-admin', 'POST', '/ebs/imports', { key, body: body(other) });
      assertStatus(conflicting, 409, 'IDEMPOTENCY_CONFLICT');
      const wrongHash = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: { file_object_key: other.key, file_sha256: file.sha } });
      assertStatus(wrongHash, 422, 'HASH_MISMATCH');
      expect(await count('select 1 from machvon.ebs_record where project_code = $1 and period = $2', [mine.code, '2026-08'])).toBe(0);
      // Step 4: the audit rows name the actor of each command.
      expect((await world.audits(importId, 'ebs.import_applied'))[0]).toMatchObject({ actor_id: world.idOf('ebs-admin'), safe_diff: { file_sha256: file.sha, records_written: 2, unknown_projects: 1 } });
      expect((await world.audits(TENANT_A, 'ebs.import_previewed')).filter((row) => row.safe_diff.file_sha256 === file.sha).map((row) => row.actor_id)).toEqual(expect.arrayContaining([world.idOf('ebs-previewer')]));
      expect((await world.audits(TENANT_A, 'ebs.import_previewed')).every((row) => row.actor_id !== world.idOf('ebs-admin') || row.safe_diff.file_sha256 !== file.sha)).toBe(true);
    } finally {
      log.stop();
    }
    assertNoOutbound(log.targets);
  });

  it('UAT-PLAN-149 the commands of the reconciliation: a run opens the items, the owner resolves one and another is handed to a second owner, the same key repeats the first answer without new rows, a stale or settled request is refused with its code, the audit rows name the actor and no connection leaves the machine', async () => {
    const log = recordConnections();
    try {
      const first = await project('600');
      const second = await project('900');
      const file = await door(csv(HEADER, `${first.code},2026-10,2026-11-05,700,`, `${second.code},2026-10,2026-11-05,950,`));
      assertStatus(await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) }), 200);
      const runBody = { period: '2026-10', owner_id: memberId(world.member('ebs-owner')) };
      // Step 1: the run opens one item for each difference, owned by somebody who made none of the figures.
      const runKey = `uat-${randomUUID()}`;
      const run = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { key: runKey, body: runBody });
      assertStatus(run, 200);
      const mineFirst = items(run).find((item) => item.project_code === first.code) as Doc;
      const mineSecond = items(run).find((item) => item.project_code === second.code) as Doc;
      expect(mineFirst).toMatchObject({ measure: 'DISBURSED_VND', difference_kind: 'AMOUNT_MISMATCH', ours: '600', theirs: '700', state: 'OPEN', owner_id: world.idOf('ebs-owner') });
      expect(mineSecond).toMatchObject({ ours: '900', theirs: '950', state: 'OPEN' });
      const resolveKey = `uat-${randomUUID()}`;
      const resolveBody = { kind: 'TIMING', reason: 'The payment will be booked next month', review_on: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) };
      const resolved = await world.as('ebs-owner', 'POST', `/ebs/differences/${mineFirst.id}/resolution`, { key: resolveKey, ifMatch: mineFirst.version, body: resolveBody });
      assertStatus(resolved, 200);
      expect(resolved.json).toMatchObject({ status: 'RESOLVED' });
      const handed = await world.as('ebs-reconciler', 'POST', `/ebs/differences/${mineSecond.id}/owner`, { ifMatch: mineSecond.version, body: { owner_id: memberId(world.member('ebs-owner2')) } });
      assertStatus(handed, 200);
      expect((await world.rows<{ owner_id: string }>('select owner_id::text from machvon.ebs_reconciliation_item where id = $1::uuid', [mineSecond.id]))[0]?.owner_id).toBe(world.idOf('ebs-owner2'));
      // Step 2: the same key repeats the first answer; the items, the audit rows and the events are not made again.
      const itemsBefore = await count('select 1 from machvon.ebs_reconciliation_item where project_code in ($1, $2)', [first.code, second.code]);
      expect(itemsBefore).toBe(2);
      const replayRun = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { key: runKey, body: runBody });
      assertStatus(replayRun, 200);
      expect(replayRun.json).toMatchObject({ status: 'RECONCILED', opened: run.json.opened, examined: run.json.examined });
      const replayResolve = await world.as('ebs-owner', 'POST', `/ebs/differences/${mineFirst.id}/resolution`, { key: resolveKey, ifMatch: mineFirst.version, body: resolveBody });
      assertStatus(replayResolve, 200);
      expect(replayResolve.json).toMatchObject({ status: 'RESOLVED', resource_version: resolved.json.resource_version });
      expect(await count('select 1 from machvon.ebs_reconciliation_item where project_code in ($1, $2)', [first.code, second.code])).toBe(2);
      expect(await world.audits(mineFirst.id, 'ebs.difference_resolved')).toHaveLength(1);
      expect(await world.events(mineFirst.id, 'ebs.difference.resolved.v1')).toHaveLength(1);
      // The same figures again under a new key open nothing new either.
      const again = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { body: runBody });
      expect(again.json).toMatchObject({ opened: 0 });
      expect(await count('select 1 from machvon.ebs_reconciliation_item where project_code in ($1, $2)', [first.code, second.code])).toBe(2);
      // Step 3: a stale version, a settled item and a hand-over to one of the makers are refused with their codes.
      assertStatus(await world.as('ebs-owner2', 'POST', `/ebs/differences/${mineSecond.id}/resolution`, { ifMatch: 1, body: { ...resolveBody } }), 409, 'VERSION_CONFLICT');
      assertStatus(await world.as('ebs-reconciler', 'POST', `/ebs/differences/${mineSecond.id}/owner`, { ifMatch: 1, body: { owner_id: memberId(world.member('ebs-owner')) } }), 409, 'VERSION_CONFLICT');
      assertStatus(await world.as('ebs-owner', 'POST', `/ebs/differences/${mineFirst.id}/resolution`, { ifMatch: resolved.json.resource_version as number, body: resolveBody }), 409, 'EBS_ITEM_STATE_INVALID');
      const current = (await world.rows<{ version: string }>('select version::text from machvon.ebs_reconciliation_item where id = $1::uuid', [mineSecond.id]))[0]?.version;
      const toMaker = await world.as('ebs-reconciler', 'POST', `/ebs/differences/${mineSecond.id}/owner`, { ifMatch: Number(current), body: { owner_id: world.idOf('ebs-admin') } });
      assertStatus(toMaker, 403, 'SELF_APPROVAL_DENIED');
      expect((await world.rows<{ owner_id: string }>('select owner_id::text from machvon.ebs_reconciliation_item where id = $1::uuid', [mineSecond.id]))[0]?.owner_id).toBe(world.idOf('ebs-owner2'));
      // Step 4: the audit rows name the actor of each command.
      expect((await world.audits(mineFirst.id, 'ebs.difference_resolved'))[0]).toMatchObject({ actor_id: world.idOf('ebs-owner'), safe_diff: { resolution_kind: 'TIMING', state: 'RESOLVED' } });
      expect((await world.audits(mineSecond.id, 'ebs.difference_reassigned'))[0]).toMatchObject({ actor_id: world.idOf('ebs-reconciler'), safe_diff: { from_owner_id: world.idOf('ebs-owner') } });
      expect((await world.audits(TENANT_A, 'ebs.reconciliation_run')).some((row) => row.actor_id === world.idOf('ebs-reconciler') && row.safe_diff.period === '2026-10')).toBe(true);
    } finally {
      log.stop();
    }
    assertNoOutbound(log.targets);
  });

  it('UAT-EBS-E2E-03 a code of EBS that is not ours is read through the mapping that is ACTIVE (made by one person and approved by another) and not through one that waits for its second person or whose range has not begun, and the code the file said is kept', async () => {
    // The system and the codes are made by the real commands of INT-03: registered with its format, proposed by one person, approved by another.
    assertStatus(await world.as('int-admin', 'POST', '/int/source-systems', { body: { code: 'ORACLE_EBS', name: 'Oracle EBS', kind: 'ERP', code_pattern: 'ORA-[A-Z]\\d' } }), 201);
    const active = await project('400');
    const waiting = await project('410');
    const later = await project('420');
    const propose = async (project_: { code: string }, external: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const proposed = await world.as('int-admin', 'POST', '/int/project-codes', { body: { source_system: 'ORACLE_EBS', our_code: project_.code, external_code: external, reason: REASON, ...extra } });
      assertStatus(proposed, 201);
      expect(proposed.json).toMatchObject({ status: 'PROPOSED' });
      return proposed.json.id as string;
    };
    const approve = async (codeId: string): Promise<void> => {
      assertStatus(await world.as('int-admin', 'POST', `/int/project-codes/${codeId}/decision`, { ifMatch: 1, body: { decision: 'APPROVE', reason: REASON } }), 403, 'SELF_APPROVAL_DENIED');
      const approved = await world.as('int-checker', 'POST', `/int/project-codes/${codeId}/decision`, { ifMatch: 1, body: { decision: 'APPROVE', reason: REASON } });
      assertStatus(approved, 200);
      expect(approved.json).toMatchObject({ status: 'ACTIVE' });
    };
    await approve(await propose(active, 'ORA-A1'));
    await propose(waiting, 'ORA-B2');
    await approve(await propose(later, 'ORA-C3', { valid_from: '2999-01-01' }));
    const file = await door(csv(HEADER, 'ORA-A1,2026-10,2026-11-06,450,', 'ORA-B2,2026-10,2026-11-06,460,', 'ORA-C3,2026-10,2026-11-06,470,'));
    // Step 1: the dry run knows the code with the ACTIVE mapping and the other two are projects it does not know.
    const dry = await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { body: body(file) });
    assertStatus(dry, 200);
    expect((dry.json.rows as Array<{ business_key: string; outcome: string | null }>).map((row) => row.outcome)).toEqual(['RECORD', 'RECORD_PROJECT_UNKNOWN', 'RECORD_PROJECT_UNKNOWN']);
    // Step 2: the apply keeps the code of the file on the records, counts the two as unknown projects, and the reconciliation attaches the one with the ACTIVE mapping to our project and only that one.
    const done = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ status: 'APPLIED', unknown_projects: 2, counts: { applied: 3 } });
    expect((await world.rows<{ project_code: string }>('select project_code from machvon.ebs_record where import_id = $1 order by project_code', [done.json.resource_id])).map((row) => row.project_code)).toEqual(['ORA-A1', 'ORA-B2', 'ORA-C3']);
    const run = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { body: { period: '2026-10', owner_id: memberId(world.member('ebs-owner')) } });
    assertStatus(run, 200);
    const differences = items(run).filter((item) => ['ORA-A1', 'ORA-B2', 'ORA-C3'].includes(item.project_code));
    // The code with the ACTIVE mapping is our project, compared with its figures; the other two are projects the reconciliation does not know (no project, no figure of ours).
    expect(differences.map((item) => [item.project_code, item.project_id, item.ours, item.theirs])).toEqual([['ORA-A1', active.id, '400', '450'], ['ORA-B2', null, null, '460'], ['ORA-C3', null, null, '470']]);
    expect(items(run).filter((item) => [waiting.id, later.id].includes(item.project_id))).toEqual([]);
  });

  it('UAT-EBS-PX-01 while the layout of the file is a working assumption every result carries acceptance PENDING_EXTERNAL and the layout version WORKING-ASSUMPTION-2026.1, and the connection names what waits for the customer (the data of the PENDING-EXTERNAL band)', async () => {
    const mine = await project('800');
    const file = await door(csv(HEADER, `${mine.code},2026-11,2026-12-02,850,`));
    // Step 1: the dry run, the apply and the items of the reconciliation all carry the label.
    const dry = await world.as('ebs-previewer', 'POST', '/ebs/imports/preview', { body: body(file) });
    assertStatus(dry, 200);
    expect(dry.json).toMatchObject({ acceptance: 'PENDING_EXTERNAL', layout_version: ASSUMED_LAYOUT });
    const done = await world.as('ebs-admin', 'POST', '/ebs/imports', { body: body(file) });
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ acceptance: 'PENDING_EXTERNAL', layout_version: ASSUMED_LAYOUT });
    expect((await world.audits(done.json.resource_id as string, 'ebs.import_applied'))[0]?.safe_diff).toMatchObject({ acceptance: 'PENDING_EXTERNAL', layout_version: ASSUMED_LAYOUT });
    const run = await world.as('ebs-reconciler', 'POST', '/ebs/reconciliations', { body: { period: '2026-11', owner_id: memberId(world.member('ebs-owner')) } });
    assertStatus(run, 200);
    const mineItems = items(run).filter((item) => item.project_code === mine.code);
    expect(mineItems).toHaveLength(1);
    expect(mineItems[0]).toMatchObject({ acceptance: 'PENDING_EXTERNAL' });
    const listed = await world.as('ebs-reader', 'GET', '/ebs/differences?state=OPEN');
    assertStatus(listed, 200);
    expect(items(listed).filter((item) => item.project_code === mine.code)[0]).toMatchObject({ acceptance: 'PENDING_EXTERNAL' });
    // Step 2: the connection (EBS-01) reads PENDING_EXTERNAL with the layout version and carries the list that the PENDING-EXTERNAL band is drawn from: what waits, who owns it and what it costs.
    const connection = await world.as('ebs-reader', 'GET', '/ebs/connection');
    assertStatus(connection, 200);
    expect(connection.json).toMatchObject({ acceptance: 'PENDING_EXTERNAL', layout_version: ASSUMED_LAYOUT, supported_layouts: [ASSUMED_LAYOUT], api_adapter: { status: 'MISSING' } });
    const waiting = connection.json.pending_external as Array<{ code: string; what: string; owner: string; consequence: string }>;
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    expect(waiting.map((entry) => entry.code)).toContain('EBS_EXTRACT');
    for (const entry of waiting) for (const field of [entry.what, entry.owner, entry.consequence]) expect(field).not.toBe('');
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'IMPORT_FILE_ALREADY_APPLIED'));
    expectCheckFails(() => assertStatus({ status: 409, json: { code: 'VERSION_CONFLICT' } }, 409, 'IMPORT_FILE_ALREADY_APPLIED'));
    expectCheckFails(() => assertNoOutbound(['127.0.0.1', '203.0.113.7']));
  });
});
