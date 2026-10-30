import { randomUUID } from 'node:crypto';
import { DomainError, assertRevisionDecision, assertRevisionProposal, versionConflict } from '@machvon/kernel';
import type { ProjectRevisionStatus, RevisionKind } from '@machvon/kernel';
import { idOf } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ProjectClassification, ProjectStatus } from './prj-project-store.ts';
import { lockProject, usableDocumentId } from './prj-stage-support.ts';
import type { LockedProject, StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The revisions of a project (ST-PRJ-008, PRJ 3.1 F6): the investor proposes a change of the investment total, the schedule, the scope or the investor unit; another person decides it with a decision
 * document and the day it takes effect. Approving applies the revision to the project (its total, years or investor unit) and supersedes the revision approved before it, so the figures of the project
 * always come from the revision approved last. Every write locks the project, so a revision is numbered, and the one that waits, without a race.
 */

export const REVISION_RESOURCE = 'project_revision';
/** The stages in which the dossier is changed by a revision: before the project bank it is edited directly, and once it is settled, rejected, cancelled or closed it no longer changes. */
export const REVISABLE_STATUSES: readonly ProjectStatus[] = ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'];

export interface ProposeRevision {
  projectId: string;
  expectedVersion: number;
  body: Record<string, unknown>;
  actor: string;
  scopes: StageScopes;
  today: string;
}

export interface DecideRevision {
  revisionId: string;
  expectedVersion: number;
  body: Record<string, unknown>;
  actor: string;
  scopes: StageScopes;
  /** Whether the caller holds the right to decide over a unit: a project with a deciding authority is decided on by whoever holds it over that unit (403 SCOPE_DENIED otherwise). */
  authorizes: ((unit: { id: string; path: string }) => boolean) | undefined;
  today: string;
}

/** The revision as it was stored: what the audit row, the event and the answer of the command are written from. */
export interface RevisionChange {
  id: string;
  projectId: string;
  projectCode: string;
  classification: ProjectClassification;
  revision: number;
  kind: RevisionKind;
  status: ProjectRevisionStatus;
  version: number;
  /** The version of the project after the command (the same as before it for a proposal, which writes none). */
  projectVersion: number;
  totalInvestmentVnd: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  decisionDocumentId: string | null;
  decisionReason: string | null;
  effectiveFrom: string | null;
  supersededRevisionId: string | null;
}

export interface PersonRef {
  membershipId: string;
  displayName: string | null;
}

export interface DocumentRef {
  id: string;
  title: string;
  number: number | null;
  numberYear: number | null;
  symbol: string | null;
  issuedOn: string | null;
  effectStatus: string;
}

export interface ProjectRevisionLine {
  id: string;
  revision: number;
  kind: RevisionKind | 'INITIAL';
  status: ProjectRevisionStatus;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  totalInvestmentVnd: string | null;
  reason: string;
  decisionReason: string | null;
  decisionDocument: DocumentRef | null;
  effectiveFrom: string | null;
  supersedesId: string | null;
  createdBy: PersonRef;
  createdAt: string;
  decidedBy: PersonRef | null;
  decidedAt: string | null;
  version: number;
}

export interface ProjectRevisionRegister {
  lines: ProjectRevisionLine[];
  /** The investment total the project holds now. */
  currentTotalVnd: string;
}

interface RevisionSql {
  id: string;
  project_id: string;
  revision: number;
  change_kind: RevisionKind | 'INITIAL';
  before_json: Record<string, unknown>;
  after_json: Record<string, unknown>;
  total_investment_vnd: string | null;
  decision_document_id: string | null;
  reason: string;
  decision_reason: string | null;
  status: ProjectRevisionStatus;
  effective_from: string | null;
  supersedes_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  created_by: string;
  version: string;
}

const COLUMNS = `r.id, r.project_id, r.revision, r.change_kind, r.before_json, r.after_json, r.total_investment_vnd::text as total_investment_vnd, r.decision_document_id, r.reason, r.decision_reason, r.status,
  r.effective_from::text as effective_from, r.supersedes_id, r.decided_by, to_char(r.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as decided_at,
  to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, r.created_by, r.version::text as version`;

interface ProjectFigures {
  start_year: number | null;
  end_year: number | null;
  investor_unit_id: string | null;
}

export class PrjRevisionStore {
  /**
   * Proposes a revision of the project under the version of the project the proposer saw (409 `VERSION_CONFLICT`). It is refused in a stage that takes no revision (409 `STAGE_TRANSITION_DENIED`) and while
   * another revision waits for its decision (409 `REVISION_PENDING_EXISTS`). The revision records what the project holds now and what it would hold after it.
   */
  async propose(tx: TenantTx, request: ProposeRevision): Promise<RevisionChange> {
    const project = await lockProject(tx, request.projectId, request.scopes);
    if (project.version !== request.expectedVersion) throw versionConflict(project.version);
    if (!REVISABLE_STATUSES.includes(project.status)) throw new DomainError('STAGE_TRANSITION_DENIED', 409, undefined, { extensions: { project_status: project.status } });
    const figures = await this.figuresOf(tx, project.id);
    const proposal = assertRevisionProposal(request.body, {
      totalInvestmentVnd: project.totalInvestmentVnd,
      startYear: figures.start_year,
      endYear: figures.end_year,
      investorUnitId: figures.investor_unit_id,
    });
    if (proposal.kind === 'ADJUST_INVESTOR') {
      if (!(await this.unitUsable(tx, proposal.after.investor_unit_id as string, request.today))) throw new DomainError('VALIDATION_FAILED', 422, 'after.investor_unit_id');
    }
    const pending = await tx.query<{ id: string }>(`select id from machvon.project_revision where project_id = $1::uuid and status = 'IN_REVIEW'`, [project.id]);
    if (pending[0] !== undefined) throw new DomainError('REVISION_PENDING_EXISTS', 409, undefined, { extensions: { revision_id: pending[0].id } });
    const id = randomUUID();
    const rows = await tx.query<RevisionSql>(
      `insert into machvon.project_revision as r (tenant_id, id, project_id, revision, change_kind, before_json, after_json, total_investment_vnd, reason, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid,
               (select coalesce(max(revision), 0) + 1 from machvon.project_revision where project_id = $2::uuid),
               $3, $4::jsonb, $5::jsonb, $6::numeric, $7, 'IN_REVIEW', $8::uuid, $8::uuid)
       returning ${COLUMNS}`,
      [id, project.id, proposal.kind, JSON.stringify(proposal.before), JSON.stringify(proposal.after), proposal.totalInvestmentVnd, proposal.reason, request.actor],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return changeOf(project, row, project.version, null);
  }

  /**
   * Decides the revision under the version of the revision the decider saw. The one who proposed it does not decide it (403 `SELF_APPROVAL_DENIED`), and a project with a deciding authority is decided on by
   * whoever holds the right over that unit. Approving needs the decision document and the day it takes effect; it applies the revision to the project, supersedes the revision approved before it and raises the
   * version of the project. Rejecting leaves the project as it is.
   */
  async decide(tx: TenantTx, request: DecideRevision): Promise<RevisionChange> {
    const revisionId = idOf(request.revisionId, 'id');
    const target = await tx.query<{ project_id: string }>('select project_id from machvon.project_revision where id = $1::uuid', [revisionId]);
    if (target[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, target[0].project_id, request.scopes);
    const rows = await tx.query<RevisionSql>(`select ${COLUMNS} from machvon.project_revision r where r.id = $1::uuid for update`, [revisionId]);
    const current = rows[0];
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.created_by === request.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await this.assertAuthority(tx, project, request.authorizes);
    if (Number(current.version) !== request.expectedVersion) throw versionConflict(Number(current.version));
    if (current.status !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, undefined, { extensions: { revision_status: current.status } });
    const decision = assertRevisionDecision(request.body, request.today);
    if (decision.decision === 'approve') await this.assertStillApplicable(tx, project, current, request.today);
    const documentId = decision.decisionDocumentId === undefined ? null : await usableDocumentId(tx, decision.decisionDocumentId, 'decision_document_id');
    if (decision.decision === 'reject') {
      const rejected = await this.write(tx, current.id, 'REJECTED', request.actor, decision.reason, documentId, null, null);
      return changeOf(project, rejected, project.version, null);
    }
    const previous = await tx.query<{ id: string }>(`select id from machvon.project_revision where project_id = $1::uuid and status = 'APPROVED' order by revision desc limit 1 for update`, [project.id]);
    const supersedes = previous[0]?.id ?? null;
    if (supersedes !== null) await tx.query(`update machvon.project_revision set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [supersedes, request.actor]);
    const approved = await this.write(tx, current.id, 'APPROVED', request.actor, decision.reason, documentId, decision.effectiveFrom ?? null, supersedes);
    const version = project.version + 1;
    await this.apply(tx, project.id, approved, request.actor, version);
    return changeOf(project, approved, version, supersedes);
  }

  /**
   * The whole history of the revisions of the project in the scope of the caller, the latest first, with the document that grounds each and who proposed and decided it: the legal dossier is drawn from it, so
   * it is never cut. A project out of sight is not found.
   */
  async list(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<ProjectRevisionRegister> {
    const predicate = scope(2);
    const found = await tx.query<{ total: string }>(`select p.total_investment_vnd::text as total from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const lines = await tx.query<
      RevisionSql & { doc_title: string | null; doc_number: number | null; doc_year: number | null; doc_symbol: string | null; doc_issued: string | null; doc_status: string | null; created_name: string | null; decided_name: string | null }
    >(
      `select ${COLUMNS}, d.title as doc_title, d.document_number as doc_number, d.number_year as doc_year, d.symbol as doc_symbol, d.issued_on::text as doc_issued, d.effect_status as doc_status,
              cu.display_name as created_name, du.display_name as decided_name
         from machvon.project_revision r
         left join machvon.document d on d.tenant_id = r.tenant_id and d.id = r.decision_document_id
         left join machvon.tenant_user_directory cu on cu.tenant_id = r.tenant_id and cu.membership_id = r.created_by
         left join machvon.tenant_user_directory du on du.tenant_id = r.tenant_id and du.membership_id = r.decided_by
        where r.project_id = $1::uuid order by r.revision desc`,
      [projectId],
    );
    return {
      currentTotalVnd: found[0].total,
      lines: lines.map((row) => ({
        id: row.id,
        revision: row.revision,
        kind: row.change_kind,
        status: row.status,
        before: row.before_json,
        after: row.after_json,
        totalInvestmentVnd: row.total_investment_vnd,
        reason: row.reason,
        decisionReason: row.decision_reason,
        decisionDocument:
          row.decision_document_id === null || row.doc_title === null
            ? null
            : { id: row.decision_document_id, title: row.doc_title, number: row.doc_number, numberYear: row.doc_year, symbol: row.doc_symbol, issuedOn: row.doc_issued, effectStatus: row.doc_status ?? 'PENDING' },
        effectiveFrom: row.effective_from,
        supersedesId: row.supersedes_id,
        createdBy: { membershipId: row.created_by, displayName: row.created_name },
        createdAt: row.created_at,
        decidedBy: row.decided_by === null ? null : { membershipId: row.decided_by, displayName: row.decided_name },
        decidedAt: row.decided_at,
        version: Number(row.version),
      })),
    };
  }

  /**
   * A revision is approved against the project as it is when it is decided: the stage must still take revisions, what the revision proposed to change must still be what the project holds (a transfer, an earlier
   * adjustment or a profile change may have moved it while the revision waited: 409 `VERSION_CONFLICT`, to be proposed again), and an investor unit it names must still be in force.
   */
  private async assertStillApplicable(tx: TenantTx, project: LockedProject, revision: RevisionSql, today: string): Promise<void> {
    if (!REVISABLE_STATUSES.includes(project.status)) throw new DomainError('STAGE_TRANSITION_DENIED', 409, undefined, { extensions: { project_status: project.status } });
    const figures = await this.figuresOf(tx, project.id);
    const held: Record<string, unknown> = { total_investment_vnd: project.totalInvestmentVnd, start_year: figures.start_year, end_year: figures.end_year, investor_unit_id: figures.investor_unit_id };
    const moved = Object.keys(revision.before_json).find((field) => field in held && held[field] !== revision.before_json[field]);
    if (moved !== undefined) throw versionConflict(project.version, { stale_field: moved });
    const unit = revision.after_json.investor_unit_id;
    if (typeof unit === 'string' && !(await this.unitUsable(tx, unit, today))) throw new DomainError('VALIDATION_FAILED', 422, 'after.investor_unit_id');
  }

  /** Whether the unit is in force on the day: active, and the day within its validity (the same rule as the receiving unit of a transfer). */
  private async unitUsable(tx: TenantTx, unitId: string, day: string): Promise<boolean> {
    const [unit] = await tx.query<{ ok: boolean }>(
      `select (status = 'Active' and valid_from <= $2::date and (valid_until is null or valid_until >= $2::date)) as ok from machvon.organization_unit where id = $1::uuid`,
      [unitId, day],
    );
    return unit?.ok === true;
  }

  private async figuresOf(tx: TenantTx, projectId: string): Promise<ProjectFigures> {
    const rows = await tx.query<ProjectFigures>('select start_year, end_year, investor_unit_id from machvon.project where id = $1::uuid', [projectId]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  private async write(tx: TenantTx, id: string, status: 'APPROVED' | 'REJECTED', actor: string, reason: string, documentId: string | null, effectiveFrom: string | null, supersedes: string | null): Promise<RevisionSql> {
    const rows = await tx.query<RevisionSql>(
      `update machvon.project_revision as r
          set status = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, decision_document_id = $5::uuid, effective_from = $6::date, supersedes_id = $7::uuid,
              updated_at = now(), updated_by = $3::uuid, version = version + 1
        where r.id = $1::uuid
        returning ${COLUMNS}`,
      [id, status, actor, reason, documentId, effectiveFrom, supersedes],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  /** The approved revision becomes what the project holds: its total, and the years or the investor unit it changes. A change of scope is only recorded on the revision. */
  private async apply(tx: TenantTx, projectId: string, revision: RevisionSql, actor: string, version: number): Promise<void> {
    const after = revision.after_json;
    await tx.query(
      `update machvon.project
          set total_investment_vnd = coalesce($2::numeric, total_investment_vnd), start_year = coalesce($3::int, start_year), end_year = coalesce($4::int, end_year),
              investor_unit_id = case when $5::boolean then $6::uuid else investor_unit_id end,
              updated_at = now(), updated_by = $7::uuid, version = $8::bigint
        where id = $1::uuid`,
      [
        projectId,
        revision.change_kind === 'ADJUST_INVESTMENT' ? revision.total_investment_vnd : null,
        typeof after.start_year === 'number' ? after.start_year : null,
        typeof after.end_year === 'number' ? after.end_year : null,
        'investor_unit_id' in after,
        typeof after.investor_unit_id === 'string' ? after.investor_unit_id : null,
        actor,
        version,
      ],
    );
  }

  private async assertAuthority(tx: TenantTx, project: LockedProject, authorizes: DecideRevision['authorizes']): Promise<void> {
    if (authorizes === undefined || project.decisionAuthorityUnitId === null) return;
    const unit = (await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [project.decisionAuthorityUnitId]))[0];
    if (unit === undefined || !authorizes(unit)) throw new DomainError('SCOPE_DENIED', 403);
  }
}

function changeOf(project: LockedProject, row: RevisionSql, projectVersion: number, superseded: string | null): RevisionChange {
  return {
    id: row.id,
    projectId: project.id,
    projectCode: project.code,
    classification: project.classification,
    revision: row.revision,
    kind: row.change_kind as RevisionKind,
    status: row.status,
    version: Number(row.version),
    projectVersion,
    totalInvestmentVnd: row.total_investment_vnd ?? project.totalInvestmentVnd,
    before: row.before_json,
    after: row.after_json,
    decisionDocumentId: row.decision_document_id,
    decisionReason: row.decision_reason,
    effectiveFrom: row.effective_from,
    supersededRevisionId: superseded,
  };
}
