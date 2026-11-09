import { createHash } from 'node:crypto';
import { PERMISSIONS, STEP_UP } from '@machvon/contracts';
import type { SystemRole } from '@machvon/db';
import { STEP_UP_WINDOW_MINUTES, holdsPermission } from '@machvon/kernel';
import { id } from '../../../../packages/db/test/support/authz-fixtures';
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

/**
 * A capital plan made by `$2` in the status `$3` (IN_REVIEW as submitted by the maker, or APPROVED as approved by a reviewer after the maker submitted it),
 * at the root unit of the tenant. The code is made from the id.
 */
const SEED_CAPITAL_PLAN = `insert into machvon.capital_plan
    (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, submitted_by, approved_by, created_by, updated_by, version)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-' || $1::uuid::text, 'ANNUAL', 2031, 2031, 2031,
          (select id from machvon.organization_unit order by char_length(path), path limit 1), 1, $3::text, $2::uuid,
          case $3::text when 'APPROVED' then '${REVIEWER}'::uuid end, $2::uuid, $2::uuid, 1)`;

/**
 * An APPROVED capital plan that can be published, made by `$2` and submitted by `$2`, approved by a reviewer: its decision document (the same id), a published
 * appropriation of the fund source of the matrix, a BUDGETED project (the national code rule does not apply to it) and one line of 100 dong. Everything has the id `$1`.
 */
const SEED_PUBLISHABLE_PLAN = `with d as (
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REFERENCE', 'QD', 'Matrix plan decision', 'MX-' || $1::uuid::text, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $2::uuid, $2::uuid)
  ), a as (
    insert into machvon.appropriation
      (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, (select id from machvon.master_record_version where code = 'MX-CAP-FUND' limit 1), 2031, 'PM_ASSIGNED', 'CENTRAL', 1000, 100,
            $1::uuid, 'Matrix authority', 2031, 1, 'PUBLISHED', '${REVIEWER}'::uuid, $2::uuid, $2::uuid)
  ), p as (
    insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-PL-' || $1::uuid::text, 'Matrix funded project', '${id(0x10, 2)}'::uuid, '${id(0x8a, 3)}'::uuid, 'INTERNAL', 1000, 'BUDGETED', 'B', 1, $2::uuid, $2::uuid)
  ), c as (
    insert into machvon.capital_plan
      (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, submitted_by, approved_by, created_by, updated_by, version)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-' || $1::uuid::text, 'ANNUAL', 2031, 2031, 2031,
            (select id from machvon.organization_unit order by char_length(path), path limit 1), 1, 'APPROVED', $2::uuid, '${REVIEWER}'::uuid, $2::uuid, $2::uuid, 1)
  ), v as (
    insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, status, capital_plan_id, created_by, updated_by, version)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, 2031, 1, 'APPROVED', $1::uuid, $2::uuid, $2::uuid, 1)
  )
  insert into machvon.allocation_line
    (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, (select id from machvon.master_record_version where code = 'MX-CAP-FUND' limit 1), 'CURRENT_YEAR', 2031, 100, 0,
          $1::uuid, $1::uuid, 'CENTRAL', 'PM_ASSIGNED', $2::uuid, $2::uuid)`;

/**
 * A request to carry capital over to the next year made by `$2`, on a line of a PUBLISHED plan of 2031 (everything has the id `$1`: the decision document, the appropriation, the project, the plan, its
 * version, the line and its balance of 100 dong). The request asks for 50 dong until the end of 2032; the document that allows it is the one of the same id.
 */
