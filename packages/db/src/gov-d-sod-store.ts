import { DomainError, afterApproval, afterRejection, afterRevocation, approversNeeded, assertExceptionWindow, assertSodReason, sodChecksFor, sodConflictOf, sodExceptionUsable, sodExceptionView, sodHeldKey, sodMatrixOf, sodSubjectKeyOf, sodViolationError, sodViolationsOf, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { SodCheck, SodExceptionFacts, SodExceptionStatus, SodExceptionView, SodMatrix, SodScope, SodSubject } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The separation of duties at commit (G4-1, `docs/gov-d-sod.md`): the store of the exceptions (`sod_exception`, V1830 to V1833) and the guard that the commands of CTR, PAY and BID call. The matrix is the governance rule `SOD_MATRIX`
 * read through `GovernancePolicyPort` (an approved version of the tenant in force on the day, else the built-in default); the duties a person already holds are found in the columns the modules keep (who drafted, who sent, who checked), so there
 * is no history to backfill. A source that cannot be read is 503 `SOD_CHECK_UNAVAILABLE` and the command is refused: an unreadable source is never read as "no conflict".
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What each duty is, in the tables of the modules.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const CONTRACT_KEYS = (alias: string): string => `${alias}.project_id as project_id, ${alias}.id as contract_id, ${alias}.package_id as package_id`;

/**
 * The rows that say who holds a duty: one row per record with the keys of the scopes (`record_id`, `project_id`, `contract_id`, `package_id`; null where the record does not belong to that kind of group) and the people who hold the duty
 * on it (`actors`, nulls are ignored). A duty is held by whoever the column names, whatever the decision was (a person who sent a measurement back checked it as much as one who approved it).
 */
const DUTY_ROWS: Readonly<Record<string, string>> = {
  'contract.draft': `select c.id as record_id, ${CONTRACT_KEYS('c')}, array[c.created_by, c.submitted_by] as actors from machvon.contract c`,
  'contract.approve': `select c.id as record_id, ${CONTRACT_KEYS('c')}, array[c.signed_by, c.activated_by] as actors from machvon.contract c`,
  'measurement.record': `select m.id as record_id, k.project_id as project_id, m.contract_id as contract_id, k.package_id as package_id, array[m.created_by, m.submitted_by] as actors
     from machvon.measurement m join machvon.contract k on k.tenant_id = m.tenant_id and k.id = m.contract_id`,
  'measurement.approve': `select m.id as record_id, k.project_id as project_id, m.contract_id as contract_id, k.package_id as package_id, array[m.decided_by] as actors
     from machvon.measurement m join machvon.contract k on k.tenant_id = m.tenant_id and k.id = m.contract_id`,
  'acceptance.record': `select a.id as record_id, k.project_id as project_id, a.contract_id as contract_id, k.package_id as package_id, array[a.created_by, a.submitted_by] as actors
     from machvon.acceptance a join machvon.contract k on k.tenant_id = a.tenant_id and k.id = a.contract_id`,
  'acceptance.approve': `select a.id as record_id, k.project_id as project_id, a.contract_id as contract_id, k.package_id as package_id, array[a.decided_by] as actors
     from machvon.acceptance a join machvon.contract k on k.tenant_id = a.tenant_id and k.id = a.contract_id`,
  'payment.request': `select p.id as record_id, p.project_id as project_id, p.contract_id as contract_id, k.package_id as package_id, array[p.created_by, p.submitted_by] as actors
     from machvon.payment_request p join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id where p.request_kind <> 'ADVANCE'`,
  'payment.verify': `select p.id as record_id, p.project_id as project_id, p.contract_id as contract_id, k.package_id as package_id, array[p.verified_by] as actors
     from machvon.payment_request p join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id where p.request_kind <> 'ADVANCE'`,
  'payment.approve': `select p.id as record_id, p.project_id as project_id, p.contract_id as contract_id, k.package_id as package_id, array[p.treasury_sent_by] as actors
     from machvon.payment_request p join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id`,
  'advance.request': `select p.id as record_id, p.project_id as project_id, p.contract_id as contract_id, k.package_id as package_id, array[p.created_by, p.submitted_by] as actors
     from machvon.payment_request p join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id where p.request_kind = 'ADVANCE'`,
  'advance.approve': `select p.id as record_id, p.project_id as project_id, p.contract_id as contract_id, k.package_id as package_id, array[p.verified_by] as actors
     from machvon.payment_request p join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id where p.request_kind = 'ADVANCE'`,
  // The scoring panel: the experts who reviewed a finding of the package, and the people who drew up or signed off the evaluation report of the package.
  'bid.evaluate': `select f.id as record_id, pk.project_id as project_id, null::uuid as contract_id, pk.id as package_id, array[rv.reviewer_user_id] as actors
       from machvon.analysis_finding_review rv
       join machvon.analysis_finding f on f.tenant_id = rv.tenant_id and f.id = rv.finding_id
       join machvon.analysis_run r on r.tenant_id = f.tenant_id and r.id = f.run_id
       join machvon.proposal pp on pp.tenant_id = r.tenant_id and pp.id = r.proposal_id
       join machvon.procurement_package pk on pk.tenant_id = pp.tenant_id and pk.id = pp.package_id
     union all
     select e.id as record_id, pk.project_id as project_id, null::uuid as contract_id, pk.id as package_id,
            array[e.created_by] || coalesce(array(select (case when jsonb_typeof(x) = 'string' then x #>> '{}' else x ->> 'membership_id' end)::uuid from jsonb_array_elements(e.signed_off_by) x), '{}'::uuid[]) as actors
       from machvon.evaluation_report e join machvon.procurement_package pk on pk.tenant_id = e.tenant_id and pk.id = e.package_id`,
  // The award: the person who proposed the result of the package. The sign-off: the person who decided it.
  'bid.award': `select r.id as record_id, pk.project_id as project_id, null::uuid as contract_id, pk.id as package_id, array[r.created_by, r.submitted_by] as actors
     from machvon.procurement_result r join machvon.procurement_package pk on pk.tenant_id = r.tenant_id and pk.id = r.package_id`,
  'bid.sign_off': `select r.id as record_id, pk.project_id as project_id, null::uuid as contract_id, pk.id as package_id, array[r.approved_by, r.rejected_by] as actors
     from machvon.procurement_result r join machvon.procurement_package pk on pk.tenant_id = r.tenant_id and pk.id = r.package_id`,
};

/** What the command acts on, so its keys can be found: the table of the record and the columns that say where it belongs. */
export type SodSubjectKind = 'contract' | 'measurement' | 'acceptance' | 'payment_request' | 'bid_finding' | 'bid_report' | 'bid_result';

const SUBJECT_ROWS: Readonly<Record<SodSubjectKind, string>> = {
  contract: `select c.id as record_id, c.project_id as project_id, c.id as contract_id, c.package_id as package_id from machvon.contract c where c.id = $1::uuid`,
  measurement: `select m.id as record_id, k.project_id as project_id, m.contract_id as contract_id, k.package_id as package_id from machvon.measurement m join machvon.contract k on k.tenant_id = m.tenant_id and k.id = m.contract_id where m.id = $1::uuid`,
  acceptance: `select a.id as record_id, k.project_id as project_id, a.contract_id as contract_id, k.package_id as package_id from machvon.acceptance a join machvon.contract k on k.tenant_id = a.tenant_id and k.id = a.contract_id where a.id = $1::uuid`,
  payment_request: `select p.id as record_id, p.project_id as project_id, p.contract_id as contract_id, k.package_id as package_id from machvon.payment_request p join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id where p.id = $1::uuid`,
  bid_finding: `select f.id as record_id, pk.project_id as project_id, null::uuid as contract_id, pk.id as package_id
     from machvon.analysis_finding f join machvon.analysis_run r on r.tenant_id = f.tenant_id and r.id = f.run_id
     join machvon.proposal pp on pp.tenant_id = r.tenant_id and pp.id = r.proposal_id join machvon.procurement_package pk on pk.tenant_id = pp.tenant_id and pk.id = pp.package_id where f.id = $1::uuid`,
  bid_report: `select e.id as record_id, pk.project_id as project_id, null::uuid as contract_id, pk.id as package_id from machvon.evaluation_report e join machvon.procurement_package pk on pk.tenant_id = e.tenant_id and pk.id = e.package_id where e.id = $1::uuid`,
  bid_result: `select r.id as record_id, pk.project_id as project_id, null::uuid as contract_id, pk.id as package_id from machvon.procurement_result r join machvon.procurement_package pk on pk.tenant_id = r.tenant_id and pk.id = r.package_id where r.id = $1::uuid`,
};

/** The table whose rows an exception of scope SAME_RECORD points at, by the area of the duty (the subject of an exception must exist). */
const RECORD_TABLE_OF_AREA: Readonly<Record<string, string>> = {
  contract: 'contract',
  measurement: 'measurement',
  acceptance: 'acceptance',
  payment: 'payment_request',
  advance: 'payment_request',
  bid: 'procurement_package',
};
const SCOPE_TABLE: Readonly<Record<Exclude<SodScope, 'SAME_RECORD'>, string>> = { SAME_PROJECT: 'project', SAME_CONTRACT: 'contract', SAME_PACKAGE: 'procurement_package' };
const SCOPE_COLUMN: Readonly<Record<SodScope, string>> = { SAME_RECORD: 'record_id', SAME_PROJECT: 'project_id', SAME_CONTRACT: 'contract_id', SAME_PACKAGE: 'package_id' };

const unavailable = (): DomainError => new DomainError('SOD_CHECK_UNAVAILABLE', 503);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Exceptions.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface ExceptionSql {
  id: string;
  action_a: string;
  action_b: string;
  scope: SodScope;
  subject_id: string;
  member_id: string;
  member_name: string | null;
  requested_by: string;
  requested_by_name: string | null;
  reason: string;
  valid_from: string;
  valid_to: string;
  rule_version: number;
  approvers_needed: number;
  approvals: number;
  status: SodExceptionStatus;
  decided_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  version: string;
  created_at: string;
  created_key: string;
  uses: string;
}

export interface SodApprovalRow {
  approverId: string;
  approverName: string | null;
  decision: 'APPROVE' | 'REJECT';
  comment: string | null;
  decidedAt: string;
}

export interface SodExceptionRow {
  id: string;
  actionA: string;
  actionB: string;
  scope: SodScope;
  subjectId: string;
  memberId: string;
  memberName: string | null;
  requestedBy: string;
  requestedByName: string | null;
  reason: string;
  validFrom: string;
  validTo: string;
  ruleVersion: number;
  approversNeeded: number;
  approvals: number;
  status: SodExceptionStatus;
  /** What a reader sees on `today`: an exception whose last day has passed is EXPIRED, though nothing was written. */
  view: SodExceptionView;
  decidedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  version: number;
  createdAt: string;
  uses: number;
  /** Cursor key (the creation moment at full precision). */
  key: string;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const EXCEPTION_COLUMNS = `e.id, e.action_a, e.action_b, e.scope, e.subject_id, e.member_id, dm.display_name as member_name, e.requested_by, dr.display_name as requested_by_name, e.reason,
  e.valid_from::text as valid_from, e.valid_to::text as valid_to, e.rule_version, e.approvers_needed, e.approvals, e.status, ${ISO('e.decided_at')} as decided_at, e.revoked_by, ${ISO('e.revoked_at')} as revoked_at,
  e.revoke_reason, e.version::text as version, ${ISO('e.created_at')} as created_at, to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_key,
  (select count(*) from machvon.sod_exception_use u where u.tenant_id = e.tenant_id and u.exception_id = e.id)::text as uses`;
const EXCEPTION_FROM = `machvon.sod_exception e
  left join machvon.tenant_user_directory dm on dm.tenant_id = e.tenant_id and dm.membership_id = e.member_id
  left join machvon.tenant_user_directory dr on dr.tenant_id = e.tenant_id and dr.membership_id = e.requested_by`;

const toException = (row: ExceptionSql, today: string): SodExceptionRow => ({
  id: row.id,
  actionA: row.action_a,
  actionB: row.action_b,
  scope: row.scope,
  subjectId: row.subject_id,
  memberId: row.member_id,
  memberName: row.member_name,
  requestedBy: row.requested_by,
  requestedByName: row.requested_by_name,
  reason: row.reason,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  ruleVersion: row.rule_version,
  approversNeeded: row.approvers_needed,
  approvals: row.approvals,
  status: row.status,
  view: sodExceptionView({ status: row.status, validTo: row.valid_to }, today),
  decidedAt: row.decided_at,
  revokedBy: row.revoked_by,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
  version: Number(row.version),
  createdAt: row.created_at,
  uses: Number(row.uses),
  key: row.created_key,
});

export interface SodUseRow {
  id: string;
  outcome: 'EXCEPTION_USED' | 'WARNED' | 'BLOCKED';
  exceptionId: string | null;
  actionA: string;
  actionB: string;
  scope: SodScope;
  subjectId: string;
  memberId: string;
  memberName: string | null;
  taking: string;
  command: string;
  recordId: string;
  ruleVersion: number;
  usedAt: string;
  key: string;
}

interface UseSql {
  id: string;
  outcome: SodUseRow['outcome'];
  exception_id: string | null;
  action_a: string;
  action_b: string;
  scope: SodScope;
  subject_id: string;
  member_id: string;
  member_name: string | null;
  taking: string;
  command: string;
  record_id: string;
  rule_version: number;
  used_at: string;
  used_key: string;
}

const USE_COLUMNS = `u.id, u.outcome, u.exception_id, u.action_a, u.action_b, u.scope, u.subject_id, u.member_id, d.display_name as member_name, u.taking, u.command, u.record_id, u.rule_version, ${ISO('u.used_at')} as used_at,
  to_char(u.used_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as used_key`;

const toUse = (row: UseSql): SodUseRow => ({
  id: row.id,
  outcome: row.outcome,
  exceptionId: row.exception_id,
  actionA: row.action_a,
  actionB: row.action_b,
  scope: row.scope,
  subjectId: row.subject_id,
  memberId: row.member_id,
  memberName: row.member_name,
  taking: row.taking,
  command: row.command,
  recordId: row.record_id,
  ruleVersion: row.rule_version,
  usedAt: row.used_at,
  key: row.used_key,
});

export interface SodMatrixReading {
  matrix: SodMatrix;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  approversNeeded: number;
  formula: string | null;
  sourceText: string | null;
  asOf: string | null;
}

export interface SodRequestInput {
  actionA: string;
  actionB: string;
  scope: SodScope;
  subjectId: string;
  memberId: string;
  reason: string;
  validFrom: string;
  validTo: string;
}

export interface SodListFilter {
  status?: SodExceptionView | undefined;
  memberId?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

const LOCKED_VIEW = `select ${EXCEPTION_COLUMNS} from ${EXCEPTION_FROM} where e.id = $1::uuid for update of e`;
const TIMESTAMP_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export class SodStore {
  private readonly port = new GovernancePolicyPort();

  /** The matrix in force on a day, with the version that decided and where its numbers come from. */
  async matrix(tx: TenantTx, today: string): Promise<SodMatrixReading> {
    const rule = await this.port.require(tx, 'SOD_MATRIX', 'DEFAULT', today);
    const matrix = sodMatrixOf(rule.params);
    return {
      matrix,
      version: rule.version,
      source: rule.source,
      unverified: rule.unverified,
      approversNeeded: approversNeeded(matrix),
      formula: rule.provenance?.formula ?? null,
      sourceText: rule.provenance?.source ?? null,
      asOf: rule.provenance?.asOf ?? null,
    };
  }

  /** Asks for an exception. The pair must be one of the matrix (and take exceptions), the days within what the pair allows, the subject must exist; an overlap with a live exception of the same person, pair and subject is 409. */
  async request(tx: TenantTx, input: SodRequestInput, actor: string, today: string): Promise<{ id: string; version: number }> {
    const reading = await this.matrix(tx, today);
    const conflict = sodConflictOf(reading.matrix, { action_a: input.actionA, action_b: input.actionB }, input.scope);
    assertExceptionWindow(conflict, input.validFrom, input.validTo, today);
    const reason = assertSodReason(input.reason);
    await this.assertSubject(tx, input);
    try {
      const rows = await tx.query<{ id: string; version: string }>(
        `insert into machvon.sod_exception (tenant_id, action_a, action_b, scope, subject_id, member_id, requested_by, reason, valid_from, valid_to, rule_version, approvers_needed)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8::date, $9::date, $10, $11) returning id, version::text as version`,
        [input.actionA, input.actionB, input.scope, input.subjectId, input.memberId, actor, reason, input.validFrom, input.validTo, reading.version, reading.approversNeeded],
      );
      const row = rows[0] as { id: string; version: string };
      return { id: row.id, version: Number(row.version) };
    } catch (failure) {
      throw this.refusal(failure);
    }
  }

  private async assertSubject(tx: TenantTx, input: SodRequestInput): Promise<void> {
    const table = input.scope === 'SAME_RECORD' ? RECORD_TABLE_OF_AREA[input.actionA.split('.')[0] as string] : SCOPE_TABLE[input.scope];
    // A subject or a person the tenant does not have is not found (404), so a caller never learns whether it exists in another tenant.
    if (table === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'subject_id');
    const found = await tx.query<{ ok: boolean }>(`select true as ok from machvon.${table} where id = $1::uuid`, [input.subjectId]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'subject_id');
    const member = await tx.query<{ ok: boolean }>(`select true as ok from machvon.membership where id = $1::uuid`, [input.memberId]);
    if (member[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'member_id');
  }

  private refusal(failure: unknown): unknown {
    const code = (failure as { code?: string } | null)?.code;
    // 23P01: the exclusion constraint (no two live exceptions for the same person, pair and subject cover a day). 42501: the guard of the database said no (the application had already checked; this is the second line).
    if (code === '23P01') return new DomainError('SOD_EXCEPTION_STATE_INVALID', 409, 'valid_from');
    if (code === '42501') return new DomainError('SELF_APPROVAL_DENIED', 403);
    return failure;
  }

  private async lock(tx: TenantTx, id: string, expectedVersion: number): Promise<{ facts: SodExceptionFacts; row: ExceptionSql }> {
    const rows = await tx.query<ExceptionSql>(LOCKED_VIEW, [id]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    const approved = await tx.query<{ approver_id: string }>(`select approver_id from machvon.sod_exception_approval where exception_id = $1::uuid and decision = 'APPROVE' order by decided_at, id`, [id]);
    return {
      row,
      facts: {
        status: row.status,
        requestedBy: row.requested_by,
        member: row.member_id,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        approvedBy: approved.map((entry) => entry.approver_id),
        approversNeeded: row.approvers_needed,
      },
    };
  }

  /** One approval. The exception becomes APPROVED when the last of the approvers the matrix asked for agrees; every approver is a person who is neither the one who asked nor the one it covers. */
  async approve(tx: TenantTx, id: string, expectedVersion: number, actor: string, comment: string | undefined, today: string): Promise<{ status: SodExceptionStatus; approvals: number; version: number; memberId: string }> {
    const { facts, row } = await this.lock(tx, id, expectedVersion);
    const next = afterApproval(facts, actor, today);
    try {
      await tx.query(`insert into machvon.sod_exception_approval (tenant_id, exception_id, approver_id, decision, comment) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'APPROVE', $3)`, [id, actor, comment ?? null]);
      const updated = await tx.query<{ version: string }>(
        `update machvon.sod_exception set approvals = $2, status = $3, decided_at = case when $3 = 'APPROVED' then now() else null end, version = version + 1, updated_at = now() where id = $1::uuid returning version::text as version`,
        [id, next.approvals, next.status],
      );
      return { status: next.status, approvals: next.approvals, version: Number((updated[0] as { version: string }).version), memberId: row.member_id };
    } catch (failure) {
      throw this.refusal(failure);
    }
  }

  /** A rejection by one person who may decide ends the request. */
  async reject(tx: TenantTx, id: string, expectedVersion: number, actor: string, comment: string): Promise<{ version: number; memberId: string }> {
    const { facts, row } = await this.lock(tx, id, expectedVersion);
    const status = afterRejection(facts, actor);
    try {
      await tx.query(`insert into machvon.sod_exception_approval (tenant_id, exception_id, approver_id, decision, comment) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'REJECT', $3)`, [id, actor, comment]);
      const updated = await tx.query<{ version: string }>(`update machvon.sod_exception set status = $2, decided_at = now(), version = version + 1, updated_at = now() where id = $1::uuid returning version::text as version`, [id, status]);
      return { version: Number((updated[0] as { version: string }).version), memberId: row.member_id };
    } catch (failure) {
      throw this.refusal(failure);
    }
  }

  /** The administrator takes an exception back, asked or approved, with a reason; it stops excusing at once. */
  async revoke(tx: TenantTx, id: string, expectedVersion: number, actor: string, reason: string): Promise<{ version: number; memberId: string }> {
    const { facts, row } = await this.lock(tx, id, expectedVersion);
    const status = afterRevocation(facts);
    const why = assertSodReason(reason);
    try {
      const updated = await tx.query<{ version: string }>(
        `update machvon.sod_exception set status = $2, revoked_by = $3::uuid, revoked_at = now(), revoke_reason = $4, version = version + 1, updated_at = now() where id = $1::uuid returning version::text as version`,
        [id, status, actor, why],
      );
      return { version: Number((updated[0] as { version: string }).version), memberId: row.member_id };
    } catch (failure) {
      throw this.refusal(failure);
    }
  }

  async find(tx: TenantTx, id: string, today: string): Promise<{ exception: SodExceptionRow; approvals: SodApprovalRow[] } | undefined> {
    const rows = await tx.query<ExceptionSql>(`select ${EXCEPTION_COLUMNS} from ${EXCEPTION_FROM} where e.id = $1::uuid`, [id]);
    if (rows[0] === undefined) return undefined;
    const approvals = await tx.query<{ approver_id: string; approver_name: string | null; decision: 'APPROVE' | 'REJECT'; comment: string | null; decided_at: string }>(
      `select a.approver_id, d.display_name as approver_name, a.decision, a.comment, ${ISO('a.decided_at')} as decided_at
         from machvon.sod_exception_approval a left join machvon.tenant_user_directory d on d.tenant_id = a.tenant_id and d.membership_id = a.approver_id
        where a.exception_id = $1::uuid order by a.decided_at, a.id`,
      [id],
    );
    return {
      exception: toException(rows[0], today),
      approvals: approvals.map((entry) => ({ approverId: entry.approver_id, approverName: entry.approver_name, decision: entry.decision, comment: entry.comment, decidedAt: entry.decided_at })),
    };
  }

  /** The register: newest first. `status` EXPIRED is the derived one (approved or asked, and the last day has passed). */
  async list(tx: TenantTx, filter: SodListFilter, today: string): Promise<SodExceptionRow[]> {
    const after = filter.after;
    if (after !== undefined && !TIMESTAMP_CURSOR.test(after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const params: unknown[] = [today];
    const where: string[] = [];
    if (filter.status !== undefined) {
      if (filter.status === 'EXPIRED') where.push(`e.status in ('REQUESTED', 'APPROVED') and e.valid_to < $1::date`);
      else if (filter.status === 'APPROVED' || filter.status === 'REQUESTED') where.push(`e.status = '${filter.status}' and e.valid_to >= $1::date`);
      else where.push(`e.status = '${filter.status}'`);
    }
    if (filter.memberId !== undefined) {
      params.push(filter.memberId);
      where.push(`e.member_id = $${params.length}::uuid`);
    }
    if (after !== undefined) {
      params.push(after.code, after.id);
      where.push(`(e.created_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(filter.limit);
    const rows = await tx.query<ExceptionSql>(
      // The day is typed in the statement itself: a read with no filter never names it otherwise, and the server cannot tell the type of a parameter the statement does not use.
      `select ${EXCEPTION_COLUMNS} from ${EXCEPTION_FROM} where $1::date is not null${where.map((condition) => ` and ${condition}`).join('')} order by e.created_at desc, e.id desc limit $${params.length}`,
      params,
    );
    return rows.map((row) => toException(row, today));
  }

  /** What the auditor reads: the uses of exceptions, the warnings and the refusals, newest first. */
  async listUses(tx: TenantTx, filter: { outcome?: SodUseRow['outcome'] | undefined; memberId?: string | undefined; exceptionId?: string | undefined; limit: number; after?: { code: string; id: string } | undefined }): Promise<SodUseRow[]> {
    const after = filter.after;
    if (after !== undefined && !TIMESTAMP_CURSOR.test(after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.outcome !== undefined) {
      params.push(filter.outcome);
      where.push(`u.outcome = $${params.length}`);
    }
    if (filter.memberId !== undefined) {
      params.push(filter.memberId);
      where.push(`u.member_id = $${params.length}::uuid`);
    }
    if (filter.exceptionId !== undefined) {
      params.push(filter.exceptionId);
      where.push(`u.exception_id = $${params.length}::uuid`);
    }
    if (after !== undefined) {
      params.push(after.code, after.id);
      where.push(`(u.used_at, u.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(filter.limit);
    const rows = await tx.query<UseSql>(
      `select ${USE_COLUMNS} from machvon.sod_exception_use u left join machvon.tenant_user_directory d on d.tenant_id = u.tenant_id and d.membership_id = u.member_id
        ${where.length === 0 ? '' : `where ${where.join(' and ')}`} order by u.used_at desc, u.id desc limit $${params.length}`,
      params,
    );
    return rows.map(toUse);
  }

  /** The approved exceptions that end within `days` days (the source of the alert type SOD_EXCEPTION_EXPIRING). */
  async expiring(tx: TenantTx, today: string, days: number): Promise<SodExceptionRow[]> {
    const rows = await tx.query<ExceptionSql>(
      `select ${EXCEPTION_COLUMNS} from ${EXCEPTION_FROM} where e.status = 'APPROVED' and e.valid_to >= $1::date and e.valid_to <= ($1::date + $2::int) order by e.valid_to, e.id`,
      [today, days],
    );
    return rows.map((row) => toException(row, today));
  }

  /** The uses since an instant (the source of the alert type SOD_EXCEPTION_USED): only the ones that went through by an exception. */
  async usedSince(tx: TenantTx, since: string): Promise<SodUseRow[]> {
    const rows = await tx.query<UseSql>(
      `select ${USE_COLUMNS} from machvon.sod_exception_use u left join machvon.tenant_user_directory d on d.tenant_id = u.tenant_id and d.membership_id = u.member_id
        where u.outcome = 'EXCEPTION_USED' and u.used_at >= $1::timestamptz order by u.used_at desc, u.id desc`,
      [since],
    );
    return rows.map(toUse);
  }

  /** The approved exception that excuses a person for a pair in a scope on a day, if any. */
  async usableFor(tx: TenantTx, member: string, check: SodCheck, subjectKey: string, today: string): Promise<{ id: string } | undefined> {
    const rows = await tx.query<{ id: string; status: SodExceptionStatus; valid_from: string; valid_to: string }>(
      `select id, status, valid_from::text as valid_from, valid_to::text as valid_to from machvon.sod_exception
        where member_id = $1::uuid and action_a = $2 and action_b = $3 and scope = $4 and subject_id = $5::uuid and status = 'APPROVED' and valid_from <= $6::date and valid_to >= $6::date
        order by valid_to desc, id limit 1`,
      [member, check.action_a, check.action_b, check.scope, subjectKey, today],
    );
    const found = rows[0];
    return found !== undefined && sodExceptionUsable({ status: found.status, validFrom: found.valid_from, validTo: found.valid_to }, today) ? { id: found.id } : undefined;
  }

  async recordUse(
    tx: TenantTx,
    use: { outcome: SodUseRow['outcome']; exceptionId: string | null; check: SodCheck; subjectKey: string; member: string; command: string; recordId: string; ruleVersion: number; requestId?: string | undefined },
  ): Promise<void> {
    await tx.query(
      `insert into machvon.sod_exception_use (tenant_id, outcome, exception_id, action_a, action_b, scope, subject_id, member_id, taking, command, record_id, rule_version, request_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9, $10::uuid, $11, $12)`,
      [use.outcome, use.exceptionId, use.check.action_a, use.check.action_b, use.check.scope, use.subjectKey, use.member, use.check.taking, use.command, use.recordId, use.ruleVersion, use.requestId ?? null],
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface SodTake {
  /** The duty the command takes (`SOD_ACTIONS` of the kernel). */
  taking: string;
  subjectKind: SodSubjectKind;
  /** The record the command acted on (it exists: the guard runs after the module's own work, in the same transaction, so a refusal rolls all of it back). */
  recordId: string;
  actor: string;
  /** The operation id of the command (kept in the use row). */
  command: string;
  requestId?: string | undefined;
}

/** What the guard found that did not stop the command. */
export interface SodPassed {
  excepted: Array<{ exceptionId: string; action_a: string; action_b: string; scope: SodScope }>;
  warned: Array<{ action_a: string; action_b: string; scope: SodScope }>;
}

/** The refusal with what a trace of it needs (kept off the wire: only `extensions` of the error are answered). */
export class SodRefusal extends DomainError {
  readonly attempt: { check: SodCheck; subjectKey: string; take: SodTake; ruleVersion: number };

  constructor(error: DomainError, attempt: SodRefusal['attempt']) {
    super(error.code, error.status, error.detail, error.extensions === undefined ? undefined : { extensions: error.extensions });
    this.attempt = attempt;
  }
}

export class SodGuard {
  private readonly store: SodStore;

  constructor(store: SodStore = new SodStore()) {
    this.store = store;
  }

  /**
   * Judges a command that has just done its work against the duties its actor already holds in the same scope. A conflict that is a BLOCK stops the command (422 SOD_VIOLATION naming the two duties) unless an approved exception of this
   * person for this pair and subject covers the day (then the use is recorded and the command goes on); a WARN is recorded and goes on. Anything the guard cannot read is 503 SOD_CHECK_UNAVAILABLE: it never lets a command pass unread.
   */
  async assert(tx: TenantTx, take: SodTake, now: Date): Promise<SodPassed> {
    const today = vietnamDateOf(now);
    const passed: SodPassed = { excepted: [], warned: [] };
    let reading: SodMatrixReading;
    let checks: SodCheck[];
    let subject: SodSubject;
    const held = new Set<string>();
    try {
      reading = await this.store.matrix(tx, today);
      checks = sodChecksFor(reading.matrix, take.taking).filter((check) => check.other !== check.taking);
      if (checks.length === 0) return passed;
      subject = await this.subjectOf(tx, take);
      for (const check of checks) {
        const key = sodSubjectKeyOf(subject, check.scope);
        if (key === null || DUTY_ROWS[check.other] === undefined) continue;
        if (held.has(sodHeldKey(check.other, check.scope))) continue;
        if (await this.holds(tx, check.other, check.scope, key, take.actor)) held.add(sodHeldKey(check.other, check.scope));
      }
    } catch {
      throw unavailable();
    }
    const violations = sodViolationsOf(reading.matrix, take.taking, held);
    let refusal: { check: SodCheck; key: string } | undefined;
    for (const check of violations) {
      const key = sodSubjectKeyOf(subject, check.scope) as string;
      if (check.severity === 'WARN') {
        await this.store.recordUse(tx, { outcome: 'WARNED', exceptionId: null, check, subjectKey: key, member: take.actor, command: take.command, recordId: take.recordId, ruleVersion: reading.version, requestId: take.requestId });
        passed.warned.push({ action_a: check.action_a, action_b: check.action_b, scope: check.scope });
        continue;
      }
      const exception = check.exception_max_days > 0 ? await this.store.usableFor(tx, take.actor, check, key, today) : undefined;
      if (exception === undefined) {
        refusal ??= { check, key };
        continue;
      }
      await this.store.recordUse(tx, { outcome: 'EXCEPTION_USED', exceptionId: exception.id, check, subjectKey: key, member: take.actor, command: take.command, recordId: take.recordId, ruleVersion: reading.version, requestId: take.requestId });
      passed.excepted.push({ exceptionId: exception.id, action_a: check.action_a, action_b: check.action_b, scope: check.scope });
    }
    if (refusal !== undefined) throw new SodRefusal(sodViolationError(refusal.check, true), { check: refusal.check, subjectKey: refusal.key, take, ruleVersion: reading.version });
    return passed;
  }

  /** Whether a person holds a duty on the group (the record, project, contract or package named by `key`) of a scope: the one question the guard asks the tables of the modules. */
  async holds(tx: TenantTx, action: string, scope: SodScope, key: string, actor: string): Promise<boolean> {
    const rowsOfDuty = DUTY_ROWS[action];
    if (rowsOfDuty === undefined) return false;
    const rows = await tx.query<{ held: boolean }>(`select exists (select 1 from (${rowsOfDuty}) d where d.${SCOPE_COLUMN[scope]} = $1::uuid and $2::uuid = any (d.actors)) as held`, [key, actor]);
    return (rows[0] as { held: boolean }).held;
  }

  /** The keys of the scopes of the record a command acted on; undefined when the record is not there. */
  async subject(tx: TenantTx, kind: SodSubjectKind, recordId: string): Promise<SodSubject | undefined> {
    const rows = await tx.query<{ record_id: string; project_id: string | null; contract_id: string | null; package_id: string | null }>(SUBJECT_ROWS[kind], [recordId]);
    const row = rows[0];
    return row === undefined ? undefined : { record: row.record_id, project: row.project_id, contract: row.contract_id, package: row.package_id };
  }

  private async subjectOf(tx: TenantTx, take: SodTake): Promise<SodSubject> {
    const found = await this.subject(tx, take.subjectKind, take.recordId);
    if (found === undefined) throw unavailable();
    return found;
  }

  /** The trace of a refusal, written in a transaction of its own after the command rolled back (a refused attempt is evidence, and the command left nothing else behind). */
  async recordRefusal(tx: TenantTx, refusal: SodRefusal): Promise<void> {
    const { check, subjectKey, take, ruleVersion } = refusal.attempt;
    await this.store.recordUse(tx, { outcome: 'BLOCKED', exceptionId: null, check, subjectKey, member: take.actor, command: take.command, recordId: take.recordId, ruleVersion, requestId: take.requestId });
  }
}
