import { randomUUID } from 'node:crypto';
import {
  DomainError,
  NOOP_METRICS,
  SETTLEMENT_DEADLINE_KEY,
  SETTLEMENT_DEADLINE_RULE,
  SETTLEMENT_SCOPES,
  SETTLEMENT_STATUSES,
  VERIFICATION_OUTCOMES,
  assertClosable,
  assertExceptionNeeded,
  assertNotPreparer,
  assertVerifier,
  deadlineDays,
  isOpenSettlement,
  isSettlementEditable,
  requiredNote,
  settlementFigures,
  vietnamDateOf,
  verificationDueOn,
  verificationTarget,
  versionConflict,
} from '@machvon/kernel';
import type { MetricsSink, SettlementFigures, SettlementScope, SettlementStatus, VerificationOutcome } from '@machvon/kernel';
import { decisionDocument } from './ctr-decision-document.ts';
import { normalizeUuid } from './file-import-item-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { MasterRules } from './master-rules.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_PAGE = 200;
const MAX_REFS = 50;
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const ts = (column: string): string => `to_char(${column} at time zone 'UTC', ${ISO})`;

/** The project statuses in which a settlement of a year or of a contract is opened, and the one in which the settlement of the whole project is (the project is complete). */
const WORKING_PROJECT_STATUSES = ['IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'] as const;
const COMPLETED_PROJECT_STATUSES = ['COMPLETED'] as const;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });

export interface SettlementReach {
  projectId: string;
  ownerUnit: { id: string; path: string };
  investorUnit: { id: string; path: string } | null;
}

/** A settlement as the screens read it: the figures, the deadline and who did what. */
export interface SettlementView {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  contractId: string | null;
  contractCode: string | null;
  scope: SettlementScope;
  fiscalYear: number | null;
  revision: number;
  status: SettlementStatus;
  settledAmountVnd: string;
  outstandingVnd: string;
  unrecoveredAdvanceVnd: string;
  figuresRefreshedAt: string;
  figuresNote: string | null;
  projectGroup: string | null;
  submittedOn: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  verificationDueOn: string | null;
  deadlineDays: number | null;
  deadlineRuleVersionId: string | null;
  deadlineRuleAwaitingConfirmation: boolean | null;
  verifiedOn: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationFindings: string | null;
  auditFindingRefs: string[];
  exceptionReason: string | null;
  exceptionApprovedBy: string | null;
  exceptionApprovedAt: string | null;
  exceptionApprovalDocumentVersionId: string | null;
  decisionDocumentVersionId: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closeReason: string | null;
  closeEvidenceIds: string[];
  supersedesId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  reach: SettlementReach;
}

