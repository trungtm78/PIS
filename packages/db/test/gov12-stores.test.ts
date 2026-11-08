import { createHash, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { ControlDatabase } from '../src/control-database';
import { AuditStandingStore } from '../src/audit-standing-store';
import { DocTransmittalStore } from '../src/doc-transmittal-store';
import { GiftStore, PhotoFindingStore, WhistlePublicReads, WhistleStore } from '../src/integrity-store';
import { MonitoringStore } from '../src/monitoring-store';
import { PeriodReportStore } from '../src/period-report-store';
import { PortalPublicReads, PortalStore } from '../src/portal-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const monitoring = new MonitoringStore();
const transmittals = new DocTransmittalStore();
const portal = new PortalStore();
const whistle = new WhistleStore();
const gifts = new GiftStore();
const photos = new PhotoFindingStore();
const standing = new AuditStandingStore();
const periods = new PeriodReportStore();

const ROOT = 1;
const CHILD = 2;
const AUDITOR = 1;
const OFFICER = 2;
const SECOND = 3;
const THIRD = 4;
const CHILD_MEMBER = 5;
const TODAY = '2027-03-10';

const PROJECT = randomUUID();
const SECRET_PROJECT = randomUUID();
const DOC = randomUUID();
const DOC_VERSION = randomUUID();
const DOC_SHA = createHash('sha256').update('document body').digest('hex');
const DOC2 = randomUUID();
const DOC2_VERSION = randomUUID();
const DOC2_SHA = createHash('sha256').update('second document body').digest('hex');

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A, member = AUDITOR): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

async function admin(statements: Array<[string, unknown[]?]>, triggers = false): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // Fixtures are written with the triggers and foreign keys off; a statement that is meant to meet a guard of the database runs with them on.
    if (!triggers) await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const projectRow = (id: string, code: string, classification: string, status: string, tenant = TENANT_A): [string, unknown[]] => [
  `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group, investor_unit_id, start_year, end_year)
   values ($1, $2, $3, $4, $5, $6, $7, 120000000000, $8, 1, 'B', $5, 2025, 2027)`,
  [tenant, id, code, `Project ${code}`, unitId(ROOT), randomUUID(), classification, status],
];
const documentRows = (id: string, versionId: string, title: string, sha: string): Array<[string, unknown[]]> => [
  [
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, effect_status, current_version_id, created_by, updated_by, version) values ($1, $2, 'ATTACHMENT', 'TXT', $3, 'INTERNAL', 'PENDING', $4, $5, $5, 1)`,
    [TENANT_A, id, title, versionId, memberId(AUDITOR)],
  ],
  [
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json) values ($1, $2, $3, 1, $4, $5, 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb)`,
    [TENANT_A, versionId, id, `tenants/${TENANT_A}/doc/${id}`, sha],
  ],
];
const recommendation = (code: string, status: string, due: string | null, amount: string | null, recovered: string, project: string | null): [string, unknown[]] => [
  `insert into machvon.audit_recommendation (tenant_id, id, conclusion_id, rec_code, rec_type, description, amount_vnd, recovered_vnd, project_id, owner_unit_id, due_on, status, created_by, updated_by, submitted_by, verified_by, verified_at, dispute_reason, dispute_document_id, disputed_by)
   values ($1, $2, $3, $4, $5, 'Do what the audit asks', $6, $7, $8, $9, $10::date, $11, $12, $12, $13, $14, $15, $16, $17, $18)`,
  [TENANT_A, randomUUID(), randomUUID(), code, amount === null ? 'PROCESS_CORRECTION' : 'FINANCIAL_RECOVERY', amount, recovered, project, unitId(ROOT), due, status, memberId(AUDITOR), status === 'CLOSED' ? memberId(OFFICER) : null, status === 'CLOSED' ? memberId(SECOND) : null, status === 'CLOSED' ? '2027-02-01T00:00:00Z' : null, status === 'DISPUTED' ? 'The unit disputes the amount' : null, status === 'DISPUTED' ? randomUUID() : null, status === 'DISPUTED' ? memberId(OFFICER) : null],
];
const photoRow = (id: string, project: string, sha: string, uploader: number, extra: { at?: string; lat?: number; lng?: number } = {}): [string, unknown[]] => [
  `insert into machvon.site_photo (tenant_id, id, project_id, client_operation_id, object_key, file_sha256, scan_status, taken_at_exif, gps_lat, gps_lng, gps_source, geo_consent, uploaded_by, created_by)
   values ($1, $2, $3, $4, $5, $6, 'CLEAN', $7::timestamptz, $8, $9, $10, $11, $12, $12)`,
  [TENANT_A, id, project, randomUUID(), `tenants/${TENANT_A}/qms/${id}`, sha, extra.at ?? null, extra.lat ?? null, extra.lng ?? null, extra.lat === undefined ? 'NONE' : 'DEVICE_AT_CAPTURE', extra.lat !== undefined, memberId(uploader)],
];

