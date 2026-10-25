import {
  CONTRACT_COMMANDS,
  CONTRACT_STATUSES,
  CONTRACT_TRANSITIONS,
  GUARANTEE_EXEMPT_CATEGORIES,
  PERMIT_GATED_CATEGORIES,
  SIGNED_STATUSES,
  assertContractTransition,
  assertNotMaker,
  contractTransition,
  isMakerOf,
  requiresPerformanceGuarantee,
  requiresPermitGate,
  signingConflict,
  withinDelegation,
} from '../src/contract-lifecycle';
import type { ContractCommand, ContractStatus } from '../src/contract-lifecycle';
import type { EffectiveAccess, GrantView } from '../src/effective-access';

const NOW = new Date('2026-10-25T03:00:00Z');
const PLACE = { ownerUnitId: 'u2', ownerUnitPath: '/u1/u2/', projectId: 'p1', contractId: 'c1' };
const grant = (overrides: Partial<GrantView> = {}): GrantView => ({
  roleCode: 'LEADER',
  rank: 50,
  permissions: ['contract.sign'],
  scope: { kind: 'TENANT' },
  status: 'Active',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveUntil: null,
  ...overrides,
});
const access = (...grants: GrantView[]): EffectiveAccess => ({ membershipId: 'm', scopeVersion: 1, membershipActive: true, grants });

/** The table of CTR section 4, written out: the commands that apply to each status. */
const VALID: ReadonlyArray<readonly [ContractCommand, ContractStatus, ContractStatus]> = [
  ['submitContractForReview', 'DRAFT', 'IN_REVIEW'],
  ['returnContractDraft', 'IN_REVIEW', 'DRAFT'],
  ['recordContractSigning', 'IN_REVIEW', 'SIGNED'],
  ['activateContract', 'SIGNED', 'ACTIVE'],
  ['suspendContract', 'ACTIVE', 'SUSPENDED'],
  ['resumeContract', 'SUSPENDED', 'ACTIVE'],
  ['terminateContract', 'SIGNED', 'TERMINATED'],
  ['terminateContract', 'ACTIVE', 'TERMINATED'],
  ['terminateContract', 'SUSPENDED', 'TERMINATED'],
  ['completeContract', 'ACTIVE', 'COMPLETED'],
  ['closeContract', 'COMPLETED', 'CLOSED'],
  ['closeContract', 'TERMINATED', 'CLOSED'],
  ['cancelContractDraft', 'DRAFT', 'CANCELLED'],
  ['cancelContractDraft', 'IN_REVIEW', 'CANCELLED'],
];