const SEED_EXTENSION = `with d as (
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REFERENCE', 'QD', 'Matrix carry-over decision', 'MX-' || $1::uuid::text, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $2::uuid, $2::uuid)
  ), a as (
    insert into machvon.appropriation
      (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, (select id from machvon.master_record_version where code = 'MX-CAP-FUND' limit 1), 2031, 'PM_ASSIGNED', 'CENTRAL', 1000, 100,
            $1::uuid, 'Matrix authority', 2031, 1, 'PUBLISHED', '${REVIEWER}'::uuid, $2::uuid, $2::uuid)
  ), p as (
    insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, version, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-EX-' || $1::uuid::text, 'Matrix carried-over project', '${id(0x10, 2)}'::uuid, '${id(0x8a, 3)}'::uuid, 'INTERNAL', 1000, 'BUDGETED', 'B', 1, $2::uuid, $2::uuid)
  ), c as (
    insert into machvon.capital_plan
      (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, submitted_by, approved_by, published_at, published_by, created_by, updated_by, version)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-' || $1::uuid::text, 'ANNUAL', 2031, 2031, 2031,
            (select id from machvon.organization_unit order by char_length(path), path limit 1), 1, 'PUBLISHED', $1::uuid, now(), $2::uuid, '${REVIEWER}'::uuid, now(), '${REVIEWER}'::uuid, $2::uuid, $2::uuid, 1)
  ), v as (
    insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id, created_by, updated_by, version)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, 2031, 1, $1::uuid, 'PUBLISHED', now(), $1::uuid, $2::uuid, $2::uuid, 1)
  ), l as (
    insert into machvon.allocation_line
      (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, appropriation_id, project_id, budget_level, origin, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, (select id from machvon.master_record_version where code = 'MX-CAP-FUND' limit 1), 'CURRENT_YEAR', 2031, 100, 0,
            $1::uuid, $1::uuid, 'CENTRAL', 'PM_ASSIGNED', $2::uuid, $2::uuid)
  ), b as (
    insert into machvon.allocation_balance (tenant_id, id, allocation_line_id, allocated_vnd, reserved_vnd, committed_vnd, disbursed_vnd)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, 100, 0, 0, 0)
  ), e as (
    insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, $1::uuid, $1::uuid, 'ALLOCATE', 100, 2031, 'CAPITAL_PLAN', $1::uuid, $2::uuid)
  )
  insert into machvon.allocation_extension
    (tenant_id, id, allocation_line_id, project_id, from_plan_year, extended_to, amount_vnd, reason_code, status, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, $1::uuid, 2031, date '2032-03-31', 50, 'GPMB_CHAM', 'REQUESTED', $2::uuid, $2::uuid)`;

/**
 * A fiscal year locked by `$2` (version 1), for the year the case names: a different holder of the right reopens it, the person who locked it is refused. The year is made from the
 * id, so two cases never meet on the unique year of the control.
 */
const SEED_LOCKED_YEAR = `insert into machvon.fiscal_year_control (tenant_id, id, plan_year, status, locked_at, locked_by, created_by, updated_by, version)
  values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1::integer, 'LOCKED', now(), $2::uuid, $2::uuid, $2::uuid, 1)`;

/** The year a case of the matrix works on: between 1990 and 2089, made from the id of the case. */
const yearOfCase = (objectId: string): number => 1990 + (Number.parseInt(objectId.replace(/-/g, '').slice(0, 6), 16) % 100);

/** A request to reopen the locked period of the matrix, made by `$2`; the table keeps one row per request, so each case names its own. */
const SEED_PERIOD_REOPEN = `insert into machvon.period_reopen (tenant_id, id, period_id, scope_kind, reason, requested_by, requested_window_hours, status, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, (select id from machvon.reporting_period where code = 'MX-W2026-03'), 'PERIOD', 'Maker-checker matrix request to reopen', $2::uuid, 24, 'REQUESTED', $2::uuid, $2::uuid)`;

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

/**
 * A guarantee of the draft contract that the matrix seeds, made by `$2` in the status `$3` (PENDING_VERIFICATION, or ACTIVE as verified by a
 * reviewer on the clean document version of the matrix). The number is made from the id, so two guarantees never meet on the unique number.
 */
