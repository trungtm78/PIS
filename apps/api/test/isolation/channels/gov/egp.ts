import { EGP_CONNECTOR_CODE, EGP_EXTERNAL_TYPES, EGP_LAYOUT_VERSION, EGP_POSITIONS, EGP_SOURCE_SYSTEM } from '@machvon/kernel';
import type { Client } from 'pg';
import type { ForeignAttemptSpec } from '../api';
import {
  CHANGE_FIXTURES,
  CONTRACT_FIXTURES,
  DOCUMENT_FIXTURES,
  MEMBERSHIP_FIXTURES,
  PERIOD_FIXTURES,
  PERIOD_SNAPSHOT_FIXTURES,
  PROJECT_FIXTURES,
} from '../../suite';
import { EGP_FIXTURES } from './egp.fixtures';
import type { SeedContext } from './support';

const FOREIGN = 'TNT-B';
const FOREIGN_FIXTURE = EGP_FIXTURES[FOREIGN];

/** The report of the catalogue the cases ask for: the portfolio by status is a report over the contracts of the caller. */
const REPORT_CODE = 'portfolio-status';

/**
 * The reports are addressed by the code of a report of the catalogue, not by the id of a row, and they read the tenant of the caller: TNT-A asking for one gets its own report (200), never a refusal.
 * What the case judges is that the report TNT-A is given holds nothing of TNT-B, so the report is asked for the project of TNT-B: the filter names a foreign id, and the answer has to be a page without a row.
 */
const FOREIGN_PROJECT_FILTER = `project=${PROJECT_FIXTURES[FOREIGN].id}`;

/**
 * The foreign-id cases of the e-GP connection (the run of an import and the mappings of the codes of the network), of the analytics of the contracts (the reports by code), of the availability control
 * of a contract and of a project, and of the tier of a change order with the check of the project adjustment. A TNT-A user names an object of TNT-B. Each command has an object of its own (the mapping that
 * waits for its decision, the mapping in force, the change order that is assessed), so that what the owner does in the control run never takes the object of another case away. The bodies are valid, so that
 * the request reaches the lookup.
 */
export const EGP_SPECS: readonly ForeignAttemptSpec[] = [
  { operation: 'getEgpImport', method: 'GET', id: FOREIGN_FIXTURE.run.id },
  {
    operation: 'decideEgpMapping',
    method: 'POST',
    id: FOREIGN_FIXTURE.decideMapping.id,
    versioned: true,
    body: { decision: 'APPROVE', reason: 'Isolation foreign decision attempt' },
  },
  {
    operation: 'retireEgpMapping',
    method: 'POST',
    id: FOREIGN_FIXTURE.retireMapping.id,
    versioned: true,
    body: { reason: 'Isolation foreign retirement attempt' },
  },
  { operation: 'getContractAvailability', method: 'GET', id: CONTRACT_FIXTURES[FOREIGN].id },
  { operation: 'getProjectEacControl', method: 'GET', id: PROJECT_FIXTURES[FOREIGN].id },
  { operation: 'getChangeTier', method: 'GET', id: CHANGE_FIXTURES[FOREIGN].id },
  {
    operation: 'clearChangeAdjustmentCheck',
    method: 'POST',
    id: FOREIGN_FIXTURE.changeOrder.id,
    versioned: true,
    body: { basis: 'Isolation foreign clearing attempt', decision_document_version_id: DOCUMENT_FIXTURES[FOREIGN].versionId },
  },
  { operation: 'getContractReport', method: 'GET', id: REPORT_CODE, query: FOREIGN_PROJECT_FILTER, expectedStatuses: [200, 404] },
  { operation: 'exportContractReport', method: 'GET', id: REPORT_CODE, query: `format=csv&${FOREIGN_PROJECT_FILTER}`, expectedStatuses: [200, 404] },
];

