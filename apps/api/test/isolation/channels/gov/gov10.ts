import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { MEMBERSHIP_FIXTURES } from '../../suite';
import { GOV10_FIXTURES } from './gov10.fixtures';
import type { AlertFeedbackFixture, RedFlagFixture } from './gov10.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const FOREIGN_FIXTURE = GOV10_FIXTURES[FOREIGN];

/**
 * The foreign-id cases of the red flags of procurement and of the reports that an alert is wrong (GOV-10): a TNT-A user reads, takes, refers or clears a finding of TNT-B, reviews or withdraws a report of TNT-B.
 * Each command has an object of its own. The bodies are valid, so that the request reaches the lookup.
 */
export const GOV10_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getRedFlag', method: 'GET', id: FOREIGN_FIXTURE.flagRead.id },
  { operation: 'takeRedFlag', method: 'POST', id: FOREIGN_FIXTURE.flagTake.id, versioned: true },
  { operation: 'referRedFlag', method: 'POST', id: FOREIGN_FIXTURE.flagRefer.id, versioned: true, body: { reason: 'Isolation foreign referral attempt' } },
  { operation: 'proposeClearRedFlag', method: 'POST', id: FOREIGN_FIXTURE.flagPropose.id, versioned: true, body: { reason: 'Isolation foreign clearing proposal' } },
  { operation: 'confirmClearRedFlag', method: 'POST', id: FOREIGN_FIXTURE.flagConfirm.id, versioned: true },
  { operation: 'rejectClearRedFlag', method: 'POST', id: FOREIGN_FIXTURE.flagReject.id, versioned: true, body: { reason: 'Isolation foreign rejection of a clearing' } },
  { operation: 'reviewAlertFeedback', method: 'POST', id: FOREIGN_FIXTURE.feedbackReview.id, versioned: true, body: { move: 'REJECT', review_note: 'Isolation foreign review attempt' } },
  { operation: 'withdrawAlertFeedback', method: 'POST', id: FOREIGN_FIXTURE.feedbackWithdraw.id, versioned: true },
];

/** Every operation of the red flags, of the alert reports and of the alert ladder: the test role of the suite holds the permission of each. */
export const GOV10_OPERATIONS: readonly string[] = [
  'listRedFlags',
  'getRedFlag',
  'getRedFlagSummary',
  'listRedFlagIndicators',
  'scanRedFlags',
  'takeRedFlag',
  'referRedFlag',
  'proposeClearRedFlag',
  'confirmClearRedFlag',
  'rejectClearRedFlag',
  'reportAlertWrong',
  'listAlertFeedback',
  'listMyAlertFeedback',
  'getAlertFeedbackStats',
  'reviewAlertFeedback',
  'withdrawAlertFeedback',
  'getAlertClosureSummary',
  'listAlertClosures',
  'getAlertFlood',
  'listAlertStorms',
  'getAlertLadderForItem',
  'getAlertLadderKpi',
  'getAlertLadderPolicy',
  'listAlertLadderRuns',
  'listAlertEscalations',
  'getAlertCoverageReport',
  'getAlertHealth',
];

/** The tables the seed fills that the snapshot reads, and that no read of these operations changes. */
export const GOV10_SNAPSHOT_TABLES: readonly string[] = ['red_flag_finding', 'alert_feedback'];

/**
 * A finding in the state its fixture says. One in review was taken by the other member; one that waits for a confirmation was proposed by the other member, so the suite principal is the second auditor the
 * checks of the table ask for.
 */
const INSERT_FINDING = `insert into machvon.red_flag_finding
  (tenant_id, id, subject_type, subject_id, subject_code, score, band, fired, readings, not_computable, rule_versions, ranking_version, status, first_flagged_at, last_evaluated_at,
   reviewer_membership_id, review_started_at, clear_proposed_by, clear_reason)
  select $1::uuid, $2::uuid, 'PACKAGE', $3::uuid, $4::text, 40, 'MEDIUM', '[]'::jsonb, '[]'::jsonb, '{}', '{}'::jsonb, 'isolation-1', $5::text, now(), now(),
         case when $5::text = 'NEW' then null else $6::uuid end, case when $5::text = 'NEW' then null else now() end,
         case when $5::text = 'CLEAR_PROPOSED' then $6::uuid else null end, case when $5::text = 'CLEAR_PROPOSED' then 'Isolation clearing reason' else null end
   where not exists (select 1 from machvon.red_flag_finding where id = $2::uuid)`;

/** A pending report of an alert about an item of the package. A report to be reviewed is made by the other member (the reviewer is never the reporter); one to be withdrawn is the own report of the suite principal. */
const INSERT_FEEDBACK = `insert into machvon.alert_feedback
  (tenant_id, id, source, source_id, alert_type_code, severity, reporter_membership_id, reason, note, status)
  select $1::uuid, $2::uuid, 'PERMIT', $3::text, 'PERMIT_EXPIRY', 'ACTION', $4::uuid, 'OTHER', $5::text, 'PENDING'
   where not exists (select 1 from machvon.alert_feedback where id = $2::uuid)`;

export async function seedGov10(client: Client, context: SeedContext): Promise<void> {
  const fixture = GOV10_FIXTURES[context.tenant];
  const maker = MEMBERSHIP_FIXTURES[context.tenant].id;
  const flag = async (one: RedFlagFixture): Promise<void> => {
    await client.query(INSERT_FINDING, [context.tenantId, one.id, one.subjectId, one.subjectCode, one.status, maker]);
  };
  for (const one of [fixture.flagRead, fixture.flagTake, fixture.flagRefer, fixture.flagPropose, fixture.flagConfirm, fixture.flagReject]) await flag(one);
  const report = async (one: AlertFeedbackFixture, reporter: string): Promise<void> => {
    await client.query(INSERT_FEEDBACK, [context.tenantId, one.id, one.sourceId, reporter, one.note]);
  };
  await report(fixture.feedbackReview, maker);
  await report(fixture.feedbackWithdraw, context.membershipId);
}
