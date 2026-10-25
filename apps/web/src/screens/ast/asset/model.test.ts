import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { canRegister, describeProblem, emptyRegister, emptyTransfer, registerBody, remainingVnd, toAsset, toAssetList, transferBody, validateRegister, validateTransfer, vietnamToday } from './model';
import type { RegisterForm } from './model';
import { DOCUMENT, asset, assetId, handoverId, unitId } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const TODAY = '2026-10-25';

const filled = (overrides: Partial<RegisterForm> = {}): RegisterForm => ({
  handoverId: handoverId(1),
  assetCode: ' AS-001 ',
  name: ' Trạm bơm ',
  recipientUnitId: unitId(1),
  valueVnd: ' 3200000000 ',
  valueBasis: 'CONTRACT_VALUE',
  fundingOrigin: '',
  warrantyUntil: '',
  ...overrides,
});

describe('toAsset', () => {
  it('reads an asset with its handover, its unit, its figures, its status and whether it may be transferred', () => {
    const read = toAsset(asset(1, { status: 'TRANSFERRED', transferred_on: '2026-10-24', external_asset_id: 'TS-1', warranty_until: '2027-10-24', allowed: { transfer: true } }));
    expect(read).toMatchObject({
      id: assetId(1),
      assetCode: 'AS-001',
      name: 'Trạm bơm 1',
      handover: { id: handoverId(1), handoverNo: 'BG-001', status: 'ACCEPTED' },
      contract: { code: 'HD-A-002', valueVnd: '10000000000' },
      recipientUnit: { id: unitId(1), name: 'Sở Giao thông' },
      valueVnd: '3200000000',
      valueBasis: 'CONTRACT_VALUE',
      contractAssetsVnd: '5000000000',
      status: 'TRANSFERRED',
      transferredOn: '2026-10-24',
      externalAssetId: 'TS-1',
      warrantyUntil: '2027-10-24',
      canTransfer: true,
      version: 1,
    });
  });

  it('keeps what is hidden or missing as nothing and refuses what cannot be shown', () => {
    expect(
      toAsset({ ...asset(1), value_vnd: null, value_basis: null, contract_assets_vnd: null, contract: { id: 'c', code: 'HD' }, allowed: null, handover: null, recipient_unit: null }),
    ).toMatchObject({
      valueVnd: null,
      valueBasis: null,
      contractAssetsVnd: null,
      contract: { valueVnd: null },
      canTransfer: false,
      handover: { id: '', handoverNo: null },
      recipientUnit: { id: '', name: '' },
    });
    expect(toAsset(null)).toBeUndefined();
    expect(toAsset({ ...asset(1), status: 'GONE' })).toBeUndefined();
    expect(toAsset({ ...asset(1), version: 'one' })).toBeUndefined();
    expect(toAsset({ ...asset(1), contract: {} })).toBeUndefined();
    expect(toAsset({ ...asset(1), id: 7 })).toBeUndefined();
    expect(toAssetList({ items: [asset(1), { id: 'x' }, asset(2)] }).map((line) => line.id)).toEqual([assetId(1), assetId(2)]);
    expect(toAssetList({ items: 'none' })).toEqual([]);
    expect(toAssetList(undefined)).toEqual([]);
  });

  it('works out what is left of the value of the contract, only when the figures are shown', () => {
    expect(remainingVnd(toAsset(asset(1)) as never)).toBe('5000000000');
    expect(remainingVnd(toAsset(asset(1, { contract_assets_vnd: '10000000000' })) as never)).toBe('0');
    expect(remainingVnd(toAsset(asset(1, { contract_assets_vnd: '12000000000' })) as never)).toBe('0');
    expect(remainingVnd(toAsset(asset(1, { contract_assets_vnd: null })) as never)).toBeUndefined();
    expect(remainingVnd(toAsset(asset(1, { contract: { id: 'c', code: 'HD' } })) as never)).toBeUndefined();
    expect(remainingVnd(toAsset(asset(1, { contract_assets_vnd: 'x' })) as never)).toBeUndefined();
  });
});

