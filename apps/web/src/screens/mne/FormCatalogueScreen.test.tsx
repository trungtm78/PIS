import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import FormCatalogueScreen from './FormCatalogueScreen';
import { FORM_ADMIN, ME, OTHER, READER, SECOND_TENANT, formRow, formsClient, mount, routeOf } from './test-support';

const ROUTE = routeOf('MNE-02', 'FR-MNE-02');

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const ROWS = [
  formRow(2),
  formRow(3, { status: 'DRAFT', version: 1, created_by: OTHER, origin: 'TENANT', pack_version: null, watermark_text: null }),
  formRow(4, { status: 'DRAFT', version: 1, created_by: ME, origin: 'TENANT', pack_version: null, report_kind: 'EVALUATION' }),
  formRow(5, { status: 'RETIRED', version: 3, legal_confirmation_ref: 'CXN-10-OK', awaiting_confirmation: false, cxn_refs: [], watermark_text: null, effective_until: '2026-03-01' }),
  formRow(6, { doc_template_id: null, export_formats: ['XML'] }),
];

const rowOf = (code: string): HTMLElement => {
  const row = within(screen.getByRole('table', { name: vi_['mne.forms.table.aria'] })).getByText(code, { selector: 'strong' }).closest('tr');
  if (row === null) throw new Error(`no row for ${code}`);
  return row as HTMLElement;
};

afterEach(cleanup);

