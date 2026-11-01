import { randomUUID } from 'node:crypto';
import { DomainError, versionConflict } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const MAX_CODE = 80;
const MAX_TITLE = 300;
const MAX_DOMAIN = 60;
const MAX_GRAIN = 200;
const PRODUCER_MODULE = /^[A-Z][A-Z0-9]{1,9}$/;

export const DATASET_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type DatasetClassification = (typeof DATASET_CLASSIFICATIONS)[number];
export type DatasetStatus = 'DRAFT' | 'ACTIVE' | 'DEPRECATED' | 'RETIRED';
/** The quality badge of BR-DGV-04 as far as the runs recorded so far decide it. */
export type QualityBadge = 'NOT_ASSESSED' | 'PASSED' | 'WARNING' | 'FAILED' | 'STALE';

/** Who is reading: the visibility of a dataset depends on the person and on the roles the person holds. */
export interface DatasetViewer {
  membershipId: string;
  roleCodes: readonly string[];
}

export interface DatasetRow {
  id: string;
  datasetCode: string;
  title: string;
  domain: string;
  grain: string;
  producerModule: string;
  ownerId: string;
  ownerName: string | null;
  stewardId: string;
  stewardName: string | null;
  classification: DatasetClassification;
  isCritical: boolean;
  freshnessSloSeconds: number;
  /** The revision of the contract in force, null until a contract is published. */
  contractRevision: number | null;
  status: DatasetStatus;
  qualityBadge: QualityBadge;
  /** The score of the latest finished run (hundredths of a percent, a decimal string), null when no run has finished: never 0 for "not measured". */
  qualityScore: string | null;
  /** Whether the latest finished run was a hard fail; null when no run has finished. */
  qualityHardFail: boolean | null;
  /** When the latest finished run finished (ISO instant), null when none has. */
  qualityRunAt: string | null;
  /** The working contract of the dataset (its highest revision), which rules and runs are written against; null while the dataset has none. */
  workingContractId: string | null;
  /** The incidents of the quality runs of the dataset that are not closed, and the ones among them past their due time (BR-DGV-05). */
  openIncidents: number;
  overdueIncidents: number;
  version: number;
}

export interface DatasetInput {
  datasetCode: string;
  title: string;
  domain: string;
  grain: string;
  producerModule: string;
  ownerId: string;
  stewardId: string;
  classification: DatasetClassification;
  isCritical: boolean;
  freshnessSloSeconds: number;
  retentionPolicyId?: string | undefined;
}

export interface DatasetFilter {
  query?: string | undefined;
  domain?: string | undefined;
  classification?: DatasetClassification | undefined;
}

/** The picture of a set of datasets by badge (DGV-01); see `DgvDatasetStore.summarize`. */
export interface CatalogSummary {
  total: number;
  notAssessed: number;
  passed: number;
  warning: number;
  failed: number;
  stale: number;
  hardFail: number;
  /** The incidents not closed on these datasets, and the ones past their due time. */
  openIncidents: number;
  overdueIncidents: number;
  /** The average of the latest scores of the datasets that have one, hundredths as a decimal string; null when none has. */
  averageScore: string | null;
}

export interface OwnershipChange {
  ownerId: string;
  stewardId: string;
}

export interface OwnershipResult {
  before: OwnershipChange;
  after: OwnershipChange;
  isCritical: boolean;
  version: number;
  status: DatasetStatus;
}

interface SqlRow {
  id: string;
  dataset_code: string;
  title: string;
  domain: string;
  grain: string;
  producer_module: string;
  owner_user_id: string;
  owner_name: string | null;
  steward_user_id: string;
  steward_name: string | null;
  classification: DatasetClassification;
  is_critical: boolean;
  freshness_slo_seconds: string;
  contract_revision: number | null;
  status: DatasetStatus;
  quality_badge: QualityBadge;
  quality_score: string | null;
  quality_hard_fail: boolean | null;
  quality_run_at: string | null;
  working_contract_id: string | null;
  open_incidents: string;
  overdue_incidents: string;
  version: string;
}

interface SummaryRow {
  total: string;
  not_assessed: string;
  passed: string;
  warning: string;
  failed: string;
  stale: string;
  hard_fail: string;
  open_incidents: string;
  overdue_incidents: string;
  average_score: string | null;
}

interface LockedRow {
  owner_user_id: string;
  steward_user_id: string;
  is_critical: boolean;
  status: DatasetStatus;
  version: string;
}

/**
 * The datasets the viewer may see (BR-DGV-11): the owner, the steward and the registrant see their own dataset; a dataset that names the
 * roles allowed to see it is seen by those roles; a dataset that names none is seen by every catalogue reader when it is PUBLIC or
 * INTERNAL, and by nobody else. $1 is the membership of the viewer, $2 the codes of the roles it holds.
 */
