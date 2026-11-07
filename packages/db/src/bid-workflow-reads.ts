import {
  DomainError,
  WORKFLOW_METHODS,
  WORKFLOW_RULE_TYPE,
  blockedReasons,
  buildPackageTimeline,
  buildProcessTree,
  countdownOf,
  daysInStep,
  defaultWorkflowDefinition,
  filterTimeline,
  ganttOf,
  groupTimelineByDay,
  isStalled,
  isTreeNodeId,
  isWorkflowMethod,
  mergeRecentChanges,
  packagesOfNode,
  parseWorkflowDefinition,
  stepStatistics,
  stuckPackages,
  timelineSummary,
  treeLeafOf,
  vietnamDateOf,
  workflowAddDays,
  workflowDaysBetween,
  workflowMedianOf,
  workflowProgressOf,
  WORKFLOW_DEFAULT_STALLED_DAYS,
} from '@machvon/kernel';
import type {
  BlockedFinding,
  FeedEntry,
  GanttBar,
  ItemStatus,
  ProcessTree,
  ProcurementWorkflowDefinition,
  StepStatistic,
  StepVisitFact,
  StuckPackage,
  TimelineDay,
  TimelineEntry,
  TimelineFilter,
  TimelineItemFact,
  TimelineLogFact,
  TimelineMilestoneFact,
  TimelineVisitFact,
  TreePackage,
  TreeTransition,
  WorkCalendarSource,
  WorkflowProgress,
  WorkflowStatus,
  WorkflowStepSummary,
} from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { PACKAGE_STATUSES_WITHOUT_MILESTONES } from './bid-milestone-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { visitStateOf } from './bid-workflow-store.ts';
import type { ItemRow, VisitRow } from './bid-workflow-store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The most packages one read puts in memory (a tree over more says it was cut: the counts are then a lower bound). */
export const WORKFLOW_READ_LIMIT = 5000;
const FEED_PACKAGE_LIMIT = 200;
const BOARD_CARDS_PER_COLUMN = 20;

export interface WorkflowFilter {
  unitId?: string | undefined;
  projectId?: string | undefined;
  method?: string | undefined;
  ownerId?: string | undefined;
  lateOnly?: boolean | undefined;
  q?: string | undefined;
}

export interface WorkflowPeriod {
  from: string;
  to: string;
}

/** One package as the boards, the lists and the tree read it. */
export interface WorkflowPackageRow {
  packageId: string;
  packageCode: string;
  title: string | null;
  valueVnd: string;
  method: string;
  packageStatus: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  unitId: string;
  unitName: string;
  workflowId: string | null;
  status: WorkflowStatus | 'NOT_STARTED';
  currentStep: string | null;
  currentStepName: string | null;
  stepOrder: number | null;
  stepsTotal: number | null;
  visit: number | null;
  enteredOn: string | null;
  enteredVia: 'START' | 'ADVANCE' | 'RETURN' | 'CORRECTION' | null;
  daysInStep: { calendarDays: number; workingDays: number | null } | null;
  dueOn: string | null;
  countdown: { daysLeft: number; dueOn: string } | null;
  late: boolean;
  lateDays: number;
  holdReason: string | null;
  ownerId: string | null;
  ownerName: string | null;
  lastActivityOn: string | null;
  stalled: boolean | null;
  progress: WorkflowProgress | null;
  openRequiredItems: number;
  version: number | null;
  substate: string | null;
  sparkline: Array<{ stepCode: string; days: number }>;
  /** The units that own and invest in the project, so the caller's permission can be judged for it. */
  reach: { ownerUnit: { id: string; path: string }; investorUnit: { id: string; path: string } | null };
  tree: TreePackage;
}

interface PackageSql {
  package_id: string;
  package_code: string;
  title: string | null;
  value_vnd: string;
  method: string;
  package_status: string;
  project_id: string;
  project_code: string;
  project_name: string;
  unit_id: string;
  unit_name: string;
  unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  workflow_id: string | null;
  wf_status: WorkflowStatus | null;
  current_step_code: string | null;
  current_visit: number | null;
  owner_membership_id: string | null;
  owner_name: string | null;
  hold_reason: string | null;
  last_activity_on: string | null;
  row_version: number | null;
  definition: Record<string, unknown> | null;
  entered_on: string | null;
  entry_kind: 'START' | 'ADVANCE' | 'RETURN' | 'CORRECTION' | null;
  due_on: string | null;
  visit_id: string | null;
  open_required: number | null;
  done_required: number | null;
}

