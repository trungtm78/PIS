import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { routeOf } from '../doc/test-support';
import { FIRST_TENANT, SECOND_TENANT, harness, mountInSession } from './security/test-support';
import { DoaWorkspace } from './DoaWorkspace';
import type { RoleOption } from './doa/hooks';
import { toMatrix } from './doa/model';
import type { DoaMatrixView } from './doa/model';
import { toOrgUnits } from './org-tree/types';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-15', 'FR-ADM-15');
const MANAGER = ['adm.doa.manage'];
const APPROVER = ['adm.doa.approve'];
const BOTH = ['adm.doa.manage', 'adm.doa.approve'];
const READER = ['adm.security.read'];
const OTHER = '00000000-0000-4000-8000-0000000000ee';
const ME = FIRST_TENANT.membershipId;

const unit = (id: string, code: string, name: string, parent: string | null, status = 'Active') => ({
  id,
  code,
  name,
  parent_id: parent,
  valid_from: '2026-01-01',
  valid_until: null,
  unit_type: 'DEPARTMENT',
  status,
  successor_id: null,
  depth: 0,
  version: 1,
});
const UNITS = toOrgUnits([unit('u1', 'PRV', 'Province', null), unit('u2', 'DEP', 'Department', 'u1'), unit('u3', 'BRD', 'Board', 'u2'), unit('u4', 'OLD', 'Dissolved unit', 'u1', 'Dissolved')]);
const ROLES: RoleOption[] = [
  { id: 'r1', code: 'LEADER_BQLGT' },
  { id: 'r2', code: 'LEADER_STC' },
  { id: 'r3', code: 'LEADER_UBND' },
];

const rule = (id: string, min: string, max: string | null, role: string, extra: Record<string, unknown> = {}) => ({
  id,
  document_type: 'FX',
  unit_id: 'u1',
  include_subtree: true,
  amount_min_vnd: min,
  amount_max_vnd: max,
  approver_role_id: role,
  approval_levels: 1,
  requires_distinct_approvers: true,
  ...extra,
});
const matrix = (id: string, revision: number, status: string, rules: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  revision,
  status,
  effective_from: '2026-01-01',
  effective_until: null,
  legal_basis_ref: 'Internal regulation 12/QD-2026',
  created_by: OTHER,
  last_edited_by: OTHER,
  approved_by: status === 'Published' ? OTHER : null,
  published_at: status === 'Published' ? '2026-01-01T00:00:00Z' : null,
  version: status === 'Draft' ? 1 : 2,
  rules,
  ...extra,
});
const THREE = [rule('a', '0', '5000000000', 'r1'), rule('b', '5000000000', '25000000000', 'r2'), rule('c', '25000000000', null, 'r3', { approval_levels: 2 })];
const GAP = [rule('d', '0', '5000000000', 'r1'), rule('e', '6000000000', null, 'r3')];
const MATRICES: DoaMatrixView[] = [
  matrix('m1', 1, 'Published', THREE),
  matrix('m2', 2, 'PendingApproval', THREE, { effective_from: '2027-01-01' }),
  matrix('m3', 3, 'Draft', GAP, { effective_from: '2027-06-01', effective_until: '2028-01-01' }),
  matrix('m4', 4, 'PendingApproval', THREE, { effective_from: '2027-09-01', created_by: ME }),
].flatMap((row) => toMatrix(row) ?? []);

const mount = (options: { matrices?: readonly DoaMatrixView[]; session?: Parameters<typeof mountInSession>[2]; h?: ReturnType<typeof harness> } = {}) => {
  const h = options.h ?? harness(() => new Error('no read'));
  const view = mountInSession(<DoaWorkspace route={ROUTE} matrices={options.matrices ?? MATRICES} units={UNITS} roles={ROLES} />, h, options.session ?? { permissions: BOTH });
  return { h, view };
};
const rowOf = (id: string): HTMLElement => document.querySelector(`[data-matrix-id="${id}"][data-status]`)?.closest("tr") as HTMLElement;
const editor = (): HTMLElement => screen.getByTestId('editor');
const save = (): HTMLButtonElement => within(editor()).getByRole('button', { name: new RegExp(`^(${vi_['adm.doa.draft.save.action']}|${vi_['adm.doa.draft.update.action']})$`) }) as HTMLButtonElement;
const field = (name: string, row: number): HTMLElement => within(editor()).getByLabelText(name.replace('{row}', String(row)));

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