interface SettlementSql {
  id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  contract_id: string | null;
  contract_code: string | null;
  settlement_scope: SettlementScope;
  fiscal_year: number | null;
  revision: number;
  status: SettlementStatus;
  settled_amount_vnd: string;
  outstanding_vnd: string;
  unrecovered_advance_vnd: string;
  figures_refreshed_at: string;
  figures_note: string | null;
  project_group: string | null;
  submitted_on: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  verification_due_on: string | null;
  deadline_days: number | null;
  deadline_rule_version_id: string | null;
  deadline_rule_awaiting_confirmation: boolean | null;
  verified_on: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verification_findings: string | null;
  audit_finding_refs: string[];
  exception_reason: string | null;
  exception_approved_by: string | null;
  exception_approved_at: string | null;
  exception_approval_document_version_id: string | null;
  decision_document_version_id: string | null;
  closed_by: string | null;
  closed_at: string | null;
  close_reason: string | null;
  close_evidence_ids: string[] | null;
  supersedes_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const COLUMNS = `sr.id, sr.project_id, p.code as project_code, p.name as project_name, sr.contract_id, c.code as contract_code, sr.settlement_scope, sr.fiscal_year, sr.revision, sr.status,
  sr.settled_amount_vnd::text as settled_amount_vnd, sr.outstanding_vnd::text as outstanding_vnd, sr.unrecovered_advance_vnd::text as unrecovered_advance_vnd,
  ${ts('sr.figures_refreshed_at')} as figures_refreshed_at, sr.figures_note, sr.project_group, sr.submitted_on::text as submitted_on, sr.submitted_by, ${ts('sr.submitted_at')} as submitted_at,
  sr.verification_due_on::text as verification_due_on, sr.deadline_days, sr.deadline_rule_version_id, sr.deadline_rule_awaiting_confirmation, sr.verified_on::text as verified_on, sr.verified_by,
  ${ts('sr.verified_at')} as verified_at, sr.verification_findings, sr.audit_finding_refs, sr.exception_reason, sr.exception_approved_by, ${ts('sr.exception_approved_at')} as exception_approved_at,
  sr.exception_approval_document_version_id, sr.decision_document_version_id, sr.closed_by, ${ts('sr.closed_at')} as closed_at, sr.close_reason, sr.close_evidence_ids, sr.supersedes_id, sr.created_by,
  ${ts('sr.created_at')} as created_at, ${ts('sr.updated_at')} as updated_at, sr.version::text as version, p.owner_unit_id, ou.path as owner_unit_path, p.investor_unit_id, iu.path as investor_unit_path`;

const FROM = `from machvon.settlement_revision sr
  join machvon.project p on p.tenant_id = sr.tenant_id and p.id = sr.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  left join machvon.contract c on c.tenant_id = sr.tenant_id and c.id = sr.contract_id`;

function toView(row: SettlementSql): SettlementView {
  return {
    id: row.id,
    projectId: row.project_id,
    projectCode: row.project_code,
    projectName: row.project_name,
    contractId: row.contract_id,
    contractCode: row.contract_code,
    scope: row.settlement_scope,
    fiscalYear: row.fiscal_year,
    revision: row.revision,
    status: row.status,
    settledAmountVnd: row.settled_amount_vnd,
    outstandingVnd: row.outstanding_vnd,
    unrecoveredAdvanceVnd: row.unrecovered_advance_vnd,
    figuresRefreshedAt: row.figures_refreshed_at,
    figuresNote: row.figures_note,
    projectGroup: row.project_group,
    submittedOn: row.submitted_on,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    verificationDueOn: row.verification_due_on,
    deadlineDays: row.deadline_days,
    deadlineRuleVersionId: row.deadline_rule_version_id,
    deadlineRuleAwaitingConfirmation: row.deadline_rule_awaiting_confirmation,
    verifiedOn: row.verified_on,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    verificationFindings: row.verification_findings,
    auditFindingRefs: row.audit_finding_refs,
    exceptionReason: row.exception_reason,
    exceptionApprovedBy: row.exception_approved_by,
    exceptionApprovedAt: row.exception_approved_at,
    exceptionApprovalDocumentVersionId: row.exception_approval_document_version_id,
    decisionDocumentVersionId: row.decision_document_version_id,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    closeEvidenceIds: row.close_evidence_ids ?? [],
    supersedesId: row.supersedes_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
    reach: {
      projectId: row.project_id,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    },
  };
}

export interface OpenSettlementInput {
  projectId: string;
  contractId?: string | undefined;
  scope: string;
  fiscalYear?: number | undefined;
}

export interface VerificationInput {
  outcome: string;
  findings: string | undefined;
  auditFindingRefs?: readonly string[] | undefined;
}

export interface ExceptionInput {
  reason: string | undefined;
  approvalDocumentVersionId: string | undefined;
}

export interface CloseSettlementInput {
  decision: string;
  reason: string | undefined;
  evidenceIds: readonly string[];
  decisionDocumentVersionId: string | undefined;
}

export interface SettlementFilter {
  status?: string | undefined;
  projectId?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a command did: the settlement as it stands and the status it was in. */
export interface SettlementChange {
  view: SettlementView;
  fromStatus: SettlementStatus;
  /** Only for a submission: the deadline that was given. */
  deadline?: { days: number; ruleVersionId: string; awaitingConfirmation: boolean };
}

/**
 * The settlement of a project, of a year or of a contract (ST-PAY-009, PAY 3.5, BR-PAY-15, BR-PAY-16). It is opened as a draft with the figures read from the ledgers, read again while it is a draft or has
 * been returned, sent with the deadline the rule of the day gives the group of the project (kept as it was given), taken up and verified by someone other than who sent it, and closed by someone other
 * than who prepared it; with something still owed it closes only on an exception that someone else approved, and the figures stay what they are.
 */
export class PayProjectSettlementStore {
  private readonly rules = new MasterRules();
  private readonly metrics: MetricsSink;