export const DATASET_VISIBLE = `(d.owner_user_id = $1::uuid or d.steward_user_id = $1::uuid or d.created_by = $1::uuid
  or (cardinality(d.allowed_role_codes) > 0 and d.allowed_role_codes && $2::text[])
  or (cardinality(d.allowed_role_codes) = 0 and d.classification in ('PUBLIC', 'INTERNAL')))`;

/**
 * The latest finished run of the dataset `d`, as the join `run`. A run that is still RUNNING or that FAILED to be measured is not a result:
 * a dataset whose only runs are those has no run here, and so no badge but NOT_ASSESSED.
 */
export const LATEST_RUN_JOIN = `left join lateral (select r.id, r.finished_at, r.overall_result, r.score, r.hard_fail, r.certified_blocked, r.snapshot_id, r.trigger
                      from machvon.quality_run r
                      where r.tenant_id = d.tenant_id and r.dataset_id = d.id and r.status = 'COMPLETED'
                      order by r.finished_at desc, r.id desc limit 1) run on true`;

/** The incidents of the quality runs and of the reconciliations of the dataset `d` that are not closed (`open_incidents`) and the ones past their due time (`overdue_incidents`). */
const INCIDENT_COUNTS_SQL = `(select count(*) filter (where i.status <> 'CLOSED') from machvon.quality_incident i left join machvon.quality_run ir on ir.tenant_id = i.tenant_id and ir.id = i.run_id left join machvon.reconciliation_run ic on ic.tenant_id = i.tenant_id and ic.id = i.reconciliation_id where coalesce(ir.dataset_id, ic.dataset_id) = d.id)::text as open_incidents,
  (select count(*) filter (where i.status <> 'CLOSED' and i.due_at < now()) from machvon.quality_incident i left join machvon.quality_run ir on ir.tenant_id = i.tenant_id and ir.id = i.run_id left join machvon.reconciliation_run ic on ic.tenant_id = i.tenant_id and ic.id = i.reconciliation_id where coalesce(ir.dataset_id, ic.dataset_id) = d.id)::text as overdue_incidents`;

/**
 * The badge of BR-DGV-04: NOT_ASSESSED without a finished run, STALE when the run is older than the freshness SLO of the dataset, otherwise the
 * verdict of the run. The one definition that the catalogue, the dashboard and the scorecard all use.
 */
export const QUALITY_BADGE_SQL = `case when run.finished_at is null then 'NOT_ASSESSED'
       when run.finished_at + d.freshness_slo_seconds * interval '1 second' < now() then 'STALE'
       else coalesce(run.overall_result, 'NOT_ASSESSED') end`;

const SELECT = `select d.id, d.dataset_code, d.title, d.domain, d.grain, d.producer_module, d.owner_user_id, od.display_name as owner_name,
  d.steward_user_id, sd.display_name as steward_name, d.classification, d.is_critical, d.freshness_slo_seconds::text as freshness_slo_seconds,
  cv.revision as contract_revision, d.status,
  ${QUALITY_BADGE_SQL} as quality_badge, run.score::text as quality_score, run.hard_fail as quality_hard_fail,
  to_char(run.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as quality_run_at,
  (select c.id from machvon.dataset_contract c where c.tenant_id = d.tenant_id and c.dataset_id = d.id and not (c.odcs_json is not null and c.status in ('IN_REVIEW', 'REJECTED', 'RETURNED'))
    order by exists (select 1 from machvon.quality_rule_version q where q.tenant_id = c.tenant_id and q.contract_id = c.id and q.status = 'APPROVED') desc, c.revision desc limit 1) as working_contract_id,
  ${INCIDENT_COUNTS_SQL},
  d.version::text as version
  from machvon.dataset d
  left join machvon.tenant_user_directory od on od.tenant_id = d.tenant_id and od.membership_id = d.owner_user_id
  left join machvon.tenant_user_directory sd on sd.tenant_id = d.tenant_id and sd.membership_id = d.steward_user_id
  left join machvon.data_contract_version cv on cv.tenant_id = d.tenant_id and cv.id = d.current_contract_version_id
  ${LATEST_RUN_JOIN}`;

