import { randomUUID } from 'node:crypto';
import { DomainError, PETITION_KINDS, PETITION_OUTCOMES, assertPetitionTransition, isPetitionOverdue, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { PetitionKind, PetitionRule, PetitionStatus } from '@machvon/kernel';
import { BidConflictStore } from './bid-conflict-store.ts';
import { BidContractorStore } from './bid-contractor-store.ts';
import { BidPetitionRules } from './bid-petition-rules.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNIQUE_VIOLATION = '23505';
const DOCUMENT_CONSTRAINT = 'procurement_petition_document_uq';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const outOfTime = (reason: string, extensions: Record<string, unknown> = {}): DomainError => new DomainError('PETITION_OUT_OF_TIME', 422, 'received_on', { extensions: { reason, ...extensions } });

export interface ReceiveInput {
  packageId: string;
  contractorId: string;
  petitionKind: string;
  receivedOn: string;
  petitionDocumentId: string;
}

export interface ResolveInput {
  outcome: string;
  /** The reply, or the letter that passes the petition on; an answer without it is 422. */
  resolutionDocumentId?: string | undefined;
}

/** What a command left, as the audit row, the event and the answer are written from. */
export interface PetitionResult {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  contractorId: string;
  petitionKind: PetitionKind;
  receivedOn: string;
  dueOn: string;
  fromStatus: PetitionStatus | null;
  status: PetitionStatus;
  version: number;
  /** The days the deadline was counted with, and the rule they came from. */
  daysApplied: number;
  ruleVersionId: string;
  petitionDocumentId: string;
  resolutionDocumentId: string | null;
  /** True when the petition was answered after the last day of its deadline. */
  late: boolean;
}

/** One petition as BID-20 shows it. */
export interface PetitionLine {
  id: string;
  package: { id: string; code: string };
  projectId: string;
  contractor: { id: string; legalName: string };
  petitionKind: PetitionKind;
  receivedOn: string;
  dueOn: string;
  daysApplied: number;
  status: PetitionStatus;
  /** True while the petition waits for an answer and the last day of its deadline has passed. */
  overdue: boolean;
  /** Whole days past the last day of the deadline while it is overdue, else 0. */
  daysOverdue: number;
  petitionDocumentId: string;
  resolutionDocumentId: string | null;
  /** True when the viewer declared a conflict of interest that stands between them and this petition: another person answers it. */
  viewerInConflict: boolean;
  handledBy: { membershipId: string; displayName: string } | null;
  resolvedAt: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
  /** The units that own and invest in the project of the package, so the caller's permission can be judged for it. */
  reach: { ownerUnit: { id: string; path: string }; investorUnit: { id: string; path: string } | null };
}

interface LockSql {
  id: string;
  package_id: string;
  package_code: string;
  project_id: string;
  contractor_id: string;
  petition_kind: PetitionKind;
  received_on: string;
  due_on: string;
  days_applied: number;
  rule_version_id: string;
  status: PetitionStatus;
  petition_document_id: string;
  version: string;
}

interface LineSql {
  id: string;
  package_id: string;
  package_code: string;
  project_id: string;
  contractor_id: string;
  contractor_name: string | null;
  petition_kind: PetitionKind;
  received_on: string;
  due_on: string;
  days_applied: number;
  status: PetitionStatus;
  petition_document_id: string;
  resolution_document_id: string | null;
  viewer_in_conflict: boolean;
  handled_by: string | null;
  handler_name: string | null;
  resolved_at: string | null;
  created_by: string;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const dateOf = (value: string, field: string): string => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!DATE.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
};
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

/**
 * The petitions of contractors about the selection of a contractor (ST-BID-007, BID 3 F7, BR-BID-14). A planner of the scope of `bid.petition.manage` logs a petition of a contractor
 * about the process or the result of a package; the last day to answer comes from the rule data in force on the day it is received (calendar days, or working days of the calendar the rule
 * names) and is kept with the version of the rule. The petition is answered with a document, or passed on to the level above with one; whoever has a conflict of interest with the
 * contractor or the package does not answer it, another person does. A petition that waits past its last day is overdue (see `BidPetitionDue`).
 */
export class BidPetitionStore {
  private readonly rules: BidPetitionRules;
  private readonly conflicts: BidConflictStore;
  private readonly contractors: BidContractorStore;

  constructor(rules: BidPetitionRules = new BidPetitionRules(), conflicts: BidConflictStore = new BidConflictStore(), contractors: BidContractorStore = new BidContractorStore()) {
    this.rules = rules;
    this.conflicts = conflicts;
    this.contractors = contractors;
  }

  /**
   * Refusals in order: the shape (422 `VALIDATION_FAILED`), the package (404 outside the scope), the contractor and the paper (422), the day (422 `PETITION_OUT_OF_TIME`: not a day
   * ahead; a petition about a result needs a result that was approved, and the rule may limit the days after it), the rule (422 `TIMER_RULE_UNCONFIRMED`, `CALENDAR_NOT_EFFECTIVE`) and a
   * paper that already lodges a petition (409 `PETITION_STATE_INVALID`).
   */
  async receive(tx: TenantTx, input: ReceiveInput, actor: string, scope: ScopeBuilder, now: Date): Promise<PetitionResult> {
    const kind = PETITION_KINDS.find((candidate) => candidate === input.petitionKind);
    if (kind === undefined) throw invalid('petition_kind');
    const receivedOn = dateOf(input.receivedOn, 'received_on');
    const packageId = idOf(input.packageId, 'package_id');
    const contractorId = idOf(input.contractorId, 'contractor_id');
    const documentId = idOf(input.petitionDocumentId, 'petition_document_id');
    const today = vietnamDateOf(now);

    const pack = await this.lockPackage(tx, packageId, scope);
    if ((await this.contractors.find(tx, contractorId)) === undefined) throw invalid('contractor_id');
    await this.assertDocument(tx, documentId, 'petition_document_id');
    if (receivedOn > today) throw outOfTime('FUTURE', { today });

    const { rule, reading } = await this.rules.resolve(tx, kind, receivedOn);
    if (kind === 'RESULT') await this.assertResultStillOpen(tx, pack.id, rule, receivedOn);
    const dueOn = await this.rules.dueOn(tx, rule, receivedOn);

    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.procurement_petition
           (tenant_id, id, package_id, contractor_id, petition_kind, received_on, due_on, petition_document_id, status, days_applied, rule_version_id, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7::uuid, 'RECEIVED', $8, $9::uuid, $10::uuid, $10::uuid, 1)`,
        [id, pack.id, contractorId, kind, receivedOn, dueOn, documentId, rule.days, reading.versionId, actor],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === DOCUMENT_CONSTRAINT) {
        throw new DomainError('PETITION_STATE_INVALID', 409, 'petition_document_id', { extensions: { reason: 'DOCUMENT_ALREADY_LODGED' } });
      }
      throw error;
    }
    return {
      id,
      packageId: pack.id,
      packageCode: pack.code,
      projectId: pack.project_id,
      contractorId,
      petitionKind: kind,
      receivedOn,
      dueOn,
      fromStatus: null,
      status: 'RECEIVED',
      version: 1,
      daysApplied: rule.days,
      ruleVersionId: reading.versionId,
      petitionDocumentId: documentId,
      resolutionDocumentId: null,
      late: false,
    };
  }

  /**
   * Answers a petition (`RESOLVED`) or passes it on to the level above (`ESCALATED`), each with a document. Refusals in order: the shape (422), the petition (404 outside the scope),
   * the version (409), the status (409 `PETITION_STATE_INVALID`), a conflict of interest of the caller with the contractor or the package (409 `CONFLICT_OF_INTEREST_BLOCKED`: another person
   * answers) and the paper (422).
   */
  async resolve(tx: TenantTx, id: string, expectedVersion: number, input: ResolveInput, actor: string, scope: ScopeBuilder, now: Date): Promise<PetitionResult> {
    const outcome = PETITION_OUTCOMES.find((candidate) => candidate === input.outcome);
    if (outcome === undefined) throw invalid('outcome');
    const documentId = idOf(input.resolutionDocumentId ?? '', 'resolution_document_id');
    const held = await this.lockPetition(tx, id, scope);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    const target = assertPetitionTransition(outcome, held.status);
    const declaration = await this.conflicts.blockingDeclaration(tx, actor, held.contractor_id, held.package_id);
    if (declaration !== undefined) {
      throw new DomainError('CONFLICT_OF_INTEREST_BLOCKED', 409, 'actor', { extensions: { contractor_id: held.contractor_id, declaration_id: declaration.id, conflict_of: 'HANDLER' } });
    }
    if (documentId === held.petition_document_id) throw invalid('resolution_document_id');
    await this.assertDocument(tx, documentId, 'resolution_document_id');
    await tx.query(
      `update machvon.procurement_petition
          set status = $2, resolution_document_id = $3::uuid, handled_by = $4::uuid, resolved_at = $5::timestamptz, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, target, documentId, actor, now.toISOString()],
    );
    return {
      id: held.id,
      packageId: held.package_id,
      packageCode: held.package_code,
      projectId: held.project_id,
      contractorId: held.contractor_id,
      petitionKind: held.petition_kind,
      receivedOn: held.received_on,
      dueOn: held.due_on,
      fromStatus: held.status,
      status: target,
      version: Number(held.version) + 1,
      daysApplied: held.days_applied,
      ruleVersionId: held.rule_version_id,
      petitionDocumentId: held.petition_document_id,
      resolutionDocumentId: documentId,
      late: vietnamDateOf(now) > held.due_on,
    };
  }

  /** The petitions of the packages in the scope of the caller, the ones that wait and are most overdue first; optionally those of one package, in one status, or only the overdue. */
  async list(tx: TenantTx, scope: ScopeBuilder, viewer: string, filter: { packageId?: string | undefined; overdueOnly?: boolean | undefined }, now: Date): Promise<PetitionLine[]> {
    const predicate = scope(4);
    const rows = await tx.query<LineSql>(
      `${select(3)} where ${predicate.sql} and ($1::uuid is null or t.package_id = $1::uuid)
          and (not $2::boolean or (t.status in ('RECEIVED', 'PROCESSING') and t.due_on < ${today(4 + predicate.params.length)}))
        order by (t.status in ('RECEIVED', 'PROCESSING')) desc, t.due_on, t.id`,
      [filter.packageId ?? null, filter.overdueOnly ?? false, viewer, ...predicate.params, vietnamDateOf(now)],
    );
    return rows.map((row) => toLine(row, vietnamDateOf(now)));
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder, viewer: string, now: Date): Promise<PetitionLine | undefined> {
    const predicate = scope(3);
    const rows = await tx.query<LineSql>(`${select(2)} where t.id = $1::uuid and ${predicate.sql}`, [id, viewer, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0], vietnamDateOf(now));
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  private async lockPackage(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<{ id: string; code: string; project_id: string }> {
    const predicate = scope(2);
    const rows = await tx.query<{ id: string; code: string; project_id: string }>(
      `select k.id, k.code, k.project_id from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = $1::uuid and ${predicate.sql} for update of p, k`,
      [packageId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  private async lockPetition(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<LockSql> {
    const predicate = scope(2);
    const rows = await tx.query<LockSql>(
      `select t.id, t.package_id, k.code as package_code, p.id as project_id, t.contractor_id, t.petition_kind, t.received_on::text as received_on, t.due_on::text as due_on, t.days_applied,
              t.rule_version_id, t.status, t.petition_document_id, t.version::text as version
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.procurement_petition t on t.tenant_id = k.tenant_id and t.package_id = k.id
        where t.id = $1::uuid and ${predicate.sql} for update of p, k, t`,
      [id, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  private async assertDocument(tx: TenantTx, documentId: string, field: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('select id from machvon.document where id = $1::uuid', [documentId]);
    if (rows[0] === undefined) throw invalid(field);
  }

  /** A petition about the result is lodged after the result was approved and, when the rule limits it, within the days the rule gives from that day. */
  private async assertResultStillOpen(tx: TenantTx, packageId: string, rule: PetitionRule, receivedOn: string): Promise<void> {
    const rows = await tx.query<{ approved_on: string }>(
      `select to_char(max(approved_at) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as approved_on from machvon.procurement_result where package_id = $1::uuid and status = 'APPROVED'`,
      [packageId],
    );
    const approvedOn = rows[0]?.approved_on;
    if (approvedOn === undefined || approvedOn === null) throw outOfTime('NO_RESULT');
    if (receivedOn < approvedOn) throw outOfTime('BEFORE_RESULT', { result_approved_on: approvedOn });
    const last = await this.rules.lastDayToFile(tx, rule, approvedOn);
    if (last !== null && receivedOn > last) throw outOfTime('FILING_WINDOW_PASSED', { result_approved_on: approvedOn, last_day_to_file: last });
  }
}

/** The position of the parameter that holds the Vietnam date of today, as an expression. */
const today = (position: number): string => `$${position}::date`;

/** The select of a petition; the parameter at `viewer` is the caller, whose declared conflicts are told. */
const select = (viewer: number): string => `select t.id, t.package_id, k.code as package_code, p.id as project_id, t.contractor_id, c.legal_name as contractor_name, t.petition_kind, t.received_on::text as received_on,
       t.due_on::text as due_on, t.days_applied, t.status, t.petition_document_id, t.resolution_document_id,
       exists (select 1 from machvon.bid_conflict_declaration d
                where d.tenant_id = t.tenant_id and d.user_id = $${viewer}::uuid and d.has_conflict and d.decision is distinct from 'ALLOWED'
                  and (d.contractor_id = t.contractor_id or (d.package_id = t.package_id and (d.contractor_id is null or d.decision = 'BLOCKED')))) as viewer_in_conflict,
       t.handled_by, hu.display_name as handler_name,
       to_char(t.resolved_at at time zone 'UTC', ${ISO}) as resolved_at, t.created_by, to_char(t.created_at at time zone 'UTC', ${ISO}) as created_at, t.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${SCOPE_FROM}
  join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
  join machvon.procurement_petition t on t.tenant_id = k.tenant_id and t.package_id = k.id
  left join machvon.contractor c on c.tenant_id = t.tenant_id and c.id = t.contractor_id
  left join machvon.tenant_user_directory hu on hu.tenant_id = t.tenant_id and hu.membership_id = t.handled_by`;

function toLine(row: LineSql, todayIso: string): PetitionLine {
  const overdue = isPetitionOverdue(row.status, row.due_on, todayIso);
  const daysOverdue = overdue ? Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${row.due_on}T00:00:00Z`)) / 86_400_000) : 0;
  return {
    id: row.id,
    package: { id: row.package_id, code: row.package_code },
    projectId: row.project_id,
    contractor: { id: row.contractor_id, legalName: row.contractor_name ?? '' },
    petitionKind: row.petition_kind,
    receivedOn: row.received_on,
    dueOn: row.due_on,
    daysApplied: row.days_applied,
    status: row.status,
    overdue,
    daysOverdue,
    petitionDocumentId: row.petition_document_id,
    resolutionDocumentId: row.resolution_document_id,
    viewerInConflict: row.viewer_in_conflict,
    handledBy: row.handled_by === null ? null : { membershipId: row.handled_by, displayName: row.handler_name ?? '' },
    resolvedAt: row.resolved_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    version: Number(row.version),
    reach: {
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    },
  };
}
