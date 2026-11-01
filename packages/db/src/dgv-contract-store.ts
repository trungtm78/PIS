import { randomUUID } from 'node:crypto';
import { DomainError, classifyChange, migrationWindowEnough, odcsSha256, parseOdcs, requiredConsumers } from '@machvon/kernel';
import type { Compatibility, ContractChange, ContractColumn, ContractConsumer } from '@machvon/kernel';
import { DATASET_VISIBLE } from './dgv-dataset-store.ts';
import type { DatasetViewer } from './dgv-dataset-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const CONTRACT_RESOURCE = 'dataset_contract';
export const CONTRACT_VERSION_RESOURCE = 'data_contract_version';
export const CONSUMER_APPROVAL_RESOURCE = 'contract_consumer_approval';

const UNIQUE_VIOLATION = '23505';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COMMENT = 2000;

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type DgvContractStatus = 'DRAFT' | 'IN_REVIEW' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'RETURNED';
export type DgvApprovalDecision = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface DgvConsumerApproval {
  id: string;
  contractId: string;
  consumerKind: string;
  consumerRef: string;
  consumerOwnerId: string;
  consumerOwnerName: string | null;
  decision: DgvApprovalDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  version: number;
}

/** A revision of a contract: the working copy that is reviewed, and then published. */
export interface DgvContractRevision {
  id: string;
  datasetId: string | null;
  datasetCode: string;
  revision: number;
  status: DgvContractStatus;
  odcsVersion: string | null;
  compatibility: Compatibility | null;
  effectiveFrom: string | null;
  freshnessSeconds: number;
  classification: string;
  ownerId: string;
  createdBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  version: number;
  columns: ContractColumn[];
  approvals: DgvConsumerApproval[];
}

export interface DgvContractDetail extends DgvContractRevision {
  odcs: unknown;
  changes: ContractChange[];
}

/** A published version: written once, with the hash of its document. */
export interface DgvContractVersion {
  id: string;
  datasetId: string;
  datasetCode: string;
  contractId: string | null;
  revision: number;
  grain: string;
  ownerId: string;
  compatibility: Compatibility | null;
  odcsSha256: string | null;
  odcsObjectKey: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  supersedesId: string | null;
  migrationWindowUntil: string | null;
  /** The version is the one the dataset stands on now, or the one before it while the window of a breaking change lasts. */
  serving: boolean;
  /** The last day the version serves, when it serves only for the window of the one that replaced it. */
  servingUntil: string | null;
  columns: ContractColumn[];
}

export interface DgvRevisionInput {
  datasetId: string;
  odcsVersion: string;
  odcs: unknown;
  effectiveFrom: string;
}

export interface DgvPublishInput {
  /** The day the old revision serves until, for a breaking change. */
  migrationWindowUntil: string | undefined;
  versionId: string;
  /** Stores the document of the revision as a file and gives its key; called when the version is about to be written, never for a publication that is refused. */
  storeDocument: (odcs: unknown) => Promise<string | null>;
  today: string;
}

/** What a publication came to: the version, or the consumers that became known since the revision was drafted and now have to approve it. */
export type DgvPublishOutcome =
  | { kind: 'PUBLISHED'; contract: DgvContractRevision; version: DgvContractVersion; supersededId: string | null; sha256: string }
  | { kind: 'CONSUMERS_ADDED'; contract: DgvContractRevision; waiting: Array<{ kind: string; ref: string; decision: DgvApprovalDecision }> };

