import {
  DomainError,
  assertFourEyes,
  draftFindings,
  headerFindings,
  notAfterCurrentFinding,
  refuseDoa,
  resolveDoa,
  submitFindings,
  unknownReferenceFinding,
  versionConflict,
} from '@machvon/kernel';
import type { DoaFinding, DoaMatrixRecord, DoaQuery, DoaResolution, DoaRuleContent, DoaRuleRecord } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type DoaMatrixStatus = 'Draft' | 'PendingApproval' | 'Published' | 'Superseded' | 'Rejected';
export type DoaDecision = 'approve' | 'return' | 'reject';

/** What a draft says (`DoaMatrixDraft` of openapi.json). */
export interface DoaMatrixInput {
  effective_from: string;
  effective_until?: string | null;
  legal_basis_ref: string;
  rules: readonly DoaRuleContent[];
}

export interface DoaMatrixRow {
  id: string;
  revision: number;
  status: DoaMatrixStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  legalBasis: string;
  createdBy: string;
  /** The last person who wrote the draft (created, edited or submitted it): neither they nor the author may approve it. */
  lastEditedBy: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  version: number;
  rules: DoaRuleRecord[];
}

export interface DoaDecisionResult {
  status: 'PUBLISHED' | 'RETURNED' | 'REJECTED';
  version: number;
  /** The version in force until now, when an approval replaced it. */
  supersededId: string | undefined;
  /** What the decided version is, for the audit row and the event. */
  revision: number;
  effectiveFrom: string;
}

interface MatrixRow {
  id: string;
  revision: number;
  status: DoaMatrixStatus;
  effective_from: string;
  effective_until: string | null;
  legal_basis_ref: string;
  created_by: string;
  last_edited_by: string | null;
  approved_by: string | null;
  published_at: string | null;
  version: string;
}

interface RuleRow {
  id: string;
  document_type: string;
  unit_id: string;
  include_subtree: boolean;
  amount_min_vnd: string;
  amount_max_vnd: string | null;
  approver_role_id: string;
  approval_levels: number;
  requires_distinct_approvers: boolean;
}

const MATRIX_COLUMNS = `id, revision, status, effective_from::text as effective_from, effective_until::text as effective_until, legal_basis_ref,
  created_by, last_edited_by, approved_by, published_at::text as published_at, version::text as version`;
const RULE_COLUMNS = `id, document_type, unit_id, include_subtree, amount_min_vnd::text as amount_min_vnd, amount_max_vnd::text as amount_max_vnd,
  approver_role_id, approval_levels, requires_distinct_approvers`;

const toRule = (row: RuleRow): DoaRuleRecord => ({
  id: row.id,
  document_type: row.document_type,
  unit_id: row.unit_id,
  include_subtree: row.include_subtree,
  amount_min_vnd: row.amount_min_vnd,
  amount_max_vnd: row.amount_max_vnd,
  approver_role_id: row.approver_role_id,
  approval_levels: row.approval_levels,
  requires_distinct_approvers: row.requires_distinct_approvers,
});

const toRow = (row: MatrixRow, rules: DoaRuleRecord[]): DoaMatrixRow => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  legalBasis: row.legal_basis_ref,
  createdBy: row.created_by,
  lastEditedBy: row.last_edited_by,
  approvedBy: row.approved_by,
  publishedAt: row.published_at,
  version: Number(row.version),
  rules,
});

const REVISION_CURSOR = /^[0-9]{1,9}$/;

const lock = (tx: TenantTx, purpose: string): Promise<unknown> =>
  tx.query(`select pg_advisory_xact_lock(hashtextextended($1::text || ':' || coalesce(current_setting('app.tenant_id', true), ''), 0))`, [purpose]);

/**
 * The delegation-of-authority matrix (ST-ADM-011, ADM 3.6): a draft written by one administrator, submitted when its bands
 * run from 0 to no end without gap or overlap, approved by a second person, and then the matrix in force from its start day.
 * A version that is not a draft never changes; approving the next version supersedes the one in force in the same
 * transaction. Every query runs inside the caller's tenant transaction, so row-level security keeps tenants apart.
 */
