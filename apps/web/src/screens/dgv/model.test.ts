import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_REGISTER_FORM, describeProblem, freshnessOf, registerBody, toDataset, toMember, validateOwnership, validateRegister } from './model';
import type { RegisterForm } from './model';
import { dataset, member, MEMBER_ONE, MEMBER_TWO } from './test-support';

const problem = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

const valid: RegisterForm = {
  ...EMPTY_REGISTER_FORM,
  datasetCode: 'DS-TREASURY',
  title: 'Treasury payments',
  domain: 'TREASURY',
  grain: 'one row per payment order',
  producerModule: 'PAY',
  ownerId: MEMBER_ONE,
  stewardId: MEMBER_TWO,
};

describe('toDataset', () => {
  it('reads a dataset of the catalogue with the names of its people and its contract', () => {
    expect(toDataset(dataset(1, { contract_revision: 3, quality_badge: 'STALE', status: 'ACTIVE', is_critical: true }))).toMatchObject({
      datasetCode: 'DS-1',
      ownerName: 'Nguyen Van An',
      stewardName: 'Tran Thi Binh',
      classification: 'INTERNAL',
      isCritical: true,
      contractRevision: 3,
      qualityBadge: 'STALE',
      status: 'ACTIVE',
      version: 1,
    });
    expect(toDataset(dataset(1, { owner_name: null, contract_revision: null }))).toMatchObject({ ownerName: null, contractRevision: null });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['without an id', { ...dataset(1), id: undefined }],
    ['with a classification that is not one', dataset(1, { classification: 'SECRET' })],
    ['with a status that is not one', dataset(1, { status: 'GONE' })],
    ['with a badge that is not one', dataset(1, { quality_badge: 'GOOD' })],
    ['with a critical flag that is not a boolean', dataset(1, { is_critical: 'yes' })],
    ['with a freshness that is not a whole number', dataset(1, { freshness_slo_seconds: 1.5 })],
    ['without a version', dataset(1, { version: undefined })],
  ])('drops a row that is %s', (_name, raw) => {
    expect(toDataset(raw)).toBeUndefined();
  });
});

describe('toMember', () => {
  it('keeps an active member of the staff and drops guests, service accounts, members who are not active and rows without a name', () => {
    expect(toMember(member(1, 'Nguyen Van An'))).toEqual({ id: member(1, '').id, name: 'Nguyen Van An' });
    expect(toMember({ id: 'x', display_name: 'No type', status: 'Active' })).toEqual({ id: 'x', name: 'No type' });
    expect(toMember(member(2, 'Guest', { membership_type: 'GUEST_CONTRACTOR' }))).toBeUndefined();
    expect(toMember(member(3, 'Suspended', { status: 'Suspended' }))).toBeUndefined();
    expect(toMember({ id: 'x', status: 'Active' })).toBeUndefined();
    expect(toMember('x')).toBeUndefined();
  });
});

describe('freshnessOf', () => {
  it.each([
    [86_400, 'days', 1],
    [172_800, 'days', 2],
    [7_200, 'hours', 2],
    [5_400, 'minutes', 90],
    [45, 'seconds', 45],
  ])('reads %i seconds as %s', (seconds, unit, count) => {
    expect(freshnessOf(seconds)).toEqual({ unit, count });
  });
});

describe('validateRegister', () => {
  it('accepts a complete form', () => {
    expect(validateRegister(valid)).toEqual({});
  });

  it('asks for what is missing', () => {
    expect(validateRegister(EMPTY_REGISTER_FORM)).toEqual({
      datasetCode: 'required',
      title: 'required',
      domain: 'required',
      grain: 'required',
      producerModule: 'required',
      ownerId: 'required',
      stewardId: 'required',
    });
  });

  it('checks the length of the texts, the module code and the freshness', () => {
    expect(validateRegister({ ...valid, datasetCode: 'x', title: 'y'.repeat(301), domain: 'z'.repeat(61), grain: 'w'.repeat(201) })).toEqual({ datasetCode: 'tooShort', title: 'tooLong', domain: 'tooLong', grain: 'tooLong' });
    expect(validateRegister({ ...valid, producerModule: 'pay' })).toEqual({ producerModule: 'invalidModule' });
    for (const hours of ['', '0', '-1', '1.5', 'abc', '1000000']) expect(validateRegister({ ...valid, freshnessHours: hours })).toEqual({ freshnessHours: 'invalidNumber' });
  });

  it('requires a critical dataset to have a steward other than its owner, and allows one person in both seats otherwise (AC-ST-DGV-001-1)', () => {
    expect(validateRegister({ ...valid, isCritical: true, stewardId: MEMBER_ONE })).toEqual({ stewardId: 'sameAsOwner' });
    expect(validateRegister({ ...valid, isCritical: false, stewardId: MEMBER_ONE })).toEqual({});
  });
});

describe('validateOwnership', () => {
  const form = { ownerId: MEMBER_ONE, stewardId: MEMBER_TWO, reason: 'The owner moved to another directorate' };

  it('accepts a pair with a reason', () => {
    expect(validateOwnership(form, true)).toEqual({});
  });

  it('asks for the people and a reason of 10 to 1000 characters', () => {
    expect(validateOwnership({ ownerId: '', stewardId: '', reason: '' }, false)).toEqual({ ownerId: 'required', stewardId: 'required', reason: 'required' });
    expect(validateOwnership({ ...form, reason: 'too short' }, false)).toEqual({ reason: 'tooShort' });
    expect(validateOwnership({ ...form, reason: 'x'.repeat(1001) }, false)).toEqual({ reason: 'tooLong' });
  });

  it('keeps the pair of a critical dataset distinct (AC-ST-DGV-001-1)', () => {
    expect(validateOwnership({ ...form, stewardId: MEMBER_ONE }, true)).toEqual({ stewardId: 'sameAsOwner' });
    expect(validateOwnership({ ...form, stewardId: MEMBER_ONE }, false)).toEqual({});
  });
});

describe('registerBody', () => {
  it('turns the form into the request: trimmed texts, the freshness in seconds', () => {
    expect(registerBody({ ...valid, datasetCode: '  DS-TREASURY ', freshnessHours: ' 48 ', isCritical: true, classification: 'PERSONAL' })).toEqual({
      dataset_code: 'DS-TREASURY',
      title: 'Treasury payments',
      domain: 'TREASURY',
      grain: 'one row per payment order',
      producer_module: 'PAY',
      owner_user_id: MEMBER_ONE,
      steward_user_id: MEMBER_TWO,
      classification: 'PERSONAL',
      is_critical: true,
      freshness_slo_seconds: 172_800,
    });
  });
});

describe('describeProblem', () => {
  it.each([
    ['OWNER_STEWARD_SAME', 'ownerStewardSame'],
    ['DATASET_CODE_DUPLICATE', 'duplicateCode'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['VALIDATION_FAILED', 'validation'],
    ['FIELD_NOT_ALLOWED', 'validation'],
    ['INVALID_REQUEST', 'validation'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['STAGE_TRANSITION_DENIED', 'retired'],
    ['SCOPE_DENIED', 'denied'],
    ['PERMISSION_DENIED', 'denied'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(problem(code, 'owner_user_id'))).toEqual({ reason, field: 'owner_user_id' });
  });

  it('maps a failure that is not an API refusal to the general one', () => {
    expect(describeProblem(new Error('network'))).toEqual({ reason: 'general', field: undefined });
  });
});