/** Every operation of the controllers of the e-GP connection, of the contract analytics and of the availability control, and the two operations of the change order that are new (the ones with an id in the path and the others). */
export const EGP_OPERATIONS: readonly string[] = [
  'setEgpConnectionState',
  'uploadEgpFile',
  'previewEgpFile',
  'importEgpFile',
  'proposeEgpMapping',
  'decideEgpMapping',
  'retireEgpMapping',
  'getEgpConnection',
  'listEgpImports',
  'getEgpImport',
  'listEgpMappings',
  'listEgpMappingSuggestions',
  'getContractPortfolio',
  'getContractReport',
  'listContractFactSnapshots',
  'exportContractReport',
  'getContractAvailability',
  'getProjectEacControl',
  'getChangeTier',
  'clearChangeAdjustmentCheck',
  'listEgpObligations',
  'openEgpObligation',
  'getEgpObligation',
  'sweepEgpObligations',
  'prepareEgpObligation',
  'submitEgpObligation',
  'receiptEgpObligation',
  'rejectEgpObligation',
  'cancelEgpObligation',
  'listEgpReconciliationItems',
  'runEgpReconciliation',
  'resolveEgpReconciliationItem',
];

/**
 * The tables the seed fills that have an `id` column and that no read of these operations changes. The connection, the run, the mappings, the refused row and the change order are the rows the foreign
 * commands aim at; the table of the checks of the project adjustment is not seeded (the clearing of the owner makes its row).
 */
export const EGP_SNAPSHOT_TABLES: readonly string[] = [
  'egp_connection',
  'egp_connection_event',
  'file_import',
  'file_import_row',
  'file_import_quarantine',
  'egp_record',
  'master_crosswalk',
  'procurement_package',
  'contract_fact_snapshot',
  'change_request',
];

const INSERT_CONNECTION = `insert into machvon.egp_connection
  (tenant_id, id, connector_code, enabled, layout_version, state_reason, state_changed_by, state_changed_at, version, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::text, true, $4::text, $5::text, $6::uuid, now(), 2, $6::uuid, $6::uuid
   where not exists (select 1 from machvon.egp_connection where tenant_id = $1::uuid and connector_code = $3::text)`;

/** The history of the connection: it was created (version 1) and switched on again with a reason (version 2). */
const INSERT_CONNECTION_EVENT = `insert into machvon.egp_connection_event (tenant_id, id, connection_id, action, reason, actor_id, connection_version)
  select $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::uuid, $7::bigint
   where not exists (select 1 from machvon.egp_connection_event where id = $2::uuid)`;

/** A package of ours with a title and a price, so that the package the file names is suggested for it (the title and the price are the ones of the record). */
const INSERT_PACKAGE = `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title)
  select $1::uuid, $2::uuid, $3::uuid, $4::text, $5::numeric, 'OPEN', 1, 'AWARDED', $6::text
   where not exists (select 1 from machvon.procurement_package where id = $2::uuid)`;

/** A file of the plans that was applied: two rows, one taken and one refused. */
const INSERT_RUN = `insert into machvon.file_import
  (tenant_id, id, connector_code, format_version, file_sha256, file_object_key, status, rows_total, rows_applied, rows_duplicate, rows_conflict, rows_quarantined, differences_opened, imported_by, completed_at)
  select $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, 'APPLIED', 2, 1, 0, 0, 1, 0, $7::uuid, now()
   where not exists (select 1 from machvon.file_import where id = $2::uuid)`;

const INSERT_CLAIM = `insert into machvon.file_import_row (tenant_id, id, connector_code, business_key, row_hash, measure, first_import_id, first_line)
  select $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::numeric, $7::uuid, 1
   where not exists (select 1 from machvon.file_import_row where id = $2::uuid)`;

/** The typed record of the taken row: what suggestions are made from (the package of the network, its name, its price and the plan). */
const INSERT_RECORD = `insert into machvon.egp_record (tenant_id, id, kind, business_key, layout_version, import_id, line, row_hash, record, applied_by)
  select $1::uuid, $2::uuid, 'KHLCNT', $3::text, $4::text, $5::uuid, 1, $6::text, $7::jsonb, $8::uuid
   where not exists (select 1 from machvon.egp_record where id = $2::uuid)`;

