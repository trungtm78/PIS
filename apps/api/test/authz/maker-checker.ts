import { createHash } from 'node:crypto';
import { PERMISSIONS, STEP_UP } from '@machvon/contracts';
import type { SystemRole } from '@machvon/db';
import { STEP_UP_WINDOW_MINUTES, holdsPermission } from '@machvon/kernel';
import { evaluateGuardDenial } from './negative-matrix';
import type { MatrixRequest, Observation } from './negative-matrix';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

/**
 * A way to present a step-up credential that the policy must refuse, as the claims the test authentication guard reads.
 * Every one is a credential that was valid once or never proved a second factor, so each is a replay of a session that
 * would not pass a fresh challenge.
 */
export interface StepUpReplay {
  id: string;
  claims(now: Date): Record<string, unknown>;
}

const agedAal2 = (now: Date, minutes: number, seconds = 0): Record<string, unknown> => ({
  aal: 'aal2',
  aal2At: new Date(now.getTime() - minutes * MINUTE_MS - seconds * 1000).toISOString(),
});

export const STEP_UP_REPLAYS: readonly StepUpReplay[] = [
  { id: 'aal1', claims: () => ({ aal: 'aal1' }) },
  { id: 'aal2-without-time', claims: () => ({ aal: 'aal2' }) },
  { id: 'aal2-just-expired', claims: (now) => agedAal2(now, STEP_UP_WINDOW_MINUTES, 1) },
  { id: 'aal2-long-ago', claims: (now) => agedAal2(now, DAY_MINUTES) },
];

export interface StepUpCase {
  id: string;
  operationId: string;
  replay: StepUpReplay;
}

/**
 * One case per step-up command and replay. The commands come from the generated STEP_UP table (`x-step-up` of the
 * contract), so a command that gains a step-up requirement joins the matrix without an edit here.
 */
export function stepUpCasesFor(operationIds: readonly string[]): StepUpCase[] {
  const stepUp = STEP_UP as Readonly<Record<string, string>>;
  return operationIds
    .filter((operationId) => stepUp[operationId] !== undefined)
    .flatMap((operationId) => STEP_UP_REPLAYS.map((replay) => ({ id: `${operationId}:mfa:${replay.id}`, operationId, replay })));
}

/** A command that approves something another person made (BR-ADM-01): the maker may not be the checker. */
export interface ApproverCommand {
  operationId: string;
  /** The request that approves the object `objectId`. */
  build(objectId: string): MatrixRequest;
  /**
   * SQL (run as the table owner in tenant A) that creates the object `objectId` as made by the membership `maker`. `checker` is the
   * membership that will approve it: a command that only the owner of the object may take names it as the owner.
   */
  seedMadeBy(objectId: string, maker: string, checker: string): [string, unknown[]];
}

/**
 * The commands that have an approver. A command is declared here by hand because "who made the object" is domain
 * knowledge; the matrix test checks that each one is a command of the matrix, and that the maker is refused while
 * another holder of the same permission is not.
 */
