import { randomUUID } from 'node:crypto';
import { DomainError, ENFORCEMENT_STEPS, asUuid, assertAdvancerIsNotDrafter, assertEnforcementMove, assertStepFacts, versionConflict } from '@machvon/kernel';
import type { EnforcementStep } from '@machvon/kernel';
import { assertCleanDocument } from './ast-evidence.ts';
import { enterScope, unitInScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import { dateOf, textOf } from './lnd-values.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

/**
 * The enforcement of a land recovery (ST-LND-011, LND 3.3, UC-LND-03, LND-09, UAT-AC385). A case is opened for a parcel whose recovery was decided and whose household was offered the money (delivered, or deposited
 * when the household would not take it), and goes through persuasion, notice, the decision of the organization, the decision of enforcement, execution and completion, each step with its decision, by someone other than
 * the person who drew the case up; execution puts the parcel under enforcement. A case belongs to the unit that answers for the household and is seen only from inside it, by the policy of the database as well as by the
 * application. The procedure is a working assumption until the business owner confirms the rule (CXN-12): there is no record of the rounds of persuasion, so none is counted.
 */
export const ENFORCEMENT_RESOURCE = 'land_enforcement_case';
export const ENFORCEMENT_STARTED_EVENT = 'lnd.enforcement.started.v1';
export const ENFORCEMENT_ADVANCED_EVENT = 'lnd.enforcement.advanced.v1';

/**
 * The parcels a case can be opened for: under an approved plan, held by a complaint, or paid (a household that would not take the money has it deposited, which settles the parcel as a payment does), and the plans whose
 * approval stands.
 */
const ENFORCEABLE_PARCELS: readonly string[] = ['PLAN_APPROVED', 'PAID', 'DISPUTED'];
const STANDING_PLAN_STATUSES: readonly string[] = ['APPROVED', 'PAYING', 'COMPLETED'];
const OPEN_CASE_CLAIM = 'land_enforcement_open_uq';
const MAX_PAGE = 200;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const notMet = (reason: string): DomainError => new DomainError('PRECONDITION_NOT_MET', 422, undefined, { extensions: { reason } });
const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value.trim()) : undefined;
  if (id === undefined) throw invalid(field);
  return id.toLowerCase();
};
const optionalId = (value: string | undefined, field: string): string | null => (value === undefined ? null : idOf(value, field));

export interface StartInput {
  projectId: string;
  parcelId: string;
  householdId?: string | undefined;
  planId?: string | undefined;
  ownerUnitId: string;
  authorityUnitId: string;
  legalBasis: string;
  startedOn: string;
}

export interface AdvanceInput {
  toStep: string;
  decisionDocumentVersionId?: string | undefined;
  plannedOn?: string | undefined;
  executedOn?: string | undefined;
  suspendReason?: string | undefined;
}

/** What a command did to a case: the facts the audit row and the event carry (ids and the dates, never the words of the household). */
export interface EnforcementResult {
  id: string;
  projectId: string;
  parcelId: string;
  householdId: string | null;
  planId: string | null;
  ownerUnitId: string;
  authorityUnitId: string | null;
  fromStep: EnforcementStep | null;
  step: EnforcementStep;
  startedOn: string;
  decisionDocumentVersionId: string | null;
  plannedOn: string | null;
  executedOn: string | null;
  version: number;
}

export interface EnforcementLine {
  id: string;
  projectId: string;
  parcel: { id: string; code: string; status: string };
  household: { id: string; code: string; headName: string } | null;
  planId: string | null;
  ownerUnitId: string;
  authorityUnitId: string | null;
  step: EnforcementStep;
  suspendedFrom: EnforcementStep | null;
  startedOn: string;
  decisionDocumentVersionId: string | null;
  plannedOn: string | null;
  executedOn: string | null;
  legalBasis: string;
  suspendReason: string | null;
  /** The member who drew the case up: the one who may not advance it. */
  draftedBy: string;
  version: number;
  createdAtKey: string;
}

interface LineSql {
  id: string;
  project_id: string;
  parcel_id: string;
  parcel_code: string;
  parcel_status: string;
  household_id: string | null;
  household_code: string | null;
  head_name: string | null;
  plan_id: string | null;
  owner_unit_id: string;
  authority_unit_id: string | null;
  step: EnforcementStep;
  suspended_from: EnforcementStep | null;
  started_on: string;
  decision_document_version_id: string | null;
  planned_on: string | null;
  executed_on: string | null;
  legal_basis: string;
  suspend_reason: string | null;
  created_by: string;
  version: string;
  created_at_key: string;
}

