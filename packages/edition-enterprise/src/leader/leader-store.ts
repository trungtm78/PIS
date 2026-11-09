import { EnterpriseSnapshotStore, SCOPE_FROM } from '@machvon/db';
import type { EnterpriseSnapshotRow, ScopeBuilder, TenantTx } from '@machvon/db';
import type { BlockFact } from './tiles.ts';
import type { NamedRef, RateDirectory } from './rates-reader.ts';
import { priorSnapshotOf } from './rates.ts';

/** Most holds of one source read for the tile; a source that has more is cut and the board says so. */
export const BLOCK_SOURCE_LIMIT = 500;
/** How many frozen enterprise snapshots are looked at to find the one of the same period last year. */
const SNAPSHOT_WINDOW = 400;
/** The issue severities that hold a project: the ones the bottleneck analysis (ANA) counts by default. */
const HOLDING_SEVERITIES = ['HIGH', 'CRITICAL'] as const;
const VN_DAY = (column: string): string => `(${column} at time zone 'Asia/Ho_Chi_Minh')::date::text`;

export interface SnapshotPair {
  current: EnterpriseSnapshotRow;
  prior: EnterpriseSnapshotRow | undefined;
}

export interface BlockRead {
  facts: BlockFact[];
  /** The sources that had more holds than the limit. */
  cut: string[];
}

interface ProjectRowSql {
  project_id: string;
  project_code: string;
  project_name: string;
  unit_id: string | null;
  unit_name: string | null;
  id: string;
  since: string;
}

/**
 * The reads of the leadership dashboard of the enterprise edition (ENT-4d): which frozen enterprise snapshot is the current one and which is the one of the same period last year, the projects and units the reader may
 * read with their codes, and what holds a project on procedure. Every read is in the scope of the reader; nothing here writes.
 */
export class LeaderStore {
  private readonly snapshots = new EnterpriseSnapshotStore();

  /** The snapshot named, or the latest frozen one (the latest day, then the latest revision), and the one of the same period one year before. Undefined when nothing is frozen or the id is not an enterprise snapshot. */
  async pair(tx: TenantTx, snapshotId: string | undefined): Promise<SnapshotPair | undefined> {
    const frozen = (await this.snapshots.list(tx, { status: 'FROZEN' }, SNAPSHOT_WINDOW)).sort((a, b) => b.asOfDate.localeCompare(a.asOfDate) || b.revision - a.revision || b.id.localeCompare(a.id));
    const current = snapshotId === undefined ? frozen[0] : await this.snapshots.find(tx, snapshotId);
    if (current === undefined) return undefined;
    // The snapshot of last year is a period close of another day: never the snapshot itself, and one of the same period only (the latest revision of it).
    const candidates = frozen.filter((row) => row.id !== current.id && row.asOfDate < current.asOfDate);
    return { current, prior: priorSnapshotOf(current.asOfDate, candidates) };
  }

  /** The snapshot loaded for the one reader. */
  view(tx: TenantTx, row: EnterpriseSnapshotRow): ReturnType<EnterpriseSnapshotStore['view']> {
    return this.snapshots.view(tx, row);
  }

