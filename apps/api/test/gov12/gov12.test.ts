import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client, Pool } from 'pg';
import { PERMISSIONS } from '@machvon/contracts';
import { ControlDatabase, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, validateOc4idsPackage } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { audModule } from '../../src/modules/aud';
import { GiftController, GiftReadsController } from '../../src/modules/aud/gift.controller';
import { InvestorStandingReadsController } from '../../src/modules/aud/standing.controller';
import { WhistleController, WhistlePublicController, WhistleReadsController } from '../../src/modules/aud/whistle.controller';
import { docModule } from '../../src/modules/doc';
import { TransmittalController, TransmittalReadsController } from '../../src/modules/doc/transmittal.controller';
import { UnconfiguredSigningPort } from '../../src/modules/doc/signing-adapters';
import { DOC_SIGNING_PORT } from '../../src/modules/doc/tokens';
import { prjModule } from '../../src/modules/prj';
import { MonitoringController, MonitoringReadsController } from '../../src/modules/prj/monitoring.controller';
import { PortalController, PortalReadsController } from '../../src/modules/prj/portal.controller';
import { PortalPublicController } from '../../src/modules/prj/portal-public.controller';
import { resetPublicLimiters } from '../../src/modules/public-client';
import { qmsModule } from '../../src/modules/qms';
import { PhotoFindingController, PhotoFindingReadsController } from '../../src/modules/qms/photo-finding.controller';
import { REPORT_FORMS, rptModule } from '../../src/modules/reports';
import { PeriodReportController, PeriodReportReadsController } from '../../src/modules/reports/period-report.controller';
import { ReportController } from '../../src/modules/reports/report.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1;
const OFFICER = 2;
const REVIEWER = 3;
const APPROVER = 4;
const NOBODY = 5;
const CHILD_HANDLER = 6;
const B_ADMIN = 1;
const ROOT = 1;
const CHILD = 2;
const PROJECT = randomUUID();
const SECRET_PROJECT = randomUUID();
const DOC = randomUUID();
const DOC2 = randomUUID();
const DOC_SHA = createHash('sha256').update('doc one').digest('hex');
const DOC2_SHA = createHash('sha256').update('doc two').digest('hex');