interface VisitSql {
  id: string;
  workflow_id: string;
  visit: number;
  step_code: string;
  entered_at: string;
  entered_on: string;
  entered_by: string | null;
  entry_kind: TimelineVisitFact['entryKind'];
  due_on: string | null;
  standard_working_days: number;
  exited_at: string | null;
  exited_on: string | null;
  exited_by: string | null;
  exit_kind: TimelineVisitFact['exitKind'];
  working_days_spent: number | null;
  calendar_days_spent: number | null;
  note: string | null;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const idFilter = (value: string | undefined, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

/**
 * The reads of the workflow of procurement packages (PRC-1): the process tree and the packages of a node, the board by step, the list, the timeline of a package, the feed of a node, the statistics of the steps and the summary of
 * the dashboard card. Every read goes through the scope of the caller (a package outside it is not counted, listed or named), says the day it was read on, and counts days on the published working calendar where there is one.
 */
export class BidWorkflowReads {
  private readonly policy: GovernancePolicyPort;
  private readonly calendars: HomeWorkCalendars;

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policy = policy;
    this.calendars = calendars;
  }

  /** The definition of each method as the board and the tree draw it: the approved rule in force or the built-in default (a method with no usable definition falls back to the default). */
  async definitions(tx: TenantTx, today: string): Promise<ProcurementWorkflowDefinition[]> {
    const result: ProcurementWorkflowDefinition[] = [];
    for (const method of WORKFLOW_METHODS) {
      const resolved = await this.policy.get(tx, WORKFLOW_RULE_TYPE, method, today);
      try {
        result.push(resolved === undefined ? defaultWorkflowDefinition(method) : parseWorkflowDefinition(resolved.params, method));
      } catch {
        result.push(defaultWorkflowDefinition(method));
      }
    }
    return result;
  }

  async calendar(tx: TenantTx, now: Date): Promise<WorkCalendarSource | undefined> {
    return this.calendars.load(tx, WORK_CALENDAR_CODE, now);
  }

  /** The packages in the scope that have a workflow or are approved and wait for one, with what the boards need to say of each; `truncated` when more than the limit were found. */
  async packages(tx: TenantTx, filter: WorkflowFilter, scope: ScopeBuilder, now: Date): Promise<{ rows: WorkflowPackageRow[]; truncated: boolean; asOf: string; calendars: WorkCalendarSource | undefined; definitions: ProcurementWorkflowDefinition[] }> {
    const today = vietnamDateOf(now);
    const calendars = await this.calendar(tx, now);
    const definitions = await this.definitions(tx, today);
    const predicate = scope(1);
    const params: unknown[] = [...predicate.params];
    const where: string[] = [predicate.sql, `(w.id is not null or k.status not in (${PACKAGE_STATUSES_WITHOUT_MILESTONES.map((status) => `'${status}'`).join(', ')}))`];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const unitId = idFilter(filter.unitId, 'unit_id');
    if (unitId !== undefined) where.push(`starts_with(ou.path, (select path from machvon.organization_unit where id = ${add(unitId)}::uuid))`);
    const projectId = idFilter(filter.projectId, 'project_id');
    if (projectId !== undefined) where.push(`p.id = ${add(projectId)}::uuid`);
    if (filter.method !== undefined) {
      if (!isWorkflowMethod(filter.method)) throw invalid('method');
      where.push(`k.method = ${add(filter.method)}`);
    }
    const ownerId = idFilter(filter.ownerId, 'owner_id');
    if (ownerId !== undefined) where.push(`w.owner_membership_id = ${add(ownerId)}::uuid`);
    if (filter.q !== undefined) {
      const text = filter.q.trim();
      if (text.length < 1 || text.length > 100) throw invalid('q');
      const like = add(`%${escapeLike(text)}%`);
      where.push(`(k.code ilike ${like} escape '\\' or k.title ilike ${like} escape '\\')`);
    }
    const rows = await tx.query<PackageSql>(
      `select k.id as package_id, k.code as package_code, k.title, k.budget_vnd::text as value_vnd, k.method, k.status as package_status,
              p.id as project_id, p.code as project_code, p.name as project_name, ou.id as unit_id, ou.name as unit_name, ou.path as unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path,
              w.id as workflow_id, w.status as wf_status, w.current_step_code, w.current_visit, w.owner_membership_id, d.display_name as owner_name, w.hold_reason,
              w.last_activity_on::text as last_activity_on, w.row_version, w.definition,
              s.entered_on::text as entered_on, s.entry_kind, s.due_on::text as due_on, s.id as visit_id,
              (select count(*)::int from machvon.package_checklist_item i where i.tenant_id = s.tenant_id and i.step_visit_id = s.id and i.required and i.status = 'OPEN') as open_required,
              (select count(*)::int from machvon.package_checklist_item i where i.tenant_id = s.tenant_id and i.step_visit_id = s.id and i.required and i.status <> 'OPEN') as done_required
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         left join machvon.package_workflow w on w.tenant_id = k.tenant_id and w.package_id = k.id
         left join machvon.package_step s on s.tenant_id = w.tenant_id and s.workflow_id = w.id and s.exited_at is null
         left join machvon.tenant_user_directory d on d.tenant_id = w.tenant_id and d.membership_id = w.owner_membership_id
        where ${where.join(' and ')}
        order by k.code, k.id
        limit ${WORKFLOW_READ_LIMIT + 1}`,
      params,
    );
    const truncated = rows.length > WORKFLOW_READ_LIMIT;
    const kept = truncated ? rows.slice(0, WORKFLOW_READ_LIMIT) : rows;
    const transitions = await this.transitionsOf(tx, kept.map((row) => row.workflow_id).filter((id): id is string => id !== null));
    const mapped = kept.map((row) => this.rowOf(row, definitions, transitions.get(row.workflow_id ?? '') ?? [], today, calendars));
    return { rows: filter.lateOnly === true ? mapped.filter((row) => row.late) : mapped, truncated, asOf: now.toISOString(), calendars, definitions };
  }

  private rowOf(row: PackageSql, definitions: readonly ProcurementWorkflowDefinition[], transitions: TreeTransition[], today: string, calendars: WorkCalendarSource | undefined): WorkflowPackageRow {
    const status: WorkflowStatus | 'NOT_STARTED' = row.wf_status ?? 'NOT_STARTED';
    // A package reads its own frozen definition; one with none (not started) reads the current one of its method.
    const definition = row.definition === null ? definitions.find((one) => one.method === row.method) : this.frozen(row.definition, definitions, row.method);
    const step = definition?.steps.find((one) => one.code === row.current_step_code);
    const running = status === 'IN_PROGRESS' || status === 'ON_HOLD';
    const dwell = running && row.entered_on !== null ? daysInStep(calendars, row.entered_on, today) : null;
    const countdown = running ? countdownOf(row.due_on, today) : null;
    const late = status === 'IN_PROGRESS' && row.due_on !== null && today > row.due_on;
    const stalledDays = definition?.stalledAfterWorkingDays ?? WORKFLOW_DEFAULT_STALLED_DAYS;
    const stalled = running && row.last_activity_on !== null ? (isStalled(calendars, row.last_activity_on, today, stalledDays) ?? null) : null;
    const required = (row.open_required ?? 0) + (row.done_required ?? 0);
    const progress = definition === undefined || row.wf_status === null ? null : workflowProgressOf(definition, status as WorkflowStatus, row.entered_on === null || row.current_step_code === null ? null : { stepCode: row.current_step_code, enteredOn: row.entered_on, dueOn: row.due_on, items: Array.from({ length: required }, (_, index) => ({ code: String(index), required: true, status: (index < (row.done_required ?? 0) ? 'DONE' : 'OPEN') as ItemStatus, completedBy: null, evidenceKinds: [], dueOn: null })) });
    const tree: TreePackage = { id: row.package_id, method: row.method, status, currentStep: row.current_step_code, enteredOn: row.entered_on, enteredVia: row.entry_kind, dueOn: row.due_on, valueVnd: row.value_vnd, transitions };
    return {
      packageId: row.package_id,
      packageCode: row.package_code,
      title: row.title,
      valueVnd: row.value_vnd,
      method: row.method,
      packageStatus: row.package_status,
      projectId: row.project_id,
      projectCode: row.project_code,
      projectName: row.project_name,
      unitId: row.unit_id,
      unitName: row.unit_name,
      workflowId: row.workflow_id,
      status,
      currentStep: row.current_step_code,
      currentStepName: step?.name ?? null,
      stepOrder: step?.order ?? null,
      stepsTotal: definition?.steps.length ?? null,
      visit: row.current_visit,
      enteredOn: row.entered_on,
      enteredVia: row.entry_kind,
      daysInStep: dwell,
      dueOn: row.due_on,
      countdown,
      late,
      lateDays: late && row.due_on !== null ? workflowDaysBetween(row.due_on, today) : 0,
      holdReason: row.hold_reason,
      ownerId: row.owner_membership_id,
      ownerName: row.owner_name,
      lastActivityOn: row.last_activity_on,
      stalled,
      progress,
      openRequiredItems: row.open_required ?? 0,
      version: row.row_version === null ? null : Number(row.row_version),
      substate: running ? treeLeafOf(tree, today).split(':')[3] ?? null : null,
      sparkline: [],
      reach: {
        ownerUnit: { id: row.unit_id, path: row.unit_path },
        investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
      },
      tree,
    };
  }

  private frozen(params: Record<string, unknown>, definitions: readonly ProcurementWorkflowDefinition[], method: string): ProcurementWorkflowDefinition | undefined {
    try {
      return parseWorkflowDefinition(params);
    } catch {
      return definitions.find((one) => one.method === method);
    }
  }

  /** The moves of the packages, derived from the visits and the holds: the edges of the tree and the arrivals and departures of a node. */
  private async transitionsOf(tx: TenantTx, workflowIds: readonly string[]): Promise<Map<string, TreeTransition[]>> {
    const result = new Map<string, TreeTransition[]>();
    if (workflowIds.length === 0) return result;
    const visits = await tx.query<{ workflow_id: string; visit: number; step_code: string; entered_on: string; entry_kind: string; exited_on: string | null; exit_kind: string | null }>(
      `select workflow_id, visit, step_code, entered_on::text as entered_on, entry_kind, exited_on::text as exited_on, exit_kind from machvon.package_step where workflow_id = any($1::uuid[]) order by workflow_id, visit`,
      [workflowIds],
    );
    const holds = await tx.query<{ workflow_id: string; step_code: string | null; on: string }>(
      `select workflow_id, step_code, ((at at time zone 'Asia/Ho_Chi_Minh')::date)::text as "on" from machvon.package_workflow_log where workflow_id = any($1::uuid[]) and kind = 'HOLD'`,
      [workflowIds],
    );
    const byWorkflow = new Map<string, typeof visits>();
    for (const visit of visits) {
      const group = byWorkflow.get(visit.workflow_id);
      if (group === undefined) byWorkflow.set(visit.workflow_id, [visit]);
      else group.push(visit);
    }
    for (const [workflowId, list] of byWorkflow) {
      const moves: TreeTransition[] = [];
      list.forEach((visit, index) => {
        if (visit.entry_kind === 'START') moves.push({ kind: 'START', from: null, to: visit.step_code, on: visit.entered_on });
        if (visit.exited_on === null || visit.exit_kind === null) return;
        const next = list[index + 1]?.step_code ?? null;
        const kind = visit.exit_kind === 'ADVANCE' ? 'ADVANCE' : visit.exit_kind === 'RETURN' ? 'RETURN' : visit.exit_kind === 'CORRECTED' ? 'CORRECTION' : visit.exit_kind === 'COMPLETE' ? 'COMPLETE' : 'CANCEL';
        moves.push({ kind, from: visit.step_code, to: kind === 'COMPLETE' || kind === 'CANCEL' ? null : next, on: visit.exited_on });
      });
      result.set(workflowId, moves);
    }
    for (const hold of holds) {
      if (hold.step_code === null) continue;
      const moves = result.get(hold.workflow_id) ?? [];
      moves.push({ kind: 'HOLD', from: hold.step_code, to: hold.step_code, on: hold.on });
      result.set(hold.workflow_id, moves);
    }
    return result;
  }

  // ---- the tree ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async tree(tx: TenantTx, filter: WorkflowFilter, period: WorkflowPeriod, scope: ScopeBuilder, now: Date): Promise<{ tree: ProcessTree; truncated: boolean; asOf: string }> {
    this.assertPeriod(period);
    const loaded = await this.packages(tx, filter, scope, now);
    const today = vietnamDateOf(now);
    const tree = buildProcessTree(loaded.definitions, loaded.rows.map((row) => row.tree), { asOf: today, period, calendars: loaded.calendars });
    return { tree, truncated: loaded.truncated, asOf: loaded.asOf };
  }