  constructor(metrics: MetricsSink = NOOP_METRICS) {
    this.metrics = metrics;
  }

  /** The settlements of the projects in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: SettlementFilter): Promise<SettlementView[]> {
    const status = filter.status === undefined ? null : (SETTLEMENT_STATUSES.find((candidate) => candidate === filter.status) ?? this.badFilter('status'));
    const project = filter.projectId === undefined ? null : normalizeUuid(filter.projectId, 'project_id');
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(5);
    const rows = await tx.query<SettlementSql>(
      `select ${COLUMNS} ${FROM}
        where ($1::text is null or sr.status = $1) and ($2::uuid is null or sr.project_id = $2::uuid)
          and ($3::text is null or (${timestampKey('sr.created_at')}, sr.id) < ($3::text, $4::uuid)) and ${predicate.sql}
        order by sr.created_at desc, sr.id desc limit ${filter.limit}`,
      [status, project, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toView);
  }

  /** One settlement inside the scope of the caller; undefined when it does not exist or lies outside the scope. */
  async find(tx: TenantTx, scope: ScopeBuilder, id: string): Promise<SettlementView | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<SettlementSql>(`select ${COLUMNS} ${FROM} where sr.id = $1::uuid and ${predicate.sql}`, [normalizeUuid(id, 'id'), ...predicate.params]);
    return rows[0] === undefined ? undefined : toView(rows[0]);
  }