describe('GOV-12 stores', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }, { n: CHILD, path: `/${unitId(ROOT)}/${unitId(CHILD)}/`, parent: ROOT }]);
      for (const member of [AUDITOR, OFFICER, SECOND, THIRD]) await harness.seedMembership(tenant, member, ROOT);
      await harness.seedMembership(tenant, CHILD_MEMBER, CHILD);
    }
    await admin([
      ["insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ('00000000-0000-4000-8000-0000000000e1', 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active') on conflict do nothing"],
      ...[[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b']].map(([id, code]): [string, unknown[]] => ["insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', '00000000-0000-4000-8000-0000000000e1', 'vn-north') on conflict (id) do nothing", [id, code]]),
    ]);
    await admin([projectRow(PROJECT, 'PRJ-G12-1', 'PUBLIC', 'IMPLEMENTATION'), projectRow(SECRET_PROJECT, 'PRJ-G12-2', 'CONFIDENTIAL', 'IMPLEMENTATION'), ...documentRows(DOC, DOC_VERSION, 'Design report', DOC_SHA), ...documentRows(DOC2, DOC2_VERSION, 'Estimate', DOC2_SHA)]);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('community monitoring file (G4-8)', () => {
    let fileId = '';
    it('opens one file for a project and fixes the days of the rule when the trigger is set', async () => {
      const first = await as((tx) => monitoring.openFile(tx, PROJECT, memberId(OFFICER)), TENANT_A, OFFICER);
      const again = await as((tx) => monitoring.openFile(tx, PROJECT, memberId(OFFICER)), TENANT_A, OFFICER);
      expect(first.created).toBe(true);
      expect(again).toMatchObject({ created: false, file: { id: first.file.id } });
      fileId = first.file.id;
      await expect(as((tx) => monitoring.setTrigger(tx, fileId, 2, { kind: 'WORKS_START', on: '2027-01-01', reason: null }, TODAY))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(as((tx) => monitoring.setTrigger(tx, fileId, 1, { kind: 'MANUAL', on: '2027-01-01', reason: 'x' }, TODAY))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const set = await as((tx) => monitoring.setTrigger(tx, fileId, 1, { kind: 'WORKS_START', on: '2027-01-01', reason: null }, TODAY));
      expect(set).toMatchObject({ triggerKind: 'WORKS_START', triggerOn: '2027-01-01', noticeDays: 45, noticeRuleVersion: 0, version: 2 });
      await expect(as((tx) => monitoring.setTrigger(tx, fileId, 2, { kind: 'WORKS_START', on: '2027-01-02', reason: null }, TODAY))).rejects.toMatchObject({ code: 'MONITORING_TRIGGER_SET' });
      expect(monitoring.noticeOf(set, TODAY)).toMatchObject({ state: 'OVERDUE', dueOn: '2027-02-15', daysLeft: -23 });
    });

    it('does not move a running deadline when the rule changes, and the database keeps the trigger as it was', async () => {
      await admin([[`update machvon.monitoring_file set notice_days = notice_days where id = $1`, [fileId]]]);
      await expect(admin([[`update machvon.monitoring_file set trigger_on = '2027-02-01' where id = $1`, [fileId]]], true)).rejects.toThrow(/not changed/);
      const reading = await as((tx) => monitoring.reading(tx, fileId, TODAY));
      expect(reading?.notice.dueOn).toBe('2027-02-15');
    });

    it('needs the required documents before the notice goes, links documents by id, and sends it once', async () => {
      await expect(as((tx) => monitoring.sendNotice(tx, fileId, 2, { sentOn: '2027-02-10', note: null }, memberId(OFFICER), TODAY), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'MONITORING_PACK_INCOMPLETE' });
      const item = await as((tx) => monitoring.addItem(tx, fileId, { item: 'NOTICE_TEXT', documentId: DOC, documentKind: 'DOCUMENT' }, memberId(OFFICER)), TENANT_A, OFFICER);
      expect(item).toMatchObject({ title: 'Design report', sha256: DOC_SHA });
      await expect(as((tx) => monitoring.addItem(tx, fileId, { item: 'NOTICE_TEXT', documentId: DOC, documentKind: 'DOCUMENT' }, memberId(OFFICER)))).rejects.toMatchObject({ code: 'MONITORING_PACK_DUPLICATE' });
      await expect(as((tx) => monitoring.addItem(tx, fileId, { item: 'PROJECT_INFO', documentId: randomUUID(), documentKind: 'DOCUMENT' }, memberId(OFFICER)))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await as((tx) => monitoring.addItem(tx, fileId, { item: 'PROJECT_INFO', documentId: DOC2, documentKind: 'DOCUMENT' }, memberId(OFFICER)));
      await as((tx) => monitoring.addItem(tx, fileId, { item: 'PLAN_SCHEDULE', documentId: DOC2, documentKind: 'DOCUMENT' }, memberId(OFFICER)));
      const sent = await as((tx) => monitoring.sendNotice(tx, fileId, 2, { sentOn: '2027-02-20', note: 'Posted at the commune hall' }, memberId(OFFICER), TODAY), TENANT_A, OFFICER);
      expect(sent.notice).toMatchObject({ state: 'SENT_LATE', daysLate: 5 });
      await expect(as((tx) => monitoring.sendNotice(tx, fileId, 3, { sentOn: '2027-02-21', note: null }, memberId(OFFICER), TODAY))).rejects.toMatchObject({ code: 'MONITORING_NOTICE_ALREADY_SENT' });
      await expect(admin([[`update machvon.monitoring_file set notice_sent_on = '2027-02-01' where id = $1`, [fileId]]], true)).rejects.toThrow(/sent notice/);
    });

    it('runs a feedback from receipt to a closed answer, with the closer a different person', async () => {
      const logged = await as((tx) => monitoring.logFeedback(tx, fileId, { reference: 'PH-001', receivedOn: '2027-03-01', channel: 'MEETING', topic: 'LAND', fromLabel: 'Hamlet 3', summary: 'The access road is blocked by spoil from the works.' }, memberId(OFFICER), TODAY), TENANT_A, OFFICER);
      expect(logged.created).toBe(true);
      expect(logged.feedback).toMatchObject({ status: 'RECEIVED', responseDays: 15, response: { state: 'NOT_DUE', dueOn: '2027-03-16' } });
      expect((await as((tx) => monitoring.logFeedback(tx, fileId, { reference: 'PH-001', receivedOn: '2027-03-01', channel: 'MEETING', topic: 'LAND', fromLabel: null, summary: 'The access road is blocked by spoil from the works.' }, memberId(OFFICER), TODAY), TENANT_A, OFFICER)).created).toBe(false);
      const id = logged.feedback.id;
      await as((tx) => monitoring.moveFeedback(tx, id, 1, 'TAKE', memberId(OFFICER), { text: null }, TODAY), TENANT_A, OFFICER);
      await expect(as((tx) => monitoring.moveFeedback(tx, id, 2, 'RESPOND', memberId(OFFICER), { text: 'short' }, TODAY), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const answered = await as((tx) => monitoring.moveFeedback(tx, id, 2, 'RESPOND', memberId(OFFICER), { text: 'The spoil is moved by 15 March and the road reopened.' }, TODAY), TENANT_A, OFFICER);
      expect(answered).toMatchObject({ status: 'RESPONDED', respondedOn: TODAY, response: { state: 'ON_TIME' } });
      await expect(as((tx) => monitoring.moveFeedback(tx, id, 3, 'CLOSE', memberId(OFFICER), { text: null }, TODAY), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      const closed = await as((tx) => monitoring.moveFeedback(tx, id, 3, 'CLOSE', memberId(SECOND), { text: null }, TODAY), TENANT_A, SECOND);
      expect(closed.status).toBe('CLOSED');
      expect((await as((tx) => monitoring.events(tx, id))).map((event) => event.move)).toEqual(['RECEIVED', 'TAKE', 'RESPOND', 'CLOSE']);
      await expect(admin([[`update machvon.monitoring_feedback set summary = 'changed words of the community' where id = $1`, [id]]], true)).rejects.toThrow(/not changed/);
    });

    it('keeps the clock of a feedback on the days it was received under, and lists the open ones as overdue', async () => {
      await as((tx) => monitoring.logFeedback(tx, fileId, { reference: 'PH-002', receivedOn: '2027-02-01', channel: 'LETTER', topic: 'QUALITY', fromLabel: null, summary: 'Cracks have appeared in the new drain near the school.' }, memberId(OFFICER), TODAY), TENANT_A, OFFICER);
      const list = await as((tx) => monitoring.list(tx, { limit: 10, offset: 0 }, TODAY));
      expect(list).toHaveLength(1);
      expect(list[0]?.summary).toMatchObject({ feedbackTotal: 2, open: 1, overdue: 1 });
      const current = (await as((tx) => monitoring.find(tx, fileId))) as NonNullable<Awaited<ReturnType<MonitoringStore['find']>>>;
      await expect(as((tx) => monitoring.close(tx, fileId, current.version, memberId(AUDITOR)))).rejects.toMatchObject({ code: 'MONITORING_FEEDBACK_OPEN' });
    });

    it('does not let a feedback be reopened on a closed file, where it would be stuck (review of the lane)', async () => {
      const open = (await as((tx) => monitoring.feedbackOf(tx, fileId, TODAY))).find((entry) => entry.reference === 'PH-002') as NonNullable<Awaited<ReturnType<MonitoringStore['getFeedback']>>>;
      await as((tx) => monitoring.moveFeedback(tx, open.id, open.version, 'DECLINE', memberId(OFFICER), { text: 'Not a matter of this project' }, TODAY), TENANT_A, OFFICER);
      const file = (await as((tx) => monitoring.find(tx, fileId))) as NonNullable<Awaited<ReturnType<MonitoringStore['find']>>>;
      await as((tx) => monitoring.close(tx, fileId, file.version, memberId(AUDITOR)));
      const first = (await as((tx) => monitoring.feedbackOf(tx, fileId, TODAY))).find((entry) => entry.reference === 'PH-001') as NonNullable<Awaited<ReturnType<MonitoringStore['getFeedback']>>>;
      await expect(as((tx) => monitoring.moveFeedback(tx, first.id, first.version, 'REOPEN', memberId(AUDITOR), { text: 'We want to hear it again' }, TODAY))).rejects.toMatchObject({ code: 'MONITORING_FILE_CLOSED' });
    });

    it('shows nothing of another tenant', async () => {
      expect(await as((tx) => monitoring.list(tx, { limit: 10, offset: 0 }, TODAY), TENANT_B)).toEqual([]);
      expect(await as((tx) => monitoring.find(tx, fileId), TENANT_B)).toBeUndefined();
    });
  });

  describe('document transmittal (G4-11)', () => {
    let container1 = '';
    let container2 = '';
    let transmittalId = '';
    it('registers a document as a container in WIP, once for a revision', async () => {
      const one = await as((tx) => transmittals.registerContainer(tx, { projectId: PROJECT, documentId: DOC, documentKind: 'DOCUMENT', revisionLabel: 'A' }, memberId(OFFICER)), TENANT_A, OFFICER);
      const two = await as((tx) => transmittals.registerContainer(tx, { projectId: PROJECT, documentId: DOC2, documentKind: 'DOCUMENT', revisionLabel: 'A' }, memberId(OFFICER)), TENANT_A, OFFICER);
      expect(one.container).toMatchObject({ state: 'WIP', title: 'Design report', contentSha256: DOC_SHA, version: 1 });
      expect((await as((tx) => transmittals.registerContainer(tx, { projectId: PROJECT, documentId: DOC, documentKind: 'DOCUMENT', revisionLabel: 'A' }, memberId(OFFICER)), TENANT_A, OFFICER)).created).toBe(false);
      container1 = one.container.id;
      container2 = two.container.id;
      await expect(as((tx) => transmittals.registerContainer(tx, { projectId: PROJECT, documentId: randomUUID(), documentKind: 'DOCUMENT', revisionLabel: 'A' }, memberId(OFFICER)))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('will not share or publish by hand without a transmittal', async () => {
      await expect(as((tx) => transmittals.moveContainer(tx, container1, 1, 'SHARED', memberId(OFFICER), null, TODAY), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'TRANSMITTAL_REQUIRED' });
    });

    it('sends a transmittal for review: due days from the rule, the container is shared, the hash is what the recipient saw', async () => {
      const sent = await as(
        (tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0001', purpose: 'FOR_REVIEW', subject: 'Design report for review', message: null, containerIds: [container1, container2], recipients: [{ membershipId: memberId(SECOND), required: true }, { membershipId: memberId(THIRD), required: false }], supersedesId: null }, memberId(OFFICER), TODAY),
        TENANT_A,
        OFFICER,
      );
      transmittalId = sent.transmittal.id;
      expect(sent.transmittal).toMatchObject({ number: 'TR-0001', reviewDays: 5, sentOn: TODAY });
      expect(sent.items.map((item) => item.contentSha256).sort()).toEqual([DOC_SHA, DOC2_SHA].sort());
      expect(sent.recipients.find((entry) => entry.recipientId === memberId(SECOND))).toMatchObject({ required: true, dueOn: '2027-03-15', review: { state: 'WAITING' } });
      expect(sent.progress).toMatchObject({ required: 1, answered: 0, allRequiredAnswered: false });
      expect((await as((tx) => transmittals.findContainer(tx, container1)))?.state).toBe('SHARED');
      expect((await as((tx) => transmittals.moves(tx, container1))).map((move) => move.toState)).toEqual(['WIP', 'SHARED']);
      await expect(as((tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0001', purpose: 'FOR_REVIEW', subject: 'Again', message: null, containerIds: [container1], recipients: [{ membershipId: memberId(SECOND), required: true }], supersedesId: null }, memberId(OFFICER), TODAY))).rejects.toThrow();
    });

    it('lets only a recipient answer, once; a non-recipient is told it does not exist', async () => {
      await expect(as((tx) => transmittals.answer(tx, transmittalId, memberId(AUDITOR), { answer: 'APPROVED', comment: null }, TODAY), TENANT_A, AUDITOR)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await expect(as((tx) => transmittals.answer(tx, transmittalId, memberId(SECOND), { answer: 'REJECTED', comment: null }, TODAY), TENANT_A, SECOND)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const inbox = await as((tx) => transmittals.inbox(tx, memberId(SECOND), TODAY), TENANT_A, SECOND);
      expect(inbox).toHaveLength(1);
      const answered = await as((tx) => transmittals.answer(tx, transmittalId, memberId(SECOND), { answer: 'APPROVED_WITH_COMMENTS', comment: 'Fix the table on page 4 before publishing.' }, TODAY), TENANT_A, SECOND);
      expect(answered.progress).toMatchObject({ allRequiredAnswered: true, approved: 1, rejected: 0 });
      await expect(as((tx) => transmittals.answer(tx, transmittalId, memberId(SECOND), { answer: 'APPROVED', comment: null }, TODAY), TENANT_A, SECOND)).rejects.toMatchObject({ code: 'TRANSMITTAL_STATE_INVALID' });
      await expect(admin([[`update machvon.doc_transmittal_recipient set answer = 'REJECTED' where transmittal_id = $1 and recipient_membership_id = $2`, [transmittalId, memberId(SECOND)]]], true)).rejects.toThrow(/given once/);
    });

    it('publishes only after every required answer is in, and not by the author', async () => {
      await expect(as((tx) => transmittals.moveContainer(tx, container1, 2, 'PUBLISHED', memberId(OFFICER), null, TODAY), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      const published = await as((tx) => transmittals.moveContainer(tx, container1, 2, 'PUBLISHED', memberId(AUDITOR), null, TODAY));
      expect(published.state).toBe('PUBLISHED');
      await expect(as((tx) => transmittals.moveContainer(tx, container2, 2, 'PUBLISHED', memberId(AUDITOR), null, TODAY))).resolves.toMatchObject({ state: 'PUBLISHED' });
      await expect(as((tx) => transmittals.moveContainer(tx, container1, 3, 'WIP', memberId(AUDITOR), 'Back to work please', TODAY))).rejects.toMatchObject({ code: 'TRANSMITTAL_STATE_INVALID' });
      await expect(admin([[`update machvon.doc_container set state = 'WIP' where id = $1`, [container1]]], true)).rejects.toThrow(/does not go from/);
    });

    it('moves a due day once, forward, with a reason; the old transmittal is superseded by the new one', async () => {
      const second = await as(
        (tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0002', purpose: 'FOR_APPROVAL', subject: 'Estimate for approval', message: 'Please decide', containerIds: [container2], recipients: [{ membershipId: memberId(THIRD), required: true }], supersedesId: null }, memberId(OFFICER), TODAY),
        TENANT_A,
        OFFICER,
      );
      const recipient = second.recipients[0] as NonNullable<(typeof second.recipients)[number]>;
      expect(recipient.dueOn).toBe('2027-03-20');
      await expect(as((tx) => transmittals.extend(tx, second.transmittal.id, recipient.id, '2027-03-25', 'The estimate needs a site visit', memberId(SECOND), TODAY), TENANT_A, SECOND)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      const extended = await as((tx) => transmittals.extend(tx, second.transmittal.id, recipient.id, '2027-03-25', 'The estimate needs a site visit', memberId(OFFICER), TODAY), TENANT_A, OFFICER);
      expect(extended.recipients[0]).toMatchObject({ dueOn: '2027-03-20', extendedDueOn: '2027-03-25', review: { dueOn: '2027-03-25' } });
      await expect(as((tx) => transmittals.extend(tx, second.transmittal.id, recipient.id, '2027-03-28', 'Once more please', memberId(OFFICER), TODAY), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'TRANSMITTAL_STATE_INVALID' });
      const replacement = await as(
        (tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0003', purpose: 'FOR_APPROVAL', subject: 'Estimate for approval (corrected)', message: null, containerIds: [container2], recipients: [{ membershipId: memberId(THIRD), required: true }], supersedesId: second.transmittal.id }, memberId(OFFICER), TODAY),
        TENANT_A,
        OFFICER,
      );
      expect(replacement.transmittal.supersedesId).toBe(second.transmittal.id);
      expect((await as((tx) => transmittals.read(tx, second.transmittal.id, TODAY)))?.transmittal.supersededById).toBe(replacement.transmittal.id);
      await expect(as((tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0004', purpose: 'FOR_APPROVAL', subject: 'Again corrected', message: null, containerIds: [container2], recipients: [{ membershipId: memberId(THIRD), required: true }], supersedesId: second.transmittal.id }, memberId(OFFICER), TODAY))).rejects.toMatchObject({ code: 'TRANSMITTAL_STATE_INVALID' });
      expect(await as((tx) => transmittals.overdue(tx, '2027-04-01'))).toBe(1);
    });

    it('judges a container by the LATEST transmittal that carried it, not by an older approval on the same day (review of the lane)', async () => {
      const fresh = await as((tx) => transmittals.registerContainer(tx, { projectId: PROJECT, documentId: DOC, documentKind: 'DOCUMENT', revisionLabel: 'C' }, memberId(OFFICER)), TENANT_A, OFFICER);
      const first = await as((tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0010', purpose: 'FOR_REVIEW', subject: 'First review of revision C', message: null, containerIds: [fresh.container.id], recipients: [{ membershipId: memberId(SECOND), required: true }], supersedesId: null }, memberId(OFFICER), TODAY), TENANT_A, OFFICER);
      await as((tx) => transmittals.answer(tx, first.transmittal.id, memberId(SECOND), { answer: 'APPROVED', comment: null }, TODAY), TENANT_A, SECOND);
      await as((tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0011', purpose: 'FOR_REVIEW', subject: 'Second review of revision C', message: null, containerIds: [fresh.container.id], recipients: [{ membershipId: memberId(THIRD), required: true }], supersedesId: null }, memberId(OFFICER), TODAY), TENANT_A, OFFICER);
      const shared = (await as((tx) => transmittals.findContainer(tx, fresh.container.id))) as NonNullable<Awaited<ReturnType<DocTransmittalStore['findContainer']>>>;
      await expect(as((tx) => transmittals.moveContainer(tx, shared.id, shared.version, 'PUBLISHED', memberId(AUDITOR), null, TODAY))).rejects.toMatchObject({ code: 'TRANSMITTAL_NOT_APPROVED' });
    });

    it('does not send a document that changed since it was registered, and shows nothing of another tenant', async () => {
      await admin([[`update machvon.document_version set checksum = $2 where id = $1`, [DOC_VERSION, createHash('sha256').update('changed').digest('hex')]]]);
      const fresh = await as((tx) => transmittals.registerContainer(tx, { projectId: PROJECT, documentId: DOC, documentKind: 'DOCUMENT', revisionLabel: 'B' }, memberId(OFFICER)), TENANT_A, OFFICER);
      await admin([[`update machvon.document_version set checksum = $2 where id = $1`, [DOC_VERSION, DOC_SHA]]]);
      await expect(as((tx) => transmittals.send(tx, { projectId: PROJECT, number: 'TR-0005', purpose: 'FOR_INFORMATION', subject: 'Information only', message: null, containerIds: [fresh.container.id], recipients: [{ membershipId: memberId(SECOND), required: false }], supersedesId: null }, memberId(OFFICER), TODAY))).rejects.toMatchObject({ code: 'TRANSMITTAL_DOCUMENT_CHANGED' });
      expect(await as((tx) => transmittals.list(tx, { limit: 10, offset: 0 }), TENANT_B)).toEqual([]);
      expect(await as((tx) => transmittals.listContainers(tx, { limit: 10, offset: 0 }), TENANT_B)).toEqual([]);
    });
  });

  describe('public portal (G4-9)', () => {
    const controlPool = (): Pool => new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 2 });
    const settings = { slug: 'cao-bang', enabled: true, whistleEnabled: true, title: 'Public investment of Cao Bang', publisherName: 'Provincial Board', idPrefix: 'VN-CB', licenseUri: 'https://example.org/license', policyUri: 'https://example.org/policy' };
    const input = { summary: 'A road of 12 km that joins two communes.', sector: 'transport.road', projectType: 'construction', purpose: 'economic' };

    it('keeps the address of a portal for one tenant and copies the policy into the settings', async () => {
      await expect(as((tx) => portal.publish(tx, PROJECT, input, memberId(AUDITOR), TODAY))).rejects.toMatchObject({ code: 'PORTAL_NOT_CONFIGURED' });
      const saved = await as((tx) => portal.saveSettings(tx, settings, 0, memberId(AUDITOR), TODAY));
      expect(saved).toMatchObject({ slug: 'cao-bang', enabled: true, ratePerMinute: 60, pageSizeMax: 100, policyRuleVersion: 0 });
      expect(saved.allowedFields).toContain('project_code');
      await expect(as((tx) => portal.saveSettings(tx, { ...settings, slug: 'cao-bang' }, 0, memberId(AUDITOR), TODAY), TENANT_B)).rejects.toMatchObject({ code: 'PORTAL_SLUG_TAKEN' });
      await as((tx) => portal.saveSettings(tx, { ...settings, slug: 'tinh-b' }, 0, memberId(AUDITOR), TODAY), TENANT_B);
      await expect(as((tx) => portal.saveSettings(tx, settings, 0, memberId(AUDITOR), TODAY))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('publishes a public project cut to the allow-list and refuses a confidential one', async () => {
      await expect(as((tx) => portal.publish(tx, SECRET_PROJECT, input, memberId(AUDITOR), TODAY))).rejects.toMatchObject({ code: 'PORTAL_NOT_PUBLISHABLE' });
      const first = await as((tx) => portal.publish(tx, PROJECT, input, memberId(AUDITOR), TODAY));
      expect(first.change).toBe('CREATED');
      expect(first.record.fields).toMatchObject({ project_code: 'PRJ-G12-1', title: 'Project PRJ-G12-1', sector: 'transport.road', budget_vnd: '120000000000', authority_name: 'Unit 1' });
      expect(Object.keys(first.record.fields)).not.toContain('classification');
      expect((await as((tx) => portal.publish(tx, PROJECT, input, memberId(AUDITOR), TODAY))).change).toBe('UNCHANGED');
      const revised = await as((tx) => portal.publish(tx, PROJECT, { ...input, summary: 'A road of 12 km, now with a bridge.' }, memberId(AUDITOR), TODAY));
      expect(revised).toMatchObject({ change: 'REVISED', record: { revision: 2 } });
    });

    it('serves the public only published fields through the functions, with no tenant and no id', async () => {
      const pool = controlPool();
      try {
        const control = new ControlDatabase(pool);
        const reads = new PortalPublicReads();
        const info = await control.withControl((tx) => reads.info(tx, 'cao-bang'));
        expect(info).toMatchObject({ title: 'Public investment of Cao Bang', recordCount: 1, idPrefix: 'VN-CB' });
        const records = await control.withControl((tx) => reads.records(tx, 'cao-bang', null, 50));
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ publicCode: 'PRJ-G12-1', revision: 2 });
        expect(JSON.stringify(records)).not.toMatch(new RegExp(`${TENANT_A}|${PROJECT}|${memberId(AUDITOR)}`));
        expect(await control.withControl((tx) => reads.records(tx, 'tinh-b', null, 50))).toEqual([]);
        expect(await control.withControl((tx) => reads.info(tx, 'no-such'))).toBeUndefined();
        // The function clears the tenant it set: nothing of it is left on the connection.
        expect(await control.withControl((tx) => tx.query<{ v: string }>(`select coalesce(current_setting('app.tenant_id', true), '') as v`))).toEqual([{ v: '' }]);
      } finally {
        await pool.end();
      }
    });

    it('cuts the answer of the public function by the allow-list the settings hold today, in the database itself (review of the lane)', async () => {
      await admin([[`update machvon.portal_setting set allowed_fields = array['project_code','title'] where tenant_id = $1`, [TENANT_A]]]);
      const pool = controlPool();
      try {
        const [record] = await new ControlDatabase(pool).withControl((tx) => new PortalPublicReads().records(tx, 'cao-bang', null, 50));
        expect(Object.keys(record?.fields ?? {}).sort()).toEqual(['project_code', 'title']);
      } finally {
        await pool.end();
      }
      await admin([[`update machvon.portal_setting set allowed_fields = array['project_code','title','summary','status','project_group','sector','project_type','purpose','start_year','end_year','budget_vnd','authority_name','updated_on'] where tenant_id = $1`, [TENANT_A]]]);
    });

    it('lets the control role read nothing of the tenant tables, and the tenant role nothing of the directory', async () => {
      const pool = controlPool();
      try {
        for (const table of ['portal_record', 'whistle_report', 'whistle_message', 'portal_setting']) {
          // Either the role has no right on the table, or row-level security shows it no row: it never reads a row of a tenant.
          const rows = await pool.query(`select * from machvon.${table}`).then((result) => result.rows, () => []);
          expect(rows).toEqual([]);
        }
        const directory = await pool.query('select slug from machvon.portal_directory order by slug');
        expect(directory.rows.map((row) => row.slug)).toEqual(['cao-bang', 'tinh-b']);
      } finally {
        await pool.end();
      }
      await expect(as((tx) => tx.query('select * from machvon.portal_directory'))).rejects.toThrow();
    });

    it('withdraws a record from the public at once, restores it by publishing again, and exports OC4IDS that meets the required fields', async () => {
      await as((tx) => portal.withdraw(tx, PROJECT, 'The project is under review', memberId(AUDITOR)));
      const pool = controlPool();
      try {
        const control = new ControlDatabase(pool);
        expect(await control.withControl((tx) => new PortalPublicReads().records(tx, 'cao-bang', null, 50))).toEqual([]);
      } finally {
        await pool.end();
      }
      await expect(as((tx) => portal.withdraw(tx, PROJECT, 'The project is under review', memberId(AUDITOR)))).rejects.toMatchObject({ code: 'PORTAL_RECORD_WITHDRAWN' });
      expect((await as((tx) => portal.publish(tx, PROJECT, input, memberId(AUDITOR), TODAY))).change).toBe('RESTORED');
      const exported = await as((tx) => portal.exportOc4ids(tx, new Date('2027-03-10T00:00:00Z')));
      expect(exported?.issues).toEqual([]);
      expect(exported?.package.projects).toHaveLength(1);
      expect(exported?.package.projects[0]).toMatchObject({ id: 'VN-CB-PRJ-G12-1', status: 'implementation', publicAuthority: { name: 'Unit 1' } });
    });

    it('narrows the public answer when the allow-list narrows, without a new publication', async () => {
      await admin([[`update machvon.portal_setting set allowed_fields = array['project_code','title'] where tenant_id = $1`, [TENANT_A]]]);
      const exported = await as((tx) => portal.exportOc4ids(tx, new Date('2027-03-10T00:00:00Z')));
      expect(exported?.package.projects[0]).not.toHaveProperty('budget');
      expect(exported?.issues.map((issue) => issue.path)).toContain('projects[0].budget');
    });
  });

  describe('anonymous channel (G4-12)', () => {
    const codeHash = createHash('sha256').update('whistle-access:TESTCODE').digest('hex');
    const controlPool = (): Pool => new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 2 });

    it('takes a report with no identity, lets the reporter read and answer with the code, and keeps no address column', async () => {
      const pool = controlPool();
      try {
        const control = new ControlDatabase(pool);
        const reads = new WhistlePublicReads();
        await control.withControl((tx) => reads.submit(tx, 'cao-bang', { category: 'PROCUREMENT_IRREGULARITY', text: 'A package was split to stay under the threshold of open bidding.', codeHash, receivedOn: TODAY }, { acknowledge_days: 7, resolve_days: 90, rate_per_hour: 5 }, 0));
        await expect(control.withControl((tx) => reads.submit(tx, 'cao-bang', { category: 'PROCUREMENT_IRREGULARITY', text: 'The same code again must not be accepted twice.', codeHash, receivedOn: TODAY }, { acknowledge_days: 7, resolve_days: 90, rate_per_hour: 5 }))).rejects.toThrow();
        await expect(control.withControl((tx) => reads.submit(tx, 'no-such', { category: 'OTHER', text: 'Nobody is listening at this address at all.', codeHash: 'f'.repeat(64), receivedOn: TODAY }, { acknowledge_days: 7, resolve_days: 90, rate_per_hour: 5 }))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
        expect(await control.withControl((tx) => reads.lookup(tx, 'cao-bang', codeHash))).toMatchObject({ category: 'PROCUREMENT_IRREGULARITY', status: 'RECEIVED', receivedOn: TODAY });
        expect(await control.withControl((tx) => reads.lookup(tx, 'cao-bang', 'a'.repeat(64)))).toBeUndefined();
        expect(await control.withControl((tx) => reads.lookup(tx, 'tinh-b', codeHash))).toBeUndefined();
        await control.withControl((tx) => reads.reply(tx, 'cao-bang', codeHash, 'The two orders were placed by the same officer.', TODAY));
        expect((await control.withControl((tx) => reads.thread(tx, 'cao-bang', codeHash))).map((message) => message.sender)).toEqual(['REPORTER']);
      } finally {
        await pool.end();
      }
      const columns = await as((tx) => tx.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'machvon' and table_name in ('whistle_report', 'whistle_message')`));
      expect(columns.map((column) => column.column_name).join(' ')).not.toMatch(/(^|_)(ip|agent|address|contact|email|phone|account)(_|$)|user_id|created_at|updated_at/);
    });

    it('is handled by auditors in order, with the answer visible to the reporter, and hidden from the unit it is about', async () => {
      const [report] = await as((tx) => whistle.list(tx, { limit: 10, offset: 0 }, TODAY));
      const id = (report as NonNullable<typeof report>).id;
      expect(report).toMatchObject({ status: 'RECEIVED', clock: { acknowledgeDueOn: '2027-03-17', acknowledgeState: 'WAITING' } });
      const acknowledged = await as((tx) => whistle.move(tx, id, 1, 'ACKNOWLEDGE', memberId(AUDITOR), null, TODAY));
      expect(acknowledged).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedOn: TODAY, handlerId: memberId(AUDITOR) });
      await expect(as((tx) => whistle.move(tx, id, 2, 'RESOLVE', memberId(AUDITOR), 'Resolved after the audit of the package', TODAY))).rejects.toMatchObject({ code: 'WHISTLE_STATE_INVALID' });
      // The auditor names the unit the report is about: the people of that unit no longer see it.
      await as((tx) => whistle.assignSubject(tx, id, 2, unitId(CHILD), memberId(AUDITOR), TODAY));
      expect(await as((tx) => whistle.listFor(tx, memberId(CHILD_MEMBER), { limit: 10, offset: 0 }, TODAY), TENANT_A, CHILD_MEMBER)).toEqual([]);
      expect(await as((tx) => whistle.findFor(tx, id, memberId(CHILD_MEMBER), TODAY), TENANT_A, CHILD_MEMBER)).toBeUndefined();
      await expect(as((tx) => whistle.move(tx, id, 3, 'INVESTIGATE', memberId(CHILD_MEMBER), null, TODAY), TENANT_A, CHILD_MEMBER)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      expect(await as((tx) => whistle.listFor(tx, memberId(AUDITOR), { limit: 10, offset: 0 }, TODAY))).toHaveLength(1);
      await as((tx) => whistle.reply(tx, id, memberId(AUDITOR), 'Thank you; which officer placed the orders?', TODAY));
      const pool = controlPool();
      try {
        const thread = await new ControlDatabase(pool).withControl((tx) => new WhistlePublicReads().thread(tx, 'cao-bang', codeHash));
        expect(thread.map((message) => message.sender)).toEqual(['REPORTER', 'HANDLER']);
        expect(JSON.stringify(thread)).not.toContain(memberId(AUDITOR));
      } finally {
        await pool.end();
      }
      await as((tx) => whistle.move(tx, id, 3, 'INVESTIGATE', memberId(AUDITOR), null, TODAY));
      const resolved = await as((tx) => whistle.move(tx, id, 4, 'RESOLVE', memberId(AUDITOR), 'The orders were merged and re-tendered.', TODAY));
      expect(resolved).toMatchObject({ status: 'RESOLVED', closedOn: TODAY, publicNote: 'The orders were merged and re-tendered.' });
      expect(await as((tx) => whistle.counts(tx, TODAY))).toMatchObject({ total: 1, open: 0 });
      // The summary is made by the database over what the handler may see: the unit the report is about sees none of it.
      expect(await as((tx) => whistle.summaryFor(tx, memberId(AUDITOR), TODAY))).toEqual({ total: 1, open: 0, acknowledgeOverdue: 0, resolveOverdue: 0 });
      expect(await as((tx) => whistle.summaryFor(tx, memberId(CHILD_MEMBER), TODAY), TENANT_A, CHILD_MEMBER)).toEqual({ total: 0, open: 0, acknowledgeOverdue: 0, resolveOverdue: 0 });
      expect(await as((tx) => whistle.list(tx, { limit: 10, offset: 0 }, TODAY), TENANT_B)).toEqual([]);
    });
  });

  describe('gifts register (G4-12)', () => {
    let giftId = '';
    it('declares a gift with the flags of the rule of that day', async () => {
      const gift = await as((tx) => gifts.declare(tx, { recipientId: memberId(OFFICER), giverName: 'ACME Construction', giverKind: 'CONTRACTOR', projectId: PROJECT, description: 'A basket of fruit and a bottle of wine', valueVnd: '3000000', receivedOn: '2027-03-01' }, memberId(OFFICER), TODAY), TENANT_A, OFFICER);
      giftId = gift.id;
      expect(gift).toMatchObject({ status: 'DECLARED', valueVnd: '3000000', ruleVersion: 0, reading: { late: true, needsReview: true, mayBeKept: false, declareDueOn: '2027-03-06' } });
      await expect(as((tx) => gifts.declare(tx, { recipientId: memberId(OFFICER), giverName: 'ACME', giverKind: 'CONTRACTOR', projectId: null, description: 'A box of tea', valueVnd: '12.5', receivedOn: '2027-03-01' }, memberId(OFFICER), TODAY))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('is reviewed by a second person, never kept above the line, and closed by the reviewer with a note', async () => {
      await expect(as((tx) => gifts.take(tx, giftId, 1, memberId(OFFICER), TODAY), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      const taken = await as((tx) => gifts.take(tx, giftId, 1, memberId(SECOND), TODAY), TENANT_A, SECOND);
      expect(taken).toMatchObject({ status: 'UNDER_REVIEW', reviewerId: memberId(SECOND), version: 2 });
      await expect(as((tx) => gifts.close(tx, giftId, 2, 'KEPT', 'Kept with the approval of the head', memberId(SECOND), TODAY), TENANT_A, SECOND)).rejects.toMatchObject({ code: 'GIFT_OUTCOME_REFUSED' });
      await expect(as((tx) => gifts.close(tx, giftId, 2, 'RETURNED', 'Returned to the giver', memberId(THIRD), TODAY), TENANT_A, THIRD)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      const closed = await as((tx) => gifts.close(tx, giftId, 2, 'RETURNED', 'Returned to the giver by registered post', memberId(SECOND), TODAY), TENANT_A, SECOND);
      expect(closed).toMatchObject({ status: 'CLOSED', outcome: 'RETURNED', closedOn: TODAY });
      await expect(admin([[`update machvon.gift_register set outcome = 'KEPT' where id = $1`, [giftId]]], true)).rejects.toThrow();
      expect(await as((tx) => gifts.list(tx, { limit: 10, offset: 0 }, TODAY), TENANT_B)).toEqual([]);
    });
  });

  describe('site photo findings (G4-12)', () => {
    const shared = createHash('sha256').update('the same photo').digest('hex');
    const a1 = randomUUID();
    const a2 = randomUUID();
    const a3 = randomUUID();
    const a4 = randomUUID();
    it('finds the same file in two projects and the same place at the same moment, once', async () => {
      await admin([
        photoRow(a1, PROJECT, shared, OFFICER),
        photoRow(a2, SECRET_PROJECT, shared, SECOND),
        photoRow(a3, PROJECT, createHash('sha256').update('p3').digest('hex'), OFFICER, { at: '2027-02-10T08:00:00Z', lat: 10.8, lng: 106.7 }),
        photoRow(a4, SECRET_PROJECT, createHash('sha256').update('p4').digest('hex'), SECOND, { at: '2027-02-10T08:04:00Z', lat: 10.80005, lng: 106.70005 }),
      ]);
      const scan = await as((tx) => photos.scan(tx, TODAY));
      expect(scan).toMatchObject({ photos: 4, pairs: 2, created: 2 });
      expect((await as((tx) => photos.scan(tx, TODAY))).created).toBe(0);
      const list = await as((tx) => photos.list(tx, { limit: 10, offset: 0 }));
      expect(list.map((finding) => finding.kind).sort()).toEqual(['SAME_FILE_OTHER_PROJECT', 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT']);
      expect(list.find((finding) => finding.kind === 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT')).toMatchObject({ metres: 8, minutes: 4 });
    });

    it('is explained by a person who did not take either photo, with a reason', async () => {
      const [finding] = await as((tx) => photos.list(tx, { status: 'OPEN', limit: 10, offset: 0 }));
      const id = (finding as NonNullable<typeof finding>).id;
      await as((tx) => photos.move(tx, id, 1, 'TAKE', memberId(AUDITOR), null));
      await expect(as((tx) => photos.move(tx, id, 2, 'EXPLAIN', memberId(OFFICER), 'The same vehicle was photographed at both sites', ), TENANT_A, OFFICER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      await expect(as((tx) => photos.move(tx, id, 2, 'EXPLAIN', memberId(AUDITOR), 'short'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const explained = await as((tx) => photos.move(tx, id, 2, 'EXPLAIN', memberId(AUDITOR), 'The same vehicle was photographed at both sites on one trip'));
      expect(explained.status).toBe('EXPLAINED');
      expect((await as((tx) => photos.events(tx, id))).map((event) => event.move)).toEqual(['FLAGGED', 'TAKE', 'EXPLAIN']);
      expect(await as((tx) => photos.list(tx, { limit: 10, offset: 0 }), TENANT_B)).toEqual([]);
    });
  });

  describe('audit standing of investors (G4-10)', () => {
    it('counts the recommendations by state per investor unit and ranks the units for follow-up', async () => {
      await admin([
        recommendation('R-1', 'IN_PROGRESS', '2027-01-15', '5000000000', '1000000000', PROJECT),
        recommendation('R-2', 'DISPUTED', '2027-01-20', null, '0', PROJECT),
        recommendation('R-3', 'ASSIGNED', '2027-12-31', null, '0', null),
        recommendation('R-4', 'CLOSED', '2027-01-10', null, '0', PROJECT),
      ]);
      const reading = await as((tx) => standing.standings(tx, TODAY));
      expect(reading.policy.version).toBe(0);
      expect(reading.snapshotAsOf).toBeNull();
      expect(reading.units).toHaveLength(1);
      expect(reading.units[0]).toMatchObject({ unitId: unitId(ROOT), rank: 1, total: 4, open: 2, overdue: 1, disputed: 1, closed: 1, owedVnd: '4000000000', disbursementRank: null });
      expect(await as((tx) => standing.standings(tx, TODAY), TENANT_B)).toMatchObject({ units: [] });
    });

    it('reads the position of the unit in the latest frozen disbursement ranking beside the standing, without changing it', async () => {
      const period = randomUUID();
      const snapshot = randomUUID();
      await admin([
        [
          `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by, version)
           values ($1, $2, $3, 'PERIOD_CLOSE', '2027-03-01T00:00:00Z', '2027-03-01', '2027-03-01', 'FROZEN', 'v1', 'SIGNED', 0, $4, $5, '2027-03-02T00:00:00Z', $5, $5, 1)`,
          [TENANT_A, snapshot, period, 'a'.repeat(64), memberId(AUDITOR)],
        ],
        [
          `insert into machvon.disbursement_ranking (tenant_id, id, snapshot_id, comparison_group, unit_id, denominator_kind, plan_vnd, disbursed_vnd, rate_pct, rank, excluded_reason) values ($1, $2, $3, 'DEPARTMENT', $4, 'PM_ASSIGNED', 2000000000, 1500000000, 75.0000, 3, null)`,
          [TENANT_A, randomUUID(), snapshot, unitId(ROOT)],
        ],
      ]);
      const reading = await as((tx) => standing.standings(tx, TODAY));
      expect(reading.snapshotAsOf).toBe('2027-03-01');
      expect(reading.units[0]).toMatchObject({ rank: 1, disbursementRank: 3 });
      const profile = await as((tx) => standing.profile(tx, unitId(ROOT), TODAY));
      expect(profile?.recommendations.map((entry) => `${entry.recCode}:${entry.overdue}`)).toEqual(['R-4:false', 'R-1:true', 'R-2:false', 'R-3:false']);
      expect(await as((tx) => standing.profile(tx, unitId(CHILD), TODAY))).toBeUndefined();
    });
  });

  describe('period lock and report signature (G4-6)', () => {
    const issueId = randomUUID();
    const digest = createHash('sha256').update('XLSX:abc').digest('hex');
    it('locks the period of an issued copy once, refuses a new copy while locked, and unlocks only by a second person with a reason', async () => {
      await admin([
        [
          `insert into machvon.report_issue (tenant_id, id, layout_id, layout_code, layout_version, period_code, period, revision, draft_id, sha256, xlsx_sha256, xlsx_name, data_source, form_status, counts_as_accepted, prepared_by, checked_by, approved_by, issued_by)
           values ($1, $2, $3, 'MOF-DIS-MONTHLY', '1', 'MONTH:2027-02', '{"kind":"MONTH","year":2027,"index":2}'::jsonb, 1, $4, $5, $5, 'a.xlsx', 'LIVE', 'READY', true, $6, $7, $8, $8)`,
          [TENANT_A, issueId, randomUUID(), randomUUID(), digest, memberId(OFFICER), memberId(SECOND), memberId(THIRD)],
        ],
      ]);
      const copy = (await as((tx) => periods.issue(tx, issueId))) as NonNullable<Awaited<ReturnType<PeriodReportStore['issue']>>>;
      await as((tx) => periods.assertOpen(tx, 'MOF-DIS-MONTHLY', 'MONTH:2027-02'));
      const locked = await as((tx) => periods.lock(tx, copy, memberId(THIRD)), TENANT_A, THIRD);
      expect(locked.created).toBe(true);
      expect((await as((tx) => periods.lock(tx, copy, memberId(THIRD)), TENANT_A, THIRD)).created).toBe(false);
      await expect(as((tx) => periods.assertOpen(tx, 'MOF-DIS-MONTHLY', 'MONTH:2027-02'))).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
      await as((tx) => periods.assertOpen(tx, 'MOF-DIS-MONTHLY', 'MONTH:2027-03'));
      await expect(as((tx) => periods.unlock(tx, locked.lock.id, 1, memberId(THIRD), 'The Ministry asked for a correction', TODAY), TENANT_A, THIRD)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      await expect(as((tx) => periods.unlock(tx, locked.lock.id, 1, memberId(AUDITOR), 'short', TODAY))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const released = await as((tx) => periods.unlock(tx, locked.lock.id, 1, memberId(AUDITOR), 'The Ministry asked for a correction of the March figures', TODAY));
      expect(released).toMatchObject({ unlockedBy: memberId(AUDITOR), version: 2 });
      await as((tx) => periods.assertOpen(tx, 'MOF-DIS-MONTHLY', 'MONTH:2027-02'));
      await expect(admin([[`update machvon.report_period_lock set unlock_reason = 'edited afterwards by hand' where id = $1`, [locked.lock.id]]], true)).rejects.toThrow(/released lock/);
      expect(await as((tx) => periods.locks(tx, { openOnly: false, limit: 10, offset: 0 }), TENANT_B)).toEqual([]);
    });

    it('stores the signature of the approver over the digest of the copy, and the database refuses any other', async () => {
      const copy = (await as((tx) => periods.issue(tx, issueId))) as NonNullable<Awaited<ReturnType<PeriodReportStore['issue']>>>;
      const session = await as((tx) =>
        periods.createSession(tx, { issueId, provider: 'MOCK', providerSessionId: 'mock-1', certificateId: randomUUID(), certificateFingerprint: 'c'.repeat(64), digestSha256: copy.sha256, startedBy: memberId(THIRD), expiresAt: new Date('2027-03-10T01:00:00Z') }), TENANT_A, THIRD);
      await expect(as((tx) => periods.createSession(tx, { issueId, provider: 'MOCK', providerSessionId: 'mock-2', certificateId: randomUUID(), certificateFingerprint: 'c'.repeat(64), digestSha256: copy.sha256, startedBy: memberId(THIRD), expiresAt: new Date('2027-03-10T01:00:00Z') }), TENANT_A, THIRD)).rejects.toThrow();
      const cms = Buffer.from('a detached CMS signature of enough length');
      const base = { issueId, sessionId: session.id, provider: 'MOCK' as const, certificateFingerprint: 'c'.repeat(64), cms, cmsSha256: createHash('sha256').update(cms).digest('hex') };
      await expect(as((tx) => periods.storeSignature(tx, { ...base, digestSha256: 'e'.repeat(64), signerId: memberId(THIRD) }), TENANT_A, THIRD)).rejects.toThrow(/own copy/);
      await expect(as((tx) => periods.storeSignature(tx, { ...base, digestSha256: copy.sha256, signerId: memberId(SECOND) }), TENANT_A, SECOND)).rejects.toThrow(/approver/);
      const stored = await as((tx) => periods.storeSignature(tx, { ...base, digestSha256: copy.sha256, signerId: memberId(THIRD) }), TENANT_A, THIRD);
      expect(stored).toMatchObject({ provider: 'MOCK', countsForDelivery: false, signerId: memberId(THIRD) });
      await expect(as((tx) => periods.storeSignature(tx, { ...base, digestSha256: copy.sha256, signerId: memberId(THIRD) }), TENANT_A, THIRD)).rejects.toThrow();
      expect((await as((tx) => periods.signatureBytes(tx, issueId)))?.cms.equals(cms)).toBe(true);
      await expect(admin([[`update machvon.report_issue_signature set provider = 'REMOTE_CA' where issue_id = $1`, [issueId]]], true)).rejects.toThrow();
      expect(await as((tx) => periods.signatureOf(tx, issueId), TENANT_B)).toBeUndefined();
    });
  });
});
