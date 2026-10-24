import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { FIRST_TENANT, mountInSession } from '../adm/security/test-support';
import QualityRulesScreen from './QualityRulesScreen';
import { APPROVER, CONTRACT, ME, OTHER_PERSON, RULE_READER, STEWARD, dataset, mount, problem, qualityClient, qualityWorld, routeOf, ruleRow } from './quality-test-support';

const ROUTE = routeOf('DGV-06', 'FR-DGV-06');
const DATASET_ID = '00000000-0000-4000-8000-000200000001';
const PATH = `/dgv/dgv-06?dataset=${DATASET_ID}`;

afterEach(cleanup);

const DATASETS = [dataset(1, { dataset_code: 'DS-1', title: 'Dataset 1', working_contract_id: CONTRACT, producer_module: 'DIS' }), dataset(2, { dataset_code: 'DS-2', title: 'Dataset 2' })];
const RULES = [
  ruleRow(1, { code: 'R-COMPLETE', status: 'APPROVED', approved_by: ME, approved_by_name: 'Nguyen Van An', threshold_json: { min_pass_rate_pct: '99.500000', warn_pass_rate_pct: '98.000000' } }),
  ruleRow(2, { code: 'R-DRAFT', status: 'DRAFT' }),
  ruleRow(3, { code: 'R-MINE', status: 'DRAFT', created_by: ME, created_by_name: 'Nguyen Van An' }),
  ruleRow(4, { code: 'R-OLD', status: 'SUPERSEDED', dimension: 'UNIQUENESS', expression_ast: { op: 'unique', fields: ['project_id', 'bucket'] }, action_on_fail: 'HARD_BLOCK', severity: 'HIGH', field_path: 'project_id' }),
];
const world = (rules: Array<Record<string, unknown>> = RULES) => qualityWorld({ datasets: DATASETS, rules });
const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const form = () => screen.getByRole('form', { name: vi_['dgv.rules.form.title'] });
const save = () => userEvent.setup().click(within(form()).getByRole('button', { name: vi_['dgv.rules.form.save.action'] }));
const rowOf = (code: string): HTMLElement => document.querySelector(`tr[data-rule-code="${code}"]`) as HTMLElement;
const ready = () => waitFor(() => expect(document.querySelectorAll('tr[data-rule-id]').length).toBeGreaterThan(0));
const ok = () => ({ status: 'DRAFT', resource_version: 1, resource_id: 'new' });