export class LndEnforcementStore {
  /** The project of a case inside the units of the caller; nothing for one outside them. The command asks it to know which project the right has to hold over. */
  async casePlace(tx: TenantTx, caseId: string, units: ScopeUnits): Promise<{ projectId: string } | undefined> {
    await enterScope(tx, units);
    const [row] = await tx.query<{ project_id: string }>('select project_id from machvon.land_enforcement_case where id = $1::uuid', [idOf(caseId, 'id')]);
    return row === undefined ? undefined : { projectId: row.project_id };
  }

  /**
   * Opens a case. Refusals in order: the fields (422), the parcel of the project and the household of it (404 outside the units of the caller), the unit that answers (422 `owner_unit_id`: the unit of the household; 404 for a unit outside the units of the caller), the authority
   * (422 `authority_unit_id`), then 422 `PRECONDITION_NOT_MET` with a `reason` for a parcel that is not under an approved plan or a complaint, a parcel with no recovery decision, a plan that is not approved and a household that has no
   * right on the parcel, and 422 `PAYMENT_NOT_OFFERED` while the household has neither been paid nor had the money deposited; and 409 `ENFORCEMENT_CASE_EXISTS` for a parcel that has a case open. Nothing is written by a refusal.
   */
  async start(tx: TenantTx, input: StartInput, actor: string, units: ScopeUnits, today: string): Promise<EnforcementResult> {
    const projectId = idOf(input.projectId, 'project_id');
    const parcelId = idOf(input.parcelId, 'parcel_id');
    const householdId = optionalId(input.householdId, 'household_id');
    const planId = optionalId(input.planId, 'plan_id');
    const ownerUnitId = idOf(input.ownerUnitId, 'owner_unit_id');
    const authorityUnitId = idOf(input.authorityUnitId, 'authority_unit_id');
    const legalBasis = textOf(input.legalBasis, 'legal_basis', 1, 2000);
    const startedOn = dateOf(input.startedOn, 'started_on');
    if (startedOn > today) throw invalid('started_on', 'IN_THE_FUTURE');
    await enterScope(tx, units);
    // A unit outside the units of the caller is not there for the caller.
    if (!unitInScope(units, ownerUnitId)) throw new DomainError('RESOURCE_NOT_FOUND', 404);

    const [parcel] = await tx.query<{ status: string; recovery_decision_on: string | null }>('select status, recovery_decision_on::text as recovery_decision_on from machvon.land_parcel where id = $1::uuid and project_id = $2::uuid for update', [
      parcelId,
      projectId,
    ]);
    if (parcel === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (householdId !== null) {
      const [household] = await tx.query<{ project_id: string; owner_unit_id: string }>('select project_id, owner_unit_id from machvon.affected_household where id = $1::uuid', [householdId]);
      if (household === undefined || household.project_id !== projectId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      // The unit that answers for the case is the unit of the household: its words are read inside it and nowhere else.
      if (household.owner_unit_id !== ownerUnitId) throw invalid('owner_unit_id');
    }
    const authorities = await tx.query('select 1 from machvon.organization_unit where id = $1::uuid', [authorityUnitId]);
    if (authorities.length === 0) throw invalid('authority_unit_id');

    if (!ENFORCEABLE_PARCELS.includes(parcel.status)) throw notMet('PARCEL_STATUS');
    if (parcel.recovery_decision_on === null) throw notMet('RECOVERY_DECISION_MISSING');
    // The money is offered to the household of the plan: delivered, or deposited when the household would not take it. Without the household and its plan there is no offer to show.
    if (householdId === null || planId === null) throw new DomainError('PAYMENT_NOT_OFFERED', 422, 'plan_id', { extensions: { reason: 'NO_PLAN_OR_HOUSEHOLD' } });
    const [plan] = await tx.query<{ status: string }>('select status from machvon.compensation_plan where id = $1::uuid and project_id = $2::uuid', [planId, projectId]);
    if (plan === undefined || !STANDING_PLAN_STATUSES.includes(plan.status)) throw notMet('PLAN_NOT_APPROVED');
    const links = await tx.query('select 1 from machvon.household_parcel where household_id = $1::uuid and parcel_id = $2::uuid', [householdId, parcelId]);
    if (links.length === 0) throw notMet('HOUSEHOLD_NOT_ON_PARCEL');
    // The money offered is the compensation of this parcel: the plan holds an item of the household for it, not only for another parcel of the household.
    const covered = await tx.query('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid and household_id = $2::uuid and parcel_id = $3::uuid', [planId, householdId, parcelId]);
    if (covered.length === 0) throw new DomainError('PAYMENT_NOT_OFFERED', 422, 'plan_id', { extensions: { reason: 'PLAN_DOES_NOT_COVER_PARCEL' } });
    // The money is offered when what was paid or deposited covers everything the plan holds for the household and no installment is still waiting (as the plan moves the household to compensated).
    const offered = await tx.query<{ settled: boolean }>(
      `select coalesce((select sum(amount_vnd) from machvon.compensation_payment where plan_id = $1::uuid and household_id = $2::uuid and status in ('PAID', 'DEPOSITED')), 0) > 0
          and coalesce((select sum(amount_vnd) from machvon.compensation_payment where plan_id = $1::uuid and household_id = $2::uuid and status in ('PAID', 'DEPOSITED')), 0)
              >= coalesce((select sum(amount_vnd) from machvon.compensation_plan_item where plan_id = $1::uuid and household_id = $2::uuid), 0)
          and not exists (select 1 from machvon.compensation_payment where plan_id = $1::uuid and household_id = $2::uuid and status = 'PENDING') as settled`,
      [planId, householdId],
    );
    if (offered[0]?.settled !== true) throw new DomainError('PAYMENT_NOT_OFFERED', 422, 'plan_id', { extensions: { reason: 'NOT_PAID_OR_DEPOSITED' } });

    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: OPEN_CASE_CLAIM, code: 'ENFORCEMENT_CASE_EXISTS' }, () =>
      tx.query(
        `insert into machvon.land_enforcement_case
           (tenant_id, id, project_id, parcel_id, household_id, plan_id, owner_unit_id, authority_unit_id, step, started_on, legal_basis, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'PERSUASION', $8::date, $9, $10::uuid, $10::uuid, 1)`,
        [id, projectId, parcelId, householdId, planId, ownerUnitId, authorityUnitId, startedOn, legalBasis, actor],
      ),
    );
    return { id, projectId, parcelId, householdId, planId, ownerUnitId, authorityUnitId, fromStep: null, step: 'PERSUASION', startedOn, decisionDocumentVersionId: null, plannedOn: null, executedOn: null, version: 1 };
  }

