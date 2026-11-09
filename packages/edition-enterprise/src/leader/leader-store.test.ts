import { EnterpriseSnapshotStore } from '@machvon/db';
import type { EnterpriseSnapshotRow, ScopeBuilder, TenantTx } from '@machvon/db';
import { BLOCK_SOURCE_LIMIT, LeaderStore } from './leader-store.ts';

interface Call {
  sql: string;
  params: unknown[];
}

const snapshot = (id: string, asOfDate: string, revision = 1): EnterpriseSnapshotRow => ({ id, asOfDate, revision, status: 'FROZEN' }) as EnterpriseSnapshotRow;

function fakeTx(answer: (sql: string, params: unknown[]) => unknown[]): { tx: TenantTx; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    tx: {
      query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
        calls.push({ sql, params });
        return answer(sql, params) as R[];
      },
    },
  };
}

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const scoped: ScopeBuilder = (first) => ({ sql: `p.owner_unit_id = $${first}`, params: ['unit-x'] });

afterEach(() => jest.restoreAllMocks());

describe('LeaderStore.pair', () => {
  const frozen = [snapshot('s-2025-10', '2025-10-31'), snapshot('s-2026-10-r1', '2026-10-31', 1), snapshot('s-2026-10-r2', '2026-10-31', 2), snapshot('s-2026-09', '2026-09-30')];

  it('takes the latest day and then the latest revision as the current one, and asks only for frozen snapshots', async () => {
    const list = jest.spyOn(EnterpriseSnapshotStore.prototype, 'list').mockResolvedValue([...frozen]);
    const pair = await new LeaderStore().pair(fakeTx(() => []).tx, undefined);
    expect(pair?.current.id).toBe('s-2026-10-r2');
    expect(pair?.prior?.id).toBe('s-2025-10');
    expect(list.mock.calls[0]?.[1]).toEqual({ status: 'FROZEN' });
  });

  it('breaks a tie of day and revision by the id, so the answer does not depend on the order of the rows', async () => {
    const twins = [snapshot('a', '2026-10-31'), snapshot('b', '2026-10-31')];
    const list = jest.spyOn(EnterpriseSnapshotStore.prototype, 'list').mockResolvedValue(twins);
    expect((await new LeaderStore().pair(fakeTx(() => []).tx, undefined))?.current.id).toBe('b');
    list.mockResolvedValue([...twins].reverse());
    expect((await new LeaderStore().pair(fakeTx(() => []).tx, undefined))?.current.id).toBe('b');
  });

  it('is undefined when nothing is frozen, and when the id named is not an enterprise snapshot', async () => {
    jest.spyOn(EnterpriseSnapshotStore.prototype, 'list').mockResolvedValue([]);
    const find = jest.spyOn(EnterpriseSnapshotStore.prototype, 'find').mockResolvedValue(undefined);
    const store = new LeaderStore();
    const { tx } = fakeTx(() => []);
    expect(await store.pair(tx, undefined)).toBeUndefined();
    expect(await store.pair(tx, 'unknown-id')).toBeUndefined();
    expect(find).toHaveBeenCalledWith(tx, 'unknown-id');
  });

  it('pairs a snapshot named by id with the one of its own period last year, and never with itself or a later one', async () => {
    jest.spyOn(EnterpriseSnapshotStore.prototype, 'list').mockResolvedValue([...frozen]);
    jest.spyOn(EnterpriseSnapshotStore.prototype, 'find').mockResolvedValue(frozen[3]);
    const pair = await new LeaderStore().pair(fakeTx(() => []).tx, 's-2026-09');
    expect(pair?.current.id).toBe('s-2026-09');
    expect(pair?.prior).toBeUndefined();
  });

  it('has no prior when the only earlier snapshot is far from the same day of last year', async () => {
    jest.spyOn(EnterpriseSnapshotStore.prototype, 'list').mockResolvedValue([snapshot('now', '2026-10-31'), snapshot('old', '2025-03-31')]);
    expect((await new LeaderStore().pair(fakeTx(() => []).tx, undefined))?.prior).toBeUndefined();
  });
});

describe('LeaderStore.view', () => {
  it('hands the row to the store of snapshots with the transaction of the reader', () => {
    const view = jest.spyOn(EnterpriseSnapshotStore.prototype, 'view').mockReturnValue('the-view' as never);
    const { tx } = fakeTx(() => []);
    const row = snapshot('s', '2026-10-31');
    expect(new LeaderStore().view(tx, row)).toBe('the-view');
    expect(view).toHaveBeenCalledWith(tx, row);
  });
});

