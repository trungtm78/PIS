import { randomUUID } from 'node:crypto';
import { DomainError, MAX_COMPONENT_DEPTH, assertComponentInput, assertMilestoneInput, assertMilestoneProgress, delayDays, formsCycle, versionConflict, wbsExceedsTotal } from '@machvon/kernel';
import type { MilestoneStatus } from '@machvon/kernel';
import { idOf } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ProjectClassification } from './prj-project-store.ts';
import { lockProject } from './prj-stage-support.ts';
import type { LockedProject, StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The work breakdown and the milestones of a project (ST-PRJ-009, PRJ 3.1 BR-PRJ-08): a tree of components whose first level adds up against the investment total (more than the total is a warning, not a block), and
 * milestones with a baseline day, a planned day, the day they were done and the milestone they wait for. Every write locks the project, so a code is unique and a dependency never closes a loop without a race.
 */

export const COMPONENT_RESOURCE = 'project_component';
export const MILESTONE_RESOURCE = 'project_milestone';
export const WBS_EXCEEDS_TOTAL = 'WBS_EXCEEDS_TOTAL';
/** A project that is closed, rejected or cancelled no longer changes. */
const FROZEN_STATUSES: readonly string[] = ['CLOSED', 'REJECTED', 'CANCELLED'];

export interface ComponentWrite {
  projectId: string;
  body: Record<string, unknown>;
  actor: string;
  scopes: StageScopes;
}

export interface ComponentChange {
  id: string;
  projectId: string;
  projectCode: string;
  classification: ProjectClassification;
  projectVersion: number;
  code: string;
  name: string;
  parentId: string | null;
  plannedValueVnd: string;
  depth: number;
  /** The first-level components now add up to more than the investment total of the project. */
  exceedsTotal: boolean;
  wbsTotalVnd: string;
  projectTotalVnd: string;
}

export interface MilestoneWrite {
  projectId: string;
  body: Record<string, unknown>;
  actor: string;
  scopes: StageScopes;
  today: string;
}

export interface MilestoneProgressWrite {
  milestoneId: string;
  expectedVersion: number;
  body: Record<string, unknown>;
  actor: string;
  scopes: StageScopes;
  today: string;
}

export interface DependencyWrite {
  milestoneId: string;
  expectedVersion: number;
  dependsOnId: string | null;
  actor: string;
  scopes: StageScopes;
  today: string;
}

export interface ProjectMilestoneChange {
  id: string;
  projectId: string;
  projectCode: string;
  classification: ProjectClassification;
  projectVersion: number;
  code: string;
  status: MilestoneStatus;
  previousStatus: MilestoneStatus | null;
  baselineDate: string;
  plannedDate: string;
  previousPlannedDate: string | null;
  actualDate: string | null;
  dependsOnId: string | null;
  previousDependsOnId: string | null;
  reason: string | null;
  delayDays: number;
  version: number;
}

export interface ComponentLine {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  plannedValueVnd: string;
  sortOrder: number;
  validFrom: string;
  validUntil: string | null;
  depth: number;
}

export interface ComponentRegister {
  lines: ComponentLine[];
  /** The planned value of the first-level components and the investment total of the project, whole dong. */
  wbsTotalVnd: string;
  projectTotalVnd: string;
  exceedsTotal: boolean;
}

export interface ProjectMilestoneLine {
  id: string;
  code: string;
  name: string;
  component: { id: string; code: string; name: string } | null;
  baselineDate: string;
  plannedDate: string;
  actualDate: string | null;
  dependsOn: { id: string; code: string } | null;
  status: MilestoneStatus;
  reason: string | null;
  delayDays: number;
  version: number;
}

interface ComponentSql {
  id: string;
  parent_component_id: string | null;
  code: string;
  name: string;
  planned_value_vnd: string;
  sort_order: number;
  valid_from: string;
  valid_until: string | null;
  depth: number;
}

interface MilestoneSql {
  id: string;
  project_id: string;
  code: string;
  name: string;
  component_id: string | null;
  baseline_date: string;
  planned_date: string;
  actual_date: string | null;
  depends_on_milestone_id: string | null;
  status: MilestoneStatus;
  status_reason: string | null;
  version: string;
}

const MILESTONE_COLUMNS = `m.id, m.project_id, m.code, m.name, m.component_id, m.baseline_date::text as baseline_date, m.planned_date::text as planned_date, m.actual_date::text as actual_date,
  m.depends_on_milestone_id, m.status, m.status_reason, m.version::text as version`;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export class PrjWbsStore {
  /** Adds a component under a parent of the same project that has not ended, within the depth the tree takes. The first level adding up to more than the total is reported, never refused. */
  async addComponent(tx: TenantTx, request: ComponentWrite): Promise<ComponentChange> {
    const project = await this.lockOpen(tx, request.projectId, request.scopes);
    const input = assertComponentInput(request.body);
    let depth = 1;
    if (input.parentId !== undefined) {
      const parent = (await tx.query<{ depth: number; valid_until: string | null }>(this.depthSql('where c.id = $2::uuid'), [project.id, input.parentId]))[0];
      if (parent === undefined) throw invalid('parent_component_id');
      if (parent.valid_until !== null) throw invalid('parent_component_id');
      depth = parent.depth + 1;
      if (depth > MAX_COMPONENT_DEPTH) throw invalid('parent_component_id');
    }
    const taken = await tx.query<{ id: string }>('select id from machvon.project_component where project_id = $1::uuid and code = $2', [project.id, input.code]);
    if (taken[0] !== undefined) throw new DomainError('COMPONENT_CODE_DUPLICATE', 409, 'code');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.project_component (tenant_id, id, project_id, parent_component_id, code, name, planned_value_vnd, sort_order, valid_from, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7, $8::date, $9::uuid, $9::uuid)`,
      [id, project.id, input.parentId ?? null, input.code, input.name, input.plannedValueVnd, input.sortOrder, input.validFrom, request.actor],
    );
    const sums = await this.firstLevel(tx, project.id);
    return {
      id,
      projectId: project.id,
      projectCode: project.code,
      classification: project.classification,
      projectVersion: project.version,
      code: input.code,
      name: input.name,
      parentId: input.parentId ?? null,
      plannedValueVnd: input.plannedValueVnd,
      depth,
      exceedsTotal: wbsExceedsTotal(sums, project.totalInvestmentVnd),
      wbsTotalVnd: sums.reduce((sum, value) => sum + BigInt(value), 0n).toString(),
      projectTotalVnd: project.totalInvestmentVnd,
    };
  }

  /** Adds a milestone (planned) with its baseline day, on a component and behind a milestone of the same project. */
  async addMilestone(tx: TenantTx, request: MilestoneWrite): Promise<ProjectMilestoneChange> {
    const project = await this.lockOpen(tx, request.projectId, request.scopes);
    const input = assertMilestoneInput(request.body);
    if (input.componentId !== undefined) {
      const found = await tx.query<{ id: string }>('select id from machvon.project_component where project_id = $1::uuid and id = $2::uuid', [project.id, input.componentId]);
      if (found[0] === undefined) throw invalid('component_id');
    }
    if (input.dependsOnId !== undefined) {
      const found = await tx.query<{ id: string }>('select id from machvon.project_milestone where project_id = $1::uuid and id = $2::uuid', [project.id, input.dependsOnId]);
      if (found[0] === undefined) throw invalid('depends_on_milestone_id');
    }
    const taken = await tx.query<{ id: string }>('select id from machvon.project_milestone where project_id = $1::uuid and code = $2', [project.id, input.code]);
    if (taken[0] !== undefined) throw new DomainError('MILESTONE_CODE_DUPLICATE', 409, 'code');
    const id = randomUUID();
    const rows = await tx.query<MilestoneSql>(
      `insert into machvon.project_milestone as m (tenant_id, id, project_id, component_id, code, name, baseline_date, planned_date, depends_on_milestone_id, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::date, $8::uuid, 'PLANNED', $9::uuid, $9::uuid)
       returning ${MILESTONE_COLUMNS}`,
      [id, project.id, input.componentId ?? null, input.code, input.name, input.baselineDate, input.plannedDate, input.dependsOnId ?? null, request.actor],
    );
    return this.changeOf(project, required(rows[0]), null, null, request.today);
  }

  /** Records what happened to a milestone under the version the caller saw: done on a day, delayed to a later day with a reason, or cancelled with a reason. */
  async recordProgress(tx: TenantTx, request: MilestoneProgressWrite): Promise<ProjectMilestoneChange> {
    const { project, milestone } = await this.lockMilestone(tx, request.milestoneId, request.scopes);
    if (Number(milestone.version) !== request.expectedVersion) throw versionConflict(Number(milestone.version));
    const progress = assertMilestoneProgress(request.body, { status: milestone.status, plannedDate: milestone.planned_date }, request.today);
    const rows = await tx.query<MilestoneSql>(
      `update machvon.project_milestone as m
          set status = $2, actual_date = $3::date, planned_date = coalesce($4::date, planned_date), status_reason = $5, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where m.id = $1::uuid
        returning ${MILESTONE_COLUMNS}`,
      [milestone.id, progress.status, progress.actualDate ?? null, progress.plannedDate ?? null, progress.reason ?? null, request.actor],
    );
    return this.changeOf(project, required(rows[0]), milestone, milestone.depends_on_milestone_id, request.today);
  }

  /**
   * Makes a milestone wait for another one of the project, or for none. A dependency that would close a loop (a milestone waiting, through others, for itself) is 409 `DEPENDENCY_CYCLE` and the dependencies stay as
   * they were.
   */
  async setDependency(tx: TenantTx, request: DependencyWrite): Promise<ProjectMilestoneChange> {
    const { project, milestone } = await this.lockMilestone(tx, request.milestoneId, request.scopes);
    if (Number(milestone.version) !== request.expectedVersion) throw versionConflict(Number(milestone.version));
    if (milestone.status === 'DONE' || milestone.status === 'CANCELLED') throw new DomainError('MILESTONE_STATE_INVALID', 409, 'status', { extensions: { status: milestone.status } });
    if (request.dependsOnId !== null) {
      const all = await tx.query<{ id: string; depends_on_milestone_id: string | null }>('select id, depends_on_milestone_id from machvon.project_milestone where project_id = $1::uuid', [project.id]);
      if (!all.some((row) => row.id === request.dependsOnId)) throw invalid('depends_on_milestone_id');
      const links = new Map(all.map((row) => [row.id, row.depends_on_milestone_id]));
      if (formsCycle(links, milestone.id, request.dependsOnId)) throw new DomainError('DEPENDENCY_CYCLE', 409, 'depends_on_milestone_id');
    }
    const rows = await tx.query<MilestoneSql>(
      `update machvon.project_milestone as m set depends_on_milestone_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where m.id = $1::uuid returning ${MILESTONE_COLUMNS}`,
      [milestone.id, request.dependsOnId, request.actor],
    );
    return this.changeOf(project, required(rows[0]), milestone, milestone.depends_on_milestone_id, request.today);
  }

  /** The components of the project in the scope of the caller, in the order of the tree (each under its parent, by place then code), with the first level set against the total. A project out of sight is not found. */
  async listComponents(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<ComponentRegister> {
    const total = await this.visibleTotal(tx, scope, projectId);
    const lines = await tx.query<ComponentSql>(
      `${this.depthSql('')} order by c.path`,
      [projectId],
    );
    const firstLevel = lines.filter((line) => line.parent_component_id === null && line.valid_until === null).map((line) => line.planned_value_vnd);
    return {
      lines: lines.map((line) => ({
        id: line.id,
        parentId: line.parent_component_id,
        code: line.code,
        name: line.name,
        plannedValueVnd: line.planned_value_vnd,
        sortOrder: line.sort_order,
        validFrom: line.valid_from,
        validUntil: line.valid_until,
        depth: line.depth,
      })),
      wbsTotalVnd: firstLevel.reduce((sum, value) => sum + BigInt(value), 0n).toString(),
      projectTotalVnd: total,
      exceedsTotal: wbsExceedsTotal(firstLevel, total),
    };
  }

  /** The milestones of the project in the scope of the caller, by planned day, with the component they belong to, the one they wait for and how many calendar days they are late against the baseline. */
  async listMilestones(tx: TenantTx, scope: ScopeBuilder, projectId: string, today: string): Promise<ProjectMilestoneLine[]> {
    await this.visibleTotal(tx, scope, projectId);
    const rows = await tx.query<MilestoneSql & { component_code: string | null; component_name: string | null; depends_code: string | null }>(
      `select ${MILESTONE_COLUMNS}, c.code as component_code, c.name as component_name, d.code as depends_code
         from machvon.project_milestone m
         left join machvon.project_component c on c.tenant_id = m.tenant_id and c.id = m.component_id
         left join machvon.project_milestone d on d.tenant_id = m.tenant_id and d.id = m.depends_on_milestone_id
        where m.project_id = $1::uuid order by m.planned_date, m.code`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      component: row.component_id === null ? null : { id: row.component_id, code: row.component_code ?? '', name: row.component_name ?? '' },
      baselineDate: row.baseline_date,
      plannedDate: row.planned_date,
      actualDate: row.actual_date,
      dependsOn: row.depends_on_milestone_id === null ? null : { id: row.depends_on_milestone_id, code: row.depends_code ?? '' },
      status: row.status,
      reason: row.status_reason,
      delayDays: delayDays({ status: row.status, baselineDate: row.baseline_date, plannedDate: row.planned_date, actualDate: row.actual_date }, today),
      version: Number(row.version),
    }));
  }

  private async lockOpen(tx: TenantTx, projectId: string, scopes: StageScopes): Promise<LockedProject> {
    const project = await lockProject(tx, idOf(projectId, 'id'), scopes);
    if (FROZEN_STATUSES.includes(project.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'id', { extensions: { project_status: project.status } });
    return project;
  }

  /** The milestone and its project, both locked; a milestone whose project is out of sight does not exist, one whose project is only readable is a refusal. */
  private async lockMilestone(tx: TenantTx, milestoneId: string, scopes: StageScopes): Promise<{ project: LockedProject; milestone: MilestoneSql }> {
    const found = await tx.query<{ project_id: string }>('select project_id from machvon.project_milestone where id = $1::uuid', [idOf(milestoneId, 'id')]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await this.lockOpen(tx, found[0].project_id, scopes);
    const rows = await tx.query<MilestoneSql>(`select ${MILESTONE_COLUMNS} from machvon.project_milestone m where m.id = $1::uuid for update`, [milestoneId]);
    return { project, milestone: required(rows[0]) };
  }

  private changeOf(project: LockedProject, row: MilestoneSql, before: MilestoneSql | null, previousDependsOn: string | null | undefined, today: string | undefined): ProjectMilestoneChange {
    return {
      id: row.id,
      projectId: project.id,
      projectCode: project.code,
      classification: project.classification,
      projectVersion: project.version,
      code: row.code,
      status: row.status,
      previousStatus: before?.status ?? null,
      baselineDate: row.baseline_date,
      plannedDate: row.planned_date,
      previousPlannedDate: before?.planned_date ?? null,
      actualDate: row.actual_date,
      dependsOnId: row.depends_on_milestone_id,
      previousDependsOnId: previousDependsOn ?? null,
      reason: row.status_reason,
      delayDays: delayDays({ status: row.status, baselineDate: row.baseline_date, plannedDate: row.planned_date, actualDate: row.actual_date }, today ?? row.baseline_date),
      version: Number(row.version),
    };
  }

  private async firstLevel(tx: TenantTx, projectId: string): Promise<string[]> {
    const rows = await tx.query<{ planned_value_vnd: string }>('select planned_value_vnd::text as planned_value_vnd from machvon.project_component where project_id = $1::uuid and parent_component_id is null and valid_until is null', [projectId]);
    return rows.map((row) => row.planned_value_vnd);
  }

  private async visibleTotal(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<string> {
    const predicate = scope(2);
    const found = await tx.query<{ total: string }>(`select p.total_investment_vnd::text as total from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return found[0].total;
  }

  /** The components of a project with their depth and a path (one sort key per level, so the descendants of a component stay under it whatever the codes of its brothers) that sorts them in the order of the tree. */
  private depthSql(filter: string): string {
    return `with recursive tree as (
        select c.*, 1 as depth, array[lpad(c.sort_order::text, 6, '0') || '/' || c.code] as path
          from machvon.project_component c where c.project_id = $1::uuid and c.parent_component_id is null
        union all
        select c.*, t.depth + 1, t.path || (lpad(c.sort_order::text, 6, '0') || '/' || c.code)
          from machvon.project_component c join tree t on t.id = c.parent_component_id
      )
      select c.id, c.parent_component_id, c.code, c.name, c.planned_value_vnd::text as planned_value_vnd, c.sort_order, c.valid_from::text as valid_from, c.valid_until::text as valid_until, c.depth, c.path
        from tree c ${filter}`;
  }
}

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  return row;
}
