import { describe, expect, it } from 'vitest';
import { chainOf, EMPTY_RENEW_VALUES, licenseRenewable, renewBody, renewalStart, validateRenewForm } from './renew';
import { toLicense } from './types';

const NOW = new Date('2027-08-01T03:00:00Z');
const current = toLicense({ id: 'a', tenant_id: 't', serial: 'LIC-1', revision: 1, status: 'Active', valid_from: '2026-10-01T00:00:00.000Z', valid_until: '2027-10-01T00:00:00.000Z', grace_until: '2027-10-31T00:00:00.000Z', version: 3 });
const values = (overrides: Partial<typeof EMPTY_RENEW_VALUES> = {}) => ({ valid_until: '2028-10-01', grace_until: '2028-10-31', seats: '', ...overrides });

describe('the renewal of a license (SAS-14, ST-SAS-014)', () => {
  it('accepts a term that ends later than the current one with a grace period that does not end before it', () => {
    expect(validateRenewForm(values(), current, NOW)).toEqual({});
    expect(validateRenewForm(values({ grace_until: '2028-10-01', seats: ' 75 ' }), current, NOW)).toEqual({});
  });

  it('asks both dates, refuses a day that does not exist, an end that is not later than the current end or not in the future, and a grace period that ends before the term', () => {
    expect(validateRenewForm(EMPTY_RENEW_VALUES, current, NOW)).toEqual({ valid_until: 'required', grace_until: 'required' });
    expect(validateRenewForm(values({ valid_until: '2028-02-30' }), current, NOW)).toEqual({ valid_until: 'date' });
    expect(validateRenewForm(values({ grace_until: 'soon' }), current, NOW)).toEqual({ grace_until: 'date' });
    expect(validateRenewForm(values({ valid_until: '2027-10-01' }), current, NOW)).toEqual({ valid_until: 'notLater' });
    expect(validateRenewForm(values({ valid_until: '2027-09-01' }), current, NOW)).toEqual({ valid_until: 'notLater' });
    const old = toLicense({ ...current, valid_until: '2026-01-01T00:00:00.000Z' });
    expect(validateRenewForm(values({ valid_until: '2027-05-01', grace_until: '2027-06-01' }), old, NOW)).toEqual({ valid_until: 'past' });
    expect(validateRenewForm(values({ grace_until: '2028-09-30' }), current, NOW)).toEqual({ grace_until: 'grace' });
  });

  it('refuses seats that are not a whole number of at least one', () => {
    for (const seats of ['0', '-3', '1.5', 'many']) expect(validateRenewForm(values({ seats }), current, NOW)).toEqual({ seats: 'seats' });
  });

  it('builds the body: days at the start of the day in UTC, the reason trimmed and the seats only when typed', () => {
    expect(renewBody(values(), '  The agency extended the contract.  ')).toEqual({ valid_until: '2028-10-01T00:00:00.000Z', grace_until: '2028-10-31T00:00:00.000Z', reason: 'The agency extended the contract.' });
    expect(renewBody(values({ seats: ' 75 ' }), 'The agency extended the contract.')).toMatchObject({ seats: 75 });
  });

  it('renews only a revision that is not started, in force or in grace, for someone who manages licenses', () => {
    for (const status of ['Scheduled', 'Active', 'Grace']) expect(licenseRenewable(status, true)).toBe(true);
    for (const status of ['Draft', 'Expired', 'Suspended', 'Revoked', 'Superseded']) expect(licenseRenewable(status, true)).toBe(false);
    expect(licenseRenewable('Active', false)).toBe(false);
  });

  it('starts the new revision at the earlier of now and the end of the current one', () => {
    expect(renewalStart(current, NOW)).toBe('2027-08-01T03:00:00.000Z');
    expect(renewalStart(current, new Date('2027-10-10T00:00:00Z'))).toBe('2027-10-01T00:00:00.000Z');
    expect(renewalStart(toLicense({ ...current, valid_until: 'unreadable' }), NOW)).toBe('2027-08-01T03:00:00.000Z');
  });

  it('orders the chain by serial and revision and marks the revision in force', () => {
    const chain = chainOf([
      toLicense({ id: 'c', serial: 'LIC-1', revision: 2, status: 'Active' }),
      toLicense({ id: 'a', serial: 'LIC-1', revision: 1, status: 'Superseded' }),
      toLicense({ id: 'b', serial: 'LIC-0', revision: 1, status: 'Revoked' }),
      toLicense({ id: 'd', serial: 'LIC-2', revision: 1, status: 'Suspended' }),
    ]);
    expect(chain.map(({ license, current: inForce }) => [license.id, inForce])).toEqual([
      ['b', false],
      ['a', false],
      ['c', true],
      ['d', true],
    ]);
  });
});
