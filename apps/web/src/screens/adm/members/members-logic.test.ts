import { describe, expect, it } from 'vitest';
import { contractsProblem, emailProblem, guestMaxUntil, guestValidUntilProblem, isoOf, localInputOf, nameProblem, reasonProblem, staffValidUntilProblem } from './rules';
import { GUEST_CONTRACT_STATUSES, lifecycleOptions, toContractOption, toMember, toMemberPage, toSeatUsage, toUnitOption } from './types';
import type { ContractOption } from './types';

const NOW = new Date('2026-10-23T09:00:00Z');
const DAY = 86_400_000;
const contract = (completionDue: string | null): ContractOption => ({ id: 'c', code: 'C', status: 'ACTIVE', contractorId: 'k', contractorName: 'K', completionDue });

describe('field rules', () => {
  it('judges an email, a name and a reason', () => {
    expect(emailProblem('')).toBe('required');
    expect(emailProblem('  ')).toBe('required');
    expect(emailProblem('no-at')).toBe('email');
    expect(emailProblem(`${'a'.repeat(250)}@example.test`)).toBe('email');
    expect(emailProblem(' a@example.test ')).toBeUndefined();
    expect(nameProblem('x'.repeat(121))).toBe('tooLong');
    expect(nameProblem('Name')).toBeUndefined();
    expect(reasonProblem('')).toBe('required');
    expect(reasonProblem('short')).toBe('tooShort');
    expect(reasonProblem('x'.repeat(2001))).toBe('tooLong');
    expect(reasonProblem('long enough reason')).toBeUndefined();
  });

  it('reads a datetime-local value as an instant and writes one back', () => {
    expect(isoOf('')).toBeUndefined();
    expect(isoOf('nonsense')).toBeUndefined();
    expect(isoOf('2027-01-01T10:00')).toBe(new Date('2027-01-01T10:00').toISOString());
    expect(localInputOf(new Date('2027-01-01T10:00'))).toBe('2027-01-01T10:00');
  });

  it('allows no end for staff and refuses a past or unreadable one', () => {
    expect(staffValidUntilProblem('', NOW)).toBeUndefined();
    expect(staffValidUntilProblem('x', NOW)).toBe('date');
    expect(staffValidUntilProblem('2020-01-01T00:00', NOW)).toBe('past');
    expect(staffValidUntilProblem('2030-01-01T00:00', NOW)).toBeUndefined();
  });

  it('bounds a guest by 365 days after the latest contract completion, counted from today when there is none or it has passed', () => {
    expect(guestMaxUntil([contract('2027-03-31')], NOW).getTime()).toBe(Date.parse('2027-03-31T00:00:00Z') + 365 * DAY);
    expect(guestMaxUntil([contract('2027-03-31'), contract('2027-06-30')], NOW).getTime()).toBe(Date.parse('2027-06-30T00:00:00Z') + 365 * DAY);
    expect(guestMaxUntil([contract(null)], NOW).getTime()).toBe(NOW.getTime() + 365 * DAY);
    expect(guestMaxUntil([contract('2026-01-01')], NOW).getTime()).toBe(NOW.getTime() + 365 * DAY);
    expect(guestMaxUntil([], NOW).getTime()).toBe(NOW.getTime() + 365 * DAY);
  });

  it('requires the end of a guest and keeps it in the future and inside the bound', () => {
    const chosen = [contract('2026-12-31')];
    expect(guestValidUntilProblem('', chosen, NOW)).toBe('required');
    expect(guestValidUntilProblem('x', chosen, NOW)).toBe('date');
    expect(guestValidUntilProblem('2026-01-01T00:00', chosen, NOW)).toBe('past');
    expect(guestValidUntilProblem('2028-06-01T00:00', chosen, NOW)).toBe('beyond');
    expect(guestValidUntilProblem('2027-06-01T00:00', chosen, NOW)).toBeUndefined();
  });

  it('wants at least one and at most fifty contracts', () => {
    expect(contractsProblem([])).toBe('required');
    expect(contractsProblem(Array.from({ length: 51 }, (_, index) => String(index)))).toBe('tooLong');
    expect(contractsProblem(['a'])).toBeUndefined();
  });
});