const MATRIX_DRAFT_CONTRACT = id(0x77, 8);
const MATRIX_EVIDENCE = id(0x78, 2);
const SEED_GUARANTEE = `insert into machvon.guarantee
    (tenant_id, id, contract_id, kind, issuer, guarantee_no, amount_vnd, expires_at, verification_status, status, valid_from, document_version_id,
     verified_by, verified_at, verification_method, verification_evidence_id, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, '${MATRIX_DRAFT_CONTRACT}'::uuid, 'PERFORMANCE', 'Matrix bank', 'MX-' || $1::uuid::text, 1000, now() + interval '1 year',
          case $3::text when 'PENDING_VERIFICATION' then 'UNVERIFIED' else 'VERIFIED' end, $3::text, date '2026-01-01', '${MATRIX_EVIDENCE}'::uuid,
          case $3::text when 'PENDING_VERIFICATION' then null else '${REVIEWER}'::uuid end, case $3::text when 'PENDING_VERIFICATION' then null else now() end,
          case $3::text when 'PENDING_VERIFICATION' then null else 'Matrix check' end, case $3::text when 'PENDING_VERIFICATION' then null else '${MATRIX_EVIDENCE}'::uuid end, $2::uuid, $2::uuid)`;

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

/**
 * A project in APPRAISAL made by `$2` with one SUBMITTED sheet of the set of criteria of the same id, scored by the member `$3` (an active member who is
 * not the maker), and the document that a decision on it names (all with the id `$1`). The set has one criterion of weight 100, so the sheet is 100.00 and recommends ADMIT.
 */
export const SEED_APPRAISAL = `with r as (
    insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'TENANT', 'APPRAISAL_CRITERIA', 'MX-CRIT-' || $1::uuid::text, 'EFFECTIVE', $2::uuid, $2::uuid)
  ), v as (
    insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, 'APPRAISAL_CRITERIA', 'MX-CRIT-' || $1::uuid::text, 1, 'Matrix criteria',
            '{"criteria":[{"code":"A","name":"Matrix criterion","max_score":100}],"pass_threshold":60}'::jsonb, '2020-01-01', 'EFFECTIVE', 'TENANT', now(), $2::uuid, $2::uuid)
  ), d as (
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REFERENCE', 'QD', 'Matrix appraisal decision', 'MX-' || $1::uuid::text, '2026-01-15', 'EFFECTIVE', 'INTERNAL', $2::uuid, $2::uuid)
  ), p as (
    insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-AP-' || $1::uuid::text, 'Matrix appraised project', '${id(0x10, 2)}'::uuid, '${id(0x8a, 3)}'::uuid, 'INTERNAL', 1000, 'APPRAISAL', 1, $2::uuid, $2::uuid)
  )
  insert into machvon.project_appraisal (tenant_id, id, project_id, round, criteria_set_version_id, appraiser_membership_id, scores_json, total_score, recommendation, status, created_by, updated_by)
  values (current_setting('app.tenant_id')::uuid, $1::uuid, $1::uuid, 1, $1::uuid, $3::uuid, '[{"criterion_code":"A","score":5}]'::jsonb, 100, 'ADMIT', 'SUBMITTED', $3::uuid, $3::uuid)`;

