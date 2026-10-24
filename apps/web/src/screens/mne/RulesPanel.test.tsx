import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import FormCatalogueScreen from './FormCatalogueScreen';
import { RulesPanel } from './RulesPanel';
import { ME, OTHER, READER, RULE_ADMIN, formRow, formsClient, mount, routeOf, ruleRow } from './test-support';

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const RULES = [
  ruleRow(1),
  ruleRow(2, { status: 'DRAFT', version: 1, created_by: OTHER, reporting_role: 'PROVINCIAL_PEOPLE_COMMITTEE', frequency: 'WEEKLY', due_rule_json: { weekly: 'FRI', time: '16:00' } }),
  ruleRow(3, { status: 'DRAFT', version: 1, created_by: ME }),
  ruleRow(4, { status: 'RETIRED', version: 3, legal_confirmation_ref: 'CXN-10-OK', awaiting_confirmation: false, cxn_refs: [], effective_until: '2026-07-01', frequency: 'ANNUAL', due_rule_json: { period: 'YEAR', month: 2, day: 10, year_offset: 1 } }),
];
const FORMS = [formRow(2), formRow(3, { status: 'DRAFT', version: 1 }), formRow(4, { status: 'RETIRED', effective_until: '2026-07-01' })];

const rowOf = (code: string): HTMLElement => {
  const row = document.querySelector(`tr[data-rule-code="${code}"]`);
  if (row === null) throw new Error(`no row for ${code}`);
  return row as HTMLElement;
};
const panel = (h = formsClient(() => FORMS, () => ({}), () => RULES), permissions: readonly string[] = RULE_ADMIN, mode?: 'READ_ONLY') =>
  mount(<RulesPanel />, h, { permissions, ...(mode === undefined ? {} : { mode }) });

afterEach(cleanup);

