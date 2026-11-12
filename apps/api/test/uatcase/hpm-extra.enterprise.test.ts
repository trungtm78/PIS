import { createHash, randomUUID } from 'node:crypto';
import type { HpmPort } from '@machvon/edition-enterprise/src/server.ts';
import { FileService } from '../../src/modules/files';
import { HPM_PORT } from '../../src/editions/enterprise/tokens';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertRefusedForPermission, assertStatus, codeOf, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';
import { ROOT_UNIT, UatWorld } from '../uat/uat-world';
import { scopedCaller, seedScopedMembers } from './support';

/**
 * Cases of docs/uat/hpm/uat.json that the suite `../uat/hpm.uat.test.ts` does not script: the two stories of the push and of the correction seen as the three attackers of the design (the maker of the next step of their
 * own work, the member of another tenant who uses an id of this one, the reader who sends a command), the cap of the retries, the boundary of the note of a rejection, and a copy made on a DEMO form. The adapter is the
 * file writer of the edition (no call leaves the process); what HPM answers is PENDING-EXTERNAL and the receipts are recorded by hand (R18). Each case is named by its id in the title of its test.
 */
jest.setTimeout(240_000);

const LAYOUT = 'HPM-MONTHLY';
const DEPARTMENT = 2;
const UNIT_HOLDER = 40; // every right of the area, on the unit tree of the department only
const HPM_ALL = ['hpm.read', 'hpm.admin', 'hpm.push', 'hpm.receipt', 'hpm.correction.propose', 'hpm.correction.decide'];
const PERSONAS = {
  'hpm-admin': HPM_ALL,
  'hpm-pusher': ['hpm.read', 'hpm.push'],
  'hpm-receiver': ['hpm.read', 'hpm.receipt'],
  'hpm-proposer': ['hpm.read', 'hpm.correction.propose'],
  'hpm-decider': ['hpm.read', 'hpm.correction.decide'],
  'hpm-reader': ['hpm.read'],
};
const REOPEN = '5a1e0000-0000-4000-8000-0000000000a1';

/** The refusal of a step the caller has no standing for: 403 with the code of the self-approval rule or of the scope. */
function assertRefusedAsMaker(reply: Reply, code: 'SELF_APPROVAL_DENIED' | 'SCOPE_DENIED'): void {
  assertStatus(reply, 403, code);
}