describe('what the directory returns', () => {
  it('reads a membership with its details and survives a malformed row', () => {
    expect(
      toMember({
        id: 'm',
        display_name: 'N',
        email: 'e',
        status: 'Suspended',
        organization_id: 'u',
        membership_type: 'GUEST_CONTRACTOR',
        valid_until: '2027-01-01T00:00:00Z',
        version: 4,
        role_codes: ['A', 7],
        invitation_status: 'Pending',
        contractor_id: 'k',
        contractor_name: 'K',
        contracts: [{ id: 'c1', code: 'C1' }, { code: 'no id' }, 'bad'],
      }),
    ).toEqual({
      id: 'm',
      displayName: 'N',
      email: 'e',
      status: 'Suspended',
      organizationId: 'u',
      membershipType: 'GUEST_CONTRACTOR',
      validUntil: '2027-01-01T00:00:00Z',
      version: 4,
      roleCodes: ['A'],
      invitationStatus: 'Pending',
      contractorId: 'k',
      contractorName: 'K',
      contracts: [{ id: 'c1', code: 'C1' }],
    });
    expect(toMember(null)).toMatchObject({ id: '', status: 'Invited', membershipType: 'STAFF', roleCodes: [], contracts: [], invitationStatus: null, version: 0 });
    expect(toMemberPage({ items: [{ id: 'a' }], next_cursor: 'n' })).toMatchObject({ nextCursor: 'n' });
    expect(toMemberPage('x')).toEqual({ items: [], nextCursor: undefined });
  });

  it('reads units and contracts, dropping rows without an id', () => {
    expect(toUnitOption({ id: 'u', code: 'C', name: 'N' })).toEqual([{ id: 'u', code: 'C', name: 'N' }]);
    expect(toUnitOption({ code: 'C' })).toEqual([]);
    expect(toContractOption({ id: 'c', code: 'GC', status: 'ACTIVE', contractor_id: 'k', contractor_name: '', completion_due: null })).toEqual([
      { id: 'c', code: 'GC', status: 'ACTIVE', contractorId: 'k', contractorName: 'k', completionDue: null },
    ]);
    expect(toContractOption({ id: 'c' })).toEqual([]);
  });

  it('offers a lifecycle command only where the server accepts it', () => {
    expect(lifecycleOptions('Active')).toEqual(['suspend', 'end']);
    expect(lifecycleOptions('Suspended')).toEqual(['reactivate', 'end']);
    expect(lifecycleOptions('Invited')).toEqual(['end']);
    expect(lifecycleOptions('Ended')).toEqual([]);
    expect(lifecycleOptions('Expired')).toEqual([]);
    expect(GUEST_CONTRACT_STATUSES).toEqual(['SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED']);
  });
});

describe('what the server says about a member and the seats', () => {
  it('reads whether the lifecycle commands are open to the reader, and nothing when the server says nothing', () => {
    expect(toMember({ can_manage: false }).canManage).toBe(false);
    expect(toMember({ can_manage: true }).canManage).toBe(true);
    expect(toMember({ can_manage: 'yes' }).canManage).toBeUndefined();
    expect(toMember(null).canManage).toBeUndefined();
  });

  it('reads the seats used out of their limit, with no limit when nothing caps them', () => {
    expect(toSeatUsage({ seats: { used: 3, limit: 5 }, guest_seats: { used: 1 } })).toEqual({ staff: { used: 3, limit: 5 }, guests: { used: 1, limit: undefined } });
    expect(toSeatUsage(null)).toEqual({ staff: { used: 0, limit: undefined }, guests: { used: 0, limit: undefined } });
  });
});