describe('MNE-02 obligation rules (ST-MNE-001, MNE F1, BR-MNE-01, BR-MNE-03)', () => {
  it('lists every revision with its form, level, frequency, formula, recipient, legal basis with the CXN label, period and status', async () => {
    panel(undefined, READER);
    await screen.findByText('OVERALL_RULE_1');
    expect(screen.getByRole('table', { name: vi_['mne.rules.table.aria'] })).toBeTruthy();
    const open = within(rowOf('OVERALL_RULE_1'));
    expect(open.getByText(fill(vi_['mne.forms.revision.pill'], { revision: 1 }))).toBeTruthy();
    expect(open.getByText('TT44-M02')).toBeTruthy();
    expect(open.getByText(vi_['mne.calendar.role.investor'])).toBeTruthy();
    expect(open.getByText(vi_['mne.rules.frequency.semiannual'])).toBeTruthy();
    expect(open.getByText('period=H1 month=7 day=10')).toBeTruthy();
    expect(open.getByText('Sở Tài chính')).toBeTruthy();
    expect(open.getByText(fill(vi_['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }))).toBeTruthy();
    expect(open.getByText(fill(vi_['mne.forms.period.open'], { from: '2026-01-01' }))).toBeTruthy();
    expect(open.getByText(vi_['mne.forms.state.published'])).toBeTruthy();
    const weekly = within(rowOf('OVERALL_RULE_2'));
    expect(weekly.getByText(vi_['mne.calendar.role.provincialPeopleCommittee'])).toBeTruthy();
    expect(weekly.getByText(vi_['mne.rules.frequency.weekly'])).toBeTruthy();
    expect(weekly.getByText('weekly=FRI time=16:00')).toBeTruthy();
    expect(weekly.getByText(vi_['mne.forms.state.draft'])).toBeTruthy();
    const retired = within(rowOf('OVERALL_RULE_4'));
    expect(retired.getByText(fill(vi_['mne.forms.confirmation.reference'], { reference: 'CXN-10-OK' }))).toBeTruthy();
    expect(retired.getByText(fill(vi_['mne.forms.period.closed'], { from: '2026-01-01', until: '2026-06-30' }))).toBeTruthy();
    expect(retired.getByText(vi_['mne.forms.state.retired'])).toBeTruthy();
    expect(retired.getByText(vi_['mne.rules.frequency.annual'])).toBeTruthy();
  });

  it('says so when there is no rule, while the rules load, and when the list cannot be read, and reads it again on retry', async () => {
    panel(formsClient(() => FORMS, () => ({}), () => []));
    expect((await screen.findByTestId('empty-rules')).textContent).toBe(vi_['mne.rules.empty.text']);
    cleanup();
    const loading = formsClient(() => FORMS);
    loading.readAll.mockImplementation(() => new Promise(() => undefined));
    panel(loading);
    expect(screen.getByText(vi_['mne.rules.loading.text'])).toBeTruthy();
    cleanup();
    let failing = true;
    panel(formsClient(() => FORMS, () => ({}), () => (failing ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : RULES)));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['mne.rules.error.text']);
    failing = false;
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByText('OVERALL_RULE_1')).toBeTruthy();
  });

  it('is part of the catalogue screen, and a failure of its read leaves the forms in place', async () => {
    mount(<FormCatalogueScreen route={routeOf('MNE-02', 'FR-MNE-02')} />, formsClient(() => FORMS, () => ({}), () => new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER });
    expect(await screen.findByText('TT44-M02')).toBeTruthy();
    expect((await screen.findByTestId('rules-panel')).textContent).toContain(vi_['mne.rules.error.text']);
    expect(screen.getByRole('heading', { level: 2, name: vi_['mne.rules.page.title'] })).toBeTruthy();
  });

  describe('publishing', () => {
    it('offers the publication of a draft that someone else made, tells the maker that another person has to publish, and offers nothing on a published revision', async () => {
      panel();
      await screen.findByText('OVERALL_RULE_2');
      expect(within(rowOf('OVERALL_RULE_2')).getByRole('button', { name: fill(vi_['mne.rules.publish.label'], { code: 'OVERALL_RULE_2', revision: 1 }) })).toBeTruthy();
      expect(within(rowOf('OVERALL_RULE_3')).queryByRole('button')).toBeNull();
      expect(within(rowOf('OVERALL_RULE_3')).getByText(vi_['mne.forms.publish.other.hint'])).toBeTruthy();
      expect(within(rowOf('OVERALL_RULE_1')).queryByRole('button')).toBeNull();
    });

    it('publishes with the version the person saw, says so, and reads the list again', async () => {
      const user = userEvent.setup();
      let reads = 0;
      const h = formsClient(() => FORMS, () => ({}), () => {
        reads += 1;
        return RULES;
      });
      panel(h);
      await screen.findByText('OVERALL_RULE_2');
      await user.click(screen.getByRole('button', { name: fill(vi_['mne.rules.publish.label'], { code: 'OVERALL_RULE_2', revision: 1 }) }));
      const form = screen.getByRole('form', { name: fill(vi_['mne.rules.publish.title'], { code: 'OVERALL_RULE_2', revision: 1 }) });
      expect(within(form).getByText(vi_['mne.rules.publish.hint'])).toBeTruthy();
      await user.click(within(form).getByRole('button', { name: vi_['mne.forms.publish.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('publishMneObligationRule', expect.objectContaining({ path: { id: RULES[1]?.id }, ifMatchVersion: 1 }));
      expect(await screen.findByText(fill(vi_['mne.rules.publish.done.notice'], { code: 'OVERALL_RULE_2', revision: 1 }))).toBeTruthy();
      expect(screen.queryByRole('form', { name: fill(vi_['mne.rules.publish.title'], { code: 'OVERALL_RULE_2', revision: 1 }) })).toBeNull();
      expect(reads).toBeGreaterThanOrEqual(2);
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, vi_['mne.forms.problem.selfApproval.text']],
      ['VERSION_CONFLICT', 409, vi_['mne.forms.problem.conflict.text']],
      ['REPORT_STATE_INVALID', 409, vi_['mne.forms.problem.stateInvalid.text']],
      ['EFFECTIVE_RANGE_OVERLAP', 409, vi_['mne.forms.problem.rangeOverlap.text']],
      ['FORM_NOT_EFFECTIVE', 422, vi_['mne.rules.problem.formNotEffective.text']],
    ])('keeps the panel open and tells the person why when the server answers %s', async (code, status, message) => {
      const user = userEvent.setup();
      panel(formsClient(() => FORMS, () => new ApiError({ status, code, correlationId: 'c' }), () => RULES));
      await screen.findByText('OVERALL_RULE_2');
      await user.click(screen.getByRole('button', { name: fill(vi_['mne.rules.publish.label'], { code: 'OVERALL_RULE_2', revision: 1 }) }));
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.publish.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(screen.getByRole('form', { name: fill(vi_['mne.rules.publish.title'], { code: 'OVERALL_RULE_2', revision: 1 }) })).toBeTruthy();
    });

    it('closes the panel without a command when the person cancels, and offers nothing to a reader or on a suspended tenant', async () => {
      const user = userEvent.setup();
      const h = formsClient(() => FORMS, () => ({}), () => RULES);
      panel(h);
      await screen.findByText('OVERALL_RULE_2');
      await user.click(screen.getByRole('button', { name: fill(vi_['mne.rules.publish.label'], { code: 'OVERALL_RULE_2', revision: 1 }) }));
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.publish.cancel.action'] }));
      expect(screen.queryByRole('form')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
      cleanup();
      panel(undefined, READER);
      await screen.findByText('OVERALL_RULE_2');
      expect(screen.queryByRole('button', { name: vi_['mne.rules.create.open.action'] })).toBeNull();
      expect(within(rowOf('OVERALL_RULE_2')).queryByRole('button')).toBeNull();
      cleanup();
      panel(undefined, RULE_ADMIN, 'READ_ONLY');
      await screen.findByText('OVERALL_RULE_2');
      expect(screen.queryByRole('button', { name: vi_['mne.rules.create.open.action'] })).toBeNull();
      expect(within(rowOf('OVERALL_RULE_2')).queryByRole('button')).toBeNull();
    });
  });

  describe('drafting a revision', () => {
    const open = async (h = formsClient(() => FORMS, () => ({}), () => RULES)) => {
      const user = userEvent.setup();
      panel(h);
      await screen.findByText('OVERALL_RULE_2');
      await user.click(screen.getByRole('button', { name: vi_['mne.rules.create.open.action'] }));
      const form = screen.getByRole('form', { name: vi_['mne.rules.create.title'] });
      // The form options come from the catalogue read: wait for them.
      await waitFor(() => expect(within(form).getAllByRole('option').length).toBeGreaterThan(1));
      return { user, h, form };
    };
    const fillAll = async (user: ReturnType<typeof userEvent.setup>, form: HTMLElement) => {
      await user.type(within(form).getByLabelText(vi_['mne.rules.create.code.label']), 'OVERALL_SEMIANNUAL');
      await user.selectOptions(within(form).getByLabelText(vi_['mne.rules.create.form.label']), String(FORMS[0]?.id));
      await user.selectOptions(within(form).getByLabelText(vi_['mne.rules.create.role.label']), 'INVESTOR');
      await user.selectOptions(within(form).getByLabelText(vi_['mne.rules.create.frequency.label']), 'SEMIANNUAL');
      await user.type(within(form).getByLabelText(vi_['mne.rules.create.recipient.label']), 'Sở Tài chính');
      fireEvent.change(within(form).getByLabelText(vi_['mne.rules.create.from.label']), { target: { value: '2026-01-01' } });
      fireEvent.change(within(form).getByLabelText(vi_['mne.rules.create.due.label']), { target: { value: '{"period":"H1","month":7,"day":10}' } });
      fireEvent.change(within(form).getByLabelText(vi_['mne.rules.create.basis.label']), { target: { value: 'Thông tư 44/2026/TT-BTC [CXN-10]' } });
    };

    it('offers the published revisions of the forms only', async () => {
      const { form } = await open();
      const options = within(form.querySelector('#rule-form') as HTMLElement).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual([vi_['mne.rules.create.form.placeholder'], fill(vi_['mne.rules.create.form.option'], { code: 'TT44-M02', revision: 1 }), fill(vi_['mne.rules.create.form.option'], { code: 'TT44-M04', revision: 1 })]);
    });

    it('tells every field that is missing and sends nothing', async () => {
      const { user, h, form } = await open();
      await user.click(within(form).getByRole('button', { name: vi_['mne.rules.create.submit.action'] }));
      const alerts = within(form).getAllByRole('alert').map((alert) => alert.textContent);
      expect(alerts).toContain(vi_['mne.forms.field.required']);
      expect(alerts.length).toBeGreaterThanOrEqual(6);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('names the other problems: a date order, a formula that is not JSON and a code with a space', async () => {
      const { user, h, form } = await open();
      await fillAll(user, form);
      await user.clear(within(form).getByLabelText(vi_['mne.rules.create.code.label']));
      await user.type(within(form).getByLabelText(vi_['mne.rules.create.code.label']), 'has space');
      fireEvent.change(within(form).getByLabelText(vi_['mne.rules.create.until.label']), { target: { value: '2025-01-01' } });
      fireEvent.change(within(form).getByLabelText(vi_['mne.rules.create.due.label']), { target: { value: '[1]' } });
      await user.click(within(form).getByRole('button', { name: vi_['mne.rules.create.submit.action'] }));
      const alerts = within(form).getAllByRole('alert').map((alert) => alert.textContent);
      expect(alerts).toEqual(expect.arrayContaining([vi_['mne.forms.field.format'], vi_['mne.forms.field.order'], vi_['mne.forms.field.json']]));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the draft with its formula, legal basis and period, says it is saved, and reads the list again', async () => {
      const { user, h, form } = await open();
      await fillAll(user, form);
      await user.click(within(form).getByRole('button', { name: vi_['mne.rules.create.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'createMneObligationRule',
        expect.objectContaining({
          body: {
            rule_code: 'OVERALL_SEMIANNUAL',
            form_id: FORMS[0]?.id,
            reporting_role: 'INVESTOR',
            recipient: 'Sở Tài chính',
            frequency: 'SEMIANNUAL',
            due_rule_json: { period: 'H1', month: 7, day: 10 },
            legal_basis: 'Thông tư 44/2026/TT-BTC [CXN-10]',
            effective_from: '2026-01-01',
          },
        }),
      );
      expect(await screen.findByText(fill(vi_['mne.rules.create.done.notice'], { code: 'OVERALL_SEMIANNUAL' }))).toBeTruthy();
      expect(screen.queryByRole('form', { name: vi_['mne.rules.create.title'] })).toBeNull();
    });

    it('sends the reference and the end of the period when they are written', async () => {
      const { user, h, form } = await open();
      await fillAll(user, form);
      await user.type(within(form).getByLabelText(vi_['mne.rules.create.reference.label']), 'CXN-10-OK');
      fireEvent.change(within(form).getByLabelText(vi_['mne.rules.create.until.label']), { target: { value: '2027-01-01' } });
      await user.click(within(form).getByRole('button', { name: vi_['mne.rules.create.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('createMneObligationRule', expect.objectContaining({ body: expect.objectContaining({ legal_confirmation_ref: 'CXN-10-OK', effective_until: '2027-01-01' }) }));
    });

    it.each([
      ['FORM_NOT_EFFECTIVE', 422, vi_['mne.rules.problem.formNotEffective.text'], undefined],
      ['EFFECTIVE_RANGE_OVERLAP', 409, vi_['mne.forms.problem.rangeOverlap.text'], undefined],
      ['VALIDATION_FAILED', 422, `${vi_['mne.forms.problem.invalid.text']} (due_rule_json.month)`, 'due_rule_json.month'],
      ['LEGAL_BASIS_REQUIRED', 422, vi_['mne.forms.problem.invalid.text'], undefined],
    ])('keeps the form and tells the person why when the server answers %s', async (code, status, message, detail) => {
      const { user, form } = await open(formsClient(() => FORMS, () => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) }), () => RULES));
      await fillAll(user, form);
      await user.click(within(form).getByRole('button', { name: vi_['mne.rules.create.submit.action'] }));
      expect((await within(form).findByText(message)).getAttribute('role')).toBe('alert');
      expect(within(form).getByLabelText(vi_['mne.rules.create.code.label'])).toBeTruthy();
    });

    it('closes the form without a command when the person cancels', async () => {
      const { user, h, form } = await open();
      await user.click(within(form).getByRole('button', { name: vi_['mne.rules.create.cancel.action'] }));
      expect(screen.queryByRole('form', { name: vi_['mne.rules.create.title'] })).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });
});
