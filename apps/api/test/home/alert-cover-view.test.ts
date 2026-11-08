import { originsOf } from '../../src/modules/home/alert-cover-view';
import type { CoverEdge } from '@machvon/kernel';

const NOW = new Date('2027-10-15T03:00:00Z');
const span = (membershipId: string): { membershipId: string; from: Date; until: Date } => ({ membershipId, from: new Date('2027-10-14T00:00:00Z'), until: new Date('2027-10-20T00:00:00Z') });
const edge = (absentId: string, deputyId: string, over: Partial<CoverEdge> = {}): CoverEdge => ({ id: `${absentId}-${deputyId}`, absentId, deputyId, from: new Date('2027-10-14T00:00:00Z'), until: new Date('2027-10-20T00:00:00Z'), status: 'APPROVED', scopeKind: 'ALL', sources: [], ...over });
const sourcesOf = (map: ReturnType<typeof originsOf>, id: string): string => {
  const reach = map.get(id);
  return reach === undefined ? 'none' : reach.all ? 'all' : [...reach.sources].sort().join(',');
};

/** Whose alerts end with a deputy: the road of `routeAlert` seen from the deputy (G2-7). */
describe('the people a deputy stands in for', () => {
  it('names the absent people a cover in force hands to the deputy, with the sources', () => {
    const origins = originsOf({ deputyId: 'c', now: NOW, edges: [edge('a', 'c'), edge('b', 'c', { scopeKind: 'SOURCES', sources: ['ISSUE', 'PERMIT'] })], spans: [span('a'), span('b')] });
    expect([sourcesOf(origins, 'a'), sourcesOf(origins, 'b')]).toEqual(['all', 'ISSUE,PERMIT']);
  });

  it('follows a chain through a deputy who is away too (A covered by B, B covered by C), narrowed by what each cover names', () => {
    const edges = [edge('a', 'b'), edge('b', 'c', { scopeKind: 'SOURCES', sources: ['ISSUE', 'PERMIT'] })];
    const origins = originsOf({ deputyId: 'c', now: NOW, edges, spans: [span('a'), span('b')] });
    expect([sourcesOf(origins, 'b'), sourcesOf(origins, 'a')]).toEqual(['ISSUE,PERMIT', 'ISSUE,PERMIT']);
    const narrower = originsOf({ deputyId: 'c', now: NOW, edges: [edge('a', 'b', { scopeKind: 'SOURCES', sources: ['ISSUE', 'GUARANTEE'] }), edges[1] as CoverEdge], spans: [span('a'), span('b')] });
    expect(sourcesOf(narrower, 'a')).toBe('ISSUE');
  });

  it('does not pass through a deputy who is present, a cover that is not in force, a loop, or a chain beyond the depth', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect(sourcesOf(originsOf({ deputyId: 'c', now: NOW, edges, spans: [span('a')] }), 'a')).toBe('none');
    expect(sourcesOf(originsOf({ deputyId: 'c', now: NOW, edges: [edge('a', 'b'), edge('b', 'c', { status: 'PENDING' })], spans: [span('a'), span('b')] }), 'a')).toBe('none');
    const loop = originsOf({ deputyId: 'c', now: NOW, edges: [edge('b', 'c'), edge('c', 'b')], spans: [span('b'), span('c')] });
    expect([...loop.keys()]).toEqual(['b']);
    expect(sourcesOf(originsOf({ deputyId: 'c', now: NOW, edges, spans: [span('a'), span('b')], maxDepth: 1 }), 'a')).toBe('none');
    expect(sourcesOf(originsOf({ deputyId: 'c', now: NOW, edges, spans: [span('a'), span('b')], maxDepth: 2 }), 'a')).toBe('all');
  });
});