describe('UAT cases of the push to HPM that the suite of the area does not script (HPM)', () => {
  const world = new UatWorld();
  const unitCaller = scopedCaller(world);
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS, { 'hpm-admin': HPM_ALL }, async (w) => {
      await w.harness.seedUnits(TENANT_A, [{ n: DEPARTMENT, path: `/${unitId(ROOT_UNIT)}/${unitId(DEPARTMENT)}/`, parent: ROOT_UNIT }]);
      await seedScopedMembers(w, [{ n: UNIT_HOLDER, permissions: HPM_ALL, kind: 'UNIT_SUBTREE', units: [DEPARTMENT] }]);
      // The reopening of the DIS period that a correction of an accepted month needs: October 2026, approved, its window open for a week.
      const period = randomUUID();
      await w.seedAsAdmin([
        [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by, soft_closed_at, locked_at, locked_by)
           values ($1, $2, 'UAT-HPX-2026-10', 1, date '2026-10-01', date '2026-10-31', date '2026-11-05' + interval '3 hours', 'WORKDAY_VN', 'MONTH', 2026, 'LOCKED', gen_random_uuid(), $3, $3, now(), now(), $3)`,
          [TENANT_A, period, memberId(1)],
        ],
        [
          `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, reason, requested_by, approved_by, decided_by, decided_at, decision_reason, window_until, requested_window_hours, status, created_by, updated_by)
           values ($1, $2, $3, 'PERIOD', 'Correction of the figures after a late invoice', $4, $5, $5, now(), 'The invoice is in order and the month may be reopened', now() + interval '167 hours', 24, 'APPROVED', $4, $4)`,
          [TENANT_A, REOPEN, period, memberId(1), memberId(2)],
        ],
      ]);
    });
  }, 300_000);

  afterAll(() => world.stop(), 60_000);

  /** A report file in the store of the tenant, as an issued copy leaves it: the key to name and the hash to state. */
  async function report(content = `row-${(counter += 1)}`): Promise<{ key: string; sha: string }> {
    const bytes = new TextEncoder().encode(`code,value\n${content}\n`);
    const stored = await world.get<FileService>(FileService).upload({ tenantId: TENANT_A, membershipId: world.idOf('hpm-admin'), scopeVersion: 1 }, { purpose: 'report_export', declaredType: 'text/csv', bytes });
    return { key: stored.key, sha: createHash('sha256').update(bytes).digest('hex') };
  }

  const pushBody = (file: { key: string; sha: string }, period: string, revision: number): Record<string, unknown> => ({ layout_code: LAYOUT, period, revision, sha256: file.sha, file_object_key: file.key });
  const push = (persona: string, file: { key: string; sha: string }, period: string, revision: number): Promise<Reply> => world.as(persona, 'POST', '/hpm/pushes', { body: pushBody(file, period, revision) });
  const pushOf = (reply: Reply): Record<string, unknown> => reply.json.push as Record<string, unknown>;
  const receipt = (persona: string, row: Record<string, unknown>, body: Record<string, unknown>): Promise<Reply> => world.as(persona, 'POST', `/hpm/pushes/${String(row.id)}/receipt`, { ifMatch: row.version as number, body });
  const pushState = async (pushId: string): Promise<Record<string, unknown>> =>
    (await world.rows<Record<string, unknown>>('select status, version, attempts, receipt_by from machvon.hpm_push where id = $1::uuid', [pushId]))[0] as Record<string, unknown>;
  const count = async (sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<number> => (await world.rows(sql, params, tenant)).length;

  it('UAT-PLAN-170 the push, its retry and its receipt: the pusher is refused the receipt of their own push (403 SELF_APPROVAL_DENIED), a holder below the whole tenant is refused every command (403 SCOPE_DENIED), a member of another tenant is answered as for an id that does not exist (404), a reader is refused (403), and nothing changes', async () => {
    const file = await report('story,one');
    const mine = pushOf(await push('hpm-admin', file, '2026-M01', 1));
    const before = await pushState(mine.id as string);
    const pushes = await count('select 1 from machvon.hpm_push');
    const retry = (caller: (url: string, version: number) => Promise<Reply>): Promise<Reply> => caller(`/hpm/pushes/${String(mine.id)}/retry`, mine.version as number);

    // Step 1: the maker records the receipt of their own push, and a holder of the rights on a part of the tenant submits, retries and records.
    assertRefusedAsMaker(await receipt('hpm-admin', mine, { outcome: 'ACCEPTED', reference: 'HPM-1' }), 'SELF_APPROVAL_DENIED');
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', '/hpm/pushes', { body: pushBody(file, '2026-M01', 1) }), 'SCOPE_DENIED');
    assertRefusedAsMaker(await retry((url, version) => unitCaller(UNIT_HOLDER, 'POST', url, { ifMatch: version, body: {} })), 'SCOPE_DENIED');
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', `/hpm/pushes/${String(mine.id)}/receipt`, { ifMatch: mine.version as number, body: { outcome: 'ACCEPTED', reference: 'HPM-1' } }), 'SCOPE_DENIED');

    // Step 2: tenant B names the push of tenant A, and the file of tenant A.
    for (const [path, payload] of [['/receipt', { outcome: 'ACCEPTED', reference: 'HPM-1' }], ['/retry', {}]] as const) {
      const foreign = await world.asTenantB(1, 'POST', `/hpm/pushes/${String(mine.id)}${path}`, { ifMatch: mine.version as number, body: payload });
      const nothing = await world.asTenantB(1, 'POST', `/hpm/pushes/${randomUUID()}${path}`, { ifMatch: 1, body: payload });
      expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
      assertStatus(foreign, 404);
    }
    const foreignFile = await world.asTenantB(1, 'POST', '/hpm/pushes', { body: pushBody(file, '2026-M01', 1) });
    const missingFile = await world.asTenantB(1, 'POST', '/hpm/pushes', { body: pushBody({ ...file, key: file.key.replace(/[0-9a-f-]{36}$/, randomUUID()) }, '2026-M01', 1) });
    expect([foreignFile.status, codeOf(foreignFile)]).toEqual([missingFile.status, codeOf(missingFile)]);
    assertStatus(foreignFile, 404);

    // Step 3: a reader sends the three commands.
    assertRefusedForPermission(await push('hpm-reader', file, '2026-M01', 1));
    assertRefusedForPermission(await retry((url, version) => world.as('hpm-reader', 'POST', url, { ifMatch: version, body: {} })));
    assertRefusedForPermission(await receipt('hpm-reader', mine, { outcome: 'ACCEPTED', reference: 'HPM-1' }));

    expect(await pushState(mine.id as string)).toEqual(before);
    expect(await count('select 1 from machvon.hpm_push')).toBe(pushes);
    expect(await world.audits(mine.id as string, 'hpm.receipt_accepted')).toHaveLength(0);
    expect(await world.audits(mine.id as string, 'hpm.push_retried')).toHaveLength(0);
    expect(await count('select 1 from machvon.hpm_push', [], TENANT_B)).toBe(0);
  });

  it('UAT-PLAN-172 the correction of an accepted month: the proposer is refused the decision on their own proposal (403 SELF_APPROVAL_DENIED), a holder below the whole tenant is refused both commands (403 SCOPE_DENIED), a member of another tenant is answered as for an id that does not exist (404), a reader is refused (403), and nothing changes', async () => {
    const accepted = pushOf(await push('hpm-pusher', await report('accepted,month'), '2026-M10', 1));
    assertStatus(await receipt('hpm-receiver', accepted, { outcome: 'ACCEPTED', reference: 'HPM-2026-10' }), 200);
    const proposal = { layout_code: LAYOUT, period: '2026-M10', from_revision: 1, period_reopen_id: REOPEN, reason: 'A late invoice changed the executed value of the month' };

    // Step 1: the proposer decides their own proposal; the holder below the whole tenant proposes and decides.
    const proposed = await world.as('hpm-admin', 'POST', '/hpm/corrections', { body: proposal });
    assertStatus(proposed, 200);
    const correctionId = proposed.json.id as string;
    const version = proposed.json.version as number;
    const before = (await world.rows<Record<string, unknown>>('select state, version, decided_by from machvon.hpm_correction where id = $1::uuid', [correctionId]))[0];
    expect(before).toMatchObject({ state: 'PROPOSED' });
    const decision = { decision: 'APPROVE', reason: 'The invoice and the reopening are in order' };
    assertRefusedAsMaker(await world.as('hpm-admin', 'POST', `/hpm/corrections/${correctionId}/decision`, { ifMatch: version, body: decision }), 'SELF_APPROVAL_DENIED');
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', '/hpm/corrections', { body: proposal }), 'SCOPE_DENIED');
    assertRefusedAsMaker(await unitCaller(UNIT_HOLDER, 'POST', `/hpm/corrections/${correctionId}/decision`, { ifMatch: version, body: decision }), 'SCOPE_DENIED');

    // Step 2: tenant B names the correction of tenant A and proposes one for the month of tenant A: it holds nothing accepted, so there is nothing to correct, as for any month.
    const foreign = await world.asTenantB(1, 'POST', `/hpm/corrections/${correctionId}/decision`, { ifMatch: version, body: decision });
    const nothing = await world.asTenantB(1, 'POST', `/hpm/corrections/${randomUUID()}/decision`, { ifMatch: 1, body: decision });
    expect([foreign.status, codeOf(foreign)]).toEqual([nothing.status, codeOf(nothing)]);
    assertStatus(foreign, 404);
    const foreignProposal = await world.asTenantB(1, 'POST', '/hpm/corrections', { body: proposal });
    const otherProposal = await world.asTenantB(1, 'POST', '/hpm/corrections', { body: { ...proposal, from_revision: 7 } });
    expect([foreignProposal.status, codeOf(foreignProposal)]).toEqual([otherProposal.status, codeOf(otherProposal)]);
    assertStatus(foreignProposal, 404);

    // Step 3: a reader proposes and decides.
    assertRefusedForPermission(await world.as('hpm-reader', 'POST', '/hpm/corrections', { body: proposal }));
    assertRefusedForPermission(await world.as('hpm-reader', 'POST', `/hpm/corrections/${correctionId}/decision`, { ifMatch: version, body: decision }));

    expect((await world.rows<Record<string, unknown>>('select state, version, decided_by from machvon.hpm_correction where id = $1::uuid', [correctionId]))[0]).toEqual(before);
    expect(await count('select 1 from machvon.hpm_correction')).toBe(1);
    expect(await world.audits(correctionId, 'hpm.correction_approved')).toHaveLength(0);
    // The decision of somebody else still goes through: the refusals above were the rule, not a broken correction.
    assertStatus(await world.as('hpm-decider', 'POST', `/hpm/corrections/${correctionId}/decision`, { ifMatch: version, body: decision }), 200);
  });

  it('UAT-HPM-STA-03 a push whose package cannot be written is retried up to the five tries of HPM_PUSH_POLICY, each recorded as HPM_DELIVERY_FAILED, the sixth is refused (409 HPM_RETRY_EXHAUSTED) and nothing of what the writer said about its disk is ever shown', async () => {
    const port = world.get<HpmPort>(HPM_PORT);
    const failing = jest.spyOn(port, 'deliver').mockRejectedValue(new Error('the disk is full at /secret/path/outbox'));
    try {
      const first = await push('hpm-pusher', await report('cap,bytes'), '2026-M06', 1);
      assertStatus(first, 200);
      let row = pushOf(first);
      const seen: unknown[] = [first.json];
      expect(row).toMatchObject({ status: 'FAILED', attempts: 1, last_error_code: 'HPM_DELIVERY_FAILED' });
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        const next = await world.as('hpm-pusher', 'POST', `/hpm/pushes/${String(row.id)}/retry`, { ifMatch: row.version as number, body: {} });
        assertStatus(next, 200);
        seen.push(next.json);
        row = pushOf(next);
        expect(row).toMatchObject({ status: 'FAILED', attempts: attempt, last_error_code: 'HPM_DELIVERY_FAILED' });
      }
      const over = await world.as('hpm-pusher', 'POST', `/hpm/pushes/${String(row.id)}/retry`, { ifMatch: row.version as number, body: {} });
      assertStatus(over, 409, 'HPM_RETRY_EXHAUSTED');
      seen.push(over.json);
      expect(failing).toHaveBeenCalledTimes(5);
      expect(await pushState(row.id as string)).toMatchObject({ status: 'FAILED', attempts: 5 });
      expect((await world.rows<{ outcome: string; error_code: string }>('select outcome, error_code from machvon.hpm_push_attempt where push_id = $1::uuid order by attempt_no', [row.id])).map((attempt) => [attempt.outcome, attempt.error_code])).toEqual(Array(5).fill(['FAILED', 'HPM_DELIVERY_FAILED']));
      expect(JSON.stringify(seen)).not.toContain('/secret/path');
      expect(JSON.stringify(await world.rows("select safe_diff from machvon.audit_event where resource_id = $1 and action like 'hpm.push_%'", [row.id]))).not.toContain('/secret/path');
      expect(JSON.stringify(await world.rows("select payload from machvon.outbox_event where aggregate_id = $1", [row.id]))).not.toContain('/secret/path');
    } finally {
      failing.mockRestore();
    }
  });

  it('UAT-HPM-EDG-01 a rejection with a note of nine characters is refused (422) and the push stays written, and with a note of exactly ten it is recorded as rejected (200)', async () => {
    const nine = pushOf(await push('hpm-pusher', await report('note,nine'), '2026-M08', 1));
    const ten = pushOf(await push('hpm-pusher', await report('note,ten'), '2026-M09', 1));
    const refused = await receipt('hpm-receiver', nine, { outcome: 'REJECTED', reference: 'HPM-8', note: '123456789' });
    assertStatus(refused, 422, 'VALIDATION_FAILED');
    expect(refused.json).toMatchObject({ detail: 'note' });
    expect(await pushState(nine.id as string)).toMatchObject({ status: 'WRITTEN', version: String(nine.version), receipt_by: null });
    expect(await world.audits(nine.id as string, 'hpm.receipt_rejected')).toHaveLength(0);
    const taken = await receipt('hpm-receiver', ten, { outcome: 'REJECTED', reference: 'HPM-9', note: '1234567890' });
    assertStatus(taken, 200);
    expect(taken.json).toMatchObject({ status: 'REJECTED' });
    expect(await pushState(ten.id as string)).toMatchObject({ status: 'REJECTED', receipt_by: world.idOf('hpm-receiver') });
    expect((await world.audits(ten.id as string, 'hpm.receipt_rejected'))[0]).toMatchObject({ actor_id: world.idOf('hpm-receiver'), reason: '1234567890' });
  });

  it('UAT-HPM-DEMO-01 a copy of the report engine made on a DEMO form is never recorded as accepted (409 TEMPLATE_UNCONFIRMED), the push keeps its state and the delivery log of the engine has no ACCEPTED row', async () => {
    const xlsx = new TextEncoder().encode(`workbook demo ${randomUUID()}`);
    const hash = createHash('sha256').update(xlsx).digest('hex');
    const issueId = randomUUID();
    await world.seedAsAdmin([
      [`insert into machvon.report_output_file (tenant_id, sha256, format, size_bytes, content, created_by) values ($1, $2, 'XLSX', $3, $4, $5)`, [TENANT_A, hash, xlsx.length, Buffer.from(xlsx), memberId(1)]],
      [
        `insert into machvon.report_issue (tenant_id, id, layout_id, layout_code, layout_version, period_code, period, revision, supersedes_id, reason, draft_id, sha256, xlsx_sha256, xlsx_name, data_source, snapshot_ref, form_status, demo_mark, counts_as_accepted, prepared_by, checked_by, approved_by, issued_by)
         values ($1, $2, $3, $4, '1', '2024-M05', '{"kind":"MONTH","year":2026,"index":1}'::jsonb, 1, null, null, $5, $6, $6, 'HPM_2024-M05_r1.xlsx', 'LIVE', null, 'DEMO', 'DEMO MARK', false, $7, $8, $9, $9)`,
        [TENANT_A, issueId, randomUUID(), LAYOUT, randomUUID(), hash, memberId(1), world.idOf('hpm-pusher'), world.idOf('hpm-receiver')],
      ],
    ]);
    const sent = pushOf(await world.as('hpm-pusher', 'POST', '/hpm/pushes', { body: { layout_code: LAYOUT, period: '2024-M05', revision: 1, sha256: hash, issue_id: issueId } }));
    expect(sent).toMatchObject({ status: 'WRITTEN', form_status: 'DEMO', demo_mark: 'DEMO MARK' });
    const before = await pushState(sent.id as string);
    const refused = await receipt('hpm-receiver', sent, { outcome: 'ACCEPTED', reference: 'HPM-D' });
    assertStatus(refused, 409, 'TEMPLATE_UNCONFIRMED');
    expect(await pushState(sent.id as string)).toEqual(before);
    expect(await world.audits(sent.id as string, 'hpm.receipt_accepted')).toHaveLength(0);
    const log = await world.rows<{ event: string }>('select event from machvon.report_delivery where issue_id = $1 order by occurred_at, id', [issueId]);
    expect(log.map((entry) => entry.event)).toEqual(['DELIVERED']);
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertRefusedAsMaker({ status: 403, json: { code: 'SCOPE_DENIED' } }, 'SELF_APPROVAL_DENIED'));
    expectCheckFails(() => assertRefusedAsMaker({ status: 200, json: {} }, 'SCOPE_DENIED'));
  });
});
