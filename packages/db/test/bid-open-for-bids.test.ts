import { PACKAGE_STATUSES_OPEN_FOR_BIDS, isOpenForBids } from '../src/bid-proposal-store';

describe('the packages that take proposals and results', () => {
  it('are the packages of an approved plan: PLANNED (what approving a plan gives them) and APPROVED (given before)', () => {
    expect([...PACKAGE_STATUSES_OPEN_FOR_BIDS].sort()).toEqual(['APPROVED', 'PLANNED']);
    expect(isOpenForBids('PLANNED')).toBe(true);
    expect(isOpenForBids('APPROVED')).toBe(true);
  });

  it('are not the packages of a plan that is not in force, or that were awarded', () => {
    for (const status of ['DRAFT', 'IN_REVIEW', 'SUPERSEDED', 'CANCELLED', 'AWARDED']) expect(isOpenForBids(status)).toBe(false);
  });
});