export class DoaMatrixStore {
  /** Refuses rules that name a unit or a role the tenant does not have: 422 DOA_MATRIX_INVALID with the position of each. */
  private async referenceFindings(tx: TenantTx, rules: readonly DoaRuleContent[]): Promise<DoaFinding[]> {
    const units = new Set(
      (
        await tx.query<{ id: string }>("select id from machvon.organization_unit where id = any($1::uuid[]) and status not in ('Superseded', 'Dissolved')", [
          [...new Set(rules.map((rule) => rule.unit_id))],
        ])
      ).map((row) => row.id),
    );
    const roles = new Set(
      (
        await tx.query<{ id: string }>("select id from machvon.role_definition where id = any($1::uuid[]) and status = 'Active'", [
          [...new Set(rules.map((rule) => rule.approver_role_id))],
        ])
      ).map((row) => row.id),
    );
    return rules.flatMap((rule, index) => [
      ...(units.has(rule.unit_id) ? [] : [unknownReferenceFinding(index, 'unit_id')]),
      ...(roles.has(rule.approver_role_id) ? [] : [unknownReferenceFinding(index, 'approver_role_id')]),
    ]);
  }

  private async insertRules(tx: TenantTx, matrixId: string, rules: readonly DoaRuleContent[]): Promise<void> {
    await tx.query(
      `insert into machvon.doa_rule
         (tenant_id, id, matrix_version_id, position, document_type, unit_id, include_subtree, amount_min_vnd, amount_max_vnd, approver_role_id, approval_levels, requires_distinct_approvers)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, (e.position - 1)::int, e.rule->>'document_type', (e.rule->>'unit_id')::uuid,
              coalesce((e.rule->>'include_subtree')::boolean, true), (e.rule->>'amount_min_vnd')::numeric, (e.rule->>'amount_max_vnd')::numeric,
              (e.rule->>'approver_role_id')::uuid, coalesce((e.rule->>'approval_levels')::int, 1), coalesce((e.rule->>'requires_distinct_approvers')::boolean, true)
         from jsonb_array_elements($2::jsonb) with ordinality as e(rule, position)`,
      [matrixId, JSON.stringify(rules)],
    );
  }

  /** The findings that keep a draft from being stored: its dates, the shape and overlap of its bands, and the units and roles it names. */
  private async draftProblems(tx: TenantTx, input: DoaMatrixInput): Promise<DoaFinding[]> {
    const own = [...headerFindings(input.effective_from, input.effective_until), ...draftFindings(input.rules)];
    if (own.length > 0) return own;
    return this.referenceFindings(tx, input.rules);
  }

  /** Writes the next draft revision of the tenant. Revisions are numbered without gaps, one writer at a time. */
  async createDraft(tx: TenantTx, input: DoaMatrixInput, createdBy: string): Promise<{ id: string; revision: number; version: number }> {
    refuseDoa(await this.draftProblems(tx, input));
    await lock(tx, 'doa_matrix_draft');
    const rows = await tx.query<{ id: string; revision: number }>(
      `insert into machvon.doa_matrix_version
         (tenant_id, id, revision, status, effective_from, effective_until, legal_basis_ref, created_by, last_edited_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(),
               (select coalesce(max(revision), 0) + 1 from machvon.doa_matrix_version), 'Draft', $1::date, $2::date, $3, $4::uuid, $4::uuid, 1)
       returning id, revision`,
      [input.effective_from, input.effective_until ?? null, input.legal_basis_ref, createdBy],
    );
    const created = rows[0] as { id: string; revision: number };
    await this.insertRules(tx, created.id, input.rules);
    return { id: created.id, revision: created.revision, version: 1 };
  }

  private async rulesOf(tx: TenantTx, id: string): Promise<DoaRuleRecord[]> {
    const rows = await tx.query<RuleRow>(
      `select ${RULE_COLUMNS} from machvon.doa_rule where matrix_version_id = $1::uuid order by position, id`,
      [id],
    );
    return rows.map(toRule);
  }

