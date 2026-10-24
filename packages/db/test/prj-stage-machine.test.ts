import { BASELINE_PACK } from '../src/master-baseline';
import { PROJECT_STATUSES } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import { PLAN_PUBLISHED_EVENT, SETTLEMENT_CLOSED_EVENT, STAGE_COMMANDS, STAGE_SEQUENCE, STAGE_TRANSITIONS, TERMINAL_STAGES, commandEdgesFrom, edgeBy, isTransitionAllowed, stagesAfter } from '../src/prj-stage-machine';

const baselineStages = BASELINE_PACK.entries.filter((entry) => entry.masterType === 'PROJECT_STAGE');

describe('the transition table of the PIMA life cycle (ST-PRJ-002)', () => {
  it('allows exactly the pairs of the table and refuses every other pair of the eleven stages, terminal stages included (AC-ST-PRJ-002-2)', () => {
    const allowed = new Set(STAGE_TRANSITIONS.map((edge) => `${edge.from}>${edge.to}`));
    let refused = 0;
    for (const from of PROJECT_STATUSES) {
      for (const to of PROJECT_STATUSES) {
        const expected = allowed.has(`${from}>${to}`);
        expect(isTransitionAllowed(from, to)).toBe(expected);
        if (!expected) refused += 1;
      }
    }
    // 121 ordered pairs, 15 of them in the table (no two edges join the same pair), 106 refused.
    expect(allowed.size).toBe(STAGE_TRANSITIONS.length);
    expect([allowed.size, refused]).toEqual([15, 106]);
  });

  it('never leads a stage to itself and leads nowhere from a closed, rejected or cancelled project', () => {
    for (const stage of PROJECT_STATUSES) expect(isTransitionAllowed(stage, stage)).toBe(false);
    for (const stage of TERMINAL_STAGES) expect(stagesAfter(stage)).toEqual([]);
    expect(TERMINAL_STAGES).toEqual(['CLOSED', 'REJECTED', 'CANCELLED']);
  });

  it('skips nothing: a concept does not start implementation or close, a pipeline project does not skip the budget, an implementation is not cancelled', () => {
    expect(isTransitionAllowed('CONCEPT', 'IMPLEMENTATION')).toBe(false);
    expect(isTransitionAllowed('CONCEPT', 'CLOSED')).toBe(false);
    expect(isTransitionAllowed('PIPELINE', 'IMPLEMENTATION')).toBe(false);
    expect(isTransitionAllowed('IMPLEMENTATION', 'CANCELLED')).toBe(false);
    expect(isTransitionAllowed('SUSPENDED', 'COMPLETED')).toBe(false);
    expect(isTransitionAllowed('COMPLETED', 'CLOSED')).toBe(false);
  });

  it('holds the same table as the master data of PROJECT_STAGE: the sequence and allowed_next of every stage', () => {
    expect(baselineStages.map((entry) => entry.businessKey).sort()).toEqual([...PROJECT_STATUSES].sort());
    for (const entry of baselineStages) {
      const stage = entry.businessKey as ProjectStatus;
      expect(STAGE_SEQUENCE[stage]).toBe(entry.attributes.sequence);
      expect([...stagesAfter(stage)].sort()).toEqual([...(entry.attributes.allowed_next as string[])].sort());
      expect(TERMINAL_STAGES.includes(stage)).toBe(entry.attributes.terminal === true);
    }
  });

  it('gives each edge the command or the event that makes it, and the system owns the two edges no member can make', () => {
    expect(edgeBy('startProjectImplementation', 'BUDGETED')).toMatchObject({ to: 'IMPLEMENTATION', actor: 'MEMBER' });
    expect(edgeBy('startProjectImplementation', 'CONCEPT')).toBeUndefined();
    expect(edgeBy(PLAN_PUBLISHED_EVENT, 'PIPELINE')).toMatchObject({ to: 'BUDGETED', actor: 'SYSTEM' });
    expect(edgeBy(SETTLEMENT_CLOSED_EVENT, 'COMPLETED')).toMatchObject({ to: 'SETTLED', actor: 'SYSTEM' });
    expect(STAGE_TRANSITIONS.filter((edge) => edge.actor === 'SYSTEM')).toHaveLength(2);
    expect(STAGE_TRANSITIONS.filter((edge) => edge.by === 'cancelProject').map((edge) => edge.from)).toEqual(['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED']);
  });

  it('offers on a card only the commands of the module that are open from its stage', () => {
    expect(commandEdgesFrom('BUDGETED').map((edge) => edge.by)).toEqual(['startProjectImplementation', 'cancelProject']);
    expect(commandEdgesFrom('IMPLEMENTATION').map((edge) => edge.by)).toEqual(['suspendProject', 'completeProject']);
    expect(commandEdgesFrom('SUSPENDED').map((edge) => edge.by)).toEqual(['resumeProject']);
    expect(commandEdgesFrom('SETTLED').map((edge) => edge.by)).toEqual(['closeProject']);
    // The edges of other commands (appraisal) and of the system consumers are not offered.
    expect(commandEdgesFrom('CONCEPT').map((edge) => edge.by)).toEqual(['cancelProject']);
    expect(commandEdgesFrom('COMPLETED')).toEqual([]);
    expect(commandEdgesFrom('CANCELLED')).toEqual([]);
    for (const command of STAGE_COMMANDS) expect(STAGE_TRANSITIONS.some((edge) => edge.by === command)).toBe(true);
  });
});
