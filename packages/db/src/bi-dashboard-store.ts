import { randomUUID } from 'node:crypto';
import { DASHBOARD_CODE, DomainError } from '@machvon/kernel';
import type { DashboardDraft } from '@machvon/kernel';
import { BiLineageStore } from './bi-lineage-store.ts';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const UNIQUE_VIOLATION = '23505';
const SAVEPOINT = 'bi_dashboard_write';
const MIN_TITLE = 2;

export type DashboardAudience = 'PRIVATE' | 'SHARED' | 'TENANT_LIBRARY';
export type DashboardStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

export interface DashboardVersionRecord {
  id: string;
  dashboardId: string;
  revision: number;
  layout: { columns: number; widgets: unknown[] };
  metricVersionIds: string[];
  filterMappings: Record<string, string>;
  breakpoints: Record<string, number>;
  datasetVersionPolicy: 'LATEST_FROZEN' | 'PINNED';
  pinnedDatasetVersionIds: string[];
  status: VersionStatus;
  createdBy: string;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
}

export interface DashboardRecord {
  id: string;
  code: string;
  title: string;
  ownerUserId: string;
  ownerName: string | null;
  currentVersionId: string | null;
  audience: DashboardAudience;
  status: DashboardStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** What the viewer may do with it: the owner, a person it was shared with to change it or only to see it; none when it is in the library only (or when it was read for a change, whoever asks). */
  permission: 'OWNER' | 'EDIT' | 'VIEW' | null;
  /** The revision and the state of the version it points to, with whether every metric of it is certified now. */
  current: { revision: number; status: VersionStatus; metricCount: number; allCertified: boolean } | null;
}

export interface DashboardFilter {
  status?: string | undefined;
}

export interface DashboardPageAnchor {
  code: string;
  id: string;
}

export interface MetricCheck {
  id: string;
  status: string;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  code: string;
  title: string;
  owner_user_id: string;
  owner_name: string | null;
  current_version_id: string | null;
  audience: DashboardAudience;
  status: DashboardStatus | VersionStatus;
  dashboard_id: string;
  revision: number;
  metric_versions: string[];
  filter_mappings: Record<string, string>;
  breakpoints: Record<string, number>;
  dataset_version_policy: "LATEST_FROZEN" | "PINNED";
  created_by: string;
  published_by: string | null;
  current_revision: number;
  current_status: VersionStatus;
  current_metrics: number;
  sort_key: string;
  pinned_dataset_version_ids: string[] | null;
}

const iso = (value: unknown): string => new Date(value as string).toISOString();

const SELECT = `select d.id, d.code, d.title, d.owner_user_id, (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = d.tenant_id and u.membership_id = d.owner_user_id) as owner_name,
  d.current_version_id, d.audience, d.status, d.created_at, d.updated_at, d.version::text as version,
  v.revision as current_revision, v.status as current_status, jsonb_array_length(v.metric_versions) as current_metrics,
  not exists (select 1 from jsonb_array_elements_text(v.metric_versions) as ref(id) join machvon.metric_definition m on m.tenant_id = d.tenant_id and m.id = ref.id::uuid where m.status <> 'CERTIFIED') as current_certified
  from machvon.dashboard d
  left join machvon.dashboard_version v on v.tenant_id = d.tenant_id and v.id = d.current_version_id`;

const toDashboard = (row: Sql): DashboardRecord => ({
  id: row.id,
  code: row.code,
  title: row.title,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name,
  currentVersionId: row.current_version_id,
  audience: row.audience,
  status: row.status as DashboardStatus,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  version: Number(row.version),
  permission: null,
  current: row.current_version_id === null ? null : { revision: row.current_revision, status: row.current_status, metricCount: row.current_metrics, allCertified: row.current_certified === true },
});

const VERSION_COLUMNS = 'id, dashboard_id, revision, layout_json, metric_versions, filter_mappings, breakpoints, dataset_version_policy, pinned_dataset_version_ids, status, created_by, created_at, published_by, published_at';

const toVersion = (row: Sql): DashboardVersionRecord => ({
  id: row.id,
  dashboardId: row.dashboard_id,
  revision: row.revision,
  layout: row.layout_json as { columns: number; widgets: unknown[]; },
  metricVersionIds: row.metric_versions,
  filterMappings: row.filter_mappings,
  breakpoints: row.breakpoints,
  datasetVersionPolicy: row.dataset_version_policy,
  pinnedDatasetVersionIds: row.pinned_dataset_version_ids ?? [],
  status: row.status as VersionStatus,
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
  publishedBy: row.published_by,
  publishedAt: row.published_at === null ? null : iso(row.published_at),
});

