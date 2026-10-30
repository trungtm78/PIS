import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import vi_ from '../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';
import TemplateEditorScreen from './TemplateEditorScreen';
import TemplatePreviewScreen from './TemplatePreviewScreen';
import { TENANT, harness, mount, routeOf } from './delivery/test-support';
import {
  bodyOf,
  canDecide,
  canSubmit,
  describeProblem,
  emptyForm,
  isLocked,
  isUuid,
  placeholdersOf,
  previewOf,
  problemsOf,
  reviseForm,
  samplesOf,
  toRecipients,
  toTemplate,
  toTemplatePage,
  variableSchemaOf,
} from './template/model';

const ADMIN = ['notification.template.manage', 'notification.template.approve', 'notification_template_version.read'];
const AUTHOR = ['notification.template.manage', 'notification_template_version.read'];
const READER = ['notification_template_version.read'];
const NOBODY = ['delivery_attempt.read'];
const reason = 'Reviewed with the owner of the process.';
const LISTED = '00000000-0000-4000-8000-0000000000c5';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const templateRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `template-${n}`,
  code: `report.submitted-${n}`,
  channel: 'SMS',
  locale: 'vi-VN',
  revision: 1,
  purpose: 'OPERATIONAL',
  content_ast: { body: 'Dossier {{code}} of {{unit}}' },
  variable_schema: { type: 'object', properties: { code: { type: 'string', classification: 'PUBLIC' }, unit: { type: 'string', classification: 'INTERNAL' } } },
  lockscreen_safe: false,
  status: 'Draft',
  provider_status: 'NOT_REQUIRED',
  created_by: 'm-1',
  approved_by: null,
  supersedes_id: null,
  created_at: '2026-10-30T02:00:00Z',
  version: 1,
  ...overrides,
});

afterEach(cleanup);

interface World {
  templates?: Array<Record<string, unknown>> | Error;
  recipients?: string[];
}

