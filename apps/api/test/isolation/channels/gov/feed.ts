import { FEED_CONNECTOR_CODE, FEED_EXTERNAL_TYPE, FEED_LAYOUT_VERSION, FEED_SOURCE_SYSTEM } from '@machvon/kernel';
import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import { MEMBERSHIP_FIXTURES, PROJECT_FIXTURES } from '../../suite';
import { FEED_FIXTURES } from './feed.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const FOREIGN_FIXTURE = FEED_FIXTURES[FOREIGN];

/**
 * The foreign-id cases of the finance feed: the run of a feed, the two mappings of a project code and the difference with our own figures. A TNT-A user names an object of TNT-B. Each command has an object of its
 * own (the mapping that waits for its decision, the mapping in force, the open difference), so that what the owner does in the control run never takes the object of another case away. The bodies are valid, so that
 * the request reaches the lookup.
 */
export const FEED_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getFinanceFeedRun', method: 'GET', id: FOREIGN_FIXTURE.run.id },
  { operation: 'decideFinanceFeedMapping', method: 'POST', id: FOREIGN_FIXTURE.decideMapping.id, versioned: true, body: { decision: 'APPROVE', reason: 'Isolation foreign decision attempt' } },
  { operation: 'retireFinanceFeedMapping', method: 'POST', id: FOREIGN_FIXTURE.retireMapping.id, versioned: true, body: { reason: 'Isolation foreign retirement attempt' } },
  { operation: 'resolveFinanceFeedDifference', method: 'POST', id: FOREIGN_FIXTURE.difference.id, versioned: true, body: { kind: 'KEEP_OURS', reason: 'Isolation foreign resolution attempt' } },
];

/** Every operation of the finance feed: the test role of the suite holds the permission of each. */
export const FEED_OPERATIONS: readonly string[] = [
  'getFinanceFeedConnection',
  'setFinanceFeedConnectionState',
  'controlFinanceFeedGenerator',
  'listFinanceFeedRuns',
  'getFinanceFeedRun',
  'uploadFinanceFeedFile',
  'previewFinanceFeedFile',
  'importFinanceFeedFile',
  'pushFinanceFeedBatch',
  'listFinanceFeedMappings',
  'listFinanceFeedUnmapped',
  'proposeFinanceFeedMapping',
  'decideFinanceFeedMapping',
  'retireFinanceFeedMapping',
  'listFinanceFeedDifferences',
  'runFinanceFeedReconciliation',
  'resolveFinanceFeedDifference',
  'getFinanceFeedQuality',
  'getFinanceFeedFacts',
  'listFinanceFeedProjects',
];

/** The tables the seed fills that have an `id` column and that no read of these operations changes. */
export const FEED_SNAPSHOT_TABLES: readonly string[] = ['finance_feed_connection', 'finance_feed_connection_event', 'finance_feed_run', 'finance_feed_record', 'finance_feed_difference', 'master_crosswalk'];

const INSERT_CONNECTION = `insert into machvon.finance_feed_connection
  (tenant_id, id, connector_code, enabled, layout_version, state_reason, state_changed_by, state_changed_at, version, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::text, true, $4::text, $5::text, $6::uuid, now(), 2, $6::uuid, $6::uuid
   where not exists (select 1 from machvon.finance_feed_connection where tenant_id = $1::uuid and connector_code = $3::text)`;

const INSERT_CONNECTION_EVENT = `insert into machvon.finance_feed_connection_event (tenant_id, id, connection_id, action, reason, actor_id, connection_version)
  select $1::uuid, $2::uuid, $3::uuid, 'ENABLED', $4::text, $5::uuid, 2
   where not exists (select 1 from machvon.finance_feed_connection_event where id = $2::uuid)`;

/** A run of the generator and one record it wrote (no file, so no import row is needed). */
const INSERT_RUN = `insert into machvon.finance_feed_run
  (tenant_id, id, channel, kind, action, layout_version, seed, epoch, records_total, records_written, digest, imported_by)
  select $1::uuid, $2::uuid, 'GENERATOR', null, 'GENERATOR_START', $3::text, 1, 1, 1, 1, $4::text, $5::uuid
   where not exists (select 1 from machvon.finance_feed_run where id = $2::uuid)`;

const INSERT_RECORD = `insert into machvon.finance_feed_record
  (tenant_id, id, channel, epoch, run_id, kind, entity_key, business_key, as_of, feed_project_code, layout_version, row_hash, record, applied_by)
  select $1::uuid, $2::uuid, 'GENERATOR', 1, $3::uuid, 'PROJECT', $4::text, $5::text, date '2026-01-10', $4::text, $6::text, $7::text, $8::jsonb, $9::uuid
   where not exists (select 1 from machvon.finance_feed_record where id = $2::uuid)`;

