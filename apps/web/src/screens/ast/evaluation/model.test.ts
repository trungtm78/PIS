import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, addMonths, acceptedHandovers, canManage, describeRefusal, earliestDue, isDay, isEvaluationId, isPostHandover, scheduleBody, toTrigger, validateSchedule, vietnamDay } from './model';
import type { AcceptedHandover } from './model';
import type { HandoverLine } from '../handover/model';

const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const HANDOVER: AcceptedHandover = { id: '00000000-0000-4000-8000-000000000001', handoverNo: 'BG-001', acceptedOn: '2027-01-15' };
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 't-1',
  trigger_kind: 'POST_HANDOVER_12M',
  handover: { id: HANDOVER.id, handover_no: 'BG-001', accepted_on: '2027-01-15' },
  due_on: '2028-01-15',
  status: 'SCHEDULED',
  fired_at: null,
  evaluation: null,
  version: 1,
  ...overrides,
});

describe('the trigger of the evaluation after the investment (AST-07, ST-AST-006)', () => {
  it('reads a trigger with its handover and its evaluation, and drops what is not one', () => {
    expect(toTrigger(raw())).toEqual({ id: 't-1', kind: 'POST_HANDOVER_12M', handover: { id: HANDOVER.id, handoverNo: 'BG-001', acceptedOn: '2027-01-15' }, dueOn: '2028-01-15', status: 'SCHEDULED', firedAt: null, evaluation: null, version: 1 });
    expect(toTrigger(raw({ handover: null, trigger_kind: 'MANUAL', status: 'ACKNOWLEDGED', fired_at: '2028-01-15T02:00:00.000000Z', evaluation: { id: 'e-1', evaluation_kind: 'FINAL', status: 'PLANNED' }, version: 3 }))).toMatchObject({
      handover: null,
      firedAt: '2028-01-15T02:00:00.000000Z',
      evaluation: { id: 'e-1', kind: 'FINAL', status: 'PLANNED' },
      version: 3,
    });
    expect(toTrigger(raw({ handover: { id: HANDOVER.id } }))).toMatchObject({ handover: { handoverNo: null, acceptedOn: null } });
    expect(toTrigger(raw({ evaluation: { id: 'e-2' } }))).toMatchObject({ evaluation: { kind: '', status: '' } });
    expect(toTrigger(raw({ version: 'x' }))).toMatchObject({ version: 0 });
    for (const bad of [null, 'x', [], raw({ id: 1 }), raw({ trigger_kind: 'WHENEVER' }), raw({ status: 'NOPE' }), raw({ due_on: undefined })]) expect(toTrigger(bad)).toBeUndefined();
  });

  it('is for the holders of the right, and not while the tenant is read-only', () => {
    expect(canManage(['evaluation.trigger.manage'], 'FULL')).toBe(true);
    expect(canManage(undefined, undefined)).toBe(true);
    expect(canManage(['evaluation.trigger.manage'], 'READ_ONLY')).toBe(false);
    expect(canManage(['project.read'], 'FULL')).toBe(false);
  });

  it('counts the days as the server does: months added, the last day of a short month, the day in Vietnam', () => {
    expect(addMonths('2027-01-15', 12)).toBe('2028-01-15');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(addMonths('2027-01-31', 24)).toBe('2029-01-31');
    expect(earliestDue('POST_HANDOVER_12M', '2027-01-15')).toBe('2028-01-15');
    expect(earliestDue('POST_HANDOVER_24M', '2027-01-15')).toBe('2029-01-15');
    expect(earliestDue('MANUAL', '2027-01-15')).toBeUndefined();
    expect([isPostHandover('POST_HANDOVER_12M'), isPostHandover('POST_HANDOVER_24M'), isPostHandover('MANUAL'), isPostHandover('')]).toEqual([true, true, false, false]);
    expect(vietnamDay('2027-01-14T17:30:00.000000Z')).toBe('2027-01-15');
    expect(vietnamDay('2027-01-15T03:00:00Z')).toBe('2027-01-15');
    expect(vietnamDay('not a time')).toBeUndefined();
    expect([isDay('2028-02-29'), isDay('2027-02-29'), isDay('2027-13-01'), isDay('2027-1-1'), isDay('')]).toEqual([true, false, false, false, false]);
  });

  it('offers the accepted handovers of the project with the day they were accepted in Vietnam', () => {
    const line = (overrides: Partial<HandoverLine>): HandoverLine => ({ id: 'h', handoverNo: 'BG', status: 'ACCEPTED', projectId: 'p-1', acceptedAt: '2027-01-14T17:30:00.000000Z', ...overrides }) as HandoverLine;
    expect(acceptedHandovers([line({ id: 'a' }), line({ id: 'b', status: 'DRAFT' }), line({ id: 'c', projectId: 'p-2' }), line({ id: 'd', acceptedAt: null }), line({ id: 'e', acceptedAt: 'nope' })], 'p-1')).toEqual([
      { id: 'a', handoverNo: 'BG', acceptedOn: '2027-01-15' },
    ]);
  });

  it('asks for a kind, a handover for a trigger after a handover, and a real day that is not before the earliest', () => {
    expect(validateSchedule(EMPTY_FORM, [HANDOVER])).toEqual({ kind: 'required', dueOn: 'required' });
    expect(validateSchedule({ kind: 'WHENEVER', handoverId: '', dueOn: '2999-01-01' }, [HANDOVER])).toEqual({ kind: 'invalid' });
    expect(validateSchedule({ kind: 'POST_HANDOVER_12M', handoverId: '', dueOn: '2028-01-15' }, [HANDOVER])).toEqual({ handover: 'required' });
    expect(validateSchedule({ kind: 'POST_HANDOVER_12M', handoverId: 'other', dueOn: '2028-01-15' }, [HANDOVER])).toEqual({ handover: 'invalid' });
    expect(validateSchedule({ kind: 'MANUAL', handoverId: 'other', dueOn: '2999-01-01' }, [HANDOVER])).toEqual({ handover: 'invalid' });
    expect(validateSchedule({ kind: 'MANUAL', handoverId: '', dueOn: '2027-02-30' }, [HANDOVER])).toEqual({ dueOn: 'invalid' });
    expect(validateSchedule({ kind: 'POST_HANDOVER_12M', handoverId: HANDOVER.id, dueOn: '2028-01-14' }, [HANDOVER])).toEqual({ dueOn: 'early' });
    expect(validateSchedule({ kind: 'POST_HANDOVER_24M', handoverId: HANDOVER.id, dueOn: '2028-01-15' }, [HANDOVER])).toEqual({ dueOn: 'early' });
    expect(validateSchedule({ kind: 'POST_HANDOVER_12M', handoverId: HANDOVER.id, dueOn: ' 2028-01-15 ' }, [HANDOVER])).toEqual({});
    expect(validateSchedule({ kind: 'MANUAL', handoverId: HANDOVER.id, dueOn: '2020-01-01' }, [HANDOVER])).toEqual({});
  });

  it('sends the kind, the day without the spaces and the handover only when one is chosen', () => {
    expect(scheduleBody({ kind: 'POST_HANDOVER_12M', handoverId: HANDOVER.id, dueOn: ' 2028-01-15 ' })).toEqual({ trigger_kind: 'POST_HANDOVER_12M', due_on: '2028-01-15', source_handover_id: HANDOVER.id });
    expect(scheduleBody({ kind: 'MANUAL', handoverId: '', dueOn: '2999-01-01' })).toEqual({ trigger_kind: 'MANUAL', due_on: '2999-01-01' });
    expect([isEvaluationId(' 00000000-0000-4000-8000-000000000001 '), isEvaluationId('x'), isEvaluationId('')]).toEqual([true, false, false]);
  });

  it('names the refusals of the server, the reason of a refused datum and the earliest day', () => {
    expect(describeRefusal(problem('TRIGGER_DUPLICATE', {}, 409))).toEqual({ problem: 'duplicate', earliest: undefined });
    expect(describeRefusal(problem('PROJECT_STAGE_INVALID'))).toMatchObject({ problem: 'stage' });
    expect(describeRefusal(problem('HANDOVER_NOT_ACCEPTED'))).toMatchObject({ problem: 'notAccepted' });
    expect(describeRefusal(problem('TRIGGER_STATE_INVALID', {}, 409))).toMatchObject({ problem: 'state' });
    expect(describeRefusal(problem('SCOPE_DENIED', {}, 403))).toMatchObject({ problem: 'scopeDenied' });
    expect(describeRefusal(problem('RESOURCE_NOT_FOUND', {}, 404))).toMatchObject({ problem: 'notFound' });
    expect(describeRefusal(problem('VALIDATION_FAILED'))).toMatchObject({ problem: 'validation' });
    expect(describeRefusal(problem('VALIDATION_FAILED', { reason: 'BEFORE_EARLIEST', earliest_due_on: '2028-01-15' }))).toEqual({ problem: 'early', earliest: '2028-01-15' });
    expect(describeRefusal(problem('VALIDATION_FAILED', { reason: 'IN_THE_PAST' }))).toMatchObject({ problem: 'past' });
    expect(describeRefusal(problem('VALIDATION_FAILED', { reason: 'NOT_A_HANDOVER_OF_THE_PROJECT' }))).toMatchObject({ problem: 'otherProject' });
    expect(describeRefusal(problem('VALIDATION_FAILED', { reason: 'NOT_FOUND' }))).toMatchObject({ problem: 'evaluationMissing' });
    expect(describeRefusal(problem('VALIDATION_FAILED', { reason: 'NOT_AN_EVALUATION_OF_THE_PROJECT' }))).toMatchObject({ problem: 'evaluationOther' });
    expect(describeRefusal(problem('VALIDATION_FAILED', { reason: 'SOMETHING_ELSE' }))).toMatchObject({ problem: 'validation' });
    expect(describeRefusal(problem('INTERNAL_ERROR', {}, 500))).toMatchObject({ problem: 'general' });
    expect(describeRefusal(new Error('down'))).toEqual({ problem: 'general', earliest: undefined });
  });
});
