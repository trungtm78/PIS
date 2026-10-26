import { DomainError } from '../src/errors';
import { INVENTORY_ITEM_KINDS } from '../src/land-inventory';
import {
  MAX_ITEMS_PER_COMMAND,
  PLAN_EXECUTOR_KINDS,
  PLAN_ITEM_KINDS,
  PLAN_STATUSES,
  PLAN_TOTAL_GROUPS,
  FEEDBACK_CHANNELS,
  FEEDBACK_STATUSES,
  REVISABLE_STATUSES,
  acceptsFeedback,
  acceptsFeedbackHandling,
  acceptsItems,
  canPost,
  canRevise,
  compensationKindOf,
  normalizeAmount,
  restsOnInventory,
  totalGroupOf,
  totalsOf,
} from '../src/land-plan';

describe('the plan of compensation, support and resettlement (BR-LND-05)', () => {
  it('names the executors, the states, the kinds of item and the groups of the totals', () => {
    expect(PLAN_EXECUTOR_KINDS).toEqual(['PROJECT_OWNER', 'LAND_FUND_CENTRE', 'DISTRICT_BOARD']);
    expect(PLAN_STATUSES).toEqual(['DRAFT', 'POSTING', 'POSTING_CLOSED', 'APPROVED', 'PAYING', 'COMPLETED', 'CANCELLED', 'REVISED']);
    expect(PLAN_ITEM_KINDS).toHaveLength(7);
    expect(PLAN_TOTAL_GROUPS).toEqual(['COMPENSATION', 'SUPPORT', 'RESETTLEMENT']);
    expect(MAX_ITEMS_PER_COMMAND).toBe(200);
  });

  it('puts every kind of item in one group of the totals', () => {
    expect(PLAN_ITEM_KINDS.map(totalGroupOf)).toEqual(['COMPENSATION', 'COMPENSATION', 'SUPPORT', 'SUPPORT', 'SUPPORT', 'RESETTLEMENT', 'RESETTLEMENT']);
  });

  it('rests compensation on an inventory and support and resettlement on a policy', () => {
    expect(PLAN_ITEM_KINDS.filter(restsOnInventory)).toEqual(['COMPENSATION_LAND', 'COMPENSATION_ASSET']);
  });

  it('compensates land as land and every other asset as an asset', () => {
    expect(INVENTORY_ITEM_KINDS.map(compensationKindOf)).toEqual(['COMPENSATION_LAND', 'COMPENSATION_ASSET', 'COMPENSATION_ASSET', 'COMPENSATION_ASSET', 'COMPENSATION_ASSET', 'COMPENSATION_ASSET', 'COMPENSATION_ASSET', 'COMPENSATION_ASSET']);
  });

  it('adds items to a draft and revises a plan that was posted or approved, and neither otherwise', () => {
    expect(PLAN_STATUSES.filter(acceptsItems)).toEqual(['DRAFT']);
    expect(PLAN_STATUSES.filter(canRevise)).toEqual(['POSTING', 'POSTING_CLOSED', 'APPROVED']);
    expect(REVISABLE_STATUSES).toEqual(['POSTING', 'POSTING_CLOSED', 'APPROVED']);
  });

  it('keeps an amount of whole dong and refuses anything else, naming the field', () => {
    expect(normalizeAmount(' 360000000 ', 'amount_vnd')).toBe('360000000');
    expect(normalizeAmount('0', 'amount_vnd')).toBe('0');
    for (const bad of ['-1', '1.5', '01', '', 'x', '1e3', '9'.repeat(25)]) {
      try {
        normalizeAmount(bad, 'amount_vnd');
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect([(error as DomainError).code, (error as DomainError).status, (error as DomainError).detail]).toEqual(['VALIDATION_FAILED', 422, 'amount_vnd']);
      }
    }
  });

  it('adds the items up by group, as whole numbers', () => {
    expect(
      totalsOf([
        { itemKind: 'COMPENSATION_LAND', amountVnd: '360000000' },
        { itemKind: 'COMPENSATION_ASSET', amountVnd: '3750000' },
        { itemKind: 'SUPPORT_LIVELIHOOD', amountVnd: '10000000' },
        { itemKind: 'SUPPORT_TRAINING', amountVnd: '1' },
        { itemKind: 'RESETTLEMENT_HOUSE', amountVnd: '99999999999999999999999' },
      ]),
    ).toEqual({ compensation: '363750000', support: '10000001', resettlement: '99999999999999999999999', grand: (363750000n + 10000001n + 99999999999999999999999n).toString() });
    expect(totalsOf([])).toEqual({ compensation: '0', support: '0', resettlement: '0', grand: '0' });
  });

  it('posts a draft, takes opinions while the plan is posted and handles them until it is approved', () => {
    expect(PLAN_STATUSES.filter(canPost)).toEqual(['DRAFT']);
    expect(PLAN_STATUSES.filter(acceptsFeedback)).toEqual(['POSTING']);
    expect(PLAN_STATUSES.filter(acceptsFeedbackHandling)).toEqual(['POSTING', 'POSTING_CLOSED']);
    expect(FEEDBACK_CHANNELS).toEqual(['IN_PERSON', 'LETTER', 'PORTAL', 'MEETING']);
    expect(FEEDBACK_STATUSES).toEqual(['OPEN', 'HANDLED']);
  });
});
