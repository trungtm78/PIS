import {
  DomainError,
  FINANCIAL_RECOMMENDATION_TYPES,
  assertDueDay,
  assertNotOwnWork,
  assertRecoveryComplete,
  effectivePermissions,
  holdsPermission,
  nextRecommendationStatus,
} from '@machvon/kernel';
import type { EffectiveAccess, EngagementStatus, RecommendationStatus, RecommendationType } from '@machvon/kernel';
import { engagementScope } from './aud-engagement-store.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const FINANCIAL = new Set<string>(FINANCIAL_RECOMMENDATION_TYPES);
const NOT_FOUND = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);
const REASON_MIN = 20;
const NOTE_MIN = 10;

export type EvidenceOwnerKind = 'ENGAGEMENT' | 'FINDING' | 'RECOMMENDATION' | 'ACTION';
export type ActionStatus = 'PLANNED' | 'DONE' | 'CANCELLED';
export type DisputeOutcome = 'ACCEPTED_BY_AUTHORITY' | 'REJECTED_BY_AUTHORITY';

/** A recommendation as a command locks it: where it stands, what it asks, who it was given to and who has had a hand in it. */
export interface RecommendationRow {
  id: string;
  conclusionId: string;
  engagementId: string;
  engagementCode: string;
  engagementStatus: EngagementStatus;
  implementationDueOn: string | null;
  recCode: string;
  recType: RecommendationType;
  amountVnd: string | null;
  recoveredVnd: string;
  status: RecommendationStatus;
  ownerUnitId: string | null;
  ownerUnitPath: string | null;
  ownerUserId: string | null;
  dueOn: string | null;
  submittedBy: string | null;
  disputedBy: string | null;
  disputeOutcome: DisputeOutcome | null;
  version: number;
}

/** An action of remediation as a command locks it, with the recommendation it belongs to. */
export interface ActionRow {
  id: string;
  actionCode: string;
  status: ActionStatus;
  plannedOn: string;
  version: number;
  recommendation: RecommendationRow;
}

export interface ActionLine {
  id: string;
  actionCode: string;
  description: string;
  plannedOn: string;
  completedOn: string | null;
  status: ActionStatus;
  evidenceDocumentId: string | null;
  version: number;
}

export interface NewAssignment {
  ownerUnitId: string;
  ownerUserId: string | undefined;
  dueOn: string;
  today: string;
}

export interface NewAction {
  actionCode: string;
  description: string;
  plannedOn: string;
}

export interface Verification {
  decision: 'CLOSE' | 'RETURN';
  closureBasisDocumentId: string | undefined;
  comment: string | undefined;
}

interface RowSql {
  id: string;
  conclusion_id: string;
  engagement_id: string;
  engagement_code: string;
  engagement_status: EngagementStatus;
  implementation_due_on: string | null;
  rec_code: string;
  rec_type: RecommendationType;
  amount_vnd: string | null;
  recovered_vnd: string;
  status: RecommendationStatus;
  owner_unit_id: string | null;
  owner_unit_path: string | null;
  owner_user_id: string | null;
  due_on: string | null;
  submitted_by: string | null;
  disputed_by: string | null;
  dispute_outcome: DisputeOutcome | null;
  version: string;
}

const ROW_COLUMNS = `r.id, r.conclusion_id, c.engagement_id, e.engagement_code, e.status as engagement_status, c.implementation_due_on::text as implementation_due_on, r.rec_code, r.rec_type,
  r.amount_vnd::text as amount_vnd, r.recovered_vnd::text as recovered_vnd, r.status, r.owner_unit_id, ow.path as owner_unit_path, r.owner_user_id, r.due_on::text as due_on, r.submitted_by,
  r.disputed_by, r.dispute_outcome, r.version::text as version`;
const ROW_FROM = `machvon.audit_recommendation r
  join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
  join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
  left join machvon.organization_unit ow on ow.tenant_id = r.tenant_id and ow.id = r.owner_unit_id`;

