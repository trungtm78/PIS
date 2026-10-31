import { randomUUID } from 'node:crypto';
import { DomainError, MNE_EVALUATION_KINDS, EVALUATION_SUBMITTABLE, assertEvaluationDecider, assertKindAtStage, assertEvaluationSubmission, versionConflict } from '@machvon/kernel';
import type { MneEvaluationConclusion, MneEvaluationKind, MneEvaluationStatus } from '@machvon/kernel';
import { TIMESTAMP } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const MAX_PAGE = 200;
const EVALUATOR_KINDS = ['INTERNAL', 'INDEPENDENT_CONSULTANT'] as const;
export type MneEvaluatorKind = (typeof EVALUATOR_KINDS)[number];
const STATUSES: readonly string[] = ['PLANNED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'RETURNED'];

export const EVALUATION_RESOURCE = 'mne_evaluation';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const dayOf = (value: string, field: string): string => {
  if (!DAY.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
};
const textOf = (value: string, field: string, min: number, max: number): string => {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw invalid(field);
  return trimmed;
};

export interface MnePlanInput {
  projectId: string;
  evaluationKind: string;
  evaluatorKind: string;
  evaluatorName: string;
  scopeText: string;
  plannedDate: string;
}

export interface MneSubmitInput {
  findings: readonly unknown[];
  conclusion: string | undefined;
  recommendationsText?: string | undefined;
  completedDate: string | undefined;
  reportDocumentId?: string | undefined;
}

export interface MneDecisionInput {
  decision: 'approve' | 'return';
  reason: string;
}

export interface MneEvaluationFilter {
  projectId?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  after?: { createdAt: string; id: string } | undefined;
}

/** An evaluation as the screens read it: the project, what was planned, what was submitted, how it was decided and the report it is linked to. */
export interface MneEvaluationView {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  evaluationKind: MneEvaluationKind;
  evaluatorKind: MneEvaluatorKind;
  evaluatorName: string;
  scopeText: string;
  plannedDate: string;
  status: MneEvaluationStatus;
  findings: unknown[];
  conclusion: MneEvaluationConclusion | null;
  recommendationsText: string | null;
  completedDate: string | null;
  reportDocumentId: string | null;
  mneReportId: string | null;
  createdBy: string;
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  version: number;
  reach: { projectId: string; ownerUnit: { id: string; path: string }; investorUnit: { id: string; path: string } | null };
}

/** What a command did: the evaluation as it stands and the status it left. */
export interface MneEvaluationChange {
  view: MneEvaluationView;
  fromStatus: MneEvaluationStatus | null;
}

interface EvaluationSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  evaluation_kind: MneEvaluationKind;
  evaluator_kind: MneEvaluatorKind;
  evaluator_name: string;
  scope_text: string;
  planned_date: string;
  status: MneEvaluationStatus;
  findings_json: unknown[];
  conclusion: MneEvaluationConclusion | null;
  recommendations_text: string | null;
  completed_date: string | null;
  report_document_id: string | null;
  mne_report_id: string | null;
  created_by: string;
  submitted_by: string | null;
  submitted_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

/** The aliases `p`, `ou` and `iu` are those of `projectScope`. */
const FROM = `machvon.mne_evaluation e
  join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const COLUMNS = `e.id, e.project_id, p.code as project_code, p.name as project_name, e.evaluation_kind, e.evaluator_kind, e.evaluator_name, e.scope_text, e.planned_date::text as planned_date, e.status, e.findings_json,
       e.conclusion, e.recommendations_text, e.completed_date::text as completed_date, e.report_document_id, e.mne_report_id, e.created_by, e.submitted_by, ${TIMESTAMP('e.submitted_at')} as submitted_at,
       e.decided_by, ${TIMESTAMP('e.decided_at')} as decided_at, e.decision_reason, ${TIMESTAMP('e.created_at')} as created_at, e.version::text as version, ou.id as owner_unit_id, ou.path as owner_unit_path,
       iu.id as investor_unit_id, iu.path as investor_unit_path`;

function toView(row: EvaluationSql): MneEvaluationView {
  return {
    id: row.id,
    projectId: row.project_id,
    projectCode: row.project_code,
    projectName: row.project_name,
    evaluationKind: row.evaluation_kind,
    evaluatorKind: row.evaluator_kind,
    evaluatorName: row.evaluator_name,
    scopeText: row.scope_text,
    plannedDate: row.planned_date,
    status: row.status,
    findings: row.findings_json,
    conclusion: row.conclusion,
    recommendationsText: row.recommendations_text,
    completedDate: row.completed_date,
    reportDocumentId: row.report_document_id,
    mneReportId: row.mne_report_id,
    createdBy: row.created_by,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    createdAt: row.created_at,
    version: Number(row.version),
    reach: {
      projectId: row.project_id,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    },
  };
}

/**
 * The investment evaluation of a project (ST-MNE-009, MNE F9, BR-MNE-08): planned for a kind that the stage of the project allows (409 `STAGE_TRANSITION_DENIED`), submitted with its findings, a conclusion and the day it was
 * completed, and decided by somebody who neither planned nor submitted it (403 `SELF_APPROVAL_DENIED`); an approved evaluation is linked to the next overall report that is still being drawn up, which reads it. Every command
 * works inside the scope of the caller over the project: a project outside it is not there for the caller.
 */
export class MneEvaluationStore {
  /** Plans an evaluation of a project, of a kind that its stage allows. */
  async plan(tx: TenantTx, input: MnePlanInput, actor: string, scope: ScopeBuilder, today: string): Promise<MneEvaluationChange> {
    const projectId = idOf(input.projectId, 'project_id');
    const kind = MNE_EVALUATION_KINDS.find((candidate) => candidate === input.evaluationKind) ?? this.fail('evaluation_kind');
    const evaluatorKind = EVALUATOR_KINDS.find((candidate) => candidate === input.evaluatorKind) ?? this.fail('evaluator_kind');
    const evaluatorName = textOf(input.evaluatorName, 'evaluator_name', 2, 300);
    const scopeText = textOf(input.scopeText, 'scope_text', 10, 2000);
    const plannedDate = dayOf(input.plannedDate, 'planned_date');
    const predicate = scope(2);
    const [project] = await tx.query<{ id: string; status: string; since: string | null }>(
      `select p.id, p.status, (p.status_changed_at at time zone 'Asia/Ho_Chi_Minh')::date::text as since
         from machvon.project p
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where p.id = $1::uuid and ${predicate.sql} for share of p`,
      [projectId, ...predicate.params],
    );
    // A project outside the scope of the caller is a project that is not there.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    assertKindAtStage(kind, project.status, project.since, today);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.mne_evaluation (tenant_id, id, project_id, evaluation_kind, evaluator_kind, evaluator_name, scope_text, status, planned_date, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, 'PLANNED', $7::date, $8::uuid, $8::uuid)`,
      [id, projectId, kind, evaluatorKind, evaluatorName, scopeText, plannedDate, actor],
    );
    return { view: await this.viewOf(tx, id), fromStatus: null };
  }

  /** Submits a planned, started or returned evaluation with what it found: the conclusion and the day are asked for, and a decision that was taken is cleared for the new decision. */
  async submit(tx: TenantTx, id: string, expectedVersion: number, input: MneSubmitInput, actor: string, scope: ScopeBuilder, today: string): Promise<MneEvaluationChange> {
    const conclusion = assertEvaluationSubmission({ findings: input.findings, conclusion: input.conclusion, completedDate: input.completedDate }, today);
    const completedDate = input.completedDate as string;
    const recommendations = input.recommendationsText === undefined || input.recommendationsText.trim() === '' ? null : textOf(input.recommendationsText, 'recommendations_text', 1, 2000);
    const document = input.reportDocumentId === undefined ? null : idOf(input.reportDocumentId, 'report_document_id');
    const held = await this.lock(tx, id, expectedVersion, scope);
    if (!(EVALUATION_SUBMITTABLE as readonly string[]).includes(held.status)) throw this.state(held.status);
    if (document !== null) {
      const [found] = await tx.query<{ id: string }>('select id from machvon.document where id = $1::uuid', [document]);
      if (found === undefined) throw invalid('report_document_id', 'NOT_FOUND');
    }
    await tx.query(
      `update machvon.mne_evaluation
          set status = 'SUBMITTED', findings_json = $2::jsonb, conclusion = $3, recommendations_text = $4, completed_date = $5::date, report_document_id = $6::uuid,
              submitted_by = $7::uuid, submitted_at = now(), approved_by = null, decided_by = null, decided_at = null, decision_reason = null,
              updated_at = now(), updated_by = $7::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, JSON.stringify(input.findings), conclusion, recommendations, completedDate, document, actor],
    );
    return { view: await this.viewOf(tx, held.id), fromStatus: held.status };
  }

  /**
   * Decides a submitted evaluation: approved or returned for another submission, with the reason. Not by who planned it or submitted it. An approved evaluation is linked to the next overall report that is still being
   * drawn up in the unit that owns the project or above it, when there is one.
   */
  async decide(tx: TenantTx, id: string, expectedVersion: number, input: MneDecisionInput, actor: string, scope: ScopeBuilder): Promise<MneEvaluationChange> {
    const reason = textOf(input.reason, 'reason', 5, 2000);
    if (input.decision !== 'approve' && input.decision !== 'return') throw invalid('decision');
    const held = await this.lock(tx, id, expectedVersion, scope);
    if (held.status !== 'SUBMITTED') throw this.state(held.status);
    assertEvaluationDecider(actor, held.created_by, held.submitted_by);
    const approved = input.decision === 'approve';
    const reportId = approved ? await this.nextOverallReport(tx, held.owner_unit_path) : null;
    await tx.query(
      `update machvon.mne_evaluation
          set status = $2, approved_by = $3::uuid, decided_by = $4::uuid, decided_at = now(), decision_reason = $5, mne_report_id = $6::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, approved ? 'APPROVED' : 'RETURNED', approved ? actor : null, actor, reason, reportId],
    );
    return { view: await this.viewOf(tx, held.id), fromStatus: held.status };
  }

  /** The evaluations in the scope of the reader, the newest first; narrowed by project and status. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: MneEvaluationFilter): Promise<MneEvaluationView[]> {
    const projectId = filter.projectId === undefined ? null : idOf(filter.projectId, 'project_id');
    const status = filter.status === undefined ? null : (STATUSES.includes(filter.status) ? filter.status : this.fail('status'));
    const predicate = scope(5);
    const rows = await tx.query<EvaluationSql>(
      `select ${COLUMNS} from ${FROM}
        where ${predicate.sql} and ($1::uuid is null or e.project_id = $1::uuid) and ($2::text is null or e.status = $2)
          and ($3::text is null or (${TIMESTAMP('e.created_at')}, e.id) < ($3::text, $4::uuid))
        order by ${TIMESTAMP('e.created_at')} desc, e.id desc limit ${Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE + 1)}`,
      [projectId, status, filter.after?.createdAt ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toView);
  }

  /** The projects the reader can be evaluated for, by code (what the filter and the plan offer): the right to read the evaluations is enough, the project register is not asked. */
  async projects(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<Array<{ id: string; code: string; name: string; status: string }>> {
    const predicate = scope(4);
    return tx.query<{ id: string; code: string; name: string; status: string }>(
      `select p.id, p.code, p.name, p.status
         from machvon.project p
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where ${predicate.sql} and ($1::text is null or (p.code, p.id) > ($1::text, $2::uuid))
        order by p.code, p.id limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, Math.min(Math.max(request.limit, 1), MAX_PAGE + 1), ...predicate.params],
    );
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private fail(field: string): never {
    throw invalid(field);
  }

  private state(status: string): DomainError {
    return new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { evaluation_status: status } });
  }

  private async viewOf(tx: TenantTx, id: string): Promise<MneEvaluationView> {
    const [row] = await tx.query<EvaluationSql>(`select ${COLUMNS} from ${FROM} where e.id = $1::uuid`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toView(row);
  }

  /** The evaluation locked for update inside the scope of the command; one the caller cannot see does not exist, and a stale version is 409 `VERSION_CONFLICT`. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scope: ScopeBuilder): Promise<{ id: string; status: MneEvaluationStatus; created_by: string; submitted_by: string | null; owner_unit_path: string }> {
    const wanted = idOf(id, 'id');
    const predicate = scope(2);
    const [row] = await tx.query<{ id: string; version: string; status: MneEvaluationStatus; created_by: string; submitted_by: string | null; owner_unit_path: string }>(
      `select e.id, e.version::text as version, e.status, e.created_by, e.submitted_by, ou.path as owner_unit_path from ${FROM} where e.id = $1::uuid and ${predicate.sql} for update of e`,
      [wanted, ...predicate.params],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  /**
   * The overall report that is still being drawn up, due soonest, of the unit that owns the project or of one above it (an overall report is one of a form of the overall kinds, semiannual or annual, and of no project). The row is held until the decision commits, and one that
   * a concurrent step has just taken out of the workflow is looked at again by the database and passed over.
   */
  private async nextOverallReport(tx: TenantTx, ownerPath: string): Promise<string | null> {
    const [row] = await tx.query<{ id: string }>(
      `select r.id from machvon.mne_report r
         join machvon.mne_report_form f on f.tenant_id = r.tenant_id and f.id = r.form_id
         join machvon.organization_unit su on su.tenant_id = r.tenant_id and su.id = r.scope_unit_id
        where f.report_kind in ('OVERALL_SEMIANNUAL', 'OVERALL_ANNUAL') and r.project_id is null and r.status in ('DRAFT', 'IN_REVIEW', 'RETURNED') and $1::text like su.path || '%'
        order by r.due_date, r.created_at, r.id limit 1
        for share of r`,
      [ownerPath],
    );
    return row?.id ?? null;
  }
}
