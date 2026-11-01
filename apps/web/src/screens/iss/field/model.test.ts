import { describe, expect, it } from 'vitest';
import { emptyResult, toInspectionLine } from '../../qms/inspection/model';
import { EMPTY_RAISE, holds, idsOf, isWorkable, issueFormOf, itemsFromForm, itemsFromRecorded, raiseBody, toSiteCheck, toSiteChecks, validateRaise, withConsent } from './model';
import type { SiteCheck } from './model';
import { inspection, recorded, scheduled } from './test-support';

const check = (raw: Record<string, unknown>): SiteCheck => toSiteCheck(raw) as SiteCheck;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ISS-05 model', () => {
  it('reads an inspection with its project, and nothing that has no project or is not an inspection', () => {
    expect(check(scheduled(1)).projectId).toBe(scheduled(1).project_id);
    expect(toSiteCheck({ ...scheduled(1), project_id: undefined })).toBeUndefined();
    expect(toSiteCheck({ ...scheduled(1), project_id: '' })).toBeUndefined();
    expect(toSiteCheck(null)).toBeUndefined();
    expect(toSiteCheck({ id: 'x' })).toBeUndefined();
    expect(toSiteChecks({ items: [scheduled(1), { id: 'x' }, scheduled(2)] })).toHaveLength(2);
    expect(toSiteChecks(undefined)).toEqual([]);
    expect(toSiteChecks({ items: 'no' })).toEqual([]);
  });

  it('works on a scheduled inspection the caller may record and on a recorded one with failed items, and on no other', () => {
    expect(isWorkable(check(scheduled(1)))).toBe(true);
    expect(isWorkable(check(scheduled(1, { actions: { schedule: false, record: false, cancel: false } })))).toBe(false);
    expect(isWorkable(check(inspection(1)))).toBe(false);
    expect(isWorkable(check(recorded(1, ['FAIL', 'PASS', 'NA'])))).toBe(true);
    expect(isWorkable(check(recorded(1, ['PASS', 'PASS', 'NA'])))).toBe(false);
    expect(isWorkable(check(inspection(1, { status: 'CANCELLED' })))).toBe(false);
  });

  it('takes the failed items from the form, with the words of the inspector, or from what the server recorded', () => {
    const line = toInspectionLine(scheduled(1));
    const items = line?.checklist ?? [];
    const form = emptyResult(items);
    form.answers.DOC = { outcome: 'FAIL', note: ' Thiếu chứng chỉ ' };
    form.answers.SAFE = { outcome: 'FAIL', note: '' };
    form.answers.SAMPLE = { outcome: 'PASS', note: 'Tốt' };
    expect(itemsFromForm(form, items)).toEqual([
      { code: 'DOC', label: 'Hồ sơ vật liệu đầy đủ', note: 'Thiếu chứng chỉ' },
      { code: 'SAFE', label: 'Biện pháp an toàn tại vị trí', note: '' },
    ]);
    expect(itemsFromForm({ ...form, answers: {} }, items)).toEqual([]);
    const done = toInspectionLine(recorded(1, ['FAIL', 'PASS', 'FAIL']));
    expect(itemsFromRecorded(done as NonNullable<typeof done>)).toEqual([
      { code: 'DOC', label: 'Hồ sơ vật liệu đầy đủ', note: 'Thiếu chứng chỉ' },
      { code: 'SAFE', label: 'Biện pháp an toàn tại vị trí', note: '' },
    ]);
  });

  it('builds the issue of an item: the inspection and the item in the title, the words of the inspector or else the item as the description', () => {
    const subject = check(scheduled(1));
    const noted = issueFormOf(subject, { code: 'DOC', label: 'Hồ sơ', note: 'Thiếu chứng chỉ' }, EMPTY_RAISE);
    expect(noted).toMatchObject({ projectId: subject.projectId, title: 'KT-001 · Hồ sơ', description: 'Thiếu chứng chỉ', severity: 'MEDIUM' });
    expect(issueFormOf(subject, { code: 'DOC', label: 'Hồ sơ', note: '' }, EMPTY_RAISE).description).toBe('Hồ sơ');
    expect(issueFormOf(subject, { code: 'DOC', label: 'x'.repeat(300), note: 'y'.repeat(3000) }, EMPTY_RAISE)).toMatchObject({ title: `KT-001 · ${'x'.repeat(191)}`, description: 'y'.repeat(2000) });
  });

  it('asks for the unit and the category, and refuses a position without the consent that keeps it', () => {
    const subject = check(scheduled(1));
    const item = { code: 'DOC', label: 'Hồ sơ', note: '' };
    expect(validateRaise(subject, [], EMPTY_RAISE)).toEqual({});
    expect(validateRaise(subject, [item], EMPTY_RAISE)).toEqual({ ownerUnitId: 'required', categoryVersionId: 'required' });
    const chosen = { ...EMPTY_RAISE, ownerUnitId: 'u', categoryVersionId: 'c' };
    expect(validateRaise(subject, [item], chosen)).toEqual({});
    expect(validateRaise(subject, [item], { ...chosen, geoLat: '10.8', geoLng: '106.7' })).toEqual({ geoConsent: 'consentRequired' });
    expect(validateRaise(subject, [item], { ...chosen, geoConsent: true, geoLat: '10.8', geoLng: '106.7' })).toEqual({});
  });

  it('withdraws the position with the consent', () => {
    const given = withConsent({ ...EMPTY_RAISE, geoLat: '10.8', geoLng: '106.7', geoAccuracy: '5' }, true);
    expect(given).toMatchObject({ geoConsent: true, geoLat: '10.8', geoLng: '106.7', geoAccuracy: '5' });
    expect(withConsent(given, false)).toMatchObject({ geoConsent: false, geoLat: '', geoLng: '', geoAccuracy: '' });
  });

  it('puts the quality module, the contract and the object of the item in the body, and the position only with the consent', async () => {
    const subject = check(scheduled(1));
    const item = { code: 'DOC', label: 'Hồ sơ', note: 'Thiếu' };
    const base = { ...EMPTY_RAISE, ownerUnitId: 'u', categoryVersionId: 'c' };
    const ids = await idsOf(subject.line.id, 'DOC');
    const without = raiseBody(subject, item, { ...base, geoLat: '10.8', geoLng: '106.7' }, ids);
    expect(without).toMatchObject({
      source_module: 'QMS',
      source_ref_id: ids.sourceRefId,
      contract_id: subject.line.contract.id,
      client_operation_id: ids.operationId,
      owner_unit_id: 'u',
      category_version_id: 'c',
    });
    expect(without).not.toHaveProperty('geo_consent');
    expect(without).not.toHaveProperty('geo_lat');
    const withIt = raiseBody(subject, item, { ...base, geoConsent: true, geoLat: '10.8', geoLng: '106.7', geoAccuracy: '4' }, ids);
    expect(withIt).toMatchObject({ geo_consent: true, geo_lat: '10.8', geo_lng: '106.7', geo_accuracy_m: '4' });
  });

  it('derives the same source and operation for the same item and others for another item or another inspection', async () => {
    const a = await idsOf('insp-1', 'DOC');
    expect(await idsOf('insp-1', 'DOC')).toEqual(a);
    expect(a.sourceRefId).toMatch(UUID);
    expect(a.operationId).toMatch(UUID);
    expect(a.sourceRefId).not.toBe(a.operationId);
    expect((await idsOf('insp-1', 'SAFE')).sourceRefId).not.toBe(a.sourceRefId);
    expect((await idsOf('insp-2', 'DOC')).sourceRefId).not.toBe(a.sourceRefId);
  });

  it('holds a permission, or is not told the permissions yet', () => {
    expect(holds(undefined, 'x')).toBe(true);
    expect(holds(['x'], 'x')).toBe(true);
    expect(holds(['y'], 'x')).toBe(false);
  });
});
