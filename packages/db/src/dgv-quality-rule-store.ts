import { randomUUID } from 'node:crypto';
import { ACTIONS_ON_FAIL, CRITICALITY_WEIGHT_MAX, CRITICALITY_WEIGHT_MIN, DomainError, QUALITY_DIMENSIONS, RULE_SEVERITIES, assertFourEyes, parseQualityThreshold, validateQualityExpression, versionConflict } from '@machvon/kernel';
import type { ActionOnFail, QualityDimension, QualityExpr, RuleSeverity } from '@machvon/kernel';
import { DATASET_VISIBLE } from './dgv-dataset-store.ts';
import type { DatasetViewer } from './dgv-dataset-store.ts';
import { qualitySourceOf } from './dgv-quality-source.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_CODE = 80;
const MIN_CODE = 2;
const MAX_FIELD_PATH = 300;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type QualityRuleStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
export const QUALITY_RULE_STATUSES: readonly QualityRuleStatus[] = ['DRAFT', 'APPROVED', 'SUPERSEDED'];

export interface QualityRuleRow {
  id: string;
  contractId: string;
  datasetId: string;
  datasetCode: string;
  code: string;
  revision: number;
  dimension: QualityDimension;
  fieldPath: string | null;
  expressionAst: Record<string, unknown>;
  severity: RuleSeverity;
  thresholdJson: Record<string, unknown>;
  actionOnFail: ActionOnFail;
  criticalityWeight: number;
  status: QualityRuleStatus;
  createdBy: string;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /** Creation time to the microsecond (UTC): the ordering key of the history of a rule. */
  createdAt: string;
  version: number;
  /** The ordering key of the list and its cursor. */
  listKey: string;
}

export interface QualityRuleDraftInput {
  contractId: string;
  code: string;
  dimension: string;
  fieldPath?: string | undefined;
  expressionAst: unknown;
  severity: string;
  thresholdJson: unknown;
  actionOnFail: string;
  criticalityWeight: number;
}

export interface QualityRuleFilter {
  datasetId?: string | undefined;
  status?: QualityRuleStatus | undefined;
}

/** The draft as it was stored: the values after trimming and normalising, which the audit row and the event carry. */
export interface QualityRuleDraft {
  id: string;
  revision: number;
  version: number;
  datasetId: string;
  datasetCode: string;
  isCritical: boolean;
  contractId: string;
  code: string;
  dimension: QualityDimension;
  fieldPath: string | null;
  expressionAst: QualityExpr;
  severity: RuleSeverity;
  thresholdJson: Record<string, string>;
  actionOnFail: ActionOnFail;
  criticalityWeight: number;
}

export interface QualityRuleApproval {
  id: string;
  datasetId: string;
  contractId: string;
  code: string;
  revision: number;
  dimension: QualityDimension;
  author: string;
  version: number;
  /** The versions of the same rule that this approval superseded (the approved one and the older drafts). */
  supersededIds: string[];
}

interface SqlRow {
  id: string;
  contract_id: string;
  dataset_id: string;
  dataset_code: string;
  code: string;
  revision: number;
  dimension: QualityDimension;
  field_path: string | null;
  expression_ast: Record<string, unknown>;
  severity: RuleSeverity;
  threshold_json: Record<string, unknown>;
  action_on_fail: ActionOnFail;
  criticality_weight: number;
  status: QualityRuleStatus;
  created_by: string;
  created_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  created_at: string;
  version: string;
  list_key: string;
}

const KEY_SQL = `(r.code || '#' || lpad(r.revision::text, 6, '0'))`;
const TIME_SQL = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SELECT = `select r.id, r.contract_id, r.dataset_id, d.dataset_code, r.code, r.revision, r.dimension, r.field_path, r.expression_ast, r.severity, r.threshold_json,
  r.action_on_fail, r.criticality_weight, r.status, r.created_by, cd.display_name as created_by_name, r.approved_by, ad.display_name as approved_by_name,
  ${TIME_SQL('r.approved_at')} as approved_at, ${TIME_SQL('r.created_at')} as created_at, r.version::text as version, ${KEY_SQL} as list_key
  from machvon.quality_rule_version r
  join machvon.dataset d on d.tenant_id = r.tenant_id and d.id = r.dataset_id
  left join machvon.tenant_user_directory cd on cd.tenant_id = r.tenant_id and cd.membership_id = r.created_by
  left join machvon.tenant_user_directory ad on ad.tenant_id = r.tenant_id and ad.membership_id = r.approved_by`;

