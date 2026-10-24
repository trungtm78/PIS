import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, EMPTY_FORM, amountText, createBody, describeProblem, filterProjects, formOf, isDossierLocked, isFrozen, profileBody, toMasterOption, toProjectLine, toProjectView, toUnitOption, validateForm, workspaceLink } from './model';
import type { ProjectView } from './model';
import { detail, line, master } from './test-support';

const view = (overrides: Record<string, unknown> = {}): ProjectView => toProjectView(detail(1, overrides)) as ProjectView;

describe('the readers of the register', () => {
  it('reads a line and a workspace, and drops what is not a project', () => {
    expect(toProjectLine(line(1))).toMatchObject({ code: 'DA-2026-001', status: 'CONCEPT', nationalProjectCode: null, leaderName: null, version: 1 });
    expect(toProjectLine(line(2, { leader_in_charge: { display_name: 'An' } }))?.leaderName).toBe('An');
    expect(toProjectLine(line(2, { leader_in_charge: {} }))?.leaderName).toBeNull();
    for (const broken of [undefined, null, [], 'x', {}, line(1, { status: 'DRAFT' }), line(1, { version: '1' }), { ...line(1), id: undefined }]) expect(toProjectLine(broken)).toBeUndefined();
    const full = view();
    expect(full).toMatchObject({ area: { businessKey: 'TINH-P' }, projectType: null, classification: 'INTERNAL', totalInvestmentVnd: '500000000000', startYear: 2026, suggestion: { groupKey: 'B', awaitingConfirmation: true, cxn: 'CXN-32' } });
    expect(toProjectView(detail(1, { area: null }))).toBeUndefined();
    expect(toProjectView(detail(1, { classification: 'SECRET' }))).toBeUndefined();
    expect(toProjectView(detail(1, { total_investment_vnd: 5 }))).toBeUndefined();
    expect(toProjectView(detail(1, { group_suggestion: { as_of: 'x' } }))?.suggestion).toBeNull();
    expect(toProjectView(detail(1, { area: { version_id: 'v', business_key: 'K' } }))?.area.label).toBe('K');
    expect(toProjectView(detail(1, { start_year: 'x' }))?.startYear).toBeNull();
  });

  it('reads the units and the entries in force that the form offers', () => {
    expect(toUnitOption({ id: 'u', code: 'U1', name: 'Unit' })).toEqual([{ id: 'u', code: 'U1', name: 'Unit' }]);
    expect(toUnitOption({ id: 'u' })).toEqual([{ id: 'u', code: '', name: '' }]);
    expect(toUnitOption({})).toEqual([]);
    expect(toUnitOption(7)).toEqual([]);
    expect(toMasterOption(master('00000000-0000-4000-8000-000000000001', 'SECTOR', 'K', 'Label'))).toEqual([{ versionId: '00000000-0000-4000-8000-000000000001', masterType: 'SECTOR', businessKey: 'K', label: 'Label' }]);
    expect(toMasterOption(master('00000000-0000-4000-8000-000000000001', 'SECTOR', 'K', 'L', { status: 'RETIRED' }))).toEqual([]);
    expect(toMasterOption({ version_id: 'v', master_type: 'SECTOR', business_key: 'K', status: 'EFFECTIVE' })[0]?.label).toBe('K');
    expect(toMasterOption({ master_type: 'SECTOR' })).toEqual([]);
  });
});