const INSERT_REFUSED_ROW = `insert into machvon.file_import_quarantine (tenant_id, id, import_id, line, business_key, error_code, field, row_hash, masked_preview)
  select $1::uuid, $2::uuid, $3::uuid, 2, $4::text, 'EGP_PRICE_INVALID', 'estimated_price', $5::text, jsonb_build_object('package_name', $6::text)
   where not exists (select 1 from machvon.file_import_quarantine where id = $2::uuid)`;

/**
 * A mapping of a code of the network to a row of ours. One that waits for its decision has no checker; one in force has a checker who is not its maker, a reason and the time of the approval (the
 * checks of the table).
 */
const INSERT_MAPPING = `insert into machvon.master_crosswalk
  (tenant_id, id, master_record_id, subject_type, subject_id, source_system, external_type, external_code, valid_from, valid_until, match_method, confidence, status, proposal_reason, import_id,
   created_by, updated_by, approved_by, approved_at, decision_reason)
  select $1::uuid, $2::uuid, null, $3::text, $4::uuid, $5::text, $6::text, $7::text, date '2026-01-01', null, $8::text, null, $9::text, $10::text, $11::uuid,
         $12::uuid, $12::uuid, $13::uuid, $14::timestamptz, $15::text
   where not exists (select 1 from machvon.master_crosswalk where id = $2::uuid)`;

/** The contract fact frozen with the period snapshot of the fixtures (the revision 1 of the period), and the fact of the draft contract in it. */
const INSERT_FACT_SNAPSHOT = `insert into machvon.contract_fact_snapshot
  (tenant_id, id, period_snapshot_id, period_id, revision, supersedes_id, cutoff_date, as_of_date, contract_count, row_count, payload_sha256, built_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, null, date '2026-01-10', date '2026-01-10', 1, 1, $5::text, $6::uuid
   where not exists (select 1 from machvon.contract_fact_snapshot where id = $2::uuid)`;

const INSERT_FACT_SNAPSHOT_CONTRACT = `insert into machvon.contract_fact_snapshot_contract (tenant_id, snapshot_id, contract_id, fact)
  select $1::uuid, $2::uuid, f.id, to_jsonb(f) from machvon.contract_fact f
   where f.id = $3::uuid and not exists (select 1 from machvon.contract_fact_snapshot_contract where snapshot_id = $2::uuid and contract_id = $3::uuid)`;

/**
 * A change order (a CO with no parent) that was assessed by the other member and waits for a decision: the cost of it is half the price of the contract, so the cumulative variation reaches the
 * threshold of the policy and the check of the project adjustment is called for. The version is the one the commands of the suite send (`If-Match: "1"`).
 */
const INSERT_CHANGE_ORDER = `insert into machvon.change_request
  (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, parent_id, estimated_delta_vnd, evaluated_delta_vnd,
   evaluated_by, evaluated_at, funding_impact_note, submitted_by, created_by, updated_by)
  select $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, 0, $6::text, 'EVALUATED', 1, $7::text, 'CO', null, $5::numeric, $5::numeric,
         $8::uuid, now(), $9::text, $8::uuid, $8::uuid, $8::uuid
   where not exists (select 1 from machvon.change_request where id = $2::uuid)`;

/**
 * Seeds the e-GP connection (switched on again with a reason, so with two events of history), a package of ours and the run of a file of the plans with the row it claimed, its typed record (the package
 * the file names has the name and the price of ours, so it is suggested) and the row it refused, a mapping that waits for the decision of another person and one in force (each for one command), the frozen
 * contract fact of the period, and a change order that was assessed by the other member. The maker of each of these is the other member, so that the suite principal may decide, retire and clear.
 */