  /** The packages of a node of the tree (the same rule the tree counts with), in the order of their code. */
  async nodePackages(tx: TenantTx, nodeId: string, filter: WorkflowFilter, scope: ScopeBuilder, now: Date): Promise<{ rows: WorkflowPackageRow[]; truncated: boolean; asOf: string }> {
    if (!isTreeNodeId(nodeId)) throw invalid('node_id');
    const loaded = await this.packages(tx, filter, scope, now);
    const today = vietnamDateOf(now);
    const inside = new Set(packagesOfNode(loaded.rows.map((row) => row.tree), nodeId, today, loaded.definitions).map((one) => one.id));
    return { rows: loaded.rows.filter((row) => inside.has(row.packageId)), truncated: loaded.truncated, asOf: loaded.asOf };
  }

  /** Adds to rows (a page) the days spent in each step they passed (the little timeline of the table). */
  async withSparklines(tx: TenantTx, rows: readonly WorkflowPackageRow[], today: string): Promise<WorkflowPackageRow[]> {
    const ids = rows.map((row) => row.workflowId).filter((id): id is string => id !== null);
    if (ids.length === 0) return [...rows];
    const visits = await tx.query<{ workflow_id: string; step_code: string; days: number }>(
      `select workflow_id, step_code, coalesce(calendar_days_spent, ($2::date - entered_on))::int as days from machvon.package_step where workflow_id = any($1::uuid[]) order by workflow_id, visit`,
      [ids, today],
    );
    const by = new Map<string, Array<{ stepCode: string; days: number }>>();
    for (const visit of visits) {
      const list = by.get(visit.workflow_id) ?? [];
      list.push({ stepCode: visit.step_code, days: Number(visit.days) });
      by.set(visit.workflow_id, list);
    }
    return rows.map((row) => ({ ...row, sparkline: row.workflowId === null ? [] : (by.get(row.workflowId) ?? []) }));
  }

  /** The numbers the side panel of a node shows: the days in the node, late, stalled and held, who holds most, the items most often unfinished, and the arrivals and departures of twelve weeks. */
  async nodeOverview(tx: TenantTx, nodeId: string, filter: WorkflowFilter, scope: ScopeBuilder, now: Date): Promise<NodeOverview> {
    const inside = await this.nodePackages(tx, nodeId, filter, scope, now);
    const rows = inside.rows;
    const days = rows.filter((row) => row.daysInStep !== null).map((row) => (row.daysInStep?.workingDays ?? row.daysInStep?.calendarDays ?? 0));
    const working = rows.filter((row) => row.daysInStep !== null).every((row) => row.daysInStep?.workingDays !== null);
    const owners = new Map<string, { id: string | null; name: string | null; count: number }>();
    for (const row of rows) {
      const key = row.ownerId ?? 'none';
      const held = owners.get(key);
      if (held === undefined) owners.set(key, { id: row.ownerId, name: row.ownerName, count: 1 });
      else held.count += 1;
    }
    const workflowIds = rows.map((row) => row.workflowId).filter((id): id is string => id !== null);
    let unfinished: Array<{ stepCode: string; itemCode: string; name: string; count: number }> = [];
    let weeks: Array<{ weekOf: string; arrivals: number; departures: number }> = [];
    if (workflowIds.length > 0) {
      const stepCode = nodeId.split(':')[0] === 'S' ? nodeId.split(':')[2] : undefined;
      unfinished = (
        await tx.query<{ step_code: string; item_code: string; name: string; count: string }>(
          `select i.step_code, i.item_code, max(i.name) as name, count(*)::text as count
             from machvon.package_checklist_item i join machvon.package_step s on s.tenant_id = i.tenant_id and s.id = i.step_visit_id and s.exited_at is null
            where i.workflow_id = any($1::uuid[]) and i.status = 'OPEN' and i.required and ($2::text is null or i.step_code = $2)
            group by i.step_code, i.item_code order by count(*) desc, i.step_code, i.item_code limit 3`,
          [workflowIds, stepCode ?? null],
        )
      ).map((row) => ({ stepCode: row.step_code, itemCode: row.item_code, name: row.name, count: Number(row.count) }));
      const today = vietnamDateOf(now);
      const flow = await tx.query<{ week_of: string; arrivals: string; departures: string }>(
        `with weeks as (select (date_trunc('week', $2::date) - (n * interval '7 days'))::date as week_of from generate_series(0, 11) n)
         select w.week_of::text as week_of,
                (select count(*) from machvon.package_step s where s.workflow_id = any($1::uuid[]) and ($3::text is null or s.step_code = $3) and s.entered_on >= w.week_of and s.entered_on < w.week_of + 7)::text as arrivals,
                (select count(*) from machvon.package_step s where s.workflow_id = any($1::uuid[]) and ($3::text is null or s.step_code = $3) and s.exited_on >= w.week_of and s.exited_on < w.week_of + 7)::text as departures
           from weeks w order by w.week_of`,
        [workflowIds, today, stepCode ?? null],
      );
      weeks = flow.map((row) => ({ weekOf: row.week_of, arrivals: Number(row.arrivals), departures: Number(row.departures) }));
    }
    return {
      nodeId,
      count: rows.length,
      medianDays: workflowMedianOf(days),
      longestDays: days.length === 0 ? null : Math.max(...days),
      shortestDays: days.length === 0 ? null : Math.min(...days),
      basis: working ? 'WORKING_DAYS' : 'CALENDAR_DAYS',
      lateCount: rows.filter((row) => row.late).length,
      stalledCount: rows.filter((row) => row.stalled === true).length,
      heldCount: rows.filter((row) => row.status === 'ON_HOLD').length,
      noOwnerCount: rows.filter((row) => row.workflowId !== null && row.ownerId === null && (row.status === 'IN_PROGRESS' || row.status === 'ON_HOLD')).length,
      topOwners: [...owners.values()].sort((left, right) => right.count - left.count || (left.name ?? '').localeCompare(right.name ?? '')).slice(0, 3),
      unfinishedItems: unfinished,
      weeks,
      truncated: inside.truncated,
      asOf: inside.asOf,
    };
  }