describe('the life of a contract (ST-CTR-004, CTR section 4)', () => {
  it('names the nine statuses and the ten commands of the table', () => {
    expect(CONTRACT_STATUSES).toHaveLength(9);
    expect(CONTRACT_COMMANDS).toHaveLength(10);
    expect(Object.keys(CONTRACT_TRANSITIONS).sort()).toEqual([...CONTRACT_COMMANDS].sort());
  });

  it('AC-ST-CTR-004-4, UAT-AC300: allows exactly the fourteen edges of the table, whatever the command, and nothing else', () => {
    const allowed: string[] = [];
    for (const command of CONTRACT_COMMANDS) for (const from of CONTRACT_STATUSES) if (contractTransition(command, from) !== undefined) allowed.push(`${command}:${from}:${contractTransition(command, from)}`);
    expect(allowed.sort()).toEqual(VALID.map(([command, from, to]) => `${command}:${from}:${to}`).sort());
    // Ten commands, nine statuses: ninety pairs, fourteen valid.
    expect(CONTRACT_COMMANDS.length * CONTRACT_STATUSES.length - allowed.length).toBe(76);
  });

  it('says CONTRACT_STATE_INVALID with the status and the command for every other pair, and never leaves a closed or cancelled contract', () => {
    for (const command of CONTRACT_COMMANDS) {
      for (const from of CONTRACT_STATUSES) {
        const wanted = VALID.find(([c, f]) => c === command && f === from)?.[2];
        if (wanted !== undefined) {
          expect(assertContractTransition(command, from)).toBe(wanted);
        } else {
          expect(() => assertContractTransition(command, from)).toThrow(expect.objectContaining({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: from, command } }));
        }
      }
    }
    for (const command of CONTRACT_COMMANDS) {
      expect(contractTransition(command, 'CLOSED')).toBeUndefined();
      expect(contractTransition(command, 'CANCELLED')).toBeUndefined();
    }
    expect(contractTransition('activateContract', 'TERMINATED')).toBeUndefined();
    expect(contractTransition('completeContract', 'SUSPENDED')).toBeUndefined();
    expect(contractTransition('completeContract', 'SIGNED')).toBeUndefined();
  });

  it('counts a contract as signed from SIGNED on, in every status but the draft ones and CANCELLED', () => {
    expect([...SIGNED_STATUSES].sort()).toEqual(['ACTIVE', 'CLOSED', 'COMPLETED', 'SIGNED', 'SUSPENDED', 'TERMINATED']);
  });

  describe('what activation needs', () => {
    it('gates a building contract on the permits and exempts the others', () => {
      expect(PERMIT_GATED_CATEGORIES).toEqual(['CONSTRUCTION', 'EPC']);
      expect(requiresPermitGate('CONSTRUCTION')).toBe(true);
      expect(requiresPermitGate('EPC')).toBe(true);
      for (const category of ['EQUIPMENT', 'CONSULTING', 'LAND_CLEARANCE', 'OTHER']) expect(requiresPermitGate(category)).toBe(false);
    });

    it('asks a performance guarantee of every contract but land clearance and consulting', () => {
      expect(GUARANTEE_EXEMPT_CATEGORIES).toEqual(['CONSULTING', 'LAND_CLEARANCE']);
      for (const category of ['CONSTRUCTION', 'EPC', 'EQUIPMENT', 'OTHER']) expect(requiresPerformanceGuarantee(category)).toBe(true);
      for (const category of ['CONSULTING', 'LAND_CLEARANCE']) expect(requiresPerformanceGuarantee(category)).toBe(false);
    });
  });

  describe('maker and checker (BR-CTR-15)', () => {
    const actors = { createdBy: 'AAAA', submittedBy: 'bbbb' };

    it('takes the one who drafted and the one who sent it to review for makers, whatever the case of the identifier', () => {
      expect(isMakerOf('aaaa', actors)).toBe(true);
      expect(isMakerOf('BBBB', actors)).toBe(true);
      expect(isMakerOf('cccc', actors)).toBe(false);
      expect(isMakerOf('cccc', { createdBy: null, submittedBy: null })).toBe(false);
    });

    it('AC-ST-CTR-004-3, UAT-AC317: refuses a maker who approves their own work with 403 SELF_APPROVAL_DENIED', () => {
      expect(() => assertNotMaker('aaaa', actors)).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED', status: 403 }));
      expect(() => assertNotMaker('bbbb', actors)).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
      expect(() => assertNotMaker('cccc', actors)).not.toThrow();
    });
  });

  describe('the delegation limit of the matrix', () => {
    it('lets a grant sign when its rank reaches the band of the contract and its scope contains the place', () => {
      expect(withinDelegation(access(grant()), NOW, 'contract.sign', PLACE, 50)).toBe(true);
      expect(withinDelegation(access(grant({ rank: 60 })), NOW, 'contract.sign', PLACE, 50)).toBe(true);
      expect(withinDelegation(access(grant({ scope: { kind: 'UNIT_SUBTREE', refIds: ['u1'], paths: ['/u1/'] } })), NOW, 'contract.sign', PLACE, 50)).toBe(true);
    });

    it('refuses a rank below the band, a scope that does not contain the place, a permission that is not held and a grant that does not count', () => {
      expect(withinDelegation(access(grant({ rank: 40 })), NOW, 'contract.sign', PLACE, 50)).toBe(false);
      expect(withinDelegation(access(grant({ scope: { kind: 'UNIT_SUBTREE', refIds: ['u9'], paths: ['/u9/'] } })), NOW, 'contract.sign', PLACE, 50)).toBe(false);
      expect(withinDelegation(access(grant({ permissions: ['contract.read'] })), NOW, 'contract.sign', PLACE, 50)).toBe(false);
      expect(withinDelegation(access(grant({ status: 'Revoked' })), NOW, 'contract.sign', PLACE, 50)).toBe(false);
      expect(withinDelegation(access(grant({ effectiveUntil: new Date('2026-10-01T00:00:00Z') })), NOW, 'contract.sign', PLACE, 50)).toBe(false);
      expect(withinDelegation(access(), NOW, 'contract.sign', PLACE, 50)).toBe(false);
    });

    it('takes the best of several grants, but only a grant that has the permission and the place together', () => {
      const lowAtPlace = grant({ rank: 40 });
      const highElsewhere = grant({ rank: 70, scope: { kind: 'UNIT_SUBTREE', refIds: ['u9'], paths: ['/u9/'] } });
      expect(withinDelegation(access(lowAtPlace, highElsewhere), NOW, 'contract.sign', PLACE, 50)).toBe(false);
      expect(withinDelegation(access(lowAtPlace, grant({ rank: 70 })), NOW, 'contract.sign', PLACE, 50)).toBe(true);
    });
  });

  describe('the conflict of interest at the signing (BR-CTR-13)', () => {
    it('blocks a signer who is in conflict, whatever decision is on the record', () => {
      expect(signingConflict({ signerInConflict: true, reviewerInConflict: false, decisionRef: undefined })).toBe('BLOCKED');
      expect(signingConflict({ signerInConflict: true, reviewerInConflict: true, decisionRef: 'QD-XL-001' })).toBe('BLOCKED');
    });

    it('lets someone else sign over a reviewer in conflict only with the decision that dealt with it', () => {
      expect(signingConflict({ signerInConflict: false, reviewerInConflict: true, decisionRef: undefined })).toBe('BLOCKED');
      expect(signingConflict({ signerInConflict: false, reviewerInConflict: true, decisionRef: '   ' })).toBe('BLOCKED');
      expect(signingConflict({ signerInConflict: false, reviewerInConflict: true, decisionRef: 'QD-XL-001' })).toBe('FREE');
    });

    it('asks nothing when nobody is in conflict', () => {
      expect(signingConflict({ signerInConflict: false, reviewerInConflict: false, decisionRef: undefined })).toBe('FREE');
    });
  });
});
