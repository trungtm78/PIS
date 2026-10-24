import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterCreateScreen from './MasterCreateScreen';
import MasterEditScreen from './MasterEditScreen';
import { STEWARD, change, client, mount, record, routeOf, version, world } from './test-support';
import type { World } from './test-support';

const CREATE = routeOf('MDM-25', 'FR-MDM-25');
const EDIT = routeOf('MDM-26', 'FR-MDM-26');
const NEW = record(9, { status: 'DRAFT', master_type: 'FUND_SOURCE', business_key: 'CTMTQG-X', label: 'CT', open_change_request_id: change(9).id });
const DRAFT = change(9, { change_kind: 'CREATE', status: 'DRAFT', version: 1, impact: { counts: {}, total: 0 }, master_record_version: 1 });

afterEach(cleanup);

const attributesText = (id: string): string => (document.getElementById(id) as HTMLTextAreaElement).value;
const choose = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const label = (type: string, name: string): string => vi_[`mdm.attr.${type}.${name}.label` as keyof typeof vi_];

function accepting(state: World, log: Array<[string, unknown]>) {
  return (operation: string, input: unknown): unknown => {
    log.push([operation, input]);
    if (operation === 'proposeMasterRecord') {
      state.records.push(NEW);
      state.changes.push(DRAFT);
      return { operation_id: 'o1', status: 'DRAFT', resource_version: 1, resource_id: NEW.id };
    }
    return { operation_id: 'o2', status: 'DRAFT', resource_version: 1, resource_id: DRAFT.id };
  };
}