/** A mapping of a project code of the feed to a project of ours; one in force has a checker who is not its maker, a reason and the time of the approval (the checks of the table). */
const INSERT_MAPPING = `insert into machvon.master_crosswalk
  (tenant_id, id, master_record_id, subject_type, subject_id, source_system, external_type, external_code, valid_from, valid_until, match_method, confidence, status, proposal_reason,
   created_by, updated_by, approved_by, approved_at, decision_reason)
  select $1::uuid, $2::uuid, null, 'PROJECT', $3::uuid, $4::text, $5::text, $6::text, date '2026-01-01', null, 'MANUAL', null, $7::text, $8::text,
         $9::uuid, $9::uuid, $10::uuid, $11::timestamptz, $12::text
   where not exists (select 1 from machvon.master_crosswalk where id = $2::uuid)`;

const INSERT_DIFFERENCE = `insert into machvon.finance_feed_difference
  (tenant_id, id, feed_project_code, project_id, fiscal_year, field, kind, feed_value, our_value, delta, delta_pct, large, state, owner_id, maker_ids, opened_by, opened_at, due_at)
  select $1::uuid, $2::uuid, $3::text, $4::uuid, 2026, 'DISBURSED_VS_TREASURY', 'VALUE_MISMATCH', 400000, 300000, 100000, 33.33, true, 'OPEN', $5::uuid, array[$6::uuid], $6::uuid, now(), now() + interval '7 days'
   where not exists (select 1 from machvon.finance_feed_difference where id = $2::uuid)`;

/**
 * Seeds the connection of the feed (switched on again with a reason), a run of the generator with one record, a mapping that waits for the decision of another person and one in force (each for one command; the
 * one in force carries another external type of the same system so that approving the first never meets it), and an open difference whose maker is the other member, so that the suite principal may decide,
 * retire and resolve.
 */
export async function seedFeed(client: Client, context: SeedContext): Promise<void> {
  const fixture = FEED_FIXTURES[context.tenant];
  const project = PROJECT_FIXTURES[context.tenant];
  const member = MEMBERSHIP_FIXTURES[context.tenant].id;

  await client.query(INSERT_CONNECTION, [context.tenantId, fixture.connection.id, FEED_CONNECTOR_CODE, FEED_LAYOUT_VERSION, fixture.connection.stateReason, context.membershipId]);
  await client.query(INSERT_CONNECTION_EVENT, [context.tenantId, fixture.connection.eventId, fixture.connection.id, fixture.connection.stateReason, context.membershipId]);

  await client.query(INSERT_RUN, [context.tenantId, fixture.run.id, FEED_LAYOUT_VERSION, fixture.run.digest, member]);
  await client.query(INSERT_RECORD, [
    context.tenantId,
    fixture.run.recordId,
    fixture.run.id,
    fixture.run.feedProjectCode,
    `${fixture.run.feedProjectCode}|2026-01-10`,
    FEED_LAYOUT_VERSION,
    fixture.run.digest,
    JSON.stringify({ feedProjectCode: fixture.run.feedProjectCode, asOf: '2026-01-10', projectName: fixture.run.projectName, sectorCode: 'GT', districtCode: 'D01', investorCode: 'CDT-1', investorName: null, totalInvestment: null, startYear: null, endYear: null, projectStatus: 'ACTIVE', ourProjectCode: null }),
    member,
  ]);

  // Waits for a decision: proposed by hand by the other member, nobody has decided it.
  await client.query(INSERT_MAPPING, [context.tenantId, fixture.decideMapping.id, project.id, FEED_SOURCE_SYSTEM, FEED_EXTERNAL_TYPE, fixture.decideMapping.externalCode, 'PROPOSED', fixture.decideMapping.reason, member, null, null, null]);
  // In force: proposed by the other member, approved by the suite principal, who is not its maker.
  await client.query(INSERT_MAPPING, [context.tenantId, fixture.retireMapping.id, project.id, FEED_SOURCE_SYSTEM, `${FEED_EXTERNAL_TYPE}_PREVIOUS`, fixture.retireMapping.externalCode, 'ACTIVE', fixture.retireMapping.reason, member, context.membershipId, new Date().toISOString(), fixture.retireMapping.reason]);

  await client.query(INSERT_DIFFERENCE, [context.tenantId, fixture.difference.id, fixture.difference.feedProjectCode, project.id, context.approverId, member]);
}