const OPERATIONS = [
  'listMonitoringFiles', 'getMonitoringFile', 'openMonitoringFile', 'setMonitoringTrigger', 'addMonitoringPackItem', 'withdrawMonitoringPackItem', 'sendMonitoringNotice', 'closeMonitoringFile', 'logMonitoringFeedback', 'moveMonitoringFeedback', 'getMonitoringFeedback',
  'getPortalSettings', 'savePortalSettings', 'publishPortalRecord', 'withdrawPortalRecord', 'listPortalRecords', 'exportPortalOc4ids',
  'listDocContainers', 'getDocContainer', 'registerDocContainer', 'moveDocContainer', 'listDocTransmittals', 'getDocTransmittalInbox', 'getDocTransmittal', 'sendDocTransmittal', 'answerDocTransmittal', 'extendDocTransmittal',
  'listWhistleReports', 'getWhistleSummary', 'getWhistleReport', 'moveWhistleReport', 'assignWhistleSubject', 'replyToWhistleReporter',
  'listGifts', 'declareGift', 'takeGiftReview', 'closeGift', 'listInvestorStandings', 'getInvestorProfile',
  'scanPhotoFindings', 'listPhotoFindings', 'getPhotoFinding', 'movePhotoFinding',
  'listReportPeriodLocks', 'unlockReportPeriod', 'startReportSignature', 'completeReportSignature', 'getReportSignature', 'deliverReport',
] as const;
const ALL_RIGHTS = [...new Set(OPERATIONS.map((operation) => (PERMISSIONS as Record<string, string>)[operation] as string))];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** Lane GOV-12 over HTTP: community monitoring, transmittals, the portal and its public surface, the anonymous channel, gifts, photo findings, standing, period locks. */
describe('GOV-12 over HTTP', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let controlPool: Pool;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string | number; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  /** The public surface: no token, no tenant header. */
  async function publicCall(method: string, url: string, body?: unknown): Promise<Reply & { headers: Headers; text: string }> {
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), headers: response.headers, text };
  }
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;

  async function admin(statements: Array<[string, unknown[]?]>, triggers = false): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      if (!triggers) await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }, { n: CHILD, path: `/${unitId(ROOT)}/${unitId(CHILD)}/`, parent: ROOT }]);
    for (const member of [ADMIN, OFFICER, REVIEWER, APPROVER, NOBODY]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedMembership(TENANT_A, CHILD_HANDLER, CHILD);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'GOV12_ALL', ALL_RIGHTS, 20);
    await harness.seedRole(TENANT_A, 2, 'GOV12_NOBODY', ['home.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'GOV12_ALL', ALL_RIGHTS, 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 3, member: REVIEWER, role: 1, kind: 'TENANT' },
      { n: 4, member: APPROVER, role: 1, kind: 'TENANT' },
      { n: 5, member: NOBODY, role: 2, kind: 'TENANT' },
      { n: 6, member: CHILD_HANDLER, role: 1, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const project = (id: string, code: string, classification: string): [string, unknown[]] => [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, investor_unit_id, start_year, end_year)
       values ($1, $2, $3, $4, $5, $6, $7, 120000000000, 'IMPLEMENTATION', 1, 'B', $5, 2025, 2027)`,
      [TENANT_A, id, code, `Project ${code}`, unitId(ROOT), randomUUID(), classification],
    ];
    const document = (id: string, sha: string, title: string): Array<[string, unknown[]]> => {
      const version = randomUUID();
      return [
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, effect_status, current_version_id, created_by, updated_by, version) values ($1, $2, 'ATTACHMENT', 'TXT', $3, 'INTERNAL', 'PENDING', $4, $5, $5, 1)`, [TENANT_A, id, title, version, memberId(ADMIN)]],
        [`insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json) values ($1, $2, $3, 1, $4, $5, 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb)`, [TENANT_A, version, id, `tenants/${TENANT_A}/doc/${id}`, sha]],
      ];
    };
    await admin([project(PROJECT, 'PRJ-HTTP-1', 'PUBLIC'), project(SECRET_PROJECT, 'PRJ-HTTP-2', 'CONFIDENTIAL'), ...document(DOC, DOC_SHA, 'Design report'), ...document(DOC2, DOC2_SHA, 'Estimate')]);
    const tenants = harness.tenants as TenantDatabase;
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [
        MonitoringController, MonitoringReadsController, PortalController, PortalReadsController, PortalPublicController, TransmittalController, TransmittalReadsController, WhistleController, WhistleReadsController, WhistlePublicController,
        GiftController, GiftReadsController, InvestorStandingReadsController, PhotoFindingController, PhotoFindingReadsController, PeriodReportController, PeriodReportReadsController, ReportController,
      ],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: ControlDatabase, useValue: new ControlDatabase(controlPool) },
        { provide: DOC_SIGNING_PORT, useValue: new UnconfiguredSigningPort() },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    if (controlPool) await controlPool.end();
    await harness.stop();
  }, 60_000);

  beforeEach(() => resetPublicLimiters());

  it('is registered in the modules of PRJ, DOC, AUD, QMS and RPT, with the public surfaces on the control plane only', () => {
    for (const controller of [MonitoringController, MonitoringReadsController, PortalController, PortalReadsController]) expect(prjModule.controllers).toContain(controller);
    expect(prjModule.controllers).not.toContain(PortalPublicController);
    expect(prjModule.controlPlane?.controllers).toContain(PortalPublicController);
    for (const controller of [TransmittalController, TransmittalReadsController]) expect(docModule.controllers).toContain(controller);
    for (const controller of [WhistleController, WhistleReadsController, GiftController, GiftReadsController, InvestorStandingReadsController]) expect(audModule.controllers).toContain(controller);
    expect(audModule.controllers).not.toContain(WhistlePublicController);
    expect(audModule.controlPlane?.controllers).toContain(WhistlePublicController);
    for (const controller of [PhotoFindingController, PhotoFindingReadsController]) expect(qmsModule.controllers).toContain(controller);
    for (const controller of [PeriodReportController, PeriodReportReadsController]) expect(rptModule.controllers).toContain(controller);
  });

  describe('community monitoring (G4-8)', () => {
    let fileId = '';
    let feedbackId = '';
    it('refuses a caller without the right and opens one file for a project', async () => {
      expect((await call('POST', '/monitoring-files', { member: NOBODY, body: { project_id: PROJECT } })).status).toBe(403);
      expect((await call('GET', '/monitoring-files', { member: NOBODY })).status).toBe(403);
      const opened = await call('POST', '/monitoring-files', { member: OFFICER, body: { project_id: PROJECT } });
      expect(opened).toMatchObject({ status: 200, json: { status: 'OPENED', resource_version: 1 } });
      fileId = opened.json.resource_id as string;
      expect((await call('POST', '/monitoring-files', { member: OFFICER, body: { project_id: PROJECT } })).json.status).toBe('EXISTING');
      expect((await call('POST', '/monitoring-files', { member: OFFICER, body: { project_id: randomUUID() } })).status).toBe(422);
    });

    it('counts 45 days from the day the duty began and fixes the days of the rule on the file', async () => {
      expect((await call('POST', `/monitoring-files/${fileId}/trigger`, { member: OFFICER, ifMatch: 7, body: { kind: 'WORKS_START', on: '2020-01-01' } })).status).toBe(409);
      expect((await call('POST', `/monitoring-files/${fileId}/trigger`, { member: OFFICER, ifMatch: 1, body: { kind: 'MANUAL', on: '2020-01-01' } })).status).toBe(422);
      const set = await call('POST', `/monitoring-files/${fileId}/trigger`, { member: OFFICER, ifMatch: 1, body: { kind: 'WORKS_START', on: '2020-01-01' } });
      expect(set.status).toBe(200);
      const read = await call('GET', `/monitoring-files/${fileId}`, { member: OFFICER });
      expect(read.json).toMatchObject({ notice_days: 45, notice_rule_version: 0, notice: { state: 'OVERDUE', due_on: '2020-02-15' }, rule: { unverified: true } });
    });

    it('needs the required documents before the notice goes, then sends it once and calls it late', async () => {
      expect((await call('POST', `/monitoring-files/${fileId}/notice`, { member: OFFICER, ifMatch: 2, body: { sent_on: '2020-03-01' } })).json.code).toBe('MONITORING_PACK_INCOMPLETE');
      for (const [item, doc] of [['NOTICE_TEXT', DOC], ['PROJECT_INFO', DOC2], ['PLAN_SCHEDULE', DOC2]] as const) {
        expect((await call('POST', `/monitoring-files/${fileId}/pack-items`, { member: OFFICER, body: { item, document_id: doc, document_kind: 'DOCUMENT' } })).status).toBe(200);
      }
      expect((await call('POST', `/monitoring-files/${fileId}/pack-items`, { member: OFFICER, body: { item: 'NOTICE_TEXT', document_id: DOC, document_kind: 'DOCUMENT' } })).json.code).toBe('MONITORING_PACK_DUPLICATE');
      const sent = await call('POST', `/monitoring-files/${fileId}/notice`, { member: OFFICER, ifMatch: 2, body: { sent_on: '2020-03-01', note: 'Posted at the commune hall' } });
      expect(sent).toMatchObject({ status: 200, json: { status: 'SENT_LATE' } });
      expect((await call('POST', `/monitoring-files/${fileId}/notice`, { member: OFFICER, ifMatch: 3, body: { sent_on: '2020-03-02' } })).json.code).toBe('MONITORING_NOTICE_ALREADY_SENT');
      const read = await call('GET', `/monitoring-files/${fileId}`, { member: OFFICER });
      expect(read.json).toMatchObject({ notice: { state: 'SENT_LATE', days_late: 15 }, pack: { complete: true } });
    });

    it('runs a feedback to a closed answer; the closer is not the responder; the words never reach the audit row or an event', async () => {
      const logged = await call('POST', `/monitoring-files/${fileId}/feedback`, { member: OFFICER, body: { reference: 'PH-HTTP-1', received_on: '2026-10-01', channel: 'MEETING', topic: 'LAND', from_label: 'Hamlet 3', summary: 'The access road is blocked by spoil from the works of the bridge.' } });
      expect(logged.json.status).toBe('RECEIVED');
      feedbackId = logged.json.resource_id as string;
      expect((await call('POST', `/monitoring-feedback/${feedbackId}/move`, { member: OFFICER, ifMatch: 1, body: { move: 'TAKE' } })).json.status).toBe('IN_REVIEW');
      expect((await call('POST', `/monitoring-feedback/${feedbackId}/move`, { member: OFFICER, ifMatch: 2, body: { move: 'RESPOND', text: 'short' } })).status).toBe(422);
      expect((await call('POST', `/monitoring-feedback/${feedbackId}/move`, { member: OFFICER, ifMatch: 2, body: { move: 'RESPOND', text: 'The spoil is moved and the road is reopened to the hamlet.' } })).json.status).toBe('RESPONDED');
      expect((await call('POST', `/monitoring-feedback/${feedbackId}/move`, { member: OFFICER, ifMatch: 3, body: { move: 'CLOSE' } })).json.code).toBe('SELF_APPROVAL_DENIED');
      expect((await call('POST', `/monitoring-feedback/${feedbackId}/move`, { member: REVIEWER, ifMatch: 3, body: { move: 'CLOSE' } })).json.status).toBe('CLOSED');
      const read = await call('GET', `/monitoring-feedback/${feedbackId}`, { member: OFFICER });
      expect((read.json.history as unknown[]).length).toBe(4);
      const traces = await harness.owner<{ text: string }>(TENANT_A, [[`select (select coalesce(string_agg(safe_diff::text || coalesce(reason, ''), ' '), '') from machvon.audit_event where resource_id = $1) || (select coalesce(string_agg(payload::text, ' '), '') from machvon.outbox_event where aggregate_id = $1) as text`, [feedbackId]]]);
      expect(traces[0]?.text).not.toContain('spoil');
    });

    it('closes the file once no feedback is open, and shows nothing to another tenant', async () => {
      const read = await call('GET', `/monitoring-files/${fileId}`, { member: OFFICER });
      expect((await call('POST', `/monitoring-files/${fileId}/close`, { member: OFFICER, ifMatch: read.json.version as number })).json.status).toBe('CLOSED');
      expect((await call('POST', `/monitoring-files/${fileId}/feedback`, { member: OFFICER, body: { reference: 'PH-HTTP-2', received_on: '2026-10-02', channel: 'LETTER', topic: 'COST', summary: 'A new complaint after the file was closed by the board.' } })).json.code).toBe('MONITORING_FILE_CLOSED');
      expect(items(await call('GET', '/monitoring-files', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
      expect((await call('GET', `/monitoring-files/${fileId}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
    });
  });

  describe('document transmittal (G4-11)', () => {
    let first = '';
    let second = '';
    let transmittalId = '';
    it('registers containers, refuses to share without a transmittal, sends one for review that shares them', async () => {
      first = (await call('POST', '/doc-containers', { member: OFFICER, body: { project_id: PROJECT, document_id: DOC, document_kind: 'DOCUMENT', revision_label: 'A' } })).json.resource_id as string;
      second = (await call('POST', '/doc-containers', { member: OFFICER, body: { project_id: PROJECT, document_id: DOC2, document_kind: 'DOCUMENT', revision_label: 'A' } })).json.resource_id as string;
      expect((await call('POST', `/doc-containers/${first}/move`, { member: OFFICER, ifMatch: 1, body: { to: 'SHARED' } })).json.code).toBe('TRANSMITTAL_REQUIRED');
      const sent = await call('POST', '/doc-transmittals', { member: OFFICER, body: { project_id: PROJECT, number: 'TR-HTTP-1', purpose: 'FOR_REVIEW', subject: 'Design report and estimate for review', container_ids: [first, second], recipients: [{ membership_id: memberId(REVIEWER), required: true }] } });
      expect(sent).toMatchObject({ status: 200, json: { status: 'SENT' } });
      transmittalId = sent.json.resource_id as string;
      expect((await call('GET', `/doc-containers/${first}`, { member: OFFICER })).json.state).toBe('SHARED');
      const detail = await call('GET', `/doc-transmittals/${transmittalId}`, { member: OFFICER });
      expect(detail.json).toMatchObject({ review_days: 5, progress: { required: 1, answered: 0 } });
    });

    it('shows the transmittal to its recipient only through the inbox right, and lets only a recipient answer, once', async () => {
      const inbox = await call('GET', '/doc-transmittals/inbox', { member: REVIEWER });
      expect(items(inbox).map((entry) => entry.number)).toEqual(['TR-HTTP-1']);
      expect((await call('POST', `/doc-transmittals/${transmittalId}/answer`, { member: APPROVER, body: { answer: 'APPROVED' } })).status).toBe(404);
      expect((await call('POST', `/doc-transmittals/${transmittalId}/answer`, { member: REVIEWER, body: { answer: 'REJECTED' } })).status).toBe(422);
      expect((await call('POST', `/doc-transmittals/${transmittalId}/answer`, { member: REVIEWER, body: { answer: 'APPROVED_WITH_COMMENTS', comment: 'Fix the table on page four.' } })).json.status).toBe('ANSWERED');
      expect((await call('POST', `/doc-transmittals/${transmittalId}/answer`, { member: REVIEWER, body: { answer: 'APPROVED' } })).json.code).toBe('TRANSMITTAL_STATE_INVALID');
    });

    it('publishes only when the required answer is in and the publisher is not the author', async () => {
      expect((await call('POST', `/doc-containers/${first}/move`, { member: OFFICER, ifMatch: 2, body: { to: 'PUBLISHED' } })).json.code).toBe('SELF_APPROVAL_DENIED');
      expect((await call('POST', `/doc-containers/${first}/move`, { member: APPROVER, ifMatch: 2, body: { to: 'PUBLISHED' } })).json.status).toBe('PUBLISHED');
      expect((await call('POST', `/doc-containers/${first}/move`, { member: APPROVER, ifMatch: 3, body: { to: 'WIP' } })).json.code).toBe('TRANSMITTAL_STATE_INVALID');
      expect((await call('GET', `/doc-containers/${first}`, { member: OFFICER })).json.moves).toHaveLength(3);
    });

    it('moves a due day once and shows nothing to another tenant', async () => {
      const sent = await call('POST', '/doc-transmittals', { member: OFFICER, body: { project_id: PROJECT, number: 'TR-HTTP-2', purpose: 'FOR_APPROVAL', subject: 'Estimate for approval', container_ids: [second], recipients: [{ membership_id: memberId(APPROVER), required: true }] } });
      const id = sent.json.resource_id as string;
      const detail = await call('GET', `/doc-transmittals/${id}`, { member: OFFICER });
      const recipient = (detail.json.recipients as Array<{ id: string; due_on: string }>)[0] as { id: string; due_on: string };
      const later = new Date(Date.parse(`${recipient.due_on}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
      expect((await call('POST', `/doc-transmittals/${id}/extension`, { member: REVIEWER, body: { recipient_id: recipient.id, due_on: later, reason: 'Site visit needed' } })).status).toBe(403);
      expect((await call('POST', `/doc-transmittals/${id}/extension`, { member: OFFICER, body: { recipient_id: recipient.id, due_on: later, reason: 'Site visit needed first' } })).json.status).toBe('EXTENDED');
      expect((await call('POST', `/doc-transmittals/${id}/extension`, { member: OFFICER, body: { recipient_id: recipient.id, due_on: later, reason: 'Once more please' } })).json.code).toBe('TRANSMITTAL_STATE_INVALID');
      expect(items(await call('GET', '/doc-transmittals', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
      expect((await call('GET', `/doc-transmittals/${id}`, { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(404);
    });
  });

  describe('public portal (G4-9)', () => {
    const settings = { expected_version: 0, slug: 'cao-bang', enabled: true, whistle_enabled: true, title: 'Public investment of Cao Bang', publisher_name: 'Provincial Board', id_prefix: 'VN-CB', license_uri: 'https://example.org/license', policy_uri: 'https://example.org/policy' };
    const publish = { project_id: PROJECT, summary: 'A road of 12 km that joins two communes.', sector: 'transport.road', project_type: 'construction', purpose: 'economic' };

    it('keeps the settings for whole-tenant rights only, and one address for one tenant', async () => {
      expect((await call('POST', '/portal/settings', { member: NOBODY, body: settings })).status).toBe(403);
      expect((await call('POST', '/portal/records', { member: ADMIN, body: publish })).json.code).toBe('PORTAL_NOT_CONFIGURED');
      expect((await call('POST', '/portal/settings', { member: ADMIN, body: settings })).json.status).toBe('ENABLED');
      expect((await call('POST', '/portal/settings', { member: B_ADMIN, tenantId: TENANT_B, body: settings })).json.code).toBe('PORTAL_SLUG_TAKEN');
      expect((await call('POST', '/portal/settings', { member: ADMIN, body: { ...settings, slug: 'Bad Slug' } })).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', '/portal/settings', { member: ADMIN })).json).toMatchObject({ settings: { slug: 'cao-bang', policy_rule_version: 0 }, rule: { unverified: true } });
    });

    it('publishes a public project and refuses a confidential one', async () => {
      expect((await call('POST', '/portal/records', { member: ADMIN, body: { ...publish, project_id: SECRET_PROJECT } })).json.code).toBe('PORTAL_NOT_PUBLISHABLE');
      expect((await call('POST', '/portal/records', { member: ADMIN, body: publish })).json.status).toBe('CREATED');
      expect((await call('POST', '/portal/records', { member: ADMIN, body: publish })).json.status).toBe('UNCHANGED');
      expect((await call('POST', '/portal/records', { member: ADMIN, body: { ...publish, summary: 'Click <b>here</b> for a surprise visit now' } })).status).toBe(422);
    });

    it('serves anybody read-only, without a token, with only the published fields and no internal id', async () => {
      const info = await publicCall('GET', '/public/portals/cao-bang');
      expect(info).toMatchObject({ status: 200, json: { title: 'Public investment of Cao Bang', record_count: 1, reports_open: true } });
      const list = await publicCall('GET', '/public/portals/cao-bang/projects');
      expect(list.status).toBe(200);
      const [entry] = list.json.items as Array<{ code: string; fields: Record<string, unknown> }>;
      expect(entry?.code).toBe('PRJ-HTTP-1');
      expect(entry?.fields).toMatchObject({ title: 'Project PRJ-HTTP-1', budget_vnd: '120000000000', sector: 'transport.road' });
      expect(list.text).not.toMatch(new RegExp(`${TENANT_A}|${PROJECT}|${memberId(ADMIN)}|classification|created_by`));
      expect((await publicCall('GET', '/public/portals/no-such-portal')).status).toBe(404);
      expect((await publicCall('GET', '/public/portals/Bad..Slug')).status).toBe(404);
      expect((await publicCall('POST', '/portal/settings', settings)).status).toBe(400);
    });

    it('exports OC4IDS that meets the required fields, in the open and in the admin view', async () => {
      const open = await publicCall('GET', '/public/portals/cao-bang/oc4ids');
      expect(open.status).toBe(200);
      expect(validateOc4idsPackage(open.json.package)).toEqual([]);
      const admin_ = await call('GET', '/portal/oc4ids', { member: ADMIN });
      expect(admin_.json).toMatchObject({ complete: true, issues: [], version: '0.9' });
    });

    it('narrows the public answer when the allow-list narrows, and says what the export now lacks', async () => {
      await admin([[`update machvon.portal_setting set allowed_fields = array['project_code','title'] where tenant_id = $1`, [TENANT_A]]]);
      const list = await publicCall('GET', '/public/portals/cao-bang/projects');
      const [entry] = list.json.items as Array<{ fields: Record<string, unknown> }>;
      expect(Object.keys(entry?.fields ?? {}).sort()).toEqual(['project_code', 'title']);
      const exported = await call('GET', '/portal/oc4ids', { member: ADMIN });
      expect(exported.json.complete).toBe(false);
      expect((exported.json.issues as Array<{ path: string }>).map((issue) => issue.path)).toContain('projects[0].budget');
      await admin([[`update machvon.portal_setting set allowed_fields = array['project_code','title','summary','status','sector','project_type','purpose','start_year','end_year','budget_vnd','authority_name','updated_on'] where tenant_id = $1`, [TENANT_A]]]);
    });

    it('limits a caller by the rate of the portal, with Retry-After, and keeps no address anywhere', async () => {
      await admin([[`update machvon.portal_setting set rate_per_minute = 3 where tenant_id = $1`, [TENANT_A]]]);
      const statuses: number[] = [];
      let limited: Awaited<ReturnType<typeof publicCall>> | undefined;
      for (let index = 0; index < 5; index += 1) {
        const reply = await publicCall('GET', '/public/portals/cao-bang');
        statuses.push(reply.status);
        if (reply.status === 429) limited = reply;
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
      await admin([[`update machvon.portal_setting set rate_per_minute = 60 where tenant_id = $1`, [TENANT_A]]]);
      const traces = await harness.owner<{ n: string }>(TENANT_A, [[`select count(*)::text as n from machvon.audit_event where safe_diff::text ~ '127\\.0\\.0\\.1|::1'`]]);
      expect(traces[0]?.n).toBe('0');
    });

    it('withdraws a record at once and restores it by publishing again', async () => {
      expect((await call('POST', `/portal/records/${PROJECT}/withdraw`, { member: ADMIN, body: { reason: 'Under review by the board' } })).json.status).toBe('WITHDRAWN');
      expect(((await publicCall('GET', '/public/portals/cao-bang/projects')).json.items as unknown[]).length).toBe(0);
      expect((await call('POST', `/portal/records/${PROJECT}/withdraw`, { member: ADMIN, body: { reason: 'Under review by the board' } })).json.code).toBe('PORTAL_RECORD_WITHDRAWN');
      expect((await call('POST', '/portal/records', { member: ADMIN, body: publish })).json.status).toBe('RESTORED');
      expect(items(await call('GET', '/portal/records', { member: ADMIN }))).toHaveLength(1);
    });
  });

  describe('anonymous report channel (G4-12)', () => {
    let code = '';
    let reportId = '';
    it('takes a report with no identity and gives the reporter a code once', async () => {
      const sent = await publicCall('POST', '/public/portals/cao-bang/reports', { category: 'PROCUREMENT_IRREGULARITY', text: 'A package was split below the threshold of open bidding by the same officer.' });
      expect(sent.status).toBe(200);
      code = sent.json.access_code as string;
      expect(code.replace(/-/g, '')).toHaveLength(32);
      expect(sent.json.shown_once).toBe(true);
      expect(sent.headers.get('cache-control')).toBe('no-store');
      expect((await publicCall('POST', '/public/portals/no-such/reports', { category: 'OTHER', text: 'Nobody listens at this address at all.' })).status).toBe(404);
      expect((await publicCall('POST', '/public/portals/cao-bang/reports', { category: 'OTHER', text: 'too short' })).status).toBeGreaterThanOrEqual(400);
      expect((await publicCall('POST', '/public/portals/cao-bang/reports', { category: 'OTHER', text: 'A report that tries to carry a name along with it.', reporter_name: 'Nguyen Van A' })).status).toBe(400);
    });

    it('lets the reporter read the status and write again with the code, and nobody else', async () => {
      const status = await publicCall('POST', '/public/portals/cao-bang/reports/status', { access_code: code });
      expect(status).toMatchObject({ status: 200, json: { status: 'RECEIVED', category: 'PROCUREMENT_IRREGULARITY' } });
      expect(status.text).not.toMatch(new RegExp(`${TENANT_A}|${memberId(ADMIN)}`));
      expect((await publicCall('POST', '/public/portals/cao-bang/reports/status', { access_code: 'A'.repeat(32) })).status).toBe(404);
      expect((await publicCall('POST', '/public/portals/cao-bang/reports/status', { access_code: 'not a code' })).status).toBe(422);
      expect((await publicCall('POST', '/public/portals/cao-bang/reports/reply', { access_code: code, body: 'The two orders were placed on the same day.' })).status).toBe(200);
    });

    it('is handled by an auditor in order, hidden from the unit it is about, and answered through the thread', async () => {
      const list = await call('GET', '/whistle-reports', { member: ADMIN });
      expect(items(list)).toHaveLength(1);
      reportId = items(list)[0]?.id as string;
      expect((await call('GET', '/whistle-reports', { member: NOBODY })).status).toBe(403);
      expect((await call('POST', `/whistle-reports/${reportId}/move`, { member: ADMIN, ifMatch: 1, body: { move: 'ACKNOWLEDGE' } })).json.status).toBe('ACKNOWLEDGED');
      expect((await call('POST', `/whistle-reports/${reportId}/subject`, { member: ADMIN, ifMatch: 2, body: { unit_id: unitId(CHILD) } })).status).toBe(200);
      expect(items(await call('GET', '/whistle-reports', { member: CHILD_HANDLER }))).toEqual([]);
      expect((await call('GET', `/whistle-reports/${reportId}`, { member: CHILD_HANDLER })).status).toBe(404);
      expect((await call('POST', `/whistle-reports/${reportId}/reply`, { member: ADMIN, body: { body: 'Thank you. Which officer placed the orders?' } })).status).toBe(200);
      const seen = await publicCall('POST', '/public/portals/cao-bang/reports/status', { access_code: code });
      expect((seen.json.thread as Array<{ from: string }>).map((message) => message.from)).toEqual(['YOU', 'HANDLER']);
      expect((await call('POST', `/whistle-reports/${reportId}/move`, { member: ADMIN, ifMatch: 3, body: { move: 'INVESTIGATE' } })).json.status).toBe('INVESTIGATING');
      expect((await call('POST', `/whistle-reports/${reportId}/move`, { member: ADMIN, ifMatch: 4, body: { move: 'RESOLVE' } })).status).toBe(422);
      expect((await call('POST', `/whistle-reports/${reportId}/move`, { member: ADMIN, ifMatch: 4, body: { move: 'RESOLVE', note: 'The orders were merged and tendered again.' } })).json.status).toBe('RESOLVED');
      expect((await publicCall('POST', '/public/portals/cao-bang/reports/reply', { access_code: code, body: 'One more thing after the report was closed.' })).json.code).toBe('WHISTLE_STATE_INVALID');
      expect((await call('GET', '/whistle-reports/summary', { member: ADMIN })).json).toMatchObject({ total: 1, open: 0 });
    });

    it('shows the reporter the days the report was received under, not the days of the settings today (review of the lane)', async () => {
      await admin([[`update machvon.portal_setting set whistle_acknowledge_days = 30, whistle_resolve_days = 200 where tenant_id = $1`, [TENANT_A]]]);
      const seen = await publicCall('POST', '/public/portals/cao-bang/reports/status', { access_code: code });
      const handler = await call('GET', `/whistle-reports/${reportId}`, { member: ADMIN });
      expect(seen.json.acknowledge_due_on).toBe((handler.json.clock as Record<string, unknown>).acknowledge_due_on);
      expect(seen.json.resolve_due_on).toBe((handler.json.clock as Record<string, unknown>).resolve_due_on);
      await admin([[`update machvon.portal_setting set whistle_acknowledge_days = 7, whistle_resolve_days = 90 where tenant_id = $1`, [TENANT_A]]]);
    });

    it('limits what one client may send in an hour, and shows nothing to another tenant', async () => {
      await admin([[`update machvon.portal_setting set whistle_rate_per_hour = 2 where tenant_id = $1`, [TENANT_A]]]);
      const statuses: number[] = [];
      for (let index = 0; index < 3; index += 1) statuses.push((await publicCall('POST', '/public/portals/cao-bang/reports', { category: 'WASTE_OF_FUNDS', text: `A report number ${index} about the waste of funds on the bridge.` })).status);
      expect(statuses).toEqual([200, 200, 429]);
      expect(items(await call('GET', '/whistle-reports', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
    });
  });

  describe('gifts register (G4-12)', () => {
    it('declares a gift with the flags of the rule of the day, closes it by a second person, never kept above the line', async () => {
      const declared = await call('POST', '/gifts', { member: OFFICER, body: { recipient_id: memberId(OFFICER), giver_name: 'ACME Construction', giver_kind: 'CONTRACTOR', project_id: PROJECT, description: 'A basket of fruit and a bottle of wine', value_vnd: '3000000', received_on: '2020-03-01' } });
      expect(declared.json.status).toBe('DECLARED');
      const id = declared.json.resource_id as string;
      const read = items(await call('GET', '/gifts', { member: ADMIN }))[0] as { flags: Record<string, unknown> };
      expect(read.flags).toMatchObject({ late: true, needs_review: true, may_be_kept: false });
      expect((await call('POST', `/gifts/${id}/take`, { member: OFFICER, ifMatch: 1 })).json.code).toBe('SELF_APPROVAL_DENIED');
      expect((await call('POST', `/gifts/${id}/take`, { member: REVIEWER, ifMatch: 1 })).json.status).toBe('UNDER_REVIEW');
      expect((await call('POST', `/gifts/${id}/close`, { member: REVIEWER, ifMatch: 2, body: { outcome: 'KEPT', note: 'Kept with the approval of the head' } })).json.code).toBe('GIFT_OUTCOME_REFUSED');
      expect((await call('POST', `/gifts/${id}/close`, { member: REVIEWER, ifMatch: 2, body: { outcome: 'RETURNED', note: 'Returned to the giver by post' } })).json.status).toBe('CLOSED');
      expect(items(await call('GET', '/gifts', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
    });
  });

  describe('photo findings (G4-12) and investor standing (G4-10)', () => {
    it('scans the registered photos, writes each pair once, and is explained by someone who did not take the photos', async () => {
      const sha = createHash('sha256').update('same photo').digest('hex');
      const photo = (id: string, project: string, uploader: number): [string, unknown[]] => [
        `insert into machvon.site_photo (tenant_id, id, project_id, client_operation_id, object_key, file_sha256, scan_status, uploaded_by, created_by) values ($1, $2, $3, $4, $5, $6, 'CLEAN', $7, $7)`,
        [TENANT_A, id, project, randomUUID(), `tenants/${TENANT_A}/qms/${id}`, sha, memberId(uploader)],
      ];
      await admin([photo(randomUUID(), PROJECT, OFFICER), photo(randomUUID(), SECRET_PROJECT, OFFICER)]);
      expect((await call('POST', '/photo-findings/scan', { member: NOBODY })).status).toBe(403);
      expect((await call('POST', '/photo-findings/scan', { member: ADMIN })).json.status).toBe('FINISHED');
      const list = await call('GET', '/photo-findings', { member: ADMIN });
      expect(items(list)).toHaveLength(1);
      expect(items(list)[0]).toMatchObject({ kind: 'SAME_FILE_OTHER_PROJECT', is_conclusion: false });
      await call('POST', '/photo-findings/scan', { member: ADMIN });
      expect(items(await call('GET', '/photo-findings', { member: ADMIN }))).toHaveLength(1);
      const id = items(list)[0]?.id as string;
      expect((await call('POST', `/photo-findings/${id}/move`, { member: ADMIN, ifMatch: 1, body: { move: 'TAKE' } })).json.status).toBe('IN_REVIEW');
      expect((await call('POST', `/photo-findings/${id}/move`, { member: OFFICER, ifMatch: 2, body: { move: 'EXPLAIN', reason: 'The same vehicle was photographed at both sites' } })).json.code).toBe('SELF_APPROVAL_DENIED');
      expect((await call('POST', `/photo-findings/${id}/move`, { member: ADMIN, ifMatch: 2, body: { move: 'EXPLAIN', reason: 'The same vehicle was photographed at both sites on one trip' } })).json.status).toBe('EXPLAINED');
      expect(items(await call('GET', '/photo-findings', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
    });

    it('ranks the investor units by their open and late recommendations beside the disbursement ranking', async () => {
      await admin([
        [
          `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, recovered_vnd, project_id, owner_unit_id, due_on, status, created_by, updated_by) values ($1, $2, $3, 'R-HTTP-1', 'FINANCIAL_RECOVERY', 'Recover the overpaid amount', 5000000000, 1000000000, $4, $5, '2020-01-15', 'IN_PROGRESS', $6, $6)`,
          [TENANT_A, randomUUID(), randomUUID(), PROJECT, unitId(ROOT), memberId(ADMIN)],
        ],
      ]);
      const list = await call('GET', '/investor-standings', { member: ADMIN });
      expect(list.status).toBe(200);
      expect(items(list)[0]).toMatchObject({ unit_id: unitId(ROOT), follow_up_rank: 1, overdue: 1, owed_vnd: '4000000000', disbursement_rank: null });
      expect(list.json).toMatchObject({ rule: { unverified: true } });
      const profile = await call('GET', `/investor-standings/${unitId(ROOT)}`, { member: ADMIN });
      expect((profile.json.recommendations as unknown[]).length).toBe(1);
      expect((await call('GET', `/investor-standings/${unitId(CHILD)}`, { member: ADMIN })).status).toBe(404);
      expect((await call('GET', '/investor-standings', { member: NOBODY })).status).toBe(403);
      expect(items(await call('GET', '/investor-standings', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
    });
  });

  describe('period reports for the Ministry (G4-6)', () => {
    const issueId = randomUUID();
    const digest = createHash('sha256').update('XLSX:http').digest('hex');
    it('UAT-RPT-PX-01: lists the four forms for the Ministry as waiting for the official template', () => {
      const forms = REPORT_FORMS.list().filter((bundle) => bundle.receiver === 'MOF');
      expect(forms.map((bundle) => bundle.layout.code)).toEqual(['MOF-DIS-MONTHLY', 'MOF-DIS-QUARTERLY', 'MOF-DIS-WEEKLY', 'MOF-DIS-YEARLY']);
      for (const bundle of forms) expect(bundle.layout.status).toBe('PENDING_EXTERNAL');
    });

    it('refuses to deliver to the Ministry a copy that is unsigned or carries only a test signature, and shows the lock and the signature', async () => {
      await admin([
        [
          `insert into machvon.report_issue (tenant_id, id, layout_id, layout_code, layout_version, period_code, period, revision, draft_id, sha256, xlsx_sha256, xlsx_name, data_source, form_status, counts_as_accepted, prepared_by, checked_by, approved_by, issued_by)
           values ($1, $2, $3, 'MOF-DIS-MONTHLY', '2026.0', 'MONTH:2027-02', '{"kind":"MONTH","year":2027,"index":2}'::jsonb, 1, $4, $5, $5, 'a.xlsx', 'LIVE', 'READY', true, $6, $7, $8, $8)`,
          [TENANT_A, issueId, randomUUID(), randomUUID(), digest, memberId(OFFICER), memberId(REVIEWER), memberId(APPROVER)],
        ],
      ]);
      expect((await call('POST', `/report-engine/issues/${issueId}/deliveries`, { member: ADMIN, body: { receiver: 'MOF', channel: 'MANUAL' } })).json.code).toBe('REPORT_SIGNATURE_REQUIRED');
      const session = randomUUID();
      await admin([
        [`insert into machvon.report_signature_session (tenant_id, id, issue_id, provider, provider_session_ref, certificate_id, certificate_fingerprint, digest_sha256, state, started_by, expires_at) values ($1, $2, $3, 'MOCK', 'mock-1', $4, $5, $6, 'COMPLETED', $7, now() + interval '1 hour')`, [TENANT_A, session, issueId, randomUUID(), 'c'.repeat(64), digest, memberId(APPROVER)]],
        [`insert into machvon.report_issue_signature (tenant_id, id, issue_id, session_id, digest_sha256, provider, signer_membership_id, certificate_fingerprint, cms, cms_sha256, counts_for_delivery) values ($1, $2, $3, $4, $5, 'MOCK', $6, $7, $8, $9, false)`, [TENANT_A, randomUUID(), issueId, session, digest, memberId(APPROVER), 'c'.repeat(64), Buffer.from('a detached CMS of a test signature'), createHash('sha256').update(Buffer.from('a detached CMS of a test signature')).digest('hex')]],
      ]);
      expect((await call('POST', `/report-engine/issues/${issueId}/deliveries`, { member: ADMIN, body: { receiver: 'MOF', channel: 'MANUAL' } })).json.code).toBe('REPORT_SIGNATURE_REQUIRED');
      const shown = await call('GET', `/report-engine/issues/${issueId}/signature`, { member: ADMIN });
      expect(shown.json).toMatchObject({ signed: true, signature: { provider: 'MOCK', counts_for_delivery: false }, period_lock: null });
      expect(shown.json.signature_required_receivers).toEqual(['MOF']);
    });

    it('retires a signing session that ran out of time, so the signer can start again (review of the lane)', async () => {
      // The copy of the earlier test holds a test signature; this one needs a copy with none.
      await admin([['delete from machvon.report_issue_signature where issue_id = $1', [issueId]]]);
      const expired = async (): Promise<string> => {
        const id = randomUUID();
        await admin([["delete from machvon.report_signature_session where issue_id = $1 and state = 'OPEN'", [issueId]]]);
        await admin([
          [
            `insert into machvon.report_signature_session (tenant_id, id, issue_id, provider, provider_session_ref, certificate_id, certificate_fingerprint, digest_sha256, state, started_by, started_at, expires_at)
             values ($1, $2, $3, 'MOCK', 'mock-expired', $4, $5, $6, 'OPEN', $7, now() - interval '2 hours', now() - interval '1 hour')`,
            [TENANT_A, id, issueId, randomUUID(), 'c'.repeat(64), digest, memberId(APPROVER)],
          ],
        ]);
        return id;
      };
      // Completing a session that ran out of time closes it for good (the refusal is answered after the closing is committed).
      const first = await expired();
      expect((await call('POST', `/report-engine/signature-sessions/${first}/completion`, { member: APPROVER })).json.code).toBe('SIGNING_SESSION_EXPIRED');
      const rows = await harness.owner<{ state: string }>(TENANT_A, [['select state from machvon.report_signature_session where id = $1', [first]]]);
      expect(rows[0]?.state).toBe('EXPIRED');
      // An expired session no longer blocks a new start: the request goes on to the certificate (which does not exist here).
      await expired();
      expect((await call('POST', `/report-engine/issues/${issueId}/signature`, { member: APPROVER, body: { certificate_id: randomUUID() } })).json.code).toBe('CERTIFICATE_NOT_ACTIVE');
    });

    it('lets only the approver start a signature, and unlocks a period only by a second person with a reason', async () => {
      expect((await call('POST', `/report-engine/issues/${issueId}/signature`, { member: ADMIN, body: { certificate_id: randomUUID() } })).status).toBe(403);
      expect((await call('POST', `/report-engine/issues/${randomUUID()}/signature`, { member: APPROVER, body: { certificate_id: randomUUID() } })).status).toBe(404);
      expect((await call('POST', `/report-engine/signature-sessions/${randomUUID()}/completion`, { member: APPROVER })).status).toBe(404);
      const lock = randomUUID();
      await admin([[`insert into machvon.report_period_lock (tenant_id, id, layout_code, period_code, issue_id, digest_sha256, locked_by) values ($1, $2, 'MOF-DIS-MONTHLY', 'MONTH:2027-02', $3, $4, $5)`, [TENANT_A, lock, issueId, digest, memberId(APPROVER)]]]);
      const locks = await call('GET', '/report-engine/period-locks?open_only=true', { member: ADMIN });
      expect(items(locks)).toHaveLength(1);
      expect((locks.json.rule as Record<string, unknown>).unverified).toBe(true);
      expect((await call('POST', `/report-engine/period-locks/${lock}/unlock`, { member: APPROVER, ifMatch: 1, body: { reason: 'The Ministry asked for a correction of the figures' } })).json.code).toBe('SELF_APPROVAL_DENIED');
      expect((await call('POST', `/report-engine/period-locks/${lock}/unlock`, { member: ADMIN, ifMatch: 1, body: { reason: 'short reason' } })).status).toBe(422);
      expect((await call('POST', `/report-engine/period-locks/${lock}/unlock`, { member: ADMIN, ifMatch: 1, body: { reason: 'The Ministry asked for a correction of the figures' } })).json.status).toBe('UNLOCKED');
      expect(items(await call('GET', '/report-engine/period-locks?open_only=true', { member: ADMIN }))).toEqual([]);
      expect(items(await call('GET', '/report-engine/period-locks', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
    });
  });
});
