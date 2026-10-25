import { randomUUID } from 'node:crypto';
import {
  DomainError,
  INSPECTION_RESULTS,
  INSPECTION_TYPES,
  assertChecklist,
  assertInspectionTransition,
  checklistFor,
  requiredRolesFor,
  requiresPermitGate,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { ChecklistItem, InspectionResult, InspectionStatus, InspectionType, SignerRole } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { assertGateOpen } from './permit-gate-guard.ts';
import { PmtGateStore } from './pmt-gate-store.ts';
import { QmsRegimeRules } from './qms-regime-rules.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** The gate of the permits that a construction contract waits for before work is inspected. */
export const START_GATE = 'START_CONSTRUCTION';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;
const MAX_PARTICIPANTS = 50;
const MAX_ANSWERS = 200;
const UNIQUE_VIOLATION = '23505';
const OPEN_CONSTRAINT = 'inspection_open_uq';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface RequestInput {
  contractId: string;
  boqItemId?: string | undefined;
  inspectionType: string;
  title: string;
  locationText?: string | undefined;
  requestedFor: string;
  siteDiaryId?: string | undefined;
}

export interface ScheduleInput {
  scheduledAt: string;
  participantMembershipIds: readonly string[];
}

export interface RecordInput {
  result: string;
  resultNote: string;
  checklist: readonly unknown[];
}

/** What a command left, as the audit row, the event and the answer are written from. */
export interface InspectionResultView {
  id: string;
  inspectionNo: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  boqItemId: string | null;
  inspectionType: InspectionType;
  requestedFor: string;
  fromStatus: InspectionStatus | null;
  status: InspectionStatus;
  version: number;
  result: InspectionResult | null;
  /** The regime the inspection was given and the roles that will sign its minutes. */
  regimeRuleVersionId: string | null;
  requiredRoles: SignerRole[];
  regimeAwaitingConfirmation: boolean;
  scheduledAt: string | null;
  participantMembershipIds: string[];
  failedItemCodes: string[];
}

/** One inspection as QMS-04 shows it. */
export interface InspectionLine {
  id: string;
  inspectionNo: string;
  contract: { id: string; code: string; status: string };
  projectId: string;
  boqItem: { id: string; businessKey: string; description: string } | null;
  inspectionType: InspectionType;
  title: string;
  locationText: string | null;
  requestedBy: { membershipId: string; displayName: string };
  requestedFor: string;
  scheduledAt: string | null;
  participants: Array<{ membershipId: string; displayName: string }>;
  status: InspectionStatus;
  result: InspectionResult | null;
  resultNote: string | null;
  resultRecordedAt: string | null;
  checklist: Array<ChecklistItem & { outcome?: string; note?: string }>;
  regime: { versionId: string | null; label: string | null; legalBasis: string | null; awaitingConfirmation: boolean; cxn: string | null };
  requiredRoles: SignerRole[];
  siteDiaryId: string | null;
  cancelReason: string | null;
  createdAt: string;
  version: number;
  reach: ContractPlace;
}

interface LockSql {
  id: string;
  inspection_no: string;
  contract_id: string;
  contract_code: string;
  project_id: string;
  boq_item_id: string | null;
  inspection_type: InspectionType;
  requested_for: string;
  status: InspectionStatus;
  scheduled_at: string | null;
  participant_membership_ids: string[];
  checklist: ChecklistItem[];
  required_roles: SignerRole[];
  regime_rule_version_id: string | null;
  regime_awaiting_confirmation: boolean;
  result: InspectionResult | null;
  version: string;
}

interface LineSql {
  id: string;
  inspection_no: string;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  boq_item_id: string | null;
  business_key: string | null;
  boq_description: string | null;
  inspection_type: InspectionType;
  title: string;
  location_text: string | null;
  requested_by: string;
  requester_name: string | null;
  requested_for: string;
  scheduled_at: string | null;
  participants: Array<{ membership_id: string; display_name: string | null }> | null;
  status: InspectionStatus;
  result: InspectionResult | null;
  result_note: string | null;
  result_recorded_at: string | null;
  checklist: Array<ChecklistItem & { outcome?: string; note?: string }>;
  regime_rule_version_id: string | null;
  regime_label: string | null;
  regime_legal_basis: string | null;
  regime_awaiting_confirmation: boolean;
  regime_cxn: string | null;
  required_roles: SignerRole[];
  site_diary_id: string | null;
  cancel_reason: string | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const SELECT = `select i.id, i.inspection_no, c.id as contract_id, c.code as contract_code, c.status as contract_status, c.project_id, i.boq_item_id, b.business_key, b.description as boq_description,
       i.inspection_type, i.title, i.location_text, i.requested_by, ru.display_name as requester_name, i.requested_for::text as requested_for, ${TIMESTAMP('i.scheduled_at')} as scheduled_at,
       (select jsonb_agg(jsonb_build_object('membership_id', p.value, 'display_name', pu.display_name) order by p.ordinality)
          from jsonb_array_elements_text(i.participant_membership_ids) with ordinality as p(value, ordinality)
          left join machvon.tenant_user_directory pu on pu.tenant_id = i.tenant_id and pu.membership_id = p.value::uuid) as participants,
       i.status, i.result, i.result_note, ${TIMESTAMP('i.result_recorded_at')} as result_recorded_at, i.checklist, i.regime_rule_version_id, rv.label as regime_label, rv.legal_basis as regime_legal_basis,
       i.regime_awaiting_confirmation, i.regime_cxn, i.required_roles, i.site_diary_id, i.cancel_reason, ${TIMESTAMP('i.created_at')} as created_at, i.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${CONTRACT_SCOPE_FROM}
  join machvon.inspection i on i.tenant_id = c.tenant_id and i.contract_id = c.id
  left join machvon.boq_item b on b.tenant_id = i.tenant_id and b.id = i.boq_item_id
  left join machvon.master_record_version rv on rv.id = i.regime_rule_version_id
  left join machvon.tenant_user_directory ru on ru.tenant_id = i.tenant_id and ru.membership_id = i.requested_by`;

function toLine(row: LineSql): InspectionLine {
  return {
    id: row.id,
    inspectionNo: row.inspection_no,
    contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
    projectId: row.project_id,
    boqItem: row.boq_item_id === null ? null : { id: row.boq_item_id, businessKey: row.business_key ?? '', description: row.boq_description ?? '' },
    inspectionType: row.inspection_type,
    title: row.title,
    locationText: row.location_text,
    requestedBy: { membershipId: row.requested_by, displayName: row.requester_name ?? '' },
    requestedFor: row.requested_for,
    scheduledAt: row.scheduled_at,
    participants: (row.participants ?? []).map((person) => ({ membershipId: person.membership_id, displayName: person.display_name ?? '' })),
    status: row.status,
    result: row.result,
    resultNote: row.result_note,
    resultRecordedAt: row.result_recorded_at,
    checklist: row.checklist,
    regime: { versionId: row.regime_rule_version_id, label: row.regime_label, legalBasis: row.regime_legal_basis, awaitingConfirmation: row.regime_awaiting_confirmation, cxn: row.regime_cxn },
    requiredRoles: row.required_roles,
    siteDiaryId: row.site_diary_id,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    version: Number(row.version),
    reach: {
      contractId: row.contract_id,
      projectId: row.project_id,
      ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
      investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    },
  };
}

const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const dateOf = (value: string, field: string): string => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!DATE.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw invalid(field);
  return value;
};
const textOf = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

/**
 * The inspections of work under a contract (ST-QMS-004, QMS 3.2). A contractor or the supervisor asks for an inspection of a kind of work on a contract that is being performed (and,
 * for a construction contract, whose permits to start construction are in order); the regime in force on the day of the request gives it its checklist and the roles that will sign its
 * minutes, and an inspection keeps them. The supervisor schedules it with the people who take part and records its result against the checklist; it can be cancelled until then.
 * A result is written once: the inspection is kept as it is afterwards.
 */
export class QmsInspectionStore {
  private readonly contracts: CtrContractStore;
  private readonly regimes: QmsRegimeRules;
  private readonly gates: PmtGateStore;

  constructor(contracts: CtrContractStore = new CtrContractStore(), regimes: QmsRegimeRules = new QmsRegimeRules(), gates: PmtGateStore = new PmtGateStore()) {
    this.contracts = contracts;
    this.regimes = regimes;
    this.gates = gates;
  }

  /**
   * Refusals in order: the shape (422 `VALIDATION_FAILED`), the contract (404 outside the scope, 403 where it may be read and not changed, 409 `CONTRACT_STATE_INVALID` unless it is ACTIVE),
   * the permits of the start of construction for a construction contract (422 `PERMIT_GATE_BLOCKED`), the item and the diary (422), the regime of the day (422 `REGIME_NOT_EFFECTIVE`)
   * and an open request for the same work, kind and day (409 `INSPECTION_DUPLICATE`).
   */
  async request(tx: TenantTx, input: RequestInput, actor: string, scopes: ContractScopes, now: Date): Promise<InspectionResultView> {
    const contractId = idOf(input.contractId, 'contract_id');
    const type = INSPECTION_TYPES.find((candidate) => candidate === input.inspectionType);
    if (type === undefined) throw invalid('inspection_type');
    const title = textOf(input.title, 'title');
    const location = input.locationText === undefined ? null : textOf(input.locationText, 'location_text');
    const requestedFor = dateOf(input.requestedFor, 'requested_for');
    const boqItemId = input.boqItemId === undefined ? null : idOf(input.boqItemId, 'boq_item_id');
    const diaryId = input.siteDiaryId === undefined ? null : idOf(input.siteDiaryId, 'site_diary_id');

    const contract = await this.contracts.lock(tx, contractId, scopes);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    const facts = (await tx.query<{ code: string; advance_category: string }>('select code, advance_category from machvon.contract where id = $1::uuid', [contractId]))[0];
    if (requiresPermitGate(facts?.advance_category ?? '')) await assertGateOpen(this.gates, tx, contract.projectId, START_GATE, vietnamDateOf(now));
    if (boqItemId !== null && (await tx.query('select 1 from machvon.boq_item where id = $1::uuid and contract_id = $2::uuid', [boqItemId, contractId])).length === 0) throw invalid('boq_item_id');
    if (diaryId !== null && (await tx.query('select 1 from machvon.site_diary where id = $1::uuid and contract_id = $2::uuid', [diaryId, contractId])).length === 0) throw invalid('site_diary_id');

    const { rule, reading } = await this.regimes.at(tx, requestedFor);
    const duplicate = await tx.query<{ id: string }>(
      `select id from machvon.inspection
        where contract_id = $1::uuid and coalesce(boq_item_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          and inspection_type = $3 and requested_for = $4::date and status in ('REQUESTED', 'SCHEDULED') limit 1`,
      [contractId, boqItemId, type, requestedFor],
    );
    if (duplicate[0] !== undefined) throw new DomainError('INSPECTION_DUPLICATE', 409, 'requested_for', { extensions: { inspection_id: duplicate[0].id } });

    const sequence = Number((await tx.query<{ n: string }>('select (count(*) + 1)::text as n from machvon.inspection where contract_id = $1::uuid', [contractId]))[0]?.n ?? '1');
    const inspectionNo = `KT-${String(sequence).padStart(3, '0')}`;
    const roles = requiredRolesFor(rule, type);
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.inspection
           (tenant_id, id, project_id, contract_id, boq_item_id, inspection_no, inspection_type, title, location_text, requested_by, requested_for, status, checklist, regime_rule_version_id,
            required_roles, regime_awaiting_confirmation, regime_cxn, site_diary_id, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::uuid, $10::date, 'REQUESTED', $11::jsonb, $12::uuid,
                 $13::jsonb, $14, $15, $16::uuid, $9::uuid, $9::uuid, 1)`,
        [
          id,
          contract.projectId,
          contractId,
          boqItemId,
          inspectionNo,
          type,
          title,
          location,
          actor,
          requestedFor,
          JSON.stringify(checklistFor(rule, type)),
          reading.versionId,
          JSON.stringify(roles),
          reading.awaitingConfirmation,
          reading.awaitingConfirmation ? (reading.cxn ?? 'CXN-07') : null,
          diaryId,
        ],
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === OPEN_CONSTRAINT) throw new DomainError('INSPECTION_DUPLICATE', 409, 'requested_for');
      throw error;
    }
    return {
      id,
      inspectionNo,
      contractId,
      contractCode: facts?.code ?? '',
      projectId: contract.projectId,
      boqItemId,
      inspectionType: type,
      requestedFor,
      fromStatus: null,
      status: 'REQUESTED',
      version: 1,
      result: null,
      regimeRuleVersionId: reading.versionId,
      requiredRoles: roles,
      regimeAwaitingConfirmation: reading.awaitingConfirmation,
      scheduledAt: null,
      participantMembershipIds: [],
      failedItemCodes: [],
    };
  }

  /** Schedules a requested inspection at a moment that has not passed, with the people who take part (each an active member of the tenant). */
  async schedule(tx: TenantTx, id: string, expectedVersion: number, input: ScheduleInput, actor: string, scopes: ContractScopes, now: Date): Promise<InspectionResultView> {
    const at = Date.parse(input.scheduledAt);
    if (Number.isNaN(at) || at < now.getTime()) throw invalid('scheduled_at');
    const participants = [...new Set(input.participantMembershipIds.map((member) => idOf(member, 'participant_membership_ids')))];
    if (participants.length === 0 || participants.length > MAX_PARTICIPANTS || participants.length !== input.participantMembershipIds.length) throw invalid('participant_membership_ids');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const target = assertInspectionTransition('schedule', held.status);
    const active = await tx.query<{ id: string }>("select id from machvon.membership where id = any($1::uuid[]) and status = 'Active'", [participants]);
    if (active.length !== participants.length) throw invalid('participant_membership_ids');
    await tx.query(
      `update machvon.inspection set status = $2, scheduled_at = $3::timestamptz, participant_membership_ids = $4::jsonb, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [id, target, new Date(at).toISOString(), JSON.stringify(participants), actor],
    );
    return this.viewOf(held, held.status, target, { scheduledAt: new Date(at).toISOString(), participants, result: null, failed: [] });
  }

  /**
   * Records the result of a scheduled inspection against its checklist: every item answered, no failed item behind a PASS, a failed item behind a FAIL or a CONDITIONAL (422
   * `CHECKLIST_INCOMPLETE`). The result is written once; the inspection is kept as it is afterwards. A failed result is what the next step (the non-conformance report) starts from.
   */
  async record(tx: TenantTx, id: string, expectedVersion: number, input: RecordInput, actor: string, scopes: ContractScopes, now: Date): Promise<InspectionResultView> {
    const result = INSPECTION_RESULTS.find((candidate) => candidate === input.result);
    if (result === undefined) throw invalid('result');
    const note = textOf(input.resultNote, 'result_note');
    if (!Array.isArray(input.checklist) || input.checklist.length > MAX_ANSWERS) throw invalid('checklist');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const target = assertInspectionTransition('record', held.status);
    const answers = assertChecklist(held.checklist, input.checklist, result);
    await tx.query(
      `update machvon.inspection
          set status = $2, result = $3, result_note = $4, checklist = $5::jsonb, result_recorded_by = $6::uuid, result_recorded_at = $7::timestamptz, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [id, target, result, note, JSON.stringify(answers), actor, now.toISOString()],
    );
    return this.viewOf(held, held.status, target, {
      scheduledAt: held.scheduled_at,
      participants: held.participant_membership_ids,
      result,
      failed: answers.filter((answer) => answer.outcome === 'FAIL').map((answer) => answer.code),
    });
  }

  /** Cancels a requested or scheduled inspection with the reason. */
  async cancel(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, scopes: ContractScopes, now: Date): Promise<InspectionResultView> {
    const why = textOf(reason, 'reason');
    const held = await this.lock(tx, id, expectedVersion, scopes);
    const target = assertInspectionTransition('cancel', held.status);
    await tx.query(`update machvon.inspection set status = $2, cancel_reason = $3, cancelled_at = $4::timestamptz, updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`, [id, target, why, now.toISOString(), actor]);
    return this.viewOf(held, held.status, target, { scheduledAt: held.scheduled_at, participants: held.participant_membership_ids, result: null, failed: [] });
  }

  /** The inspections of the contracts in the scope of the caller, newest request first; one contract when named. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: { contractId?: string | undefined; limit?: number | undefined }): Promise<InspectionLine[]> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or i.contract_id = $1::uuid)
        order by i.requested_for desc, i.created_at desc, i.id limit ${Math.min(Math.max(filter.limit ?? 200, 1), 1000)}`,
      [filter.contractId ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<InspectionLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`${SELECT} where i.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  /** The inspection locked for update inside the scope of the command, its contract locked first and judged by the scope; one the caller cannot see does not exist. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<LockSql> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.inspection where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<LockSql>(
      `select i.id, i.inspection_no, c.id as contract_id, c.code as contract_code, c.project_id, i.boq_item_id, i.inspection_type, i.requested_for::text as requested_for, i.status,
              ${TIMESTAMP('i.scheduled_at')} as scheduled_at, i.participant_membership_ids, i.checklist, i.required_roles, i.regime_rule_version_id, i.regime_awaiting_confirmation, i.result, i.version::text as version
         from machvon.inspection i join machvon.contract c on c.tenant_id = i.tenant_id and c.id = i.contract_id
        where i.id = $1::uuid for update of i`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }

  private viewOf(held: LockSql, from: InspectionStatus, status: InspectionStatus, after: { scheduledAt: string | null; participants: string[]; result: InspectionResult | null; failed: string[] }): InspectionResultView {
    return {
      id: held.id,
      inspectionNo: held.inspection_no,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      projectId: held.project_id,
      boqItemId: held.boq_item_id,
      inspectionType: held.inspection_type,
      requestedFor: held.requested_for,
      fromStatus: from,
      status,
      version: Number(held.version) + 1,
      result: after.result,
      regimeRuleVersionId: held.regime_rule_version_id,
      requiredRoles: held.required_roles,
      regimeAwaitingConfirmation: held.regime_awaiting_confirmation,
      scheduledAt: after.scheduledAt,
      participantMembershipIds: after.participants,
      failedItemCodes: after.failed,
    };
  }
}