/**
 * The shares of a dashboard that reach the viewer ($1, a membership): one to the person, one to a role they hold now, one to a unit they belong to or to a unit above it. A share that was revoked reaches nobody at the
 * next read: the right is judged when a dashboard is asked for, never kept.
 */
const SHARE_REACHES = `s.tenant_id = d.tenant_id and s.dashboard_id = d.id and s.status = 'ACTIVE' and (
    (s.grantee_kind = 'USER' and s.grantee_ref_id = $1::uuid)
    or (s.grantee_kind = 'ROLE' and s.grantee_ref_id in (select rg.role_id from machvon.role_grant rg where rg.membership_id = $1::uuid and rg.status = 'Active' and rg.effective_from <= now() and (rg.effective_until is null or now() < rg.effective_until)))
    or (s.grantee_kind = 'UNIT' and s.grantee_ref_id in (select a.id from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id join machvon.organization_unit a on a.tenant_id = u.tenant_id and u.path like a.path || '%' where m.id = $1::uuid)))`;

/** The dashboards the viewer may see: their own, those shared with them and those the tenant published to its library. */
const VISIBLE = `(d.owner_user_id = $1::uuid or (d.audience = 'TENANT_LIBRARY' and d.status = 'PUBLISHED') or exists (select 1 from machvon.dashboard_share s where ${SHARE_REACHES}))`;

/**
 * The dashboards and their versions (ST-BI-005, BI 3 F5): a dashboard is an object with an owner; a version is saved whole and never changes (the database refuses it), and the dashboard points at the latest one. A version
 * names metrics that are certified and, when it pins the versions of the datasets, versions that are frozen. Who sees what, and who may change it, is the business of the controller.
 */