const toRow = (row: RowSql): RecommendationRow => ({
  id: row.id,
  conclusionId: row.conclusion_id,
  engagementId: row.engagement_id,
  engagementCode: row.engagement_code,
  engagementStatus: row.engagement_status,
  implementationDueOn: row.implementation_due_on,
  recCode: row.rec_code,
  recType: row.rec_type,
  amountVnd: row.amount_vnd,
  recoveredVnd: row.recovered_vnd,
  status: row.status,
  ownerUnitId: row.owner_unit_id,
  ownerUnitPath: row.owner_unit_path,
  ownerUserId: row.owner_user_id,
  dueOn: row.due_on,
  submittedBy: row.submitted_by,
  disputedBy: row.disputed_by,
  disputeOutcome: row.dispute_outcome,
  version: Number(row.version),
});

/**
 * The recommendations a caller may see (AUD 2): those of the engagements that meet a grant of `aud.read`, and those given to the caller or to a unit that a grant of the permission to execute
 * reaches (an owner sees what was assigned to them without seeing the whole engagement). Compiled over the aliases `r` (the recommendation) and `e` (its engagement); the parameters start at `first`.
 */
export function recommendationScope(access: EffectiveAccess, readPermission: string, executePermission: string, now: Date): ScopeBuilder {
  return (first: number) => {
    const engagement = engagementScope(access, readPermission, now)(first);
    const owner = scopePredicate(access, executePermission, now, { unitPath: 'ow.path', unitId: 'ow.id' }, first + engagement.params.length);
    const params = [...engagement.params, ...owner.params, access.membershipId];
    const mine = `r.owner_user_id = $${first + params.length - 1}::uuid`;
    const unit = owner.sql === 'false' ? 'false' : `exists (select 1 from machvon.organization_unit ow where ow.tenant_id = r.tenant_id and ow.id = r.owner_unit_id and ${owner.sql})`;
    return { sql: `(${engagement.sql} or ${mine} or ${unit})`, params };
  };
}

/**
 * 422 `NOT_OWNER` unless the caller is the one the recommendation was given to: the person when one was named, and otherwise anyone whose grant of the permission to execute reaches the unit that
 * owns it. Whoever the work was given to does it; whoever else holds the permission somewhere does not.
 */
export function assertOwner(row: RecommendationRow, access: EffectiveAccess, permission: string, now: Date): void {
  if (row.ownerUserId !== null) {
    if (row.ownerUserId.toLowerCase() !== access.membershipId.toLowerCase()) throw new DomainError('NOT_OWNER', 422);
    return;
  }
  if (row.ownerUnitId === null || row.ownerUnitPath === null) throw new DomainError('NOT_OWNER', 422);
  if (!holdsPermission(effectivePermissions(access, now, { ownerUnitPath: row.ownerUnitPath, ownerUnitId: row.ownerUnitId }), permission)) throw new DomainError('NOT_OWNER', 422);
}

/** What the screens read of a recommendation: the line of the conclusion screen with the owner, the day, the dispute, the verifier's words, and the actions with their evidence. */
export interface BoardLine {
  id: string;
  conclusionId: string;
  engagement: { id: string; code: string };
  findingId: string | null;
  recCode: string;
  recType: RecommendationType;
  description: string;
  amountVnd: string | null;
  recoveredVnd: string;
  projectId: string | null;
  ownerUnit: { id: string; code: string; name: string } | null;
  ownerUser: { id: string; name: string } | null;
  dueOn: string | null;
  implementationDueOn: string | null;
  status: RecommendationStatus;
  isOverdue: boolean;
  linkedIssueId: string | null;
  disputeReason: string | null;
  disputeOutcome: DisputeOutcome | null;
  verificationNote: string | null;
  submittedBy: string | null;
  disputedBy: string | null;
  actions: ActionLine[];
  evidenceCount: number;
  createdAt: string;
  version: number;
}

interface BoardSql {
  id: string;
  conclusion_id: string;
  engagement_id: string;
  engagement_code: string;
  finding_id: string | null;
  rec_code: string;
  rec_type: RecommendationType;
  description: string;
  amount_vnd: string | null;
  recovered_vnd: string;
  project_id: string | null;
  owner_unit_id: string | null;
  owner_unit_code: string | null;
  owner_unit_name: string | null;
  owner_user_id: string | null;
  owner_user_name: string | null;
  due_on: string | null;
  implementation_due_on: string | null;
  status: RecommendationStatus;
  is_overdue: boolean;
  linked_issue_id: string | null;
  dispute_reason: string | null;
  dispute_outcome: DisputeOutcome | null;
  verification_note: string | null;
  submitted_by: string | null;
  disputed_by: string | null;
  actions: Array<{ id: string; action_code: string; description: string; planned_on: string; completed_on: string | null; status: ActionStatus; evidence_document_id: string | null; version: number }>;
  evidence_count: string;
  created_at: string;
  version: string;
}