export interface DgvContractFilter {
  datasetId?: string | undefined;
  status?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

const iso = (value: unknown): string => new Date(value as string).toISOString();
const toColumns = (json: unknown): ContractColumn[] =>
  typeof json === 'object' && json !== null && Array.isArray((json as { columns?: unknown }).columns) ? (json as { columns: ContractColumn[] }).columns : [];

const approvalOf = (row: Sql): DgvConsumerApproval => ({
  id: row.id,
  contractId: row.contract_id,
  consumerKind: row.consumer_kind,
  consumerRef: row.consumer_ref,
  consumerOwnerId: row.consumer_owner_user_id,
  consumerOwnerName: row.owner_name ?? null,
  decision: row.decision,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at === null ? null : iso(row.decided_at),
  comment: row.comment,
  version: Number(row.version),
});

const APPROVAL_SELECT = `select a.id, a.contract_id, a.consumer_kind, a.consumer_ref, a.consumer_owner_user_id, od.display_name as owner_name, a.decision, a.decided_by, a.decided_at, a.comment, a.version::text as version
  from machvon.contract_consumer_approval a left join machvon.tenant_user_directory od on od.tenant_id = a.tenant_id and od.membership_id = a.consumer_owner_user_id`;

const REVISION_SELECT = `select c.id, c.dataset_id, c.dataset_code, c.revision, c.status, c.odcs_version, c.compatibility, c.effective_from::text as effective_from, c.freshness_seconds::text as freshness_seconds, c.classification,
  c.owner_id, c.created_by, c.approved_by, c.created_at, c.created_at::text as created_raw, c.version::text as version, c.schema_json, c.quality_json, c.odcs_json
  from machvon.dataset_contract c join machvon.dataset d on d.tenant_id = c.tenant_id and d.id = c.dataset_id`;

const VERSION_SELECT = `select v.id, v.dataset_id, d.dataset_code, v.contract_id, v.revision, v.grain, v.owner_id, v.compatibility, v.odcs_sha256, v.odcs_object_key, v.published_by, v.published_at, coalesce(v.published_at, 'epoch'::timestamptz)::text as published_raw, v.supersedes_id,
  v.migration_window_until::text as migration_window_until, v.schema_json,
  (d.current_contract_version_id = v.id or (nxt.migration_window_until is not null and nxt.migration_window_until >= $3::date)) as serving,
  case when d.current_contract_version_id = v.id then null else nxt.migration_window_until::text end as serving_until
  from machvon.data_contract_version v join machvon.dataset d on d.tenant_id = v.tenant_id and d.id = v.dataset_id
  left join lateral (select n.migration_window_until from machvon.data_contract_version n where n.tenant_id = v.tenant_id and n.supersedes_id = v.id and n.compatibility = 'BREAKING' order by n.revision limit 1) nxt on true`;

function versionOf(row: Sql): DgvContractVersion {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    datasetCode: row.dataset_code,
    contractId: row.contract_id,
    revision: Number(row.revision),
    grain: row.grain,
    ownerId: row.owner_id,
    compatibility: row.compatibility,
    odcsSha256: row.odcs_sha256,
    odcsObjectKey: row.odcs_object_key,
    publishedBy: row.published_by,
    publishedAt: row.published_at === null ? null : iso(row.published_at),
    supersedesId: row.supersedes_id,
    migrationWindowUntil: row.migration_window_until,
    serving: row.serving === true,
    servingUntil: row.serving_until,
    columns: toColumns(row.schema_json),
  };
}

/** A page of a keyset: the time as the database wrote it (microseconds, never through a date of the language that keeps milliseconds) and the id. */
function cursorOf(raw: string | undefined): { at: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
  return { at, id };
}
const cursorFor = (at: string, id: string): string => Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');

/**
 * The data contracts (ST-DGV-005, DGV 3.1 F2, BR-DGV-07): an ODCS document of the pinned version is drafted as a revision for a dataset and reviewed; its compatibility with the published version is worked out; a breaking
 * revision is approved by the owner of each consumer; somebody other than the person who drafted it publishes it, with a window in which the version before it still serves; a published version is written once.
 */