  /** The recent changes of the packages of a node, newest first (state changes only unless asked for all), from the append-only history. */
  async nodeFeed(tx: TenantTx, nodeId: string, filter: WorkflowFilter, range: { fromDay?: string | undefined; toDay?: string | undefined }, limit: number, onlyStateChanges: boolean, scope: ScopeBuilder, now: Date): Promise<{ entries: Array<FeedEntry & { packageCode: string }>; asOf: string; truncated: boolean }> {
    const inside = await this.nodePackages(tx, nodeId, filter, scope, now);
    const today = vietnamDateOf(now);
    const subset = inside.rows.filter((row) => row.workflowId !== null).slice(0, FEED_PACKAGE_LIMIT);
    const calendars = await this.calendar(tx, now);
    const feeds = new Map<string, readonly TimelineEntry[]>();
    const codeOf = new Map(subset.map((row) => [row.packageId, row.packageCode]));
    const facts = await this.factsOf(tx, subset.map((row) => ({ workflowId: row.workflowId as string, packageId: row.packageId })));
    for (const row of subset) {
      const fact = facts.get(row.workflowId as string);
      if (fact === undefined) continue;
      const definition = fact.definition;
      feeds.set(row.packageId, filterTimeline(buildPackageTimeline({ definition, ...fact.input, today }, calendars), { fromDay: range.fromDay, toDay: range.toDay }));
    }
    const merged = mergeRecentChanges(feeds, limit, onlyStateChanges);
    return { entries: merged.map((one) => ({ ...one, packageCode: codeOf.get(one.packageId) ?? '' })), asOf: inside.asOf, truncated: inside.truncated || inside.rows.filter((row) => row.workflowId !== null).length > FEED_PACKAGE_LIMIT };
  }