export const APPROVER_COMMANDS: readonly ApproverCommand[] = [
  {
    operationId: 'decideProjectAppraisal',
    build: (objectId) => ({
      method: 'POST',
      path: `/project-appraisals/${derivedId(objectId, 'appraisal')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'ADMIT', reason: 'maker-checker matrix decision', decision_document_id: derivedId(objectId, 'appraisal'), project_group: 'B' },
    }),
    seedMadeBy: (objectId, maker, checker) => [SEED_APPRAISAL, [derivedId(objectId, 'appraisal'), maker, checker]],
  },
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
    operationId: 'publishAvcPolicy',
    build: (objectId) => ({ method: 'POST', path: `/avc-policies/${objectId}/publish`, ifMatch: '"1"', body: {} }),
    // One published policy per scope and object at a time: each case drafts the policy of a scope of its own.
    seedMadeBy: (objectId, maker) => [
      `insert into machvon.avc_policy (tenant_id, id, policy_code, scope_kind, scope_value, control_object, warn_pct, block_pct, legal_basis, effective_from, revision, status, created_by, updated_by, version)
       values (current_setting('app.tenant_id')::uuid, $1::uuid, 'MX-' || $1::uuid::text, 'FUND_SOURCE', 'MX-' || $1::uuid::text, 'ALLOCATION_LINE', 90, 100, 'maker-checker matrix basis', date '2026-01-01', 1, 'DRAFT', $2::uuid, $2::uuid, 1)`,
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
    operationId: 'approveGovernanceRule',
    build: (objectId) => ({ method: 'POST', path: `/governance-rules/${objectId}/approve`, ifMatch: '"1"', body: { reason: 'maker-checker matrix approval' } }),
    // A version submitted by its own maker: the maker (and the submitter) may not approve it.
    seedMadeBy: (objectId, maker) => [
      `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at)
       values (current_setting('app.tenant_id')::uuid, $1::uuid, 'REMINDER_POLICY', 'MX_' || upper(replace($1::text, '-', '')), 1, 'SUBMITTED',
               '{"every_working_hours":{"URGENT":4,"ACTION":8,"WATCH":40},"max_per_item":{"URGENT":40,"ACTION":20,"WATCH":8}}'::jsonb, date '2999-01-01', 'Maker-checker matrix rule', $2::uuid, $2::uuid, now())`,
      [objectId, maker],
    ],
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
    operationId: 'verifyGuarantee',
    build: (objectId) => ({
      method: 'POST',
      path: `/guarantees/${derivedId(objectId, 'verify-guarantee')}/verify`,
      ifMatch: '"1"',
      body: { outcome: 'VERIFIED', method: 'maker-checker matrix check', evidence_document_version_id: MATRIX_EVIDENCE },
    }),
    seedMadeBy: (objectId, maker) => [SEED_GUARANTEE, [derivedId(objectId, 'verify-guarantee'), maker, 'PENDING_VERIFICATION']],
  },
  {
    operationId: 'releaseGuarantee',
    build: (objectId) => ({
      method: 'POST',
      path: `/guarantees/${derivedId(objectId, 'release-guarantee')}/release`,
      ifMatch: '"1"',
      body: { release_evidence_id: MATRIX_EVIDENCE, reason: 'maker-checker matrix release' },
    }),
    seedMadeBy: (objectId, maker) => [SEED_GUARANTEE, [derivedId(objectId, 'release-guarantee'), maker, 'ACTIVE']],
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
    operationId: 'decideAllocationExtension',
    build: (objectId) => ({
      method: 'POST',
      path: `/allocation-extensions/${derivedId(objectId, 'decide-allocation-extension')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix extension decision', approving_document_id: derivedId(objectId, 'decide-allocation-extension') },
    }),
    seedMadeBy: (objectId, maker) => [SEED_EXTENSION, [derivedId(objectId, 'decide-allocation-extension'), maker]],
  },
  {
    operationId: 'reopenFiscalYear',
    build: (objectId) => ({
      method: 'POST',
      path: `/fiscal-years/${yearOfCase(derivedId(objectId, 'reopen-fiscal-year'))}/reopen`,
      ifMatch: '"1"',
      body: { reason: 'maker-checker matrix reopening of the year for a correction', window_hours: 24 },
    }),
    seedMadeBy: (objectId, maker) => [SEED_LOCKED_YEAR, [yearOfCase(derivedId(objectId, 'reopen-fiscal-year')), maker]],
  },
  {
    operationId: 'decideCapitalPlan',
    build: (objectId) => ({
      method: 'POST',
      path: `/capital-plans/${derivedId(objectId, 'decide-capital-plan')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix plan decision' },
    }),
    seedMadeBy: (objectId, maker) => [SEED_CAPITAL_PLAN, [derivedId(objectId, 'decide-capital-plan'), maker, 'IN_REVIEW']],
  },
  {
    operationId: 'post_plans_id_publish',
    build: (objectId) => ({
      method: 'POST',
      path: `/plans/${derivedId(objectId, 'publish-capital-plan')}/publish`,
      ifMatch: '"1"',
      body: { decision_document_id: derivedId(objectId, 'publish-capital-plan') },
    }),
    seedMadeBy: (objectId, maker) => [SEED_PUBLISHABLE_PLAN, [derivedId(objectId, 'publish-capital-plan'), maker]],
  },
  {
    operationId: 'decidePeriodReopen',
    build: (objectId) => ({
      method: 'POST',
      path: `/period-reopens/${derivedId(objectId, 'decide-period-reopen')}/decision`,
      ifMatch: '"1"',
      body: { decision: 'approve', reason: 'maker-checker matrix reopen decision', window_hours: 24 },
    }),
    seedMadeBy: (objectId, maker) => [SEED_PERIOD_REOPEN, [derivedId(objectId, 'decide-period-reopen'), maker]],
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
  {
    operationId: 'decideProcurementPlan',
    build: (objectId) => ({
      method: 'POST',
      path: `/procurement-plans/${derivedId(objectId, 'bid-plan')}/decision`,
      ifMatch: '"2"',
      body: { decision: 'APPROVE', decision_document_id: derivedId(objectId, 'bid-decision') },
    }),
    // The statements carry no parameter, so the driver sends them as one simple query: a transaction in which the plan, its package and the lines they rest on are written.
    seedMadeBy: (objectId, maker) => [seedBidPlan(objectId, maker), []],
  },
  {
    operationId: 'approveCriteriaVersion',
    build: (objectId) => ({ method: 'POST', path: `/criteria-versions/${derivedId(objectId, 'criteria-version')}/approval`, ifMatch: '"1"', body: {} }),
    // The statements carry no parameter, so the driver sends them as one simple query: the project, the package of its approved plan and the draft of its criteria.
    seedMadeBy: (objectId, maker) => [seedCriteriaDraft(objectId, maker), []],
  },
  {
    operationId: 'grantPermitGateWaiver',
    build: (objectId) => ({
      method: 'POST',
      path: '/permit-gate-waivers',
      body: {
        project_id: derivedId(objectId, 'waiver-project'),
        gate_code: 'START_CONSTRUCTION',
        permit_type_id: derivedId(objectId, 'waiver-type'),
        reason: 'maker-checker matrix waiver',
        decision_document_version_id: derivedId(objectId, 'waiver-version'),
        valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      },
    }),
    // The statements carry no parameter, so the driver sends them as one simple query: the project, the permit type and the decision that `maker` made.
    seedMadeBy: (objectId, maker) => [seedWaiverRequest(objectId, maker), []],
  },
  {
    operationId: 'approveQualityRuleVersion',
    build: (objectId) => ({ method: 'POST', path: `/dgv/quality-rules/${derivedId(objectId, 'quality-rule')}/approval`, ifMatch: '"1"', body: {} }),
    seedMadeBy: (objectId, maker, checker) => [SEED_QUALITY_RULE, [derivedId(objectId, 'quality-rule'), maker, checker, derivedId(objectId, 'quality-dataset'), derivedId(objectId, 'quality-contract')]],
  },
  {
    operationId: 'decideBackupRequest',
    build: (objectId) => ({ method: 'POST', path: `/backup-requests/${objectId}/decision`, ifMatch: '"1"', body: { decision: 'approve', reason: 'maker-checker matrix decision' } }),
    seedMadeBy: (objectId, maker) => [
      `insert into machvon.backup_request (tenant_id, id, kind, repository, reason, requested_by)
       values (current_setting('app.tenant_id')::uuid, $1, 'full', 1, 'maker-checker matrix request', $2)`,
      [objectId, maker],
    ],
  },
];

/** A draft quality rule written by $2 on a dataset of the DIS module (owned by $2, stewarded by $3), through its working contract. */
const SEED_QUALITY_RULE = `with d as (
  insert into machvon.dataset (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical, freshness_slo_seconds, status, created_by, updated_by)
    values (current_setting('app.tenant_id')::uuid, $4::uuid, 'DS-MX-' || substr($4::uuid::text, 1, 8), 'Matrix rule dataset', 'MATRIX', 'one row per case', 'DIS', $2::uuid, $3::uuid, 'INTERNAL', false, 3600, 'DRAFT', $2::uuid, $2::uuid) returning id
), c as (
  insert into machvon.dataset_contract (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id)
    select current_setting('app.tenant_id')::uuid, $5::uuid, 'DS-MX-' || substr($4::uuid::text, 1, 8), 1, $2::uuid, '{}'::jsonb, '{}'::jsonb, 3600, 'INTERNAL', 'DRAFT', d.id from d returning id
)
insert into machvon.quality_rule_version (tenant_id, id, contract_id, dataset_id, code, revision, expression_ast, severity, threshold_json, status, dimension, field_path, action_on_fail, criticality_weight, created_by)
  select current_setting('app.tenant_id')::uuid, $1::uuid, c.id, $4::uuid, 'R-MX-' || substr($1::uuid::text, 1, 8), 1, '{"op":"not_null","field":"project_id"}'::jsonb, 'MEDIUM', '{"min_pass_rate_pct":"100.000000"}'::jsonb,
         'DRAFT', 'COMPLETENESS', 'project_id', 'QUARANTINE', 1, $2::uuid from c`;

/**
 * A procurement plan IN_REVIEW (version 2; with `status` DRAFT, version 1) made and submitted by `maker`, of a project of unit 2 with a line of capital in a published plan, the
 * one package that uses the line and the decision document in force that an approval can name. Every id is derived from the object id, so two
 * plans of the matrix never meet on a code or a key.
 */
export function seedBidPlan(objectId: string, maker: string, status: 'DRAFT' | 'IN_REVIEW' = 'IN_REVIEW'): string {
  const ids = Object.fromEntries(['project', 'capital', 'version', 'line', 'plan', 'package', 'decision'].map((purpose) => [purpose, derivedId(objectId, `bid-${purpose}`)]));
  const tag = (ids.plan as string).slice(0, 8);
  const tenant = "current_setting('app.tenant_id')::uuid";
  return `
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, symbol, issued_on, effect_status, created_by, updated_by)
      values (${tenant}, '${ids.decision}', 'REFERENCE', 'QD', 'Matrix plan decision', 'INTERNAL', '45/QD-MATRIX', date '2026-10-01', 'EFFECTIVE', '${maker}', '${maker}');
    insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
      values (${tenant}, '${ids.project}', 'MXB-${tag}', 'Matrix plan project', '${id(0x10, 2)}', '${id(0x8a, 3)}', 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B');
    insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, decision_document_id, effective_at, created_by, updated_by)
      values (${tenant}, '${ids.capital}', 'MXB-${tag}', 'ANNUAL', 2026, 2026, 2026, '${id(0x10, 1)}', 1, 'PUBLISHED', '${ids.decision}', now(), '${maker}', '${maker}');
    insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at, capital_plan_id)
      values (${tenant}, '${ids.version}', '${ids.project}', 2026, 1, '${ids.decision}', 'PUBLISHED', now(), '${ids.capital}');
    insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id)
      values (${tenant}, '${ids.line}', '${ids.version}', '${id(0x8c, 2)}', 'CURRENT_YEAR', 2026, 1000, 0, '${ids.project}');
    insert into machvon.procurement_plan (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, status, created_by, updated_by)
      values (${tenant}, '${ids.plan}', '${ids.project}', 1, 'Matrix procurement plan', 500, 'Matrix legal basis', 'DRAFT', '${maker}', '${maker}');
    insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, plan_id, title, contract_type, bidding_form, allocation_line_id, planned_start_period, duration_days, created_by)
      values (${tenant}, '${ids.package}', '${ids.project}', 'MXB-${tag}', 500, 'OPEN_BIDDING', 1, 'DRAFT', '${ids.plan}', 'Matrix package', 'LUMP_SUM', 'ONLINE', '${ids.line}', '2026-Q4', 30, '${maker}');
