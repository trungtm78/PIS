import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, barsOf, createBody, describeProblem, formOfRevision, hundredths, mayPublish, toPolicy, toPreview, validateForm } from './model';
import type { PolicyForm, PolicyRow } from './model';

const valid = (overrides: Partial<PolicyForm> = {}): PolicyForm => ({ ...EMPTY_FORM, policyCode: 'AVC-2026', legalBasis: 'Quyết định 12/QĐ-UBND', effectiveFrom: '2026-01-01', ...overrides });
const policy = (overrides: Partial<PolicyRow> = {}): PolicyRow => ({
  id: 'p1',
  policyCode: 'AVC-2026',
  revision: 2,
  scopeKind: 'UNIT',
  scopeRefId: 'unit-1',
  scopeValue: null,
  controlObject: 'APPROPRIATION',
  warnPct: '80.00',
  blockPct: '95.50',
  includeReservations: false,
  legalBasis: 'Quyết định 12/QĐ-UBND',
  effectiveFrom: '2026-01-01',
  effectiveUntil: null,
  status: 'DRAFT',
  createdBy: 'ME',
  version: 1,
  ...overrides,
});

describe('the policy as the screen reads it', () => {
  it('reads a policy from the answer of the server, with a safe default for what is missing or unknown', () => {
    expect(
      toPolicy({
        id: 'p1',
        policy_code: 'AVC-1',
        revision: 3,
        scope_kind: 'PROJECT_GROUP',
        scope_ref_id: null,
        scope_value: 'A',
        control_object: 'ALLOCATION_LINE',
        warn_pct: '85.00',
        block_pct: '100.00',
        include_reservations: true,
        legal_basis: 'Basis',
        effective_from: '2026-01-01',
        effective_until: '2026-12-31',
        status: 'PUBLISHED',
        created_by: 'ME',
        version: 2,
      }),
    ).toEqual({
      id: 'p1',
      policyCode: 'AVC-1',
      revision: 3,
      scopeKind: 'PROJECT_GROUP',
      scopeRefId: null,
      scopeValue: 'A',
      controlObject: 'ALLOCATION_LINE',
      warnPct: '85.00',
      blockPct: '100.00',
      includeReservations: true,
      legalBasis: 'Basis',
      effectiveFrom: '2026-01-01',
      effectiveUntil: '2026-12-31',
      status: 'PUBLISHED',
      createdBy: 'ME',
      version: 2,
    });
    expect(toPolicy({ id: 'p2', scope_kind: 'NOPE', status: 'NOPE', control_object: 'NOPE', include_reservations: false })).toMatchObject({ scopeKind: 'TENANT', status: 'DRAFT', controlObject: 'ALLOCATION_LINE', includeReservations: false, revision: 0 });
    expect(toPolicy({ policy_code: 'no id' })).toBeUndefined();
    expect(toPolicy('junk')).toBeUndefined();
  });

  it('reads the preview counts, and zeros when they are missing', () => {
    expect(toPreview({ policy_id: 'p1', control_object: 'APPROPRIATION', total: 5, ok: 3, warn: 1, block: 1 })).toEqual({ policyId: 'p1', controlObject: 'APPROPRIATION', total: 5, ok: 3, warn: 1, block: 1 });
    expect(toPreview(null)).toEqual({ policyId: '', controlObject: 'ALLOCATION_LINE', total: 0, ok: 0, warn: 0, block: 0 });
  });
});

describe('validateForm (AC-ST-CAP-005-2)', () => {
  it('takes a warning not above the block and a block of at most 100, in the hundredths of a percent the server takes', () => {
    expect(validateForm(valid())).toEqual({});
    expect(validateForm(valid({ warnPct: '85.5', blockPct: '85.5' }))).toEqual({});
    expect(validateForm(valid({ warnPct: '0', blockPct: '0' }))).toEqual({});
    expect(hundredths('90')).toBe(9000);
    expect(hundredths(' 12.5 ')).toBe(1250);
    expect(hundredths('1.234')).toBeUndefined();
  });

  it('refuses a warning above the block, a block above 100, and what is not a percentage', () => {
    expect(validateForm(valid({ warnPct: '95', blockPct: '90' }))).toEqual({ warnPct: 'warnAboveBlock' });
    expect(validateForm(valid({ blockPct: '100.01' }))).toEqual({ blockPct: 'above100' });
    expect(validateForm(valid({ warnPct: '101', blockPct: '150' }))).toEqual({ warnPct: 'above100', blockPct: 'above100' });
    expect(validateForm(valid({ warnPct: 'abc', blockPct: '' }))).toEqual({ warnPct: 'notPercentage', blockPct: 'notPercentage' });
    expect(validateForm(valid({ warnPct: '-1' }))).toEqual({ warnPct: 'notPercentage' });
  });

  it('asks for the code in its shape, the scope that the kind needs, the legal basis and the dates', () => {
    expect(validateForm({ ...EMPTY_FORM, warnPct: '90', blockPct: '100' })).toEqual({ policyCode: 'required', legalBasis: 'required', effectiveFrom: 'required' });
    expect(validateForm(valid({ policyCode: 'not valid' }))).toEqual({ policyCode: 'format' });
    expect(validateForm(valid({ scopeKind: 'UNIT' }))).toEqual({ scope: 'required' });
    expect(validateForm(valid({ scopeKind: 'UNIT', scopeRefId: 'u1' }))).toEqual({});
    expect(validateForm(valid({ scopeKind: 'FUND_SOURCE' }))).toEqual({ scope: 'required' });
    expect(validateForm(valid({ scopeKind: 'PROJECT_GROUP', scopeValue: 'A' }))).toEqual({});
    expect(validateForm(valid({ legalBasis: 'ab' }))).toEqual({ legalBasis: 'tooShort' });
    expect(validateForm(valid({ effectiveFrom: '2026-02-30' }))).toEqual({ effectiveFrom: 'notDate' });
    expect(validateForm(valid({ effectiveFrom: 'soon' }))).toEqual({ effectiveFrom: 'notDate' });
    expect(validateForm(valid({ effectiveUntil: '2025-12-31' }))).toEqual({ effectiveUntil: 'beforeStart' });
    expect(validateForm(valid({ effectiveUntil: '2026-13-01' }))).toEqual({ effectiveUntil: 'notDate' });
    expect(validateForm(valid({ effectiveFrom: '', effectiveUntil: '2025-01-01' }))).toEqual({ effectiveFrom: 'required' });
  });
});