describe('MNE-02 form catalogue (ST-MNE-001, MNE F1, BR-MNE-01)', () => {
  it('UI-MNE-02: lists every revision with its code, name, kind, legal basis with the CXN label, period, DOC template link and export formats', async () => {
    mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: READER });
    expect(await screen.findByText('TT44-M02')).toBeTruthy();
    expect(screen.getByRole('heading', { name: vi_['mne.forms.page.title'] })).toBeTruthy();
    const published = within(rowOf('TT44-M02'));
    expect(published.getByText(fill(vi_['mne.forms.revision.pill'], { revision: 1 }))).toBeTruthy();
    expect(published.getByText('Báo cáo giám sát mẫu 2')).toBeTruthy();
    expect(published.getByText(vi_['mne.forms.kind.overallSemiannual'])).toBeTruthy();
    expect(published.getByText('Thông tư 44/2026/TT-BTC [CXN-10]')).toBeTruthy();
    expect(published.getByText(fill(vi_['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }))).toBeTruthy();
    expect(published.getByText(fill(vi_['mne.forms.watermark.text'], { text: 'Mẫu chờ xác nhận pháp lý [CXN-10]' }))).toBeTruthy();
    expect(published.getByText(fill(vi_['mne.forms.period.open'], { from: '2026-01-01' }))).toBeTruthy();
    expect(published.getByText('XLSX, PDF')).toBeTruthy();
    const link = published.getByRole('link', { name: fill(vi_['mne.forms.template.link.label'], { code: 'MNE-TT44-M02' }) });
    expect(link.getAttribute('href')).toBe('/doc/doc-14');
    expect(published.getByText(vi_['mne.forms.state.published'])).toBeTruthy();
    expect(published.getByText(vi_['mne.forms.phase.inForce'])).toBeTruthy();
  });

  it('UI-MNE-02: shows a confirmed revision with its reference and the last day of its period, and a form whose DOC template is missing without a link', async () => {
    mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: READER });
    await screen.findByText('TT44-M05');
    const retired = within(rowOf('TT44-M05'));
    expect(retired.getByText(fill(vi_['mne.forms.confirmation.reference'], { reference: 'CXN-10-OK' }))).toBeTruthy();
    expect(retired.queryByText(fill(vi_['mne.forms.confirmation.pending'], { tags: '[CXN-10]' }))).toBeNull();
    // `effective_until` is exclusive: the period is shown up to the day before.
    expect(retired.getByText(fill(vi_['mne.forms.period.closed'], { from: '2026-01-01', until: '2026-02-28' }))).toBeTruthy();
    expect(retired.getByText(vi_['mne.forms.state.retired'])).toBeTruthy();
    expect(retired.getByText(vi_['mne.forms.phase.ended'])).toBeTruthy();
    const missing = within(rowOf('TT44-M06'));
    expect(missing.getByText(vi_['mne.forms.template.missing'])).toBeTruthy();
    expect(missing.queryByRole('link')).toBeNull();
    expect(missing.getByText('MNE-TT44-M06')).toBeTruthy();
    expect(within(rowOf('TT44-M03')).getByText(vi_['mne.forms.phase.draft'])).toBeTruthy();
  });

  it('counts the revisions that wait for their legal confirmation and the revisions listed', async () => {
    mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: READER });
    expect((await screen.findByTestId('awaiting-banner')).textContent).toBe(fill(vi_['mne.forms.awaiting.banner'], { count: 4 }));
    expect(screen.getByTestId('count').textContent).toBe(fill(vi_['mne.forms.count.text'], { count: 5 }));
  });

  it('shows no banner when every revision is confirmed', async () => {
    mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => [formRow(2, { legal_confirmation_ref: 'CXN-10-OK', awaiting_confirmation: false })]), { permissions: READER });
    await screen.findByText('TT44-M02');
    expect(screen.queryByTestId('awaiting-banner')).toBeNull();
  });

  describe('publishing', () => {
    it('offers the publication of a draft that someone else made, tells the maker that another person has to publish, and offers nothing on a published revision', async () => {
      mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: FORM_ADMIN });
      await screen.findByText('TT44-M03');
      expect(within(rowOf('TT44-M03')).getByRole('button', { name: fill(vi_['mne.forms.publish.label'], { code: 'TT44-M03', revision: 1 }) })).toBeTruthy();
      expect(within(rowOf('TT44-M04')).queryByRole('button')).toBeNull();
      expect(within(rowOf('TT44-M04')).getByText(vi_['mne.forms.publish.other.hint'])).toBeTruthy();
      expect(within(rowOf('TT44-M02')).queryByRole('button')).toBeNull();
    });

    it('publishes with the version the person saw, says so, and reads the catalogue again', async () => {
      const user = userEvent.setup();
      let reads = 0;
      const h = formsClient(() => {
        reads += 1;
        return ROWS;
      });
      mount(<FormCatalogueScreen route={ROUTE} />, h, { permissions: FORM_ADMIN });
      await screen.findByText('TT44-M03');
      await user.click(screen.getByRole('button', { name: fill(vi_['mne.forms.publish.label'], { code: 'TT44-M03', revision: 1 }) }));
      const panel = screen.getByRole('form', { name: fill(vi_['mne.forms.publish.title'], { code: 'TT44-M03', revision: 1 }) });
      expect(within(panel).getByText(vi_['mne.forms.publish.hint'])).toBeTruthy();
      await user.click(within(panel).getByRole('button', { name: vi_['mne.forms.publish.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('publishMneForm', expect.objectContaining({ path: { id: ROWS[1]?.id }, ifMatchVersion: 1 }));
      expect(await screen.findByText(fill(vi_['mne.forms.publish.done.notice'], { code: 'TT44-M03', revision: 1 }))).toBeTruthy();
      expect(screen.queryByRole('form', { name: fill(vi_['mne.forms.publish.title'], { code: 'TT44-M03', revision: 1 }) })).toBeNull();
      expect(reads).toBeGreaterThanOrEqual(2);
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, vi_['mne.forms.problem.selfApproval.text']],
      ['VERSION_CONFLICT', 409, vi_['mne.forms.problem.conflict.text']],
      ['REPORT_STATE_INVALID', 409, vi_['mne.forms.problem.stateInvalid.text']],
      ['FORM_RANGE_OVERLAP', 409, vi_['mne.forms.problem.rangeOverlap.text']],
      ['DOC_TEMPLATE_MISSING', 422, vi_['mne.forms.problem.templateMissing.text']],
      ['INTERNAL_ERROR', 500, vi_['mne.forms.problem.general.text']],
    ])('keeps the panel open and tells the person why when the server answers %s', async (code, status, message) => {
      const user = userEvent.setup();
      const h = formsClient(() => ROWS, () => new ApiError({ status, code, correlationId: 'c' }));
      mount(<FormCatalogueScreen route={ROUTE} />, h, { permissions: FORM_ADMIN });
      await screen.findByText('TT44-M03');
      await user.click(screen.getByRole('button', { name: fill(vi_['mne.forms.publish.label'], { code: 'TT44-M03', revision: 1 }) }));
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.publish.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(screen.getByRole('form', { name: fill(vi_['mne.forms.publish.title'], { code: 'TT44-M03', revision: 1 }) })).toBeTruthy();
    });

    it('closes the panel without a command when the person cancels', async () => {
      const user = userEvent.setup();
      const h = formsClient(() => ROWS);
      mount(<FormCatalogueScreen route={ROUTE} />, h, { permissions: FORM_ADMIN });
      await screen.findByText('TT44-M03');
      await user.click(screen.getByRole('button', { name: fill(vi_['mne.forms.publish.label'], { code: 'TT44-M03', revision: 1 }) }));
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.publish.cancel.action'] }));
      expect(screen.queryByRole('form', { name: fill(vi_['mne.forms.publish.title'], { code: 'TT44-M03', revision: 1 }) })).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('offers neither publishing nor drafting to a reader or on a suspended tenant', async () => {
      const reader = mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: READER });
      await screen.findByText('TT44-M03');
      expect(screen.queryByRole('button', { name: vi_['mne.forms.create.open.action'] })).toBeNull();
      expect(within(rowOf('TT44-M03')).queryByRole('button')).toBeNull();
      reader.rerenderWith({ permissions: FORM_ADMIN });
      await waitFor(() => expect(screen.getByRole('button', { name: vi_['mne.forms.create.open.action'] })).toBeTruthy());
      reader.rerenderWith({ permissions: FORM_ADMIN, mode: 'READ_ONLY' });
      await waitFor(() => expect(screen.getByText(vi_['mne.forms.frozen.notice'])).toBeTruthy());
      expect(screen.queryByRole('button', { name: vi_['mne.forms.create.open.action'] })).toBeNull();
      expect(within(rowOf('TT44-M03')).queryByRole('button')).toBeNull();
    });
  });

  describe('drafting a revision', () => {
    const open = async (h = formsClient(() => ROWS)) => {
      const user = userEvent.setup();
      const view = mount(<FormCatalogueScreen route={ROUTE} />, h, { permissions: FORM_ADMIN });
      await screen.findByText('TT44-M03');
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.create.open.action'] }));
      const form = screen.getByRole('form', { name: vi_['mne.forms.create.title'] });
      return { user, h, form, view };
    };
    const date = (form: HTMLElement, label: string, value: string): void => {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    };
    const fillAll = async (user: ReturnType<typeof userEvent.setup>, form: HTMLElement) => {
      await user.type(within(form).getByLabelText(vi_['mne.forms.create.code.label']), 'TT44-M02');
      await user.type(within(form).getByLabelText(vi_['mne.forms.create.name.label']), 'Báo cáo tổng thể 6 tháng');
      await user.selectOptions(within(form).getByLabelText(vi_['mne.forms.create.kind.label']), 'OVERALL_SEMIANNUAL');
      await user.type(within(form).getByLabelText(vi_['mne.forms.create.template.label']), 'MNE-TT44-M02');
      date(form, vi_['mne.forms.create.from.label'], '2026-07-01');
      // A bracket is a key descriptor for the keyboard of the test: the legal basis names its confirmation in brackets.
      fireEvent.change(within(form).getByLabelText(vi_['mne.forms.create.basis.label']), { target: { value: 'Thông tư 44/2026/TT-BTC [CXN-10]' } });
    };

    it('tells every field that is missing and sends nothing', async () => {
      const { user, h, form } = await open();
      await user.click(within(form).getByRole('button', { name: vi_['mne.forms.create.submit.action'] }));
      const alerts = within(form).getAllByRole('alert').map((alert) => alert.textContent);
      expect(alerts).toContain(vi_['mne.forms.field.required']);
      expect(alerts.length).toBeGreaterThanOrEqual(5);
      expect(h.command).not.toHaveBeenCalled();
      // A field clears its message as soon as it is changed.
      await user.type(screen.getByLabelText(vi_['mne.forms.create.code.label']), 'TT44-M02');
      expect(screen.getByLabelText(vi_['mne.forms.create.code.label']).getAttribute('aria-invalid')).toBe('false');
    });

    it('names the other problems of the fields: a date order, a bad JSON and no export format', async () => {
      const { user, h, form } = await open();
      await fillAll(user, form);
      date(form, vi_['mne.forms.create.until.label'], '2026-06-01');
      fireEvent.change(within(form).getByLabelText(vi_['mne.forms.create.schema.label']), { target: { value: '[1]' } });
      await user.click(within(form).getByRole('checkbox', { name: 'XLSX' }));
      await user.click(within(form).getByRole('button', { name: vi_['mne.forms.create.submit.action'] }));
      const alerts = within(form).getAllByRole('alert').map((alert) => alert.textContent);
      expect(alerts).toEqual(expect.arrayContaining([vi_['mne.forms.field.order'], vi_['mne.forms.field.json'], vi_['mne.forms.field.formats']]));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the draft with its legal basis and period, says it is saved, and reads the catalogue again', async () => {
      const { user, h, form } = await open();
      await fillAll(user, form);
      await user.type(within(form).getByLabelText(vi_['mne.forms.create.reference.label']), 'CXN-10-OK');
      await user.click(within(form).getByRole('checkbox', { name: 'PDF' }));
      await user.click(within(form).getByRole('button', { name: vi_['mne.forms.create.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'createMneFormVersion',
        expect.objectContaining({
          body: {
            form_code: 'TT44-M02',
            title: 'Báo cáo tổng thể 6 tháng',
            report_kind: 'OVERALL_SEMIANNUAL',
            legal_basis: 'Thông tư 44/2026/TT-BTC [CXN-10]',
            legal_confirmation_ref: 'CXN-10-OK',
            effective_from: '2026-07-01',
            schema_json: {},
            doc_template_code: 'MNE-TT44-M02',
            export_formats: ['XLSX', 'PDF'],
          },
        }),
      );
      expect(await screen.findByText(fill(vi_['mne.forms.create.done.notice'], { code: 'TT44-M02' }))).toBeTruthy();
      expect(screen.queryByRole('form', { name: vi_['mne.forms.create.title'] })).toBeNull();
    });

    it.each([
      ['DOC_TEMPLATE_MISSING', 422, vi_['mne.forms.problem.templateMissing.text']],
      ['FORM_RANGE_OVERLAP', 409, vi_['mne.forms.problem.rangeOverlap.text']],
      ['LEGAL_BASIS_REQUIRED', 422, vi_['mne.forms.problem.invalid.text']],
    ])('keeps the form and tells the person why when the server answers %s', async (code, status, message) => {
      const { user, form } = await open(formsClient(() => ROWS, () => new ApiError({ status, code, correlationId: 'c' })));
      await fillAll(user, form);
      await user.click(within(form).getByRole('button', { name: vi_['mne.forms.create.submit.action'] }));
      expect((await within(form).findByText(message)).getAttribute('role')).toBe('alert');
      expect(screen.getByLabelText(vi_['mne.forms.create.code.label'])).toBeTruthy();
    });

    it('closes the form without a command when the person cancels, and when a switch of tenant starts the screen over', async () => {
      const { user, h, form, view } = await open();
      await user.click(within(form).getByRole('button', { name: vi_['mne.forms.create.cancel.action'] }));
      expect(screen.queryByRole('form', { name: vi_['mne.forms.create.title'] })).toBeNull();
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.create.open.action'] }));
      await user.type(screen.getByLabelText(vi_['mne.forms.create.code.label']), 'written for the first tenant');
      view.rerenderWith({ permissions: FORM_ADMIN, tenant: SECOND_TENANT });
      await waitFor(() => expect(screen.queryByLabelText(vi_['mne.forms.create.code.label'])).toBeNull());
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('the filters', () => {
    it('sends the report kind and the date the person chose, and starts without any', async () => {
      const user = userEvent.setup();
      const h = formsClient(() => ROWS);
      mount(<FormCatalogueScreen route={ROUTE} />, h, { permissions: READER });
      await screen.findByText('TT44-M02');
      const lastFormsRead = (): unknown[] | undefined => h.readAll.mock.calls.filter((call) => call[0] === 'listMneForms').at(-1);
      expect(lastFormsRead()).toEqual(['listMneForms', { query: {} }]);
      await user.selectOptions(screen.getByLabelText(vi_['mne.forms.filter.kind.label']), 'EVALUATION');
      fireEvent.change(screen.getByLabelText(vi_['mne.forms.filter.effectiveOn.label']), { target: { value: '2026-06-30' } });
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.filter.action'] }));
      await waitFor(() => expect(lastFormsRead()).toEqual(['listMneForms', { query: { report_kind: 'EVALUATION', effective_on: '2026-06-30' } }]));
    });
  });

  describe('the kit', () => {
    it('writes the number of revisions in the context bar, and counts the applied conditions on the button of the filter panel once they are applied', async () => {
      const user = userEvent.setup();
      mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: READER });
      await screen.findByText('TT44-M02');
      const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
      expect(within(bar).getByText('Số phiên bản đang hiện')).toBeTruthy();
      expect(within(bar).getByText('5')).toBeTruthy();
      expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggle'] })).toBeTruthy();
      await user.selectOptions(screen.getByLabelText(vi_['mne.forms.filter.kind.label']), 'EVALUATION');
      // The count follows the filter that was applied, not the one that is being written.
      expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggle'] })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: vi_['mne.forms.filter.action'] }));
      expect(await screen.findByRole('button', { name: fill(vi_['ui.filterPanel.toggleApplied'], { count: 1 }) })).toBeTruthy();
    });

    it('shows the lifecycle and the phase of a revision as pills with their text', async () => {
      mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: READER });
      await screen.findByText('TT44-M02');
      const pill = within(rowOf('TT44-M05')).getByText(vi_['mne.forms.state.retired']).closest('.ui-pill');
      expect(pill).not.toBeNull();
      expect(pill?.className).toContain('ui-tone-neutral');
    });
  });

  describe('UI-MNE-02: the standard states', () => {
    it.each([
      ['empty', [] as Array<Record<string, unknown>>, vi_['states.empty.title']],
      ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
      ['signed out', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
    ])('UI-MNE-02: shows the %s state and keeps the filters', async (_name, reply, title) => {
      mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => reply));
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByLabelText(vi_['mne.forms.filter.kind.label'])).toBeTruthy();
    });

    it('UI-MNE-02: shows the loading state first and names the page for assistive technology', () => {
      const h = formsClient(() => []);
      h.readAll.mockImplementation(() => new Promise(() => undefined));
      mount(<FormCatalogueScreen route={ROUTE} />, h);
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['mne.forms.page.title'] })).toBeTruthy();
    });

    it('UI-MNE-02: gives every field, every column and every action of the loaded screen an accessible name', async () => {
      mount(<FormCatalogueScreen route={ROUTE} />, formsClient(() => ROWS), { permissions: FORM_ADMIN });
      await screen.findByText('TT44-M02');
      for (const control of [...screen.getAllByRole('combobox'), screen.getByLabelText(vi_['mne.forms.filter.effectiveOn.label'])]) {
        expect((control as HTMLInputElement).labels?.length).toBeGreaterThan(0);
      }
      for (const action of screen.getAllByRole('button')) expect((action.getAttribute('aria-label') ?? action.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(screen.getByRole('table', { name: vi_['mne.forms.table.aria'] })).toBeTruthy();
      expect(screen.getAllByRole('columnheader').length).toBeGreaterThanOrEqual(9);
    });

    it('UI-MNE-02: retries the read after an error', async () => {
      let failing = true;
      const h = formsClient(() => (failing ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : ROWS));
      mount(<FormCatalogueScreen route={ROUTE} />, h);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      failing = false;
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByText('TT44-M02')).toBeTruthy();
    });
  });
});
