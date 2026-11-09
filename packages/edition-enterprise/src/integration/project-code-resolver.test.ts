import { SourceSystemStore, isDirectMatchSystem } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { ProjectCodeResolver, registerEnterpriseCodeSystems } from './project-code-resolver.ts';
import { ENTERPRISE_SYSTEM_SEEDS } from './project-codes.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

interface Call {
  sql: string;
  params: unknown[];
}

/** A transaction that answers by the table the query reads and keeps what it was asked. */
function fakeTx(answers: { crosswalk?: unknown[]; projects?: unknown[] }): { tx: TenantTx; calls: Call[] } {
  const calls: Call[] = [];
  const tx: TenantTx = {
    query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
      calls.push({ sql, params });
      if (sql.includes('machvon.master_crosswalk')) return (answers.crosswalk ?? []) as R[];
      if (sql.includes('machvon.project')) return (answers.projects ?? []) as R[];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { tx, calls };
}

const mapping = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ project_id: P1, source_system: 'EBS', external_code: 'EBS-77', valid_from: '2026-01-01', valid_until: null, status: 'ACTIVE', ...patch });

afterEach(() => jest.restoreAllMocks());

describe('registerEnterpriseCodeSystems', () => {
  it('puts EBS and HPM among the systems read by direct match, and leaves any other system out', () => {
    expect(isDirectMatchSystem('ORACLE_EBS')).toBe(false);
    registerEnterpriseCodeSystems();
    registerEnterpriseCodeSystems();
    expect(isDirectMatchSystem('ORACLE_EBS')).toBe(true);
    expect(isDirectMatchSystem('HPM')).toBe(true);
    expect(isDirectMatchSystem('SAP')).toBe(false);
  });
});

describe('ProjectCodeResolver.ensureSystems', () => {
  it('registers the two systems that the tenant does not have and names them', async () => {
    const register = jest.spyOn(SourceSystemStore.prototype, 'register').mockResolvedValue({} as never);
    jest.spyOn(SourceSystemStore.prototype, 'byCode').mockResolvedValue(undefined);
    const added = await new ProjectCodeResolver().ensureSystems(fakeTx({}).tx, 'actor-1');
    expect(added).toEqual(ENTERPRISE_SYSTEM_SEEDS.map((seed) => seed.code));
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[0]?.[1]).toEqual({ code: 'ORACLE_EBS', name: 'ORACLE_EBS', kind: 'ERP', codePattern: ENTERPRISE_SYSTEM_SEEDS[0]?.codePattern });
    expect(register.mock.calls[0]?.[2]).toBe('actor-1');
  });

  it('registers only the missing one and nothing at all when both are there', async () => {
    const register = jest.spyOn(SourceSystemStore.prototype, 'register').mockResolvedValue({} as never);
    const byCode = jest.spyOn(SourceSystemStore.prototype, 'byCode').mockImplementation(async (_tx, code) => (code === 'ORACLE_EBS' ? ({ code } as never) : undefined));
    expect(await new ProjectCodeResolver().ensureSystems(fakeTx({}).tx, 'a')).toEqual(['HPM']);
    expect(register).toHaveBeenCalledTimes(1);
    byCode.mockResolvedValue({} as never);
    register.mockClear();
    expect(await new ProjectCodeResolver().ensureSystems(fakeTx({}).tx, 'a')).toEqual([]);
    expect(register).not.toHaveBeenCalled();
  });
});

describe('ProjectCodeResolver.inbound', () => {
  it('follows the active mapping that holds on the day and asks only for active rows of that code', async () => {
    const { tx, calls } = fakeTx({ crosswalk: [mapping()], projects: [] });
    expect(await new ProjectCodeResolver().inbound(tx, 'EBS', 'EBS-77', '2026-06-01')).toEqual({ projectId: P1, via: 'CROSSWALK', shadowsDirect: false });
    expect(calls[0]?.params).toEqual(['EBS', 'EBS-77']);
    expect(calls[0]?.sql).toContain("x.status = 'ACTIVE'");
  });

  it('says the crosswalk shadows the direct match when both name different projects', async () => {
    const { tx } = fakeTx({ crosswalk: [mapping()], projects: [{ id: P2 }] });
    expect(await new ProjectCodeResolver().inbound(tx, 'EBS', 'EBS-77', '2026-06-01')).toEqual({ projectId: P1, via: 'CROSSWALK', shadowsDirect: true });
  });

  it('falls back to the project of the same code when no mapping holds, and finds nobody when there is no such project', async () => {
    const expired = mapping({ valid_until: '2026-03-31' });
    expect(await new ProjectCodeResolver().inbound(fakeTx({ crosswalk: [expired], projects: [{ id: P2 }] }).tx, 'EBS', 'EBS-77', '2026-06-01')).toEqual({ projectId: P2, via: 'DIRECT', shadowsDirect: false });
    expect(await new ProjectCodeResolver().inbound(fakeTx({ crosswalk: [expired] }).tx, 'EBS', 'EBS-77', '2026-06-01')).toEqual({ projectId: null, via: null, shadowsDirect: false });
  });

  it('reads the day of a Date in Vietnam time: 17:30 UTC of the 31st is already the 1st', async () => {
    const wholeMonth = mapping({ valid_from: '2026-06-01' });
    const resolver = new ProjectCodeResolver();
    expect((await resolver.inbound(fakeTx({ crosswalk: [wholeMonth] }).tx, 'EBS', 'EBS-77', new Date('2026-05-31T17:30:00Z'))).via).toBe('CROSSWALK');
    expect((await resolver.inbound(fakeTx({ crosswalk: [wholeMonth] }).tx, 'EBS', 'EBS-77', new Date('2026-05-31T16:30:00Z'))).via).toBeNull();
  });
});

describe('ProjectCodeResolver.outbound', () => {
  it('answers nothing and reads nothing for no project', async () => {
    const { tx, calls } = fakeTx({});
    expect((await new ProjectCodeResolver().outbound(tx, 'EBS', [], '2026-06-01')).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('answers every project asked for: the mapped code through the crosswalk, the own code flagged DIRECT otherwise', async () => {
    const { tx, calls } = fakeTx({ crosswalk: [mapping()], projects: [{ id: P1, code: 'DA-001' }, { id: P2, code: 'DA-002' }] });
    const answer = await new ProjectCodeResolver().outbound(tx, 'EBS', [P1, P2], '2026-06-01');
    expect(answer.get(P1)).toEqual({ code: 'EBS-77', via: 'CROSSWALK', ourCode: 'DA-001' });
    expect(answer.get(P2)).toEqual({ code: 'DA-002', via: 'DIRECT', ourCode: 'DA-002' });
    expect(answer.has(P3)).toBe(false);
    expect(calls[1]?.params).toEqual(['EBS', [P1, P2]]);
  });

  it('does not use a mapping of another system or one that has ended', async () => {
    const rows = [mapping({ source_system: 'HPM', external_code: 'H-1' }), mapping({ valid_until: '2026-02-01' })];
    const answer = await new ProjectCodeResolver().outbound(fakeTx({ crosswalk: rows, projects: [{ id: P1, code: 'DA-001' }] }).tx, 'EBS', [P1], '2026-06-01');
    expect(answer.get(P1)).toEqual({ code: 'DA-001', via: 'DIRECT', ourCode: 'DA-001' });
  });
});
