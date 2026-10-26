import { continueDrill } from '../src/drill-continuation.ts';
import type { DrillContinuation, DrillDeps } from '../src/drill-continuation.ts';
import type { EffectiveAccess } from '../src/effective-access.ts';
import { DomainError } from '../src/errors.ts';

const NOW = new Date('2026-06-01T10:00:00Z');
const MEMBER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const UNIT_1 = '00000000-0000-4000-a001-000000000001';
const UNIT_2 = '00000000-0000-4000-a001-000000000002';
const PERMISSION = 'report.drill';

const accessWith = (permissions: string[], overrides: Partial<EffectiveAccess> = {}): EffectiveAccess => ({
  membershipId: MEMBER,
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'ANALYST', rank: 30, permissions, scope: { kind: 'TENANT' }, status: 'Active', effectiveFrom: new Date(0), effectiveUntil: null }],
  ...overrides,
});

const drill = (unitId: string): DrillContinuation => ({ id: 'drill-1', membershipId: MEMBER, permission: PERMISSION, unitId });

function harness(access: EffectiveAccess, reachable: string[]): { deps: DrillDeps<string>; read: string[] } {
  const read: string[] = [];
  return {
    read,
    deps: {
      now: () => NOW,
      loadAccess: () => Promise.resolve(access),
      reachesUnit: (_access, _permission, unitId) => Promise.resolve(reachable.includes(unitId)),
      rows: (unitId) => {
        read.push(unitId);
        return Promise.resolve([`Project of ${unitId}`]);
      },
    },
  };
}

const refusal = async (promise: Promise<unknown>): Promise<DomainError> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
};

describe('continueDrill (AC-ST-KERNEL-025-3, UAT-AC481)', () => {
  it('AC-ST-KERNEL-025-3: continues a drill into a unit that is still in scope', async () => {
    const { deps, read } = harness(accessWith([PERMISSION]), [UNIT_1, UNIT_2]);
    expect(await continueDrill(drill(UNIT_2), deps)).toEqual([`Project of ${UNIT_2}`]);
    expect(read).toEqual([UNIT_2]);
  });

  it('AC-ST-KERNEL-025-3: answers 403 SCOPE_DENIED for a unit revoked since the drill was opened, reads nothing of it, and names no project', async () => {
    const { deps, read } = harness(accessWith([PERMISSION]), [UNIT_1]);
    const error = await refusal(continueDrill(drill(UNIT_2), deps));
    expect([error.status, error.code, error.detail]).toEqual([403, 'SCOPE_DENIED', undefined]);
    expect(JSON.stringify({ message: error.message, extensions: error.extensions })).not.toContain('Project');
    expect(read).toEqual([]);
    // The unit that is still reachable continues under the same drill.
    expect(await continueDrill(drill(UNIT_1), deps)).toEqual([`Project of ${UNIT_1}`]);
  });

  it('AC-ST-KERNEL-025-3: refuses a drill whose person has lost the permission, or whose membership has ended, without asking which units are reachable', async () => {
    for (const access of [accessWith(['report.view']), accessWith([PERMISSION], { membershipActive: false })]) {
      const { deps, read } = harness(access, [UNIT_1, UNIT_2]);
      const error = await refusal(continueDrill(drill(UNIT_1), deps));
      expect([error.status, error.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(read).toEqual([]);
    }
  });
});