const BOARD_COLUMNS = `r.id, r.conclusion_id, c.engagement_id, e.engagement_code, r.finding_id, r.rec_code, r.rec_type, r.description, r.amount_vnd::text as amount_vnd, r.recovered_vnd::text as recovered_vnd,
  r.project_id, r.owner_unit_id, ow.code as owner_unit_code, ow.name as owner_unit_name, r.owner_user_id, od.display_name as owner_user_name, r.due_on::text as due_on, c.implementation_due_on::text as implementation_due_on, r.status, r.is_overdue,
  r.linked_issue_id, r.dispute_reason, r.dispute_outcome, r.verification_note, r.submitted_by, r.disputed_by,
  coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'action_code', a.action_code, 'description', a.description, 'planned_on', a.planned_on::text, 'completed_on', a.completed_on::text,
                                                  'status', a.status, 'evidence_document_id', a.evidence_document_id, 'version', a.version) order by a.action_code)
              from machvon.audit_remediation_action a where a.tenant_id = r.tenant_id and a.recommendation_id = r.id), '[]'::jsonb) as actions,
  (select count(*) from machvon.audit_evidence v where v.tenant_id = r.tenant_id and ((v.owner_kind = 'RECOMMENDATION' and v.owner_id = r.id)
      or (v.owner_kind = 'ACTION' and v.owner_id in (select a.id from machvon.audit_remediation_action a where a.tenant_id = r.tenant_id and a.recommendation_id = r.id))))::text as evidence_count,
  r.created_at::text as created_at, r.version::text as version`;
const BOARD_FROM = `machvon.audit_recommendation r
  join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
  join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
  left join machvon.organization_unit ow on ow.tenant_id = r.tenant_id and ow.id = r.owner_unit_id
  left join machvon.tenant_user_directory od on od.tenant_id = r.tenant_id and od.membership_id = r.owner_user_id`;

const toBoard = (row: BoardSql): BoardLine => ({
  id: row.id,
  conclusionId: row.conclusion_id,
  engagement: { id: row.engagement_id, code: row.engagement_code },
  findingId: row.finding_id,
  recCode: row.rec_code,
  recType: row.rec_type,
  description: row.description,
  amountVnd: row.amount_vnd,
  recoveredVnd: row.recovered_vnd,
  projectId: row.project_id,
  ownerUnit: row.owner_unit_id === null ? null : { id: row.owner_unit_id, code: row.owner_unit_code ?? '', name: row.owner_unit_name ?? '' },
  ownerUser: row.owner_user_id === null ? null : { id: row.owner_user_id, name: row.owner_user_name ?? '' },
  dueOn: row.due_on,
  implementationDueOn: row.implementation_due_on,
  status: row.status,
  isOverdue: row.is_overdue,
  linkedIssueId: row.linked_issue_id,
  disputeReason: row.dispute_reason,
  disputeOutcome: row.dispute_outcome,
  verificationNote: row.verification_note,
  submittedBy: row.submitted_by,
  disputedBy: row.disputed_by,
  actions: row.actions.map((action) => ({
    id: action.id,
    actionCode: action.action_code,
    description: action.description,
    plannedOn: action.planned_on,
    completedOn: action.completed_on,
    status: action.status,
    evidenceDocumentId: action.evidence_document_id,
    version: Number(action.version),
  })),
  evidenceCount: Number(row.evidence_count),
  createdAt: row.created_at,
  version: Number(row.version),
});

/**
 * The remediation of the recommendations of a conclusion (ST-AUD-003, AUD 3.3 to 3.5): the assignment to an owner with a day read from the conclusion, the actions the owner plans and completes
 * with evidence that is in force, the report for verification, the dispute and the authority's answer to it, and the verification by someone who had no hand in the work. Every state change
 * goes through the state machine of the kernel and is held again by the table.
 */