/** A second id for the same object, so two commands of one maker never meet on a primary key (the same maker is the maker of both). */
export function derivedId(objectId: string, purpose: string): string {
  const hex = createHash('md5').update(`${objectId}:${purpose}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const IMPACT = '{"counts":{},"total":0,"computed_at":"2026-01-01T00:00:00.000Z"}';
const REVIEWER = '00000000-0000-4000-8000-0000000000e1';

/**
 * A new master record with its first version and its CREATE change request, all made by `$2`, the request in the status `$3`; with
 * `batch`, the request belongs to an import batch of the same id, which is in review (and reviewed once the request is approved).
 */
function seedMaster(batch: boolean): string {
  const batchRow = batch
    ? `b as (
    insert into machvon.master_import_batch (tenant_id, id, master_type, file_object_key, file_sha256, mapping_json, mode, status, total_rows, error_rows, errors_json, reviewed_by, reviewed_at, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MATRIX', 'tenants/matrix/import/' || $1::uuid::text, repeat('d', 64), '{}'::jsonb, 'ATOMIC', 'IN_REVIEW', 1, 0, '[]'::jsonb,
            case $3::text when 'APPROVED' then '${REVIEWER}'::uuid end, case $3::text when 'APPROVED' then now() end, $2::uuid, $2::uuid)
  ), `
    : '';
  return `with ${batchRow}r as (
    insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'TENANT', 'MATRIX', 'MX-' || $1::uuid::text, $3::text, $2::uuid, $2::uuid)
  ), v as (
    insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, 'MATRIX', 'MX-' || $1::uuid::text, 1, 'Matrix entry', '{}', '2026-01-01', $3::text, 'TENANT', $2::uuid, $2::uuid)
  ), d as (
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'INCOMING', 'CV', 'Matrix decision', 'INTERNAL', $2::uuid, $2::uuid)
  )
  insert into machvon.master_change_request (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, reason, impact_json, effective_from, status, reviewed_by, decided_at, created_by, updated_by${batch ? ', import_batch_id' : ''})
  values (current_setting('app.tenant_id')::uuid, $1::uuid, 'CREATE', 'MATRIX', $1::uuid, '{"label":"Matrix entry"}'::jsonb, 'maker-checker matrix', '${IMPACT}'::jsonb, '2026-01-01', $3::text,
          case $3::text when 'APPROVED' then '${REVIEWER}'::uuid end, case $3::text when 'APPROVED' then now() end, $2::uuid, $2::uuid${batch ? ', $1::uuid' : ''})`;
}

/**
 * A glossary term made by `$2` and owned by `$3` (the membership that decides and publishes it), in the status `$4`; an approved term
 * carries the decision of a reviewer. The term code is made from the id, so two terms never meet on the unique code.
 */
const SEED_GLOSSARY_TERM = `insert into machvon.glossary_term
    (tenant_id, id, term_code, term_vi, definition, domain, owner_membership_id, revision, status, approved_by, decided_by, decided_at, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX_' || upper(replace($1::uuid::text, '-', '_')), 'Thuật ngữ ma trận', 'Định nghĩa của thuật ngữ do ma trận phân quyền tạo ra.', 'MATRIX', $3::uuid, 1, $4::text,
          case $4::text when 'APPROVED' then '${REVIEWER}'::uuid end, case $4::text when 'APPROVED' then '${REVIEWER}'::uuid end, case $4::text when 'APPROVED' then now() end, $2::uuid, $2::uuid)`;

/**
 * An UNVERIFIED contractor made by `$2`, with a document of the same id as its profile and as the evidence a verification can name. The tax
 * id is made from the id, so two contractors of the matrix never meet on the unique index of verified tax ids.
 */
const SEED_CONTRACTOR = `with d as (
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REFERENCE', 'QD', 'Matrix registration certificate', 'INTERNAL', $2::uuid, $2::uuid)
  )
  insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, '09' || lpad((('x' || right(replace($1::uuid::text, '-', ''), 6))::bit(24)::int)::text, 8, '0'),
          'Matrix maker-checker contractor', 'UNVERIFIED', $1::uuid, $2::uuid, $2::uuid)`;

/**
 * A template revision made by `$2` in the status `$3` (a published one names a reviewer as its publisher and waits for its legal
 * confirmation), with a document of the same id as the evidence a confirmation can name.
 */
const SEED_TEMPLATE = `with d as (
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REFERENCE', 'QD', 'Matrix legal opinion', 'INTERNAL', $2::uuid, $2::uuid)
  )
  insert into machvon.document_template
    (tenant_id, id, template_code, revision, group_code, doc_type_code, title, layout_profile_id, body_blocks, placeholder_schema, legal_basis, watermark_text, origin,
     content_sha256, effective_from, status, approved_by, published_at, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-' || $1::uuid::text, 1, 'OTHER', 'QD', 'Matrix template',
          (select id from machvon.document_layout_profile where profile_code = 'ND30_A4_STANDARD' limit 1), '[{"kind":"paragraph","text":"{{body}}"}]'::jsonb,
          '{"required":["body"]}'::jsonb, 'Matrix legal basis', 'Waiting for confirmation', 'TENANT', repeat('e', 64), '2026-01-01', $3::text,
          case $3::text when 'PUBLISHED' then '${REVIEWER}'::uuid end, case $3::text when 'PUBLISHED' then now() end, $2::uuid, $2::uuid)`;

/**
 * A DRAFT appropriation made by `$2`, backed by a document of the same id as its decision and drawn from the fund source version that the
 * matrix seeds. A fund source version of the matrix is required to exist (it is, in the setup of the test).
 */
const SEED_APPROPRIATION = `with d as (
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REFERENCE', 'QD', 'Matrix assignment decision', 'INTERNAL', $2::uuid, $2::uuid)
  )
  insert into machvon.appropriation
    (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, decision_document_id, issuing_authority, source_year, revision, status, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, (select id from machvon.master_record_version where code = 'MX-CAP-FUND' limit 1), 2026, 'PM_ASSIGNED', 'CENTRAL', 1000,
          $1::uuid, 'Matrix authority', 2026, 1, 'DRAFT', $2::uuid, $2::uuid)`;

/** A report form made by `$2` in the status `$3` (a published one names a reviewer as its publisher). The code is made from the id. */
const SEED_MNE_FORM = `insert into machvon.mne_report_form
    (tenant_id, id, form_code, title, report_kind, legal_basis, effective_from, schema_json, doc_template_code, export_formats, revision, status, approved_by, published_at, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-' || $1::uuid::text, 'Matrix report form', 'OVERALL_SEMIANNUAL', 'Matrix legal basis', '2026-01-01', '{}'::jsonb, 'MX-TEMPLATE', array['XLSX'], 1, $3::text,
          case $3::text when 'PUBLISHED' then '${REVIEWER}'::uuid end, case $3::text when 'PUBLISHED' then now() end, $2::uuid, $2::uuid)`;

/** A DRAFT obligation rule `$3` made by `$2`, over a published form `$1` of the same maker (a reviewer published it). */
const SEED_MNE_RULE = `with f as (
    insert into machvon.mne_report_form
      (tenant_id, id, form_code, title, report_kind, legal_basis, effective_from, schema_json, doc_template_code, export_formats, revision, status, approved_by, published_at, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-' || $1::uuid::text, 'Matrix report form', 'OVERALL_SEMIANNUAL', 'Matrix legal basis', '2026-01-01', '{}'::jsonb, 'MX-TEMPLATE', array['XLSX'], 1,
            'PUBLISHED', '${REVIEWER}'::uuid, now(), $2::uuid, $2::uuid)
  )
  insert into machvon.mne_obligation_rule
    (tenant_id, id, rule_code, form_id, reporting_role, recipient, frequency, due_rule_json, legal_basis, effective_from, revision, status, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $3::uuid, 'MX-RULE-' || $3::uuid::text, $1::uuid, 'INVESTOR', 'Matrix recipient', 'SEMIANNUAL', '{"period":"H1","month":7,"day":10}'::jsonb, 'Matrix legal basis', '2026-01-01', 1, 'DRAFT', $2::uuid, $2::uuid)`;

const SEED_MASTER = seedMaster(false);
const SEED_MASTER_IMPORT = seedMaster(true);

/**
 * A DoA matrix version waiting for approval, made by `$maker` with one rule that covers every amount of a document type at a unit of
 * the tenant, starting one day later than the versions before it (an approval needs a start after the one in force). Written as a block because the rules are inserted while the version is a draft (the database refuses to change them
 * afterwards) and the version is then moved to PendingApproval. The ids are uuids made by the test, never user input.
 */
const seedDoaMatrix = (matrixId: string, maker: string): string => `do $seed$
declare
  matrix uuid := '${matrixId}';