const toRow = (row: SqlRow): QualityRuleRow => ({
  id: row.id,
  contractId: row.contract_id,
  datasetId: row.dataset_id,
  datasetCode: row.dataset_code,
  code: row.code,
  revision: row.revision,
  dimension: row.dimension,
  fieldPath: row.field_path,
  expressionAst: row.expression_ast,
  severity: row.severity,
  thresholdJson: row.threshold_json,
  actionOnFail: row.action_on_fail,
  criticalityWeight: row.criticality_weight,
  status: row.status,
  createdBy: row.created_by,
  createdByName: row.created_by_name,
  approvedBy: row.approved_by,
  approvedByName: row.approved_by_name,
  approvedAt: row.approved_at,
  createdAt: row.created_at,
  version: Number(row.version),
  listKey: row.list_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function oneOf<T extends string>(list: readonly T[], value: string, field: string): T {
  const found = list.find((item) => item === value);
  if (found === undefined) throw invalid(field);
  return found;
}

/** A rule code as it is stored: trimmed, 2 to 80 characters, no control characters. */
function codeOf(value: string): string {
  const code = value.trim();
  if (code.length < MIN_CODE || code.length > MAX_CODE || CONTROL.test(code)) throw invalid('code');
  return code;
}

interface ContractRow {
  dataset_id: string | null;
  dataset_code: string;
  producer_module: string;
  status: string;
  is_critical: boolean;
}

/**
 * The quality rules of the datasets (ST-DGV-002, DGV 3.3 F3): each rule is a version written by one person and approved by another, in an
 * expression the engine allows and with a threshold it can judge. A version never changes once it is written; approving it supersedes the
 * version it replaces, so the runs that applied the older one stay true to what was measured.
 */
export class DgvQualityRuleStore {
  /** Writes a draft version of the rule `code` on the contract; a code that exists gets the next revision. */
  async create(tx: TenantTx, input: QualityRuleDraftInput, viewer: DatasetViewer): Promise<QualityRuleDraft> {
    const code = codeOf(input.code);
    const dimension = oneOf(QUALITY_DIMENSIONS, input.dimension, 'dimension');
    const severity = oneOf(RULE_SEVERITIES, input.severity, 'severity');
    const action = oneOf(ACTIONS_ON_FAIL, input.actionOnFail, 'action_on_fail');
    if (!Number.isInteger(input.criticalityWeight) || input.criticalityWeight < CRITICALITY_WEIGHT_MIN || input.criticalityWeight > CRITICALITY_WEIGHT_MAX) throw invalid('criticality_weight');
    const fieldPath = input.fieldPath === undefined || input.fieldPath.trim() === '' ? null : input.fieldPath.trim();
    if (fieldPath !== null && (fieldPath.length > MAX_FIELD_PATH || CONTROL.test(fieldPath))) throw invalid('field_path');

    // A contract of the tenant that is bound to a dataset the writer may see; anything else is a contract that does not exist for the writer.
    const contracts = await tx.query<ContractRow>(
      `select c.dataset_id, d.dataset_code, d.producer_module, d.status, d.is_critical
         from machvon.dataset_contract c join machvon.dataset d on d.tenant_id = c.tenant_id and d.id = c.dataset_id
        where c.id = $3::uuid and ${DATASET_VISIBLE}`,
      [viewer.membershipId, [...viewer.roleCodes], input.contractId],
    );
    const contract = contracts[0];
    if (contract === undefined || contract.dataset_id === null) throw invalid('contract_id');
    if (contract.status === 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const source = qualitySourceOf(contract.producer_module);
    if (source === undefined) throw invalid('contract_id');

    const { ast, fields } = validateQualityExpression(dimension, input.expressionAst, source.shape);
    const threshold = parseQualityThreshold(input.thresholdJson, dimension);
    if (dimension === 'INTEGRITY' && action === 'WARN') throw invalid('action_on_fail');
    if (fieldPath !== null && !fields.includes(fieldPath)) throw invalid('field_path');

    // Two drafts of one code at the same moment would both want the next revision: they take turns.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('dgv-rule:' || current_setting('app.tenant_id') || ':' || $1::text || ':' || $2::text, 0))", [input.contractId, code]);
    const latest = await tx.query<{ revision: number }>('select coalesce(max(revision), 0) as revision from machvon.quality_rule_version where contract_id = $1::uuid and code = $2', [input.contractId, code]);
    const revision = (latest[0]?.revision ?? 0) + 1;
    const id = randomUUID();
    const storedPath = fieldPath ?? fields[0] ?? null;
    await tx.query(
      `insert into machvon.quality_rule_version
         (tenant_id, id, contract_id, dataset_id, code, revision, expression_ast, severity, threshold_json, status, dimension, field_path, action_on_fail, criticality_weight, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8::jsonb, 'DRAFT', $9, $10, $11, $12, $13::uuid)`,
      [id, input.contractId, contract.dataset_id, code, revision, JSON.stringify(ast), severity, JSON.stringify(threshold.json), dimension, storedPath, action, input.criticalityWeight, viewer.membershipId],
    );
    return {
      id,
      revision,
      version: 1,
      datasetId: contract.dataset_id,
      datasetCode: contract.dataset_code,
      isCritical: contract.is_critical,
      contractId: input.contractId,
      code,
      dimension,
      fieldPath: storedPath,
      expressionAst: ast,
      severity,
      thresholdJson: threshold.json,
      actionOnFail: action,
      criticalityWeight: input.criticalityWeight,
    };
  }

  /**
   * Approves a draft against the version the approver read. The author never approves their own draft (403 SELF_APPROVAL_DENIED); a draft
   * that is not the newest revision of its code cannot be approved over a newer approved one. The approved version it replaces, and the
   * older drafts of the code, are superseded in the same step.
   */
  async approve(tx: TenantTx, id: string, expectedVersion: number, viewer: DatasetViewer): Promise<QualityRuleApproval> {
    const rows = await tx.query<SqlRow>(`${SELECT} where r.id = $3::uuid and ${DATASET_VISIBLE} for update of r`, [viewer.membershipId, [...viewer.roleCodes], id]);
    const locked = rows[0];
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const version = Number(locked.version);
    if (version !== expectedVersion) throw versionConflict(version);
    assertFourEyes(locked.created_by, viewer.membershipId);
    if (locked.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const newer = await tx.query<{ id: string }>(
      "select id from machvon.quality_rule_version where contract_id = $1::uuid and code = $2 and revision > $3 and status in ('APPROVED', 'SUPERSEDED') limit 1",
      [locked.contract_id, locked.code, locked.revision],
    );
    if (newer[0] !== undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const superseded = await tx.query<{ id: string }>(
      `update machvon.quality_rule_version set status = 'SUPERSEDED', version = version + 1
        where contract_id = $1::uuid and code = $2 and revision < $3 and status in ('APPROVED', 'DRAFT') returning id`,
      [locked.contract_id, locked.code, locked.revision],
    );
    await tx.query(`update machvon.quality_rule_version set status = 'APPROVED', approved_by = $2::uuid, approved_at = now(), version = version + 1 where id = $1::uuid`, [id, viewer.membershipId]);
    return {
      id,
      datasetId: locked.dataset_id,
      contractId: locked.contract_id,
      code: locked.code,
      revision: locked.revision,
      dimension: locked.dimension,
      author: locked.created_by,
      version: version + 1,
      supersededIds: superseded.map((row) => row.id).sort(),
    };
  }

  /** The rule with this id when the viewer may see its dataset. */
  async find(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<QualityRuleRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where r.id = $3::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The rules of the datasets the viewer may see, by code and revision; the page after `after` when given. */
  async list(tx: TenantTx, viewer: DatasetViewer, filter: QualityRuleFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<QualityRuleRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ${DATASET_VISIBLE} and ($3::uuid is null or r.dataset_id = $3::uuid) and ($4::text is null or r.status = $4)
          and ($5::text is null or (${KEY_SQL}, r.id) > ($5::text, $6::uuid))
        order by ${KEY_SQL}, r.id limit $7`,
      [viewer.membershipId, [...viewer.roleCodes], filter.datasetId ?? null, filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** The approved versions of a contract, which a run applies. */
  async approvedOfContract(tx: TenantTx, contractId: string): Promise<Array<{ id: string }>> {
    return tx.query<{ id: string }>("select id from machvon.quality_rule_version where contract_id = $1::uuid and status = 'APPROVED' order by code, id", [contractId]);
  }
}
