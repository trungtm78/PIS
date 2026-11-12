import { DomainError, versionConflict } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import type { NationalCodeRule } from './master-rules.ts';
import { LIST_COLUMNS, LIST_FROM, PROJECT_STATUSES, SCOPE_FROM } from './prj-project-store.ts';
import type { ProjectClassification, ProjectListRow, ProjectStatus } from './prj-project-store.ts';
import { PrjLessonsStore } from './prj-lessons-store.ts';
import { PLAN_PUBLISHED_EVENT, STAGE_SEQUENCE, commandEdgesFrom, edgeBy } from './prj-stage-machine.ts';
import type { StageCommand } from './prj-stage-machine.ts';
import { SqlProjectWorkflowGate } from './pwf-gate.ts';
import type { GateOutcome, ProjectWorkflowGatePort } from './pwf-gate.ts';
import { effectiveDateOf, invalid, lockProject, projectInScope, reasonOf, recordStageChange, usableDocumentId } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export type { StageScopes } from './prj-stage-support.ts';

/** The counter of the stage a project moved to: `prj_stage_transition_total{to}` (PRJ 3.1 section 9). */
export const PRJ_STAGE_TRANSITION_METRIC = 'prj_stage_transition_total';

/** The groups a project can be put in (BR-PRJ-05); the database says the same in `project_group_chk`. */
export const PROJECT_GROUPS: readonly string[] = ['QTQG', 'A', 'B', 'C'];
const BOARD_RANK_COLLATION = '"C"';
const HISTORY_LIMIT = 500;
const SYSTEM_ACTOR_KIND = 'SYSTEM';
const PROJECT_RESOURCE = 'project';

export type GuardKey = 'DECISION_DOCUMENT' | 'INVESTMENT_DECISION_DOCUMENT' | 'NATIONAL_CODE' | 'OPEN_OBLIGATIONS' | 'LESSONS_LEARNED';
/** MET: satisfied. UNMET: the command is refused. WARNING: allowed, but the rule says to flag it. INPUT_REQUIRED: the caller supplies it with the command. */
export type GuardState = 'MET' | 'UNMET' | 'WARNING' | 'INPUT_REQUIRED';

export interface GuardReading {
  key: GuardKey;
  state: GuardState;
  /** The refusal the guard gives when it is UNMET. */
  refusal?: { code: string; status: number; detail?: string };
}

type DocumentField = 'decisionDocumentId' | 'investmentDecisionDocumentId';

interface DocumentGuard {
  field: DocumentField;
  /** The name the contract and the problem details use. */
  apiField: string;
  key: GuardKey;
  required: boolean;
}

interface CommandGuards {
  documents: readonly DocumentGuard[];
  /** The national project code is judged by the rule of the day (CXN-01) against the stage the project moves to. */
  nationalCode: boolean;
  /** Cancelling is refused while any capital was committed or paid; closing, while any is committed or reserved. */
  obligations: 'CANCEL' | 'CLOSE' | null;
  /** The closing gate asks for the lessons learned of the project (G1-19): approved lessons, or an approved waiver, by the rule LESSONS_LEARNED_POLICY. */
  lessons?: boolean;
}

const DECISION = (required: boolean): DocumentGuard => ({ field: 'decisionDocumentId', apiField: 'decision_document_id', key: 'DECISION_DOCUMENT', required });
const INVESTMENT_DECISION: DocumentGuard = { field: 'investmentDecisionDocumentId', apiField: 'investment_decision_document_id', key: 'INVESTMENT_DECISION_DOCUMENT', required: true };

/** What each command needs before it moves a project (PRJ 3.1 section 4, column "Guard"). */
const COMMAND_GUARDS: Readonly<Record<StageCommand, CommandGuards>> = {
  startProjectImplementation: { documents: [INVESTMENT_DECISION], nationalCode: true, obligations: null },
  suspendProject: { documents: [DECISION(true)], nationalCode: false, obligations: null },
  resumeProject: { documents: [DECISION(false)], nationalCode: false, obligations: null },
  completeProject: { documents: [DECISION(true)], nationalCode: false, obligations: null },
  closeProject: { documents: [DECISION(false)], nationalCode: false, obligations: 'CLOSE', lessons: true },
  cancelProject: { documents: [DECISION(true)], nationalCode: false, obligations: 'CANCEL' },
};

