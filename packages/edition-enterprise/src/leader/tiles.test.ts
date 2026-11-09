import { blockedBoard, daysFrom } from './tiles.ts';
import type { BlockFact } from './tiles.ts';

describe('blockedBoard', () => {
  const fact = (over: Partial<BlockFact>): BlockFact => ({ projectId: 'p1', projectCode: 'DA-01', projectName: 'Project 1', unitId: 'u1', unitName: 'Unit 1', source: 'PERMIT', sourceId: 's1', since: '2026-10-01', ...over });

  it('counts projects, not holds: a project with three late permits is one', () => {
    const board = blockedBoard([fact({ sourceId: 'a' }), fact({ sourceId: 'b' }), fact({ sourceId: 'c', source: 'ISSUE', since: '2026-10-20' })], '2026-11-09');
    expect(board.total).toBe(1);
    expect(board.projects[0]).toMatchObject({ projectId: 'p1', items: 3, sources: ['PERMIT', 'ISSUE'], since: '2026-10-01', days: 39 });
    expect(board.bySource).toEqual({ PERMIT: 1, ISSUE: 1, LAND: 0, PROCUREMENT: 0 });
  });

  it('a hold due today or later is not late yet', () => {
    const board = blockedBoard([fact({ since: '2026-11-09' }), fact({ projectId: 'p2', sourceId: 'x', since: '2026-11-10' })], '2026-11-09');
    expect(board.total).toBe(0);
  });

  it('counts a thing read twice once', () => {
    const board = blockedBoard([fact({}), fact({})], '2026-11-09');
    expect(board.projects[0]?.items).toBe(1);
  });

  it('orders the longest hold first, then the code, whatever the order of the facts', () => {
    const facts = [fact({ projectId: 'p2', projectCode: 'DA-02', sourceId: 'x', since: '2026-10-01' }), fact({ projectId: 'p3', projectCode: 'DA-00', sourceId: 'y', since: '2026-09-01' }), fact({})];
    const forward = blockedBoard(facts, '2026-11-09').projects.map((project) => project.projectCode);
    const backward = blockedBoard([...facts].reverse(), '2026-11-09').projects.map((project) => project.projectCode);
    expect(forward).toEqual(['DA-00', 'DA-01', 'DA-02']);
    expect(backward).toEqual(forward);
  });

  it('cuts the list but not the count', () => {
    const facts = Array.from({ length: 5 }, (_, index) => fact({ projectId: `p${index}`, projectCode: `DA-0${index}`, sourceId: `s${index}` }));
    const board = blockedBoard(facts, '2026-11-09', 2);
    expect(board.total).toBe(5);
    expect(board.projects).toHaveLength(2);
    expect(board.truncated).toBe(true);
  });

  it('refuses a day that is not a day', () => {
    expect(() => blockedBoard([fact({ since: '2026-02-30' })], '2026-11-09')).toThrow();
    expect(() => blockedBoard([], 'today')).toThrow();
    expect(daysFrom('2026-11-01', '2026-11-09')).toBe(8);
  });
});