export async function seedEgp(client: Client, context: SeedContext): Promise<void> {
  const fixture = EGP_FIXTURES[context.tenant];
  const project = PROJECT_FIXTURES[context.tenant];
  const contract = CONTRACT_FIXTURES[context.tenant];
  const member = MEMBERSHIP_FIXTURES[context.tenant].id;
  const run = fixture.run;

  await client.query(INSERT_CONNECTION, [context.tenantId, fixture.connection.id, EGP_CONNECTOR_CODE, EGP_LAYOUT_VERSION, fixture.connection.stateReason, context.membershipId]);
  await client.query(INSERT_CONNECTION_EVENT, [context.tenantId, fixture.connection.createdEventId, fixture.connection.id, 'CREATED', null, context.membershipId, 1]);
  await client.query(INSERT_CONNECTION_EVENT, [context.tenantId, fixture.connection.enabledEventId, fixture.connection.id, 'ENABLED', fixture.connection.stateReason, context.membershipId, 2]);

  await client.query(INSERT_PACKAGE, [context.tenantId, fixture.package.id, project.id, fixture.package.code, fixture.package.budgetVnd, fixture.package.title]);

  await client.query(INSERT_RUN, [context.tenantId, run.id, EGP_POSITIONS.KHLCNT, EGP_LAYOUT_VERSION, run.fileSha256, run.fileObjectKey, member]);
  await client.query(INSERT_CLAIM, [context.tenantId, run.claimId, EGP_POSITIONS.KHLCNT, run.recordBusinessKey, run.rowHash, run.estimatedPriceVnd, run.id]);
  await client.query(INSERT_RECORD, [
    context.tenantId,
    run.recordId,
    run.recordBusinessKey,
    EGP_LAYOUT_VERSION,
    run.id,
    run.rowHash,
    JSON.stringify({ planCode: run.planCode, packageExternalCode: run.packageExternalCode, packageName: run.packageName, estimatedPrice: run.estimatedPriceVnd }),
    member,
  ]);
  await client.query(INSERT_REFUSED_ROW, [context.tenantId, run.quarantineId, run.id, run.quarantineBusinessKey, run.rowHash, run.quarantinePreview]);

  // Waits for a decision: proposed by hand by the other member, nobody has decided it.
  await client.query(INSERT_MAPPING, [
    context.tenantId,
    fixture.decideMapping.id,
    'PROJECT',
    project.id,
    EGP_SOURCE_SYSTEM,
    EGP_EXTERNAL_TYPES.PROJECT,
    fixture.decideMapping.externalCode,
    'MANUAL',
    'PROPOSED',
    fixture.decideMapping.reason,
    null,
    member,
    null,
    null,
    null,
  ]);
  // In force: proposed by the file import, approved by the suite principal, who is not its maker.
  await client.query(INSERT_MAPPING, [
    context.tenantId,
    fixture.retireMapping.id,
    'CONTRACT',
    contract.id,
    EGP_SOURCE_SYSTEM,
    EGP_EXTERNAL_TYPES.CONTRACT,
    fixture.retireMapping.externalCode,
    'IMPORT',
    'ACTIVE',
    fixture.retireMapping.reason,
    run.id,
    member,
    context.membershipId,
    new Date().toISOString(),
    fixture.retireMapping.reason,
  ]);

  await client.query(INSERT_FACT_SNAPSHOT, [
    context.tenantId,
    fixture.factSnapshot.id,
    PERIOD_SNAPSHOT_FIXTURES[context.tenant].id,
    PERIOD_FIXTURES[context.tenant].id,
    fixture.factSnapshot.payloadSha256,
    context.membershipId,
  ]);
  await client.query(INSERT_FACT_SNAPSHOT_CONTRACT, [context.tenantId, fixture.factSnapshot.id, contract.id]);

  await client.query(INSERT_CHANGE_ORDER, [
    context.tenantId,
    fixture.changeOrder.id,
    contract.id,
    contract.revisionId,
    fixture.changeOrder.deltaVnd,
    fixture.changeOrder.reason,
    fixture.changeOrder.code,
    member,
    fixture.changeOrder.fundingNote,
  ]);
}