/** The request body of a stage command, as the contract's allowlist has it. */
export interface StageInput {
  reason: string;
  decisionDocumentId?: string | undefined;
  investmentDecisionDocumentId?: string | undefined;
  policyProposalDocumentId?: string | undefined;
  effectiveDate?: string | undefined;
}

export interface StageRequest {
  command: StageCommand;
  projectId: string;
  expectedVersion: number;
  actor: string;
  scopes: StageScopes;
  input: StageInput;
  today: string;
}

/** The capital that a project holds, read through the port of CAP (allocation balances and fund reservations). */
export interface OpenObligations {
  committedVnd: string;
  disbursedVnd: string;
  activeReservations: number;
}

export interface ProjectObligationsPort {
  openObligations(tx: TenantTx, projectId: string): Promise<OpenObligations>;
}

/** Reads the obligations of a project from the tables of CAP: the sums of its allocation balances and the reservations that are still ACTIVE. */
export class SqlProjectObligations implements ProjectObligationsPort {
  async openObligations(tx: TenantTx, projectId: string): Promise<OpenObligations> {
    const balances = await tx.query<{ committed: string; disbursed: string }>(
      `select coalesce(sum(b.committed_vnd), 0)::text as committed, coalesce(sum(b.disbursed_vnd), 0)::text as disbursed
         from machvon.allocation_line l join machvon.allocation_balance b on b.tenant_id = l.tenant_id and b.allocation_line_id = l.id
        where l.project_id = $1::uuid`,
      [projectId],
    );
    const reservations = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.fund_reservation where project_id = $1::uuid and status = 'ACTIVE'`, [projectId]);
    return { committedVnd: balances[0]?.committed ?? '0', disbursedVnd: balances[0]?.disbursed ?? '0', activeReservations: Number(reservations[0]?.n ?? 0) };
  }
}

/** One move of a project, as it was stored: what the audit row, the event and the telemetry of the move are written from. */
export interface StageChange {
  projectId: string;
  code: string;
  from: ProjectStatus;
  to: ProjectStatus;
  /** The version the project has after the move. */
  version: number;
  operation: string;
  actorKind: 'USER' | 'SYSTEM';
  actorId: string;
  decisionDocumentId: string | null;
  classification: ProjectClassification;
  reason: string | null;
  effectiveDate: string | null;
  sourceEventId: string | null;
  /** The rule on the national code said to flag the project, not to refuse the move. */
  nationalCodeWarning: boolean;
}

export interface StageHistoryEntry {
  from: ProjectStatus;
  to: ProjectStatus;
  version: number;
  operation: string;
  actorKind: 'USER' | 'SYSTEM';
  actorName: string | null;
  decisionDocumentId: string | null;
  reason: string | null;
  effectiveDate: string | null;
  occurredAt: string;
}

export interface NextTransition {
  operation: StageCommand;
  to: ProjectStatus;
  /** Whether the caller holds the permission of the command on this project. */
  allowed: boolean;
  guards: Array<{ key: GuardKey; state: GuardState }>;
}

export interface ProjectLifecycle {
  projectId: string;
  code: string;
  status: ProjectStatus;
  version: number;
  projectGroup: string | null;
  nationalProjectCode: string | null;
  statusChangedAt: string;
  history: StageHistoryEntry[];
  next: NextTransition[];
}

export interface PipelineFilter {
  stage?: string | undefined;
  projectGroup?: string | undefined;
}

export interface PipelineCard extends ProjectListRow {
  appraisalScore: string | null;
  totalInvestmentVnd: string;
  pipelinePriority: number | null;
  /** For a project in the pipeline: whether it has what a capital plan needs of it (the national code, where the rule requires it; the group is a condition of the stage). Null elsewhere. */
  capitalReady: boolean | null;
  statusChangedAt: string;
}

export interface PipelinePage {
  cards: PipelineCard[];
  total: number;
}

/** The columns of a project that the moves and the history read. */
interface ProjectStageSql {
  id: string;
  code: string;
  version: string;
  status: ProjectStatus;
  classification: ProjectClassification;
  project_group: string | null;
  national_project_code: string | null;
}

interface PipelineSql {
  id: string;
  code: string;
  name: string;
  owner_unit_id: string;
  owner_unit_name: string;
  investor_unit_id: string | null;
  investor_unit_name: string | null;
  project_group: string | null;
  status: ProjectStatus;
  national_project_code: string | null;
  leader_membership_id: string | null;
  leader_name: string | null;
  version: string;
  appraisal_score: string | null;
  total_investment_vnd: string;
  pipeline_priority: number | null;
  status_changed_at: string;
  rank_key: string;
}

const isStage = (value: string): value is ProjectStatus => (PROJECT_STATUSES as readonly string[]).includes(value);

/** The filter of the project bank when it names a stage and a group that exist; anything else is a fault of the request (422 naming the parameter). */
export function checkedPipelineFilter(filter: PipelineFilter): PipelineFilter {
  if (filter.stage !== undefined && !isStage(filter.stage)) throw invalid('stage');
  if (filter.projectGroup !== undefined && !PROJECT_GROUPS.includes(filter.projectGroup)) throw invalid('project_group');
  return filter;
}

/** The number of whole dong in a decimal string, for an exact comparison. */
const wholeOf = (amount: string): bigint => BigInt(amount.split('.')[0] ?? '0');

/**
 * Whether the rule on the national code applies to a project that moves to `target`: the rule names the stage from which the code is
 * required; a stage the rule names that this module does not know is read as required (the safer reading).
 */
function codeRequiredAt(rule: NationalCodeRule, target: ProjectStatus): boolean {
  const from = (STAGE_SEQUENCE as Record<string, number | undefined>)[rule.fromStageKey];
  return from === undefined || STAGE_SEQUENCE[target] >= from;
}

export function nationalCodeReading(rule: NationalCodeRule | undefined, target: ProjectStatus, code: string | null): GuardReading {
  if (rule === undefined || !codeRequiredAt(rule, target)) return { key: 'NATIONAL_CODE', state: 'MET' };
  const unmet = (refusal: { code: string; status: number; detail: string }): GuardReading =>
    rule.mode === 'WARN' ? { key: 'NATIONAL_CODE', state: 'WARNING' } : { key: 'NATIONAL_CODE', state: 'UNMET', refusal };
  if (code === null) return unmet({ code: 'NATIONAL_CODE_REQUIRED', status: 422, detail: 'national_project_code' });
  if (rule.format !== null && !new RegExp(rule.format.pattern).test(code)) return unmet({ code: 'NATIONAL_CODE_FORMAT_INVALID', status: 422, detail: 'national_project_code' });
  return { key: 'NATIONAL_CODE', state: 'MET' };
}

function obligationsReading(kind: 'CANCEL' | 'CLOSE', open: OpenObligations): GuardReading {
  const held = wholeOf(open.committedVnd) > 0n || open.activeReservations > 0 || (kind === 'CANCEL' && wholeOf(open.disbursedVnd) > 0n);
  return held ? { key: 'OPEN_OBLIGATIONS', state: 'UNMET', refusal: { code: 'OPEN_OBLIGATIONS_EXIST', status: 409 } } : { key: 'OPEN_OBLIGATIONS', state: 'MET' };
}

/** What the closing gate reads of the lessons learned of a project (G1-19). */
export interface ProjectLessonsPort {
  gate(tx: TenantTx, projectId: string, now: Date): Promise<{ met: boolean; reason: string; required: number; approved: number }>;
}

export class SqlProjectLessons implements ProjectLessonsPort {
  private readonly lessons = new PrjLessonsStore();

  gate(tx: TenantTx, projectId: string, now: Date): Promise<{ met: boolean; reason: string; required: number; approved: number }> {
    return this.lessons.gate(tx, projectId, 'CLOSE', now);
  }
}

function lessonsReading(reading: { met: boolean; reason: string }): GuardReading {
  return reading.met ? { key: 'LESSONS_LEARNED', state: 'MET' } : { key: 'LESSONS_LEARNED', state: 'UNMET', refusal: { code: 'LESSONS_LEARNED_REQUIRED', status: 422, detail: reading.reason } };
}

function refuse(reading: GuardReading): never {
  const refusal = reading.refusal ?? { code: 'VALIDATION_FAILED', status: 422 };
  throw new DomainError(refusal.code, refusal.status, refusal.detail);
}

/** The audit row and the event of a move: the same for a member's command and for the system consumer, written from the stored values. */
export function stageChangeRecord(change: StageChange, tenantId: string, occurredAt: Date) {
  return {
    audit: {
      action: 'project.stage_changed',
      resourceType: PROJECT_RESOURCE,
      resourceId: change.projectId,
      classification: change.classification,
      ...(change.reason === null ? {} : { reason: change.reason }),
      diff: {
        code: change.code,
        from: change.from,
        to: change.to,
        operation: change.operation,
        decision_document_id: change.decisionDocumentId,
        effective_date: change.effectiveDate,
        national_code_warning: change.nationalCodeWarning,
      },
    },
    event: {
      aggregateType: PROJECT_RESOURCE,
      aggregateId: change.projectId,
      aggregateVersion: change.version,
      type: 'project.stage_changed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: tenantId,
        project_id: change.projectId,
        version: change.version,
        actor_id: change.actorId,
        occurred_at: occurredAt.toISOString(),
        from: change.from,
        to: change.to,
        decision_document_id: change.decisionDocumentId,
        operation: change.operation,
      },
      eventKey: `${PROJECT_RESOURCE}:${change.projectId}:${change.version}`,
    },
  };
}

/**
 * The guarded transitions of the PIMA life cycle (ST-PRJ-002, PRJ 3.1 F3 to F5): a project moves only along the table of
 * `prj-stage-machine`, with the documents, the national code and the capital position that the move needs, under the version the caller saw.
 * Each move bumps the version and leaves one row of history; the audit row and the event are written by the caller from the stored values.
 */
export class PrjStageStore {
  private readonly rules: MasterRules;
  private readonly obligations: ProjectObligationsPort;
  private readonly lessons: ProjectLessonsPort;
  private readonly gate: ProjectWorkflowGatePort;

  constructor(
    rules: MasterRules = new MasterRules(),
    obligations: ProjectObligationsPort = new SqlProjectObligations(),
    lessons: ProjectLessonsPort = new SqlProjectLessons(),
    gate: ProjectWorkflowGatePort = new SqlProjectWorkflowGate(),
  ) {
    this.rules = rules;
    this.obligations = obligations;
    this.lessons = lessons;
    this.gate = gate;
  }

  /**
   * Moves a project by a command of the module. The project must lie in the scope of the permission of the command (readable but not
   * actionable is 403, out of sight 404), the version must be the current one, the pair of stages must be in the table (409
   * STAGE_TRANSITION_DENIED, the project unchanged), and the guards of the command must hold.
   */
  async transition(tx: TenantTx, request: StageRequest): Promise<StageChange> {
    const locked = await lockProject(tx, request.projectId, request.scopes);
    if (locked.version !== request.expectedVersion) throw versionConflict(locked.version);
    const edge = edgeBy(request.command, locked.status);
    if (edge === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const guards = COMMAND_GUARDS[request.command];
    const reason = reasonOf(request.input.reason);
    const effectiveDate = effectiveDateOf(request.input.effectiveDate);
    const documents = await this.checkedDocuments(tx, guards, request.input);
    const readings = await this.serverGuards(tx, guards, edge.to, locked, request.today);
    const refused = readings.find((reading) => reading.state === 'UNMET');
    if (refused !== undefined) refuse(refused);
    // The workflow of the project, when it has one, keeps the command closed until the required tasks of the gated phases are done (PWF-1, R29): the same transaction, the same lock.
    await this.gate.assert(tx, locked.id, request.command);
    const decisionDocumentId = documents.investmentDecisionDocumentId ?? documents.decisionDocumentId ?? null;
    const version = locked.version + 1;
    await tx.query(
      `update machvon.project
          set status = $2, status_changed_at = now(), updated_at = now(), updated_by = $3::uuid, version = $4::bigint,
              investment_decision_document_id = coalesce($5::uuid, investment_decision_document_id)
        where id = $1::uuid`,
      [locked.id, edge.to, request.actor, version, documents.investmentDecisionDocumentId ?? null],
    );
    await this.gate.follow(tx, locked.id, edge.to);
    // A project cancelled while it is being appraised takes its open sheets with it: nobody decides on a sheet of a project that is gone.
    if (locked.status === 'APPRAISAL' && edge.to === 'CANCELLED') {
      await tx.query(
        `update machvon.project_appraisal set status = 'VOID', updated_at = now(), updated_by = $2::uuid, version = version + 1
          where project_id = $1::uuid and status in ('DRAFT', 'SUBMITTED')`,
        [locked.id, request.actor],
      );
    }
    await recordStageChange(tx, {
      projectId: locked.id,
      version,
      from: locked.status,
      to: edge.to,
      operation: request.command,
      actorKind: 'USER',
      actorId: request.actor,
      decisionDocumentId,
      reason,
      effectiveDate,
      sourceEventId: null,
    });
    return {
      projectId: locked.id,
      code: locked.code,
      from: locked.status,
      to: edge.to,
      version,
      operation: request.command,
      actorKind: 'USER',
      actorId: request.actor,
      decisionDocumentId,
      classification: locked.classification,
      reason,
      effectiveDate,
      sourceEventId: null,
      nationalCodeWarning: readings.some((reading) => reading.key === 'NATIONAL_CODE' && reading.state === 'WARNING'),
    };
  }

  /**
   * The system consumer of `capital.plan_published.v1` (PRJ 3.1 F3): every project the event names that is in the pipeline and has a line of
   * more than nothing in the published plan becomes BUDGETED, by the system. What the plan says is read from the plan, not from the event; a
   * project in any other stage, or without a funded line in that plan, is left as it is, so a repeated or late event moves nothing.
   */
  async budgetFromPublishedPlan(tx: TenantTx, request: { capitalPlanId: string; projectIds: readonly string[]; eventId: string; actor: string }): Promise<StageChange[]> {
    return (await this.budgetFromPublishedPlanGated(tx, request)).changes;
  }

  /** As `budgetFromPublishedPlan`, and says which projects the gate of their workflow kept in the pipeline: the event moves nothing for them and the caller reports the refusal (BR-PWF-13). */
  async budgetFromPublishedPlanGated(tx: TenantTx, request: { capitalPlanId: string; projectIds: readonly string[]; eventId: string; actor: string }): Promise<{ changes: StageChange[]; refused: Array<{ projectId: string; code: string; outcome: GateOutcome }> }> {
    const plans = await tx.query<{ decision_document_id: string | null }>(`select decision_document_id from machvon.capital_plan where id = $1::uuid and status = 'PUBLISHED'`, [request.capitalPlanId]);
    if (plans[0] === undefined || request.projectIds.length === 0) return { changes: [], refused: [] };
    const decisionDocumentId = plans[0].decision_document_id;
    const candidates = await tx.query<ProjectStageSql>(
      `select p.id, p.code, p.version::text as version, p.status, p.classification, p.project_group, p.national_project_code
         from machvon.project p
        where p.id = any($1::uuid[]) and p.status = 'PIPELINE'
          and exists (select 1 from machvon.plan_version pv join machvon.allocation_line al on al.tenant_id = pv.tenant_id and al.plan_version_id = pv.id
                       where pv.tenant_id = p.tenant_id and pv.capital_plan_id = $2::uuid and pv.project_id = p.id and al.amount_vnd > 0)
        order by p.id
          for update of p`,
      [[...request.projectIds], request.capitalPlanId],
    );
    const changes: StageChange[] = [];
    const refused: Array<{ projectId: string; code: string; outcome: GateOutcome }> = [];
    for (const row of candidates) {
      // A project whose workflow keeps the publication of the plan closed stays in the pipeline; the caller reports it (BR-PWF-13).
      const outcome = await this.gate.assess(tx, row.id, PLAN_PUBLISHED_EVENT);
      if (outcome !== undefined && outcome.gated && !outcome.open) {
        refused.push({ projectId: row.id, code: row.code, outcome });
        continue;
      }
      const version = Number(row.version) + 1;
      await tx.query(`update machvon.project set status = 'BUDGETED', status_changed_at = now(), updated_at = now(), updated_by = $2::uuid, version = $3::bigint where id = $1::uuid`, [row.id, request.actor, version]);
      await recordStageChange(tx, {
        projectId: row.id,
        version,
        from: 'PIPELINE',
        to: 'BUDGETED',
        operation: PLAN_PUBLISHED_EVENT,
        actorKind: SYSTEM_ACTOR_KIND,
        actorId: request.actor,
        decisionDocumentId,
        reason: null,
        effectiveDate: null,
        sourceEventId: request.eventId,
      });
      changes.push({
        projectId: row.id,
        code: row.code,
        from: 'PIPELINE',
        to: 'BUDGETED',
        version,
        operation: PLAN_PUBLISHED_EVENT,
        actorKind: SYSTEM_ACTOR_KIND,
        actorId: request.actor,
        decisionDocumentId,
        classification: row.classification,
        reason: null,
        effectiveDate: null,
        sourceEventId: request.eventId,
        nationalCodeWarning: false,
      });
    }
    return { changes, refused };
  }

  /** The history of the stage of a project, who moved it and on what ground, and the moves it may make now with the state of their guards. */
  async lifecycle(tx: TenantTx, id: string, scopes: { read: ScopeBuilder; act: Readonly<Record<StageCommand, ScopeBuilder>> }, today: string): Promise<ProjectLifecycle | undefined> {
    const predicate = scopes.read(2);
    const rows = await tx.query<ProjectStageSql & { status_changed_at: string }>(
      `select p.id, p.code, p.version::text as version, p.status, p.classification, p.project_group, p.national_project_code,
              to_char(p.status_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as status_changed_at
         from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`,
      [id, ...predicate.params],
    );
    const project = rows[0];
    if (project === undefined) return undefined;
    const history = await tx.query<{
      from_stage: ProjectStatus;
      to_stage: ProjectStatus;
      version: string;
      operation: string;
      actor_kind: 'USER' | 'SYSTEM';
      display_name: string | null;
      decision_document_id: string | null;
      reason: string | null;
      effective_date: string | null;
      occurred_at: string;
    }>(
      `select c.from_stage, c.to_stage, c.project_version::text as version, c.operation, c.actor_kind, d.display_name, c.decision_document_id, c.reason,
              c.effective_date::text as effective_date, to_char(c.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at
         from machvon.project_stage_change c
         left join machvon.tenant_user_directory d on d.tenant_id = c.tenant_id and d.membership_id = c.actor_id and c.actor_kind = 'USER'
        where c.project_id = $1::uuid order by c.occurred_at, c.id limit ${HISTORY_LIMIT}`,
      [project.id],
    );
    const rule = await this.rules.nationalCode(tx, today);
    const next: NextTransition[] = [];
    for (const edge of commandEdgesFrom(project.status)) {
      const guards = COMMAND_GUARDS[edge.by];
      const readings = await this.serverGuards(tx, guards, edge.to, { id: project.id, nationalProjectCode: project.national_project_code }, today, rule);
      const inputs: GuardReading[] = guards.documents.filter((document) => document.required).map((document) => ({ key: document.key, state: 'INPUT_REQUIRED' }));
      next.push({
        operation: edge.by,
        to: edge.to,
        allowed: await projectInScope(tx, project.id, scopes.act[edge.by]),
        guards: [...inputs, ...readings].map(({ key, state }) => ({ key, state })),
      });
    }
    return {
      projectId: project.id,
      code: project.code,
      status: project.status,
      version: Number(project.version),
      projectGroup: project.project_group,
      nationalProjectCode: project.national_project_code,
      statusChangedAt: project.status_changed_at,
      history: history.map((entry) => ({
        from: entry.from_stage,
        to: entry.to_stage,
        version: Number(entry.version),
        operation: entry.operation,
        actorKind: entry.actor_kind,
        actorName: entry.display_name,
        decisionDocumentId: entry.decision_document_id,
        reason: entry.reason,
        effectiveDate: entry.effective_date,
        occurredAt: entry.occurred_at,
      })),
      next,
    };
  }

  /**
   * The project bank (PRJ-14): the projects in the scope of the caller, optionally of one stage and one group, ranked by appraisal score
   * (highest first), then by the number of milestones done, then by how long they have been in the stage (BR-PRJ-06). The cursor carries the
   * rank key and the id of the last card; `total` counts the projects the filter matches in the scope, not the page.
   */
  async pipeline(
    tx: TenantTx,
    scope: ScopeBuilder,
    filter: PipelineFilter,
    page: { limit: number; after: { code: string; id: string } | undefined },
    today: string,
  ): Promise<PipelinePage> {
    checkedPipelineFilter(filter);
    const predicate = scope(6);
    const rows = await tx.query<PipelineSql>(
      `select * from (
         select ${LIST_COLUMNS}, p.appraisal_score::text as appraisal_score, p.total_investment_vnd::text as total_investment_vnd, p.pipeline_priority,
                to_char(p.status_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as status_changed_at,
                (lpad((10100 - round(coalesce(p.appraisal_score, -1) * 100))::int::text, 6, '0') || '|'
                 || lpad((99999 - least(99999, (select count(*) from machvon.project_milestone m where m.tenant_id = p.tenant_id and m.project_id = p.id and m.status = 'DONE')))::text, 5, '0') || '|'
                 || to_char(p.status_changed_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') || '|' || p.code) collate ${BOARD_RANK_COLLATION} as rank_key
           ${LIST_FROM}
          where ($1::text is null or p.status = $1::text) and ($2::text is null or p.project_group = $2::text) and ${predicate.sql}
       ) ranked
       where ($3::text is null or (ranked.rank_key, ranked.id) > ($3::text collate ${BOARD_RANK_COLLATION}, $4::uuid))
       order by ranked.rank_key, ranked.id limit $5`,
      [filter.stage ?? null, filter.projectGroup ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit, ...predicate.params],
    );
    const counted = scope(3);
    const totals = await tx.query<{ n: string }>(
      `select count(*)::text as n from ${SCOPE_FROM} where ($1::text is null or p.status = $1::text) and ($2::text is null or p.project_group = $2::text) and ${counted.sql}`,
      [filter.stage ?? null, filter.projectGroup ?? null, ...counted.params],
    );
    const rule = rows.some((row) => row.status === 'PIPELINE') ? await this.rules.nationalCode(tx, today) : undefined;
    return {
      cards: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        ownerUnitId: row.owner_unit_id,
        ownerUnitName: row.owner_unit_name,
        investorUnitId: row.investor_unit_id,
        investorUnitName: row.investor_unit_name,
        projectGroup: row.project_group,
        status: row.status,
        nationalProjectCode: row.national_project_code,
        leader: row.leader_membership_id === null || row.leader_name === null ? null : { membershipId: row.leader_membership_id, displayName: row.leader_name },
        version: Number(row.version),
        // The ordering key of the board and of its cursor: the rank of the card, not its code.
        codeKey: row.rank_key,
        appraisalScore: row.appraisal_score,
        totalInvestmentVnd: row.total_investment_vnd,
        pipelinePriority: row.pipeline_priority,
        capitalReady: row.status === 'PIPELINE' ? nationalCodeReading(rule, 'BUDGETED', row.national_project_code).state !== 'UNMET' : null,
        statusChangedAt: row.status_changed_at,
      })),
      total: Number(totals[0]?.n ?? 0),
    };
  }

  /**
   * The documents of a command, normalised and checked: each must be a document of the tenant that can still ground a decision. A field the
   * command does not take is refused by name, so a document sent to the wrong command is not stored as if it counted.
   */
  private async checkedDocuments(tx: TenantTx, guards: CommandGuards, input: StageInput): Promise<Partial<Record<DocumentField, string>>> {
    const taken = new Set(guards.documents.map((document) => document.field));
    if (input.policyProposalDocumentId !== undefined) throw invalid('policy_proposal_document_id');
    if (input.decisionDocumentId !== undefined && !taken.has('decisionDocumentId')) throw invalid('decision_document_id');
    if (input.investmentDecisionDocumentId !== undefined && !taken.has('investmentDecisionDocumentId')) throw invalid('investment_decision_document_id');
    const checked: Partial<Record<DocumentField, string>> = {};
    for (const document of guards.documents) {
      const given = input[document.field];
      if (given === undefined) {
        if (document.required) throw new DomainError('DECISION_REQUIRED', 422, document.apiField);
        continue;
      }
      checked[document.field] = await usableDocumentId(tx, given, document.apiField);
    }
    return checked;
  }

  /** The guards the server judges by itself: the national code against the rule of the day, and the capital the project still holds. */
  private async serverGuards(
    tx: TenantTx,
    guards: CommandGuards,
    target: ProjectStatus,
    project: { id: string; nationalProjectCode: string | null },
    today: string,
    known?: NationalCodeRule,
  ): Promise<GuardReading[]> {
    const readings: GuardReading[] = [];
    if (guards.nationalCode) readings.push(nationalCodeReading(known ?? (await this.rules.nationalCode(tx, today)), target, project.nationalProjectCode));
    if (guards.obligations !== null) readings.push(obligationsReading(guards.obligations, await this.obligations.openObligations(tx, project.id)));
    if (guards.lessons === true) readings.push(lessonsReading(await this.lessons.gate(tx, project.id, new Date())));
    return readings;
  }
}