export class AudRecommendationStore {
  /** The unit an assignment names, as it stands in the tenant: 404 for one that is not there, whether it never existed or belongs to another tenant (BR-IAM-01). */
  async resolveUnit(tx: TenantTx, unitId: string): Promise<{ id: string; path: string }> {
    const [unit] = await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = $1::uuid', [unitId]);
    if (unit === undefined) throw NOT_FOUND();
    return unit;
  }

  /**
   * Locks a recommendation for a command in the scope of the caller (404 outside it; `acts` is the scope a caller needs to act, 403 when they see it and are outside it). The caller then shows
   * who they are (`assertOwner`, or the scope of `acts`), and only then the version (`assertVersion`) and the state of the engagement (`assertFollowedUp`) are judged, so that the answer to
   * a stranger does not depend on either.
   */
  async lock(tx: TenantTx, id: string, seen: ScopeBuilder, options: { acts?: ScopeBuilder } = {}): Promise<RecommendationRow> {
    const visible = seen(2);
    const [located] = await tx.query<{ id: string }>(`select r.id from ${ROW_FROM} where r.id = $1::uuid and ${visible.sql}`, [id, ...visible.params]);
    if (located === undefined) throw NOT_FOUND();
    const [row] = await tx.query<RowSql>(`select ${ROW_COLUMNS} from ${ROW_FROM} where r.id = $1::uuid for update of r`, [id]);
    if (row === undefined) throw NOT_FOUND();
    if (options.acts !== undefined) {
      const own = options.acts(2);
      const [allowed] = await tx.query<{ id: string }>(`select r.id from ${ROW_FROM} where r.id = $1::uuid and ${own.sql}`, [id, ...own.params]);
      if (allowed === undefined) throw new DomainError('SCOPE_DENIED', 403);
    }
    return toRow(row);
  }

  /** Locks a recommendation for the system (a consumer of events, a job), which acts for the tenant and not through the scope of a person: 404 when it is not in the tenant. */
  async lockForSystem(tx: TenantTx, id: string): Promise<RecommendationRow> {
    const [row] = await tx.query<RowSql>(`select ${ROW_COLUMNS} from ${ROW_FROM} where r.id = $1::uuid for update of r`, [id]);
    if (row === undefined) throw NOT_FOUND();
    return toRow(row);
  }