  /** A version with its rules, or undefined when the tenant has no such version. */
  async find(tx: TenantTx, id: string): Promise<DoaMatrixRow | undefined> {
    const rows = await tx.query<MatrixRow>(`select ${MATRIX_COLUMNS} from machvon.doa_matrix_version where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0], await this.rulesOf(tx, id));
  }

  /** Keyset page of the versions with their rules, newest revision first. The caller asks for one more row than it shows. */
  async list(tx: TenantTx, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<DoaMatrixRow[]> {
    const { after } = request;
    if (after !== undefined && !REVISION_CURSOR.test(after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await tx.query<MatrixRow>(
      `select ${MATRIX_COLUMNS} from machvon.doa_matrix_version
        where ($1::int is null or (revision, id) < ($1::int, $2::uuid))
        order by revision desc, id desc
        limit $3`,
      [after === undefined ? null : Number(after.code), after?.id ?? null, request.limit],
    );
    const rules = await tx.query<RuleRow & { matrix_version_id: string }>(
      `select ${RULE_COLUMNS}, matrix_version_id from machvon.doa_rule where matrix_version_id = any($1::uuid[]) order by position, id`,
      [rows.map((row) => row.id)],
    );
    return rows.map((row) => toRow(row, rules.filter((rule) => rule.matrix_version_id === row.id).map(toRule)));
  }

  /**
   * Locks a version for a change. One that is not there is 404, a stale version is 409 VERSION_CONFLICT. The state is checked by the caller
   * with the code of the command (a draft is edited and submitted, a pending version is decided).
   */
  private async lockVersion(tx: TenantTx, id: string, expectedVersion: number, mustBe: DoaMatrixStatus, stateCode: string): Promise<DoaMatrixRow> {
    const rows = await tx.query<MatrixRow>(`select ${MATRIX_COLUMNS} from machvon.doa_matrix_version where id = $1::uuid for update`, [id]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (rows[0].status !== mustBe) throw new DomainError(stateCode, 409);
    const matrix = toRow(rows[0], await this.rulesOf(tx, id));
    if (matrix.version !== expectedVersion) throw versionConflict(matrix.version);
    return matrix;
  }

  /** Replaces a draft as a whole (its dates, its legal basis and all its rules). Only a draft can be edited: 409 DOA_MATRIX_NOT_DRAFT. */
  async updateDraft(tx: TenantTx, id: string, expectedVersion: number, input: DoaMatrixInput, editor: string): Promise<{ version: number }> {
    await this.lockVersion(tx, id, expectedVersion, 'Draft', 'DOA_MATRIX_NOT_DRAFT');
    refuseDoa(await this.draftProblems(tx, input));
    await tx.query('delete from machvon.doa_rule where matrix_version_id = $1::uuid', [id]);
    await this.insertRules(tx, id, input.rules);
    const rows = await tx.query<{ version: string }>(
      `update machvon.doa_matrix_version
          set effective_from = $2::date, effective_until = $3::date, legal_basis_ref = $4, last_edited_by = $5::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [id, input.effective_from, input.effective_until ?? null, input.legal_basis_ref, editor],
    );
    return { version: Number((rows[0] as { version: string }).version) };
  }

  /** Submits a draft for approval (BR-ADM-04): the bands of every document type and unit run from 0 to no end without gap or overlap. */
  async submit(tx: TenantTx, id: string, expectedVersion: number, editor: string): Promise<{ version: number }> {
    const draft = await this.lockVersion(tx, id, expectedVersion, 'Draft', 'DOA_MATRIX_NOT_DRAFT');
    refuseDoa(submitFindings(draft.rules));
    refuseDoa(await this.referenceFindings(tx, draft.rules));
    const rows = await tx.query<{ version: string }>(
      "update machvon.doa_matrix_version set status = 'PendingApproval', last_edited_by = $2::uuid, version = version + 1 where id = $1::uuid returning version::text as version",
      [id, editor],
    );
    return { version: Number((rows[0] as { version: string }).version) };
  }