describe('LeaderStore.visibleProjects', () => {
  it('is undefined (all) when the scope is the whole tenant, and runs no query', async () => {
    const { tx, calls } = fakeTx(() => []);
    expect(await new LeaderStore().visibleProjects(tx, everything)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('lists the ids inside the scope, numbering the scope from the first parameter', async () => {
    const { tx, calls } = fakeTx(() => [{ id: 'p1' }, { id: 'p2' }]);
    expect(await new LeaderStore().visibleProjects(tx, scoped)).toEqual(['p1', 'p2']);
    expect(calls[0]?.sql).toContain('p.owner_unit_id = $1');
    expect(calls[0]?.params).toEqual(['unit-x']);
  });

  it('is an empty list, not "all", when the reader may read no project', async () => {
    expect(await new LeaderStore().visibleProjects(fakeTx(() => []).tx, scoped)).toEqual([]);
  });
});

describe('LeaderStore.directory', () => {
  it('reads nothing when the snapshot mentions no unit and no project', async () => {
    const { tx, calls } = fakeTx(() => []);
    const directory = await new LeaderStore().directory(tx, [], []);
    expect(calls).toHaveLength(0);
    expect(directory.units.size + directory.projects.size).toBe(0);
  });

  it('names the units and projects it was asked for, each from its own table', async () => {
    const { tx, calls } = fakeTx((sql) => (sql.includes('organization_unit') ? [{ id: 'u1', code: 'U-1', name: 'Unit one' }] : [{ id: 'p1', code: 'P-1', name: 'Project one' }]));
    const directory = await new LeaderStore().directory(tx, ['u1'], ['p1']);
    expect(directory.units.get('u1')).toEqual({ code: 'U-1', name: 'Unit one' });
    expect(directory.projects.get('p1')).toEqual({ code: 'P-1', name: 'Project one' });
    expect(calls.map((call) => call.params)).toEqual([[['u1']], [['p1']]]);
  });

  it('reads only the table it needs when one list is empty', async () => {
    const { tx, calls } = fakeTx(() => [{ id: 'p1', code: 'P-1', name: 'Project one' }]);
    const directory = await new LeaderStore().directory(tx, [], ['p1']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('machvon.project');
    expect(directory.units.size).toBe(0);
  });
});

describe('LeaderStore.blockFacts', () => {
  const row = (id: string, since: string): Record<string, unknown> => ({ id, project_id: `pr-${id}`, project_code: `C-${id}`, project_name: `N-${id}`, unit_id: 'u1', unit_name: 'Unit', since });

  it('reads the four registers in order with the day first, and numbers the scope after the parameters of each read', async () => {
    const scopeCalls: number[] = [];
    const scope: ScopeBuilder = (first) => {
      scopeCalls.push(first);
      return { sql: `scope($${first})`, params: ['S'] };
    };
    const { tx, calls } = fakeTx((sql) => (sql.includes('machvon.permit ') ? [row('a', '2026-10-01')] : sql.includes('machvon.issue ') ? [row('b', '2026-10-02')] : sql.includes('compensation_payment') ? [row('c', '2026-10-03')] : [row('d', '2026-10-04')]));
    const read = await new LeaderStore().blockFacts(tx, scope, '2026-11-09', 14);
    expect(read.facts.map((fact) => [fact.source, fact.sourceId, fact.since])).toEqual([
      ['PERMIT', 'a', '2026-10-01'],
      ['ISSUE', 'b', '2026-10-02'],
      ['LAND', 'c', '2026-10-03'],
      ['PROCUREMENT', 'd', '2026-10-04'],
    ]);
    expect(read.cut).toEqual([]);
    expect(scopeCalls).toEqual([2, 3, 2, 3]);
    expect(calls.map((call) => call.params)).toEqual([['2026-11-09', 'S'], ['2026-11-09', ['HIGH', 'CRITICAL'], 'S'], ['2026-11-09', 'S'], ['2026-11-09', 14, 'S']]);
    expect(read.facts[0]).toMatchObject({ projectId: 'pr-a', projectCode: 'C-a', projectName: 'N-a', unitId: 'u1', unitName: 'Unit' });
  });

  it('cuts a source that has more holds than the limit, says which, and keeps the others whole', async () => {
    const many = Array.from({ length: BLOCK_SOURCE_LIMIT + 1 }, (_, index) => row(`i${index}`, '2026-10-02'));
    const { tx } = fakeTx((sql) => (sql.includes('machvon.issue ') ? many : []));
    const read = await new LeaderStore().blockFacts(tx, everything, '2026-11-09', 14);
    expect(read.cut).toEqual(['ISSUE']);
    expect(read.facts).toHaveLength(BLOCK_SOURCE_LIMIT);
    expect(read.facts.every((fact) => fact.source === 'ISSUE')).toBe(true);
  });

  it('does not call a source cut when it holds exactly the limit', async () => {
    const exact = Array.from({ length: BLOCK_SOURCE_LIMIT }, (_, index) => row(`p${index}`, '2026-10-02'));
    const { tx } = fakeTx((sql) => (sql.includes('machvon.permit ') ? exact : []));
    const read = await new LeaderStore().blockFacts(tx, everything, '2026-11-09', 14);
    expect(read.cut).toEqual([]);
    expect(read.facts).toHaveLength(BLOCK_SOURCE_LIMIT);
  });
});
