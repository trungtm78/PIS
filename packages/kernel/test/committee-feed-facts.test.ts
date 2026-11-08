import { factsDefects } from '../src/committee-facts.ts';
import { feedFactsToProvinceFacts } from '../src/committee-feed-facts.ts';
import type { OurProjectRef } from '../src/committee-feed-facts.ts';
import type { FeedProjectFact } from '../src/finance-feed-facts.ts';

const fact = (over: Partial<FeedProjectFact> = {}): FeedProjectFact => ({
  channel: 'FILE',
  feedProjectCode: 'F-100',
  known: true,
  projectName: 'Road one',
  sectorCode: 'GT',
  districtCode: 'D01',
  investorCode: 'CDT-1',
  investorName: 'Investor one',
  projectStatus: 'IMPLEMENTATION',
  ourProjectCode: null,
  fiscalYear: 2026,
  planByFund: { NSTW: 1_000_000_000_00n },
  disbursedByFund: { NSTW: 400_000_000_00n },
  monthly: [0n, 0n, 400_000_000_00n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  latestMonth: 3,
  asOf: '2026-04-02',
  ...over,
});

const idOf = (key: string): string => `id:${key}`;
const input = (facts: FeedProjectFact[], ours: Array<[string, OurProjectRef]> = []) => ({ facts, ours: new Map(ours), asOf: '2026-11-08', fiscalYear: 2026, reference: 'feed:2026', lastDeliveredAt: '2026-11-01T00:00:00Z', idOf });

describe('the facts of the feed as the facts of the committee workspace', () => {
  it('turns hundredths of a dong into whole dong and keeps plan and disbursement by fund', () => {
    const out = feedFactsToProvinceFacts(input([fact()]));
    expect(out.lines).toEqual([{ projectId: 'id:feed-project:F-100', fundSourceCode: 'NSTW', fundSourceName: expect.any(String), planVnd: '1000000000', disbursedVnd: '400000000', lastYearSamePeriodVnd: null, lastYearFullYearVnd: null }]);
    expect(out.projects[0]).toMatchObject({ code: 'F-100', name: 'Road one', sectorName: expect.any(String), totalInvestmentVnd: '1000000000', eacVnd: null, delayDays: null, stalledDays: null });
    expect(factsDefects(out)).toEqual([]);
  });

  it('takes our id, name, status, investor and total for a project the feed maps to one of ours, and our code', () => {
    const ours: OurProjectRef = { id: 'p-1', name: 'Our road', status: 'IMPLEMENTATION', investorUnitId: 'u-1', investorName: 'Our board', totalInvestmentVnd: '5000000000' };
    const out = feedFactsToProvinceFacts(input([fact({ ourProjectCode: 'DA-GT100' })], [['DA-GT100', ours]]));
    expect(out.projects[0]).toMatchObject({ projectId: 'p-1', code: 'DA-GT100', name: 'Our road', investorUnitId: 'u-1', investorName: 'Our board', totalInvestmentVnd: '5000000000' });
    expect(out.lines[0]?.projectId).toBe('p-1');
  });

  it('does not invent a figure: a project with no month stated has an unknown disbursement, not zero', () => {
    const out = feedFactsToProvinceFacts(input([fact({ latestMonth: 0, disbursedByFund: {}, monthly: new Array<bigint>(12).fill(0n), asOf: null })]));
    expect(out.lines[0]?.disbursedVnd).toBeNull();
    expect(out.projects[0]?.lastReportedOn).toBeNull();
  });

  it('keeps a fund the feed said nothing about unknown even when another fund of the same project reported', () => {
    const out = feedFactsToProvinceFacts(input([fact({ planByFund: { NSTW: 100_00n, NSDP: 200_00n }, disbursedByFund: { NSTW: 40_00n } })]));
    expect(out.lines.map((line) => [line.fundSourceCode, line.disbursedVnd])).toEqual([['NSDP', null], ['NSTW', '40']]);
  });

  it('leaves out a code the project list of the feed does not know', () => {
    const out = feedFactsToProvinceFacts(input([fact(), fact({ feedProjectCode: 'F-999', known: false })]));
    expect(out.projects.map((project) => project.code)).toEqual(['F-100']);
  });

  it('counts, for each investor, the projects that reached the latest month the whole feed reached', () => {
    const out = feedFactsToProvinceFacts(input([fact(), fact({ feedProjectCode: 'F-101', latestMonth: 2, asOf: '2026-03-02' }), fact({ feedProjectCode: 'F-102', investorCode: 'CDT-2', investorName: null })]));
    const one = out.units.find((unit) => unit.unitName === 'Investor one');
    expect(one).toMatchObject({ expected: 2, received: 1, lastReportedOn: '2026-04-02' });
    expect(out.units.find((unit) => unit.unitName === 'CDT-2')).toMatchObject({ expected: 1, received: 1 });
  });

  it('stands the cut-off on the newest statement and notes that the figures come from the live core, with the reference of the feed', () => {
    const out = feedFactsToProvinceFacts(input([fact(), fact({ feedProjectCode: 'F-101', asOf: '2026-06-30' })]));
    expect(out).toMatchObject({ asOf: '2026-06-30', evaluatedOn: '2026-11-08', fiscalYear: 2026, feed: { basis: 'CORE_LIVE', reference: 'feed:2026', lastDeliveredAt: '2026-11-01T00:00:00Z' } });
    expect(feedFactsToProvinceFacts({ ...input([fact({ asOf: '2027-01-05' })]), asOf: '2026-11-08' }).asOf).toBe('2026-11-08');
  });

  it('gives empty facts for an empty feed', () => {
    const out = feedFactsToProvinceFacts(input([]));
    expect(out).toMatchObject({ projects: [], lines: [], units: [], asOf: '2026-11-08' });
  });
});
