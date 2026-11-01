import { describe, expect, it } from 'vitest';
import { toHandover } from '../../ast/handover/model';
import type { HandoverLine, HandoverStatus } from '../../ast/handover/model';
import { toSettlement } from '../../pay/settlement/model';
import type { Settlement } from '../../pay/settlement/model';
import { toAssignmentLine, toTaskForceLine } from '../accountability-model';
import type { AssignmentLine, TaskForceLine } from '../accountability-model';
import type { ProjectStatus } from '../model';
import * as labels from './labels';
import { closingSettlement, closureOf, handoverCounts, handoverTone, handoversOf, mayRead, settlementsOf, teamOf } from './model';
import { OTHER, PROJECT, assignment, force, handover, member, settlement } from './test-support';

const assignments = (...raw: Array<Record<string, unknown>>): AssignmentLine[] => raw.flatMap((one) => toAssignmentLine(one) ?? []);
const forces = (...raw: Array<Record<string, unknown>>): TaskForceLine[] => raw.flatMap((one) => toTaskForceLine(one) ?? []);
const handovers = (...raw: Array<Record<string, unknown>>): HandoverLine[] => raw.flatMap((one) => toHandover(one) ?? []);
const settlements = (...raw: Array<Record<string, unknown>>): Settlement[] => raw.flatMap((one) => toSettlement(one) ?? []);
const target = { id: PROJECT, code: 'DA-2026-001' };
const t = (key: string, values?: Record<string, string | number>): string => (values === undefined ? key : `${key}:${Object.values(values).join(',')}`);

describe('mayRead', () => {
  it('holds when the permission is listed or the permissions are not yet known', () => {
    expect(mayRead(undefined, 'x.read')).toBe(true);
    expect(mayRead(['x.read'], 'x.read')).toBe(true);
    expect(mayRead(['y.read'], 'x.read')).toBe(false);
  });
});

describe('teamOf (PRJ-08)', () => {
  it('puts the assignments in the order of the roles, then the members by force and by name, and leaves out what is not in force on this project', () => {
    const rows = teamOf(
      target,
      assignments(
        assignment(1, { accountability_role: 'FOCAL_OFFICER' }),
        assignment(2, { accountability_role: 'DEPUTY_LEADER' }),
        assignment(3),
        assignment(4, { status: 'ENDED', valid_until: '2026-02-01' }),
        assignment(5, { project_id: OTHER }),
      ),
      forces(
        force(2, [member(1, { display_name: 'Bình' })]),
        force(1, [
          member(2, { display_name: 'Cường' }),
          member(3, { display_name: 'An', role: 'SECRETARY' }),
          member(4, { project: null }),
          member(5, { valid_until: '2026-03-01' }),
          member(6, { display_name: null }),
        ]),
        force(3, [member(7)], { status: 'DISSOLVED' }),
      ),
    );
    expect(rows.map((row) => `${row.kind}:${row.role}:${row.person}`)).toEqual([
      'assignment:LEADER_IN_CHARGE:Người phụ trách 3',
      'assignment:DEPUTY_LEADER:Người phụ trách 2',
      'assignment:FOCAL_OFFICER:Người phụ trách 1',
      'taskForce:MEMBER:null',
      'taskForce:SECRETARY:An',
      'taskForce:MEMBER:Cường',
      'taskForce:MEMBER:Bình',
    ]);
    expect(rows[4]).toMatchObject({ forceCode: 'TF-01', forceName: 'Tổ công tác 1', scopeUnit: 'Sở Giao thông', validFrom: '2026-02-01', validUntil: null });
  });

  it('is empty for a project nobody answers for', () => {
    expect(teamOf(target, [], [])).toEqual([]);
  });
});

describe('handovers of a project (PRJ-11)', () => {
  it('keeps the handovers of the project in the order given', () => {
    const lines = handovers(handover(1), handover(2, { project_id: OTHER }), handover(3));
    expect(handoversOf(PROJECT, lines).map((line) => line.handoverNo)).toEqual(['BG-01', 'BG-03']);
    expect(handoversOf('none', lines)).toEqual([]);
  });

  it('counts the accepted ones and the ones on the way, and gives each state its colour', () => {
    const states: HandoverStatus[] = ['DRAFT', 'INSPECTING', 'PUNCH_PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'];
    const lines = handovers(...states.map((status, index) => handover(index + 1, { status })));
    expect(handoverCounts(lines)).toEqual({ accepted: 1, open: 3 });
    expect(handoverCounts([])).toEqual({ accepted: 0, open: 0 });
    expect(states.map(handoverTone)).toEqual(['blue', 'blue', 'blue', 'green', 'gray', 'gray']);
  });
});

describe('settlement of a project (PRJ-12)', () => {
  it('keeps the settlements of the project', () => {
    const lines = settlements(settlement(1), settlement(2, { project: { id: OTHER, code: 'X', name: 'Y' } }));
    expect(settlementsOf(PROJECT, lines).map((one) => one.revision)).toEqual([1]);
  });

  it('takes as the one in force the highest revision of the whole project that was not superseded', () => {
    const lines = settlements(
      settlement(1, { status: 'SUPERSEDED' }),
      settlement(2, { status: 'RETURNED' }),
      settlement(3, { settlement_scope: 'ANNUAL', fiscal_year: 2026 }),
      settlement(4, { status: 'SUPERSEDED' }),
      settlement(5, { settlement_scope: 'CONTRACT' }),
    );
    expect(closingSettlement(lines)?.revision).toBe(2);
    expect(closingSettlement(settlements(settlement(1, { status: 'SUPERSEDED' })))).toBeUndefined();
    expect(closingSettlement([])).toBeUndefined();
  });

  it('reads where the closing stands from the stage of the project and the settlement', () => {
    const closed = settlements(settlement(1, { status: 'CLOSED' }))[0];
    const verified = settlements(settlement(1))[0];
    const stages: Array<[ProjectStatus, Settlement | undefined, string]> = [
      ['SETTLED', closed, 'settled'],
      ['CLOSED', closed, 'settled'],
      ['SETTLED', undefined, 'settled'],
      ['COMPLETED', closed, 'closedAwaitingStage'],
      ['COMPLETED', verified, 'waiting'],
      ['COMPLETED', undefined, 'waiting'],
      ['IMPLEMENTATION', closed, 'notReached'],
      ['CANCELLED', undefined, 'notReached'],
    ];
    for (const [stage, closing, expected] of stages) expect(closureOf(stage, closing)).toBe(expected);
  });
});

describe('labels', () => {
  it('says every closing in its own sentence', () => {
    for (const closure of ['settled', 'closedAwaitingStage', 'waiting', 'notReached'] as const) expect(labels.closureMessage(t, closure)).toBe(`prj.settlement.closure.${closure}.notice`);
  });

  it('names the state of an asset, and shows one it does not know as it came', () => {
    expect(labels.assetStateLabel(t, 'REGISTERED')).toBe('ast.asset.status.registered');
    expect(labels.assetStateLabel(t, 'LOST')).toBe('LOST');
  });
});