function open(element: JSX.Element, permissions: readonly string[], world: World = {}, command: (operation: string, input: unknown) => unknown = () => ({}), entry = '/') {
  const h = harness((operation, input) => {
    switch (operation) {
      case 'get_resources_notification_template_version':
        return world.templates instanceof Error ? world.templates : { items: world.templates ?? [], next_cursor: null };
      case 'get_resources_notification_template_version_id': {
        if (world.templates instanceof Error) return world.templates;
        const found = (world.templates ?? []).find((row) => row.id === (input as { path: { id: string } }).path.id);
        return found ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
      }
      case 'listNotificationTestRecipients':
        return { membership_ids: world.recipients ?? [] };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  return { h, ...mount(element, h, { permissions, entry }) };
}

const editor = (permissions: readonly string[], world: World, command?: (operation: string, input: unknown) => unknown) => {
  const element = <TemplateEditorScreen route={routeOf('NOT-07', 'FR-NOT-07')} />;
  return open(element, permissions, world, command);
};
const preview = (permissions: readonly string[], world: World, command?: (operation: string, input: unknown) => unknown, entry = '/not/not-08?template=template-1') => {
  const element = <TemplatePreviewScreen route={routeOf('NOT-08', 'FR-NOT-08')} />;
  return open(element, permissions, world, command, entry);
};

describe('NOT-07 the template editor (UI-NOT-07)', () => {
  it('AC-ST-NOT-005-4 UI-NOT-07: lists the revisions with the channel, the locale, the revision and the state, and locks a revision that is not a Draft', async () => {
    editor(ADMIN, { templates: [templateRow(1), templateRow(2, { status: 'Active', revision: 2 })] });
    const table = await screen.findByRole('table');
    for (const key of ['code', 'channel', 'locale', 'revision', 'status', 'created']) expect(within(table).getByRole('columnheader', { name: vi_[`not.template.col.${key}` as keyof typeof vi_] })).toBeTruthy();
    const draft = table.querySelector('[data-template-id="template-1"]') as HTMLElement;
    fireEvent.click(within(draft).getByRole('button', { name: vi_['not.template.open.action'] }));
    let detail = document.querySelector('[data-template-detail]') as HTMLElement;
    expect(detail.getAttribute('data-locked')).toBe('false');
    expect(detail.querySelector('[data-locked-note]')).toBeNull();
    expect(detail.querySelector('[data-detail-body]')?.textContent).toBe('Dossier {{code}} of {{unit}}');
    const active = table.querySelector('[data-template-id="template-2"]') as HTMLElement;
    fireEvent.click(within(active).getByRole('button', { name: vi_['not.template.open.action'] }));
    detail = document.querySelector('[data-template-detail]') as HTMLElement;
    expect(detail.getAttribute('data-locked')).toBe('true');
    expect(detail.querySelector('[data-locked-note]')?.textContent).toBe(vi_['not.template.detail.locked']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.template.page.title']);
  });

  it('AC-ST-NOT-005-4 UI-NOT-07: shows a loading state, then the denied, signed-out, offline and error states, and says in words when there is no template', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      editor(ADMIN, { templates: error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = editor(ADMIN, { templates: [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['not.template.list.none'])).toBeTruthy();
    cleanup();
    const { h } = editor(NOBODY, {});
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('tells the author before sending what the server would refuse: money on a phone channel, an undeclared variable, an e-mail with no subject', async () => {
    const { h } = editor(ADMIN, { templates: [] });
    fireEvent.change(await screen.findByLabelText(vi_['not.template.form.code.label']), { target: { value: 'debt.reminder' } });
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.channel.label']), { target: { value: 'SMS' } });
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.body.label']), { target: { value: 'You owe {{amount}} for {{ghost}}' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.form.variable.add'] }));
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.variable.name'].replace('{n}', '1')), { target: { value: 'amount' } });
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.variable.type'].replace('{n}', '1')), { target: { value: 'money' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.form.submit.action'] }));
    const problems = await screen.findByRole('alert');
    expect(problems.textContent).toContain(vi_['not.template.form.classified.invalid'].replace('{name}', 'amount'));
    expect(problems.textContent).toContain(vi_['not.template.form.undeclared.invalid'].replace('{name}', 'ghost'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.channel.label']), { target: { value: 'EMAIL' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.form.submit.action'] }));
    await waitFor(() => expect(document.querySelector('[data-form-problems]')?.textContent).toContain(vi_['not.template.form.subject.invalid']));
  });

  it('writes the draft with the content, the variables and, for a push, the lock-screen flag, and says to send it to review', async () => {
    const { h } = editor(ADMIN, { templates: [] }, () => ({ status: 'DRAFT', resource_id: 'template-9', resource_version: 1 }));
    fireEvent.change(await screen.findByLabelText(vi_['not.template.form.code.label']), { target: { value: 'dossier.alert' } });
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.channel.label']), { target: { value: 'PUSH_FCM' } });
    expect(document.querySelector('[data-lockscreen]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.body.label']), { target: { value: 'A dossier of {{unit}} needs a look' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.form.variable.add'] }));
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.variable.name'].replace('{n}', '1')), { target: { value: 'unit' } });
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.variable.classification'].replace('{n}', '1')), { target: { value: 'INTERNAL' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.form.submit.action'] }));
    expect(await screen.findByText(vi_['not.template.done.saved'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('createTemplateRevision');
    expect(input.body).toEqual({
      code: 'dossier.alert',
      channel: 'PUSH_FCM',
      locale: 'vi-VN',
      purpose: 'OPERATIONAL',
      content_ast: { body: 'A dossier of {{unit}} needs a look' },
      variable_schema: { type: 'object', properties: { unit: { type: 'string', classification: 'INTERNAL' } } },
      lockscreen_safe: true,
    });
  });

  it('starts a new revision from an existing one: the same line, the same words, and the revision it supersedes', async () => {
    const { h } = editor(ADMIN, { templates: [templateRow(1, { status: 'Active' })] }, () => ({ status: 'DRAFT' }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['not.template.revise.action'] }));
    expect((screen.getByLabelText(vi_['not.template.form.code.label']) as HTMLInputElement).value).toBe('report.submitted-1');
    expect((screen.getByLabelText(vi_['not.template.form.code.label']) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText(vi_['not.template.form.body.label']), { target: { value: 'Changed {{code}} {{unit}}' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.form.submit.action'] }));
    expect(await screen.findByText(vi_['not.template.done.saved'])).toBeTruthy();
    expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toMatchObject({ code: 'report.submitted-1', channel: 'SMS', supersedes_id: 'template-1', content_ast: { body: 'Changed {{code}} {{unit}}' } });
  });

  it('says why the server refused a draft: the variable that is classified, or a field that is wrong', async () => {
    for (const [error, message] of [
      [problem('TEMPLATE_VARIABLE_CLASSIFIED', 422, 'variable_schema.amount'), vi_['not.template.problem.classified'].replace('{variable}', 'variable_schema.amount')],
      [problem('TEMPLATE_INVALID', 422, 'lockscreen_safe'), vi_['not.template.problem.invalidAt'].replace('{field}', 'lockscreen_safe')],
    ] as const) {
      editor(ADMIN, { templates: [] }, () => error);
      fireEvent.change(await screen.findByLabelText(vi_['not.template.form.code.label']), { target: { value: 'dossier.alert' } });
      fireEvent.change(screen.getByLabelText(vi_['not.template.form.channel.label']), { target: { value: 'IN_APP' } });
      fireEvent.change(screen.getByLabelText(vi_['not.template.form.body.label']), { target: { value: 'Hello' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['not.template.form.submit.action'] }));
      await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes(message))).toBe(true));
      cleanup();
    }
  });

  it('sends a Draft to review on the version it saw, with a reason', async () => {
    const { h } = editor(AUTHOR, { templates: [templateRow(1, { version: 3 })] }, () => ({ status: 'INREVIEW' }));
    expect(screen.queryByRole('button', { name: vi_['not.template.approve.action'] })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: vi_['not.template.submit.action'] }));
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.reason.confirm.action'] }));
    expect(await screen.findByText(vi_['not.template.reason.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['not.template.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.reason.confirm.action'] }));
    expect(await screen.findByText(vi_['not.template.done.submitted'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('submitTemplateRevision');
    expect(input.path).toEqual({ templateId: 'template-1' });
    expect(input.body).toEqual({ reason });
    expect(input.ifMatchVersion).toBe(3);
  });

  it('lets the approver approve, return or reject a revision that waits, and tells that its author may not', async () => {
    const waiting = templateRow(1, { status: 'InReview', version: 2 });
    for (const [action, decision, done] of [
      ['approve', 'approve', 'approved'],
      ['return', 'return', 'returned'],
      ['reject', 'reject', 'rejected'],
    ] as const) {
      const { h } = editor(ADMIN, { templates: [waiting] }, () => ({ status: 'ACTIVE' }));
      expect(screen.queryByRole('button', { name: vi_['not.template.submit.action'] })).toBeNull();
      fireEvent.click(await screen.findByRole('button', { name: vi_[`not.template.${action}.action` as keyof typeof vi_] }));
      fireEvent.change(screen.getByLabelText(vi_['not.template.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['not.template.reason.confirm.action'] }));
      expect(await screen.findByText(vi_[`not.template.done.${done}` as keyof typeof vi_])).toBeTruthy();
      const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown; ifMatchVersion: number }];
      expect(operation).toBe('decideTemplateRevision');
      expect(input.body).toEqual({ decision, reason, evidence_ids: [] });
      expect(input.ifMatchVersion).toBe(2);
      cleanup();
    }
    editor(ADMIN, { templates: [waiting] }, () => problem('SELF_APPROVAL_DENIED', 403));
    fireEvent.click(await screen.findByRole('button', { name: vi_['not.template.approve.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['not.template.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.template.reason.confirm.action'] }));
    expect((await screen.findByTestId('template-reason-problem')).textContent).toBe(vi_['not.template.problem.self']);
  });

  it('starts the editor over when the tenant changes: a form written for one tenant is not saved into another', async () => {
    const h = harness(() => ({ items: [], next_cursor: null }));
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    const sessionOf = (tenantId: string, membershipId: string): SessionValue => ({
      tenant: { ...TENANT, id: tenantId, membershipId },
      tenants: [TENANT],
      user: { displayName: 'Operator', initials: 'OP' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: ADMIN,
    });
    const tree = (session: SessionValue) => (
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter>
              <TemplateEditorScreen route={routeOf('NOT-07', 'FR-NOT-07')} />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
    const first = render(tree(sessionOf('00000000-0000-4000-8000-0000000000a1', 'm-a')));
    fireEvent.change(await screen.findByLabelText(vi_['not.template.form.code.label']), { target: { value: 'half.written' } });
    first.rerender(tree(sessionOf('00000000-0000-4000-8000-0000000000b2', 'm-b')));
    await waitFor(() => expect((screen.getByLabelText(vi_['not.template.form.code.label']) as HTMLInputElement).value).toBe(''));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows a reader only the list, and a suspended tenant nothing to write', async () => {
    editor(READER, { templates: [templateRow(1), templateRow(2, { status: 'InReview' })] });
    await screen.findByRole('table');
    expect(screen.queryByRole('form', { name: vi_['not.template.form.aria'] })).toBeNull();
    for (const key of ['submit', 'approve', 'return', 'reject', 'revise'] as const) expect(screen.queryByRole('button', { name: vi_[`not.template.${key}.action`] })).toBeNull();
    cleanup();
    const element = <TemplateEditorScreen route={routeOf('NOT-07', 'FR-NOT-07')} />;
    const h = harness(() => ({ items: [templateRow(1)], next_cursor: null }));
    mount(element, h, { permissions: ADMIN, mode: 'READ_ONLY' });
    await screen.findByRole('table');
    expect(screen.queryByRole('form', { name: vi_['not.template.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['not.template.submit.action'] })).toBeNull();
  });
});

describe('NOT-08 the preview and the test send (UI-NOT-08)', () => {
  it('AC-ST-NOT-005-5 UI-NOT-08: asks for a value for each variable and shows the message with the [TEST] prefix, saying what is still missing', async () => {
    preview(ADMIN, { templates: [templateRow(1)], recipients: [] });
    expect(await screen.findByLabelText(/code \(chuỗi, công khai\)/)).toBeTruthy();
    expect(document.querySelector('[data-preview-text]')?.textContent).toBe('[TEST] Dossier {{code}} of {{unit}}');
    expect(document.querySelector('[data-missing]')?.textContent).toContain('code, unit');
    fireEvent.change(screen.getByLabelText(/code \(/), { target: { value: 'D-17' } });
    fireEvent.change(screen.getByLabelText(/unit \(/), { target: { value: 'Cao Bang' } });
    expect(document.querySelector('[data-preview-text]')?.textContent).toBe('[TEST] Dossier D-17 of Cao Bang');
    expect(document.querySelector('[data-missing]')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.preview.page.title']);
  });

  it('AC-ST-NOT-005-5 UI-NOT-08: shows a loading state, then the denied, signed-out, offline and error states', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      preview(ADMIN, { templates: error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = preview(ADMIN, { templates: [templateRow(1)] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    const { h } = preview(NOBODY, {});
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('offers the revisions to choose from when none is named in the address, and keeps the choice in the address', async () => {
    preview(ADMIN, { templates: [templateRow(1), templateRow(2)] }, undefined, '/not/not-08');
    const select = (await screen.findByLabelText(vi_['not.preview.pick.label'])) as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(3);
    fireEvent.change(select, { target: { value: 'template-2' } });
    expect(await screen.findByLabelText(/code \(/)).toBeTruthy();
  });

  it('changes nothing in the list of recipients before it has been read: a list that failed to load is not an empty one', async () => {
    const h = harness((operation) => {
      if (operation === 'get_resources_notification_template_version_id') return templateRow(1);
      if (operation === 'listNotificationTestRecipients') return new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' });
      return new Error('unexpected');
    });
    const element = <TemplatePreviewScreen route={routeOf('NOT-08', 'FR-NOT-08')} />;
    mount(element, h, { permissions: ADMIN, entry: '/not/not-08?template=template-1' });
    expect(await screen.findByText(vi_['not.preview.recipients.error'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['not.preview.recipients.add.label']), { target: { value: LISTED } });
    expect((screen.getByRole('button', { name: vi_['not.preview.recipients.add.action'] }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: vi_['not.preview.recipients.aria'] }));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: vi_['not.preview.recipients.retry.action'] })).toBeTruthy();
  });

  it('does not offer a test send for a template of a provider, which the server always refuses', async () => {
    preview(ADMIN, { templates: [templateRow(1, { channel: 'ZALO_ZNS' })], recipients: [LISTED] });
    expect(await screen.findByText(vi_['not.preview.send.notSendable'])).toBeTruthy();
    await screen.findByText(LISTED);
    fireEvent.click(within(document.querySelector('[data-recipients]') as HTMLElement).getByRole('checkbox'));
    expect((screen.getByRole('button', { name: vi_['not.preview.send.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the picker load the older revisions when there are more than a page', async () => {
    const h = harness((operation, input) => {
      if (operation !== 'get_resources_notification_template_version') return new Error('unexpected');
      const cursor = (input as { query?: { cursor?: string } }).query?.cursor;
      return cursor === undefined ? { items: [templateRow(1)], next_cursor: 'c2' } : { items: [templateRow(2)], next_cursor: null };
    });
    const element = <TemplatePreviewScreen route={routeOf('NOT-08', 'FR-NOT-08')} />;
    mount(element, h, { permissions: ADMIN, entry: '/not/not-08' });
    const select = (await screen.findByLabelText(vi_['not.preview.pick.label'])) as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: vi_['not.preview.pick.more.action'] }));
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: vi_['not.preview.pick.more.action'] })).toBeNull();
  });

  it('keeps the list of the people a test may go to: adds one by the id of the membership, refuses an id that is not one, and removes one', async () => {
    const { h } = preview(ADMIN, { templates: [templateRow(1)], recipients: [LISTED] }, () => ({ status: 'SET' }));
    await screen.findByText(LISTED);
    fireEvent.change(screen.getByLabelText(vi_['not.preview.recipients.add.label']), { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.preview.recipients.add.action'] }));
    expect(await screen.findByText(vi_['not.preview.recipients.add.invalid'].replace('{max}', '10'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    const other = '00000000-0000-4000-8000-0000000000c6';
    fireEvent.change(screen.getByLabelText(vi_['not.preview.recipients.add.label']), { target: { value: other.toUpperCase() } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.preview.recipients.add.action'] }));
    expect(await screen.findByText(vi_['not.preview.recipients.saved'])).toBeTruthy();
    expect(h.command.mock.calls[0]).toEqual(['setNotificationTestRecipients', expect.objectContaining({ body: { membership_ids: [LISTED, other] } })]);
    fireEvent.click(screen.getByRole('button', { name: vi_['not.preview.recipients.remove.action'].replace('{id}', LISTED.slice(0, 8)) }));
    await waitFor(() => expect(h.command.mock.calls).toHaveLength(2));
    expect(h.command.mock.calls[1]).toEqual(['setNotificationTestRecipients', expect.objectContaining({ body: { membership_ids: [] } })]);
  });

  it('sends the test to the people chosen with the sample values, and says why the server refused', async () => {
    const { h } = preview(ADMIN, { templates: [templateRow(1)], recipients: [LISTED] }, () => ({ status: 'ACCEPTED' }));
    const send = (await screen.findByRole('button', { name: vi_['not.preview.send.action'] })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/code \(/), { target: { value: 'D-17' } });
    fireEvent.change(screen.getByLabelText(/unit \(/), { target: { value: 'Cao Bang' } });
    fireEvent.click(within(document.querySelector('[data-recipients]') as HTMLElement).getByRole('checkbox'));
    fireEvent.click(send);
    expect(await screen.findByText(vi_['not.preview.send.done'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown }];
    expect(operation).toBe('sendTestNotification');
    expect(input.path).toEqual({ templateId: 'template-1' });
    expect(input.body).toEqual({ test_recipient_ids: [LISTED], sample_variables: { code: 'D-17', unit: 'Cao Bang' } });
    cleanup();
    preview(ADMIN, { templates: [templateRow(1)], recipients: [LISTED] }, () => problem('TEST_RECIPIENT_NOT_ALLOWED', 422));
    fireEvent.click(within(await screen.findByRole('list')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: vi_['not.preview.send.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['not.template.problem.recipient']);
  });

  it('asks for a boolean sample as true or false, so the preview and the test say the same thing', async () => {
    const withBoolean = templateRow(1, {
      content_ast: { body: 'Urgent: {{urgent}}' },
      variable_schema: { type: 'object', properties: { urgent: { type: 'boolean', classification: 'PUBLIC' } } },
    });
    const { h } = preview(ADMIN, { templates: [withBoolean], recipients: [LISTED] }, () => ({ status: 'ACCEPTED' }));
    const field = (await screen.findByLabelText(/urgent \(/)) as HTMLSelectElement;
    expect(field.tagName).toBe('SELECT');
    expect(within(field).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'true', 'false']);
    fireEvent.change(field, { target: { value: 'false' } });
    expect(document.querySelector('[data-preview-text]')?.textContent).toBe('[TEST] Urgent: false');
    fireEvent.click(within(document.querySelector('[data-recipients]') as HTMLElement).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: vi_['not.preview.send.action'] }));
    await screen.findByText(vi_['not.preview.send.done']);
    expect((h.command.mock.calls[0] as [string, { body: { sample_variables: unknown } }])[1].body.sample_variables).toEqual({ urgent: false });
  });

  it('does not offer a test send to a reader, nor for a revision that was rejected or retired', async () => {
    preview(READER, { templates: [templateRow(1)], recipients: [] });
    await screen.findByText(/\[TEST\]/);
    expect(document.querySelector('[data-test-send]')).toBeNull();
    cleanup();
    preview(ADMIN, { templates: [templateRow(1, { status: 'Rejected' })], recipients: [LISTED] });
    expect(await screen.findByText(vi_['not.preview.send.notSendable'])).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['not.preview.send.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-locked-note]')).not.toBeNull();
  });
});

describe('the model of NOT-07 and NOT-08', () => {
  it('reads a revision, a page and the list of recipients, and takes what is not one for nothing', () => {
    expect(toTemplate(null)).toBeUndefined();
    expect(toTemplate({ id: 'x' })).toBeUndefined();
    expect(toTemplate(templateRow(1, { content_ast: { subject: 'S', body: 'B' } }))).toMatchObject({
      id: 'template-1', channel: 'SMS', subject: 'S', body: 'B', status: 'Draft', version: 1, approvedBy: undefined,
      variables: [{ name: 'code', type: 'string', classification: 'PUBLIC' }, { name: 'unit', type: 'string', classification: 'INTERNAL' }],
    });
    expect(toTemplate(templateRow(1, { status: 'Odd' }))?.status).toBe('Draft');
    expect(toTemplatePage({ items: [templateRow(1), 3], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toTemplatePage(7)).toEqual({ items: [], nextCursor: undefined });
    expect(toRecipients({ membership_ids: [LISTED, 4] })).toEqual([LISTED]);
    expect(toRecipients(null)).toEqual([]);
  });

  it('judges a form the way the server does', () => {
    const base = { ...emptyForm(), code: 'abc', channel: 'SMS' as const, body: 'Hello {{amount}}', variables: [{ name: 'amount', type: 'money', classification: 'INTERNAL' }] };
    expect(problemsOf(base)).toEqual([{ field: 'classified', name: 'amount' }]);
    expect(problemsOf({ ...base, channel: 'EMAIL', subject: 'S' })).toEqual([]);
    expect(problemsOf({ ...base, channel: 'IN_APP' })).toEqual([]);
    expect(problemsOf({ ...base, code: 'X' })).toEqual([{ field: 'code' }, { field: 'classified', name: 'amount' }]);
    expect(problemsOf({ ...base, variables: [] })).toEqual([{ field: 'undeclared', name: 'amount' }]);
    expect(problemsOf({ ...base, variables: [{ name: 'a b', type: 'string', classification: 'PUBLIC' }], body: 'x' })).toEqual([{ field: 'variables' }]);
    expect(problemsOf({ ...base, body: '  ' })).toContainEqual({ field: 'body' });
    expect(placeholdersOf('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });

  it('builds what is sent: the subject only for e-mail, the schema of the variables, the samples by type, a revision from an old one', () => {
    const form = { ...emptyForm(), code: 'abc', body: 'B', subject: ' S ', variables: [{ name: ' n ', type: 'integer', classification: 'PUBLIC' }] };
    expect(bodyOf(form)).toEqual({ subject: 'S', body: 'B' });
    expect(bodyOf({ ...form, channel: 'SMS' })).toEqual({ body: 'B' });
    expect(variableSchemaOf(form)).toEqual({ type: 'object', properties: { n: { type: 'integer', classification: 'PUBLIC' } } });
    const variables = [{ name: 'a', type: 'string', classification: 'PUBLIC' }, { name: 'b', type: 'money', classification: 'INTERNAL' }, { name: 'c', type: 'boolean', classification: 'PUBLIC' }, { name: 'd', type: 'integer', classification: 'PUBLIC' }];
    expect(samplesOf(variables, { a: 'x', b: '12.5', c: 'true', d: 'oops' })).toEqual({ a: 'x', b: 12.5, c: true });
    // A boolean is true or false and nothing else: a guess is not sent.
    expect(samplesOf(variables, { c: 'False' })).toEqual({});
    expect(samplesOf(variables, { c: 'false' })).toEqual({ c: false });
    const revised = reviseForm(toTemplate(templateRow(4)) as NonNullable<ReturnType<typeof toTemplate>>);
    expect(revised).toMatchObject({ code: 'report.submitted-4', channel: 'SMS', supersedesId: 'template-4', body: 'Dossier {{code}} of {{unit}}' });
  });

  it('fills the preview and names what is missing; knows what can be sent for review, decided and edited; reads ids and problems', () => {
    expect(previewOf({ subject: 'S {{a}}', body: 'B {{a}} {{b}}' }, { a: '1' })).toEqual({ subject: '[TEST] S 1', text: '[TEST] B 1 {{b}}', missing: ['b'] });
    // A variable named like a property of a plain object is missing until it is given.
    expect(previewOf({ subject: undefined, body: '{{constructor}}' }, {})).toEqual({ subject: undefined, text: '[TEST] {{constructor}}', missing: ['constructor'] });
    expect([canSubmit({ status: 'Draft' }), canSubmit({ status: 'Active' }), canDecide({ status: 'InReview' }), canDecide({ status: 'PendingProvider' }), canDecide({ status: 'Draft' }), isLocked({ status: 'Draft' }), isLocked({ status: 'Retired' })]).toEqual([true, false, true, true, false, false, true]);
    expect([isUuid(LISTED), isUuid(` ${LISTED.toUpperCase()} `), isUuid('x')]).toEqual([true, true, false]);
    expect(describeProblem(problem('TEMPLATE_VARIABLE_CLASSIFIED', 422, 'variable_schema.amount'))).toEqual({ reason: 'classified', field: 'variable_schema.amount' });
    expect(describeProblem(problem('TEMPLATE_IMMUTABLE')).reason).toBe('immutable');
    expect(describeProblem(problem('TEMPLATE_PROVIDER_PENDING')).reason).toBe('providerPending');
    expect(describeProblem(problem('PROVIDER_UNAVAILABLE', 503)).reason).toBe('provider');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });
});