describe('createBody and formOfRevision', () => {
  it('sends only what the scope kind names, the thresholds as typed and the period', () => {
    expect(createBody(valid({ policyCode: ' AVC-2026 ', warnPct: ' 85 ', legalBasis: ' Basis here ' }))).toEqual({
      policy_code: 'AVC-2026',
      scope_kind: 'TENANT',
      control_object: 'ALLOCATION_LINE',
      warn_pct: '85',
      block_pct: '100',
      include_reservations: true,
      legal_basis: 'Basis here',
      effective_from: '2026-01-01',
    });
    expect(createBody(valid({ scopeKind: 'UNIT', scopeRefId: 'u1', effectiveUntil: '2026-12-31' }))).toMatchObject({ scope_kind: 'UNIT', scope_ref_id: 'u1', effective_until: '2026-12-31' });
    expect(createBody(valid({ scopeKind: 'FUND_SOURCE', scopeValue: 'NSTW', includeReservations: false }))).toMatchObject({ scope_kind: 'FUND_SOURCE', scope_value: 'NSTW', include_reservations: false });
    expect(createBody(valid({ scopeKind: 'PROJECT_GROUP', scopeValue: 'QTQG' }))).toMatchObject({ scope_value: 'QTQG' });
    expect(createBody(valid())).not.toHaveProperty('scope_ref_id');
    expect(createBody(valid())).not.toHaveProperty('scope_value');
  });

  it('starts the next revision from a policy: the same code, scope and object, the period to be typed', () => {
    expect(formOfRevision(policy())).toEqual({
      policyCode: 'AVC-2026',
      scopeKind: 'UNIT',
      scopeRefId: 'unit-1',
      scopeValue: '',
      controlObject: 'APPROPRIATION',
      warnPct: '80.00',
      blockPct: '95.50',
      includeReservations: false,
      legalBasis: 'Quyết định 12/QĐ-UBND',
      effectiveFrom: '',
      effectiveUntil: '',
    });
    expect(formOfRevision(policy({ scopeKind: 'FUND_SOURCE', scopeRefId: null, scopeValue: 'NSTW' }))).toMatchObject({ scopeRefId: '', scopeValue: 'NSTW' });
  });
});

describe('barsOf', () => {
  it('draws the two thresholds as shares of the bar, at zero for what is not a percentage and never beyond the bar', () => {
    expect(barsOf('90', '100')).toEqual({ warn: 90, block: 100 });
    expect(barsOf('50.5', '75.25')).toEqual({ warn: 50.5, block: 75.25 });
    expect(barsOf('abc', '')).toEqual({ warn: 0, block: 0 });
    expect(barsOf('150', '200')).toEqual({ warn: 100, block: 100 });
  });
});

describe('mayPublish', () => {
  it('offers a draft to someone who holds the right and did not draft it', () => {
    expect(mayPublish(policy(), 'OTHER', true)).toBe(true);
    expect(mayPublish(policy(), 'me', true)).toBe(false);
    expect(mayPublish(policy(), 'OTHER', false)).toBe(false);
    expect(mayPublish(policy({ status: 'PUBLISHED' }), 'OTHER', true)).toBe(false);
    expect(mayPublish(policy(), undefined, true)).toBe(true);
  });
});

describe('describeProblem', () => {
  const failure = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
  it.each([
    ['AVC_THRESHOLD_INVALID', 'threshold'],
    ['VALIDATION_FAILED', 'invalid'],
    ['SELF_APPROVAL_DENIED', 'selfApproval'],
    ['AVC_POLICY_STATE_INVALID', 'state'],
    ['AVC_POLICY_OVERLAP', 'overlap'],
    ['VERSION_CONFLICT', 'conflict'],
    ['SCOPE_DENIED', 'denied'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SESSION_EXPIRED', 'session'],
    ['SOMETHING_ELSE', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(failure(code, 'warn_pct'))).toEqual({ reason, field: 'warn_pct' });
  });

  it('says a failure that is not an answer of the server in general words', () => {
    expect(describeProblem(new Error('offline'))).toEqual({ reason: 'general', field: undefined });
  });
});