describe('the attribute fields of MDM-25', () => {
  it('opens for the type that a catalogue names, with one field per attribute of the type', async () => {
    mount(<MasterCreateScreen route={CREATE} />, client(world()), STEWARD, '/mdm/mdm-25?type=FUND_SOURCE');
    expect((screen.getByLabelText(vi_['mdm.create.type.label']) as HTMLInputElement).value).toBe('FUND_SOURCE');
    expect(screen.getByTestId('typed-attributes')).toBeTruthy();
    for (const name of ['category', 'relation', 'onlending']) expect(screen.getByLabelText(label('fundSource', name))).toBeTruthy();
    // The choices of a list carry their own names, and none is chosen to begin with.
    expect((screen.getByLabelText(label('fundSource', 'category')) as HTMLSelectElement).value).toBe('');
    expect(screen.getByRole('option', { name: vi_['mdm.value.category.ctmtqg'] })).toBeTruthy();
  });

  it('writes what is chosen into the attributes text and sends it', async () => {
    const state = world();
    const log: Array<[string, unknown]> = [];
    mount(<MasterCreateScreen route={CREATE} />, client(state, accepting(state, log)), STEWARD, '/mdm/mdm-25?type=FUND_SOURCE');
    const user = userEvent.setup();
    choose(label('fundSource', 'category'), 'CTMTQG');
    choose(label('fundSource', 'relation'), 'SUBSET_OF');
    choose(label('fundSource', 'onlending'), 'no');
    expect(JSON.parse(attributesText('record-attributes'))).toEqual({ category: 'CTMTQG', relation: 'SUBSET_OF', onlending: false });
    choose(label('fundSource', 'onlending'), '');
    expect(JSON.parse(attributesText('record-attributes'))).toEqual({ category: 'CTMTQG', relation: 'SUBSET_OF' });
    fireEvent.change(screen.getByLabelText(vi_['mdm.create.key.label']), { target: { value: 'CTMTQG-X' } });
    fireEvent.change(screen.getByLabelText(vi_['mdm.create.name.label']), { target: { value: 'CT' } });
    fireEvent.change(screen.getByLabelText(vi_['mdm.create.validFrom.label']), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText(vi_['mdm.create.reason.label']), { target: { value: 'Initial catalogue entry' } });
    await user.click(screen.getByRole('button', { name: vi_['mdm.create.save.action'] }));
    await waitFor(() => expect(log).toHaveLength(1));
    expect((log[0]?.[1] as { body: { attributes: unknown } }).body.attributes).toEqual({ category: 'CTMTQG', relation: 'SUBSET_OF' });
  });

  it('follows the text: an attribute typed as JSON shows in its field, and text that is not an object hides the fields until it is one', async () => {
    mount(<MasterCreateScreen route={CREATE} />, client(world()), STEWARD, '/mdm/mdm-25?type=FUND_SOURCE');
    fireEvent.change(screen.getByLabelText(vi_['mdm.create.attributes.label']), { target: { value: '{"category":"ODA","onlending":true}' } });
    expect((screen.getByLabelText(label('fundSource', 'category')) as HTMLSelectElement).value).toBe('ODA');
    expect((screen.getByLabelText(label('fundSource', 'onlending')) as HTMLSelectElement).value).toBe('yes');
    fireEvent.change(screen.getByLabelText(vi_['mdm.create.attributes.label']), { target: { value: '{oops' } });
    expect(screen.queryByTestId('typed-attributes')).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['mdm.create.attributes.label']), { target: { value: '{"category":"NSTW"}' } });
    expect((screen.getByLabelText(label('fundSource', 'category')) as HTMLSelectElement).value).toBe('NSTW');
  });

  it('has no typed fields for a type that has no form, and takes numbers, text and lists for the types that have one', async () => {
    mount(<MasterCreateScreen route={CREATE} />, client(world()), STEWARD, '/mdm/mdm-25?type=AREA');
    expect(screen.queryByTestId('typed-attributes')).toBeNull();
    cleanup();
    mount(<MasterCreateScreen route={CREATE} />, client(world()), STEWARD, '/mdm/mdm-25?type=DECISION_TYPE');
    fireEvent.change(screen.getByLabelText(label('decisionType', 'template')), { target: { value: 'TPL-1' } });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(label('decisionType', 'requiredFields')), 'number, issued_on');
    expect(JSON.parse(attributesText('record-attributes'))).toEqual({ template: 'TPL-1', required_fields: ['number', 'issued_on'] });
    expect(screen.getByText(vi_['mdm.attr.identifiers.hint'])).toBeTruthy();
    cleanup();
    mount(<MasterCreateScreen route={CREATE} />, client(world()), STEWARD, '/mdm/mdm-25?type=PROJECT_GROUP');
    fireEvent.change(screen.getByLabelText(label('projectGroup', 'rank')), { target: { value: '3' } });
    expect(JSON.parse(attributesText('record-attributes'))).toEqual({ rank: 3 });
    fireEvent.change(screen.getByLabelText(label('projectGroup', 'rank')), { target: { value: '' } });
    expect(attributesText('record-attributes')).toBe('');
  });

  it('offers the funding sources in force for a programme, and the other stages for the steps a stage may lead to', async () => {
    const sources = [record(1, { master_type: 'FUND_SOURCE', business_key: 'CTMTQG-NTM', label: 'Nông thôn mới' }), record(2, { master_type: 'FUND_SOURCE', business_key: 'OLD', status: 'RETIRED' })];
    mount(<MasterCreateScreen route={CREATE} />, client(world({ records: sources })), STEWARD, '/mdm/mdm-25?type=PROGRAM');
    await waitFor(() => expect(screen.getByRole('option', { name: /CTMTQG-NTM/ })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /OLD/ })).toBeNull();
    choose(label('program', 'fundSourceKey'), 'CTMTQG-NTM');
    expect(JSON.parse(attributesText('record-attributes'))).toEqual({ fund_source_key: 'CTMTQG-NTM' });
    cleanup();
    const stages = [record(1, { master_type: 'PROJECT_STAGE', business_key: 'CONCEPT' }), record(2, { master_type: 'PROJECT_STAGE', business_key: 'APPRAISAL' })];
    mount(<MasterCreateScreen route={CREATE} />, client(world({ records: stages })), STEWARD, '/mdm/mdm-25?type=PROJECT_STAGE');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'APPRAISAL' })).toBeTruthy());
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'APPRAISAL' }));
    await user.click(screen.getByRole('checkbox', { name: 'CONCEPT' }));
    expect(JSON.parse(attributesText('record-attributes'))).toEqual({ allowed_next: ['APPRAISAL', 'CONCEPT'] });
    await user.click(screen.getByRole('checkbox', { name: 'APPRAISAL' }));
    expect(JSON.parse(attributesText('record-attributes'))).toEqual({ allowed_next: ['CONCEPT'] });
  });
});

describe('the attribute fields of MDM-26', () => {
  it('starts from the attributes of the version in force and keeps the ones that no field names', async () => {
    const stage = record(1, { master_type: 'PROJECT_STAGE', business_key: 'CONCEPT', label: 'Ý tưởng' });
    const other = record(2, { master_type: 'PROJECT_STAGE', business_key: 'APPRAISAL', label: 'Thẩm định' });
    const state = world({
      records: [stage, other],
      versions: [version(1, 1, { master_type: 'PROJECT_STAGE', code: 'CONCEPT', label: 'Ý tưởng', attributes: { sequence: 1, allowed_next: ['APPRAISAL'], note: 'kept' } })],
    });
    mount(<MasterEditScreen route={EDIT} />, client(state), STEWARD, '/mdm/mdm-26?type=PROJECT_STAGE&key=CONCEPT');
    await waitFor(() => expect((screen.getByLabelText(vi_['mdm.edit.name.label']) as HTMLInputElement).value).toBe('Ý tưởng'));
    expect((screen.getByLabelText(label('projectStage', 'sequence')) as HTMLInputElement).value).toBe('1');
    expect((screen.getByRole('checkbox', { name: 'APPRAISAL' }) as HTMLInputElement).checked).toBe(true);
    choose(label('projectStage', 'terminal'), 'yes');
    expect(JSON.parse(attributesText('edit-attributes'))).toEqual({ sequence: 1, allowed_next: ['APPRAISAL'], note: 'kept', terminal: true });
  });
});
