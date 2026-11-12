import { X509Certificate, createHash, randomUUID } from 'node:crypto';
import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { DIS_WEEKLY_CODE, INTERNAL_OVERVIEW_DEFAULT, vietnamDateOf } from '@machvon/kernel';
import type { LayoutConfig } from '@machvon/kernel';
import { fingerprintOf } from '../../src/modules/doc/cms-verification';
import { MockCertificateAuthority } from '../../src/modules/doc/mock-pki';
import { MockSigningPort } from '../../src/modules/doc/signing-port';
import type { SessionRef, SigningPort, SigningProvider } from '../../src/modules/doc/signing-port';
import { DOC_SIGNING_PORT } from '../../src/modules/doc/tokens';
import { reportFileName } from '../../src/modules/reports/file-name';
import { TENANT_A, id, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, codeOf, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * Design cases of the publishing of reports in the enterprise edition that no suite named yet (docs/uat/rpt): the signature of an issued copy and the lock of its period (UAT-PLAN-3001) and the form a tenant configures
 * without code, from the three people who approve its layout to the issued copy that keeps the version and the hash of that layout, with the three files of the copy and the name of the PDF (UAT-PLAN-3411, UAT-PLAN-3410).
 * Deviations that the product forces, said once here: (1) the four forms for the Ministry of Finance wait for the official template (PX-01) and the engine refuses to issue them, so the copy that is signed and locked is a copy of
 * the weekly report (READY) issued through the real chain, and the receiver that requires a signature is the Ministry all the same (the policy names receivers, not forms); (2) no certification authority adapter exists in the
 * product (DOC-SPK-01), so the port of signing is bound to the test authority of the product (MockSigningPort): as a MOCK provider it makes a test signature, and as the stand-in of a certification authority (the same
 * port, another provider name) it makes the real signature that locks the period; (3) a version of a rule cannot govern a past day, so the newer version of the layout is approved from tomorrow and the case reads the issued copy again today.
 */
jest.setTimeout(600_000);

const FAMILY = 0xb8;
const PERSONAS = {
  'rule-drafter': ['adm.governance.manage', 'adm.governance.read'],
  'rule-submitter': ['adm.governance.manage', 'adm.governance.read'],
  'rule-approver': ['adm.governance.approve', 'adm.governance.read'],
  'rule-all': ['adm.governance.manage', 'adm.governance.approve', 'adm.governance.read'],
  'rpt-preparer': ['rpt.read', 'rpt.generate', 'home.read'],
  'rpt-checker': ['rpt.read', 'rpt.check'],
  'rpt-approver': ['rpt.read', 'rpt.approve', 'rpt.issue', 'rpt.sign', 'rpt.lock.unlock', 'rpt.lock.read'],
  'rpt-deliverer': ['rpt.read', 'rpt.deliver'],
  'rpt-unlocker': ['rpt.read', 'rpt.lock.unlock', 'rpt.lock.read'],
  'rpt-reader': ['rpt.read'],
};
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const asOf = (day: string): { kind: 'AS_OF'; year: number; day: string } => ({ kind: 'AS_OF', year: Number(day.slice(0, 4)), day });
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('UAT of the signature, the lock and the configured forms of the report engine of the enterprise edition (cases of docs/uat/rpt)', () => {
  const world = new UatWorld();
  let counter = 0;

  beforeAll(async () => {
    await world.start(PERSONAS);
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  /** A frozen snapshot of the day with one project: what the weekly report and the overview are filled from. */
  async function snapshot(day: string, paid: string): Promise<void> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    const snapshotId = randomUUID();
    const projectId = id(FAMILY, 500 + counter);
    await world.seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `UAT-C8-${counter}`, unitId(ROOT_UNIT), id(FAMILY, 30)],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, date '2046-01-02' + $4::int, date '2046-01-02' + $4::int + 6, now(), 'DEFAULT', 'WEEK', $7, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `UAT-C8-RP-${counter}`, counter * 7, id(FAMILY, 40), WORKER_MEMBERSHIP_ID, Number(day.slice(0, 4))],
      ],
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, supersedes_id, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', now(), $4::date, $4::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $5, now() + ($6::int * interval '1 second'), null, $5, $5)`,
        [TENANT_A, snapshotId, periodId, day, WORKER_MEMBERSHIP_ID, counter],
      ],
      [
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, $5::numeric, 'COMPLETE')`,
        [TENANT_A, snapshotId, projectId, unitId(ROOT_UNIT), paid],
      ],
    ]);
  }

  const generate = (code: string, period: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Reply> => world.as('rpt-preparer', 'POST', '/report-engine/drafts', { body: { layout_code: code, period, ...extra } });
  const step = (persona: string, draftId: string, version: number, action: 'check' | 'approve' | 'issue'): Promise<Reply> => world.as(persona, 'POST', `/report-engine/drafts/${draftId}/${action}`, { ifMatch: version });
  /** A copy issued through the real chain: the preparer makes the draft, a second person checks, the approver approves and issues. */
  async function issuedCopy(code: string, period: Record<string, unknown>): Promise<string> {
    const made = await generate(code, period);
    assertStatus(made, 200);
    const draftId = made.json.draft_id as string;
    assertStatus(await step('rpt-checker', draftId, 1, 'check'), 200);
    assertStatus(await step('rpt-approver', draftId, 2, 'approve'), 200);
    const issued = await step('rpt-approver', draftId, 3, 'issue');
    assertStatus(issued, 200);
    expect(issued.json).toMatchObject({ status: 'ISSUED' });
    return issued.json.resource_id as string;
  }

  it('UAT-PLAN-3001 a signature of the test provider is kept as a test signature and the copy cannot go to the Ministry (422 REPORT_SIGNATURE_REQUIRED) and locks nothing; a real signature locks the period, the copy goes, a new copy is refused (PERIOD_LOCKED), the locker cannot unlock (403 SELF_APPROVAL_DENIED), a short reason is 422 and a good reason from a second person opens the period', async () => {
    // The approver is the signer of the case (user C): a personal certificate of the test authority is registered for the approver.
    const authority = await MockCertificateAuthority.createRoot({ commonName: 'UAT Root CA', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2040-01-01T00:00:00Z') });
    const identity = await authority.issue({ commonName: 'User C', notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2030-01-01T00:00:00Z') });
    const fingerprint = fingerprintOf(new X509Certificate(identity.certificate));
    const certificateId = randomUUID();
    await world.seedAsAdmin([
      [
        `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
         values ($1::uuid, $2::uuid, 'PERSONAL', $3::uuid, null, '01', 'CN=UAT Root CA', 'CN=User C', 'MOCK', '2026-01-01', '2030-01-01', $4, 'Active', $3::uuid)`,
        [TENANT_A, certificateId, world.idOf('rpt-approver'), fingerprint],
      ],
    ]);
    // The port of signing: the test authority of the product signs; the name of the provider decides whether the signature is a test one.
    const mock = new MockSigningPort({ identity, clock: () => new Date() });
    const bind = (provider: SigningProvider): void => {
      const port = world.get<SigningPort>(DOC_SIGNING_PORT);
      Object.assign(port, {
        provider,
        startSession: async (request: Parameters<SigningPort['startSession']>[0]): Promise<SessionRef> => ({ ...(await mock.startSession(request)), provider }),
        collect: (ref: SessionRef) => mock.collect({ ...ref, provider: 'MOCK' }),
        cancel: (ref: SessionRef) => mock.cancel({ ...ref, provider: 'MOCK' }),
      });
    };
    const sign = async (copy: string): Promise<Reply> => {
      const started = await world.as('rpt-approver', 'POST', `/report-engine/issues/${copy}/signature`, { body: { certificate_id: certificateId } });
      assertStatus(started, 200);
      const [session] = await world.rows<{ provider_session_ref: string }>('select provider_session_ref from machvon.report_signature_session where id = $1', [started.json.resource_id as string]);
      mock.approve({ provider: 'MOCK', sessionId: session?.provider_session_ref as string, expiresAt: new Date(Date.now() + 60_000) });
      return world.as('rpt-approver', 'POST', `/report-engine/signature-sessions/${started.json.resource_id as string}/completion`);
    };
    const deliver = (copy: string): Promise<Reply> => world.as('rpt-deliverer', 'POST', `/report-engine/issues/${copy}/deliveries`, { body: { receiver: 'MOF', channel: 'MANUAL' } });
    const lockOf = async (copy: string): Promise<Array<{ id: string; unlocked_at: string | null; locked_by: string }>> =>
      world.rows('select id, unlocked_at::text as unlocked_at, locked_by from machvon.report_period_lock where issue_id = $1', [copy]);

    // Steps 1 and 2: the copy of the series of today is signed with the test provider; it is kept as a test signature, locks nothing, and the Ministry does not get the copy.
    await snapshot(today, '600000000000');
    const testCopy = await issuedCopy(DIS_WEEKLY_CODE, asOf(today));
    bind('MOCK');
    const completed = await sign(testCopy);
    assertStatus(completed, 200);
    expect(completed.json).toMatchObject({ status: 'SIGNED' });
    expect((await world.audits(testCopy, 'rpt.signature_completed'))[0]?.safe_diff).toMatchObject({ provider: 'MOCK', counts_for_delivery: false });
    expect((await world.as('rpt-reader', 'GET', `/report-engine/issues/${testCopy}/signature`)).json).toMatchObject({ signed: true, signature: { provider: 'MOCK', counts_for_delivery: false }, period_lock: null, signature_required_receivers: ['MOF'] });
    expect(await lockOf(testCopy)).toEqual([]);
    const refused = await deliver(testCopy);
    assertStatus(refused, 422, 'REPORT_SIGNATURE_REQUIRED');
    expect(await world.rows('select 1 from machvon.report_delivery where issue_id = $1', [testCopy])).toEqual([]);

    // Step 3: the copy of the series of yesterday is signed through the stand-in of a certification authority: a real signature, which locks the period and lets the copy go to the Ministry.
    await snapshot(yesterday, '500000000000');
    const realCopy = await issuedCopy(DIS_WEEKLY_CODE, asOf(yesterday));
    bind('REMOTE_CA');
    const signed = await sign(realCopy);
    assertStatus(signed, 200);
    expect((await world.audits(realCopy, 'rpt.signature_completed'))[0]?.safe_diff).toMatchObject({ provider: 'REMOTE_CA', counts_for_delivery: true });
    const [lock] = await lockOf(realCopy);
    expect(lock).toMatchObject({ unlocked_at: null, locked_by: world.idOf('rpt-approver') });
    expect((await world.audits(lock?.id as string, 'rpt.period_locked'))[0]?.safe_diff).toMatchObject({ layout_code: DIS_WEEKLY_CODE, event: 'SIGNED' });
    expect((await world.as('rpt-reader', 'GET', `/report-engine/issues/${realCopy}/signature`)).json).toMatchObject({ signed: true, signature: { provider: 'REMOTE_CA', counts_for_delivery: true }, period_lock: { open: true } });
    const delivered = await deliver(realCopy);
    assertStatus(delivered, 200);
    expect(delivered.json).toMatchObject({ receiver: 'MOF', event: 'DELIVERED' });
    // A new copy of the same period is refused while the period is locked, and nothing is made.
    const draftsBefore = (await world.rows<{ n: string }>('select count(*)::text as n from machvon.report_draft'))[0]?.n;
    const blocked = await generate(DIS_WEEKLY_CODE, asOf(yesterday), { reason: 'The Treasury booked a payment after the signature' });
    expect([blocked.status, codeOf(blocked)]).toEqual([422, 'PERIOD_LOCKED']);
    expect((await world.rows<{ n: string }>('select count(*)::text as n from machvon.report_draft'))[0]?.n).toBe(draftsBefore);
    // The person who locked cannot unlock (403 SELF_APPROVAL_DENIED); a second person needs a reason of enough length (422 VALIDATION_FAILED for a short one) and then opens the period.
    const unlock = (persona: string, reason: string): Promise<Reply> => world.as(persona, 'POST', `/report-engine/period-locks/${lock?.id as string}/unlock`, { ifMatch: 1, body: { reason } });
    assertStatus(await unlock('rpt-approver', 'The Ministry asked for a correction of the figures'), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await unlock('rpt-unlocker', 'short reason'), 422, 'VALIDATION_FAILED');
    expect((await lockOf(realCopy))[0]?.unlocked_at).toBeNull();
    const opened = await unlock('rpt-unlocker', 'The Ministry asked for a correction of the figures');
    assertStatus(opened, 200);
    expect(opened.json).toMatchObject({ status: 'UNLOCKED' });
    expect((await lockOf(realCopy))[0]?.unlocked_at).not.toBeNull();
    expect(((await world.as('rpt-unlocker', 'GET', '/report-engine/period-locks?open_only=true')).json.items as unknown[]).length).toBe(0);
    // With the period open, a new copy of it is made again.
    assertStatus(await generate(DIS_WEEKLY_CODE, asOf(yesterday), { reason: 'The Treasury booked a payment after the signature' }), 200);
  });

  it('UAT-PLAN-3411 / UAT-PLAN-3410 a layout drafted by A, submitted by B and approved by C is offered from the day it is in force, a report of the configured form is generated and issued, its PDF is named by the file-name rule and kept with its hash, and the copy keeps the version and the hash of the layout when a newer version is approved; the forms of PVN, HPM and the Ministry cannot be configured', async () => {
    const tomorrow = vietnamDateOf(new Date(Date.now() + 86_400_000));
    const day = vietnamDateOf(new Date());
    const layout = (title: string, indicators: LayoutConfig['indicators']): LayoutConfig => ({ ...(JSON.parse(JSON.stringify(INTERNAL_OVERVIEW_DEFAULT)) as LayoutConfig), title, indicators });
    const draft = async (persona: string, code: string, params: LayoutConfig, effectiveFrom: string): Promise<Reply> =>
      world.as(persona, 'POST', '/governance-rules', { body: { rule_type: 'REPORT_LAYOUT', code, params, effective_from: effectiveFrom, reason: 'The board overview of the month' } });
    const approveRule = async (code: string, params: LayoutConfig, effectiveFrom: string): Promise<string> => {
      const drafted = await draft('rule-drafter', code, params, effectiveFrom);
      assertStatus(drafted, 201);
      const ruleId = drafted.json.resource_id as string;
      const submitted = await world.as('rule-submitter', 'POST', `/governance-rules/${ruleId}/submit`, { ifMatch: drafted.json.resource_version as number, body: { reason: 'Ready for the decision' } });
      assertStatus(submitted, 200);
      assertStatus(await world.as('rule-approver', 'POST', `/governance-rules/${ruleId}/approve`, { ifMatch: submitted.json.resource_version as number, body: { reason: 'Approved by the head of the planning board' } }), 200);
      expect((await world.audits(ruleId, 'governance_rule.approved'))[0]).toMatchObject({ actor_id: world.idOf('rule-approver') });
      return ruleId;
    };
    const v1 = layout('UAT board overview', [{ code: 'DISBURSEMENT_RATE_TOTAL' }, { code: 'DISBURSED_TREASURY' }, { code: 'PLAN_TOTAL' }, { code: 'OPEN_WARNINGS' }]);
    // The official forms of PVN, HPM and the Ministry cannot be configured: a code that is not a configured one, and a receiver that is an official one, are refused and nothing is written.
    const before = (await world.rows<{ n: string }>(`select count(*)::text as n from machvon.governance_rule where rule_type = 'REPORT_LAYOUT'`))[0]?.n;
    for (const code of ['PVN-MONTHLY', 'HPM-MONTHLY', 'MOF-DIS-MONTHLY']) assertStatus(await draft('rule-drafter', code, v1, day), 422, 'VALIDATION_FAILED');
    for (const receiver of ['PVN', 'HPM', 'MOF']) assertStatus(await draft('rule-drafter', 'CFG_UAT_OFFICIAL', { ...v1, receiver: receiver as never }, day), 422, 'GOVERNANCE_RULE_PARAMS_INVALID');
    expect((await world.rows<{ n: string }>(`select count(*)::text as n from machvon.governance_rule where rule_type = 'REPORT_LAYOUT'`))[0]?.n).toBe(before);
    // A drafts, B submits, C approves; the form is offered from the day it is in force: today for the first, tomorrow for the other.
    const firstRule = await approveRule('CFG_UAT_BOARD', v1, day);
    await approveRule('CFG_UAT_LATER', v1, tomorrow);
    const catalogue = (await world.as('rpt-reader', 'GET', '/report-engine/catalogue')).json.items as Array<{ code: string; status: string; issuable: boolean; data_source: string }>;
    expect(catalogue.find((item) => item.code === 'CFG_UAT_BOARD')).toMatchObject({ status: 'READY', issuable: true, data_source: 'LIVE' });
    expect(catalogue.some((item) => item.code === 'CFG_UAT_LATER')).toBe(false);
    assertStatus(await generate('CFG_UAT_LATER', { kind: 'MONTH', year: Number(day.slice(0, 4)), index: Number(day.slice(5, 7)) }), 404);
    // The report of the configured form is generated and issued by three people: the copy keeps the version of the rule and the hash of the layout.
    await snapshot(today, '700000000000');
    const month = { kind: 'MONTH', year: Number(day.slice(0, 4)), index: Number(day.slice(5, 7)) };
    const copy = await issuedCopy('CFG_UAT_BOARD', month);
    const issue = (await world.as('rpt-reader', 'GET', `/report-engine/issues/${copy}`)).json as { layout_code: string; layout_version: string; layout_sha256: string; revision: number; counts_as_accepted: boolean; files: Array<{ format: string; sha256: string }> };
    expect(issue).toMatchObject({ layout_code: 'CFG_UAT_BOARD', layout_version: 'v1', revision: 1, counts_as_accepted: true });
    expect(issue.layout_sha256).toMatch(/^[0-9a-f]{64}$/);
    const layoutRow = (await world.rows<{ sha256: string; version: string; status: string }>(`select template_sha256 as sha256, version, status from machvon.report_layout where code = 'CFG_UAT_BOARD'`))[0];
    expect(layoutRow).toMatchObject({ version: 'v1', status: 'READY' });
    // The three files: the workbook, the PDF (and the Word file where the layout has a narrative) are read back and agree with their hashes; the PDF is named by the rule.
    const formats = issue.files.map((file) => file.format);
    expect(formats).toEqual(expect.arrayContaining(['XLSX', 'PDF']));
    for (const file of issue.files) {
      const read = await world.as('rpt-reader', 'GET', `/report-engine/issues/${copy}/files/${file.format}`);
      assertStatus(read, 200);
      const bytes = Buffer.from(read.json.content_base64 as string, 'base64');
      expect(sha(bytes)).toBe(file.sha256);
      expect(read.json.sha256).toBe(file.sha256);
      if (file.format === 'PDF') {
        expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(read.json.name).toBe(reportFileName({ code: 'CFG_UAT_BOARD', period: month as never, revision: 1, sha256: file.sha256, extension: 'pdf' }));
        expect(read.json.name).toMatch(new RegExp(`^CFG_UAT_BOARD_${month.year}-M${String(month.index).padStart(2, '0')}_v01_${file.sha256.slice(0, 8)}\\.pdf$`));
      }
    }
    // A newer version of the layout is drafted, submitted and approved (in force from tomorrow); the issued copy read again keeps its version and its hash, and the catalogue of today still offers the first.
    const v2 = layout('UAT board overview, second version', [{ code: 'PLAN_TOTAL' }, { code: 'DISBURSED_TREASURY' }]);
    const secondRule = await approveRule('CFG_UAT_BOARD', v2, tomorrow);
    expect(secondRule).not.toBe(firstRule);
    const again = (await world.as('rpt-reader', 'GET', `/report-engine/issues/${copy}`)).json as { layout_version: string; layout_sha256: string; sha256: string };
    expect(again).toMatchObject({ layout_version: 'v1', layout_sha256: issue.layout_sha256 });
    const versions = await world.rows<{ version: number; status: string }>(`select version, status from machvon.governance_rule where rule_type = 'REPORT_LAYOUT' and code = 'CFG_UAT_BOARD' order by version`);
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    expect(versions[1]?.status).toBe('APPROVED');
    // The three are three people: whoever drafted and submitted a layout cannot approve it (403 SELF_APPROVAL_DENIED), though he holds the right to approve.
    const own = await draft('rule-all', 'CFG_UAT_OWN', v1, day);
    assertStatus(own, 201);
    const ownSubmitted = await world.as('rule-all', 'POST', `/governance-rules/${own.json.resource_id as string}/submit`, { ifMatch: own.json.resource_version as number, body: { reason: 'Ready' } });
    assertStatus(ownSubmitted, 200);
    assertStatus(await world.as('rule-all', 'POST', `/governance-rules/${own.json.resource_id as string}/approve`, { ifMatch: ownSubmitted.json.resource_version as number, body: { reason: 'Approved by myself' } }), 403, 'SELF_APPROVAL_DENIED');
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'REPORT_SIGNATURE_REQUIRED'));
    expectCheckFails(() => assertStatus({ status: 422, json: { code: 'PERIOD_LOCKED' } }, 422, 'REPORT_SIGNATURE_REQUIRED'));
    expectCheckFails(() => {
      if (sha(new Uint8Array([1])) !== sha(new Uint8Array([2]))) throw new Error('the hashes differ');
    });
  });
});