begin
  insert into machvon.doa_matrix_version (tenant_id, id, revision, status, effective_from, legal_basis_ref, created_by, last_edited_by, version)
  values (current_setting('app.tenant_id')::uuid, matrix, (select coalesce(max(revision), 0) + 1 from machvon.doa_matrix_version), 'Draft', date '2026-01-01' + (select count(*)::int from machvon.doa_matrix_version), 'Maker-checker matrix regulation', '${maker}', '${maker}', 1);
  insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id)
  values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), matrix, 'MATRIX', (select id from machvon.organization_unit order by id limit 1), 0, null,
          (select id from machvon.role_definition where code = 'MEMBER'));
  update machvon.doa_matrix_version set status = 'PendingApproval' where id = matrix;
end
$seed$`;

export const APPROVER_COMMANDS: readonly ApproverCommand[] = [
  {
    operationId: 'releaseLegalHold',
    build: (objectId) => ({ method: 'POST', path: `/legal-holds/${objectId}/release`, ifMatch: '"1"', body: { reason: 'maker-checker matrix release' } }),
    seedMadeBy: (objectId, maker) => [
      `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
       values (current_setting('app.tenant_id')::uuid, $1, '{"kind":"TENANT","ids":[]}'::jsonb, 'MATRIX-MAKER-REF', 'maker-checker matrix hold', '2026-01-01T00:00:00Z', 'AUDIT', 'Active', $2, 1)`,
      [objectId, maker],
    ],
  },
  {
    operationId: 'publishSecurityPolicy',
    build: (objectId) => ({ method: 'POST', path: `/security-policies/${objectId}/publish`, ifMatch: '"1"', body: { reason: 'maker-checker matrix publish' } }),
    seedMadeBy: (objectId, maker) => [
      `insert into machvon.security_policy_version (tenant_id, id, revision, policy_json, status, created_by, version)
       values (current_setting('app.tenant_id')::uuid, $1, (select coalesce(max(revision), 0) + 1 from machvon.security_policy_version), '{"mfa_required_roles":[],"session_idle_minutes":30,"session_max_hours":8}'::jsonb, 'Draft', $2, 1)`,
      [objectId, maker],
    ],
  },
  {
    operationId: 'decideDoaMatrix',
    build: (objectId) => ({
      method: 'POST',
      path: `/doa-matrices/${objectId}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix decision', evidence_ids: [] },
    }),
    seedMadeBy: (objectId, maker) => [seedDoaMatrix(objectId, maker), []],
  },
  {
    operationId: 'decideMasterChangeRequest',
    build: (objectId) => ({
      method: 'POST',
      path: `/master-change-requests/${derivedId(objectId, 'decide')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix decision' },
    }),
    seedMadeBy: (objectId, maker) => [SEED_MASTER, [derivedId(objectId, 'decide'), maker, 'IN_REVIEW']],
  },
  {
    operationId: 'post_master_records_id_publish',
    build: (objectId) => ({
      method: 'POST',
      path: `/master-records/${derivedId(objectId, 'publish')}/publish`,
      ifMatch: '"1"',
      body: { decision_document_id: derivedId(objectId, 'publish') },
    }),
    seedMadeBy: (objectId, maker) => [SEED_MASTER, [derivedId(objectId, 'publish'), maker, 'APPROVED']],
  },
  {
    operationId: 'decideMasterImport',
    build: (objectId) => ({
      method: 'POST',
      path: `/master-imports/${derivedId(objectId, 'decide-batch')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix batch decision' },
    }),
    seedMadeBy: (objectId, maker) => [SEED_MASTER_IMPORT, [derivedId(objectId, 'decide-batch'), maker, 'IN_REVIEW']],
  },
  {
    operationId: 'publishMasterImport',
    build: (objectId) => ({
      method: 'POST',
      path: `/master-imports/${derivedId(objectId, 'publish-batch')}/publish`,
      ifMatch: '"1"',
      body: { decision_document_id: derivedId(objectId, 'publish-batch') },
    }),
    seedMadeBy: (objectId, maker) => [SEED_MASTER_IMPORT, [derivedId(objectId, 'publish-batch'), maker, 'APPROVED']],
  },
  {
    operationId: 'decideGlossaryTerm',
    build: (objectId) => ({
      method: 'POST',
      path: `/glossary-terms/${derivedId(objectId, 'decide-term')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix term decision' },
    }),
    seedMadeBy: (objectId, maker, checker) => [SEED_GLOSSARY_TERM, [derivedId(objectId, 'decide-term'), maker, checker, 'IN_REVIEW']],
  },
  {
    operationId: 'publishGlossaryTerm',
    build: (objectId) => ({ method: 'POST', path: `/glossary-terms/${derivedId(objectId, 'publish-term')}/publish`, ifMatch: '"1"', body: {} }),
    seedMadeBy: (objectId, maker, checker) => [SEED_GLOSSARY_TERM, [derivedId(objectId, 'publish-term'), maker, checker, 'APPROVED']],
  },
  {
    operationId: 'publishDocumentTemplate',
    build: (objectId) => ({ method: 'POST', path: `/document-templates/${derivedId(objectId, 'publish-template')}/publish`, ifMatch: '"1"', body: {} }),
    seedMadeBy: (objectId, maker) => [SEED_TEMPLATE, [derivedId(objectId, 'publish-template'), maker, 'DRAFT']],
  },
  {
    operationId: 'confirmDocumentTemplateLegalBasis',
    build: (objectId) => ({
      method: 'POST',
      path: `/document-templates/${derivedId(objectId, 'confirm-template')}/legal-confirmation`,
      ifMatch: '"1"',
      body: { legal_confirmation_ref: 'CXN-MATRIX', evidence_document_id: derivedId(objectId, 'confirm-template') },
    }),
    seedMadeBy: (objectId, maker) => [SEED_TEMPLATE, [derivedId(objectId, 'confirm-template'), maker, 'PUBLISHED']],
  },
  {
    operationId: 'verifyContractor',
    build: (objectId) => ({
      method: 'POST',
      path: `/contractors/${derivedId(objectId, 'verify-contractor')}/verification`,
      ifMatch: '"1"',
      body: { decision: 'VERIFIED', verification_evidence_document_id: derivedId(objectId, 'verify-contractor') },
    }),
    seedMadeBy: (objectId, maker) => [SEED_CONTRACTOR, [derivedId(objectId, 'verify-contractor'), maker]],
  },
  {
    operationId: 'decideAppropriation',
    build: (objectId) => ({
      method: 'POST',
      path: `/appropriations/${derivedId(objectId, 'decide-appropriation')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix appropriation decision' },
    }),
    seedMadeBy: (objectId, maker) => [SEED_APPROPRIATION, [derivedId(objectId, 'decide-appropriation'), maker]],
  },
  {
    operationId: 'publishMneForm',
    build: (objectId) => ({ method: 'POST', path: `/mne-forms/${derivedId(objectId, 'publish-mne-form')}/publish`, ifMatch: '"1"', body: {} }),
    seedMadeBy: (objectId, maker) => [SEED_MNE_FORM, [derivedId(objectId, 'publish-mne-form'), maker, 'DRAFT']],
  },
  {
    operationId: 'publishMneObligationRule',
    build: (objectId) => ({ method: 'POST', path: `/mne-obligation-rules/${derivedId(objectId, 'publish-mne-rule')}/publish`, ifMatch: '"1"', body: {} }),
    seedMadeBy: (objectId, maker) => [SEED_MNE_RULE, [derivedId(objectId, 'publish-mne-rule-form'), maker, derivedId(objectId, 'publish-mne-rule')]],
  },
  {
    operationId: 'publishRetentionPolicy',
    build: (objectId) => ({ method: 'POST', path: `/retention-policies/${objectId}/publish`, ifMatch: '"1"', body: { reason: 'maker-checker matrix publish' } }),
    // One open draft per record class is allowed, so each case drafts its own class.
    seedMadeBy: (objectId, maker) => [
      `insert into machvon.data_retention_policy (tenant_id, id, record_class, revision, retention_years, retention_basis, legal_basis_ref, end_action, effective_from, status, created_by, version)
       values (current_setting('app.tenant_id')::uuid, $1::uuid, 'mx_' || right(replace($1::uuid::text, '-', ''), 12), 1, 10, 'FROM_CLOSED', 'Maker-checker matrix basis', 'REVIEW_FOR_DESTRUCTION', date '2026-01-01', 'Draft', $2::uuid, 1)`,
      [objectId, maker],
    ],
  },
];

export interface MakerCheckerCase {
  id: string;
  operationId: string;
  /** The system role of the maker; it holds the permission of the command, so only the maker rule can refuse it. */
  roleCode: string;
}

export function makerCheckerCasesFor(commands: readonly ApproverCommand[], roles: readonly SystemRole[]): MakerCheckerCase[] {
  return commands.flatMap((command) => {
    const permission = (PERMISSIONS as Readonly<Record<string, string>>)[command.operationId];
    if (permission === undefined) throw new Error(`operation ${command.operationId} has no permission in the generated table`);
    return roles
      .filter((role) => holdsPermission(new Set(role.permissions), permission))
      .map((role) => ({ id: `${command.operationId}:maker:${role.code}`, operationId: command.operationId, roleCode: role.code }));
  });
}

/** Failures of a replay case: refused with MFA_REQUIRED, one DENIED audit row, nothing changed. */
export function evaluateStepUpDenial(observation: Observation): string[] {
  return evaluateGuardDenial(observation, 'MFA_REQUIRED');
}

/** Failures of a maker-checker case: the maker's own approval is refused with SELF_APPROVAL_DENIED and changes nothing. */
export function evaluateSelfApproval(observation: Observation): string[] {
  const failures: string[] = [];
  if (observation.status !== 403) failures.push(`answered ${observation.status} instead of 403`);
  if (observation.code !== 'SELF_APPROVAL_DENIED') failures.push(`code ${String(observation.code)} instead of SELF_APPROVAL_DENIED`);
  if (observation.stateChanged) failures.push('tenant state changed');
  return failures;
}