describe('the form', () => {
  const valid = { ...EMPTY_FORM, code: 'DA-1', name: 'Cầu mới', ownerUnitId: 'u', areaVersionId: 'a', totalInvestment: '1000' };

  it('accepts a complete form and names each field that is wrong', () => {
    expect(validateForm(valid, 'create')).toEqual({});
    expect(validateForm(EMPTY_FORM, 'create')).toEqual({ code: 'required', name: 'required', ownerUnitId: 'required', areaVersionId: 'required', totalInvestment: 'required' });
    expect(validateForm({ ...valid, code: 'x'.repeat(51), name: 'x'.repeat(501), totalInvestment: '01' }, 'create')).toEqual({ code: 'tooLong', name: 'tooLong', totalInvestment: 'invalidAmount' });
    expect(validateForm({ ...valid, name: 'ab', totalInvestment: '1.5' }, 'create')).toEqual({ name: 'tooShort', totalInvestment: 'invalidAmount' });
    expect(validateForm({ ...valid, totalInvestment: '0' }, 'create')).toEqual({});
    expect(validateForm({ ...valid, startYear: '1989', endYear: '20x0' }, 'create')).toEqual({ startYear: 'invalidYear', endYear: 'invalidYear' });
    expect(validateForm({ ...valid, startYear: '2030', endYear: '2026' }, 'create')).toEqual({ endYear: 'order' });
    expect(validateForm({ ...valid, startYear: '2026', endYear: '2026' }, 'create')).toEqual({});
    // A profile update does not ask for the code, the unit or the amount: they are not in its allowlist.
    expect(validateForm({ ...EMPTY_FORM, name: 'Tên' }, 'profile')).toEqual({});
  });

  it('builds the body of the creation from what was typed and leaves out what was not', () => {
    expect(createBody(valid)).toEqual({ code: 'DA-1', name: 'Cầu mới', owner_unit_id: 'u', area_master_version_id: 'a', total_investment_vnd: '1000', classification: 'INTERNAL' });
    expect(
      createBody({ ...valid, code: ' DA-2 ', investorUnitId: 'i', decisionAuthorityUnitId: 'd', sectorVersionId: 's', projectTypeVersionId: 't', programVersionId: 'p', startYear: '2026', endYear: '2027', classification: 'PUBLIC' }),
    ).toEqual({
      code: 'DA-2',
      name: 'Cầu mới',
      owner_unit_id: 'u',
      area_master_version_id: 'a',
      total_investment_vnd: '1000',
      classification: 'PUBLIC',
      investor_unit_id: 'i',
      decision_authority_unit_id: 'd',
      sector_master_version_id: 's',
      project_type_master_version_id: 't',
      program_master_version_id: 'p',
      start_year: 2026,
      end_year: 2027,
    });
  });

  it('builds the body of a profile update from the differences only, and from the name and the classification once the dossier is locked (AC-ST-PRJ-001-4)', () => {
    const project = view();
    const same = formOf(project);
    expect(profileBody(project, same)).toEqual({});
    expect(
      profileBody(project, { ...same, name: ' Tên khác ', classification: 'PUBLIC', investorUnitId: 'i', areaVersionId: 'a2', sectorVersionId: 's2', projectTypeVersionId: 't', programVersionId: 'p', startYear: '2027', endYear: '2029' }),
    ).toEqual({
      name: 'Tên khác',
      classification: 'PUBLIC',
      investor_unit_id: 'i',
      area_master_version_id: 'a2',
      sector_master_version_id: 's2',
      project_type_master_version_id: 't',
      program_master_version_id: 'p',
      start_year: 2027,
      end_year: 2029,
    });
    // An emptied optional field is not a request to clear it: the allowlist has no way to unset a master entry.
    expect(profileBody(project, { ...same, sectorVersionId: '', investorUnitId: '', startYear: '', endYear: '' })).toEqual({});
    const locked = view({ status: 'PIPELINE' });
    expect(profileBody(locked, { ...formOf(locked), name: 'Tên mới', classification: 'CONFIDENTIAL', startYear: '2030', areaVersionId: 'a2' })).toEqual({ name: 'Tên mới', classification: 'CONFIDENTIAL' });
    const body = profileBody(project, { ...same, name: 'x y z', totalInvestment: '1' });
    expect(Object.keys(body)).not.toContain('total_investment_vnd');
  });

  it('knows the stages in which the dossier is locked and the ones in which the project is frozen', () => {
    expect(isDossierLocked('CONCEPT')).toBe(false);
    expect(isDossierLocked('APPRAISAL')).toBe(true);
    expect(isFrozen('CLOSED')).toBe(true);
    expect(isFrozen('REJECTED')).toBe(true);
    expect(isFrozen('CANCELLED')).toBe(true);
    expect(isFrozen('SETTLED')).toBe(false);
  });

  it('forms the form of a project with empty fields where it has none', () => {
    const bare = view({ sector: null, start_year: null, end_year: null, investor_unit_id: null });
    expect(formOf(bare)).toMatchObject({ sectorVersionId: '', projectTypeVersionId: '', programVersionId: '', startYear: '', endYear: '' });
  });
});

describe('the list and the refusals', () => {
  const projects = [toProjectLine(line(1)), toProjectLine(line(2, { status: 'IMPLEMENTATION', national_project_code: '7654321' }))].flatMap((item) => (item === undefined ? [] : [item]));

  it('filters the lines by code or name, by stage and by a missing national code', () => {
    expect(filterProjects(projects, EMPTY_FILTER)).toHaveLength(2);
    expect(filterProjects(projects, { ...EMPTY_FILTER, query: ' DA-2026-002 ' }).map((item) => item.code)).toEqual(['DA-2026-002']);
    expect(filterProjects(projects, { ...EMPTY_FILTER, query: 'SỐ 1' }).map((item) => item.code)).toEqual(['DA-2026-001']);
    expect(filterProjects(projects, { ...EMPTY_FILTER, query: 'không có' }).map((item) => item.code)).toEqual([]);
    expect(filterProjects(projects, { ...EMPTY_FILTER, status: 'IMPLEMENTATION' }).map((item) => item.code)).toEqual(['DA-2026-002']);
    expect(filterProjects(projects, { ...EMPTY_FILTER, missingNationalCode: true }).map((item) => item.code)).toEqual(['DA-2026-001']);
  });

  it('maps the failures of a command to the reason the screens tell, and the others to the general one', () => {
    const error = (code: string, detailText?: string) => new ApiError({ status: 422, code, correlationId: 'c', detail: detailText, extensions: {} });
    expect(describeProblem(error('PROJECT_CODE_DUPLICATE'))).toEqual({ reason: 'duplicateCode', field: undefined });
    expect(describeProblem(error('MASTER_NOT_EFFECTIVE', 'sector_master_version_id'))).toEqual({ reason: 'masterNotEffective', field: 'sector_master_version_id' });
    expect(describeProblem(error('INVALID_REQUEST'))).toEqual({ reason: 'validation', field: undefined });
    expect(describeProblem(error('SOMETHING_ELSE'))).toEqual({ reason: 'general', field: undefined });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });

  it('writes an amount in the grouping of the language without turning it into a float, and the address of a workspace', () => {
    expect(amountText('500000000000', 'vi')).toBe(new Intl.NumberFormat('vi').format(500000000000n));
    expect(amountText('9007199254740993', 'en')).toBe('9,007,199,254,740,993');
    expect(amountText('12.50', 'en')).toBe('12');
    expect(amountText('abc', 'en')).toBe('abc');
    expect(workspaceLink('a b')).toBe('/prj/prj-03?id=a+b');
  });
});