  /**
   * Decides a version waiting for approval. Approving needs a second person: neither the author nor whoever last wrote the draft
   * (403 SELF_APPROVAL_DENIED). The units and roles are checked again, and the version must start after the one in force (it
   * ends that one on its first day). Returning sends it back to Draft; rejecting ends it.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, decision: DoaDecision, decidedBy: string): Promise<DoaDecisionResult> {
    const pending = await this.lockVersion(tx, id, expectedVersion, 'PendingApproval', 'DOA_STATE_INVALID');
    if (decision === 'approve') return this.approve(tx, pending, decidedBy);
    const status = decision === 'return' ? 'Draft' : 'Rejected';
    const rows = await tx.query<{ version: string }>("update machvon.doa_matrix_version set status = $2, version = version + 1 where id = $1::uuid returning version::text as version", [id, status]);
    return {
      status: decision === 'return' ? 'RETURNED' : 'REJECTED',
      version: Number((rows[0] as { version: string }).version),
      supersededId: undefined,
      revision: pending.revision,
      effectiveFrom: pending.effectiveFrom,
    };
  }

  private async approve(tx: TenantTx, pending: DoaMatrixRow, approvedBy: string): Promise<DoaDecisionResult> {
    assertFourEyes(pending.createdBy, approvedBy);
    if (pending.lastEditedBy !== null) assertFourEyes(pending.lastEditedBy, approvedBy);
    refuseDoa(submitFindings(pending.rules));
    refuseDoa(await this.referenceFindings(tx, pending.rules));
    // Two approvals of different versions lock different rows: the tenant-wide lock makes the second one wait for the first and then
    // see the version it published, instead of failing on the one-Published-per-tenant index.
    await lock(tx, 'doa_matrix_publication');
    const inForce = (await tx.query<{ id: string; effective_from: string; effective_until: string | null }>(
      "select id, effective_from::text as effective_from, effective_until::text as effective_until from machvon.doa_matrix_version where status = 'Published' for update",
    ))[0];
    if (inForce !== undefined && pending.effectiveFrom <= inForce.effective_from) refuseDoa([notAfterCurrentFinding()]);
    if (inForce !== undefined) {
      await tx.query(
        `update machvon.doa_matrix_version
            set status = 'Superseded', effective_until = least(coalesce(effective_until, $2::date), $2::date), version = version + 1
          where id = $1::uuid`,
        [inForce.id, pending.effectiveFrom],
      );
    }
    const rows = await tx.query<{ version: string }>(
      "update machvon.doa_matrix_version set status = 'Published', approved_by = $2::uuid, published_at = now(), version = version + 1 where id = $1::uuid returning version::text as version",
      [pending.id, approvedBy],
    );
    return { status: 'PUBLISHED', version: Number((rows[0] as { version: string }).version), supersededId: inForce?.id, revision: pending.revision, effectiveFrom: pending.effectiveFrom };
  }

  /**
   * Who approves a document (BR-ADM-03, the in-process contract of the approval engine): the matrix in force on the business date,
   * the nearest unit that has a rule for the document type, and in it the band that holds the amount. The answer names the matrix
   * version, which a running instance pins. 422 `DOA_RULE_NOT_FOUND` when nothing applies.
   */
  async resolve(tx: TenantTx, query: DoaQuery): Promise<DoaResolution> {
    const matrices = await tx.query<{ id: string; status: string; effective_from: string; effective_until: string | null }>(
      `select id, status, effective_from::text as effective_from, effective_until::text as effective_until
         from machvon.doa_matrix_version
        where status in ('Published', 'Superseded') and effective_from <= $1::date and (effective_until is null or $1::date < effective_until)`,
      [query.businessDate],
    );
    const rules = await tx.query<RuleRow & { matrix_version_id: string }>(
      `select ${RULE_COLUMNS}, matrix_version_id from machvon.doa_rule where matrix_version_id = any($1::uuid[]) and document_type = $2`,
      [matrices.map((matrix) => matrix.id), query.documentType],
    );
    const unitIds = [...new Set([query.unitId, ...rules.map((rule) => rule.unit_id)])];
    const paths = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = any($1::uuid[])', [unitIds]);
    const records: DoaMatrixRecord[] = matrices.map((matrix) => ({
      id: matrix.id,
      status: matrix.status,
      effectiveFrom: matrix.effective_from,
      effectiveUntil: matrix.effective_until,
      rules: rules.filter((rule) => rule.matrix_version_id === matrix.id).map(toRule),
    }));
    return resolveDoa(records, new Map(paths.map((unit) => [unit.id, unit.path])), query);
  }
}
