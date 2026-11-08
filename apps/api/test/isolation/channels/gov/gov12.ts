import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { MEMBERSHIP_FIXTURES, PROJECT_FIXTURES, UNIT_FIXTURES } from '../../suite';
import { GOV12_FIXTURES } from './gov12.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const THEIRS = GOV12_FIXTURES[FOREIGN];
const REASON = 'Isolation foreign attempt of a user of the other tenant';

/**
 * The foreign-id cases of lane GOV-12: a TNT-A user names a monitoring file, a feedback, a pack item, a container, a transmittal, a portal record, a whistle report, a gift, a photo finding, a lock, a signature session or an
 * issued copy of TNT-B. Every command has a valid body, so the request reaches its own lookup; every one is refused (404) and changes nothing. The pack item, the container and the others each have a row of their own.
 */
export const GOV12_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getMonitoringFile', method: 'GET', id: THEIRS.fileId },
  { operation: 'getMonitoringFeedback', method: 'GET', id: THEIRS.feedbackId },
  { operation: 'setMonitoringTrigger', method: 'POST', id: THEIRS.fileId, versioned: true, body: { kind: 'WORKS_START', on: '2026-01-01' } },
  { operation: 'addMonitoringPackItem', method: 'POST', id: THEIRS.fileId, body: { item: 'PROJECT_INFO', document_id: THEIRS.containerId, document_kind: 'DOCUMENT' } },
  { operation: 'withdrawMonitoringPackItem', method: 'POST', id: THEIRS.packItemId, body: { reason: REASON } },
  { operation: 'sendMonitoringNotice', method: 'POST', id: THEIRS.fileId, versioned: true, body: { sent_on: '2026-02-01' } },
  { operation: 'closeMonitoringFile', method: 'POST', id: THEIRS.fileId, versioned: true, body: {} },
  { operation: 'logMonitoringFeedback', method: 'POST', id: THEIRS.fileId, body: { reference: 'PH-ISO-FOREIGN', received_on: '2026-02-01', channel: 'LETTER', topic: 'LAND', summary: 'A foreign attempt to log a feedback on the file of the other tenant.' } },
  { operation: 'moveMonitoringFeedback', method: 'POST', id: THEIRS.feedbackId, versioned: true, body: { move: 'TAKE' } },
  { operation: 'withdrawPortalRecord', method: 'POST', id: PROJECT_FIXTURES[FOREIGN].id, body: { reason: REASON } },
  { operation: 'getDocContainer', method: 'GET', id: THEIRS.containerId },
  { operation: 'moveDocContainer', method: 'POST', id: THEIRS.containerId, versioned: true, body: { to: 'SHARED' } },
  { operation: 'getDocTransmittal', method: 'GET', id: THEIRS.transmittalId },
  { operation: 'answerDocTransmittal', method: 'POST', id: THEIRS.transmittalId, body: { answer: 'APPROVED' } },
  { operation: 'extendDocTransmittal', method: 'POST', id: THEIRS.transmittalId, body: { recipient_id: THEIRS.recipientRowId, due_on: '2030-01-01', reason: REASON } },
  { operation: 'getWhistleReport', method: 'GET', id: THEIRS.whistleId },
  { operation: 'moveWhistleReport', method: 'POST', id: THEIRS.whistleId, versioned: true, body: { move: 'ACKNOWLEDGE' } },
  { operation: 'assignWhistleSubject', method: 'POST', id: THEIRS.whistleId, versioned: true, body: { unit_id: null } },
  { operation: 'replyToWhistleReporter', method: 'POST', id: THEIRS.whistleId, body: { body: 'A foreign reply to the reporter of the other tenant.' } },
  { operation: 'takeGiftReview', method: 'POST', id: THEIRS.giftId, versioned: true, body: {} },
  { operation: 'closeGift', method: 'POST', id: THEIRS.giftId, versioned: true, body: { outcome: 'RETURNED', note: REASON } },
  { operation: 'getPhotoFinding', method: 'GET', id: THEIRS.findingId },
  { operation: 'movePhotoFinding', method: 'POST', id: THEIRS.findingId, versioned: true, body: { move: 'TAKE' } },
  { operation: 'getInvestorProfile', method: 'GET', id: UNIT_FIXTURES[FOREIGN][0]?.id ?? THEIRS.fileId },
  { operation: 'unlockReportPeriod', method: 'POST', id: THEIRS.lockId, versioned: true, body: { reason: REASON } },
  { operation: 'getReportSignature', method: 'GET', id: THEIRS.issueId },
  { operation: 'startReportSignature', method: 'POST', id: THEIRS.issueId, body: { certificate_id: THEIRS.lockId } },
  { operation: 'completeReportSignature', method: 'POST', id: THEIRS.sessionId, body: {} },
];