  // ---- one package ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * The workflow of one package: where it is, who holds it, the countdown, what blocks it, the checklist of the current step with its evidence, the exceptions, the shortcuts to the records that belong to it, and the timeline with its
   * summary and the planned-versus-actual strip. `null` workflow when the package has none yet (the screen offers to start it); 404 outside the scope.
   */
  async detail(tx: TenantTx, packageId: string, scope: ScopeBuilder, now: Date): Promise<PackageWorkflowDetail> {
    if (!UUID.test(packageId)) throw invalid('package_id');
    const today = vietnamDateOf(now);
    const predicate = scope(2);
    const head = await tx.query<{ id: string; code: string; title: string | null; budget_vnd: string; method: string; status: string; project_id: string; project_code: string; project_name: string; unit_id: string; unit_name: string; unit_path: string; investor_unit_id: string | null; investor_unit_path: string | null }>(
      `select k.id, k.code, k.title, k.budget_vnd::text as budget_vnd, k.method, k.status, p.id as project_id, p.code as project_code, p.name as project_name, ou.id as unit_id, ou.name as unit_name, ou.path as unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
         from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id where k.id = $1::uuid and ${predicate.sql}`,
      [packageId.toLowerCase(), ...predicate.params],
    );
    const pack = head[0];
    if (pack === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const reach = { ownerUnit: { id: pack.unit_id, path: pack.unit_path }, investorUnit: pack.investor_unit_id === null || pack.investor_unit_path === null ? null : { id: pack.investor_unit_id, path: pack.investor_unit_path } };
    const base = { packageId: pack.id, packageCode: pack.code, title: pack.title, valueVnd: pack.budget_vnd, method: pack.method, packageStatus: pack.status, projectId: pack.project_id, projectCode: pack.project_code, projectName: pack.project_name, unitName: pack.unit_name, reach, asOf: now.toISOString() };
    const workflow = await tx.query<{
      id: string;
      status: WorkflowStatus;
      current_step_code: string | null;
      current_visit: number | null;
      owner_membership_id: string | null;
      owner_name: string | null;
      hold_reason: string | null;
      held_at: string | null;
      started_at: string;
      started_by: string;
      ended_at: string | null;
      end_reason: string | null;
      last_activity_on: string;
      definition: Record<string, unknown>;
      definition_rule_version: number;
      definition_hash: string;
      row_version: number;
    }>(
      `select w.id, w.status, w.current_step_code, w.current_visit, w.owner_membership_id, d.display_name as owner_name, w.hold_reason, to_char(w.held_at at time zone 'UTC', ${ISO}) as held_at,
              to_char(w.started_at at time zone 'UTC', ${ISO}) as started_at, w.started_by, to_char(w.ended_at at time zone 'UTC', ${ISO}) as ended_at, w.end_reason, w.last_activity_on::text as last_activity_on,
              w.definition, w.definition_rule_version, w.definition_hash, w.row_version
         from machvon.package_workflow w left join machvon.tenant_user_directory d on d.tenant_id = w.tenant_id and d.membership_id = w.owner_membership_id where w.package_id = $1::uuid`,
      [pack.id],
    );
    const wf = workflow[0];
    const calendars = await this.calendar(tx, now);
    if (wf === undefined) {
      const definitions = await this.definitions(tx, today);
      const definition = definitions.find((one) => one.method === pack.method);
      return { ...base, workflow: null, startable: !PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status) && definition !== undefined, definitionSteps: definition?.steps.map((step) => ({ code: step.code, name: step.name, order: step.order, standardWorkingDays: step.standardWorkingDays })) ?? [] };
    }
    const definition = parseWorkflowDefinition(wf.definition);
    const facts = await this.factsOf(tx, [{ workflowId: wf.id, packageId: pack.id }]);
    const fact = facts.get(wf.id);
    if (fact === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const openVisit = fact.input.visits.find((visit) => visit.exitedAt === null) ?? null;
    const currentItems = openVisit === null ? [] : fact.items.filter((item) => item.visitNumber === openVisit.visit);
    const visitRow: VisitRow | null = openVisit === null ? null : { id: '', visit: openVisit.visit, stepCode: openVisit.stepCode, enteredOn: openVisit.enteredAt.slice(0, 10), entryKind: openVisit.entryKind, dueOn: openVisit.dueOn, standardWorkingDays: 0 };
    const itemRows: ItemRow[] = currentItems.map((item) => ({ id: item.id, itemCode: item.itemCode, name: item.name, required: item.required, status: item.status, completedBy: item.completedBy, dueOn: item.dueOn, evidenceKinds: item.evidence.map((one) => one.kind), evidenceRequired: item.evidenceRequired, allowedKinds: item.allowedKinds, milestoneKind: item.milestoneKind, ownerId: item.ownerId, version: item.version }));
    const enteredOn = openVisit === null ? null : this.dayOf(openVisit.enteredAt);
    const visitState = visitRow === null || enteredOn === null ? null : visitStateOf({ ...visitRow, enteredOn }, itemRows);
    const exceptions = fact.exceptions;
    const pending = exceptions.some((one) => one.status === 'REQUESTED');
    const blockers: BlockedFinding[] = blockedReasons({ status: wf.status, holdReason: wf.hold_reason, visit: visitState, dueOn: openVisit?.dueOn ?? null, today, ownerId: wf.owner_membership_id, exceptionPending: pending, calendarUnavailable: openVisit !== null && openVisit.dueOn === null && wf.status === 'IN_PROGRESS', definition });
    const progress = workflowProgressOf(definition, wf.status, visitState);
    const step = definition.steps.find((one) => one.code === wf.current_step_code);
    const timeline = buildPackageTimeline({ definition, ...fact.input, today }, calendars);
    const dwell = openVisit === null || enteredOn === null ? null : daysInStep(calendars, enteredOn, today);
    const links = await this.linksOf(tx, pack.id);
    return {
      ...base,
      workflow: {
        id: wf.id,
        status: wf.status,
        currentStep: wf.current_step_code,
        currentStepName: step?.name ?? null,
        currentVisit: wf.current_visit,
        ownerId: wf.owner_membership_id,
        ownerName: wf.owner_name,
        holdReason: wf.hold_reason,
        heldAt: wf.held_at,
        startedAt: wf.started_at,
        endedAt: wf.ended_at,
        endReason: wf.end_reason,
        lastActivityOn: wf.last_activity_on,
        definitionRuleVersion: wf.definition_rule_version,
        definitionHash: wf.definition_hash,
        version: Number(wf.row_version),
        enteredOn,
        dueOn: openVisit?.dueOn ?? null,
        countdown: wf.status === 'IN_PROGRESS' || wf.status === 'ON_HOLD' ? countdownOf(openVisit?.dueOn ?? null, today) : null,
        daysInStep: dwell,
        standardWorkingDays: step?.standardWorkingDays ?? null,
        late: wf.status === 'IN_PROGRESS' && openVisit?.dueOn !== null && openVisit?.dueOn !== undefined && today > openVisit.dueOn,
        progress,
        blockers,
        steps: definition.steps.map((one) => ({ code: one.code, name: one.name, order: one.order, standardWorkingDays: one.standardWorkingDays, responsibleRole: one.responsibleRole, entryCondition: one.entryCondition, exitCondition: one.exitCondition, makerChecker: one.makerChecker, evidenceKinds: [...one.evidenceKinds], milestoneKind: one.milestoneKind })),
        checklist: currentItems.map((item) => ({ id: item.id, code: item.itemCode, name: item.name, required: item.required, status: item.status, dueOn: item.dueOn, completedAt: item.completedAt, completedBy: item.completedBy, completedVia: item.completedVia, ownerId: item.ownerId, evidenceRequired: item.evidenceRequired, allowedKinds: item.allowedKinds, milestoneKind: item.milestoneKind, evidence: item.evidence, version: item.version })),
        exceptions: exceptions.map((one) => ({ id: one.id, kind: one.kind, status: one.status, reason: one.reason, requestedBy: one.requestedBy, requestedAt: one.requestedAt, decidedBy: one.decidedBy, decidedAt: one.decidedAt, decisionNote: one.decisionNote, stepCode: one.stepCode })),
        history: fact.input.visits.map((visit) => ({ visit: visit.visit, stepCode: visit.stepCode, enteredAt: visit.enteredAt, enteredBy: visit.enteredBy, entryKind: visit.entryKind, exitedAt: visit.exitedAt, exitedBy: visit.exitedBy, exitKind: visit.exitKind, dueOn: visit.dueOn, note: visit.note })),
        summary: timelineSummary(definition, fact.input.visits, today, calendars),
        gantt: ganttOf(definition, fact.input.visits, today, calendars),
        timeline,
        links,
      },
    };
  }

  /** The timeline of a package with the filters of the screen: a day range, one person, or only the changes of state; grouped by day, newest day first by default. */
  async timeline(tx: TenantTx, packageId: string, filter: TimelineFilter & { oldestFirst?: boolean | undefined }, scope: ScopeBuilder, now: Date): Promise<{ days: TimelineDay[]; entries: TimelineEntry[]; summary: WorkflowStepSummary[]; gantt: GanttBar[]; asOf: string; empty: boolean }> {
    const detail = await this.detail(tx, packageId, scope, now);
    if (detail.workflow === null) return { days: [], entries: [], summary: [], gantt: [], asOf: detail.asOf, empty: true };
    const entries = filterTimeline(detail.workflow.timeline, filter);
    return { days: groupTimelineByDay(entries, filter.oldestFirst !== true), entries, summary: detail.workflow.summary, gantt: detail.workflow.gantt, asOf: detail.asOf, empty: entries.length === 0 };
  }

  private dayOf(instant: string): string {
    return vietnamDateOf(new Date(instant));
  }

  /** The records that belong to the package, for the shortcuts of the package page: the milestones (BID-17), the petitions (BID-20), the result (BID-18) and the contract (CTR). Ids and statuses only. */
  private async linksOf(tx: TenantTx, packageId: string): Promise<PackageLinks> {
    const milestones = await tx.query<{ id: string; milestone_kind: string; actual_at: string | null; planned_at: string | null; source: string }>(
      `select id, milestone_kind, to_char(actual_at at time zone 'UTC', ${ISO}) as actual_at, to_char(planned_at at time zone 'UTC', ${ISO}) as planned_at, source from machvon.procurement_milestone where package_id = $1::uuid order by milestone_kind`,
      [packageId],
    );
    const petitions = await tx.query<{ n: string; open: string }>(`select count(*)::text as n, count(*) filter (where status in ('RECEIVED', 'PROCESSING', 'ESCALATED'))::text as open from machvon.procurement_petition where package_id = $1::uuid`, [packageId]);
    const result = await tx.query<{ id: string; status: string }>(`select id, status from machvon.procurement_result where package_id = $1::uuid order by created_at desc limit 1`, [packageId]);
    const contract = await tx.query<{ id: string; code: string; status: string }>(`select id, code, status from machvon.contract where package_id = $1::uuid order by code limit 1`, [packageId]);
    return {
      milestones: milestones.map((row) => ({ id: row.id, kind: row.milestone_kind, actualAt: row.actual_at, plannedAt: row.planned_at, source: row.source })),
      petitions: { total: Number(petitions[0]?.n ?? 0), open: Number(petitions[0]?.open ?? 0) },
      result: result[0] === undefined ? null : { id: result[0].id, status: result[0].status },
      contract: contract[0] === undefined ? null : { id: contract[0].id, code: contract[0].code, status: contract[0].status },
    };
  }

  /** The facts a timeline is built from, for several workflows at once: the visits, the items with their evidence, the log, the exceptions and the milestones. */
  private async factsOf(tx: TenantTx, workflows: ReadonlyArray<{ workflowId: string; packageId: string }>): Promise<Map<string, WorkflowFacts>> {
    const result = new Map<string, WorkflowFacts>();
    if (workflows.length === 0) return result;
    const ids = workflows.map((one) => one.workflowId);
    const packageIds = workflows.map((one) => one.packageId);
    const heads = await tx.query<{ id: string; package_id: string; definition: Record<string, unknown>; started_at: string; started_by: string; ended_at: string | null }>(
      `select id, package_id, definition, to_char(started_at at time zone 'UTC', ${ISO}) as started_at, started_by, to_char(ended_at at time zone 'UTC', ${ISO}) as ended_at from machvon.package_workflow where id = any($1::uuid[])`,
      [ids],
    );
    const visits = await tx.query<VisitSql>(
      `select id, workflow_id, visit, step_code, to_char(entered_at at time zone 'UTC', ${ISO}) as entered_at, entered_on::text as entered_on, entered_by, entry_kind, due_on::text as due_on, standard_working_days,
              to_char(exited_at at time zone 'UTC', ${ISO}) as exited_at, exited_on::text as exited_on, exited_by, exit_kind, working_days_spent, calendar_days_spent, note
         from machvon.package_step where workflow_id = any($1::uuid[]) order by workflow_id, visit`,
      [ids],
    );
    const items = await tx.query<{
      id: string;
      workflow_id: string;
      visit: number;
      item_code: string;
      step_code: string;
      name: string;
      required: boolean;
      due_on: string | null;
      status: ItemStatus;
      completed_at: string | null;
      completed_by: string | null;
      completed_via: string | null;
      owner_membership_id: string | null;
      evidence_required: boolean;
      evidence_kinds: string[];
      milestone_kind: string | null;
      row_version: number;
    }>(
      `select i.id, i.workflow_id, s.visit, i.item_code, i.step_code, i.name, i.required, i.due_on::text as due_on, i.status, to_char(i.completed_at at time zone 'UTC', ${ISO}) as completed_at, i.completed_by, i.completed_via,
              i.owner_membership_id, i.evidence_required, i.evidence_kinds, i.milestone_kind, i.row_version
         from machvon.package_checklist_item i join machvon.package_step s on s.tenant_id = i.tenant_id and s.id = i.step_visit_id where i.workflow_id = any($1::uuid[]) order by i.workflow_id, s.visit, i.created_at, i.item_code`,
      [ids],
    );
    const evidence = await tx.query<{ item_id: string; evidence_kind: string; document_id: string | null; milestone_id: string | null; milestone_kind: string | null; external_ref: string | null; note: string | null }>(
      `select e.item_id, e.evidence_kind, e.document_id, e.milestone_id, m.milestone_kind, e.external_ref, e.note
         from machvon.package_checklist_evidence e left join machvon.procurement_milestone m on m.tenant_id = e.tenant_id and m.id = e.milestone_id where e.workflow_id = any($1::uuid[]) order by e.attached_at, e.id`,
      [ids],
    );
    const logs = await tx.query<{ workflow_id: string; kind: TimelineLogFact['kind']; at: string; actor: string; step_code: string | null; reason: string | null; subject: string | null }>(
      `select workflow_id, kind, to_char(at at time zone 'UTC', ${ISO}) as at, actor, step_code, reason, subject from machvon.package_workflow_log where workflow_id = any($1::uuid[]) order by at, id`,
      [ids],
    );
    const exceptions = await tx.query<{ id: string; workflow_id: string; kind: string; status: string; reason: string; requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; step_code: string }>(
      `select x.id, x.workflow_id, x.kind, x.status, x.reason, x.requested_by, to_char(x.requested_at at time zone 'UTC', ${ISO}) as requested_at, x.decided_by, to_char(x.decided_at at time zone 'UTC', ${ISO}) as decided_at, x.decision_note, s.step_code
         from machvon.package_step_exception x join machvon.package_step s on s.tenant_id = x.tenant_id and s.id = x.step_visit_id where x.workflow_id = any($1::uuid[]) order by x.requested_at`,
      [ids],
    );
    const milestones = await tx.query<{ package_id: string; milestone_kind: string; actual_at: string; source: 'MANUAL' | 'IMPORT'; import_batch_id: string | null }>(
      `select package_id, milestone_kind, to_char(actual_at at time zone 'UTC', ${ISO}) as actual_at, source, import_batch_id from machvon.procurement_milestone where package_id = any($1::uuid[]) and actual_at is not null order by actual_at`,
      [packageIds],
    );
    const evidenceOf = new Map<string, Array<{ kind: string; documentId: string | null; milestoneKind: string | null; reference: string | null }>>();
    for (const row of evidence) {
      const list = evidenceOf.get(row.item_id) ?? [];
      list.push({ kind: row.evidence_kind, documentId: row.document_id, milestoneKind: row.milestone_kind, reference: row.external_ref ?? row.note });
      evidenceOf.set(row.item_id, list);
    }
    for (const head of heads) {
      const definition = parseWorkflowDefinition(head.definition);
      const myItems = items.filter((row) => row.workflow_id === head.id).map((row): FactItem => ({
        id: row.id,
        visitNumber: row.visit,
        stepCode: row.step_code,
        itemCode: row.item_code,
        name: row.name,
        required: row.required,
        dueOn: row.due_on,
        completedAt: row.completed_at,
        completedBy: row.completed_by,
        completedVia: row.completed_via,
        status: row.status,
        evidence: evidenceOf.get(row.id) ?? [],
        ownerId: row.owner_membership_id,
        evidenceRequired: row.evidence_required,
        allowedKinds: row.evidence_kinds,
        milestoneKind: row.milestone_kind,
        version: Number(row.row_version),
      }));
      result.set(head.id, {
        definition,
        items: myItems,
        exceptions: exceptions.filter((row) => row.workflow_id === head.id).map((row) => ({ id: row.id, kind: row.kind, status: row.status, reason: row.reason, requestedBy: row.requested_by, requestedAt: row.requested_at, decidedBy: row.decided_by, decidedAt: row.decided_at, decisionNote: row.decision_note, stepCode: row.step_code })),
        input: {
          startedAt: head.started_at,
          startedBy: head.started_by,
          completedAt: head.ended_at,
          visits: visits.filter((row) => row.workflow_id === head.id).map((row) => ({ visit: row.visit, stepCode: row.step_code, enteredAt: row.entered_at, enteredBy: row.entered_by, entryKind: row.entry_kind, exitedAt: row.exited_at, exitedBy: row.exited_by, exitKind: row.exit_kind, dueOn: row.due_on, note: row.note })),
          items: myItems.map((item): TimelineItemFact => ({ stepCode: item.stepCode, itemCode: item.itemCode, name: item.name, required: item.required, dueOn: item.dueOn, completedAt: item.completedAt, completedBy: item.completedBy, status: item.status, evidence: item.evidence })),
          log: logs.filter((row) => row.workflow_id === head.id).map((row) => ({ kind: row.kind, at: row.at, actor: row.actor, stepCode: row.step_code, reason: row.reason, subject: row.subject })),
          milestones: milestones.filter((row) => row.package_id === head.package_id).map((row): TimelineMilestoneFact => ({ kind: row.milestone_kind, actualAt: row.actual_at, source: row.source, importBatchId: row.import_batch_id })),
        },
      });
    }
    return result;
  }

  // ---- the board, the statistics, the summary ----------------------------------------------------------------------------------------------------------------------------------------

  /** The board by step for one method (the one with most packages when none is named): a column for each step with its count, value and late packages, and the cards of the packages longest in it first. */
  async board(tx: TenantTx, method: string | undefined, filter: WorkflowFilter, scope: ScopeBuilder, now: Date): Promise<WorkflowBoard> {
    const loaded = await this.packages(tx, { ...filter, method: undefined }, scope, now);
    const counts = new Map<string, number>();
    for (const row of loaded.rows) counts.set(row.method, (counts.get(row.method) ?? 0) + 1);
    const methods = [...counts.entries()].map(([code, count]) => ({ method: code, count })).sort((left, right) => right.count - left.count || left.method.localeCompare(right.method));
    const chosen = method ?? methods[0]?.method ?? WORKFLOW_METHODS[0];
    if (!isWorkflowMethod(chosen)) throw invalid('method');
    const definition = loaded.definitions.find((one) => one.method === chosen) ?? defaultWorkflowDefinition(chosen);
    const mine = loaded.rows.filter((row) => row.method === chosen);
    const column = (rows: readonly WorkflowPackageRow[]): { count: number; valueVnd: string; lateCount: number; heldCount: number; cards: WorkflowPackageRow[] } => ({
      count: rows.length,
      valueVnd: rows.reduce((sum, row) => sum + BigInt(row.valueVnd), 0n).toString(),
      lateCount: rows.filter((row) => row.late).length,
      heldCount: rows.filter((row) => row.status === 'ON_HOLD').length,
      cards: [...rows].sort((left, right) => (right.daysInStep?.calendarDays ?? 0) - (left.daysInStep?.calendarDays ?? 0) || left.packageCode.localeCompare(right.packageCode)).slice(0, BOARD_CARDS_PER_COLUMN),
    });
    const known = new Set(definition.steps.map((step) => step.code));
    const inStep = (row: WorkflowPackageRow): boolean => row.status === 'IN_PROGRESS' || row.status === 'ON_HOLD';
    const columns: WorkflowBoard['columns'] = [
      { code: 'NOT_STARTED', name: null, order: 0, kind: 'NOT_STARTED', standardWorkingDays: null, ...column(mine.filter((row) => row.status === 'NOT_STARTED')) },
      ...definition.steps.map((step) => ({ code: step.code, name: step.name, order: step.order, kind: 'STEP' as const, standardWorkingDays: step.standardWorkingDays, ...column(mine.filter((row) => inStep(row) && row.currentStep === step.code)) })),
    ];
    const orphan = mine.filter((row) => inStep(row) && row.currentStep !== null && !known.has(row.currentStep));
    if (orphan.length > 0) columns.push({ code: 'OTHER', name: null, order: definition.steps.length + 1, kind: 'OTHER', standardWorkingDays: null, ...column(orphan) });
    columns.push({ code: 'COMPLETED', name: null, order: definition.steps.length + 2, kind: 'COMPLETED', standardWorkingDays: null, ...column(mine.filter((row) => row.status === 'COMPLETED')) });
    columns.push({ code: 'CANCELLED', name: null, order: definition.steps.length + 3, kind: 'CANCELLED', standardWorkingDays: null, ...column(mine.filter((row) => row.status === 'CANCELLED')) });
    const withSparks = await this.withSparklines(tx, columns.flatMap((one) => one.cards), vietnamDateOf(now));
    const sparks = new Map(withSparks.map((row) => [row.packageId, row.sparkline]));
    for (const one of columns) one.cards = one.cards.map((card) => ({ ...card, sparkline: sparks.get(card.packageId) ?? [] }));
    return { method: chosen, methodName: definition.name, methods, columns, truncated: loaded.truncated, asOf: loaded.asOf };
  }

  /** The median days each step takes, the share finished on time, the steps with most packages over the standard and the packages stuck longest, for the visits that ended in the period. */
  async statistics(tx: TenantTx, filter: WorkflowFilter, period: WorkflowPeriod, scope: ScopeBuilder, now: Date): Promise<WorkflowStatistics> {
    this.assertPeriod(period);
    const loaded = await this.packages(tx, filter, scope, now);
    const today = vietnamDateOf(now);
    const withFlow = loaded.rows.filter((row) => row.workflowId !== null);
    const facts: StepVisitFact[] = [];
    if (withFlow.length > 0) {
      const visits = await tx.query<{ workflow_id: string; package_id: string; method: string; step_code: string; entered_on: string; exited_on: string | null; exit_kind: StepVisitFact['exitKind']; standard_working_days: number; working_days_spent: number | null; calendar_days_spent: number | null }>(
        `select s.workflow_id, s.package_id, w.method, s.step_code, s.entered_on::text as entered_on, s.exited_on::text as exited_on, s.exit_kind, s.standard_working_days, s.working_days_spent, s.calendar_days_spent
           from machvon.package_step s join machvon.package_workflow w on w.tenant_id = s.tenant_id and w.id = s.workflow_id where s.workflow_id = any($1::uuid[])`,
        [withFlow.map((row) => row.workflowId)],
      );
      for (const visit of visits) {
        const open = visit.exited_on === null;
        const dwell = open ? daysInStep(loaded.calendars, visit.entered_on, today) : null;
        facts.push({
          packageId: visit.package_id,
          method: visit.method,
          stepCode: visit.step_code,
          enteredOn: visit.entered_on,
          exitedOn: visit.exited_on,
          exitKind: visit.exit_kind,
          standardWorkingDays: visit.standard_working_days,
          workingDays: open ? (dwell?.workingDays ?? null) : visit.working_days_spent,
          calendarDays: open ? (dwell?.calendarDays ?? 0) : (visit.calendar_days_spent ?? 0),
        });
      }
    }
    const nameOf = (method: string, step: string): string | null => loaded.definitions.find((one) => one.method === method)?.steps.find((one) => one.code === step)?.name ?? null;
    const stats = stepStatistics(facts, period).map((one) => ({ ...one, stepName: nameOf(one.method, one.stepCode) }));
    const byId = new Map(loaded.rows.map((row) => [row.packageId, row]));
    const stuck = stuckPackages(facts, 10).map((one) => {
      const row = byId.get(one.packageId);
      return { ...one, packageCode: row?.packageCode ?? '', title: row?.title ?? null, method: row?.method ?? '', stepName: row?.currentStepName ?? null, valueVnd: row?.valueVnd ?? '0', ownerName: row?.ownerName ?? null, late: row?.late ?? false };
    });
    const done = stats.reduce((sum, one) => sum + one.completedVisits, 0);
    const onTime = stats.reduce((sum, one) => sum + Math.round((one.onTimeShare ?? 0) * one.completedVisits), 0);
    const all = facts.filter((one) => one.exitedOn !== null && (one.exitKind === 'ADVANCE' || one.exitKind === 'COMPLETE') && one.exitedOn >= period.from && one.exitedOn <= period.to);
    const working = all.length > 0 && all.every((one) => one.workingDays !== null);
    return {
      period,
      asOf: loaded.asOf,
      truncated: loaded.truncated,
      steps: stats,
      stuck,
      kpis: { onTimeShare: done === 0 ? null : Math.round((onTime / done) * 10_000) / 10_000, completedVisits: done, medianDays: workflowMedianOf(all.map((one) => (working ? (one.workingDays as number) : one.calendarDays))), basis: working || all.length === 0 ? 'WORKING_DAYS' : 'CALENDAR_DAYS' },
    };
  }

  /** The dashboard card: how many packages, how many late, stalled, on hold and without an owner, and the five steps with most packages. */
  async summary(tx: TenantTx, filter: WorkflowFilter, scope: ScopeBuilder, now: Date): Promise<WorkflowSummary> {
    const loaded = await this.packages(tx, filter, scope, now);
    const running = loaded.rows.filter((row) => row.status === 'IN_PROGRESS' || row.status === 'ON_HOLD');
    const steps = new Map<string, { method: string; code: string; name: string | null; count: number; lateCount: number }>();
    for (const row of running) {
      const key = `${row.method}:${row.currentStep}`;
      const held = steps.get(key);
      if (held === undefined) steps.set(key, { method: row.method, code: row.currentStep ?? '', name: row.currentStepName, count: 1, lateCount: row.late ? 1 : 0 });
      else {
        held.count += 1;
        if (row.late) held.lateCount += 1;
      }
    }
    return {
      total: loaded.rows.length,
      running: running.length,
      notStarted: loaded.rows.filter((row) => row.status === 'NOT_STARTED').length,
      completed: loaded.rows.filter((row) => row.status === 'COMPLETED').length,
      late: running.filter((row) => row.late).length,
      stalled: running.filter((row) => row.stalled === true).length,
      onHold: running.filter((row) => row.status === 'ON_HOLD').length,
      noOwner: running.filter((row) => row.ownerId === null).length,
      topSteps: [...steps.values()].sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)).slice(0, 5).map((one) => ({ nodeId: `S:${one.method}:${one.code}`, ...one })),
      truncated: loaded.truncated,
      asOf: loaded.asOf,
    };
  }

  /** The display names of members (the people of a timeline, a checklist, an exception): an id with no name in the directory is left out, never guessed. */
  async names(tx: TenantTx, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
    const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string' && UUID.test(id)))];
    const names = new Map<string, string>();
    if (wanted.length === 0) return names;
    const rows = await tx.query<{ membership_id: string; display_name: string }>('select membership_id, display_name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [wanted]);
    for (const row of rows) names.set(row.membership_id, row.display_name);
    return names;
  }

  private assertPeriod(period: WorkflowPeriod): void {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(period.from) || Number.isNaN(Date.parse(`${period.from}T00:00:00Z`))) throw invalid('from');
    if (!day.test(period.to) || Number.isNaN(Date.parse(`${period.to}T00:00:00Z`))) throw invalid('to');
    if (period.to < period.from || workflowDaysBetween(period.from, period.to) > 1830) throw invalid('to');
  }

  /** The default period of a read: the last `days` days up to and including today. */
  static defaultPeriod(now: Date, days = 30): WorkflowPeriod {
    const today = vietnamDateOf(now);
    return { from: workflowAddDays(today, -days), to: today };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Shapes the reads return.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface FactItem {
  id: string;
  visitNumber: number;
  stepCode: string;
  itemCode: string;
  name: string;
  required: boolean;
  dueOn: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedVia: string | null;
  status: ItemStatus;
  evidence: Array<{ kind: string; documentId: string | null; milestoneKind: string | null; reference: string | null }>;
  ownerId: string | null;
  evidenceRequired: boolean;
  allowedKinds: string[];
  milestoneKind: string | null;
  version: number;
}

interface FactException {
  id: string;
  kind: string;
  status: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  stepCode: string;
}

interface WorkflowFacts {
  definition: ProcurementWorkflowDefinition;
  items: FactItem[];
  exceptions: FactException[];
  input: { startedAt: string; startedBy: string | null; completedAt: string | null; visits: TimelineVisitFact[]; items: TimelineItemFact[]; log: TimelineLogFact[]; milestones: TimelineMilestoneFact[] };
}

export interface NodeOverview {
  nodeId: string;
  count: number;
  medianDays: number | null;
  longestDays: number | null;
  shortestDays: number | null;
  basis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  lateCount: number;
  stalledCount: number;
  heldCount: number;
  noOwnerCount: number;
  topOwners: Array<{ id: string | null; name: string | null; count: number }>;
  unfinishedItems: Array<{ stepCode: string; itemCode: string; name: string; count: number }>;
  weeks: Array<{ weekOf: string; arrivals: number; departures: number }>;
  truncated: boolean;
  asOf: string;
}

export interface PackageLinks {
  milestones: Array<{ id: string; kind: string; actualAt: string | null; plannedAt: string | null; source: string }>;
  petitions: { total: number; open: number };
  result: { id: string; status: string } | null;
  contract: { id: string; code: string; status: string } | null;
}

export interface PackageWorkflowDetail {
  packageId: string;
  packageCode: string;
  title: string | null;
  valueVnd: string;
  method: string;
  packageStatus: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  unitName: string;
  reach: { ownerUnit: { id: string; path: string }; investorUnit: { id: string; path: string } | null };
  asOf: string;
  /** Null when the package has no workflow yet. */
  workflow: null | {
    id: string;
    status: WorkflowStatus;
    currentStep: string | null;
    currentStepName: string | null;
    currentVisit: number | null;
    ownerId: string | null;
    ownerName: string | null;
    holdReason: string | null;
    heldAt: string | null;
    startedAt: string;
    endedAt: string | null;
    endReason: string | null;
    lastActivityOn: string;
    definitionRuleVersion: number;
    definitionHash: string;
    version: number;
    enteredOn: string | null;
    dueOn: string | null;
    countdown: { daysLeft: number; dueOn: string } | null;
    daysInStep: { calendarDays: number; workingDays: number | null } | null;
    standardWorkingDays: number | null;
    late: boolean;
    progress: WorkflowProgress;
    blockers: BlockedFinding[];
    steps: Array<{ code: string; name: string; order: number; standardWorkingDays: number; responsibleRole: string; entryCondition: string; exitCondition: string; makerChecker: boolean; evidenceKinds: string[]; milestoneKind: string | null }>;
    checklist: Array<{
      id: string;
      code: string;
      name: string;
      required: boolean;
      status: ItemStatus;
      dueOn: string | null;
      completedAt: string | null;
      completedBy: string | null;
      completedVia: string | null;
      ownerId: string | null;
      evidenceRequired: boolean;
      allowedKinds: string[];
      milestoneKind: string | null;
      evidence: Array<{ kind: string; documentId: string | null; milestoneKind: string | null; reference: string | null }>;
      version: number;
    }>;
    exceptions: FactException[];
    history: Array<{ visit: number; stepCode: string; enteredAt: string; enteredBy: string | null; entryKind: string; exitedAt: string | null; exitedBy: string | null; exitKind: string | null; dueOn: string | null; note: string | null }>;
    summary: WorkflowStepSummary[];
    gantt: GanttBar[];
    timeline: TimelineEntry[];
    links: PackageLinks;
  };
  /** A package without a workflow: whether it can be started and the steps its method would follow. */
  startable?: boolean;
  definitionSteps?: Array<{ code: string; name: string; order: number; standardWorkingDays: number }>;
}

export interface WorkflowBoard {
  method: string;
  methodName: string;
  methods: Array<{ method: string; count: number }>;
  columns: Array<{ code: string; name: string | null; order: number; kind: 'NOT_STARTED' | 'STEP' | 'OTHER' | 'COMPLETED' | 'CANCELLED'; standardWorkingDays: number | null; count: number; valueVnd: string; lateCount: number; heldCount: number; cards: WorkflowPackageRow[] }>;
  truncated: boolean;
  asOf: string;
}

export interface WorkflowStatistics {
  period: WorkflowPeriod;
  asOf: string;
  truncated: boolean;
  steps: Array<StepStatistic & { stepName: string | null }>;
  stuck: Array<StuckPackage & { packageCode: string; title: string | null; method: string; stepName: string | null; valueVnd: string; ownerName: string | null; late: boolean }>;
  kpis: { onTimeShare: number | null; completedVisits: number; medianDays: number | null; basis: 'WORKING_DAYS' | 'CALENDAR_DAYS' };
}

export interface WorkflowSummary {
  total: number;
  running: number;
  notStarted: number;
  completed: number;
  late: number;
  stalled: number;
  onHold: number;
  noOwner: number;
  topSteps: Array<{ nodeId: string; method: string; code: string; name: string | null; count: number; lateCount: number }>;
  truncated: boolean;
  asOf: string;
}
