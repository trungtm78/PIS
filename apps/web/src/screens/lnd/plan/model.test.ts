import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { planItemRecord, planRecord } from '../test-support';
import {
  EMPTY_DRAFT_FORM,
  EMPTY_ITEM_FORM,
  REVISABLE_STATUSES,
  acceptsItems,
  canRevise,
  canWritePlan,
  compensationKindOf,
  describeProblem,
  draftBody,
  itemBody,
  plansOf,
  restsOnInventory,
  toPlanItem,
  toPlanLine,
  validateDraft,
  validateItem,
  validateRevise,
} from './model';
import type { DraftForm, ItemForm, PlanLine } from './model';

const UNIT = '00000000-0000-4000-8000-000200000001';
const problem = (code: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {} });
const plan = (overrides: Record<string, unknown> = {}): PlanLine => toPlanLine(planRecord(1, overrides)) as PlanLine;

describe('toPlanLine and toPlanItem', () => {
  it('reads a plan of the list with the totals as the server wrote them', () => {
    expect(plan({ total_compensation_vnd: '360000000', total_support_vnd: '1', grand_total_vnd: '360000001', revision: 2, supersedes_id: 'x', revision_reason: 'why' })).toMatchObject({
      planCode: 'PA-0001',
      revision: 2,
      supersedesId: 'x',
      revisionReason: 'why',
      totalCompensationVnd: '360000000',
      totalSupportVnd: '1',
      totalResettlementVnd: '0',
      grandTotalVnd: '360000001',
      status: 'DRAFT',
      executorKind: 'LAND_FUND_CENTRE',
      version: 1,
    });
    expect(plan({ supersedes_id: undefined, revision_reason: 5 })).toMatchObject({ supersedesId: null, revisionReason: null });
  });

  it('drops a plan it cannot read rather than showing it half', () => {
    expect(toPlanLine(null)).toBeUndefined();
    for (const field of ['id', 'project_id', 'executor_unit_id', 'plan_code', 'revision', 'total_compensation_vnd', 'total_support_vnd', 'total_resettlement_vnd', 'grand_total_vnd', 'version']) {
      expect(toPlanLine(planRecord(1, { [field]: undefined }))).toBeUndefined();
    }
    expect(toPlanLine(planRecord(1, { executor_kind: 'NOBODY' }))).toBeUndefined();
    expect(toPlanLine(planRecord(1, { status: 'GONE' }))).toBeUndefined();
  });

  it('reads an item with what it counts, or without when it rests on a policy', () => {
    expect(toPlanItem(planItemRecord(1, 'p', { item_kind: 'COMPENSATION_ASSET', quantity: '80.000000', unit_code: 'M2', unit_price_vnd: '4500000', price_decision_ref: 'QD', price_decision_revision: 1, parcel_code: 'TB-1', basis_inventory_id: 'b' }))).toMatchObject({
      householdCode: 'HH-000001',
      itemKind: 'COMPENSATION_ASSET',
      amountVnd: '10000000',
      quantity: '80.000000',
      unitCode: 'M2',
      unitPriceVnd: '4500000',
      priceDecisionRef: 'QD',
      priceDecisionRevision: 1,
      parcelCode: 'TB-1',
      basisInventoryId: 'b',
    });
    expect(toPlanItem(planItemRecord(1, 'p'))).toMatchObject({ parcelCode: null, basisInventoryId: null, quantity: null, priceDecisionRef: null, priceDecisionRevision: null });
    expect(toPlanItem(null)).toBeUndefined();
    for (const field of ['id', 'household_id', 'household_code', 'amount_vnd', 'legal_basis']) expect(toPlanItem(planItemRecord(1, 'p', { [field]: undefined }))).toBeUndefined();
    expect(toPlanItem(planItemRecord(1, 'p', { item_kind: 'SPACESHIP' }))).toBeUndefined();
  });
});