/** Every operation of lane GOV-12 that a tenant user can reach (the public portal and the anonymous channel are on the control plane and have their own tests): the test role of the suite holds the permission of each. */
export const GOV12_OPERATIONS: readonly string[] = [
  'listMonitoringFiles',
  'getMonitoringFile',
  'openMonitoringFile',
  'setMonitoringTrigger',
  'addMonitoringPackItem',
  'withdrawMonitoringPackItem',
  'sendMonitoringNotice',
  'closeMonitoringFile',
  'logMonitoringFeedback',
  'moveMonitoringFeedback',
  'getMonitoringFeedback',
  'getPortalSettings',
  'savePortalSettings',
  'publishPortalRecord',
  'withdrawPortalRecord',
  'listPortalRecords',
  'exportPortalOc4ids',
  'listDocContainers',
  'getDocContainer',
  'registerDocContainer',
  'moveDocContainer',
  'listDocTransmittals',
  'getDocTransmittalInbox',
  'getDocTransmittal',
  'sendDocTransmittal',
  'answerDocTransmittal',
  'extendDocTransmittal',
  'listWhistleReports',
  'getWhistleSummary',
  'getWhistleReport',
  'moveWhistleReport',
  'assignWhistleSubject',
  'replyToWhistleReporter',
  'listGifts',
  'declareGift',
  'takeGiftReview',
  'closeGift',
  'listInvestorStandings',
  'getInvestorProfile',
  'scanPhotoFindings',
  'listPhotoFindings',
  'getPhotoFinding',
  'movePhotoFinding',
  'listReportPeriodLocks',
  'unlockReportPeriod',
  'startReportSignature',
  'completeReportSignature',
  'getReportSignature',
];

/** The tables the seeds fill that the snapshot reads, so a foreign command that changed one of them is seen. */
export const GOV12_SNAPSHOT_TABLES: readonly string[] = [
  'monitoring_file',
  'monitoring_pack_item',
  'monitoring_feedback',
  'monitoring_feedback_event',
  'doc_container',
  'doc_container_move',
  'doc_transmittal',
  'doc_transmittal_item',
  'doc_transmittal_recipient',
  'portal_setting',
  'portal_record',
  'whistle_report',
  'whistle_message',
  'gift_register',
  'photo_finding',
  'photo_finding_event',
];

const SHA = (seed: string): string => seed.repeat(64).slice(0, 64);

