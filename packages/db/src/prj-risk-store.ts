import { randomUUID } from 'node:crypto';
import { DomainError, SCALE_MAX, vietnamDateOf, assertRiskClosure, assertRiskEntry, assertRiskLive, assertRiskMove, isCritical, riskLevelOf, riskScore, versionConflict } from '@machvon/kernel';
import type { RiskLevel, RiskStatus } from '@machvon/kernel';
import { canFollowProject, idOf, memberStanding } from './prj-accountability-support.ts';
import type { ProjectClassification } from './prj-project-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { invalid, lockProject } from './prj-stage-support.ts';
import type { LockedProject, StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The risks of a project (ST-PRJ-010, PRJ 3.1 F8, BR-PRJ-07): a risk is written with a likelihood and an impact, owned by someone who can follow the project, and
 * ends closed or accepted with a reason. Every write locks the project, so the code of a risk is unique inside it without a race, and a caller who can read the
 * project but not manage its risks is refused (403 SCOPE_DENIED) where one who cannot read it finds nothing (404).
 */

export const RISK_CATEGORY_TYPE = 'RISK_CATEGORY';
export const RISK_RESOURCE = 'project_risk';

export interface RiskInput {
  body: Record<string, unknown>;
  actor: string;
  scopes: StageScopes;
  now: Date;
}

export interface RegisterRisk extends RiskInput {
  projectId: string;
}

export interface UpdateRisk extends RiskInput {
  riskId: string;
  expectedVersion: number;
}

export interface CloseRisk {
  body: Record<string, unknown>;
  riskId: string;
  expectedVersion: number;
  actor: string;
  scopes: StageScopes;
}

/** The risk as it was stored: what the audit row, the event and the answer of the command are written from. */
export interface RiskChange {
  id: string;
  projectId: string;
  projectCode: string;
  projectVersion: number;
  classification: ProjectClassification;
  code: string;
  status: RiskStatus;
  /** The status the risk had before the command, none when it was just written. */
  previousStatus: RiskStatus | null;
  likelihood: number;
  impact: number;
  score: number;
  level: RiskLevel;
  ownerMembershipId: string;
  categoryMasterVersionId: string;
  dueDate: string;
  linkedIssueId: string | null;
  closedReason: string | null;
  version: number;
  /** The names of the fields that differ from what the risk was before the command (all of them for a new risk). */
  changed: string[];
}

export interface RiskLine {
  id: string;
  code: string;
  categoryMasterVersionId: string;
  categoryLabel: string | null;
  title: string;
  description: string;
  likelihood: number;
  impact: number;
  score: number;
  level: RiskLevel;
  owner: { membershipId: string; displayName: string | null };
  mitigation: string;
  dueDate: string;
  /** A live risk whose day has passed. */
  overdue: boolean;
  linkedIssueId: string | null;
  status: RiskStatus;
  closedReason: string | null;
  version: number;
  updatedAt: string;
  /** The key the page is cut by: the highest score first, then the earliest day, then the code. */
  rankKey: string;
}

/** One cell of the 5 by 5 matrix: the score and the band of the cell are the server's, so the screen shows them for the cells that hold no risk as well. */
export interface RiskCell {
  likelihood: number;
  impact: number;
  score: number;
  level: RiskLevel;
  count: number;
}

export interface RiskRegister {
  lines: RiskLine[];
  /** The 25 cells of likelihood and impact with the live risks of the project in each, whatever the filter and the page: what the matrix of PRJ-16 shows. */
  matrix: RiskCell[];
  /** The live risks of the project that are critical, and those whose day has passed. */
  liveCount: number;
  criticalCount: number;
  overdueCount: number;
}

interface RiskSql {
  id: string;
  project_id: string;
  code: string;
  category_master_version_id: string;
  title: string;
  description: string;
  likelihood: number;
  impact: number;
  score: number;
  owner_membership_id: string;
  mitigation: string;
  due_date: string;
  linked_issue_id: string | null;
  status: RiskStatus;
  closed_reason: string | null;
  version: string;
  updated_at: string;
}

interface LineSql extends RiskSql {
  category_label: string | null;
  owner_name: string | null;
  overdue: boolean;
  rank_key: string;
}

const COLUMNS = `r.id, r.project_id, r.code, r.category_master_version_id, r.title, r.description, r.likelihood::int as likelihood, r.impact::int as impact, r.score::int as score,
  r.owner_membership_id, r.mitigation, r.due_date::text as due_date, r.linked_issue_id, r.status, r.closed_reason, r.version::text as version,
  to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

const lineOf = (row: LineSql): RiskLine => ({
  id: row.id,
  code: row.code,
  categoryMasterVersionId: row.category_master_version_id,
  categoryLabel: row.category_label,
  title: row.title,
  description: row.description,
  likelihood: row.likelihood,
  impact: row.impact,
  score: row.score,
  level: riskLevelOf(row.score),
  owner: { membershipId: row.owner_membership_id, displayName: row.owner_name },
  mitigation: row.mitigation,
  dueDate: row.due_date,
  overdue: row.overdue,
  linkedIssueId: row.linked_issue_id,
  status: row.status,
  closedReason: row.closed_reason,
  version: Number(row.version),
  updatedAt: row.updated_at,
  rankKey: row.rank_key,
});

const FIELDS: ReadonlyArray<[string, (row: RiskSql) => unknown]> = [
  ['code', (row) => row.code],
  ['category_master_version_id', (row) => row.category_master_version_id],
  ['title', (row) => row.title],
  ['description', (row) => row.description],
  ['likelihood', (row) => row.likelihood],
  ['impact', (row) => row.impact],
  ['owner_membership_id', (row) => row.owner_membership_id],
  ['mitigation', (row) => row.mitigation],
  ['due_date', (row) => row.due_date],
  ['linked_issue_id', (row) => row.linked_issue_id],
  ['status', (row) => row.status],
];

const changeOf = (project: LockedProject, row: RiskSql, previousStatus: RiskStatus | null, changed: string[]): RiskChange => ({
  id: row.id,
  projectId: project.id,
  projectCode: project.code,
  projectVersion: project.version,
  classification: project.classification,
  code: row.code,
  status: row.status,
  previousStatus,
  likelihood: row.likelihood,
  impact: row.impact,
  score: row.score,
  level: riskLevelOf(row.score),
  ownerMembershipId: row.owner_membership_id,
  categoryMasterVersionId: row.category_master_version_id,
  dueDate: row.due_date,
  linkedIssueId: row.linked_issue_id,
  closedReason: row.closed_reason,
  version: Number(row.version),
  changed,
});

export class PrjRiskStore {
  /** Writes a risk into the register of a project: the group is an entry in use, the owner can follow the project, the issue it is linked to belongs to the project. */
  async register(tx: TenantTx, request: RegisterRisk): Promise<RiskChange> {
    const project = await lockProject(tx, request.projectId, request.scopes);
    const entry = assertRiskEntry(request.body);
    await this.assertCodeFree(tx, project.id, entry.code, undefined);
    await this.assertReferences(tx, project.id, entry.categoryMasterVersionId, entry.ownerMembershipId, entry.linkedIssueId, request.now);
    const id = randomUUID();
    const rows = await tx.query<RiskSql>(
      `insert into machvon.project_risk as r (tenant_id, id, project_id, code, category_master_version_id, title, description, likelihood, impact, owner_membership_id, mitigation, due_date, linked_issue_id, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::uuid, $10, $11::date, $12::uuid, $13, $14::uuid, $14::uuid)
       returning ${COLUMNS}`,
      [id, project.id, entry.code, entry.categoryMasterVersionId, entry.title, entry.description, entry.likelihood, entry.impact, entry.ownerMembershipId, entry.mitigation, entry.dueDate, entry.linkedIssueId ?? null, entry.status, request.actor],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return changeOf(project, row, null, FIELDS.map(([name]) => name));
  }

  /**
   * Rewrites a risk under the version the caller saw. The entry is the whole of the risk as the contract has it; a status it does not name leaves the status where it
   * is, and one it names goes on towards escalation, never back (409 RISK_STATE_INVALID). A risk that has ended is not changed.
   */
  async update(tx: TenantTx, request: UpdateRisk): Promise<RiskChange> {
    const current = await this.lockRisk(tx, idOf(request.riskId, 'id'), request.scopes);
    const entry = assertRiskEntry(request.body);
    const from = current.risk.status;
    assertRiskLive(from);
    const status = request.body.status === undefined ? from : entry.status;
    if (Number(current.risk.version) !== request.expectedVersion) throw versionConflict(Number(current.risk.version));
    assertRiskMove(from, status);
    if (entry.code !== current.risk.code) await this.assertCodeFree(tx, current.project.id, entry.code, current.risk.id);
    await this.assertReferences(tx, current.project.id, entry.categoryMasterVersionId, entry.ownerMembershipId, entry.linkedIssueId, request.now, current.risk);
    const rows = await tx.query<RiskSql>(
      `update machvon.project_risk as r set code = $2, category_master_version_id = $3::uuid, title = $4, description = $5, likelihood = $6, impact = $7, owner_membership_id = $8::uuid, mitigation = $9,
              due_date = $10::date, linked_issue_id = $11::uuid, status = $12, updated_at = now(), updated_by = $13::uuid, version = version + 1
        where r.id = $1::uuid
        returning ${COLUMNS}`,
      [current.risk.id, entry.code, entry.categoryMasterVersionId, entry.title, entry.description, entry.likelihood, entry.impact, entry.ownerMembershipId, entry.mitigation, entry.dueDate, entry.linkedIssueId ?? null, status, request.actor],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const before = current.risk;
    const changed = FIELDS.filter(([, read]) => read(before) !== read(row)).map(([name]) => name);
    return changeOf(current.project, row, before.status, changed);
  }

  /** Ends a risk, closed or accepted as it is, with the reason; an ended risk is not ended again. */
  async close(tx: TenantTx, request: CloseRisk): Promise<RiskChange> {
    const current = await this.lockRisk(tx, idOf(request.riskId, 'id'), request.scopes);
    const closure = assertRiskClosure(request.body);
    assertRiskLive(current.risk.status);
    if (Number(current.risk.version) !== request.expectedVersion) throw versionConflict(Number(current.risk.version));
    const rows = await tx.query<RiskSql>(
      `update machvon.project_risk as r set status = $2, closed_reason = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where r.id = $1::uuid
        returning ${COLUMNS}`,
      [current.risk.id, closure.status, closure.reason, request.actor],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return changeOf(current.project, row, current.risk.status, ['status', 'closed_reason']);
  }

  /**
   * The register of a project in the scope of the caller: the highest score first, one page after the anchor, with the live risks of the whole project by
   * likelihood and impact. A project out of sight is not found.
   */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    request: { projectId: string; status: RiskStatus | undefined; today: string; limit: number; after: { code: string; id: string } | undefined },
  ): Promise<RiskRegister> {
    const predicate = scope(2);
    const found = await tx.query<{ id: string }>(`select p.id from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [request.projectId, ...predicate.params]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const lines = await tx.query<LineSql>(
      `select * from (
         select ${COLUMNS}, rv.label as category_label, d.display_name as owner_name, (r.status in ('OPEN', 'MITIGATING', 'ESCALATED') and r.due_date < $3::date) as overdue,
                (lpad((100 - r.score)::text, 3, '0') || '|' || r.due_date::text || '|' || r.code) collate "C" as rank_key
           from machvon.project_risk r
           left join machvon.master_record_version rv on rv.tenant_id = r.tenant_id and rv.id = r.category_master_version_id
           left join machvon.tenant_user_directory d on d.tenant_id = r.tenant_id and d.membership_id = r.owner_membership_id
          where r.project_id = $1::uuid and ($2::text is null or r.status = $2::text)
       ) listed
       where ($4::text is null or (listed.rank_key, listed.id) > ($4::text collate "C", $5::uuid))
       order by listed.rank_key, listed.id limit $6`,
      [request.projectId, request.status ?? null, request.today, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    const cells = await tx.query<{ likelihood: number; impact: number; count: string; overdue: string }>(
      `select r.likelihood::int as likelihood, r.impact::int as impact, count(*)::text as count, count(*) filter (where r.due_date < $2::date)::text as overdue
         from machvon.project_risk r where r.project_id = $1::uuid and r.status in ('OPEN', 'MITIGATING', 'ESCALATED') group by r.likelihood, r.impact order by r.likelihood, r.impact`,
      [request.projectId, request.today],
    );
    const held = new Map(cells.map((cell) => [`${cell.likelihood}:${cell.impact}`, Number(cell.count)]));
    const matrix: RiskCell[] = [];
    for (let likelihood = 1; likelihood <= SCALE_MAX; likelihood += 1) {
      for (let impact = 1; impact <= SCALE_MAX; impact += 1) {
        const score = riskScore(likelihood, impact);
        matrix.push({ likelihood, impact, score, level: riskLevelOf(score), count: held.get(`${likelihood}:${impact}`) ?? 0 });
      }
    }
    return {
      lines: lines.map(lineOf),
      matrix,
      liveCount: matrix.reduce((sum, cell) => sum + cell.count, 0),
      criticalCount: matrix.filter((cell) => isCritical(cell.score)).reduce((sum, cell) => sum + cell.count, 0),
      overdueCount: cells.reduce((sum, cell) => sum + Number(cell.overdue), 0),
    };
  }

  /** The risk and its project, both locked for update; a risk whose project is out of sight does not exist, one whose project is only readable is a refusal. */
  private async lockRisk(tx: TenantTx, riskId: string, scopes: StageScopes): Promise<{ project: LockedProject; risk: RiskSql }> {
    const found = await tx.query<{ project_id: string }>('select project_id from machvon.project_risk where id = $1::uuid', [riskId]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, found[0].project_id, scopes);
    const rows = await tx.query<RiskSql>(`select ${COLUMNS} from machvon.project_risk r where r.id = $1::uuid for update`, [riskId]);
    const risk = rows[0];
    if (risk === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { project, risk };
  }

  private async assertCodeFree(tx: TenantTx, projectId: string, code: string, exceptRiskId: string | undefined): Promise<void> {
    const taken = await tx.query<{ id: string }>('select id from machvon.project_risk where project_id = $1::uuid and code = $2 and ($3::uuid is null or id <> $3::uuid)', [projectId, code, exceptRiskId ?? null]);
    if (taken[0] !== undefined) throw new DomainError('RISK_CODE_DUPLICATE', 409, 'code');
  }

  /**
   * What a risk points at must be there: a group of risks that is in use, an owner who is on the staff, in force and able to follow the project (a risk kept by someone
   * who cannot see the project would never be handled), and an issue of the same project. A reference the risk already holds is not asked for again, so an owner who
   * has since left does not stop the risk from being closed or its other fields from being corrected.
   */
  private async assertReferences(tx: TenantTx, projectId: string, categoryId: string, ownerId: string, issueId: string | undefined, now: Date, held?: RiskSql): Promise<void> {
    if (held === undefined || held.category_master_version_id !== categoryId) {
      const categories = await tx.query<{ id: string }>(
        `select v.id from machvon.master_record_version v join machvon.master_record r on r.tenant_id = v.tenant_id and r.id = v.master_record_id
          where v.id = $1::uuid and v.master_type = $2 and r.status = 'EFFECTIVE' and v.published_at is not null and v.status in ('APPROVED', 'EFFECTIVE')
            and v.valid_from <= $3::date and (v.valid_until is null or v.valid_until > $3::date)`,
        [categoryId, RISK_CATEGORY_TYPE, vietnamDateOf(now)],
      );
      if (categories[0] === undefined) throw invalid('category_master_version_id');
    }
    if (held === undefined || held.owner_membership_id !== ownerId) {
      const owners = await tx.query<{ id: string }>('select id from machvon.membership where id = $1::uuid', [ownerId]);
      if (owners[0] === undefined) throw invalid('owner_membership_id');
      if (!(await canFollowProject(tx, await memberStanding(tx, ownerId), projectId, now))) throw invalid('owner_membership_id');
    }
    if (issueId !== undefined && held?.linked_issue_id !== issueId) {
      const issues = await tx.query<{ id: string }>('select id from machvon.issue where id = $1::uuid and project_id = $2::uuid', [issueId, projectId]);
      if (issues[0] === undefined) throw invalid('linked_issue_id');
    }
  }
}