describe('what can be done to a plan', () => {
  it('lets whoever holds land.plan.write write, unless the session is read-only', () => {
    expect(canWritePlan(['land.plan.write'], 'FULL')).toBe(true);
    expect(canWritePlan(undefined, undefined)).toBe(true);
    expect(canWritePlan(['land.plan.write'], 'READ_ONLY')).toBe(false);
    expect(canWritePlan(['land.read'], 'FULL')).toBe(false);
  });

  it('adds items to a draft and revises a plan that was posted, closed or approved, and nothing else', () => {
    const states = ['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED', 'PAYING', 'COMPLETED', 'CANCELLED', 'REVISED'];
    expect(states.filter((status) => acceptsItems(plan({ status })))).toEqual(['DRAFT']);
    expect(states.filter((status) => canRevise(plan({ status })))).toEqual(['POSTING', 'POSTING_CLOSED', 'APPROVED']);
    expect(REVISABLE_STATUSES).toEqual(['POSTING', 'POSTING_CLOSED', 'APPROVED']);
  });

  it('rests a compensation on an inventory and nothing else', () => {
    expect(['COMPENSATION_LAND', 'COMPENSATION_ASSET', 'SUPPORT_TRAINING', 'RESETTLEMENT_HOUSE'].map((kind) => restsOnInventory(kind as never))).toEqual([true, true, false, false]);
    expect(compensationKindOf('LAND')).toBe('COMPENSATION_LAND');
    expect(['HOUSE', 'TREE', 'OTHER'].map(compensationKindOf)).toEqual(['COMPENSATION_ASSET', 'COMPENSATION_ASSET', 'COMPENSATION_ASSET']);
  });

  it('keeps the plans of a status in the order of the read, or all of them', () => {
    const plans = [plan({ id: 'a', status: 'DRAFT' }), plan({ id: 'b', status: 'REVISED' }), plan({ id: 'c', status: 'DRAFT' })];
    expect(plansOf(plans, '').map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(plansOf(plans, 'DRAFT').map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(plansOf(plans, 'APPROVED')).toEqual([]);
  });
});

describe('validateDraft and draftBody', () => {
  const filled = (overrides: Partial<DraftForm> = {}): DraftForm => ({ executorUnitId: UNIT, executorKind: 'LAND_FUND_CENTRE', planCode: 'PA-1', ...overrides });

  it('asks for the code, the executor and its kind', () => {
    expect(validateDraft(EMPTY_DRAFT_FORM)).toEqual({ executorUnitId: 'required', executorKind: 'required', planCode: 'required' });
    expect(validateDraft(filled())).toEqual({});
    expect(validateDraft(filled({ planCode: 'x'.repeat(51) })).planCode).toBe('tooLong');
    expect(validateDraft(filled({ planCode: 'a\u0007b' })).planCode).toBe('invalid');
    expect(validateDraft(filled({ planCode: 'x'.repeat(50) }))).toEqual({});
  });

  it('sends the code without its spaces', () => {
    expect(draftBody('p', filled({ planCode: ' PA-1 ' }))).toEqual({ project_id: 'p', executor_unit_id: UNIT, executor_kind: 'LAND_FUND_CENTRE', plan_code: 'PA-1' });
  });
});

describe('validateItem and itemBody', () => {
  const compensation = (overrides: Partial<ItemForm> = {}): ItemForm => ({ householdId: 'h', itemKind: 'COMPENSATION_ASSET', basisInventoryId: 'b', amountVnd: '', legalBasis: 'Luật Đất đai 2024', ...overrides });
  const policy = (overrides: Partial<ItemForm> = {}): ItemForm => ({ householdId: 'h', itemKind: 'SUPPORT_TRAINING', basisInventoryId: '', amountVnd: '2500000', legalBasis: 'Nghị định 88', ...overrides });

  it('asks for the household, the kind and the legal basis, and then what the kind rests on', () => {
    expect(validateItem(EMPTY_ITEM_FORM)).toEqual({ householdId: 'required', itemKind: 'required', legalBasis: 'required' });
    expect(validateItem(compensation())).toEqual({});
    expect(validateItem(compensation({ basisInventoryId: '' }))).toEqual({ basisInventoryId: 'required' });
    expect(validateItem(policy())).toEqual({});
    expect(validateItem(policy({ amountVnd: '' }))).toEqual({ amountVnd: 'required' });
  });

  it('wants an amount of whole dong for a policy and a legal basis that is text of a fit length', () => {
    for (const amountVnd of ['-1', '1.5', '01', 'x', '9'.repeat(25)]) expect(validateItem(policy({ amountVnd })).amountVnd).toBe('invalid');
    for (const amountVnd of ['0', '1', ' 2500000 ']) expect(validateItem(policy({ amountVnd })).amountVnd).toBeUndefined();
    expect(validateItem(policy({ legalBasis: 'x'.repeat(501) })).legalBasis).toBe('tooLong');
    expect(validateItem(policy({ legalBasis: 'a\u0001' })).legalBasis).toBe('invalid');
    expect(validateItem(policy({ legalBasis: '   ' })).legalBasis).toBe('required');
  });

  it('sends the record of a compensation and the amount of a policy, and never the other', () => {
    expect(itemBody(compensation({ legalBasis: ' Luật ' }))).toEqual({ household_id: 'h', item_kind: 'COMPENSATION_ASSET', legal_basis: 'Luật', basis_inventory_id: 'b' });
    expect(itemBody(policy({ amountVnd: ' 2500000 ' }))).toEqual({ household_id: 'h', item_kind: 'SUPPORT_TRAINING', legal_basis: 'Nghị định 88', amount_vnd: '2500000' });
  });
});

describe('validateRevise', () => {
  it('wants a reason in words', () => {
    expect(validateRevise({ reason: '' })).toEqual({ reason: 'required' });
    expect(validateRevise({ reason: '   ' })).toEqual({ reason: 'required' });
    expect(validateRevise({ reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
    expect(validateRevise({ reason: 'a\u0007b' })).toEqual({ reason: 'invalid' });
    expect(validateRevise({ reason: 'Giá đất thay đổi' })).toEqual({});
  });
});

describe('describeProblem', () => {
  it('names the refusals that have their own sentence', () => {
    expect(describeProblem(problem('PLAN_CODE_DUPLICATE'))).toBe('codeDuplicate');
    expect(describeProblem(problem('PLAN_STATE_INVALID'))).toBe('stateInvalid');
    expect(describeProblem(problem('INVENTORY_NOT_CONFIRMED'))).toBe('notConfirmed');
    expect(describeProblem(problem('VERSION_CONFLICT'))).toBe('versionConflict');
    expect(describeProblem(problem('SCOPE_DENIED'))).toBe('scopeDenied');
    expect(describeProblem(problem('VALIDATION_FAILED'))).toBe('validation');
    expect(describeProblem(problem('INVALID_REQUEST'))).toBe('validation');
    expect(describeProblem(problem('FIELD_NOT_ALLOWED'))).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND'))).toBe('notFound');
  });

  it('says the general sentence for anything else', () => {
    expect(describeProblem(problem('SOMETHING_ELSE'))).toBe('general');
    expect(describeProblem(new Error('x'))).toBe('general');
  });
});
