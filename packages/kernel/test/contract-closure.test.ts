import type { DomainError } from '../src/errors';
import { CLOSURE_GUARDS, assertContractClosure, unmetClosureGuards } from '../src/contract-closure';
import type { ClosureFacts } from '../src/contract-closure';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const facts = (overrides: Partial<ClosureFacts> = {}): ClosureFacts => ({
  settlement: { status: 'CLOSED', excepted: false },
  advanceOutstandingVnd: '0',
  retention: { holds: 0, unresolvedVnd: '0' },
  ...overrides,
});

describe('the closure of a contract (ST-CTR-012, UAT-AC300)', () => {
  it('lists the guards in the order they are told', () => {
    expect(CLOSURE_GUARDS).toEqual(['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED']);
  });

  it('closes a contract whose settlement is closed, with no advance owed and no retention unresolved', () => {
    expect(unmetClosureGuards(facts())).toEqual([]);
    expect(() => assertContractClosure(facts())).not.toThrow();
  });

  it('AC-ST-CTR-012-1, UAT-AC300: wants the settlement closed: none, or one that is not closed, is the first guard', () => {
    expect(unmetClosureGuards(facts({ settlement: undefined }))).toEqual(['SETTLEMENT_NOT_CLOSED']);
    for (const status of ['DRAFT', 'SUBMITTED', 'VERIFIED', 'RETURNED']) expect(unmetClosureGuards(facts({ settlement: { status, excepted: false } }))).toEqual(['SETTLEMENT_NOT_CLOSED']);
    expect(failure(() => assertContractClosure(facts({ settlement: { status: 'VERIFIED', excepted: false } })))).toMatchObject({
      code: 'SETTLEMENT_NOT_CLOSED',
      status: 422,
      extensions: { settlement_status: 'VERIFIED', unmet: ['SETTLEMENT_NOT_CLOSED'] },
    });
    expect(failure(() => assertContractClosure(facts({ settlement: undefined }))).extensions).toMatchObject({ settlement_status: null });
  });

  it('AC-ST-CTR-012-1, UAT-AC300: wants no advance owed, unless the settlement closed with an exception approved for it', () => {
    expect(unmetClosureGuards(facts({ advanceOutstandingVnd: '1250000000' }))).toEqual(['ADVANCE_OUTSTANDING']);
    expect(unmetClosureGuards(facts({ advanceOutstandingVnd: '1250000000', settlement: { status: 'CLOSED', excepted: true } }))).toEqual([]);
    expect(unmetClosureGuards(facts({ advanceOutstandingVnd: '1' }))).toEqual(['ADVANCE_OUTSTANDING']);
    // An exception on a settlement that is not closed carries nothing.
    expect(unmetClosureGuards(facts({ advanceOutstandingVnd: '1250000000', settlement: { status: 'VERIFIED', excepted: true } }))).toEqual(['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING']);
    expect(failure(() => assertContractClosure(facts({ advanceOutstandingVnd: '1250000000' })))).toMatchObject({
      code: 'ADVANCE_OUTSTANDING',
      status: 422,
      extensions: { advance_outstanding_vnd: '1250000000', unmet: ['ADVANCE_OUTSTANDING'] },
    });
  });

  it('AC-ST-CTR-012-1, UAT-AC300: wants the retention resolved: any hold with something still held that nothing carries is the last guard', () => {
    expect(unmetClosureGuards(facts({ retention: { holds: 2, unresolvedVnd: '150000000' } }))).toEqual(['RETENTION_UNRESOLVED']);
    expect(failure(() => assertContractClosure(facts({ retention: { holds: 2, unresolvedVnd: '150000000' } })))).toMatchObject({
      code: 'RETENTION_UNRESOLVED',
      status: 422,
      extensions: { retention_holds: 2, retention_unresolved_vnd: '150000000', unmet: ['RETENTION_UNRESOLVED'] },
    });
  });

  it('refuses with the first guard that is not met and lists all of them', () => {
    const everything = facts({ settlement: undefined, advanceOutstandingVnd: '1250000000', retention: { holds: 1, unresolvedVnd: '100000000' } });
    expect(unmetClosureGuards(everything)).toEqual(['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED']);
    expect(failure(() => assertContractClosure(everything))).toMatchObject({
      code: 'SETTLEMENT_NOT_CLOSED',
      extensions: { unmet: ['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED'] },
    });
  });
});