export class DgvContractStore {
  /** The dataset the viewer may see, with what a contract is made from. */
  private async datasetOf(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<Sql> {
    const rows = await tx.query<Sql>(
      `select d.id, d.dataset_code, d.grain, d.producer_module, d.owner_user_id, d.classification, d.freshness_slo_seconds, d.retention_policy_id, d.status, d.current_contract_version_id
         from machvon.dataset d where d.id = $3::uuid and ${DATASET_VISIBLE}`,
      [viewer.membershipId, [...viewer.roleCodes], id],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  /** The consumers of a dataset the platform knows of without the contract saying so: the datasets of BI built on it. */
  private async knownConsumers(tx: TenantTx, datasetId: string): Promise<ContractConsumer[]> {
    const rows = await tx.query<{ dataset_code: string; owner_user_id: string }>(
      "select dataset_code, owner_user_id from machvon.bi_dataset where dgv_dataset_id = $1::uuid and status <> 'DEPRECATED' order by dataset_code",
      [datasetId],
    );
    return rows.map((row) => ({ kind: 'BI_DATASET', ref: row.dataset_code, ownerUserId: row.owner_user_id }));
  }

  /** The people who are to answer for a consumer must be people of the tenant. */
  private async assertOwners(tx: TenantTx, consumers: readonly ContractConsumer[]): Promise<void> {
    if (consumers.length === 0) return;
    const ids = [...new Set(consumers.map((consumer) => consumer.ownerUserId))];
    const found = await tx.query<{ id: string }>('select id from machvon.membership where id = any($1::uuid[])', [ids]);
    if (found.length !== ids.length) throw new DomainError('ODCS_SCHEMA_INVALID', 422, 'customProperties');
  }

  /** The newest published version of a dataset with the document its contract was made from. */
  private async published(tx: TenantTx, datasetId: string): Promise<{ id: string; revision: number; columns: ContractColumn[]; consumers: ContractConsumer[] } | undefined> {
    const rows = await tx.query<Sql>(
      `select v.id, v.revision, v.schema_json, c.odcs_json, c.odcs_version from machvon.data_contract_version v left join machvon.dataset_contract c on c.tenant_id = v.tenant_id and c.id = v.contract_id
        where v.dataset_id = $1::uuid order by v.revision desc limit 1`,
      [datasetId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const consumers = row.odcs_json === null || row.odcs_version === null ? [] : parseOdcs(row.odcs_json, row.odcs_version).consumers;
    return { id: row.id, revision: Number(row.revision), columns: toColumns(row.schema_json), consumers };
  }

  /**
   * Drafts the next revision of the contract of a dataset from an ODCS document. The document is checked (422 `ODCS_SCHEMA_INVALID` naming the path), it is compared with the published version (BACKWARD_COMPATIBLE or
   * BREAKING; INITIAL when there is none), a breaking one asks the owner of each consumer to approve, and the revision is IN_REVIEW. One revision is open for a dataset at a time (409 `CONTRACT_REVISION_OPEN`).
   */
  async draft(tx: TenantTx, input: DgvRevisionInput, actor: string, viewer: DatasetViewer): Promise<DgvContractRevision> {
    if (!DATE.test(input.effectiveFrom) || Number.isNaN(Date.parse(`${input.effectiveFrom}T00:00:00.000Z`))) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
    const dataset = await this.datasetOf(tx, input.datasetId, viewer);
    const parsed = parseOdcs(input.odcs, input.odcsVersion);
    await this.assertOwners(tx, parsed.consumers);
    const open = await tx.query<{ id: string }>("select id from machvon.dataset_contract where dataset_id = $1::uuid and status = 'IN_REVIEW' and odcs_json is not null limit 1", [dataset.id]);
    if (open[0] !== undefined) throw new DomainError('CONTRACT_REVISION_OPEN', 409, 'dataset_id');
    const before = await this.published(tx, dataset.id);
    const { compatibility } = classifyChange(before?.columns, parsed.columns);
    const consumers = compatibility === 'BREAKING' ? requiredConsumers(before?.consumers ?? [], await this.knownConsumers(tx, dataset.id)) : [];
    await this.assertOwners(tx, consumers);
    const next = await tx.query<{ revision: number }>(
      'select greatest(coalesce((select max(revision) from machvon.dataset_contract where dataset_code = $1), 0), coalesce((select max(revision) from machvon.data_contract_version where dataset_id = $2::uuid), 0)) + 1 as revision',
      [dataset.dataset_code, dataset.id],
    );
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.dataset_contract
           (tenant_id, id, dataset_code, revision, owner_id, schema_json, quality_json, freshness_seconds, classification, status, dataset_id, odcs_version, odcs_json, producer_module, compatibility, effective_from, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::int, $4::uuid, $5::jsonb, $6::jsonb, $7::bigint, $8, 'IN_REVIEW', $9::uuid, $10, $11::jsonb, $12, $13, $14::date, $15::uuid)`,
        [
          id,
          dataset.dataset_code,
          Number(next[0]?.revision ?? 1),
          dataset.owner_user_id,
          JSON.stringify({ columns: parsed.columns }),
          JSON.stringify({ rules: parsed.quality }),
          parsed.freshnessSeconds ?? Number(dataset.freshness_slo_seconds),
          dataset.classification,
          dataset.id,
          input.odcsVersion,
          JSON.stringify(input.odcs),
          dataset.producer_module,
          compatibility,
          input.effectiveFrom,
          actor,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('CONTRACT_REVISION_OPEN', 409, 'dataset_id');
      throw error;
    }
    for (const consumer of consumers) {
      await tx.query(
        `insert into machvon.contract_consumer_approval (tenant_id, id, contract_id, consumer_kind, consumer_ref, consumer_owner_user_id, decision, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, 'PENDING', $6::uuid, $6::uuid)`,
        [randomUUID(), id, consumer.kind, consumer.ref, consumer.ownerUserId, actor],
      );
    }
    const made = await this.revision(tx, id);
    if (made === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return made;
  }

  private async approvalsOf(tx: TenantTx, contractIds: readonly string[]): Promise<Map<string, DgvConsumerApproval[]>> {
    const by = new Map<string, DgvConsumerApproval[]>();
    if (contractIds.length === 0) return by;
    const rows = await tx.query<Sql>(`${APPROVAL_SELECT} where a.contract_id = any($1::uuid[]) order by a.consumer_kind, a.consumer_ref`, [[...contractIds]]);
    for (const row of rows) by.set(row.contract_id, [...(by.get(row.contract_id) ?? []), approvalOf(row)]);
    return by;
  }

  private toRevision(row: Sql, approvals: DgvConsumerApproval[]): DgvContractRevision {
    return {
      id: row.id,
      datasetId: row.dataset_id,
      datasetCode: row.dataset_code,
      revision: Number(row.revision),
      status: row.status,
      odcsVersion: row.odcs_version,
      compatibility: row.compatibility,
      effectiveFrom: row.effective_from,
      freshnessSeconds: Number(row.freshness_seconds),
      classification: row.classification,
      ownerId: row.owner_id,
      createdBy: row.created_by,
      approvedBy: row.approved_by,
      createdAt: iso(row.created_at),
      version: Number(row.version),
      columns: toColumns(row.schema_json),
      approvals,
    };
  }

  /** A revision with no regard to who asks (for what the commands have just made). */
  private async revision(tx: TenantTx, id: string): Promise<DgvContractRevision | undefined> {
    const rows = await tx.query<Sql>(`${REVISION_SELECT} where c.id = $1::uuid`, [id]);
    if (rows[0] === undefined) return undefined;
    return this.toRevision(rows[0], (await this.approvalsOf(tx, [id])).get(id) ?? []);
  }

  /** The revision as the viewer may see it (only through a dataset they may see), with the document and the changes from the version before it. */
  async find(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<DgvContractDetail | undefined> {
    const rows = await tx.query<Sql>(`${REVISION_SELECT} where c.id = $3::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], id]);
    const row = rows[0];
    if (row === undefined) return undefined;
    const approvals = (await this.approvalsOf(tx, [id])).get(id) ?? [];
    const revision = this.toRevision(row, approvals);
    const before = await tx.query<Sql>('select schema_json from machvon.data_contract_version where dataset_id = $1::uuid and revision < $2::int order by revision desc limit 1', [
      row.dataset_id,
      revision.revision,
    ]);
    const changes = row.odcs_json === null ? [] : classifyChange(before[0] === undefined ? undefined : toColumns(before[0].schema_json), revision.columns).changes;
    return { ...revision, odcs: row.odcs_json, changes };
  }

  /** What a revision changes from the version before it (none for a contract without a document). */
  private async changesOf(tx: TenantTx, contractId: string): Promise<ContractChange[]> {
    const rows = await tx.query<Sql>('select dataset_id, revision, schema_json, odcs_json from machvon.dataset_contract where id = $1::uuid', [contractId]);
    const row = rows[0];
    if (row === undefined || row.odcs_json === null) return [];
    const before = await tx.query<Sql>('select schema_json from machvon.data_contract_version where dataset_id = $1::uuid and revision < $2::int order by revision desc limit 1', [
      row.dataset_id,
      Number(row.revision),
    ]);
    return classifyChange(before[0] === undefined ? undefined : toColumns(before[0].schema_json), toColumns(row.schema_json)).changes;
  }

  /** The revisions of the datasets the viewer may see, newest first; the approvals of those in review are with them. */
  async list(tx: TenantTx, viewer: DatasetViewer, filter: DgvContractFilter): Promise<{ items: DgvContractRevision[]; next: string | null }> {
    if (filter.status !== undefined && !['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'RETURNED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${REVISION_SELECT}
        where ${DATASET_VISIBLE} and ($3::uuid is null or c.dataset_id = $3::uuid) and ($4::text is null or c.status = $4) and ($5::timestamptz is null or (c.created_at, c.id) < ($5::timestamptz, $6::uuid))
        order by c.created_at desc, c.id desc limit $7::int`,
      [viewer.membershipId, [...viewer.roleCodes], filter.datasetId ?? null, filter.status ?? null, after?.at ?? null, after?.id ?? null, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit);
    const approvals = await this.approvalsOf(
      tx,
      page.filter((row) => row.status === 'IN_REVIEW').map((row) => row.id),
    );
    const last = page[page.length - 1];
    const items = page.map((row) => this.toRevision(row, approvals.get(row.id) ?? []));
    return { items, next: rows.length > filter.limit && last !== undefined ? cursorFor(last.created_raw, last.id) : null };
  }

  /** A published version as the viewer may see it. `today` is the day the question is asked on (a day: YYYY-MM-DD). */
  async findVersion(tx: TenantTx, id: string, viewer: DatasetViewer, today: string): Promise<DgvContractVersion | undefined> {
    const rows = await tx.query<Sql>(`${VERSION_SELECT} where v.id = $4::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], today, id]);
    return rows[0] === undefined ? undefined : versionOf(rows[0]);
  }

  async listVersions(
    tx: TenantTx,
    viewer: DatasetViewer,
    filter: { datasetId?: string | undefined; cursor?: string | undefined; limit: number },
    today: string,
  ): Promise<{ items: DgvContractVersion[]; next: string | null }> {
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${VERSION_SELECT}
        where ${DATASET_VISIBLE} and ($4::uuid is null or v.dataset_id = $4::uuid) and ($5::timestamptz is null or (coalesce(v.published_at, 'epoch'::timestamptz), v.id) < ($5::timestamptz, $6::uuid))
        order by coalesce(v.published_at, 'epoch'::timestamptz) desc, v.id desc limit $7::int`,
      [viewer.membershipId, [...viewer.roleCodes], today, filter.datasetId ?? null, after?.at ?? null, after?.id ?? null, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    return { items: page.map(versionOf), next: rows.length > filter.limit && last !== undefined ? cursorFor(last.published_raw, last.id) : null };
  }

  /** The approval at the version the caller read: 409 `VERSION_CONFLICT` otherwise; locked, with the contract it belongs to (locked first, as publishing and closing lock it, so that a decision never meets a revision that is being closed). */
  private async lockApproval(tx: TenantTx, id: string, expected: number): Promise<{ approval: DgvConsumerApproval; contractStatus: DgvContractStatus }> {
    const owner = await tx.query<{ contract_id: string }>('select contract_id from machvon.contract_consumer_approval where id = $1::uuid', [id]);
    if (owner[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await tx.query<{ status: DgvContractStatus }>('select status from machvon.dataset_contract where id = $1::uuid for update', [owner[0].contract_id]);
    const rows = await tx.query<Sql>(`${APPROVAL_SELECT} where a.id = $1::uuid for update of a`, [id]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const approval = approvalOf(rows[0]);
    if (approval.version !== expected) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: approval.version } });
    return { approval, contractStatus: contract[0]?.status ?? 'DRAFT' };
  }

  /**
   * The owner of a consumer approves or rejects the revision (the order of the refusals: 404, 409 `VERSION_CONFLICT`, 403 `NOT_CONSUMER_OWNER`, 409 `STAGE_TRANSITION_DENIED` for a decision that was made or a revision that is no
   * longer in review). A decision is final.
   */
  async decideConsumer(
    tx: TenantTx,
    id: string,
    expected: number,
    input: { decision: 'APPROVED' | 'REJECTED'; comment: string | undefined },
    actor: string,
  ): Promise<{ approval: DgvConsumerApproval; previous: DgvApprovalDecision; contract: DgvContractRevision }> {
    if (input.decision !== 'APPROVED' && input.decision !== 'REJECTED') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    if (input.comment !== undefined && (input.comment.length > MAX_COMMENT || input.comment.includes('\0'))) throw new DomainError('VALIDATION_FAILED', 422, 'comment');
    const { approval, contractStatus } = await this.lockApproval(tx, id, expected);
    if (approval.consumerOwnerId !== actor) throw new DomainError('NOT_CONSUMER_OWNER', 403);
    if (approval.decision !== 'PENDING' || contractStatus !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'decision');
    await tx.query(
      `update machvon.contract_consumer_approval set decision = $2, decided_by = $3::uuid, decided_at = now(), comment = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, input.decision, actor, input.comment === undefined || input.comment.trim() === '' ? null : input.comment.trim()],
    );
    const updated = (await tx.query<Sql>(`${APPROVAL_SELECT} where a.id = $1::uuid`, [id]))[0];
    const contract = await this.revision(tx, approval.contractId);
    if (updated === undefined || contract === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { approval: approvalOf(updated), previous: approval.decision, contract };
  }

