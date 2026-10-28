import { randomUUID } from 'node:crypto';
import { DomainError, columnMasksProblem, predicateProblem, requireApplicablePolicies } from '@machvon/kernel';
import type { PolicyGranteeKind } from '@machvon/kernel';
import { datasetDimensions } from './bi-metric-store.ts';
import type { TenantTx } from './tenant-database.ts';

export type BiPolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

export interface PolicyRow {
  id: string;
  datasetId: string;
  revision: number;
  granteeKind: PolicyGranteeKind;
  granteeRefId: string;
  rowPredicate: Record<string, unknown>;
  columnMasks: Record<string, string>;
  status: BiPolicyStatus;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface PolicyInput {
  datasetId: string;
  granteeKind: PolicyGranteeKind;
  granteeRefId: string;
  rowPredicate: unknown;
  columnMasks: unknown;
  actor: string;
}

/** Who a query is made by, as far as policies are concerned: the roles they hold, the units they are in (their own and the ones above it), and themselves. */
export interface Requester {
  membershipId: string;
  roleIds: readonly string[];
  unitIds: readonly string[];
}

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const SELECT = `select p.id, p.dataset_id, p.revision, p.grantee_kind, p.grantee_ref_id, p.row_predicate_ast, p.column_masks, p.status, p.approved_by, p.created_by, p.created_at, p.version::text as version
  from machvon.bi_access_policy p`;

const toRow = (row: Sql): PolicyRow => ({
  id: row.id,
  datasetId: row.dataset_id,
  revision: row.revision,
  granteeKind: row.grantee_kind,
  granteeRefId: row.grantee_ref_id,
  rowPredicate: row.row_predicate_ast,
  columnMasks: row.column_masks,
  status: row.status,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  version: Number(row.version),
});

const GRANTEE_TABLE: Readonly<Record<PolicyGranteeKind, string>> = { ROLE: 'machvon.role_definition', UNIT_TREE: 'machvon.organization_unit', MEMBERSHIP: 'machvon.membership' };

/**
 * The access policies of BI (ST-BI-003, BI BR-BI-05): a policy says, for a role, a unit and everything under it, or one membership, which rows of a dataset may be read and which columns are hidden. It is drafted
 * by one person and made ACTIVE by another (the owner of the data): nobody activates what they wrote. The predicate is checked against the dimensions of the dataset, and is ANDed with the scope of the person at
 * query time, so a policy can narrow the grants and never widen them. With no ACTIVE policy for a person the dataset is closed to them.
 */
export class BiPolicyStore {
  async list(tx: TenantTx, filter: { datasetId?: string | undefined; status?: string | undefined }): Promise<PolicyRow[]> {
    const rows = await tx.query<Sql>(`${SELECT} where ($1::uuid is null or p.dataset_id = $1::uuid) and ($2::text is null or p.status = $2) order by p.dataset_id, p.grantee_kind, p.grantee_ref_id, p.revision`, [filter.datasetId ?? null, filter.status ?? null]);
    return rows.map(toRow);
  }

  async find(tx: TenantTx, id: string): Promise<PolicyRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where p.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  private async lockGrantee(tx: TenantTx, datasetId: string, granteeRefId: string): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bi_policy:' || current_setting('app.tenant_id', true) || ':' || $1 || ':' || $2, 0))", [datasetId, granteeRefId]);
  }

  /** Drafts the next revision of the policy for a dataset and grantee. Nothing is allowed by a draft. */
  async create(tx: TenantTx, input: PolicyInput): Promise<PolicyRow> {
    const datasets = await tx.query<{ join_paths: unknown; status: string }>('select join_paths, status from machvon.bi_dataset where id = $1::uuid', [input.datasetId]);
    if (datasets[0] === undefined || datasets[0].status !== 'ACTIVE') throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
    const dimensions = datasetDimensions(datasets[0].join_paths);
    const predicate = predicateProblem(input.rowPredicate, dimensions);
    if (predicate !== undefined) throw new DomainError(predicate.code, 422, predicate.field);
    const masks = columnMasksProblem(input.columnMasks);
    if (masks !== undefined) throw new DomainError(masks.code, 422, masks.field);
    const grantee = await tx.query<{ id: string }>(`select id from ${GRANTEE_TABLE[input.granteeKind]} where id = $1::uuid`, [input.granteeRefId]);
    if (grantee[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'grantee_ref_id');
    await this.lockGrantee(tx, input.datasetId, input.granteeRefId);
    const last = await tx.query<{ revision: number }>('select max(revision) as revision from machvon.bi_access_policy where dataset_id = $1::uuid and grantee_kind = $2 and grantee_ref_id = $3::uuid', [
      input.datasetId,
      input.granteeKind,
      input.granteeRefId,
    ]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.bi_access_policy (tenant_id, id, dataset_id, revision, grantee_kind, grantee_ref_id, row_predicate_ast, column_masks, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4, $5::uuid, $6::jsonb, $7::jsonb, 'DRAFT', $8::uuid, $8::uuid)`,
      [id, input.datasetId, (last[0]?.revision ?? 0) + 1, input.granteeKind, input.granteeRefId, JSON.stringify(input.rowPredicate), JSON.stringify(input.columnMasks), input.actor],
    );
    return (await this.find(tx, id)) as PolicyRow;
  }

  /**
   * Makes a draft ACTIVE for good, by someone other than its author (SELF_APPROVAL_DENIED): the policy that was active for the same dataset and grantee is retired in the same moment, so a grantee never has two.
   * The path to it is the decision on a publication request (ST-BI-006).
   */
  async activate(tx: TenantTx, id: string, approver: string): Promise<PolicyRow> {
    const named = await this.find(tx, id);
    if (named === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // Two activations for one dataset and grantee are taken one after the other (the lock of drafting too): the status is read after the other one is done, so a grantee never has two active policies.
    await this.lockGrantee(tx, named.datasetId, named.granteeRefId);
    const draft = (await this.find(tx, id)) as PolicyRow;
    if (draft.createdBy === approver) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (draft.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    await tx.query("update machvon.bi_access_policy set status = 'RETIRED', updated_at = now(), updated_by = $4::uuid, version = version + 1 where dataset_id = $1::uuid and grantee_kind = $2 and grantee_ref_id = $3::uuid and status = 'ACTIVE'", [
      draft.datasetId,
      draft.granteeKind,
      draft.granteeRefId,
      approver,
    ]);
    await tx.query("update machvon.bi_access_policy set status = 'ACTIVE', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, approver]);
    return (await this.find(tx, id)) as PolicyRow;
  }

  /** The ACTIVE policies that apply to a requester for a dataset; none is ACCESS_POLICY_MISSING (403), never an empty list that could be read as "no data". */
  async applicable(tx: TenantTx, datasetId: string, requester: Requester): Promise<PolicyRow[]> {
    const rows = await tx.query<Sql>(
      `${SELECT}
        where p.dataset_id = $1::uuid and p.status = 'ACTIVE'
          and ((p.grantee_kind = 'ROLE' and p.grantee_ref_id = any($2::uuid[]))
            or (p.grantee_kind = 'UNIT_TREE' and p.grantee_ref_id = any($3::uuid[]))
            or (p.grantee_kind = 'MEMBERSHIP' and p.grantee_ref_id = $4::uuid))
        order by p.grantee_kind, p.grantee_ref_id`,
      [datasetId, [...requester.roleIds], [...requester.unitIds], requester.membershipId],
    );
    return [...requireApplicablePolicies(rows.map(toRow))];
  }
}