  /**
   * Opens a settlement as a draft (PAY 3.5 step 1). The scope says what the other fields must be: a year for ANNUAL, a contract of the project for CONTRACT, neither for PROJECT. The project must be
   * one in which a settlement is made (the settlement of the whole project when it is complete). Only one settlement is worked on for the same project, scope, contract and year (409
   * `SETTLEMENT_OPEN_EXISTS`); a closed one gives way to the next revision, which supersedes it.
   */
  async open(tx: TenantTx, input: OpenSettlementInput, actor: string, scope: ScopeBuilder): Promise<SettlementChange> {
    const kind = SETTLEMENT_SCOPES.find((candidate) => candidate === input.scope) ?? invalidScope();
    const projectId = normalizeUuid(input.projectId, 'project_id');
    const contractId = input.contractId === undefined ? null : normalizeUuid(input.contractId, 'contract_id');
    const fiscalYear = input.fiscalYear ?? null;
    if (kind === 'CONTRACT' && contractId === null) throw invalid('contract_id', 'REQUIRED_FOR_SCOPE');
    if (kind !== 'CONTRACT' && contractId !== null) throw invalid('contract_id', 'NOT_FOR_SCOPE');
    if (kind === 'ANNUAL' && fiscalYear === null) throw invalid('fiscal_year', 'REQUIRED_FOR_SCOPE');
    if (kind !== 'ANNUAL' && fiscalYear !== null) throw invalid('fiscal_year', 'NOT_FOR_SCOPE');
    if (fiscalYear !== null && (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100)) throw invalid('fiscal_year', 'OUT_OF_RANGE');

    const predicate = scope(2);
    const [project] = await tx.query<{ id: string; status: string }>(
      `select p.id, p.status from machvon.project p
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where p.id = $1::uuid and ${predicate.sql} for update of p`,
      [projectId, ...predicate.params],
    );
    // A project outside the scope of the caller is a project that is not there.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const allowed: readonly string[] = kind === 'PROJECT' ? COMPLETED_PROJECT_STATUSES : WORKING_PROJECT_STATUSES;
    if (!allowed.includes(project.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'project_id', { extensions: { project_status: project.status, settlement_scope: kind } });
    if (contractId !== null) {
      const [contract] = await tx.query<{ project_id: string }>('select project_id from machvon.contract where id = $1::uuid', [contractId]);
      if (contract === undefined || contract.project_id !== projectId) throw invalid('contract_id', 'NOT_IN_PROJECT');
    }

    const [latest] = await tx.query<{ id: string; status: SettlementStatus; revision: number }>(
      `select id, status, revision from machvon.settlement_revision
        where project_id = $1::uuid and contract_id is not distinct from $2::uuid and settlement_scope = $3 and fiscal_year is not distinct from $4::integer
        order by revision desc limit 1 for update`,
      [projectId, contractId, kind, fiscalYear],
    );
    if (latest !== undefined && isOpenSettlement(latest.status)) {
      throw new DomainError('SETTLEMENT_OPEN_EXISTS', 409, 'project_id', { extensions: { settlement_id: latest.id, status: latest.status, revision: latest.revision } });
    }
    const figures = await this.figuresOf(tx, projectId, contractId, kind, fiscalYear);
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.settlement_revision
           (tenant_id, id, project_id, contract_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, audit_finding_refs, status, settlement_scope, fiscal_year, supersedes_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::numeric, $7::numeric, '[]'::jsonb, 'DRAFT', $8, $9, $10::uuid, $11::uuid, $11::uuid)`,
        [id, projectId, contractId, (latest?.revision ?? 0) + 1, figures.settledVnd, figures.outstandingVnd, figures.unrecoveredAdvanceVnd, kind, fiscalYear, latest?.id ?? null, actor],
      );
      if (latest !== undefined) {
        await tx.query("update machvon.settlement_revision set status = 'SUPERSEDED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [latest.id, actor]);
      }
    } catch (error) {
      throw settlementRefusal(error);
    }
    this.metrics.increment(SETTLEMENT_COMMAND_METRIC, { command: 'open', outcome: 'ok' });
    return { view: await this.viewOf(tx, id), fromStatus: 'DRAFT' };
  }

  /** Reads the figures from the ledgers again (PAY 3.5 step 1): only a draft or a settlement that was returned has figures that can change, and one that was returned becomes a draft again. */
  async refresh(tx: TenantTx, id: string, expectedVersion: number, note: string | undefined, actor: string, scope: ScopeBuilder): Promise<SettlementChange> {
    const text = note === undefined ? null : requiredNote(note, 'note');
    const held = await this.lock(tx, id, expectedVersion, scope);
    if (!isSettlementEditable(held.status)) throw stateInvalid(held.status);
    const figures = await this.figuresOf(tx, held.project_id, held.contract_id, held.settlement_scope, held.fiscal_year);
    try {
      await tx.query(
        `update machvon.settlement_revision
            set settled_amount_vnd = $2::numeric, outstanding_vnd = $3::numeric, unrecovered_advance_vnd = $4::numeric, figures_refreshed_at = now(), figures_note = $5,
                status = 'DRAFT', submitted_on = null, submitted_by = null, submitted_at = null, project_group = null, verification_due_on = null, deadline_days = null, deadline_rule_version_id = null,
                deadline_rule_awaiting_confirmation = null, verified_on = null, verified_by = null, verified_at = null, deadline_t30_sent_at = null, deadline_t7_sent_at = null, deadline_overdue_sent_at = null,
                updated_at = now(), updated_by = $6::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, figures.settledVnd, figures.outstandingVnd, figures.unrecoveredAdvanceVnd, text, actor],
      );
    } catch (error) {
      throw settlementRefusal(error);
    }
    this.metrics.increment(SETTLEMENT_COMMAND_METRIC, { command: 'refresh', outcome: 'ok' });
    return { view: await this.viewOf(tx, held.id), fromStatus: held.status };
  }

  /**
   * Sends the settlement (PAY 3.5 step 2, UAT-AC339): the group of the project is taken on the day of the submission and the deadline is that day plus the days the rule in force on that day gives the
   * group. A project with no group is 422 `PROJECT_GROUP_MISSING`; no rule in force, or one with no row for the group, is 422 `DEADLINE_RULE_UNCONFIRMED`. The days and the version of the rule are kept
   * with the deadline, so changing the rule afterwards does not move a deadline that was given.
   */
  async submit(tx: TenantTx, id: string, expectedVersion: number, input: { submittedOn: string }, actor: string, scope: ScopeBuilder, now: Date): Promise<SettlementChange> {
    const submittedOn = dayOf(input.submittedOn, 'submitted_on');
    const held = await this.lock(tx, id, expectedVersion, scope);
    if (!isSettlementEditable(held.status)) throw stateInvalid(held.status);
    if (submittedOn > vietnamDateOf(now)) throw invalid('submitted_on', 'IN_THE_FUTURE');
    const [project] = await tx.query<{ project_group: string | null }>('select project_group from machvon.project where id = $1::uuid', [held.project_id]);
    const group = project?.project_group ?? null;
    if (group === null) throw new DomainError('PROJECT_GROUP_MISSING', 422, 'project_id', { extensions: { project_id: held.project_id } });
    const rule = await this.rules.read(tx, SETTLEMENT_DEADLINE_RULE, SETTLEMENT_DEADLINE_KEY, submittedOn);
    if (rule === undefined) throw new DomainError('DEADLINE_RULE_UNCONFIRMED', 422, 'submitted_on', { extensions: { reason: 'NO_RULE', project_group: group, submitted_on: submittedOn } });
    const days = deadlineDays(daysOf(rule.attributes.days_by_group), group);
    if (days === undefined) {
      throw new DomainError('DEADLINE_RULE_UNCONFIRMED', 422, 'submitted_on', { extensions: { reason: 'NO_ROW_FOR_GROUP', project_group: group, deadline_rule_version_id: rule.versionId } });
    }
    const dueOn = verificationDueOn(submittedOn, days);
    try {
      await tx.query(
        `update machvon.settlement_revision
            set status = 'SUBMITTED', submitted_on = $2::date, submitted_by = $3::uuid, submitted_at = now(), project_group = $4, verification_due_on = $5::date, deadline_days = $6,
                deadline_rule_version_id = $7::uuid, deadline_rule_awaiting_confirmation = $8, updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, submittedOn, actor, group, dueOn, days, rule.versionId, rule.awaitingConfirmation],
      );
    } catch (error) {
      throw settlementRefusal(error);
    }
    this.metrics.increment(SETTLEMENT_COMMAND_METRIC, { command: 'submit', outcome: 'ok' });
    return { view: await this.viewOf(tx, held.id), fromStatus: held.status, deadline: { days, ruleVersionId: rule.versionId, awaitingConfirmation: rule.awaitingConfirmation } };
  }

  /**
   * Takes up, verifies or gives back a settlement (PAY 3.5 step 4), with the findings in the words of the verifier and the references to the conclusions of AUD. Whoever sent the settlement does not verify
   * it (403 `SELF_APPROVAL_DENIED`). A settlement that is given back can be read again and sent again.
   */
  async verify(tx: TenantTx, id: string, expectedVersion: number, input: VerificationInput, actor: string, scope: ScopeBuilder, now: Date): Promise<SettlementChange> {
    const outcome: VerificationOutcome = VERIFICATION_OUTCOMES.find((candidate) => candidate === input.outcome) ?? invalidOutcome();
    const findings = requiredNote(input.findings, 'findings');
    const refs = (input.auditFindingRefs ?? []).map((ref) => normalizeUuid(ref, 'audit_finding_refs'));
    if (refs.length > MAX_REFS) throw invalid('audit_finding_refs', 'TOO_MANY');
    const held = await this.lock(tx, id, expectedVersion, scope);
    const target = verificationTarget(held.status, outcome);
    if (target === undefined) throw stateInvalid(held.status);
    assertVerifier(actor, held.submitted_by);
    const verified = target === 'VERIFIED';
    try {
      await tx.query(
        `update machvon.settlement_revision
            set status = $2, verification_findings = $3, audit_finding_refs = case when $4::boolean then $5::jsonb else audit_finding_refs end,
                verified_on = case when $6::boolean then $7::date else verified_on end, verified_by = case when $6::boolean then $8::uuid else verified_by end,
                verified_at = case when $6::boolean then now() else verified_at end, updated_at = now(), updated_by = $8::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, target, findings, refs.length > 0, JSON.stringify(refs), verified, vietnamDateOf(now), actor],
      );
    } catch (error) {
      throw settlementRefusal(error);
    }
    this.metrics.increment(SETTLEMENT_COMMAND_METRIC, { command: 'verify', outcome: target });
    return { view: await this.viewOf(tx, held.id), fromStatus: held.status };
  }

  /**
   * Approves the exception that lets a settlement close while something is still owed (PAY 3.5 step 5, UAT-AC66): the settlement is verified, it owes something (422 `NO_OUTSTANDING_TO_EXCEPT`
   * otherwise), and whoever approves is not one of the people who prepared it (403 `SELF_APPROVAL_DENIED`). The figures are not touched.
   */
  async approveException(tx: TenantTx, id: string, expectedVersion: number, input: ExceptionInput, actor: string, scope: ScopeBuilder, now: Date): Promise<SettlementChange> {
    const held = await this.lock(tx, id, expectedVersion, scope);
    if (held.status !== 'VERIFIED') throw stateInvalid(held.status);
    if (held.exception_approved_at !== null) throw stateInvalid(held.status, 'EXCEPTION_ALREADY_APPROVED');
    assertExceptionNeeded(figuresOfRow(held));
    const reason = requiredNote(input.reason, 'reason');
    assertNotPreparer(actor, held.created_by, held.submitted_by);
    const document = await this.cleanDocument(tx, input.approvalDocumentVersionId, 'approval_document_version_id');
    try {
      await tx.query(
        `update machvon.settlement_revision
            set exception_reason = $2, exception_approved_by = $3::uuid, exception_approved_at = $5::timestamptz, exception_approval_document_version_id = $4::uuid,
                updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, reason, actor, document, now.toISOString()],
      );
    } catch (error) {
      throw settlementRefusal(error);
    }
    this.metrics.increment(SETTLEMENT_COMMAND_METRIC, { command: 'approve_exception', outcome: 'ok' });
    return { view: await this.viewOf(tx, held.id), fromStatus: held.status };
  }

  /**
   * Closes a verified settlement (PAY 3.5 step 5): on the decision document of the tenant (422 `DECISION_DOCUMENT_REQUIRED`), with nothing owed or the exception approved (422
   * `SETTLEMENT_HAS_OUTSTANDING`), by someone other than the people who prepared it. The figures stay what they are; the exception, not a zero, is what lets it close.
   */
  async close(tx: TenantTx, id: string, expectedVersion: number, input: CloseSettlementInput, actor: string, scope: ScopeBuilder, now: Date): Promise<SettlementChange> {
    if (input.decision !== 'approve') throw invalid('decision', 'ONLY_APPROVE_CLOSES');
    const reason = requiredNote(input.reason, 'reason');
    const evidence = [...new Set(input.evidenceIds.map((evidenceId) => normalizeUuid(evidenceId, 'evidence_ids')))];
    if (evidence.length > MAX_REFS) throw invalid('evidence_ids', 'TOO_MANY');
    const held = await this.lock(tx, id, expectedVersion, scope);
    if (held.status !== 'VERIFIED') throw stateInvalid(held.status);
    const decision = await decisionDocument(tx, input.decisionDocumentVersionId, 'decision_document_version_id');
    assertClosable(figuresOfRow(held), held.exception_approved_at !== null);
    assertNotPreparer(actor, held.created_by, held.submitted_by);
    await this.assertEvidence(tx, evidence);
    try {
      await tx.query(
        `update machvon.settlement_revision
            set status = 'CLOSED', decision_document_version_id = $2::uuid, closed_by = $3::uuid, closed_at = $4::timestamptz, close_reason = $5, close_evidence_ids = $6::jsonb,
                updated_at = now(), updated_by = $3::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, decision.versionId, actor, now.toISOString(), reason, JSON.stringify(evidence)],
      );
    } catch (error) {
      throw settlementRefusal(error);
    }
    this.metrics.increment(SETTLEMENT_COMMAND_METRIC, { command: 'close', outcome: held.exception_approved_at === null ? 'ok' : 'with_exception' });
    return { view: await this.viewOf(tx, held.id), fromStatus: held.status };
  }

  /**
   * The figures of a scope from the ledgers. A settlement of a project or a contract reads everything the ledgers hold now; one of a year reads what was paid in that year (Vietnam time) and what was
   * owed and unrecovered at the end of it. The accepted work and the retention are those of the cumulative ledger of the contracts in scope, the advance those of the advance journal.
   */
  async figuresOf(tx: TenantTx, projectId: string, contractId: string | null, kind: SettlementScope, fiscalYear: number | null): Promise<SettlementFigures> {
    const from = kind === 'ANNUAL' && fiscalYear !== null ? `${fiscalYear}-01-01` : null;
    const until = kind === 'ANNUAL' && fiscalYear !== null ? `${fiscalYear + 1}-01-01` : null;
    const [sums] = await tx.query<{ accepted: string; paid: string; paid_window: string; retention: string; disbursed: string; recovered: string }>(
      `with contracts as (select id from machvon.contract where project_id = $1::uuid and ($2::uuid is null or id = $2::uuid)),
            bounds as (select ($3::date)::timestamp at time zone 'Asia/Ho_Chi_Minh' as since, ($4::date)::timestamp at time zone 'Asia/Ho_Chi_Minh' as until),
            ledger as (
              select coalesce(sum(e.accepted_delta_vnd), 0) as accepted, coalesce(sum(e.retention_delta_vnd), 0) as retention, coalesce(sum(e.paid_delta_vnd), 0) as paid_all,
                     coalesce(sum(e.paid_delta_vnd) filter (where bounds.since is null or e.posted_at >= bounds.since), 0) as paid_window
                from machvon.cumulative_ledger_entry e cross join bounds
               where e.contract_id in (select id from contracts) and (bounds.until is null or e.posted_at < bounds.until)
            ),
            advances as (
              select coalesce(sum(case when a.entry_kind in ('DISBURSE') then a.amount_vnd when a.entry_kind = 'REVERSE_DISBURSE' then -a.amount_vnd else 0 end), 0) as disbursed,
                     coalesce(sum(case when a.entry_kind in ('RECOVER') then a.amount_vnd when a.entry_kind = 'REVERSE_RECOVER' then -a.amount_vnd else 0 end), 0) as recovered
                from machvon.advance_ledger_entry a cross join bounds
               where a.contract_id in (select id from contracts) and (bounds.until is null or a.posted_at < bounds.until)
            )
       select ledger.accepted::text as accepted, ledger.paid_all::text as paid, ledger.paid_window::text as paid_window, ledger.retention::text as retention,
              advances.disbursed::text as disbursed, advances.recovered::text as recovered
         from ledger cross join advances`,
      [projectId, contractId, from, until],
    );
    // The sums of a year are those of the entries up to its end; what it settled is only what was paid in it.
    return settlementFigures({
      acceptedVnd: sums?.accepted ?? '0',
      paidVnd: sums?.paid ?? '0',
      ...(from === null ? {} : { paidInPeriodVnd: sums?.paid_window ?? '0' }),
      retentionHeldVnd: sums?.retention ?? '0',
      advanceDisbursedVnd: sums?.disbursed ?? '0',
      advanceRecoveredVnd: sums?.recovered ?? '0',
    });
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number, scope: ScopeBuilder): Promise<SettlementSql> {
    const found = await this.find(tx, scope, id);
    // A settlement outside the scope of the caller is a settlement that is not there.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [row] = await tx.query<SettlementSql>(`select ${COLUMNS} ${FROM} where sr.id = $1::uuid for update of sr`, [found.id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private async viewOf(tx: TenantTx, id: string): Promise<SettlementView> {
    const [row] = await tx.query<SettlementSql>(`select ${COLUMNS} ${FROM} where sr.id = $1::uuid`, [id]);
    if (row === undefined) throw new Error('the settlement vanished after its change');
    return toView(row);
  }

  /** A document of the tenant that was scanned clean: the evidence of an approval. */
  private async cleanDocument(tx: TenantTx, value: string | undefined, field: string): Promise<string> {
    if (value === undefined) throw new DomainError('APPROVAL_REQUIRED', 422, field);
    const id = normalizeUuid(value, field);
    const [document] = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [id]);
    if (document === undefined) throw invalid(field, 'NOT_FOUND');
    if (document.scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, field);
    return id;
  }

  private async assertEvidence(tx: TenantTx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await tx.query<{ id: string; scan_status: string }>('select id, scan_status from machvon.document_version where id = any($1::uuid[])', [ids]);
    if (found.length !== ids.length) throw invalid('evidence_ids', 'NOT_FOUND');
    if (found.some((row) => row.scan_status === 'INFECTED')) throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'evidence_ids');
  }

  private badFilter(field: string): never {
    throw invalid(field);
  }
}