  /**
   * The approvals that are addressed to a person as the owner of a consumer, newest first, each with the revision it is about. They are theirs whether or not they may see the dataset: the approval is how they are asked.
   * Somebody else's approval is not in the answer.
   */
  async approvalsFor(
    tx: TenantTx,
    owner: string,
    filter: { decision?: string | undefined; cursor?: string | undefined; limit: number },
  ): Promise<{
    items: Array<{
      approval: DgvConsumerApproval;
      contract: Pick<DgvContractRevision, 'id' | 'datasetId' | 'datasetCode' | 'revision' | 'status' | 'compatibility' | 'effectiveFrom' | 'odcsVersion'> & { changes: ContractChange[] };
    }>;
    next: string | null;
  }> {
    if (filter.decision !== undefined && !['PENDING', 'APPROVED', 'REJECTED'].includes(filter.decision)) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${APPROVAL_SELECT.replace('a.version::text as version', 'a.version::text as version, a.created_at::text as created_raw, c.dataset_id, c.dataset_code, c.revision, c.status as contract_status, c.compatibility, c.effective_from::text as effective_from, c.odcs_version')} join machvon.dataset_contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id
        where a.consumer_owner_user_id = $1::uuid and ($2::text is null or a.decision = $2) and ($3::timestamptz is null or (a.created_at, a.id) < ($3::timestamptz, $4::uuid))
        order by a.created_at desc, a.id desc limit $5::int`,
      [owner, filter.decision ?? null, after?.at ?? null, after?.id ?? null, filter.limit + 1],
    );
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    // The owner decides on what changes, so it is told with the approval (the contract in full is for those who may see the dataset).
    const changes = new Map<string, ContractChange[]>();
    for (const contractId of new Set(page.map((row) => row.contract_id as string))) changes.set(contractId, await this.changesOf(tx, contractId));
    return {
      items: page.map((row) => ({
        approval: approvalOf(row),
        contract: {
          changes: changes.get(row.contract_id) ?? [],
          id: row.contract_id,
          datasetId: row.dataset_id,
          datasetCode: row.dataset_code,
          revision: Number(row.revision),
          status: row.contract_status,
          compatibility: row.compatibility,
          effectiveFrom: row.effective_from,
          odcsVersion: row.odcs_version,
        },
      })),
      next: rows.length > filter.limit && last !== undefined ? cursorFor(last.created_raw, last.id) : null,
    };
  }

  /** The revision at the version the caller read, locked; 404 for a dataset the viewer may not see, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED` when it is not in review. */
  private async lockRevision(tx: TenantTx, id: string, expected: number, viewer: DatasetViewer): Promise<Sql> {
    const rows = await tx.query<Sql>(`${REVISION_SELECT} where c.id = $3::uuid and ${DATASET_VISIBLE} for update of c`, [viewer.membershipId, [...viewer.roleCodes], id]);
    const row = rows[0];
    if (row === undefined || row.odcs_json === null) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expected) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: Number(row.version) } });
    if (row.status !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    return row;
  }

  /**
   * Publishes the revision in review. The order of the refusals: 404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED`, 403 `SELF_APPROVAL_DENIED` (the person who drafted it), for a breaking one 409
   * `CONSUMER_APPROVAL_PENDING` (listing the consumers that have not approved) and 422 `MIGRATION_WINDOW_REQUIRED` (a window that ends thirty days after the revision takes effect at the earliest); a window for a
   * revision that is not breaking is 422. The version is written once, the revision before it is SUPERSEDED, and the dataset stands on the new version (and is ACTIVE).
   */
  async publish(tx: TenantTx, id: string, expected: number, input: DgvPublishInput, actor: string, viewer: DatasetViewer): Promise<DgvPublishOutcome> {
    const row = await this.lockRevision(tx, id, expected, viewer);
    if (row.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    // The dataset is locked before the consumers are read: a dataset of BI that is being built on it waits for this publication or is seen by it (see BiDatasetStore, which shares the row).
    const dataset = await tx.query<Sql>('select id, grain, owner_user_id, retention_policy_id, status, current_contract_version_id from machvon.dataset where id = $1::uuid for update', [
      row.dataset_id,
    ]);
    const breaking = row.compatibility === 'BREAKING';
    if (breaking) {
      // A dataset of BI may have been built on the dataset since the revision was drafted: its owner is asked now, and the publication waits for the answer (what was written is kept; the answer is the refusal).
      if ((await this.reconcileConsumers(tx, row, actor)) > 0) {
        const asked = (await this.approvalsOf(tx, [id])).get(id) ?? [];
        const contract = await this.revision(tx, id);
        if (contract === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
        return {
          kind: 'CONSUMERS_ADDED',
          contract,
          waiting: asked.filter((approval) => approval.decision !== 'APPROVED').map((approval) => ({ kind: approval.consumerKind, ref: approval.consumerRef, decision: approval.decision })),
        };
      }
      const approvals = (await this.approvalsOf(tx, [id])).get(id) ?? [];
      const waiting = approvals.filter((approval) => approval.decision !== 'APPROVED');
      if (waiting.length > 0)
        throw new DomainError('CONSUMER_APPROVAL_PENDING', 409, 'consumers', {
          extensions: { consumers: waiting.map((approval) => ({ kind: approval.consumerKind, ref: approval.consumerRef, decision: approval.decision })) },
        });
      if (
        input.migrationWindowUntil === undefined ||
        !DATE.test(input.migrationWindowUntil) ||
        !migrationWindowEnough(row.effective_from, input.migrationWindowUntil) ||
        input.migrationWindowUntil < input.today
      )
        throw new DomainError('MIGRATION_WINDOW_REQUIRED', 422, 'migration_window_until');
    } else if (input.migrationWindowUntil !== undefined) {
      throw new DomainError('VALIDATION_FAILED', 422, 'migration_window_until');
    }
    const owned = dataset[0];
    if (owned === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (owned.retention_policy_id === null) throw new DomainError('VALIDATION_FAILED', 422, 'retention_policy_id');
    const sha256 = odcsSha256(row.odcs_json);
    const supersededId: string | null = owned.current_contract_version_id;
    const before =
      supersededId === null
        ? undefined
        : (await tx.query<{ contract_id: string | null; revision: number }>('select contract_id, revision from machvon.data_contract_version where id = $1::uuid', [supersededId]))[0];
    if (before !== undefined && Number(before.revision) >= Number(row.revision)) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const odcsObjectKey = await input.storeDocument(row.odcs_json);
    await tx.query(
      `insert into machvon.data_contract_version
         (tenant_id, id, dataset_id, revision, grain, schema_json, owner_id, quality_rules, retention_policy_id, status, contract_id, odcs_sha256, odcs_object_key, compatibility, published_by, published_at, supersedes_id, migration_window_until)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4, $5::jsonb, $6::uuid, $7::jsonb, $8::uuid, 'PUBLISHED', $9::uuid, $10, $11, $12, $13::uuid, now(), $14::uuid, $15::date)`,
      [
        input.versionId,
        row.dataset_id,
        row.revision,
        owned.grain,
        JSON.stringify(row.schema_json),
        owned.owner_user_id,
        JSON.stringify(row.quality_json ?? {}),
        owned.retention_policy_id,
        id,
        sha256,
        odcsObjectKey,
        row.compatibility,
        actor,
        supersededId,
        breaking ? input.migrationWindowUntil : null,
      ],
    );
    if (before?.contract_id !== undefined && before.contract_id !== null) {
      await tx.query("update machvon.dataset_contract set status = 'SUPERSEDED', version = version + 1 where id = $1::uuid and status = 'PUBLISHED'", [before.contract_id]);
    }
    await tx.query("update machvon.dataset_contract set status = 'PUBLISHED', approved_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    await tx.query(
      `update machvon.dataset set current_contract_version_id = $2::uuid, status = case when status = 'DRAFT' then 'ACTIVE' else status end, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [row.dataset_id, input.versionId, actor],
    );
    const contract = await this.revision(tx, id);
    const version = await this.findVersion(tx, input.versionId, viewer, input.today);
    if (contract === undefined || version === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { kind: 'PUBLISHED', contract, version, supersededId, sha256 };
  }

  /** Asks the owners of the consumers that are required now and have no approval in this revision yet (the datasets of BI built on the dataset since it was drafted); returns how many were asked. */
  private async reconcileConsumers(tx: TenantTx, row: Sql, actor: string): Promise<number> {
    const before = await tx.query<Sql>(
      `select c.odcs_json, c.odcs_version from machvon.data_contract_version v join machvon.dataset_contract c on c.tenant_id = v.tenant_id and c.id = v.contract_id
        where v.dataset_id = $1::uuid order by v.revision desc limit 1`,
      [row.dataset_id],
    );
    const declared = before[0]?.odcs_json === undefined || before[0].odcs_json === null ? [] : parseOdcs(before[0].odcs_json, before[0].odcs_version).consumers;
    const required = requiredConsumers(declared, await this.knownConsumers(tx, row.dataset_id));
    const asked = await tx.query<{ consumer_kind: string; consumer_ref: string; consumer_owner_user_id: string }>(
      'select consumer_kind, consumer_ref, consumer_owner_user_id from machvon.contract_consumer_approval where contract_id = $1::uuid',
      [row.id],
    );
    // A consumer that was asked of somebody else (the document named an owner before the platform knew the consumer) is not answered for by the owner the platform knows: an approval is never reassigned, so the
    // publication cannot go on and the revision is closed for another to be drafted.
    const owners = new Map(asked.map((item) => [`${item.consumer_kind}:${item.consumer_ref}`, item.consumer_owner_user_id]));
    const misplaced = required.filter((consumer) => {
      const owner = owners.get(`${consumer.kind}:${consumer.ref}`);
      return owner !== undefined && owner !== consumer.ownerUserId;
    });
    if (misplaced.length > 0)
      throw new DomainError('CONSUMER_APPROVAL_PENDING', 409, 'consumers', {
        extensions: { consumers: misplaced.map((consumer) => ({ kind: consumer.kind, ref: consumer.ref, decision: 'PENDING' })) },
      });
    const have = new Set(owners.keys());
    const missing = required.filter((consumer) => !have.has(`${consumer.kind}:${consumer.ref}`));
    await this.assertOwners(tx, missing);
    for (const consumer of missing) {
      await tx.query(
        `insert into machvon.contract_consumer_approval (tenant_id, id, contract_id, consumer_kind, consumer_ref, consumer_owner_user_id, decision, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, 'PENDING', $6::uuid, $6::uuid)`,
        [randomUUID(), row.id, consumer.kind, consumer.ref, consumer.ownerUserId, actor],
      );
    }
    return missing.length;
  }

  /** The owner of the data returns or rejects the revision in review (the same refusals as publishing, none about consumers): the revision is closed and a new one can be drafted. */
  async close(tx: TenantTx, id: string, expected: number, to: 'RETURNED' | 'REJECTED', actor: string, viewer: DatasetViewer): Promise<DgvContractRevision> {
    const row = await this.lockRevision(tx, id, expected, viewer);
    if (row.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await tx.query('update machvon.dataset_contract set status = $2, version = version + 1 where id = $1::uuid', [id, to]);
    const contract = await this.revision(tx, id);
    if (contract === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return contract;
  }
}