  /**
   * Moves a case to a step, at the version the caller saw. Refusals in order: 404 for a case outside the units of the caller, 409 `VERSION_CONFLICT`, 403 `SELF_APPROVAL_DENIED` for the person who drew the case up, 422
   * `ENFORCEMENT_STEP_INVALID` for a move the procedure does not allow, then what the step needs (422 `DECISION_DOCUMENT_REQUIRED`, `VALIDATION_FAILED` for the day of execution, of completion and the reason of a
   * suspension) and the documents and days themselves. Execution puts the parcel under enforcement.
   */
  async advance(tx: TenantTx, id: string, expectedVersion: number, input: AdvanceInput, actor: string, units: ScopeUnits, today: string): Promise<EnforcementResult> {
    const toStep = ENFORCEMENT_STEPS.find((candidate) => candidate === input.toStep);
    if (toStep === undefined || toStep === 'PERSUASION') throw invalid('to_step');
    const decisionId = optionalId(input.decisionDocumentVersionId, 'decision_document_version_id');
    const plannedOn = input.plannedOn === undefined ? null : dateOf(input.plannedOn, 'planned_on');
    const executedOn = input.executedOn === undefined ? null : dateOf(input.executedOn, 'executed_on');
    const reason = input.suspendReason === undefined ? null : textOf(input.suspendReason, 'suspend_reason', 1, 2000);
    await enterScope(tx, units);
    const [held] = await tx.query<{
      id: string;
      project_id: string;
      parcel_id: string;
      household_id: string | null;
      plan_id: string | null;
      owner_unit_id: string;
      authority_unit_id: string | null;
      step: EnforcementStep;
      suspended_from: EnforcementStep | null;
      started_on: string;
      decision_document_version_id: string | null;
      planned_on: string | null;
      executed_on: string | null;
      created_by: string;
      version: string;
    }>(
      `select id, project_id, parcel_id, household_id, plan_id, owner_unit_id, authority_unit_id, step, suspended_from, started_on::text as started_on, decision_document_version_id, planned_on::text as planned_on,
              executed_on::text as executed_on, created_by, version::text as version
         from machvon.land_enforcement_case where id = $1::uuid for update`,
      [idOf(id, 'id')],
    );
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    assertAdvancerIsNotDrafter(actor, held.created_by);
    assertEnforcementMove(held.step, toStep, held.suspended_from);
    assertStepFacts(toStep, { decisionDocumentVersionId: decisionId ?? undefined, plannedOn: plannedOn ?? undefined, executedOn: executedOn ?? undefined, suspendReason: reason ?? undefined });
    if (plannedOn !== null && plannedOn < held.started_on) throw invalid('planned_on', 'BEFORE_START');
    if (executedOn !== null && executedOn < held.started_on) throw invalid('executed_on', 'BEFORE_START');
    if (executedOn !== null && executedOn > today) throw invalid('executed_on', 'IN_THE_FUTURE');
    if (decisionId !== null) await assertCleanDocument(tx, decisionId, 'decision_document_version_id');

    if (toStep === 'EXECUTING') {
      const [parcel] = await tx.query<{ status: string }>('select status from machvon.land_parcel where id = $1::uuid for update', [held.parcel_id]);
      if (parcel === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (parcel.status !== 'ENFORCEMENT' && !ENFORCEABLE_PARCELS.includes(parcel.status)) throw new DomainError('ENFORCEMENT_STEP_INVALID', 422, 'to_step', { extensions: { reason: 'PARCEL_STATUS' } });
      if (parcel.status !== 'ENFORCEMENT') {
        await tx.query("update machvon.land_parcel set status = 'ENFORCEMENT', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [held.parcel_id, actor]);
      }
    }
    const version = Number(held.version) + 1;
    const decision = decisionId ?? held.decision_document_version_id;
    const planned = plannedOn ?? held.planned_on;
    const executed = executedOn ?? held.executed_on;
    await tx.query(
      `update machvon.land_enforcement_case
          set step = $2, suspended_from = $3, decision_document_version_id = $4::uuid, planned_on = $5::date, executed_on = $6::date, suspend_reason = $7,
              updated_at = now(), updated_by = $8::uuid, version = $9::bigint
        where id = $1::uuid`,
      [held.id, toStep, toStep === 'SUSPENDED' ? held.step : null, decision, planned, executed, toStep === 'SUSPENDED' ? reason : null, actor, version],
    );
    return {
      id: held.id,
      projectId: held.project_id,
      parcelId: held.parcel_id,
      householdId: held.household_id,
      planId: held.plan_id,
      ownerUnitId: held.owner_unit_id,
      authorityUnitId: held.authority_unit_id,
      fromStep: held.step,
      step: toStep,
      startedOn: held.started_on,
      decisionDocumentVersionId: decision,
      plannedOn: planned,
      executedOn: executed,
      version,
    };
  }

  /** The cases of a project inside the units of the reader, newest first, with the household in its masked form only. */
  async list(tx: TenantTx, filter: { projectId: string; step?: string | undefined }, units: ScopeUnits, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<EnforcementLine[]> {
    if (filter.step !== undefined && !(ENFORCEMENT_STEPS as readonly string[]).includes(filter.step)) throw invalid('step');
    assertTimestampCursor(request.after?.code);
    if (request.after !== undefined && asUuid(request.after.id) === undefined) throw invalid('cursor');
    await enterScope(tx, units);
    const rows = await tx.query<LineSql>(
      `select e.id, e.project_id, e.parcel_id, p.parcel_code, p.status as parcel_status, e.household_id, h.household_code, h.head_name, e.plan_id, e.owner_unit_id, e.authority_unit_id, e.step, e.suspended_from,
              e.started_on::text as started_on, e.decision_document_version_id, e.planned_on::text as planned_on, e.executed_on::text as executed_on, e.legal_basis, e.suspend_reason, e.created_by,
              e.version::text as version, ${timestampKey('e.created_at')} as created_at_key
         from machvon.land_enforcement_case e
         join machvon.land_parcel p on p.tenant_id = e.tenant_id and p.id = e.parcel_id
         left join machvon.affected_household h on h.tenant_id = e.tenant_id and h.id = e.household_id
        where e.project_id = $1::uuid and ($2::text is null or e.step = $2) and ($3::text is null or (${timestampKey('e.created_at')}, e.id) < ($3::text, $4::uuid))
        order by e.created_at desc, e.id desc limit $5`,
      [idOf(filter.projectId, 'project_id'), filter.step ?? null, request.after?.code ?? null, request.after?.id ?? null, Math.min(request.limit, MAX_PAGE + 1)],
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      parcel: { id: row.parcel_id, code: row.parcel_code, status: row.parcel_status },
      household: row.household_id === null || row.household_code === null ? null : { id: row.household_id, code: row.household_code, headName: row.head_name ?? '' },
      planId: row.plan_id,
      ownerUnitId: row.owner_unit_id,
      authorityUnitId: row.authority_unit_id,
      step: row.step,
      suspendedFrom: row.suspended_from,
      startedOn: row.started_on,
      decisionDocumentVersionId: row.decision_document_version_id,
      plannedOn: row.planned_on,
      executedOn: row.executed_on,
      legalBasis: row.legal_basis,
      suspendReason: row.suspend_reason,
      draftedBy: row.created_by,
      version: Number(row.version),
      createdAtKey: row.created_at_key,
    }));
  }
}
