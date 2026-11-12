import { MILESTONE_SEEDS } from './ent-catalogue.ts';
import type { MilestoneEntry } from './ent-catalogue.ts';
import { investmentProfileOf, planRevisionsOf } from './investment-profile.ts';
import type { HeldMilestone, OriginLine, PlanRevision } from './investment-profile.ts';

const CATALOGUE: MilestoneEntry[] = MILESTONE_SEEDS.map((seed) => ({
  code: seed.code,
  label: seed.params.label as string,
  sequence: seed.params.sequence as number,
  phase: seed.params.phase as MilestoneEntry['phase'],
  evidenceKinds: seed.params.evidence_kinds as string[],
  required: seed.params.required as boolean,
}));
const PROJECT_TYPE = { code: 'ENT_MAJOR_REPAIR', label: 'Sua chua lon', kind: 'MAJOR_REPAIR' };

const held = (code: string, plannedOn: string, actualOn: string | null = null, status: HeldMilestone['status'] = actualOn === null ? 'PLANNED' : 'DONE'): HeldMilestone => ({ code, plannedOn, actualOn, status });
const line = (origin: string, amountVnd: string, symbol: string | null, kind: string | null = null): OriginLine => ({ origin, decisionKind: kind, decisionSymbol: symbol, decisionIssuedOn: symbol === null ? null : '2026-01-15', issuingAuthority: symbol === null ? null : 'AUTH', amountVnd });
const profile = (patch: Partial<Parameters<typeof investmentProfileOf>[0]> = {}) => investmentProfileOf({ catalogue: CATALOGUE, projectType: PROJECT_TYPE, projectStartYear: null, held: [], plans: [], origins: [], planYear: 2026, ...patch });

