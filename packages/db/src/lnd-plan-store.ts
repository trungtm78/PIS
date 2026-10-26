import { randomUUID } from 'node:crypto';
import {
  DomainError,
  MAX_ITEMS_PER_COMMAND,
  PLAN_EXECUTOR_KINDS,
  PLAN_ITEM_KINDS,
  PLAN_STATUSES,
  acceptsItems,
  canRevise,
  compensationKindOf,
  normalizeAmount,
  restsOnInventory,
  totalsOf,
  versionConflict,
} from '@machvon/kernel';
import type { InventoryItemKind, PlanExecutorKind, PlanItemKind, PlanStatus, PlanTotals } from '@machvon/kernel';
import { enterScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import { LndLandSource } from './lnd-land-source.ts';
import { lowerId, textOf } from './lnd-values.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const MAX_CODE = 50;
const MAX_LEGAL_BASIS = 500;
const MAX_REASON = 2000;
const MAX_PAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NewCompensationPlan {
  projectId: string;
  sectionId?: string | undefined;
  executorUnitId: string;
  executorKind: string;
  planCode: string;
}

/** What drafting a plan did: ids and the code, which is all the audit row and the event carry. */
export interface DraftedPlan {
  id: string;
  projectId: string;
  sectionId: string | null;
  executorUnitId: string;
  executorKind: PlanExecutorKind;
  planCode: string;
  revision: number;
  status: 'DRAFT';
  version: number;
}

/** One item as the caller states it; the store judges it, reads what it rests on and writes the rest. */
export interface NewPlanItem {
  householdId: unknown;
  parcelId?: unknown;
  itemKind: unknown;
  basisInventoryId?: unknown;
  amountVnd?: unknown;
  legalBasis: unknown;
}

export interface AddedItem {
  id: string;
  householdId: string;
  itemKind: PlanItemKind;
  amountVnd: string;
  basisInventoryId: string | null;
}

export interface AddedItems {
  planId: string;
  projectId: string;
  status: PlanStatus;
  version: number;
  added: AddedItem[];
  totals: PlanTotals;
}

export interface RevisedPlan {
  previousId: string;
  id: string;
  projectId: string;
  planCode: string;
  revision: number;
  itemsCopied: number;
  totals: PlanTotals;
  /** The version of the plan that was replaced, after it was marked as replaced. */
  previousVersion: number;
}

/** A plan as the screen reads it. */
export interface CompensationPlanLine {
  id: string;
  projectId: string;
  sectionId: string | null;
  executorUnitId: string;
  executorKind: PlanExecutorKind;
  planCode: string;
  revision: number;
  supersedesId: string | null;
  revisionReason: string | null;
  totalCompensationVnd: string;
  totalSupportVnd: string;
  totalResettlementVnd: string;
  grandTotalVnd: string;
  status: PlanStatus;
  postingStartedOn: string | null;
  postingEndsOn: string | null;
  postingPlaceText: string | null;
  feedbackSummary: string | null;
  approvedOn: string | null;
  paymentDueOn: string | null;
  decisionDocumentVersionId: string | null;
  version: number;
}

/** An item as the screen reads it. What it counts is read only inside the unit of its household. */
export interface PlanItemLine {
  id: string;
  planId: string;
  householdId: string;
  householdCode: string;
  parcelId: string | null;
  parcelCode: string | null;
  ownerUnitId: string;
  itemKind: PlanItemKind;
  amountVnd: string;
  basisInventoryId: string | null;
  quantity: string | null;
  unitCode: string | null;
  unitPriceVnd: string | null;
  priceDecisionRef: string | null;
  priceDecisionRevision: number | null;
  legalBasis: string;
}

export interface CompensationPlanFilter {
  projectId: string;
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

interface PlanSql {
  id: string;
  project_id: string;
  section_id: string | null;
  executor_unit_id: string;
  executor_kind: PlanExecutorKind;
  plan_code: string;
  revision: number;
  supersedes_id: string | null;
  revision_reason: string | null;
  total_compensation_vnd: string;
  total_support_vnd: string;
  total_resettlement_vnd: string;
  grand_total_vnd: string;
  status: PlanStatus;
  posting_started_on: string | null;
  posting_ends_on: string | null;
  posting_place_text: string | null;
  feedback_summary: string | null;
  approved_on: string | null;
  payment_due_on: string | null;
  decision_document_version_id: string | null;
  version: string;
}

const PLAN_COLUMNS = `c.id, c.project_id, c.section_id, c.executor_unit_id, c.executor_kind, c.plan_code, c.revision, c.supersedes_id, c.revision_reason, c.total_compensation_vnd::text as total_compensation_vnd,
  c.total_support_vnd::text as total_support_vnd, c.total_resettlement_vnd::text as total_resettlement_vnd, c.grand_total_vnd::text as grand_total_vnd, c.status, c.posting_started_on::text as posting_started_on,
  c.posting_ends_on::text as posting_ends_on, c.posting_place_text, c.feedback_summary, c.approved_on::text as approved_on, c.payment_due_on::text as payment_due_on,
  c.decision_document_version_id, c.version::text as version`;

/** The plan with the project and the two units the scope of its project is judged by (the aliases of the project register: `p`, `ou`, `iu`). */
const PLAN_FROM = `machvon.compensation_plan c
  join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });

const toPlan = (row: PlanSql): CompensationPlanLine => ({
  id: row.id,
  projectId: row.project_id,
  sectionId: row.section_id,
  executorUnitId: row.executor_unit_id,
  executorKind: row.executor_kind,
  planCode: row.plan_code,
  revision: row.revision,
  supersedesId: row.supersedes_id,
  revisionReason: row.revision_reason,
  totalCompensationVnd: row.total_compensation_vnd,
  totalSupportVnd: row.total_support_vnd,
  totalResettlementVnd: row.total_resettlement_vnd,
  grandTotalVnd: row.grand_total_vnd,
  status: row.status,
  postingStartedOn: row.posting_started_on,
  postingEndsOn: row.posting_ends_on,
  postingPlaceText: row.posting_place_text,
  feedbackSummary: row.feedback_summary,
  approvedOn: row.approved_on,
  paymentDueOn: row.payment_due_on,
  decisionDocumentVersionId: row.decision_document_version_id,
  version: Number(row.version),
});

const idText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value.trim())) throw invalid(field);
  return lowerId(value.trim());
};

interface ParsedItem {
  householdId: string;
  parcelId: string | null;
  itemKind: PlanItemKind;
  basisInventoryId: string | null;
  amountVnd: string | null;
  legalBasis: string;
}

/**
 * The plan of compensation, support and resettlement (ST-LND-005, LND 3.3, BR-LND-05, UAT-AC382, UAT-PLAN-30). A plan is drafted for a project by an executor; items are added while it is a draft: a compensation
 * is counted from an inventory record the household confirmed (422 `INVENTORY_NOT_CONFIRMED`), so its amount is the quantity times the price of that record with the price decision it was counted by, and a
 * support or a resettlement is a policy amount with its legal basis. The totals of the plan are the sums of its items, kept by the same command that writes them. A plan that was posted or approved is not
 * edited: it is revised into a new revision, and the earlier one stays as it was read.
 */
export class LndPlanStore {
  private readonly source: LndLandSource;

  constructor(source: LndLandSource = new LndLandSource()) {
    this.source = source;
  }

  async draft(tx: TenantTx, input: NewCompensationPlan, actor: string): Promise<DraftedPlan> {
    const projectId = lowerId(input.projectId);
    const executorUnitId = lowerId(input.executorUnitId);
    const sectionId = input.sectionId === undefined ? null : lowerId(input.sectionId);
    const executorKind = PLAN_EXECUTOR_KINDS.find((candidate) => candidate === input.executorKind) ?? this.badField('executor_kind');
    const planCode = textOf(input.planCode, 'plan_code', 1, MAX_CODE);
    if (sectionId !== null && (await this.source.sectionOfProject(tx, projectId, sectionId)) === undefined) throw invalid('section_id');
    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: 'compensation_plan_rev_uq', code: 'PLAN_CODE_DUPLICATE' }, () =>
      tx.query(
        `insert into machvon.compensation_plan (tenant_id, id, project_id, section_id, executor_unit_id, executor_kind, plan_code, revision, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 1, 'DRAFT', $7::uuid, $7::uuid, 1)`,
        [id, projectId, sectionId, executorUnitId, executorKind, planCode, actor],
      ),
    );
    return { id, projectId, sectionId, executorUnitId, executorKind, planCode, revision: 1, status: 'DRAFT', version: 1 };
  }

  /** The project and the state of a plan, for whoever decides whether the caller may act on it; undefined when the tenant has no such plan. */
  async place(tx: TenantTx, id: string): Promise<{ projectId: string; status: PlanStatus; version: number } | undefined> {
    const rows = await tx.query<{ project_id: string; status: PlanStatus; version: string }>('select project_id, status, version::text as version from machvon.compensation_plan where id = $1::uuid', [lowerId(id)]);
    const row = rows[0];
    return row === undefined ? undefined : { projectId: row.project_id, status: row.status, version: Number(row.version) };
  }

  /**
   * Adds items to a plan that is a draft, under the version the caller saw (409 `VERSION_CONFLICT`, 409 `PLAN_STATE_INVALID`). All the items are added or none. The households of the items are in the scope
   * of the caller and in the project of the plan; a compensation names a CONFIRMED inventory record of its household, which is used once in the plan, and takes its amount, its parcel and the price decision from
   * that record; a support or a resettlement takes the amount the caller states. The totals of the plan grow by what was added.
   */
  async addItems(tx: TenantTx, planId: string, items: readonly NewPlanItem[], expectedVersion: number, actor: string, units: ScopeUnits): Promise<AddedItems> {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS_PER_COMMAND) throw invalid('items');
    const parsed = items.map((item, index) => this.parse(item, index));
    await enterScope(tx, units);
    const plan = (await tx.query<{ id: string; project_id: string; status: PlanStatus; version: string }>('select id, project_id, status, version::text as version from machvon.compensation_plan where id = $1::uuid for update', [lowerId(planId)]))[0];
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(plan.version) !== expectedVersion) throw versionConflict(Number(plan.version));
    if (!acceptsItems(plan.status)) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    const used = new Set<string>();
    const added: AddedItem[] = [];
    for (const [index, item] of parsed.entries()) {
      const at = (field: string): string => `items[${index}].${field}`;
      const household = (await tx.query<{ owner_unit_id: string; project_id: string }>('select owner_unit_id, project_id from machvon.affected_household where id = $1::uuid', [item.householdId]))[0];
      // A household outside the scope of the caller is not there for them.
      if (household === undefined) throw invalid(at('household_id'), 'NOT_FOUND');
      if (household.project_id !== plan.project_id) throw invalid(at('household_id'), 'NOT_IN_THE_PROJECT_OF_THE_PLAN');
      const resting = await this.resting(tx, item, plan.id, used, at);
      const id = randomUUID();
      await tx.query(
        `insert into machvon.compensation_plan_item
           (tenant_id, id, plan_id, household_id, parcel_id, owner_unit_id, item_kind, amount_vnd, basis_inventory_id, legal_basis, quantity, unit_code, unit_price_vnd, price_decision_ref,
            price_decision_version_id, price_decision_revision, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::numeric, $8::uuid, $9, $10::numeric, $11, $12::numeric, $13, $14::uuid, $15,
                 $16::uuid, $16::uuid, 1)`,
        [
          id,
          plan.id,
          item.householdId,
          resting.parcelId,
          household.owner_unit_id,
          item.itemKind,
          resting.amountVnd,
          item.basisInventoryId,
          item.legalBasis,
          resting.quantity,
          resting.unitCode,
          resting.unitPriceVnd,
          resting.priceDecisionRef,
          resting.priceDecisionVersionId,
          resting.priceDecisionRevision,
          actor,
        ],
      );
      added.push({ id, householdId: item.householdId, itemKind: item.itemKind, amountVnd: resting.amountVnd, basisInventoryId: item.basisInventoryId });
    }
    const delta = totalsOf(added.map((entry) => ({ itemKind: entry.itemKind, amountVnd: entry.amountVnd })));
    const version = Number(plan.version) + 1;
    const updated = await tx.query<{ total_compensation_vnd: string; total_support_vnd: string; total_resettlement_vnd: string }>(
      `update machvon.compensation_plan
          set total_compensation_vnd = total_compensation_vnd + $2::numeric, total_support_vnd = total_support_vnd + $3::numeric, total_resettlement_vnd = total_resettlement_vnd + $4::numeric,
              updated_at = now(), updated_by = $5::uuid, version = $6
        where id = $1::uuid
        returning total_compensation_vnd::text as total_compensation_vnd, total_support_vnd::text as total_support_vnd, total_resettlement_vnd::text as total_resettlement_vnd`,
      [plan.id, delta.compensation, delta.support, delta.resettlement, actor, version],
    );
    // The plan is locked by this transaction, so the update finds it.
    const row = updated[0] as { total_compensation_vnd: string; total_support_vnd: string; total_resettlement_vnd: string };
    // The parcels that the plan now counts are drafted into it (LND 4): a parcel that is somewhere else (objected to, posted by another plan) stays where it is.
    await tx.query('select parcels_moved from machvon.advance_plan_subjects($1::uuid, $2::uuid)', [plan.id, actor]);
    const grand = (BigInt(row.total_compensation_vnd) + BigInt(row.total_support_vnd) + BigInt(row.total_resettlement_vnd)).toString();
    return { planId: plan.id, projectId: plan.project_id, status: plan.status, version, added, totals: { compensation: row.total_compensation_vnd, support: row.total_support_vnd, resettlement: row.total_resettlement_vnd, grand } };
  }

  /**
   * Replaces a plan that was posted or approved by a new revision (409 `PLAN_STATE_INVALID` for any other state, 409 `VERSION_CONFLICT`): the new revision is a draft with the same items, it supersedes the old
   * one and says why, and the old one is marked as replaced and stays readable. A caller who does not see every item of the plan (an item of another unit) cannot copy it (403 `SCOPE_DENIED`), because a copy that
   * lost items would be a different plan.
   */
  async revise(tx: TenantTx, planId: string, reason: string, expectedVersion: number, actor: string, units: ScopeUnits): Promise<RevisedPlan> {
    const why = textOf(reason, 'reason', 1, MAX_REASON);
    await enterScope(tx, units);
    const old = (
      await tx.query<{ id: string; project_id: string; section_id: string | null; executor_unit_id: string; executor_kind: PlanExecutorKind; plan_code: string; revision: number; status: PlanStatus; version: string; t1: string; t2: string; t3: string }>(
        `select id, project_id, section_id, executor_unit_id, executor_kind, plan_code, revision, status, version::text as version, total_compensation_vnd::text as t1, total_support_vnd::text as t2,
                total_resettlement_vnd::text as t3
           from machvon.compensation_plan where id = $1::uuid for update`,
        [lowerId(planId)],
      )
    )[0];
    if (old === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(old.version) !== expectedVersion) throw versionConflict(Number(old.version));
    if (!canRevise(old.status)) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: old.status } });
    const items = await tx.query<{ household_id: string; parcel_id: string | null; owner_unit_id: string; item_kind: PlanItemKind; amount_vnd: string; basis_inventory_id: string | null; legal_basis: string; quantity: string | null; unit_code: string | null; unit_price_vnd: string | null; price_decision_ref: string | null; price_decision_version_id: string | null; price_decision_revision: number | null }>(
      `select household_id, parcel_id, owner_unit_id, item_kind, amount_vnd::text as amount_vnd, basis_inventory_id, legal_basis, quantity::text as quantity, unit_code, unit_price_vnd::text as unit_price_vnd,
              price_decision_ref, price_decision_version_id, price_decision_revision
         from machvon.compensation_plan_item where plan_id = $1::uuid order by id`,
      [old.id],
    );
    const totals = totalsOf(items.map((item) => ({ itemKind: item.item_kind, amountVnd: item.amount_vnd })));
    if (totals.compensation !== old.t1 || totals.support !== old.t2 || totals.resettlement !== old.t3) throw new DomainError('SCOPE_DENIED', 403, 'plan_id', { extensions: { reason: 'ITEMS_OUTSIDE_THE_SCOPE' } });
    // An item rests on a record that is still confirmed: a record that was replaced since cannot carry an item into a new revision, and the plan says which stand in the way.
    const stale = await tx.query<{ status: string }>(
      `select r.status from machvon.compensation_plan_item i join machvon.land_inventory_record r on r.tenant_id = i.tenant_id and r.id = i.basis_inventory_id
        where i.plan_id = $1::uuid and r.status <> 'CONFIRMED' limit 1`,
      [old.id],
    );
    if (stale[0] !== undefined) throw new DomainError('INVENTORY_NOT_CONFIRMED', 422, 'items', { extensions: { status: stale[0].status } });
    const id = randomUUID();
    const revision = old.revision + 1;
    await withUniqueClaim(tx, { constraint: 'compensation_plan_rev_uq', code: 'PLAN_STATE_INVALID' }, () =>
      tx.query(
        `insert into machvon.compensation_plan (tenant_id, id, project_id, section_id, executor_unit_id, executor_kind, plan_code, revision, supersedes_id, revision_reason, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid, $9, 'DRAFT', $10::uuid, $10::uuid, 1)`,
        [id, old.project_id, old.section_id, old.executor_unit_id, old.executor_kind, old.plan_code, revision, old.id, why, actor],
      ),
    );
    for (const item of items) {
      await tx.query(
        `insert into machvon.compensation_plan_item
           (tenant_id, id, plan_id, household_id, parcel_id, owner_unit_id, item_kind, amount_vnd, basis_inventory_id, legal_basis, quantity, unit_code, unit_price_vnd, price_decision_ref,
            price_decision_version_id, price_decision_revision, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::uuid, $8, $9::numeric, $10, $11::numeric, $12, $13::uuid, $14,
                 $15::uuid, $15::uuid, 1)`,
        [id, item.household_id, item.parcel_id, item.owner_unit_id, item.item_kind, item.amount_vnd, item.basis_inventory_id, item.legal_basis, item.quantity, item.unit_code, item.unit_price_vnd, item.price_decision_ref, item.price_decision_version_id, item.price_decision_revision, actor],
      );
    }
    await tx.query('update machvon.compensation_plan set total_compensation_vnd = $2::numeric, total_support_vnd = $3::numeric, total_resettlement_vnd = $4::numeric where id = $1::uuid', [id, totals.compensation, totals.support, totals.resettlement]);
    const previousVersion = Number(old.version) + 1;
    await tx.query("update machvon.compensation_plan set status = 'REVISED', updated_at = now(), updated_by = $2::uuid, version = $3 where id = $1::uuid", [old.id, actor, previousVersion]);
    return { previousId: old.id, id, projectId: old.project_id, planCode: old.plan_code, revision, itemsCopied: items.length, totals, previousVersion };
  }

  /** The plans of a project in the scope of the caller, the lowest code first and the newest revision first within a code. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: CompensationPlanFilter): Promise<CompensationPlanLine[]> {
    const projectId = lowerId(filter.projectId);
    if (!UUID.test(projectId)) throw invalid('project_id');
    const status = filter.status === undefined ? null : (PLAN_STATUSES.find((candidate) => candidate === filter.status) ?? this.badField('status'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    const predicate = scope(5);
    const rows = await tx.query<PlanSql>(
      `select ${PLAN_COLUMNS} from ${PLAN_FROM}
        where c.project_id = $1::uuid and ($2::text is null or c.status = $2) and ($3::text is null or (c.plan_code, c.id) > ($3::text, $4::uuid)) and ${predicate.sql}
        order by c.plan_code, c.revision desc, c.id limit ${filter.limit}`,
      [projectId, status, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toPlan);
  }

  /** The items of a plan inside the scope of the caller, by household code; an item of another unit is not there. */
  async items(tx: TenantTx, planId: string, units: ScopeUnits): Promise<PlanItemLine[]> {
    const id = lowerId(planId);
    if (!UUID.test(id)) throw invalid('plan_id');
    await enterScope(tx, units);
    const rows = await tx.query<{
      id: string;
      plan_id: string;
      household_id: string;
      household_code: string;
      parcel_id: string | null;
      parcel_code: string | null;
      owner_unit_id: string;
      item_kind: PlanItemKind;
      amount_vnd: string;
      basis_inventory_id: string | null;
      quantity: string | null;
      unit_code: string | null;
      unit_price_vnd: string | null;
      price_decision_ref: string | null;
      price_decision_revision: number | null;
      legal_basis: string;
    }>(
      `select i.id, i.plan_id, i.household_id, h.household_code, i.parcel_id, p.parcel_code, i.owner_unit_id, i.item_kind, i.amount_vnd::text as amount_vnd, i.basis_inventory_id, i.quantity::text as quantity,
              i.unit_code, i.unit_price_vnd::text as unit_price_vnd, i.price_decision_ref, i.price_decision_revision, i.legal_basis
         from machvon.compensation_plan_item i
         join machvon.affected_household h on h.tenant_id = i.tenant_id and h.id = i.household_id
         left join machvon.land_parcel p on p.tenant_id = i.tenant_id and p.id = i.parcel_id
        where i.plan_id = $1::uuid order by h.household_code, i.item_kind, i.id`,
      [id],
    );
    return rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      householdId: row.household_id,
      householdCode: row.household_code,
      parcelId: row.parcel_id,
      parcelCode: row.parcel_code,
      ownerUnitId: row.owner_unit_id,
      itemKind: row.item_kind,
      amountVnd: row.amount_vnd,
      basisInventoryId: row.basis_inventory_id,
      quantity: row.quantity,
      unitCode: row.unit_code,
      unitPriceVnd: row.unit_price_vnd,
      priceDecisionRef: row.price_decision_ref,
      priceDecisionRevision: row.price_decision_revision,
      legalBasis: row.legal_basis,
    }));
  }

  /** The shape of one item as the caller wrote it: the household, the kind, the legal basis, and what the kind needs or forbids. */
  private parse(item: NewPlanItem, index: number): ParsedItem {
    const at = (field: string): string => `items[${index}].${field}`;
    if (typeof item !== 'object' || item === null) throw invalid(`items[${index}]`);
    const kind = PLAN_ITEM_KINDS.find((candidate) => candidate === item.itemKind);
    if (kind === undefined) throw invalid(at('item_kind'));
    const householdId = idText(item.householdId, at('household_id'));
    const parcelId = item.parcelId === undefined ? null : idText(item.parcelId, at('parcel_id'));
    const legalBasis = typeof item.legalBasis === 'string' ? textOf(item.legalBasis, at('legal_basis'), 1, MAX_LEGAL_BASIS) : this.badField(at('legal_basis'));
    if (restsOnInventory(kind)) {
      const basis = idText(item.basisInventoryId, at('basis_inventory_id'));
      const amount = item.amountVnd === undefined ? null : typeof item.amountVnd === 'string' ? normalizeAmount(item.amountVnd, at('amount_vnd')) : this.badField(at('amount_vnd'));
      return { householdId, parcelId, itemKind: kind, basisInventoryId: basis, amountVnd: amount, legalBasis };
    }
    if (item.basisInventoryId !== undefined) throw invalid(at('basis_inventory_id'), 'ONLY_A_COMPENSATION_RESTS_ON_AN_INVENTORY');
    if (typeof item.amountVnd !== 'string') throw invalid(at('amount_vnd'));
    return { householdId, parcelId, itemKind: kind, basisInventoryId: null, amountVnd: normalizeAmount(item.amountVnd, at('amount_vnd')), legalBasis };
  }

  /** What an item rests on: the confirmed inventory record of a compensation (its amount, parcel and price decision), or the policy amount of a support or a resettlement. */
  private async resting(
    tx: TenantTx,
    item: ParsedItem,
    planId: string,
    used: Set<string>,
    at: (field: string) => string,
  ): Promise<{
    amountVnd: string;
    parcelId: string | null;
    quantity: string | null;
    unitCode: string | null;
    unitPriceVnd: string | null;
    priceDecisionRef: string | null;
    priceDecisionVersionId: string | null;
    priceDecisionRevision: number | null;
  }> {
    if (item.basisInventoryId === null) {
      return { amountVnd: item.amountVnd as string, parcelId: item.parcelId, quantity: null, unitCode: null, unitPriceVnd: null, priceDecisionRef: null, priceDecisionVersionId: null, priceDecisionRevision: null };
    }
    const record = (
      await tx.query<{
        household_id: string;
        parcel_id: string;
        item_kind: InventoryItemKind;
        amount_vnd: string;
        quantity: string;
        unit_code: string;
        unit_price_vnd: string;
        price_decision_ref: string;
        price_decision_version_id: string | null;
        price_decision_revision: number | null;
        status: string;
      }>(
        `select household_id, parcel_id, item_kind, amount_vnd::text as amount_vnd, quantity::text as quantity, unit_code, unit_price_vnd::text as unit_price_vnd, price_decision_ref, price_decision_version_id,
                price_decision_revision, status
           from machvon.land_inventory_record where id = $1::uuid`,
        [item.basisInventoryId],
      )
    )[0];
    if (record === undefined) throw invalid(at('basis_inventory_id'), 'NOT_FOUND');
    if (record.status !== 'CONFIRMED') throw new DomainError('INVENTORY_NOT_CONFIRMED', 422, at('basis_inventory_id'), { extensions: { status: record.status } });
    if (record.household_id !== item.householdId) throw invalid(at('basis_inventory_id'), 'NOT_A_RECORD_OF_THE_HOUSEHOLD');
    if (compensationKindOf(record.item_kind) !== item.itemKind) throw invalid(at('item_kind'), 'DOES_NOT_MATCH_THE_RECORD');
    if (item.parcelId !== null && item.parcelId !== record.parcel_id) throw invalid(at('parcel_id'), 'DOES_NOT_MATCH_THE_RECORD');
    if (item.amountVnd !== null && item.amountVnd !== record.amount_vnd) throw invalid(at('amount_vnd'), 'THE_AMOUNT_IS_THE_AMOUNT_OF_THE_RECORD');
    const key = item.basisInventoryId;
    const twice = used.has(key) || (await tx.query('select 1 from machvon.compensation_plan_item where plan_id = $1::uuid and basis_inventory_id = $2::uuid', [planId, key])).length > 0;
    if (twice) throw invalid(at('basis_inventory_id'), 'ALREADY_IN_THE_PLAN');
    used.add(key);
    return {
      amountVnd: record.amount_vnd,
      parcelId: record.parcel_id,
      quantity: record.quantity,
      unitCode: record.unit_code,
      unitPriceVnd: record.unit_price_vnd,
      priceDecisionRef: record.price_decision_ref,
      priceDecisionVersionId: record.price_decision_version_id,
      priceDecisionRevision: record.price_decision_revision,
    };
  }

  private badField(field: string): never {
    throw invalid(field);
  }
}