export class BiDashboardStore {
  /** A dashboard the viewer sees, or none (one that is not theirs and not in the library is as good as none). */
  async find(tx: TenantTx, id: string, viewer: string): Promise<DashboardRecord | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where d.id = $2::uuid and ${VISIBLE}`, [viewer, id]);
    return (await this.withPermissions(tx, rows.map(toDashboard), viewer))[0];
  }

  /** What the viewer may do with each dashboard: the owner, a share to change it, a share to see it (the best of the shares that reach them). */
  private async withPermissions(tx: TenantTx, records: DashboardRecord[], viewer: string): Promise<DashboardRecord[]> {
    if (records.length === 0) return records;
    const rows = await tx.query<{ id: string; permission: DashboardRecord['permission'] }>(
      `select d.id, case when d.owner_user_id = $1::uuid then 'OWNER'
                         when exists (select 1 from machvon.dashboard_share s where ${SHARE_REACHES} and s.permission = 'EDIT') then 'EDIT'
                         when exists (select 1 from machvon.dashboard_share s where ${SHARE_REACHES}) then 'VIEW' end as permission
         from machvon.dashboard d where d.id = any($2::uuid[])`,
      [viewer, records.map((record) => record.id)],
    );
    const by = new Map(rows.map((row) => [row.id, row.permission]));
    return records.map((record) => ({ ...record, permission: by.get(record.id) ?? null }));
  }

  /** The dashboard locked for a change, with no regard to who sees it (the caller judges). */
  async lock(tx: TenantTx, id: string): Promise<DashboardRecord | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where d.id = $1::uuid for update of d`, [id]);
    return rows[0] === undefined ? undefined : toDashboard(rows[0]);
  }

  /** The dashboards of the viewer by code and id. */
  async list(tx: TenantTx, viewer: string, filter: DashboardFilter, page: { limit: number; after: DashboardPageAnchor | undefined }): Promise<{ records: DashboardRecord[]; next: DashboardPageAnchor | undefined }> {
    const rows = await tx.query<Sql>(
      `${SELECT}
        where ${VISIBLE} and ($2::text is null or d.status = $2) and ($3::text is null or (d.code, d.id) > ($3::text, $4::uuid))
        order by d.code, d.id limit $5::int`,
      [viewer, filter.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: await this.withPermissions(tx, shown.map(toDashboard), viewer), next: rows.length > page.limit && last !== undefined ? { code: last.code, id: last.id } : undefined };
  }

  async versions(tx: TenantTx, dashboardId: string): Promise<DashboardVersionRecord[]> {
    const rows = await tx.query<Sql>(`select ${VERSION_COLUMNS} from machvon.dashboard_version where dashboard_id = $1::uuid order by revision desc`, [dashboardId]);
    return rows.map(toVersion);
  }

  /** One version, when the viewer sees its dashboard. */
  async findVersion(tx: TenantTx, id: string, viewer: string): Promise<DashboardVersionRecord | undefined> {
    const rows = await tx.query<Sql>(
      `select ${VERSION_COLUMNS.split(', ').map((column) => `v.${column}`).join(', ')} from machvon.dashboard_version v join machvon.dashboard d on d.tenant_id = v.tenant_id and d.id = v.dashboard_id where v.id = $2::uuid and ${VISIBLE}`,
      [viewer, id],
    );
    return rows[0] === undefined ? undefined : toVersion(rows[0]);
  }

  /** The versions the viewer sees, newest first (the scaffold read of the family). */
  async listVersions(tx: TenantTx, viewer: string, page: { limit: number; after: { at: string; id: string } | undefined }): Promise<{ records: DashboardVersionRecord[]; next: { at: string; id: string } | undefined }> {
    assertTimestampCursor(page.after?.at);
    const rows = await tx.query<Sql>(
      `select ${VERSION_COLUMNS.split(', ').map((column) => `v.${column}`).join(', ')}, to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key from machvon.dashboard_version v join machvon.dashboard d on d.tenant_id = v.tenant_id and d.id = v.dashboard_id
        where ${VISIBLE} and ($2::timestamptz is null or (v.created_at, v.id) < ($2::timestamptz, $3::uuid))
        order by v.created_at desc, v.id desc limit $4::int`,
      [viewer, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toVersion), next: rows.length > page.limit && last !== undefined ? { at: last.sort_key, id: last.id } : undefined };
  }

  /** A dashboard is made: private to its owner, a draft, with no version yet. A code the tenant uses already is 409 `DASHBOARD_CODE_DUPLICATE`. */
  async create(tx: TenantTx, input: { code: string; title: string; actor: string }): Promise<DashboardRecord> {
    const code = input.code.trim();
    const title = input.title.trim().normalize('NFC');
    if (!DASHBOARD_CODE.test(code)) throw new DomainError('VALIDATION_FAILED', 422, 'code');
    if (title.length < MIN_TITLE || title.length > 300) throw new DomainError('VALIDATION_FAILED', 422, 'title');
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.dashboard (tenant_id, id, code, title, owner_user_id, audience, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, 'PRIVATE', 'DRAFT', $4::uuid, $4::uuid)`,
        [id, code, title, input.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('DASHBOARD_CODE_DUPLICATE', 409, 'code');
    }
    return this.reread(tx, id, input.actor);
  }

  /** The state of the metrics a draft names, by id: one that is not in the tenant is missing from the answer. */
  async metricChecks(tx: TenantTx, ids: readonly string[]): Promise<MetricCheck[]> {
    if (ids.length === 0) return [];
    return tx.query<MetricCheck>('select id, status from machvon.metric_definition where id = any($1::uuid[])', [ids]);
  }

  /** The state of the dataset versions a draft pins, by id. */
  async datasetVersionChecks(tx: TenantTx, ids: readonly string[]): Promise<MetricCheck[]> {
    if (ids.length === 0) return [];
    return tx.query<MetricCheck>('select id, status from machvon.bi_dataset_version where id = any($1::uuid[])', [ids]);
  }

  /** The next revision of a dashboard is saved whole, as a draft, and the dashboard points to it; the version of the dashboard moves. Returns the version. */
  async saveVersion(tx: TenantTx, dashboard: DashboardRecord, draft: DashboardDraft, actor: string): Promise<DashboardVersionRecord> {
    const [row] = await tx.query<{ next: number }>('select coalesce(max(revision), 0) + 1 as next from machvon.dashboard_version where dashboard_id = $1::uuid', [dashboard.id]);
    const next = row?.next ?? 1;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.dashboard_version (tenant_id, id, dashboard_id, revision, layout_json, metric_versions, filter_mappings, breakpoints, dataset_version_policy, pinned_dataset_version_ids, status, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb, 'DRAFT', $10::uuid)`,
      [
        id,
        dashboard.id,
        next,
        JSON.stringify({ columns: draft.layout.columns, widgets: draft.layout.widgets.map(widgetRow) }),
        JSON.stringify(draft.metricVersionIds),
        JSON.stringify(draft.filterMappings),
        JSON.stringify(draft.breakpoints),
        draft.policy,
        draft.policy === 'PINNED' ? JSON.stringify(draft.pinnedDatasetVersionIds) : null,
        actor,
      ],
    );
    await tx.query('update machvon.dashboard set current_version_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [dashboard.id, id, actor]);
    // The lineage of data is told which metrics the version shows.
    await new BiLineageStore().dashboardVersionSaved(tx, { versionId: id, dashboardCode: dashboard.code, revision: next, metricVersionIds: draft.metricVersionIds, observedAt: new Date() });
    const [saved] = await tx.query<Sql>(`select ${VERSION_COLUMNS} from machvon.dashboard_version where id = $1::uuid`, [id]);
    return toVersion(saved as Sql);
  }

  /** The dashboard is SHARED while it has an active share and PRIVATE when it has none (a dashboard in the library stays as it is); its version moves with it. */
  async markShared(tx: TenantTx, dashboardId: string, shared: boolean, actor: string): Promise<void> {
    await tx.query(
      `update machvon.dashboard set audience = case when audience = 'PRIVATE' and $2::boolean then 'SHARED' when audience = 'SHARED' and not $2::boolean then 'PRIVATE' else audience end,
              updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [dashboardId, shared, actor],
    );
  }

  /** A version locked for a change with its dashboard, whoever sees them (the caller judges); the dashboard is locked first, as a save of a version locks it. */
  async lockVersion(tx: TenantTx, versionId: string): Promise<{ dashboard: DashboardRecord; version: DashboardVersionRecord } | undefined> {
    const owner = await tx.query<{ dashboard_id: string }>('select dashboard_id from machvon.dashboard_version where id = $1::uuid', [versionId]);
    if (owner[0] === undefined) return undefined;
    const dashboard = await this.lock(tx, owner[0].dashboard_id);
    const rows = await tx.query<Sql>(`select ${VERSION_COLUMNS} from machvon.dashboard_version where id = $1::uuid for update`, [versionId]);
    return dashboard === undefined || rows[0] === undefined ? undefined : { dashboard, version: toVersion(rows[0]) };
  }

  /**
   * Publishes a draft version, by someone other than who saved it (SELF_APPROVAL_DENIED): the version that was published is superseded, the new one says who published it and when, and the dashboard is PUBLISHED
   * and points to it. The way to it is the decision on a publication request, or the approval of the layout (ST-BI-006); a version that was published never changes again.
   */
  async publishVersion(tx: TenantTx, versionId: string, approver: string): Promise<{ dashboard: DashboardRecord; version: DashboardVersionRecord }> {
    const held = await this.lockVersion(tx, versionId);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (held.version.createdBy === approver) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (held.version.status !== 'DRAFT' || held.dashboard.status === 'ARCHIVED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    await tx.query("update machvon.dashboard_version set status = 'SUPERSEDED' where dashboard_id = $1::uuid and status = 'PUBLISHED'", [held.dashboard.id]);
    await tx.query("update machvon.dashboard_version set status = 'PUBLISHED', published_by = $2::uuid, published_at = now() where id = $1::uuid", [versionId, approver]);
    await tx.query("update machvon.dashboard set status = 'PUBLISHED', current_version_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [held.dashboard.id, versionId, approver]);
    const published = await this.lockVersion(tx, versionId);
    return published as { dashboard: DashboardRecord; version: DashboardVersionRecord };
  }

  private async reread(tx: TenantTx, id: string, viewer: string): Promise<DashboardRecord> {
    const row = await this.find(tx, id, viewer);
    if (row === undefined) throw new Error('the dashboard vanished after its write');
    return row;
  }
}

/** A tile as it is stored: the names of the contract, which is what the screens and the queries read. */
function widgetRow(widget: DashboardDraft['layout']['widgets'][number]): Record<string, unknown> {
  return {
    id: widget.id,
    kind: widget.kind,
    ...(widget.title === null ? {} : { title: widget.title }),
    metric_version_id: widget.metricVersionId,
    ...(widget.dimensionCode === null ? {} : { dimension_code: widget.dimensionCode }),
    grid: widget.grid,
  };
}