/** Seeds the rows of one tenant: a monitoring file with a feedback and a pack item, a container and a transmittal for information, the portal with a published record, a whistle report, a gift and a pair of photos with their finding. */
export async function seedGov12(client: Client, context: SeedContext): Promise<void> {
  const fixture = GOV12_FIXTURES[context.tenant];
  const project = PROJECT_FIXTURES[context.tenant].id;
  const member = context.membershipId;
  const tenant = context.tenantId;
  await client.query('insert into machvon.monitoring_file (tenant_id, id, project_id, created_by) values ($1, $2, $3, $4)', [tenant, fixture.fileId, project, member]);
  await client.query(
    `insert into machvon.monitoring_feedback (tenant_id, id, file_id, reference, received_on, channel, topic, summary, response_days, rule_version, created_by) values ($1, $2, $3, $4, '2026-03-01', 'MEETING', 'LAND', $5, 15, 0, $6)`,
    [tenant, fixture.feedbackId, fixture.fileId, fixture.feedbackReference, fixture.feedbackSummary, member],
  );
  await client.query(
    `insert into machvon.monitoring_pack_item (tenant_id, id, file_id, item, document_id, document_kind, title, added_by) values ($1, $2, $3, 'NOTICE_TEXT', $4, 'DOCUMENT', $5, $6)`,
    [tenant, fixture.packItemId, fixture.fileId, fixture.containerId, fixture.packItemTitle, member],
  );
  await client.query(
    `insert into machvon.doc_container (tenant_id, id, project_id, document_id, document_kind, revision_label, title, content_sha256, author_membership_id) values ($1, $2, $3, $4, 'DOCUMENT', 'A', $5, $6, $7)`,
    [tenant, fixture.containerId, project, fixture.packItemId, fixture.containerTitle, SHA('c'), member],
  );
  await client.query(
    `insert into machvon.doc_transmittal (tenant_id, id, project_id, number, purpose, subject, sent_on, sent_by, rule_version) values ($1, $2, $3, $4, 'FOR_INFORMATION', $5, '2026-03-02', $6, 0)`,
    [tenant, fixture.transmittalId, project, fixture.transmittalNumber, fixture.transmittalSubject, member],
  );
  await client.query(
    `insert into machvon.doc_transmittal_item (tenant_id, id, transmittal_id, container_id, document_id, revision_label, title, content_sha256) values ($1, $2, $3, $4, $5, 'A', $6, $7)`,
    [tenant, fixture.transmittalItemId, fixture.transmittalId, fixture.containerId, fixture.packItemId, fixture.containerTitle, SHA('c')],
  );
  await client.query(`insert into machvon.doc_transmittal_recipient (tenant_id, id, transmittal_id, recipient_membership_id, required) values ($1, $2, $3, $4, false)`, [tenant, fixture.recipientRowId, fixture.transmittalId, member]);
  await client.query(
    `insert into machvon.portal_setting (tenant_id, id, slug, enabled, whistle_enabled, title, publisher_name, id_prefix, license_uri, policy_uri, allowed_fields, updated_by)
     values ($1, $2, $3, true, true, $4, 'Isolation board', 'ISO', 'https://example.org/license', 'https://example.org/policy', array['project_code','title'], $5)`,
    [tenant, fixture.portalSettingId, fixture.portalSlug, fixture.portalTitle, member],
  );
  await client.query(`insert into machvon.portal_record (tenant_id, id, project_id, public_code, fields, fields_sha256, published_by) values ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [
    tenant,
    fixture.portalRecordId,
    project,
    PROJECT_FIXTURES[context.tenant].code,
    JSON.stringify({ project_code: PROJECT_FIXTURES[context.tenant].code, title: fixture.portalRecordTitle }),
    SHA('d'),
    member,
  ]);
  await client.query(
    `insert into machvon.whistle_report (tenant_id, id, category, body, access_code_hash, received_on, acknowledge_days, resolve_days, rule_version) values ($1, $2, 'PROCUREMENT_IRREGULARITY', $3, $4, '2026-03-03', 7, 90, 0)`,
    [tenant, fixture.whistleId, fixture.whistleBody, fixture.whistleCodeHash],
  );
  await client.query(
    `insert into machvon.gift_register (tenant_id, id, recipient_membership_id, declared_by, giver_name, giver_kind, description, value_vnd, received_on, declared_on, late, needs_review, may_be_kept, rule_version)
     values ($1, $2, $3, $3, $4, 'CONTRACTOR', 'A basket of fruit', 3000000, '2026-03-01', '2026-03-03', false, true, false, 0)`,
    [tenant, fixture.giftId, member, fixture.giftGiver],
  );
  for (const [id, key] of [[fixture.photoFirstId, 'first'], [fixture.photoSecondId, 'second']] as const) {
    await client.query(
      `insert into machvon.site_photo (tenant_id, id, project_id, client_operation_id, object_key, file_sha256, scan_status, uploaded_by, created_by) values ($1, $2, $3, $4, $5, $6, 'CLEAN', $7, $7)`,
      [tenant, id, project, fixture.photoSecondId.replace(/.$/, key === 'first' ? '1' : '2'), `tenants/${tenant}/qms/${id}`, fixture.photoSha256, MEMBERSHIP_FIXTURES[context.tenant].id],
    );
  }
  const [first, second] = fixture.photoFirstId < fixture.photoSecondId ? [fixture.photoFirstId, fixture.photoSecondId] : [fixture.photoSecondId, fixture.photoFirstId];
  await client.query(
    `insert into machvon.photo_finding (tenant_id, id, kind, first_photo_id, second_photo_id, first_project_id, second_project_id, rule_version) values ($1, $2, 'SAME_FILE_OTHER_DAY', $3, $4, $5, $5, 0)`,
    [tenant, fixture.findingId, first, second, project],
  );
}