describe('the investment profile of a project (MD.01, MD.02, CN.01)', () => {
  it('lists every milestone of the catalogue in its order, and says which the project has not got', () => {
    const result = profile();
    expect(result.milestones.map((one) => one.code)).toEqual(CATALOGUE.map((one) => one.code));
    expect(result.milestones.every((one) => one.state === 'NOT_HELD' && one.plannedOn === null && one.actualOn === null)).toBe(true);
    expect(result.projectType).toEqual(PROJECT_TYPE);
    expect(result).toMatchObject({ planYear: 2026, plans: [] });
    expect(result.startFlag).toBeNull();
    expect(result.startYear).toBeNull();
    expect(result.startYearBasis).toBeNull();
    expect(result.findings).toEqual([]);
  });

  it('reads the state of each held milestone: reached, planned, delayed or cancelled', () => {
    const result = profile({
      held: [held('INVESTMENT_POLICY', '2025-01-10', '2025-01-12'), held('FS_APPROVAL', '2025-06-01'), held('TMDT_APPROVAL', '2025-03-01', null, 'DELAYED'), held('ACCEPTANCE', '2027-01-01', null, 'CANCELLED')],
    });
    const states = Object.fromEntries(result.milestones.map((one) => [one.code, one.state]));
    expect(states).toMatchObject({ INVESTMENT_POLICY: 'REACHED', FS_APPROVAL: 'PLANNED', TMDT_APPROVAL: 'DELAYED', ACCEPTANCE: 'CANCELLED', GROUNDBREAKING: 'NOT_HELD' });
    expect(result.milestones.find((one) => one.code === 'INVESTMENT_POLICY')).toMatchObject({ actualOn: '2025-01-12', plannedOn: '2025-01-10', required: true, phase: 'PREPARATION', evidenceKinds: ['INVESTMENT_POLICY_DECISION'] });
  });

  it('flags a project as a new start in the year of its groundbreaking and as continuing after it, by the day it really happened, else by the day it is planned', () => {
    expect(profile({ held: [held('GROUNDBREAKING', '2026-03-01')], planYear: 2026 })).toMatchObject({ startFlag: 'NEW_START', startYear: 2026, startYearBasis: 'PLANNED' });
    expect(profile({ held: [held('GROUNDBREAKING', '2026-03-01', '2025-12-20')], planYear: 2026 })).toMatchObject({ startFlag: 'CONTINUING', startYear: 2025, startYearBasis: 'ACTUAL' });
    expect(profile({ held: [held('GROUNDBREAKING', '2027-02-01')], planYear: 2026 })).toMatchObject({ startFlag: null, startYear: 2027, startYearBasis: 'PLANNED' });
    expect(profile({ held: [held('GROUNDBREAKING', '2026-03-01', null, 'CANCELLED')], planYear: 2026 })).toMatchObject({ startFlag: null, startYear: null, startYearBasis: null });
  });

  it('takes the start year written on the project while it holds no groundbreaking milestone, and lets a milestone, even a cancelled one, speak over it', () => {
    expect(profile({ projectStartYear: 2026 })).toMatchObject({ startFlag: 'NEW_START', startYear: 2026, startYearBasis: 'PROJECT' });
    expect(profile({ projectStartYear: 2024 })).toMatchObject({ startFlag: 'CONTINUING', startYearBasis: 'PROJECT' });
    expect(profile({ projectStartYear: 2028 })).toMatchObject({ startFlag: null, startYear: 2028 });
    expect(profile({ projectStartYear: 2024, held: [held('GROUNDBREAKING', '2026-03-01')] })).toMatchObject({ startFlag: 'NEW_START', startYearBasis: 'PLANNED' });
    expect(profile({ projectStartYear: 2024, held: [held('GROUNDBREAKING', '2026-03-01', null, 'CANCELLED')] })).toMatchObject({ startFlag: null, startYear: null, startYearBasis: null });
  });

  it('reports a milestone reached before one that comes earlier in the catalogue, and a required one that was skipped', () => {
    const result = profile({
      held: [held('INVESTMENT_POLICY', '2025-01-01', '2025-01-05'), held('FS_APPROVAL', '2025-02-01', '2025-04-01'), held('TMDT_APPROVAL', '2025-03-01', '2025-03-10'), held('GROUNDBREAKING', '2025-09-01', '2025-09-02')],
    });
    expect(result.findings).toEqual(['MILESTONE_ORDER:TMDT_APPROVAL', 'REQUIRED_SKIPPED:CONTRACTOR_SELECTION_PLAN']);
  });

  it('does not call a missing milestone skipped while nothing after it was reached, nor an optional one at all', () => {
    expect(profile({ held: [held('INVESTMENT_POLICY', '2025-01-01', '2025-01-05')] }).findings).toEqual([]);
    const optionalGap = profile({ held: [held('INVESTMENT_POLICY', '2025-01-01', '2025-01-05'), held('FS_APPROVAL', '2025-02-01', '2025-02-05')] });
    expect(optionalGap.findings).toEqual([]);
  });

  it('splits the plan of the project by the origin of the capital: the resolution of the group, the decision of the company, the rest, with the documents behind each', () => {
    const result = profile({
      origins: [
        line('GROUP_ASSIGNED', '1000000000', 'NQ-12/PVN', 'GROUP_RESOLUTION'),
        line('GROUP_ASSIGNED', '500000000', 'NQ-12/PVN', 'GROUP_RESOLUTION'),
        line('GROUP_ASSIGNED', '250000000', 'NQ-30/PVN', 'GROUP_RESOLUTION'),
        line('BOARD_APPROVED', '300000000', 'QD-77/TCT', 'COMPANY_DECISION'),
        line('SELF_FUNDED', '40', null),
      ],
    });
    expect(result.originSplit).toEqual({
      totalVnd: '2050000040',
      groupAssignedVnd: '1750000000',
      boardApprovedVnd: '300000000',
      otherVnd: '40',
      origins: [
        { origin: 'BOARD_APPROVED', amountVnd: '300000000', lines: 1, decisions: [{ kind: 'COMPANY_DECISION', symbol: 'QD-77/TCT', issuedOn: '2026-01-15', authority: 'AUTH' }] },
        {
          origin: 'GROUP_ASSIGNED',
          amountVnd: '1750000000',
          lines: 3,
          decisions: [
            { kind: 'GROUP_RESOLUTION', symbol: 'NQ-12/PVN', issuedOn: '2026-01-15', authority: 'AUTH' },
            { kind: 'GROUP_RESOLUTION', symbol: 'NQ-30/PVN', issuedOn: '2026-01-15', authority: 'AUTH' },
          ],
        },
        { origin: 'SELF_FUNDED', amountVnd: '40', lines: 1, decisions: [] },
      ],
    });
  });

  it('has an empty split and zeros for a project without plan lines', () => {
    expect(profile().originSplit).toEqual({ totalVnd: '0', groupAssignedVnd: '0', boardApprovedVnd: '0', otherVnd: '0', origins: [] });
  });

  it('holds a project without a type as null', () => {
    expect(profile({ projectType: null }).projectType).toBeNull();
  });
});

describe('the revisions the split is read from', () => {
  const revision = (id: string, planCode: string | null, status: string, number: number): PlanRevision => ({ id, planCode, status, revision: number });

  it('takes one revision per plan code: every revision of a plan keeps the code, so a pending revision never counts twice with the published one', () => {
    const chosen = planRevisionsOf([revision('a1', 'KH-A', 'PUBLISHED', 1), revision('a2', 'KH-A', 'DRAFT', 2), revision('b1', 'KH-B', 'PUBLISHED', 3), revision('b2', 'KH-B', 'PUBLISHED', 4)], true);
    expect(chosen.map((one) => one.id)).toEqual(['a1', 'b2']);
  });

  it('shows the newest revision in work only to who drafts or approves, and only when the plan has no published revision', () => {
    const all = [revision('a1', 'KH-A', 'DRAFT', 1), revision('a2', 'KH-A', 'IN_REVIEW', 2), revision('b1', 'KH-B', 'PUBLISHED', 1)];
    expect(planRevisionsOf(all, true).map((one) => one.id)).toEqual(['a2', 'b1']);
    expect(planRevisionsOf(all, false).map((one) => one.id)).toEqual(['b1']);
    expect(planRevisionsOf([], true)).toEqual([]);
  });

  it('counts a version without a plan code as a plan of its own', () => {
    expect(planRevisionsOf([revision('x', null, 'PUBLISHED', 1), revision('y', null, 'PUBLISHED', 1)], false).map((one) => one.id)).toEqual(['x', 'y']);
  });
});