${status === 'DRAFT' ? '' : `
    update machvon.procurement_plan set status = 'IN_REVIEW', submitted_by = '${maker}', submitted_at = now(), version = 2 where id = '${ids.plan}';
    update machvon.procurement_package set status = 'IN_REVIEW' where id = '${ids.package}';`}`;
}

/**
 * A draft of the criteria of a package (version 1) made by `maker`, for a package of an approved plan in a project of unit 2. Every id is derived
 * from the object id, so two drafts of the matrix never meet on a code or a key.
 */
export function seedCriteriaDraft(objectId: string, maker: string): string {
  const ids = Object.fromEntries(['project', 'package', 'version'].map((purpose) => [purpose, derivedId(objectId, `criteria-${purpose}`)]));
  const tag = (ids.version as string).slice(0, 8);
  const tenant = "current_setting('app.tenant_id')::uuid";
  return `
    insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
      values (${tenant}, '${ids.project}', 'MXC-${tag}', 'Matrix criteria project', '${id(0x10, 2)}', '${id(0x8a, 3)}', 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B');
    insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title)
      values (${tenant}, '${ids.package}', '${ids.project}', 'MXC-${tag}', 500, 'OPEN_BIDDING', 1, 'PLANNED', 'Matrix criteria package');
    insert into machvon.criteria_version (tenant_id, id, package_id, revision, criteria_json, legal_basis, weights_sum, status, created_by, version)
      values (${tenant}, '${ids.version}', '${ids.package}', 1, '{"criteria":[{"code":"MX1","name":"Matrix criterion","kind":"SCORED","weight":100,"max_score":10,"threshold":5,"mandatory":false,"required_evidence":[]}]}'::jsonb,
              'Matrix legal basis', 100, 'DRAFT', '${maker}', 1);`;
}

/**
 * The things a waiver of a permit gate rests on, all made by `maker`: a project of unit 2, a permit type and the decision document version that asked for the
 * waiver. Granting it is approving what the maker asked for. Every id is derived from the object id, so two cases never meet on a code or a key.
 */
export function seedWaiverRequest(objectId: string, maker: string): string {
  const ids = Object.fromEntries(['project', 'type', 'document', 'version'].map((purpose) => [purpose, derivedId(objectId, `waiver-${purpose}`)]));
  const tag = (ids.type as string).slice(0, 8);
  const tenant = "current_setting('app.tenant_id')::uuid";
  return `
    insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
      values (${tenant}, '${ids.project}', 'MXW-${tag}', 'Matrix waiver project', '${id(0x10, 2)}', '${id(0x8a, 3)}', 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B');
    insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
      values (${tenant}, '${ids.type}', 'MXW_${tag.toUpperCase()}', 'Matrix waiver type', 'OTHER', 'Matrix authority', 'Matrix legal basis', date '2026-01-01', '{}'::jsonb, 'PUBLISHED', '${maker}', '${maker}');
    insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
      values (${tenant}, '${ids.document}', 'REFERENCE', 'QD', 'Matrix waiver decision', 'INTERNAL', '${maker}', '${maker}');
    insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
      values (${tenant}, '${ids.version}', '${ids.document}', 1, 'tenants/matrix/${tag}.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL');`;
}

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