  /** The ids of the projects the reader may read; undefined when they may read all (the scope is the whole tenant). */
  async visibleProjects(tx: TenantTx, scope: ScopeBuilder): Promise<string[] | undefined> {
    const visible = scope(1);
    if (visible.sql === 'true') return undefined;
    const rows = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where ${visible.sql} order by p.id`, visible.params);
    return rows.map((row) => row.id);
  }

  /** The codes and names of the units and projects a snapshot mentions. */
  async directory(tx: TenantTx, unitIds: readonly string[], projectIds: readonly string[]): Promise<RateDirectory> {
    const units = unitIds.length === 0 ? [] : await tx.query<{ id: string; code: string; name: string }>('select id, code, name from machvon.organization_unit where id = any($1::uuid[])', [[...unitIds]]);
    const projects = projectIds.length === 0 ? [] : await tx.query<{ id: string; code: string; name: string }>('select id, code, name from machvon.project where id = any($1::uuid[])', [[...projectIds]]);
    const refs = (rows: ReadonlyArray<{ id: string; code: string; name: string }>): Map<string, NamedRef> => new Map(rows.map((row) => [row.id, { code: row.code, name: row.name }]));
    return { units: refs(units), projects: refs(projects) };
  }

  private fact(source: BlockFact['source'], row: ProjectRowSql): BlockFact {
    return { projectId: row.project_id, projectCode: row.project_code, projectName: row.project_name, unitId: row.unit_id, unitName: row.unit_name, source, sourceId: row.id, since: row.since };
  }

  /**
   * What holds projects on procedure, from the registers of their own modules: permits whose decision was expected and has not come (PMT), issues of high severity not solved past their due day (ISS), compensation due and not
   * paid (LND), procurement packages with no activity for `stalledDays` (BID). The day each began to hold is the due day, or the last day of activity; whether it is late is judged by `blockedBoard`.
   */
  async blockFacts(tx: TenantTx, scope: ScopeBuilder, today: string, stalledDays: number): Promise<BlockRead> {
    const cut: string[] = [];
    const read = async (source: BlockFact['source'], sql: string, params: unknown[]): Promise<BlockFact[]> => {
      const rows = await tx.query<ProjectRowSql>(sql, params);
      if (rows.length > BLOCK_SOURCE_LIMIT) cut.push(source);
      return rows.slice(0, BLOCK_SOURCE_LIMIT).map((row) => this.fact(source, row));
    };
    const head = 'p.id as project_id, p.code as project_code, p.name as project_name, p.owner_unit_id as unit_id, ou.name as unit_name';
    const permitScope = scope(2);
    const permits = await read(
      'PERMIT',
      `select x.id, ${head}, x.expected_decision_on::text as since
         from machvon.permit x join machvon.permit_dossier d on d.tenant_id = x.tenant_id and d.id = x.dossier_id
         join ${SCOPE_FROM} on p.tenant_id = d.tenant_id and p.id = d.project_id
        where x.status in ('SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED') and x.expected_decision_on is not null and x.expected_decision_on < $1::date and ${permitScope.sql}
        order by x.id limit ${BLOCK_SOURCE_LIMIT + 1}`,
      [today, ...permitScope.params],
    );
    const issueScope = scope(3);
    const issues = await read(
      'ISSUE',
      `select i.id, ${head}, ${VN_DAY('i.due_at')} as since
         from machvon.issue i join ${SCOPE_FROM} on p.tenant_id = i.tenant_id and p.id = i.project_id
        where i.status in ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'REOPENED') and i.severity = any($2::text[]) and (i.due_at at time zone 'Asia/Ho_Chi_Minh')::date < $1::date
          and ${issueScope.sql}
        order by i.id limit ${BLOCK_SOURCE_LIMIT + 1}`,
      [today, [...HOLDING_SEVERITIES], ...issueScope.params],
    );
    const landScope = scope(2);
    const land = await read(
      'LAND',
      `select cp.plan_id as id, ${head}, min(cp.due_on)::text as since
         from machvon.compensation_payment cp join machvon.compensation_plan pl on pl.tenant_id = cp.tenant_id and pl.id = cp.plan_id
         join ${SCOPE_FROM} on p.tenant_id = pl.tenant_id and p.id = pl.project_id
        where cp.status = 'PENDING' and cp.due_on < $1::date and ${landScope.sql}
        group by cp.plan_id, p.id, p.code, p.name, p.owner_unit_id, ou.name
        order by cp.plan_id limit ${BLOCK_SOURCE_LIMIT + 1}`,
      [today, ...landScope.params],
    );
    const stalledScope = scope(3);
    const procurement = await read(
      'PROCUREMENT',
      `select w.id, ${head}, w.last_activity_on::text as since
         from machvon.package_workflow w join machvon.procurement_package k on k.tenant_id = w.tenant_id and k.id = w.package_id
         join ${SCOPE_FROM} on p.tenant_id = k.tenant_id and p.id = k.project_id
        where w.status in ('IN_PROGRESS', 'ON_HOLD') and $1::date - w.last_activity_on >= $2::int and ${stalledScope.sql}
        order by w.id limit ${BLOCK_SOURCE_LIMIT + 1}`,
      [today, stalledDays, ...stalledScope.params],
    );
    return { facts: [...permits, ...issues, ...land, ...procurement], cut };
  }
}
