import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ADVANCE,
  EMPTY_START,
  advanceBody,
  canEnforce,
  describeRefusal,
  moveChoices,
  needsDocument,
  startBody,
  stepAfter,
  toCase,
  validateAdvance,
  validateStart,
  vietnamToday,
} from './model';
import type { CaseLine } from './model';

const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  parcel: { id: 'p1', parcel_code: 'TB-1/10', status: 'PLAN_APPROVED' },
  household: { id: 'h1', household_code: 'HH-1', head_name: 'N** A' },
  step: 'PERSUASION',
  suspended_from: null,
  started_on: '2026-01-05',
  allowed: { advance: true, suspend: true, next: 'NOTICE' },
  version: 3,
  ...overrides,
});
const line = (overrides: Record<string, unknown> = {}): CaseLine => toCase(raw(overrides)) as CaseLine;
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';

describe('the model of LND-09', () => {
  it('reads a case and leaves out what is not one', () => {
    expect(toCase(undefined)).toBeUndefined();
    expect(toCase({ id: 'x' })).toBeUndefined();
    expect(toCase(raw({ step: 'ODD' }))).toBeUndefined();
    expect(toCase(raw({ parcel: { id: 'p1' } }))).toBeUndefined();
    expect(toCase(raw({ version: '3' }))).toBeUndefined();
    expect(toCase(raw({ started_on: undefined }))).toBeUndefined();
    expect(toCase(raw())).toMatchObject({ id: 'c1', parcelCode: 'TB-1/10', step: 'PERSUASION', household: { code: 'HH-1', headName: 'N** A' }, suspendedFrom: null, legalBasis: '', mayAdvance: true, maySuspend: true, version: 3 });
    expect(toCase(raw({ household: null, allowed: undefined, suspended_from: 'NOTICE', legal_basis: 'Điều 89' }))).toMatchObject({ household: null, mayAdvance: false, maySuspend: false, suspendedFrom: 'NOTICE', legalBasis: 'Điều 89' });
    expect(toCase(raw({ household: { id: 'h1' } }))?.household).toBeNull();
    expect(toCase(raw({ household: { id: 'h1', household_code: 'HH-1' } }))?.household?.headName).toBe('');
  });

  it('follows the flow of the procedure', () => {
    expect(stepAfter('PERSUASION')).toBe('NOTICE');
    expect(stepAfter('EXECUTING')).toBe('COMPLETED');
    expect(stepAfter('COMPLETED')).toBeUndefined();
    expect(stepAfter('SUSPENDED')).toBeUndefined();
    expect(moveChoices(line())).toEqual(['NOTICE', 'SUSPENDED']);
    expect(moveChoices(line({ allowed: { advance: true, suspend: false, next: 'NOTICE' } }))).toEqual(['NOTICE']);
    expect(moveChoices(line({ step: 'COMPLETED', allowed: { advance: false, suspend: false, next: null } }))).toEqual([]);
    expect(moveChoices(line({ step: 'COMPLETED', allowed: { advance: true, suspend: false, next: null } }))).toEqual([]);
    expect(moveChoices(line({ step: 'SUSPENDED', suspended_from: 'ENFORCEMENT_DECISION', allowed: { advance: true, suspend: false, next: null } }))).toEqual(['ENFORCEMENT_DECISION', 'EXECUTING']);
    expect(moveChoices(line({ step: 'SUSPENDED', suspended_from: 'EXECUTING', allowed: { advance: true, suspend: false, next: null } }))).toEqual(['EXECUTING', 'COMPLETED']);
    expect(moveChoices(line({ step: 'SUSPENDED', suspended_from: 'PERSUASION', allowed: { advance: true, suspend: false, next: null } }))).toEqual(['NOTICE']);
    expect(moveChoices(line({ step: 'SUSPENDED', suspended_from: null, allowed: { advance: true, suspend: false, next: null } }))).toEqual([]);
    expect(moveChoices(line({ step: 'SUSPENDED', suspended_from: 'COMPLETED', allowed: { advance: true, suspend: false, next: null } }))).toEqual(['COMPLETED']);
    expect(needsDocument('EXECUTING')).toBe(true);
    expect(needsDocument('NOTICE')).toBe(false);
  });

  it('validates the start form and builds the body with the unit of the household', () => {
    const good = { ...EMPTY_START, parcelId: 'p', householdId: 'h', planId: 'pl', authorityUnitId: 'a', legalBasis: ' Điều 89 ', startedOn: '2026-01-05' };
    expect(validateStart(good, '2026-10-31')).toEqual({});
    expect(validateStart(EMPTY_START, '2026-10-31')).toEqual({ parcel: 'required', household: 'required', plan: 'required', authority: 'required', basis: 'required', startedOn: 'required' });
    expect(validateStart({ ...good, legalBasis: 'x'.repeat(2001) }, '2026-10-31')).toEqual({ basis: 'invalid' });
    expect(validateStart({ ...good, legalBasis: 'x'.repeat(2000) }, '2026-10-31')).toEqual({});
    expect(validateStart({ ...good, startedOn: '2026-02-30' }, '2026-10-31')).toEqual({ startedOn: 'invalid' });
    expect(validateStart({ ...good, startedOn: 'soon' }, '2026-10-31')).toEqual({ startedOn: 'invalid' });
    expect(validateStart({ ...good, startedOn: '2026-11-01' }, '2026-10-31')).toEqual({ startedOn: 'future' });
    expect(validateStart({ ...good, startedOn: '2026-10-31' }, '2026-10-31')).toEqual({});
    expect(startBody(good, 'proj', 'unit')).toEqual({ project_id: 'proj', parcel_id: 'p', household_id: 'h', plan_id: 'pl', owner_unit_id: 'unit', authority_unit_id: 'a', legal_basis: 'Điều 89', started_on: '2026-01-05' });
  });

  it('validates a move against what the step asks for and sends only that', () => {
    const at = line();
    expect(validateAdvance(EMPTY_ADVANCE, at, '2026-10-31')).toEqual({ toStep: 'required' });
    expect(validateAdvance({ ...EMPTY_ADVANCE, toStep: 'COMPLETED' }, at, '2026-10-31').toStep).toBe('invalid');
    expect(validateAdvance({ ...EMPTY_ADVANCE, toStep: 'NOTICE' }, at, '2026-10-31')).toEqual({});
    expect(validateAdvance({ ...EMPTY_ADVANCE, toStep: 'SUSPENDED' }, at, '2026-10-31')).toEqual({ reason: 'required' });
    expect(validateAdvance({ ...EMPTY_ADVANCE, toStep: 'SUSPENDED', reason: 'x'.repeat(2001) }, at, '2026-10-31')).toEqual({ reason: 'invalid' });

    const decision = line({ step: 'NOTICE' });
    expect(validateAdvance({ ...EMPTY_ADVANCE, toStep: 'ORGANIZATION_DECISION' }, decision, '2026-10-31')).toEqual({ document: 'required' });
    expect(validateAdvance({ ...EMPTY_ADVANCE, toStep: 'ORGANIZATION_DECISION', document: 'x' }, decision, '2026-10-31')).toEqual({ document: 'invalid' });
    expect(validateAdvance({ ...EMPTY_ADVANCE, toStep: 'ORGANIZATION_DECISION', document: DOCUMENT }, decision, '2026-10-31')).toEqual({});

    const executing = line({ step: 'ENFORCEMENT_DECISION' });
    const form = { ...EMPTY_ADVANCE, toStep: 'EXECUTING', document: DOCUMENT };
    expect(validateAdvance(form, executing, '2026-10-31')).toEqual({ plannedOn: 'required' });
    expect(validateAdvance({ ...form, plannedOn: '2026-01-04' }, executing, '2026-10-31')).toEqual({ plannedOn: 'invalid' });
    expect(validateAdvance({ ...form, plannedOn: 'soon' }, executing, '2026-10-31')).toEqual({ plannedOn: 'invalid' });
    expect(validateAdvance({ ...form, plannedOn: '2026-01-05' }, executing, '2026-10-31')).toEqual({});

    const completing = line({ step: 'EXECUTING' });
    const done = { ...EMPTY_ADVANCE, toStep: 'COMPLETED' };
    expect(validateAdvance(done, completing, '2026-10-31')).toEqual({ executedOn: 'required' });
    expect(validateAdvance({ ...done, executedOn: '2026-01-04' }, completing, '2026-10-31')).toEqual({ executedOn: 'invalid' });
    expect(validateAdvance({ ...done, executedOn: '2026-11-01' }, completing, '2026-10-31')).toEqual({ executedOn: 'future' });
    expect(validateAdvance({ ...done, executedOn: '2026-10-31' }, completing, '2026-10-31')).toEqual({});

    expect(advanceBody({ ...EMPTY_ADVANCE, toStep: 'NOTICE', document: DOCUMENT, plannedOn: '2026-02-01', reason: 'x' })).toEqual({ to_step: 'NOTICE' });
    expect(advanceBody({ ...form, document: ` ${DOCUMENT.toUpperCase()} `, plannedOn: '2026-02-01', reason: 'x' })).toEqual({ to_step: 'EXECUTING', decision_document_version_id: DOCUMENT, planned_on: '2026-02-01' });
    expect(advanceBody({ ...done, executedOn: '2026-02-02' })).toEqual({ to_step: 'COMPLETED', executed_on: '2026-02-02' });
    expect(advanceBody({ ...EMPTY_ADVANCE, toStep: 'SUSPENDED', reason: ' Chờ ' })).toEqual({ to_step: 'SUSPENDED', suspend_reason: 'Chờ' });
  });

  it('holds the right only outside the read-only mode, and reads anything but an error of the server as a general failure', () => {
    expect(canEnforce(['land.enforce.write'], 'FULL')).toBe(true);
    expect(canEnforce(['land.enforce.write'], 'READ_ONLY')).toBe(false);
    expect(canEnforce(['land.read'], 'FULL')).toBe(false);
    expect(canEnforce(undefined, undefined)).toBe(true);
    expect(describeRefusal(new Error('boom'))).toEqual({ problem: 'general', reason: undefined });
    expect(describeRefusal(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' })).problem).toBe('general');
    expect(describeRefusal(new ApiError({ status: 422, code: 'PRECONDITION_NOT_MET', correlationId: 'c', extensions: { reason: 'PARCEL_STATUS' } }))).toEqual({ problem: 'precondition', reason: 'PARCEL_STATUS' });
  });

  it('counts the day in Vietnam', () => {
    expect(vietnamToday(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10-31');
    expect(vietnamToday(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11-01');
  });
});