const toRow = (row: SqlRow): DatasetRow => ({
  id: row.id,
  datasetCode: row.dataset_code,
  title: row.title,
  domain: row.domain,
  grain: row.grain,
  producerModule: row.producer_module,
  ownerId: row.owner_user_id,
  ownerName: row.owner_name,
  stewardId: row.steward_user_id,
  stewardName: row.steward_name,
  classification: row.classification,
  isCritical: row.is_critical,
  freshnessSloSeconds: Number(row.freshness_slo_seconds),
  contractRevision: row.contract_revision,
  status: row.status,
  qualityBadge: row.quality_badge,
  qualityScore: row.quality_score,
  qualityHardFail: row.quality_hard_fail,
  qualityRunAt: row.quality_run_at,
  workingContractId: row.working_contract_id,
  openIncidents: Number(row.open_incidents),
  overdueIncidents: Number(row.overdue_incidents),
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A name or a code as it is stored: trimmed, not empty, without control characters, within its length. */
function textOf(value: string, field: string, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

/** The text of a search as a LIKE pattern that matches it literally. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/** A critical dataset has an owner who is not its steward (DGV 3.1 F1); the database CHECK is the last word, this is the first. */
function assertDistinctPair(isCritical: boolean, ownerId: string, stewardId: string): void {
  if (isCritical && ownerId === stewardId) throw new DomainError('OWNER_STEWARD_SAME', 422, 'steward_user_id');
}

/**
 * The dataset catalogue (ST-DGV-001, DGV 3.1 F1): datasets registered with a domain, a grain, an owner and a steward, found again by a
 * search that shows each reader only what their roles and the classification allow. A dataset the reader may not see is not in the
 * answer and not in the count, and an id that names one is as unknown as an id of another tenant.
 */
export class DgvDatasetStore {
  /** Registers a dataset in DRAFT; the contract that activates it belongs to a later step. */
  async register(tx: TenantTx, input: DatasetInput, actor: string): Promise<{ id: string; version: number }> {
    const datasetCode = textOf(input.datasetCode, 'dataset_code', MAX_CODE);
    const title = textOf(input.title, 'title', MAX_TITLE);
    const domain = textOf(input.domain, 'domain', MAX_DOMAIN);
    const grain = textOf(input.grain, 'grain', MAX_GRAIN);
    if (!PRODUCER_MODULE.test(input.producerModule)) throw invalid('producer_module');
    if (!Number.isSafeInteger(input.freshnessSloSeconds) || input.freshnessSloSeconds <= 0) throw invalid('freshness_slo_seconds');
    assertDistinctPair(input.isCritical, input.ownerId, input.stewardId);
    await this.assertStaff(tx, { owner_user_id: input.ownerId, steward_user_id: input.stewardId });
    if (input.retentionPolicyId !== undefined) {
      const policy = await tx.query<{ id: string }>('select id from machvon.data_retention_policy where id = $1::uuid', [input.retentionPolicyId]);
      if (policy[0] === undefined) throw invalid('retention_policy_id');
    }
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.dataset
           (tenant_id, id, dataset_code, title, domain, grain, producer_module, owner_user_id, steward_user_id, classification, is_critical,
            freshness_slo_seconds, retention_policy_id, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9, $10, $11, $12::uuid, 'DRAFT', $13::uuid, $13::uuid)`,
        [id, datasetCode, title, domain, grain, input.producerModule, input.ownerId, input.stewardId, input.classification, input.isCritical, input.freshnessSloSeconds, input.retentionPolicyId ?? null, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('DATASET_CODE_DUPLICATE', 409, 'dataset_code');
      throw error;
    }
    return { id, version: 1 };
  }

  /** The dataset with this id when the viewer may see it, with the readable names of its owner and steward. */
  async find(tx: TenantTx, id: string, viewer: DatasetViewer): Promise<DatasetRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where d.id = $3::uuid and ${DATASET_VISIBLE}`, [viewer.membershipId, [...viewer.roleCodes], id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The visible datasets that match the filter, by code; the page after `after` when given. */
  async search(tx: TenantTx, viewer: DatasetViewer, filter: DatasetFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<DatasetRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ${DATASET_VISIBLE} and ${this.matching()}
          and ($6::text is null or (d.dataset_code, d.id) > ($6::text, $7::uuid))
        order by d.dataset_code, d.id limit $8`,
      [...this.filterParams(viewer, filter), request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** How many visible datasets match the filter: a dataset the viewer may not see is not in the number. */
  async count(tx: TenantTx, viewer: DatasetViewer, filter: DatasetFilter): Promise<number> {
    const rows = await tx.query<{ total: string }>(`select count(*)::text as total from machvon.dataset d where ${DATASET_VISIBLE} and ${this.matching()}`, this.filterParams(viewer, filter));
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * The picture of the visible datasets that match the filter (DGV-01): how many carry each badge, how many are hard fails, and the average
   * score. The average is over the datasets that have a finished run - a NOT_ASSESSED dataset has no score and is left out of it, never counted
   * as 0 or as passed - truncated to hundredths, and null when no dataset has a score. A STALE dataset keeps its last score in the average and is
   * counted separately, so the reader sees how much of the average is old.
   */
  async summarize(tx: TenantTx, viewer: DatasetViewer, filter: DatasetFilter): Promise<CatalogSummary> {
    const rows = await tx.query<SummaryRow>(
      `select count(*)::text as total,
              (count(*) filter (where x.badge = 'NOT_ASSESSED'))::text as not_assessed,
              (count(*) filter (where x.badge = 'PASSED'))::text as passed,
              (count(*) filter (where x.badge = 'WARNING'))::text as warning,
              (count(*) filter (where x.badge = 'FAILED'))::text as failed,
              (count(*) filter (where x.badge = 'STALE'))::text as stale,
              (count(*) filter (where x.hard_fail))::text as hard_fail,
              coalesce(sum(x.open_incidents::bigint), 0)::text as open_incidents,
              coalesce(sum(x.overdue_incidents::bigint), 0)::text as overdue_incidents,
              trunc(avg(x.score) filter (where x.badge <> 'NOT_ASSESSED'), 2)::text as average_score
         from (select ${QUALITY_BADGE_SQL} as badge, run.score as score, coalesce(run.hard_fail, false) as hard_fail, ${INCIDENT_COUNTS_SQL}
                 from machvon.dataset d ${LATEST_RUN_JOIN}
                where ${DATASET_VISIBLE} and ${this.matching()}) x`,
      this.filterParams(viewer, filter),
    );
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      notAssessed: Number(row?.not_assessed ?? 0),
      passed: Number(row?.passed ?? 0),
      warning: Number(row?.warning ?? 0),
      failed: Number(row?.failed ?? 0),
      stale: Number(row?.stale ?? 0),
      hardFail: Number(row?.hard_fail ?? 0),
      openIncidents: Number(row?.open_incidents ?? 0),
      overdueIncidents: Number(row?.overdue_incidents ?? 0),
      averageScore: row?.average_score ?? null,
    };
  }

  /**
   * Gives the dataset a new owner and steward. The dataset is locked, so two changes of one dataset run one after the other; a dataset
   * the viewer may not see, or one that does not exist, is 404, and a dataset that was changed since the viewer read it is 409.
   */
  async assignOwnership(tx: TenantTx, id: string, expectedVersion: number, change: OwnershipChange, viewer: DatasetViewer): Promise<OwnershipResult> {
    const rows = await tx.query<LockedRow>(
      `select d.owner_user_id, d.steward_user_id, d.is_critical, d.status, d.version::text as version from machvon.dataset d where d.id = $3::uuid and ${DATASET_VISIBLE} for update of d`,
      [viewer.membershipId, [...viewer.roleCodes], id],
    );
    const locked = rows[0];
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const version = Number(locked.version);
    if (version !== expectedVersion) throw versionConflict(version);
    // A retired dataset is history: who owned it is not rewritten.
    if (locked.status === 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    assertDistinctPair(locked.is_critical, change.ownerId, change.stewardId);
    if (locked.owner_user_id === change.ownerId && locked.steward_user_id === change.stewardId) throw invalid('owner_user_id');
    await this.assertStaff(tx, { owner_user_id: change.ownerId, steward_user_id: change.stewardId });
    await tx.query(
      `update machvon.dataset set owner_user_id = $2::uuid, steward_user_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
      [id, change.ownerId, change.stewardId, viewer.membershipId],
    );
    return {
      before: { ownerId: locked.owner_user_id, stewardId: locked.steward_user_id },
      after: change,
      isCritical: locked.is_critical,
      version: version + 1,
      status: locked.status,
    };
  }

  /** The WHERE part that follows the filter; its parameters are $3 (the text), $4 (the domain) and $5 (the classification). */
  private matching(): string {
    return `($3::text is null or d.dataset_code ilike $3 escape '\\' or d.title ilike $3 escape '\\' or d.grain ilike $3 escape '\\')
      and ($4::text is null or d.domain = $4) and ($5::text is null or d.classification = $5)`;
  }

  private filterParams(viewer: DatasetViewer, filter: DatasetFilter): unknown[] {
    const text = filter.query?.trim();
    return [viewer.membershipId, [...viewer.roleCodes], text === undefined || text === '' ? null : likePattern(text), filter.domain ?? null, filter.classification ?? null];
  }

  /** An owner and a steward are active staff of the tenant: not a guest, not a service account, not a membership that has ended. */
  private async assertStaff(tx: TenantTx, people: Record<'owner_user_id' | 'steward_user_id', string>): Promise<void> {
    const ids = [...new Set(Object.values(people))];
    const staff = await tx.query<{ id: string }>(
      `select id from machvon.membership
        where id = any($1::uuid[]) and status = 'Active' and membership_type = 'STAFF' and valid_from <= now() and (valid_until is null or valid_until > now())`,
      [ids],
    );
    const known = new Set(staff.map((row) => row.id));
    for (const [field, memberId] of Object.entries(people)) if (!known.has(memberId)) throw invalid(field);
  }
}