describe('registering an asset', () => {
  it('may be done by whoever holds the permission, or when it is not yet known, unless the session is read only', () => {
    expect(canRegister(['asset.manage'], 'FULL')).toBe(true);
    expect(canRegister(undefined, undefined)).toBe(true);
    expect(canRegister(['asset.manage'], 'READ_ONLY')).toBe(false);
    expect(canRegister(['asset_record.read'], 'FULL')).toBe(false);
  });

  it('sees what is wrong before it is sent: whole dong in digits, a basis, a unit and a code', () => {
    expect(validateRegister(filled())).toEqual({});
    expect(Object.keys(validateRegister(emptyRegister())).sort()).toEqual(['assetCode', 'handoverId', 'name', 'recipientUnitId', 'valueBasis', 'valueVnd']);
    expect(validateRegister(emptyRegister(handoverId(2)))).not.toHaveProperty('handoverId');
    expect(validateRegister(filled({ valueVnd: '12.5' }))).toEqual({ valueVnd: 'amount' });
    expect(validateRegister(filled({ valueVnd: '-1' }))).toEqual({ valueVnd: 'amount' });
    expect(validateRegister(filled({ valueVnd: '1'.repeat(25) }))).toEqual({ valueVnd: 'amount' });
    expect(validateRegister(filled({ valueVnd: '0' }))).toEqual({});
    expect(validateRegister(filled({ assetCode: 'x'.repeat(2001), fundingOrigin: 'x'.repeat(2001), warrantyUntil: '2026-02-30' }))).toEqual({
      assetCode: 'tooLong',
      fundingOrigin: 'tooLong',
      warrantyUntil: 'date',
    });
  });

  it('sends the project of the handover, the words trimmed and the optional fields only when given', () => {
    expect(registerBody(filled(), 'p')).toEqual({
      project_id: 'p',
      handover_id: handoverId(1),
      asset_code: 'AS-001',
      name: 'Trạm bơm',
      recipient_unit_id: unitId(1),
      value_vnd: '3200000000',
      value_basis: 'CONTRACT_VALUE',
    });
    expect(registerBody(filled({ fundingOrigin: ' Ngân sách ', warrantyUntil: '2027-10-24', valueBasis: 'SETTLED_VALUE' }), 'p')).toMatchObject({
      funding_origin: 'Ngân sách',
      warranty_until: '2027-10-24',
      value_basis: 'SETTLED_VALUE',
    });
    expect(registerBody(emptyRegister(), 'p').value_basis).toBe('CONTRACT_VALUE');
  });
});

describe('transferring an asset', () => {
  it('sees what is wrong before it is sent: a day that is not in the future and the dossier of the commissioning', () => {
    expect(validateTransfer({ ...emptyTransfer(TODAY), documentVersionId: DOCUMENT }, TODAY)).toEqual({});
    expect(validateTransfer({ transferredOn: '', documentVersionId: '', externalAssetId: '' }, TODAY)).toEqual({ transferredOn: 'required', documentVersionId: 'required' });
    expect(validateTransfer({ transferredOn: '2026-02-30', documentVersionId: 'nope', externalAssetId: 'x'.repeat(2001) }, TODAY)).toEqual({
      transferredOn: 'date',
      documentVersionId: 'uuid',
      externalAssetId: 'tooLong',
    });
    expect(validateTransfer({ transferredOn: '2026-10-26', documentVersionId: DOCUMENT, externalAssetId: '' }, TODAY)).toEqual({ transferredOn: 'future' });
    expect(vietnamToday(new Date('2026-10-25T18:00:00Z'))).toBe('2026-10-26');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('sends the day, the dossier in lower case and the code typed by hand when there is one', () => {
    expect(transferBody({ transferredOn: ' 2026-10-24 ', documentVersionId: ` ${DOCUMENT.toUpperCase()} `, externalAssetId: '' })).toEqual({
      transferred_on: '2026-10-24',
      commissioning_document_version_id: DOCUMENT,
    });
    expect(transferBody({ transferredOn: '2026-10-24', documentVersionId: DOCUMENT, externalAssetId: ' TS-2027-009 ' })).toMatchObject({ external_asset_id: 'TS-2027-009' });
  });
});

describe('describeProblem', () => {
  it('words every refusal the commands can meet, and keeps the figures of a value above the contract', () => {
    expect(describeProblem(problem('HANDOVER_STATE_INVALID', {}, 409))).toEqual({ problem: 'handoverState', detail: undefined });
    expect(describeProblem(problem('VALUE_EXCEEDS_CONTRACT', { total_vnd: '10000000001', contract_value_vnd: '10000000000' }))).toEqual({
      problem: 'valueExceeds',
      detail: { total: '10000000001', contract: '10000000000' },
    });
    expect(describeProblem(problem('VALUE_EXCEEDS_CONTRACT'))).toEqual({ problem: 'valueExceeds', detail: undefined });
    expect(describeProblem(problem('ASSET_CODE_DUPLICATE', {}, 409)).problem).toBe('duplicate');
    expect(describeProblem(problem('ASSET_STATE_INVALID', {}, 409)).problem).toBe('assetState');
    expect(describeProblem(problem('HANDOVER_NOT_ACCEPTED')).problem).toBe('handoverNotAccepted');
    expect(describeProblem(problem('DOCUMENT_NOT_CLEAN')).problem).toBe('notClean');
    expect(describeProblem(problem('VERSION_CONFLICT', {}, 409)).problem).toBe('versionConflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(problem(code, {}, 400)).problem).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', {}, 404)).problem).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED', {}, 401)).problem).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE', {}, 500)).problem).toBe('general');
    expect(describeProblem(new Error('x')).problem).toBe('general');
  });
});
