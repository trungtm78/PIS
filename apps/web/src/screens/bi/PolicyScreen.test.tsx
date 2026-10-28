import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import PolicyScreen from './PolicyScreen';
import { EMPTY_POLICY, describePolicyProblem, policyBody, predicateText, toPolicy, validatePolicy } from './policy-model';

const ROUTE = routeOf('BI-08', 'FR-BI-08');
// The datasets are listed under bi.query, which a policy administrator holds too.
const ADMIN = ['bi.policy.manage', 'bi.query'];
const READER = ['bi.query'];
const DATASET = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';
const ROLE = '00000000-0000-4000-8000-0000000000c3';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });

const dataset = (id = DATASET, code = 'DS-TREASURY', dimensions = ['unit', 'fund']) => ({
  id,
  dataset_code: code,
  title: 'Kho bạc',
  source_kind: 'PERIOD_SNAPSHOT',
  grain: 'project',
  join_paths: { dimensions },
  refresh_policy: 'ON_SNAPSHOT_FROZEN',
  status: 'ACTIVE',
  latest_version: null,
});
const policy = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000f0${n}`,
  dataset_id: DATASET,
  revision: n,
  grantee_kind: 'ROLE',
  grantee_ref_id: ROLE,
  row_predicate_ast: { op: 'and', args: [{ op: 'unit_in_scope' }, { op: 'in', field: 'fund', values: ['NSTW'] }] },
  column_masks: { account_no: 'HIDE', beneficiary: 'MASK' },
  hidden_columns: ['account_no'],
  status: 'ACTIVE',
  approved_by: '00000000-0000-4000-8000-0000000000aa',
  version: 2,
  ...overrides,
});

interface World {
  datasets: unknown[] | Error;
  policies: unknown[] | Error;
}

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT' })) {
  const h = harness(() => new Error('unexpected read'), command);
  const readAll = vi.fn((operation: string, input?: unknown) => {
    void input;
    const answer = operation === 'listBiDatasets' ? world.datasets : operation === 'listBiAccessPolicies' ? world.policies : new Error(`unexpected readAll ${operation}`);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('BI-08 row and column access (ST-BI-003, BI BR-BI-05)', () => {
  it('AC-ST-BI-003-1: UAT-AC473 lists the policies of the dataset with who each is for, the condition, the columns hidden and the status, and says the dataset is open', async () => {
    mount(<PolicyScreen route={ROUTE} />, client({ datasets: [dataset()], policies: [policy(1)] }), { permissions: ADMIN });
    const table = await screen.findByTestId('policy-table');
    const row = table.querySelector('tbody tr') as HTMLElement;
    expect(within(row).getByText(vi_['bi.policy.grantee.role'])).toBeTruthy();
    expect(within(row).getByText('account_no')).toBeTruthy();
    expect(within(row).getByText(`(${vi_['bi.policy.inScope']} AND fund ∈ (NSTW))`)).toBeTruthy();
    expect(within(row).getByText(vi_['bi.policy.status.active'])).toBeTruthy();
    expect(screen.getByTestId('policy-openness').getAttribute('data-open')).toBe('true');
    for (const name of ['grantee', 'scope', 'hidden', 'condition', 'status']) {
      expect(within(table).getByRole('columnheader', { name: vi_[`bi.policy.column.${name}` as keyof typeof vi_] })).toBeTruthy();
    }
  });

  it('AC-ST-BI-003-1: UAT-AC473 says the dataset is closed, and refuses every query, when no policy is active, a draft included', async () => {
    mount(<PolicyScreen route={ROUTE} />, client({ datasets: [dataset()], policies: [policy(1, { status: 'DRAFT', approved_by: null })] }), { permissions: ADMIN });
    await screen.findByTestId('policy-table');
    const note = screen.getByTestId('policy-openness');
    expect(note.getAttribute('data-open')).toBe('false');
    expect(note.textContent).toBe(vi_['bi.policy.closed']);
    expect(screen.getByText(vi_['bi.policy.status.draft'])).toBeTruthy();
  });

  it('says a dataset has no policy yet, and that the preview as a user comes with the queries', async () => {
    mount(<PolicyScreen route={ROUTE} />, client({ datasets: [dataset()], policies: [] }), { permissions: ADMIN });
    expect((await screen.findByTestId('policy-none')).textContent).toBe(vi_['bi.policy.noPolicies']);
    expect(screen.getByTestId('policy-preview-note').textContent).toBe(vi_['bi.policy.preview.note']);
  });

  it('reads the policies of the dataset chosen, and follows the choice', async () => {
    const user = userEvent.setup();
    const h = client({ datasets: [dataset(), dataset(OTHER, 'DS-OTHER')], policies: [] });
    mount(<PolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
    await screen.findByTestId('policy-table');
    expect(h.readAll.mock.calls.at(-1)).toEqual(['listBiAccessPolicies', { query: { dataset_id: DATASET } }]);
    await user.selectOptions(screen.getByLabelText(vi_['bi.policy.dataset']), OTHER);
    await waitFor(() => expect(h.readAll.mock.calls.at(-1)).toEqual(['listBiAccessPolicies', { query: { dataset_id: OTHER } }]));
  });

  it('AC-ST-BI-003-1: UAT-AC473 drafts a policy for a role from choices: the rows in scope, an extra condition on a dimension and the columns hidden and masked', async () => {
    const user = userEvent.setup();
    const h = client({ datasets: [dataset()], policies: [] });
    mount(<PolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
    await user.type(await screen.findByLabelText(vi_['bi.policy.form.grantee']), ROLE);
    await user.type(screen.getByLabelText(vi_['bi.policy.form.field']), 'fund');
    await user.type(screen.getByLabelText(vi_['bi.policy.form.values']), 'NSTW, NSDP');
    await user.type(screen.getByLabelText(vi_['bi.policy.form.hidden']), 'account_no');
    await user.type(screen.getByLabelText(vi_['bi.policy.form.masked']), 'beneficiary');
    await user.click(screen.getByRole('button', { name: vi_['bi.policy.form.save'] }));
    expect((await screen.findByTestId('policy-saved')).textContent).toBe(vi_['bi.policy.saved']);
    expect(h.command.mock.calls[0]).toMatchObject([
      'createBiAccessPolicy',
      {
        body: {
          dataset_id: DATASET,
          grantee_kind: 'ROLE',
          grantee_ref_id: ROLE,
          row_predicate_ast: { op: 'and', args: [{ op: 'unit_in_scope' }, { op: 'in', field: 'fund', values: ['NSTW', 'NSDP'] }] },
          column_masks: { account_no: 'HIDE', beneficiary: 'MASK' },
        },
      },
    ]);
  });

  it('names each field that is wrong and sends nothing until they are right', async () => {
    const user = userEvent.setup();
    const h = client({ datasets: [dataset()], policies: [] });
    mount(<PolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
    await user.click(await screen.findByRole('button', { name: vi_['bi.policy.form.save'] }));
    expect(await screen.findByText(vi_['bi.policy.problem.required'])).toBeTruthy();
    await user.type(screen.getByLabelText(vi_['bi.policy.form.grantee']), 'nope');
    await user.click(screen.getByRole('button', { name: vi_['bi.policy.form.save'] }));
    expect(await screen.findByText(vi_['bi.policy.problem.invalidId'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each([
    ['PREDICATE_NOT_ALLOWED', undefined, vi_['bi.policy.refused.predicate']],
    ['DIMENSION_NOT_IN_DATASET', 'fund_x', vi_['bi.policy.refused.dimension'].replace('{field}', 'fund_x')],
    ['VALIDATION_FAILED', 'grantee_ref_id', vi_['bi.policy.refused.invalid'].replace('{field}', 'grantee_ref_id')],
    ['SCOPE_DENIED', undefined, vi_['bi.policy.refused.denied']],
    ['INTERNAL_ERROR', undefined, vi_['bi.policy.refused.general']],
  ])('AC-ST-BI-003-2: UAT-AC476 says what the server refused: %s', async (code, detail, message) => {
    const user = userEvent.setup();
    mount(<PolicyScreen route={ROUTE} />, client({ datasets: [dataset()], policies: [] }, () => failure(code === 'INTERNAL_ERROR' ? 500 : 422, code, detail)), { permissions: ADMIN });
    await user.type(await screen.findByLabelText(vi_['bi.policy.form.grantee']), ROLE);
    await user.click(screen.getByRole('button', { name: vi_['bi.policy.form.save'] }));
    await waitFor(() => expect(screen.getByTestId('policy-refused').textContent).toBe(message));
  });

  it('shows no form to whoever may not draft policies, nor while the tenant is read-only', async () => {
    mount(<PolicyScreen route={ROUTE} />, client({ datasets: [dataset()], policies: [] }), { permissions: READER });
    await screen.findByTestId('policy-table');
    expect(screen.queryByRole('button', { name: vi_['bi.policy.form.save'] })).toBeNull();
    cleanup();
    mount(<PolicyScreen route={ROUTE} />, client({ datasets: [dataset()], policies: [] }), { permissions: ADMIN, mode: 'READ_ONLY' });
    await screen.findByTestId('policy-table');
    expect(screen.queryByRole('button', { name: vi_['bi.policy.form.save'] })).toBeNull();
  });

  describe('the seven standard states', () => {
    it.each([
      ['empty', { datasets: [], policies: [] }, vi_['states.empty.title']],
      ['denied', { datasets: failure(403, 'SCOPE_DENIED'), policies: [] }, vi_['states.denied.title']],
      ['denied for the policies', { datasets: [dataset()], policies: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { datasets: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), policies: [] }, vi_['states.offline.title']],
      ['error', { datasets: failure(500, 'INTERNAL_ERROR'), policies: [] }, vi_['states.error.title']],
      ['signed out', { datasets: failure(401, 'SESSION_EXPIRED'), policies: [] }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-BI-08 shows the %s state', async (_name, world, title) => {
      mount(<PolicyScreen route={ROUTE} />, client(world), { permissions: ADMIN });
      expect(await screen.findByText(title)).toBeTruthy();
    });

    it('UI-BI-08 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<PolicyScreen route={ROUTE} />, h, { permissions: ADMIN });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['bi.policy.page.title'] })).toBeTruthy();
    });
  });
});

describe('the policy as the screen reads it', () => {
  it('leaves out an entry that lacks what the screen needs and lists the columns hidden', () => {
    expect(toPolicy({ id: 'x' })).toBeUndefined();
    for (const broken of [{ grantee_kind: 'GROUP' }, { status: 'GONE' }, { revision: '1' }, { row_predicate_ast: 'x' }, { column_masks: [] }]) expect(toPolicy(policy(1, broken))).toBeUndefined();
    expect(toPolicy(policy(1, { column_masks: { b: 'HIDE', a: 'HIDE', c: 'MASK', d: 5 } }))).toMatchObject({ hiddenColumns: ['a', 'b'], columnMasks: { a: 'HIDE', b: 'HIDE', c: 'MASK' } });
  });

  it('writes a predicate as a condition and what the grammar does not have as a question mark', () => {
    expect(predicateText({ op: 'unit_in_scope' }, 'in scope')).toBe('in scope');
    expect(predicateText({ op: 'or', args: [{ op: 'eq', field: 'unit', value: 'U1' }, { op: 'not', args: [{ op: 'ne', field: 'project', value: 7 }] }] }, 's')).toBe('(unit = U1 OR NOT project ≠ 7)');
    expect(predicateText({ op: 'raw_sql' }, 's')).toBe('?');
  });

  it('judges the form, and builds the body: a lone scope is the predicate itself, a lone condition needs no scope, and hidden wins over nothing masked twice', () => {
    const valid = { ...EMPTY_POLICY, datasetId: DATASET, granteeRefId: ROLE };
    expect(validatePolicy(valid)).toEqual({});
    expect(policyBody(valid).row_predicate_ast).toEqual({ op: 'unit_in_scope' });
    const onlyCondition = { ...valid, inScope: false, conditionField: 'fund', conditionValues: 'NSTW' };
    expect(policyBody(onlyCondition).row_predicate_ast).toEqual({ op: 'in', field: 'fund', values: ['NSTW'] });
    expect(validatePolicy({ ...valid, inScope: false })).toEqual({ condition: 'needsCondition' });
    expect(validatePolicy({ ...valid, conditionField: 'fund' })).toEqual({ conditionValues: 'needsCondition' });
    expect(validatePolicy({ ...valid, conditionValues: 'NSTW' })).toEqual({ condition: 'needsCondition' });
    expect(validatePolicy({ ...valid, conditionField: 'bad field', conditionValues: 'x' })).toEqual({ condition: 'invalidName' });
    expect(validatePolicy({ ...valid, hiddenColumns: 'a b' })).toEqual({ hiddenColumns: 'invalidName' });
    expect(validatePolicy({ ...valid, maskedColumns: 'a b' })).toEqual({ maskedColumns: 'invalidName' });
    expect(validatePolicy({ ...valid, hiddenColumns: 'a', maskedColumns: 'a' })).toEqual({ maskedColumns: 'bothMasks' });
    expect(validatePolicy({ ...valid, datasetId: '', granteeRefId: '' })).toEqual({ datasetId: 'required', granteeRefId: 'required' });
    expect(policyBody({ ...valid, hiddenColumns: 'a, b', maskedColumns: 'c' }).column_masks).toEqual({ c: 'MASK', a: 'HIDE', b: 'HIDE' });
  });

  it('maps a refusal of the server', () => {
    const refused = (code: string, detail?: string) => describePolicyProblem(new ApiError({ status: 422, code, correlationId: 'c', detail, extensions: {} }));
    expect([refused('PREDICATE_NOT_ALLOWED').reason, refused('DIMENSION_NOT_IN_DATASET', 'x').reason, refused('FIELD_NOT_ALLOWED').reason, refused('SCOPE_DENIED').reason, refused('SESSION_EXPIRED').reason, refused('OTHER').reason]).toEqual(['predicate', 'dimension', 'invalid', 'denied', 'session', 'general']);
    expect(describePolicyProblem(new Error('x'))).toEqual({ reason: 'general', field: '' });
  });
});