  /** 409 `VERSION_CONFLICT` unless the version is the one the screen showed. */
  assertVersion(row: { version: number }, version: number): void {
    if (row.version !== version) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: row.version } });
  }

  /** Only the recommendations of an engagement that is being followed up move (409 ENGAGEMENT_STATE_INVALID). */
  assertFollowedUp(row: RecommendationRow): void {
    if (row.engagementStatus !== 'FOLLOW_UP') throw new DomainError('ENGAGEMENT_STATE_INVALID', 409, `${row.engagementStatus}->follow_up`);
  }

  /** Locks an action of remediation with its recommendation, in the scope of the caller (404 outside it). */
  async lockAction(tx: TenantTx, id: string, seen: ScopeBuilder): Promise<ActionRow> {
    const visible = seen(2);
    const [located] = await tx.query<{ recommendation_id: string }>(
      `select a.recommendation_id from machvon.audit_remediation_action a join machvon.audit_recommendation r on r.tenant_id = a.tenant_id and r.id = a.recommendation_id
         join machvon.audit_conclusion c on c.tenant_id = r.tenant_id and c.id = r.conclusion_id
         join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id
         left join machvon.organization_unit ow on ow.tenant_id = r.tenant_id and ow.id = r.owner_unit_id
        where a.id = $1::uuid and ${visible.sql}`,
      [id, ...visible.params],
    );
    if (located === undefined) throw NOT_FOUND();
    const [action] = await tx.query<{ id: string; action_code: string; status: ActionStatus; planned_on: string; version: string }>(
      'select id, action_code, status, planned_on::text as planned_on, version::text as version from machvon.audit_remediation_action where id = $1::uuid for update',
      [id],
    );
    if (action === undefined) throw NOT_FOUND();
    const [row] = await tx.query<RowSql>(`select ${ROW_COLUMNS} from ${ROW_FROM} where r.id = $1::uuid for update of r`, [located.recommendation_id]);
    if (row === undefined) throw NOT_FOUND();
    return { id: action.id, actionCode: action.action_code, status: action.status, plannedOn: action.planned_on, version: Number(action.version), recommendation: toRow(row) };
  }

  /** The document must be in force: the evidence of work, an explanation, a basis of closure (BR-AUD-09); one that is not is the refusal the caller names. */
  private async assertEffective(tx: TenantTx, documentId: string, refusal: DomainError, kinds?: readonly string[]): Promise<void> {
    const [document] = await tx.query<{ doc_kind: string; effect_status: string }>('select doc_kind, effect_status from machvon.document where id = $1::uuid', [documentId]);
    if (document === undefined || document.effect_status !== 'EFFECTIVE' || (kinds !== undefined && !kinds.includes(document.doc_kind))) throw refusal;
  }

  /**
   * ASSIGN: gives a recommendation to a unit (and to a person of the tenant when one is named) with the day it is due, which is read from the conclusion and not after the deadline it
   * states (422 DUE_AFTER_CONCLUSION_DEADLINE). The caller has shown that the unit lies in their scope. It may be repeated before the work begins, with another owner or another day.
   */
  async assign(tx: TenantTx, row: RecommendationRow, input: NewAssignment, actor: string): Promise<{ version: number }> {
    const status = nextRecommendationStatus(row.status, 'assign');
    assertDueDay(input.dueOn, input.today, row.implementationDueOn);
    if (input.ownerUserId !== undefined) {
      const [member] = await tx.query<{ id: string }>("select id from machvon.membership where id = $1::uuid and status = 'Active'", [input.ownerUserId]);
      if (member === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'owner_user_id');
    }
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_recommendation set status = $2, owner_unit_id = $3::uuid, owner_user_id = $4::uuid, due_on = $5::date, is_overdue = false, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [row.id, status, input.ownerUnitId, input.ownerUserId ?? null, input.dueOn, actor],
    );
    return { version: Number((updated as { version: string }).version) };
  }

  /**
   * PLAN: the owner adds an action, which moves ASSIGNED to IN_PROGRESS once; a code is used once in the recommendation (409 ACTION_CODE_DUPLICATE). Returns the action and the
   * recommendation as they stand.
   */
  async plan(tx: TenantTx, row: RecommendationRow, input: NewAction, actor: string): Promise<{ actionId: string; version: number; status: RecommendationStatus }> {
    const status = nextRecommendationStatus(row.status, 'plan');
    const code = input.actionCode.trim();
    const description = input.description.trim();
    if (code.length < 1) throw new DomainError('VALIDATION_FAILED', 422, 'action_code');
    if (description.length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'description');
    const action = await withUniqueClaim(tx, { constraint: 'audit_remediation_action_code_uq', code: 'ACTION_CODE_DUPLICATE', status: 409 }, async () => {
      const [created] = await tx.query<{ id: string }>(
        `insert into machvon.audit_remediation_action (tenant_id, id, recommendation_id, action_code, description, planned_on, status, reported_by, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::date, 'PLANNED', $5::uuid, $5::uuid, $5::uuid, 1) returning id`,
        [row.id, code, description, input.plannedOn, actor],
      );
      return created as { id: string };
    });
    const [updated] = await tx.query<{ version: string }>(
      'update machvon.audit_recommendation set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid returning version::text as version',
      [row.id, status, actor],
    );
    return { actionId: action.id, version: Number((updated as { version: string }).version), status };
  }

  /**
   * COMPLETE: marks an action of a recommendation that is in progress as done on a day that has come, with evidence that is in force (422 EVIDENCE_REQUIRED for a document that is missing, of
   * another tenant or not in force, BR-AUD-09); the evidence is also kept in the register of evidence of the recommendation.
   */
  async complete(tx: TenantTx, action: ActionRow, input: { completedOn: string; evidenceDocumentId: string; today: string }, actor: string): Promise<{ version: number }> {
    if (action.recommendation.status !== 'IN_PROGRESS') throw new DomainError('RECOMMENDATION_STATE_INVALID', 409, `${action.recommendation.status}->complete`);
    if (action.status !== 'PLANNED') throw new DomainError('ACTION_STATE_INVALID', 409, `${action.status}->complete`);
    if (input.completedOn > input.today) throw new DomainError('VALIDATION_FAILED', 422, 'completed_on');
    await this.assertEffective(tx, input.evidenceDocumentId, new DomainError('EVIDENCE_REQUIRED', 422, 'evidence_document_id'));
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_remediation_action set status = 'DONE', completed_on = $2::date, evidence_document_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [action.id, input.completedOn, input.evidenceDocumentId, actor],
    );
    await this.keepEvidence(tx, 'ACTION', action.id, input.evidenceDocumentId, null, actor);
    return { version: Number((updated as { version: string }).version) };
  }

  /** Puts a document in the register of evidence of an object once; the same document twice is the same row. */
  async keepEvidence(tx: TenantTx, ownerKind: EvidenceOwnerKind, ownerId: string, documentId: string, note: string | null, actor: string): Promise<string> {
    await tx.query(
      `insert into machvon.audit_evidence (tenant_id, id, owner_kind, owner_id, document_id, note, attached_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2::uuid, $3::uuid, $4, $5::uuid) on conflict do nothing`,
      [ownerKind, ownerId, documentId, note, actor],
    );
    const [row] = await tx.query<{ id: string }>('select id from machvon.audit_evidence where owner_kind = $1 and owner_id = $2::uuid and document_id = $3::uuid', [ownerKind, ownerId, documentId]);
    return (row as { id: string }).id;
  }

  /**
   * SUBMIT: the owner reports the work for verification once no action is planned any more and at least one is done (422 OPEN_ACTIONS_REMAIN), and, for a financial recommendation, once what
   * was recommended is recovered (422 RECOVERY_INCOMPLETE) unless the authority accepted the dispute. The owner is the one who reported it (BR-AUD-08).
   */
  async submit(tx: TenantTx, row: RecommendationRow, actor: string): Promise<{ version: number }> {
    const status = nextRecommendationStatus(row.status, 'submit');
    const [counts] = await tx.query<{ planned: string; done: string }>(
      `select count(*) filter (where status = 'PLANNED')::text as planned, count(*) filter (where status = 'DONE')::text as done from machvon.audit_remediation_action where recommendation_id = $1::uuid`,
      [row.id],
    );
    if (counts === undefined || Number(counts.planned) > 0 || Number(counts.done) === 0) throw new DomainError('OPEN_ACTIONS_REMAIN', 422);
    assertRecoveryComplete({ financial: FINANCIAL.has(row.recType), amountVnd: row.amountVnd, recoveredVnd: row.recoveredVnd, disputeAccepted: row.disputeOutcome === 'ACCEPTED_BY_AUTHORITY' });
    const [updated] = await tx.query<{ version: string }>(
      'update machvon.audit_recommendation set status = $2, submitted_by = $3::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid returning version::text as version',
      [row.id, status, actor],
    );
    return { version: Number((updated as { version: string }).version) };
  }

  /**
   * VERIFY: someone who had no hand in the work closes it or sends it back (403 SELF_APPROVAL_DENIED for the owner, the one who reported the work or the one who raised the dispute). A closure of
   * a financial recommendation needs what was recommended recovered or the dispute accepted (422 RECOVERY_INCOMPLETE); a basis of closure, when one is named, is a document in force. A return
   * says what is left to do, in words.
   */
  async verify(tx: TenantTx, row: RecommendationRow, input: Verification, actor: string): Promise<{ version: number; status: RecommendationStatus }> {
    const closing = input.decision === 'CLOSE';
    const status = nextRecommendationStatus(row.status, closing ? 'verifyClose' : 'verifyReturn');
    assertNotOwnWork(actor, row);
    const comment = (input.comment ?? '').trim();
    if (closing) {
      assertRecoveryComplete({ financial: FINANCIAL.has(row.recType), amountVnd: row.amountVnd, recoveredVnd: row.recoveredVnd, disputeAccepted: row.disputeOutcome === 'ACCEPTED_BY_AUTHORITY' });
      if (input.closureBasisDocumentId !== undefined) await this.assertEffective(tx, input.closureBasisDocumentId, new DomainError('DOCUMENT_NOT_EFFECTIVE', 422, 'closure_basis_document_id'));
    } else if (comment.length < NOTE_MIN) {
      throw new DomainError('VALIDATION_FAILED', 422, 'comment');
    }
    const [updated] = closing
      ? await tx.query<{ version: string }>(
          `update machvon.audit_recommendation
              set status = $2, verified_by = $3::uuid, verified_at = now(), closure_basis_document_id = coalesce($4::uuid, closure_basis_document_id), verification_note = nullif($5, ''),
                  updated_at = now(), updated_by = $3::uuid, version = version + 1
            where id = $1::uuid returning version::text as version`,
          [row.id, status, actor, input.closureBasisDocumentId ?? null, comment],
        )
      : await tx.query<{ version: string }>(
          `update machvon.audit_recommendation
              set status = $2, submitted_by = null, verified_by = null, verified_at = null, verification_note = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1
            where id = $1::uuid returning version::text as version`,
          [row.id, status, actor, comment],
        );
    if (closing && input.closureBasisDocumentId !== undefined) await this.keepEvidence(tx, 'RECOMMENDATION', row.id, input.closureBasisDocumentId, 'CLOSURE_BASIS', actor);
    return { version: Number((updated as { version: string }).version), status };
  }

  /**
   * DISPUTE: the owner explains why the recommendation should not stand, in words and with a document in force (422 DOCUMENT_NOT_EFFECTIVE); it is DISPUTED until the authority answers, and
   * the day it is due stops counting meanwhile (BR-AUD-06). The person who raised it is kept, for the separation of duties.
   */
  async dispute(tx: TenantTx, row: RecommendationRow, input: { reason: string; documentId: string }, actor: string): Promise<{ version: number }> {
    const status = nextRecommendationStatus(row.status, 'dispute');
    const reason = input.reason.trim();
    if (reason.length < REASON_MIN) throw new DomainError('VALIDATION_FAILED', 422, 'dispute_reason');
    await this.assertEffective(tx, input.documentId, new DomainError('DOCUMENT_NOT_EFFECTIVE', 422, 'dispute_document_id'));
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_recommendation
          set status = $2, dispute_reason = $3, dispute_document_id = $4::uuid, disputed_by = $5::uuid, dispute_outcome = null, is_overdue = false, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [row.id, status, reason, input.documentId, actor],
    );
    await this.keepEvidence(tx, 'RECOMMENDATION', row.id, input.documentId, 'DISPUTE', actor);
    return { version: Number((updated as { version: string }).version) };
  }

  /**
   * DECIDE: records the answer of the authority to a dispute, with the document of its opinion (a received or reference document in force, 422 DECISION_DOCUMENT_NOT_EFFECTIVE): accepted, the
   * recommendation goes to the verifier and may close on what was recovered; rejected, it goes back to work and its old day counts again. The one who decides had no hand in it either.
   */
  async decide(tx: TenantTx, row: RecommendationRow, input: { outcome: DisputeOutcome; authorityDocumentId: string }, actor: string): Promise<{ version: number; status: RecommendationStatus }> {
    const accepted = input.outcome === 'ACCEPTED_BY_AUTHORITY';
    const status = nextRecommendationStatus(row.status, accepted ? 'decideAccepted' : 'decideRejected');
    assertNotOwnWork(actor, row);
    await this.assertEffective(tx, input.authorityDocumentId, new DomainError('DECISION_DOCUMENT_NOT_EFFECTIVE', 422, 'authority_document_id'), ['INCOMING', 'REFERENCE']);
    const [updated] = await tx.query<{ version: string }>(
      `update machvon.audit_recommendation
          set status = $2, dispute_outcome = $3, closure_basis_document_id = case when $3 = 'ACCEPTED_BY_AUTHORITY' then $4::uuid else closure_basis_document_id end,
              updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [row.id, status, input.outcome, input.authorityDocumentId, actor],
    );
    await this.keepEvidence(tx, 'RECOMMENDATION', row.id, input.authorityDocumentId, `DISPUTE_DECISION:${input.outcome}`, actor);
    return { version: Number((updated as { version: string }).version), status };
  }

  /**
   * ATTACH: puts a document that is in force in the register of evidence of an engagement, a finding, a recommendation or an action (BR-AUD-09: AUD stores no file). The owner object is found
   * in the scope of the caller or not at all (404). The same document twice is the same row.
   */
  async attachEvidence(tx: TenantTx, input: { ownerKind: EvidenceOwnerKind; ownerId: string; documentId: string; note: string | undefined }, actor: string): Promise<{ id: string }> {
    await this.assertEffective(tx, input.documentId, new DomainError('DOCUMENT_NOT_EFFECTIVE', 422, 'document_id'));
    return { id: await this.keepEvidence(tx, input.ownerKind, input.ownerId, input.documentId, (input.note ?? '').trim() || null, actor) };
  }

  /** The place of the owner object of a piece of evidence, as the scope decides: the recommendation or the engagement it hangs on, or undefined when the caller does not reach it. */
  async locateEvidenceOwner(
    tx: TenantTx,
    ownerKind: EvidenceOwnerKind,
    ownerId: string,
    scopes: { recommendations: ScopeBuilder; engagements: ScopeBuilder },
  ): Promise<{ recommendationId: string | null; engagementId: string } | undefined> {
    if (ownerKind === 'RECOMMENDATION' || ownerKind === 'ACTION') {
      const visible = scopes.recommendations(2);
      const [found] = await tx.query<{ recommendation_id: string; engagement_id: string }>(
        ownerKind === 'RECOMMENDATION'
          ? `select r.id as recommendation_id, c.engagement_id from ${ROW_FROM} where r.id = $1::uuid and ${visible.sql}`
          : `select r.id as recommendation_id, c.engagement_id from machvon.audit_remediation_action a join ${ROW_FROM} on r.tenant_id = a.tenant_id and r.id = a.recommendation_id
              where a.id = $1::uuid and ${visible.sql}`,
        [ownerId, ...visible.params],
      );
      return found === undefined ? undefined : { recommendationId: found.recommendation_id, engagementId: found.engagement_id };
    }
    const visible = scopes.engagements(2);
    const [found] = await tx.query<{ engagement_id: string }>(
      ownerKind === 'ENGAGEMENT'
        ? `select e.id as engagement_id from machvon.audit_engagement e where e.id = $1::uuid and ${visible.sql}`
        : `select e.id as engagement_id from machvon.audit_finding f join machvon.audit_conclusion c on c.tenant_id = f.tenant_id and c.id = f.conclusion_id
             join machvon.audit_engagement e on e.tenant_id = c.tenant_id and e.id = c.engagement_id where f.id = $1::uuid and ${visible.sql}`,
      [ownerId, ...visible.params],
    );
    return found === undefined ? undefined : { recommendationId: null, engagementId: found.engagement_id };
  }

  /** The recommendations in the scope of the caller, by code, with the owner, the day, the dispute and the actions; the cursor is the code and the id of the last one. */
  async list(
    tx: TenantTx,
    scope: ScopeBuilder,
    request: {
      limit: number;
      after: { code: string; id: string } | undefined;
      conclusionId?: string | undefined;
      engagementId?: string | undefined;
      status?: string | undefined;
      recType?: string | undefined;
      ownerUnitId?: string | undefined;
      overdue?: boolean | undefined;
    },
  ): Promise<BoardLine[]> {
    const predicate = scope(10);
    const rows = await tx.query<BoardSql>(
      `select ${BOARD_COLUMNS}
         from ${BOARD_FROM}
        where ($1::text is null or (r.rec_code, r.id) > ($1::text, $2::uuid))
          and ($4::uuid is null or r.conclusion_id = $4::uuid) and ($5::uuid is null or c.engagement_id = $5::uuid)
          and ($6::text is null or r.status = $6::text) and ($7::text is null or r.rec_type = $7::text)
          and ($8::uuid is null or r.owner_unit_id = $8::uuid) and ($9::boolean is null or r.is_overdue = $9::boolean)
          and ${predicate.sql}
        order by r.rec_code, r.id limit $3`,
      [
        request.after?.code ?? null,
        request.after?.id ?? null,
        request.limit,
        request.conclusionId ?? null,
        request.engagementId ?? null,
        request.status ?? null,
        request.recType ?? null,
        request.ownerUnitId ?? null,
        request.overdue ?? null,
        ...predicate.params,
      ],
    );
    return rows.map(toBoard);
  }
}