/** Fills the first row of the empty form with a complete first band, as an administrator would. */
async function fillFirstBand(user: ReturnType<typeof userEvent.setup>, max = ''): Promise<void> {
  await user.type(field(vi_['adm.doa.rule.documentType.row'], 1), 'FX');
  await user.selectOptions(field(vi_['adm.doa.rule.unit.row'], 1), 'u1');
  await user.selectOptions(field(vi_['adm.doa.rule.role.row'], 1), 'r1');
  if (max !== '') await user.type(field(vi_['adm.doa.rule.max.row'], 1), max);
}

describe('DoaWorkspace (ADM-15)', () => {
  it('shows the version in view with an audit line, who made and who approved it, and the status of every version as a pill', () => {
    mount();
    const inView = screen.getByTestId('matrix-in-view');
    const line = within(inView).getByRole('list', { name: vi_['ui.auditLine.label'] });
    expect(within(line).getByText('#1')).toBeTruthy();
    expect(within(line).getByText(translator.t('w2adm.doa.audit.publishedAt'))).toBeTruthy();
    const badge = within(inView).getByRole('group', { name: vi_['ui.makerChecker.label'] });
    expect(badge.textContent).toContain(vi_['ui.makerChecker.maker'].replace('{name}', OTHER.slice(0, 8)));
    expect(badge.textContent).toContain(vi_['ui.makerChecker.checker'].replace('{name}', OTHER.slice(0, 8)));
    expect(within(rowOf('m2')).getByText(vi_['adm.doa.status.pendingApproval']).closest('.ui-pill')?.className).toContain('ui-tone-warning');
    expect(within(rowOf('m1')).getByText(vi_['adm.doa.status.published']).closest('.ui-pill')?.className).toContain('ui-tone-success');
  });

  it('says a draft nobody approved yet is waiting for a checker', async () => {
    mount();
    await userEvent.setup().click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.view.action'] }));
    const badge = within(screen.getByTestId('matrix-in-view')).getByRole('group', { name: vi_['ui.makerChecker.label'] });
    expect(within(badge).getByText(vi_['ui.makerChecker.pending'])).toBeTruthy();
  });

  it('draws the bands of the matrix in force with their approvers, and the screen says what it is (AC-ST-ADM-011-3)', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.doa.page.title']);
    const inView = screen.getByTestId('matrix-in-view');
    expect(inView.getAttribute('data-matrix-id')).toBe('m1');
    const segments = [...inView.querySelectorAll('.doa-seg')].map((segment) => [segment.getAttribute('data-kind'), segment.textContent]);
    expect(segments).toEqual([
      ['band', '0 – 5.000.000.000LEADER_BQLGT'],
      ['band', '5.000.000.000 – 25.000.000.000LEADER_STC'],
      ['band', '25.000.000.000 – không giới hạnLEADER_UBND'],
    ]);
    expect(within(inView).getByText(vi_['adm.doa.chart.row'].replace('{documentType}', 'FX').replace('{unit}', 'PRV · Province'))).toBeTruthy();
  });

  it('shows a gap in the bands before anything is submitted, in the chart and as a reason it cannot be submitted (AC-ST-ADM-011-3)', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.edit.action'] }));
    const chart = within(editor()).getByLabelText(vi_['adm.doa.chart.title']);
    const gap = chart.querySelector('.doa-seg[data-kind="gap"]') as HTMLElement;
    expect(gap.textContent).toBe(`${vi_['adm.doa.chart.gap']} 5.000.000.000 – 6.000.000.000`);
    const blockers = within(screen.getByTestId('blockers'));
    expect(blockers.getByText(vi_['adm.doa.blockers.title'])).toBeTruthy();
    expect(blockers.getByText(vi_['adm.doa.error.gap'].replace('{row}', '2'))).toBeTruthy();
    // Mending the gap clears the reason and the gap segment.
    const upper = field(vi_['adm.doa.rule.max.row'], 1);
    await user.clear(upper);
    await user.type(upper, '6000000000');
    expect(chart.querySelector('.doa-seg[data-kind="gap"]')).toBeNull();
    expect(screen.getByText(vi_['adm.doa.blockers.none'])).toBeTruthy();
  });

  it('marks a band that overlaps the one before it and does not let the draft be saved with it', async () => {
    const { h } = mount();
    const user = userEvent.setup();
    await user.click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.edit.action'] }));
    const upper = field(vi_['adm.doa.rule.max.row'], 1);
    await user.clear(upper);
    await user.type(upper, '9000000000');
    const chart = within(editor()).getByLabelText(vi_['adm.doa.chart.title']);
    expect((chart.querySelector('.doa-seg[data-overlap="true"]') as HTMLElement).textContent).toContain(vi_['adm.doa.chart.overlap']);
    expect(within(screen.getByTestId('blockers')).getByText(vi_['adm.doa.error.overlap'].replace('{row}', '2'))).toBeTruthy();
    await user.click(save());
    expect(h.command).not.toHaveBeenCalled();
  });

  it('lists the versions newest first with their period, and says so when there is none', () => {
    mount();
    expect([...document.querySelectorAll('[data-matrix-id][data-status]')].map((row) => row.getAttribute('data-matrix-id'))).toEqual(['m4', 'm3', 'm2', 'm1']);
    expect(within(rowOf('m3')).getByText(vi_['adm.doa.period.closed'].replace('{from}', '2027-06-01').replace('{until}', '2028-01-01'))).toBeTruthy();
    expect(within(rowOf('m1')).getByText(vi_['adm.doa.period.open'].replace('{from}', '2026-01-01'))).toBeTruthy();
    expect(within(rowOf('m2')).getByText(vi_['adm.doa.status.pendingApproval'])).toBeTruthy();
    cleanup();
    mount({ matrices: [] });
    expect(screen.getByText(vi_['adm.doa.versions.empty'])).toBeTruthy();
    expect(screen.queryByTestId('matrix-in-view')).toBeNull();
  });

  it('shows another version when asked', async () => {
    mount();
    await userEvent.setup().click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.view.action'] }));
    expect(screen.getByTestId('matrix-in-view').getAttribute('data-matrix-id')).toBe('m3');
    expect(rowOf('m3').querySelector('[data-matrix-id]')?.getAttribute('aria-current')).toBe('true');
  });

  describe('who approves a document', () => {
    const result = (): string => screen.getByTestId('preview-result').textContent ?? '';

    it('names the approver, the levels and the unit of the rule that applies, at the edges of the bands', async () => {
      mount();
      const user = userEvent.setup();
      const amount = screen.getByLabelText(vi_['adm.doa.preview.amount.label']);
      await user.selectOptions(screen.getByLabelText(vi_['adm.doa.preview.unit.label']), 'u2');
      await user.type(amount, '4999999999');
      expect(result()).toContain('LEADER_BQLGT, 1 cấp duyệt, theo quy tắc của đơn vị PRV · Province.');
      await user.clear(amount);
      await user.type(amount, '5000000000');
      expect(result()).toContain('LEADER_STC, 1 cấp duyệt');
      await user.clear(amount);
      await user.type(amount, '25000000000');
      expect(result()).toContain('LEADER_UBND, 2 cấp duyệt');
      expect(result()).toContain(vi_['adm.doa.preview.distinct.yes']);
    });

    it('judges a document without an amount as 0, and says when one person may approve several levels', async () => {
      const custom = [matrix('m9', 9, 'Published', [rule('z', '0', null, 'r1', { requires_distinct_approvers: false })])].flatMap((row) => toMatrix(row) ?? []);
      mount({ matrices: custom });
      expect(result()).toContain('LEADER_BQLGT');
      expect(result()).toContain(vi_['adm.doa.preview.distinct.no']);
    });

    it('warns when nobody would approve, when the amount is not whole VND and when the document type has no rule', async () => {
      mount({ matrices: [toMatrix(matrix('m9', 9, 'Published', [rule('z', '10', null, 'r1')])) as DoaMatrixView] });
      expect(result()).toBe(vi_['adm.doa.preview.notFound']);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(vi_['adm.doa.preview.amount.label']), '12.5');
      expect(result()).toBe(vi_['adm.doa.preview.amountInvalid']);
    });

    it('judges the version in view, whatever its state, as if it were in force', async () => {
      mount();
      const user = userEvent.setup();
      await user.click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.view.action'] }));
      await user.type(screen.getByLabelText(vi_['adm.doa.preview.amount.label']), '5500000000');
      expect(result()).toBe(vi_['adm.doa.preview.notFound']);
      await user.clear(screen.getByLabelText(vi_['adm.doa.preview.amount.label']));
      await user.type(screen.getByLabelText(vi_['adm.doa.preview.amount.label']), '6000000000');
      expect(result()).toContain('LEADER_UBND');
    });

    it('has nothing to preview without a unit to ask about', () => {
      mountInSession(<DoaWorkspace route={ROUTE} matrices={MATRICES} units={[]} roles={ROLES} />, harness(() => new Error('no read')), { permissions: BOTH });
      expect(screen.getByText(vi_['adm.doa.preview.empty'])).toBeTruthy();
    });
  });

  describe('writing a draft', () => {
    it('sends the first band, with the optional fields as typed, once', async () => {
      const { h } = mount({ matrices: [], h: harness(() => new Error('no read'), () => ({ status: 'DRAFTED', resource_version: 1, resource_id: 'm9' })) });
      const user = userEvent.setup();
      fireEvent.change(screen.getByLabelText(vi_['adm.doa.effectiveFrom.label']), { target: { value: '2026-01-01' } });
      await user.type(screen.getByLabelText(vi_['adm.doa.basis.label']), 'Internal regulation 12/QD-2026');
      await fillFirstBand(user);
      await user.click(save());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createDoaMatrixDraft');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: {
          effective_from: '2026-01-01',
          legal_basis_ref: 'Internal regulation 12/QD-2026',
          rules: [{ document_type: 'FX', unit_id: 'u1', include_subtree: true, amount_min_vnd: '0', approver_role_id: 'r1', approval_levels: 1, requires_distinct_approvers: true }],
        },
      });
      expect((h.command.mock.calls[0]?.[1] as { body: { rules: Array<Record<string, unknown>> } }).body.rules[0]).not.toHaveProperty('amount_max_vnd');
      expect(await screen.findByText(vi_['adm.doa.draft.accepted.notice'])).toBeTruthy();
      // The same text is not saved again; an edit makes it another revision.
      expect(save().disabled).toBe(true);
      fireEvent.submit(screen.getByRole('form', { name: vi_['adm.doa.form.title'] }));
      expect(h.command).toHaveBeenCalledTimes(1);
      await user.type(field(vi_['adm.doa.rule.max.row'], 1), '9');
      expect(save().disabled).toBe(false);
    });

    it('continues the staircase: the next band starts where the last one ends, for the same kind of document, unit and role', async () => {
      const { h } = mount({ matrices: [], h: harness(() => new Error('no read'), () => ({ status: 'DRAFTED', resource_version: 1, resource_id: 'm9' })) });
      const user = userEvent.setup();
      fireEvent.change(screen.getByLabelText(vi_['adm.doa.effectiveFrom.label']), { target: { value: '2026-01-01' } });
      fireEvent.change(screen.getByLabelText(vi_['adm.doa.effectiveUntil.label']), { target: { value: '2027-01-01' } });
      await user.type(screen.getByLabelText(vi_['adm.doa.basis.label']), 'Internal regulation 12/QD-2026');
      await fillFirstBand(user, '5000000000');
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.rules.add.action'] }));
      expect((field(vi_['adm.doa.rule.min.row'], 2) as HTMLInputElement).value).toBe('5000000000');
      expect((field(vi_['adm.doa.rule.documentType.row'], 2) as HTMLInputElement).value).toBe('FX');
      expect((field(vi_['adm.doa.rule.unit.row'], 2) as HTMLSelectElement).value).toBe('u1');
      await user.selectOptions(field(vi_['adm.doa.rule.role.row'], 2), 'r3');
      await user.selectOptions(field(vi_['adm.doa.rule.levels.row'], 2), '2');
      await user.click(field(vi_['adm.doa.rule.distinct.row'], 2));
      await user.click(field(vi_['adm.doa.rule.subtree.row'], 2));
      await user.click(save());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: {
          effective_until: '2027-01-01',
          rules: [
            { amount_min_vnd: '0', amount_max_vnd: '5000000000', approver_role_id: 'r1' },
            { amount_min_vnd: '5000000000', approver_role_id: 'r3', approval_levels: 2, requires_distinct_approvers: false, include_subtree: false },
          ],
        },
      });
      // The second band has no upper end, so the two bands run from 0 to no end.
      expect(screen.getByText(vi_['adm.doa.blockers.none'])).toBeTruthy();
    });

    it('removes a row, and starts a new first band from an empty list', async () => {
      mount({ matrices: [] });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.rules.add.action'] }));
      expect(within(screen.getByTestId('rule-rows')).getAllByRole('row')).toHaveLength(3);
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.rule.remove.row'].replace('{row}', '1') }));
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.rule.remove.row'].replace('{row}', '1') }));
      expect(within(screen.getByTestId('rule-rows')).getAllByRole('row')).toHaveLength(1);
      await user.click(save());
      expect(await screen.findAllByText(vi_['adm.doa.field.required'])).not.toHaveLength(0);
      expect(within(editor()).getAllByRole('alert').length).toBeGreaterThanOrEqual(2);
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.rules.add.action'] }));
      expect((field(vi_['adm.doa.rule.min.row'], 1) as HTMLInputElement).value).toBe('0');
    });

    it('refuses what the form can see is wrong before anything is sent', async () => {
      const { h } = mount({ matrices: [] });
      const user = userEvent.setup();
      fireEvent.change(screen.getByLabelText(vi_['adm.doa.effectiveFrom.label']), { target: { value: '' } });
      await user.click(save());
      expect(screen.getAllByText(vi_['adm.doa.field.required']).length).toBeGreaterThanOrEqual(3);
      expect(screen.getByText(vi_['adm.doa.field.unit'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.doa.field.role'])).toBeTruthy();
      fireEvent.change(screen.getByLabelText(vi_['adm.doa.effectiveFrom.label']), { target: { value: '2026-05-01' } });
      fireEvent.change(screen.getByLabelText(vi_['adm.doa.effectiveUntil.label']), { target: { value: '2026-05-01' } });
      await user.type(screen.getByLabelText(vi_['adm.doa.basis.label']), 'abc');
      await user.type(field(vi_['adm.doa.rule.documentType.row'], 1), 'X'.repeat(61));
      await user.click(save());
      expect(await screen.findByText(vi_['adm.doa.field.order'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.doa.field.tooShort'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.doa.field.tooLong'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('does not offer a unit that was dissolved', () => {
      mount({ matrices: [] });
      const options = [...(field(vi_['adm.doa.rule.unit.row'], 1) as HTMLSelectElement).options].map((option) => option.value);
      expect(options).toEqual(['', 'u1', 'u2', 'u3']);
    });

    it('lists every finding of a matrix the server refused with 422 DOA_MATRIX_INVALID, in its order', async () => {
      const errors = [
        { field: 'rules[1].amount_min_vnd', code: 'OVERLAP' },
        { field: 'rules[0].document_type', code: 'DOCUMENT_TYPE_REQUIRED' },
        { field: 'rules[0].amount_min_vnd', code: 'AMOUNT_INVALID' },
        { field: 'rules[0].amount_max_vnd', code: 'RANGE_INVALID' },
        { field: 'rules[0].amount_min_vnd', code: 'GAP' },
        { field: 'rules[0].amount_min_vnd', code: 'NOT_FROM_ZERO' },
        { field: 'rules[0].amount_max_vnd', code: 'NOT_TO_INFINITY' },
        { field: 'rules', code: 'NO_RULES' },
        { field: 'effective_from', code: 'DATE_INVALID' },
        { field: 'effective_from', code: 'NOT_AFTER_CURRENT' },
        { field: 'rules[2].unit_id', code: 'UNIT_UNKNOWN' },
        { field: 'rules[2].approver_role_id', code: 'ROLE_UNKNOWN' },
        { field: 'x', code: 'SOMETHING_NEW' },
        { code: 'BROKEN' },
      ];
      const { h } = mount({ matrices: [], h: harness(() => new Error('no read'), () => new ApiError({ status: 422, code: 'DOA_MATRIX_INVALID', correlationId: 'c', extensions: { errors } })) });
      const user = userEvent.setup();
      fireEvent.change(screen.getByLabelText(vi_['adm.doa.effectiveFrom.label']), { target: { value: '2026-01-01' } });
      await user.type(screen.getByLabelText(vi_['adm.doa.basis.label']), 'Internal regulation 12/QD-2026');
      await fillFirstBand(user);
      await user.click(save());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const refusal = (await screen.findByText(vi_['adm.doa.problem.matrixInvalid'], { selector: 'p' })).closest('[role="alert"]') as HTMLElement;
      const row = (key: keyof typeof vi_, number: string): string => vi_[key].replace('{row}', number);
      expect(within(refusal).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        row('adm.doa.error.overlap', '2'),
        row('adm.doa.error.documentTypeRequired', '1'),
        row('adm.doa.error.amountInvalid', '1'),
        row('adm.doa.error.rangeInvalid', '1'),
        row('adm.doa.error.gap', '1'),
        row('adm.doa.error.notFromZero', '1'),
        row('adm.doa.error.notToInfinity', '1'),
        row('adm.doa.error.noRules', ''),
        row('adm.doa.error.dateInvalid', ''),
        row('adm.doa.error.notAfterCurrent', ''),
        row('adm.doa.error.unitUnknown', '3'),
        row('adm.doa.error.roleUnknown', '3'),
        vi_['adm.doa.problem.matrixInvalid'],
      ]);
    });

    it('edits a draft in place: the whole draft is replaced with the version of the row', async () => {
      const { h } = mount({ h: harness(() => new Error('no read'), () => ({ status: 'UPDATED', resource_version: 2, resource_id: 'm3' })) });
      const user = userEvent.setup();
      await user.click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.edit.action'] }));
      expect(screen.getByRole('heading', { name: vi_['adm.doa.form.editing.title'] })).toBeTruthy();
      expect((screen.getByLabelText(vi_['adm.doa.effectiveUntil.label']) as HTMLInputElement).value).toBe('2028-01-01');
      expect((field(vi_['adm.doa.rule.min.row'], 2) as HTMLInputElement).value).toBe('6000000000');
      await user.click(within(editor()).getByRole('button', { name: vi_['adm.doa.draft.update.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('updateDoaMatrixDraft');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { matrixId: 'm3' },
        ifMatchVersion: 1,
        body: { effective_from: '2027-06-01', effective_until: '2028-01-01', rules: [{ amount_min_vnd: '0', amount_max_vnd: '5000000000' }, { amount_min_vnd: '6000000000' }] },
      });
      expect(await screen.findByText(vi_['adm.doa.draft.accepted.notice'])).toBeTruthy();
      // The draft stays open for editing, at the version the update made.
      expect(screen.getByRole('heading', { name: vi_['adm.doa.form.editing.title'] })).toBeTruthy();
      await user.type(screen.getByLabelText(vi_['adm.doa.basis.label']), ' amended');
      await user.click(within(editor()).getByRole('button', { name: vi_['adm.doa.draft.update.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command.mock.calls[1]?.[1]).toMatchObject({ path: { matrixId: 'm3' }, ifMatchVersion: 2 });
    });

    it('starts the next revision from any version as a new draft, and a version that is not a draft has no edit in place', async () => {
      const { h } = mount({ h: harness(() => new Error('no read'), () => ({ status: 'DRAFTED', resource_version: 1, resource_id: 'm9' })) });
      const user = userEvent.setup();
      expect(within(rowOf('m1')).queryByRole('button', { name: vi_['adm.doa.edit.action'] })).toBeNull();
      await user.click(within(rowOf('m1')).getByRole('button', { name: vi_['adm.doa.copy.action'] }));
      expect((screen.getByLabelText(vi_['adm.doa.basis.label']) as HTMLInputElement).value).toBe('Internal regulation 12/QD-2026');
      expect(within(screen.getByTestId('rule-rows')).getAllByRole('row')).toHaveLength(4);
      await user.click(save());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createDoaMatrixDraft');
    });

    it.each([
      ['VERSION_CONFLICT', 409, 'adm.doa.problem.conflict'],
      ['DOA_MATRIX_NOT_DRAFT', 409, 'adm.doa.problem.notDraft'],
      ['RESOURCE_NOT_FOUND', 404, 'adm.doa.problem.notFound'],
      ['SCOPE_DENIED', 403, 'adm.doa.problem.denied'],
      ['SESSION_EXPIRED', 401, 'adm.doa.problem.session'],
      ['VALIDATION_FAILED', 422, 'adm.doa.problem.invalid'],
    ] as const)('shows what the server refused for an edit: %s', async (code, status, key) => {
      mount({ h: harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })) });
      const user = userEvent.setup();
      await user.click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.edit.action'] }));
      await user.click(within(editor()).getByRole('button', { name: vi_['adm.doa.draft.update.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
    });
  });

  describe('submitting and deciding', () => {
    it('submits a draft with a reason and the version of the row', async () => {
      const { h } = mount({ session: { permissions: MANAGER }, h: harness(() => new Error('no read'), () => ({ status: 'SUBMITTED', resource_version: 2, resource_id: 'm3' })) });
      const user = userEvent.setup();
      expect(within(rowOf('m1')).queryByRole('button', { name: vi_['adm.doa.submit.action'] })).toBeNull();
      await user.click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.submit.action'] }));
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.panel.confirm.action'] }));
      expect(await screen.findByText(vi_['adm.doa.field.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.type(screen.getByLabelText(vi_['adm.doa.panel.reason.label']), 'Ready for the second person');
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.panel.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('submitDoaMatrix');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { matrixId: 'm3' }, ifMatchVersion: 1, body: { reason: 'Ready for the second person' } });
      expect(await screen.findByText(vi_['adm.doa.submit.accepted.notice'])).toBeTruthy();
      expect(screen.queryByLabelText(vi_['adm.doa.panel.reason.label'])).toBeNull();
    });

    it('shows the findings of a submission the server refused, a gap among them', async () => {
      const errors = [{ field: 'rules[1].amount_min_vnd', code: 'GAP' }];
      mount({ session: { permissions: MANAGER }, h: harness(() => new Error('no read'), () => new ApiError({ status: 422, code: 'DOA_MATRIX_INVALID', correlationId: 'c', extensions: { errors } })) });
      const user = userEvent.setup();
      await user.click(within(rowOf('m3')).getByRole('button', { name: vi_['adm.doa.submit.action'] }));
      await user.type(screen.getByLabelText(vi_['adm.doa.panel.reason.label']), 'Ready for the second person');
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.panel.confirm.action'] }));
      expect(await screen.findByText(vi_['adm.doa.error.gap'].replace('{row}', '2'))).toBeTruthy();
    });

    it.each([
      ['approve', 'adm.doa.approve.action'],
      ['return', 'adm.doa.return.action'],
      ['reject', 'adm.doa.reject.action'],
    ] as const)('sends the %s decision with a reason and the version of the row', async (decision, actionKey) => {
      const { h } = mount({ session: { permissions: APPROVER }, h: harness(() => new Error('no read'), () => ({ status: 'PUBLISHED', resource_version: 3, resource_id: 'm2' })) });
      const user = userEvent.setup();
      await user.click(within(rowOf('m2')).getByRole('button', { name: vi_[actionKey] }));
      await user.type(screen.getByLabelText(vi_['adm.doa.panel.reason.label']), 'Checked against the regulation');
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.panel.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('decideDoaMatrix');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { matrixId: 'm2' }, ifMatchVersion: 2, body: { decision, reason: 'Checked against the regulation', evidence_ids: [] } });
      expect(await screen.findByText(vi_['adm.doa.decision.accepted.notice'])).toBeTruthy();
    });

    it('does not let the author approve their own version: the button is disabled and explains why, while a return stays possible', async () => {
      mount({ session: { permissions: BOTH } });
      const approve = within(rowOf('m4')).getByRole('button', { name: vi_['adm.doa.approve.action'] }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      expect(approve.title).toBe(vi_['adm.doa.approve.selfApproval.hint']);
      expect((within(rowOf('m2')).getByRole('button', { name: vi_['adm.doa.approve.action'] }) as HTMLButtonElement).disabled).toBe(false);
      expect((within(rowOf('m4')).getByRole('button', { name: vi_['adm.doa.return.action'] }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('also disables the approval for whoever edited the draft last', () => {
      const edited = [toMatrix(matrix('m8', 8, 'PendingApproval', THREE, { last_edited_by: ME })) as DoaMatrixView];
      mount({ matrices: edited, session: { permissions: BOTH } });
      expect((within(rowOf('m8')).getByRole('button', { name: vi_['adm.doa.approve.action'] }) as HTMLButtonElement).disabled).toBe(true);
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'adm.doa.problem.selfApproval'],
      ['DOA_STATE_INVALID', 409, 'adm.doa.problem.stateInvalid'],
      ['VERSION_CONFLICT', 409, 'adm.doa.problem.conflict'],
      ['DOA_MATRIX_NOT_DRAFT', 409, 'adm.doa.problem.notDraft'],
    ] as const)('shows what the server refused for a decision: %s', async (code, status, key) => {
      mount({ session: { permissions: APPROVER }, h: harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })) });
      const user = userEvent.setup();
      await user.click(within(rowOf('m2')).getByRole('button', { name: vi_['adm.doa.approve.action'] }));
      await user.type(screen.getByLabelText(vi_['adm.doa.panel.reason.label']), 'Checked against the regulation');
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.panel.confirm.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
    });

    it('closes the reason form without sending anything', async () => {
      const { h } = mount();
      const user = userEvent.setup();
      await user.click(within(rowOf('m2')).getByRole('button', { name: vi_['adm.doa.approve.action'] }));
      await user.click(screen.getByRole('button', { name: vi_['adm.doa.panel.cancel.action'] }));
      expect(screen.queryByLabelText(vi_['adm.doa.panel.reason.label'])).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('who may do what', () => {
    it('offers a reader the versions and the chart without any action', () => {
      mount({ session: { permissions: READER } });
      expect(screen.getByText(vi_['adm.doa.readOnly.notice'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.draft.save.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.rules.add.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.submit.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.approve.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.edit.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.copy.action'] })).toBeNull();
      expect(screen.getByTestId('matrix-in-view')).toBeTruthy();
      expect((field(vi_['adm.doa.rule.documentType.row'], 1) as HTMLInputElement).disabled).toBe(true);
    });

    it('gives a manager no approval and an approver no draft', () => {
      mount({ session: { permissions: MANAGER } });
      expect(screen.queryByRole('button', { name: vi_['adm.doa.approve.action'] })).toBeNull();
      expect(screen.getByRole('button', { name: vi_['adm.doa.draft.save.action'] })).toBeTruthy();
      cleanup();
      mount({ session: { permissions: APPROVER } });
      expect(screen.queryByRole('button', { name: vi_['adm.doa.draft.save.action'] })).toBeNull();
      expect(within(rowOf('m2')).getByRole('button', { name: vi_['adm.doa.approve.action'] })).toBeTruthy();
    });

    it('is read-only in a suspended tenant, whatever the grants say', () => {
      mount({ session: { permissions: BOTH, mode: 'READ_ONLY' } });
      expect(screen.getByText(vi_['adm.doa.frozen.notice'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.draft.save.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['adm.doa.approve.action'] })).toBeNull();
    });

    it('shows every action while the permissions are not known yet', () => {
      mount({ session: { permissions: undefined } });
      expect(screen.getByRole('button', { name: vi_['adm.doa.draft.save.action'] })).toBeTruthy();
      expect(within(rowOf('m2')).getByRole('button', { name: vi_['adm.doa.approve.action'] })).toBeTruthy();
    });

    it('starts over when the person switches tenant: a draft typed for one tenant is never saved into another', async () => {
      const { h, view } = mount({ matrices: [], session: { permissions: BOTH } });
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(vi_['adm.doa.basis.label']), 'Regulation of the first tenant');
      view.rerenderWith({ permissions: BOTH, tenant: SECOND_TENANT });
      expect((screen.getByLabelText(vi_['adm.doa.basis.label']) as HTMLInputElement).value).toBe('');
      expect(h.command).not.toHaveBeenCalled();
    });

    it('stops a decision that was opened before the tenant was suspended', async () => {
      const h = harness(() => new Error('no read'), () => ({ status: 'PUBLISHED', resource_version: 3, resource_id: 'm2' }));
      const { view } = mount({ session: { permissions: APPROVER }, h });
      const user = userEvent.setup();
      await user.click(within(rowOf('m2')).getByRole('button', { name: vi_['adm.doa.approve.action'] }));
      await user.type(screen.getByLabelText(vi_['adm.doa.panel.reason.label']), 'Checked against the regulation');
      view.rerenderWith({ permissions: APPROVER, mode: 'READ_ONLY' });
      expect(screen.queryByRole('button', { name: vi_['adm.doa.panel.confirm.action'] })).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  it('speaks English when asked to', () => {
    translator.setLocale('en');
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en_['adm.doa.page.title']);
    expect(screen.getByTestId('matrix-in-view').querySelector('.doa-seg')?.textContent).toBe('0 – 5,000,000,000LEADER_BQLGT');
  });
});