/** What the database refused, in the words of the contract; anything else is given back as it came. */
export function settlementRefusal(error: unknown): unknown {
  const failure = error as { code?: string; message?: string; constraint?: string };
  if (failure.code === UNIQUE_VIOLATION && (failure.constraint === 'settlement_revision_open_uq' || failure.constraint === 'settlement_revision_key_uq')) {
    return new DomainError('SETTLEMENT_OPEN_EXISTS', 409, 'project_id');
  }
  if (failure.code !== CHECK_VIOLATION) return error;
  const message = failure.message ?? '';
  if (message.includes('SETTLEMENT_STATE_INVALID')) return new DomainError('SETTLEMENT_STATE_INVALID', 409, 'id');
  if (message.includes('settlement_revision_close_chk')) return new DomainError('SETTLEMENT_HAS_OUTSTANDING', 422, 'id');
  if (message.includes('settlement_revision_verifier_chk') || message.includes('settlement_revision_exception_chk') || message.includes('settlement_revision_closed_chk')) {
    return new DomainError('SELF_APPROVAL_DENIED', 403);
  }
  return error;
}

/** The command counters of the settlement, by command and outcome. */
export const SETTLEMENT_COMMAND_METRIC = 'pay_settlement_command_total';

const stateInvalid = (status: string, reason?: string): DomainError =>
  new DomainError('SETTLEMENT_STATE_INVALID', 409, 'id', { extensions: reason === undefined ? { status } : { status, reason } });

const invalidScope = (): never => {
  throw invalid('settlement_scope');
};

const invalidOutcome = (): never => {
  throw invalid('outcome');
};

function dayOf(value: string, field: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
}

const figuresOfRow = (row: SettlementSql): SettlementFigures => ({ settledVnd: row.settled_amount_vnd, outstandingVnd: row.outstanding_vnd, unrecoveredAdvanceVnd: row.unrecovered_advance_vnd });

function daysOf(value: unknown): Array<{ projectGroup: string; days: number }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ projectGroup: string; days: number }> = [];
  for (const row of value as Array<Record<string, unknown>>) {
    if (typeof row.project_group === 'string' && typeof row.days === 'number') rows.push({ projectGroup: row.project_group, days: row.days });
  }
  return rows;
}