describe('QualityRulesScreen (DGV-06): quality rules (UI-DGV-06)', () => {
  it('asks for a dataset when none is chosen and lists the rule versions of the chosen one', async () => {
    const h = qualityClient(world());
    mount(<QualityRulesScreen route={ROUTE} />, h, RULE_READER, '/dgv/dgv-06');
    expect((await screen.findByTestId('choose-dataset')).textContent).toBe(vi_['dgv.rules.choose.text']);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
    fireEvent.change(screen.getByLabelText(vi_['dgv.rules.dataset.label']), { target: { value: DATASET_ID } });
    await ready();
    expect(h.readAll).toHaveBeenCalledWith('get_resources_quality_rule_version', { query: { dataset_id: DATASET_ID } });
    fireEvent.change(screen.getByLabelText(vi_['dgv.rules.dataset.label']), { target: { value: '' } });
    expect(await screen.findByTestId('choose-dataset')).toBeTruthy();
  });

  it('shows each version with its dimension, field, check, threshold, action, weight, status and people', async () => {
    mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world()), RULE_READER, PATH);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dgv.rules.page.title']);
    const cells = (code: string): string[] => Array.from(rowOf(code).querySelectorAll('td')).map((cell) => cell.textContent ?? '');
    expect(cells('R-COMPLETE')).toEqual([
      `R-COMPLETE${vi_['dgv.score.rule.revision'].replace('{revision}', '1')}`,
      vi_['dgv.quality.dimension.completeness.text'],
      'project_id',
      'not_null project_id',
      `99.500000%${vi_['dgv.rules.threshold.warn'].replace('{value}', '98.000000')}`,
      `${vi_['dgv.quality.action.quarantine.text']}${vi_['dgv.quality.severity.medium.text']}`,
      '3',
      vi_['dgv.quality.ruleStatus.approved.text'],
      `Tran Thi Binh${vi_['dgv.rules.approvedBy.text'].replace('{name}', 'Nguyen Van An')}`,
      '',
    ]);
    expect(cells('R-OLD')[3]).toBe('unique project_id, bucket');
    expect(cells('R-OLD')[7]).toBe(vi_['dgv.quality.ruleStatus.superseded.text']);
    expect(screen.getByRole('table', { name: vi_['dgv.rules.table.aria'] })).toBeTruthy();
  });

  it('says there is no rule yet for a dataset that has none', async () => {
    mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world([])), RULE_READER, PATH);
    expect((await screen.findByTestId('empty-rules')).textContent).toBe(vi_['dgv.rules.empty.text']);
  });

  it('says so when the caller may not read the rules, and reads nothing', async () => {
    const h = qualityClient(world());
    mount(<QualityRulesScreen route={ROUTE} />, h, ['data.catalog.read'], PATH);
    expect((await screen.findByTestId('rules-unreadable')).textContent).toBe(vi_['dgv.rules.unreadable.text']);
    expect(h.readAll).not.toHaveBeenCalledWith('get_resources_quality_rule_version', expect.anything());
  });

  it('shows the error state when the rules cannot be read', async () => {
    mount(<QualityRulesScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS, failing: new Set(['get_resources_quality_rule_version']) })), RULE_READER, PATH);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  describe('approval', () => {
    it('offers to approve a draft that someone else wrote, and not the draft that the caller wrote nor a rule that is not a draft', async () => {
      mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world()), APPROVER, PATH);
      await ready();
      expect(within(rowOf('R-DRAFT')).getByRole('button', { name: vi_['dgv.rules.approve.action'] })).toBeTruthy();
      expect(within(rowOf('R-MINE')).queryByRole('button', { name: vi_['dgv.rules.approve.action'] })).toBeNull();
      expect(within(rowOf('R-MINE')).getByText(vi_['dgv.rules.approve.own.hint'])).toBeTruthy();
      expect(within(rowOf('R-COMPLETE')).queryByRole('button')).toBeNull();
      expect(within(rowOf('R-OLD')).queryByRole('button')).toBeNull();
    });

    it('does not offer approval to a person who may not approve, nor in a read-only workspace', async () => {
      mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world()), STEWARD, PATH);
      await ready();
      expect(screen.queryByRole('button', { name: vi_['dgv.rules.approve.action'] })).toBeNull();
      cleanup();
      mountInSession(<QualityRulesScreen route={ROUTE} />, qualityClient(world()), { tenant: FIRST_TENANT, permissions: APPROVER, mode: 'READ_ONLY' });
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.dataset.label']), { target: { value: DATASET_ID } });
      await ready();
      expect(screen.queryByRole('button', { name: vi_['dgv.rules.approve.action'] })).toBeNull();
      expect(screen.queryByRole('form', { name: vi_['dgv.rules.form.title'] })).toBeNull();
    });

    it('approves against the version that was read', async () => {
      const h = qualityClient(world(), () => ({ status: 'APPROVED', resource_version: 2 }));
      mount(<QualityRulesScreen route={ROUTE} />, h, APPROVER, PATH);
      await ready();
      await userEvent.setup().click(within(rowOf('R-DRAFT')).getByRole('button', { name: vi_['dgv.rules.approve.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('approveQualityRuleVersion');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: RULES[1]?.id }, ifMatchVersion: 1 });
    });

    it.each([
      [problem('SELF_APPROVAL_DENIED', 403), 'dgv.quality.problem.selfApproval.error'],
      [problem('VERSION_CONFLICT', 409), 'dgv.quality.problem.versionConflict.error'],
      [problem('STAGE_TRANSITION_DENIED', 409, 'status'), 'dgv.quality.problem.notDraft.error'],
      [problem('RESOURCE_NOT_FOUND', 404), 'dgv.problem.notFound.error'],
    ])('tells why an approval was refused (%#)', async (error, key) => {
      mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world(), () => error), APPROVER, PATH);
      await ready();
      await userEvent.setup().click(within(rowOf('R-DRAFT')).getByRole('button', { name: vi_['dgv.rules.approve.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe((vi_ as Record<string, string>)[key]);
    });
  });

  describe('writing a rule', () => {
    it('is not offered to a person who may only read', async () => {
      mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world()), RULE_READER, PATH);
      await ready();
      expect(screen.queryByRole('form', { name: vi_['dgv.rules.form.title'] })).toBeNull();
    });

    it('refuses an incomplete form before asking, field by field', async () => {
      const h = qualityClient(world(), ok);
      mount(<QualityRulesScreen route={ROUTE} />, h, STEWARD, PATH);
      await ready();
      type(vi_['dgv.rules.form.minRate.label'], '150');
      type(vi_['dgv.rules.form.warnRate.label'], 'abc');
      type(vi_['dgv.rules.form.weight.label'], '11');
      await save();
      const messages = within(form()).getAllByRole('alert').map((alert) => alert.textContent);
      expect(messages).toEqual(expect.arrayContaining([vi_['dgv.field.required.error'], vi_['dgv.quality.field.invalidRate.error'], vi_['dgv.field.invalidNumber.error']]));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the draft with the expression of the check chosen, for a completeness rule', async () => {
      const h = qualityClient(world(), ok);
      mount(<QualityRulesScreen route={ROUTE} />, h, STEWARD, PATH);
      await ready();
      type(vi_['dgv.rules.form.code.label'], ' R-NEW ');
      type(vi_['dgv.rules.form.field.label'], 'project_id');
      type(vi_['dgv.rules.form.minRate.label'], '99.5');
      type(vi_['dgv.rules.form.warnRate.label'], '98');
      type(vi_['dgv.rules.form.weight.label'], '5');
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.severity.label']), { target: { value: 'HIGH' } });
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.action.label']), { target: { value: 'HARD_BLOCK' } });
      await save();
      expect((await screen.findByTestId('rule-saved')).textContent).toBe(vi_['dgv.rules.form.saved.notice']);
      expect(h.command.mock.calls[0]?.[0]).toBe('createQualityRuleVersion');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: {
          contract_id: CONTRACT,
          code: 'R-NEW',
          dimension: 'COMPLETENESS',
          expression_ast: { op: 'not_null', field: 'project_id' },
          severity: 'HIGH',
          threshold_json: { min_pass_rate_pct: '99.5', warn_pass_rate_pct: '98' },
          action_on_fail: 'HARD_BLOCK',
          criticality_weight: 5,
        },
      });
      expect((screen.getByLabelText(vi_['dgv.rules.form.code.label']) as HTMLInputElement).value).toBe('');
    });

    it('asks for the inputs of each check and builds its expression', async () => {
      const h = qualityClient(world(), ok);
      mount(<QualityRulesScreen route={ROUTE} />, h, STEWARD, PATH);
      await ready();
      const sent = (): Record<string, unknown> => (h.command.mock.calls.at(-1)?.[1] as { body: { expression_ast: Record<string, unknown>; dimension: string } }).body;
      type(vi_['dgv.rules.form.code.label'], 'R-VALIDITY');

      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'VALIDITY' } });
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.operator.label']), { target: { value: 'between' } });
      type(vi_['dgv.rules.form.field.label'], 'rate_total_pct');
      type(vi_['dgv.rules.form.min.label'], '0');
      type(vi_['dgv.rules.form.max.label'], '100');
      await save();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(sent()).toMatchObject({ dimension: 'VALIDITY', expression_ast: { op: 'between', field: 'rate_total_pct', min: '0', max: '100' } });

      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'VALIDITY' } });
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.operator.label']), { target: { value: 'in' } });
      type(vi_['dgv.rules.form.code.label'], 'R-IN');
      type(vi_['dgv.rules.form.field.label'], 'bucket');
      type(vi_['dgv.rules.form.values.label'], 'CURRENT_YEAR, CARRYOVER');
      await save();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(sent()).toMatchObject({ expression_ast: { op: 'in', field: 'bucket', values: ['CURRENT_YEAR', 'CARRYOVER'] } });

      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'VALIDITY' } });
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.operator.label']), { target: { value: 'compare' } });
      type(vi_['dgv.rules.form.code.label'], 'R-CMP');
      type(vi_['dgv.rules.form.field.label'], 'plan_total_vnd');
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.comparator.label']), { target: { value: 'gte' } });
      type(vi_['dgv.rules.form.value.label'], '0');
      await save();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
      expect(sent()).toMatchObject({ expression_ast: { op: 'compare', field: 'plan_total_vnd', cmp: 'gte', value: '0' } });

      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'CONSISTENCY' } });
      type(vi_['dgv.rules.form.code.label'], 'R-CONS');
      type(vi_['dgv.rules.form.field.label'], 'ctmtqg_subset_vnd');
      type(vi_['dgv.rules.form.otherField.label'], 'plan_total_vnd');
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.comparator.label']), { target: { value: 'lte' } });
      await save();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(4));
      expect(sent()).toMatchObject({ dimension: 'CONSISTENCY', expression_ast: { op: 'compare_fields', left: 'ctmtqg_subset_vnd', cmp: 'lte', right: 'plan_total_vnd' } });

      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'UNIQUENESS' } });
      type(vi_['dgv.rules.form.code.label'], 'R-UNIQ');
      type(vi_['dgv.rules.form.fields.label'], 'project_id, bucket');
      await save();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(5));
      expect(sent()).toMatchObject({ expression_ast: { op: 'unique', fields: ['project_id', 'bucket'] } });

      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'TIMELINESS' } });
      type(vi_['dgv.rules.form.code.label'], 'R-AGE');
      type(vi_['dgv.rules.form.seconds.label'], '86400');
      await save();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(6));
      expect(sent()).toMatchObject({ expression_ast: { op: 'snapshot_age_within', seconds: 86400 } });

      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'INTEGRITY' } });
      type(vi_['dgv.rules.form.code.label'], 'R-FK');
      type(vi_['dgv.rules.form.field.label'], 'project_id');
      await save();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(7));
      expect(sent()).toMatchObject({ dimension: 'INTEGRITY', expression_ast: { op: 'reference_exists', field: 'project_id' } });
    });

    it('offers only the checks of the dimension, no accuracy, and for an integrity rule a minimum of 100 and no warn-only action', async () => {
      mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world(), ok), STEWARD, PATH);
      await ready();
      const options = (label: string): string[] => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => (option as HTMLOptionElement).value);
      expect(options(vi_['dgv.rules.form.dimension.label'])).toEqual(['COMPLETENESS', 'UNIQUENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'INTEGRITY']);
      expect(options(vi_['dgv.rules.form.operator.label'])).toEqual(['not_null', 'not_blank']);
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.action.label']), { target: { value: 'WARN' } });
      fireEvent.change(screen.getByLabelText(vi_['dgv.rules.form.dimension.label']), { target: { value: 'INTEGRITY' } });
      expect(options(vi_['dgv.rules.form.operator.label'])).toEqual(['reference_exists']);
      expect(options(vi_['dgv.rules.form.action.label'])).toEqual(['QUARANTINE', 'HARD_BLOCK']);
      expect((screen.getByLabelText(vi_['dgv.rules.form.action.label']) as HTMLSelectElement).value).toBe('QUARANTINE');
      expect((screen.getByLabelText(vi_['dgv.rules.form.minRate.label']) as HTMLInputElement).value).toBe('100');
      expect(screen.getByText(vi_['dgv.rules.form.minRate.integrity'])).toBeTruthy();
      type(vi_['dgv.rules.form.minRate.label'], '99');
      type(vi_['dgv.rules.form.code.label'], 'R-FK');
      type(vi_['dgv.rules.form.field.label'], 'project_id');
      await save();
      expect(within(form()).getByText(vi_['dgv.quality.field.invalidRate.error'])).toBeTruthy();
    });

    it.each([
      [problem('EXPRESSION_NOT_ALLOWED', 422, 'expression_ast'), 'dgv.quality.problem.expressionNotAllowed.error'],
      [problem('THRESHOLD_INVALID', 422, 'threshold_json'), 'dgv.quality.problem.thresholdInvalid.error'],
      [problem('VALIDATION_FAILED', 422, 'contract_id'), 'dgv.problem.validationField.error'],
      [new Error('network'), 'dgv.problem.general.error'],
    ])('tells why the server refused a draft (%#)', async (error, key) => {
      mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world(), () => error), STEWARD, PATH);
      await ready();
      type(vi_['dgv.rules.form.code.label'], 'R-NEW');
      type(vi_['dgv.rules.form.field.label'], 'project_id');
      await save();
      const expected = (vi_ as Record<string, string>)[key] as string;
      await waitFor(() => expect(within(form()).getAllByRole('alert').map((alert) => alert.textContent)).toContain(expected.replace('{field}', 'contract_id')));
      expect(screen.queryByTestId('rule-saved')).toBeNull();
    });

    it('cannot save while the dataset has no working contract, and says why', async () => {
      const bare = qualityWorld({ datasets: [dataset(1, { working_contract_id: null })], rules: [] });
      const h = qualityClient(bare, ok);
      mount(<QualityRulesScreen route={ROUTE} />, h, STEWARD, PATH);
      await screen.findByTestId('empty-rules');
      expect(screen.getByTestId('no-contract').textContent).toBe(vi_['dgv.rules.form.noContract.text']);
      expect((within(form()).getByRole('button', { name: vi_['dgv.rules.form.save.action'] }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(form());
      expect(h.command).not.toHaveBeenCalled();
    });

    it('shows the person who wrote a rule as unknown when the directory has no name', async () => {
      mount(<QualityRulesScreen route={ROUTE} />, qualityClient(world([ruleRow(1, { created_by: OTHER_PERSON, created_by_name: null })])), RULE_READER, PATH);
      await ready();
      expect(rowOf('R-1').textContent).toContain(vi_['dgv.rules.person.unknown']);
    });
  });
});
