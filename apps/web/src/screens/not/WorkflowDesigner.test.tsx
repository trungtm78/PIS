import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';
import vi_ from '../../i18n/vi.json';
import EventCatalogueScreen from './EventCatalogueScreen';
import WorkflowDesignerScreen from './WorkflowDesignerScreen';
import { TENANT, harness, mount, routeOf } from './delivery/test-support';
import {
  canPublish,
  definitionFromForm,
  describeProblem,
  emptyForm,
  invalidFields,
  isPublishReasonValid,
  moveChannel,
  toEventType,
  toEventTypes,
  toWorkflow,
  toWorkflowPage,
} from './workflow/model';

const ADMIN = ['notification.publish'];
const NOBODY = ['delivery_attempt.read'];
const EVENT = 'report.submitted.v1';
const reason = 'Reviewed with the owner of the process.';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const eventRow = (eventType: string, overrides: Record<string, unknown> = {}) => ({
  event_type: eventType,
  owning_module: 'DIS',
  schema_version: 1,
  allowed_purposes: ['OPERATIONAL', 'REMINDER'],
  data_classification: 'INTERNAL',
  status: 'Active',
  ...overrides,
});

const workflowRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `workflow-${n}`,
  event_type: EVENT,
  revision: n,
  status: 'Draft',
  definition: { priority: 'HIGH', purpose: 'OPERATIONAL', ackRequired: true, expiresAfterMinutes: 120, channels: [{ channel: 'IN_APP' }, { channel: 'EMAIL', templateCode: 'mail.a' }], resolver: { kind: 'explicit' } },
  created_by: 'm-1',
  published_by: null,
  created_at: '2026-10-30T02:00:00Z',
  published_at: null,
  supersedes_id: null,
  version: 1,
  ...overrides,
});

afterEach(cleanup);

interface World {
  types?: Array<Record<string, unknown>> | Error;
  workflows?: Array<Record<string, unknown>> | Error;
}

function open(element: JSX.Element, permissions: readonly string[], world: World = {}, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation) => {
    switch (operation) {
      case 'listNotificationEventTypes':
        return world.types instanceof Error ? world.types : { items: world.types ?? [] };
      case 'listNotificationWorkflows':
        return world.workflows instanceof Error ? world.workflows : { items: world.workflows ?? [], next_cursor: null };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  return { h, ...mount(element, h, { permissions }) };
}

const catalogue = (permissions: readonly string[], world: World) => {
  const element = <EventCatalogueScreen route={routeOf('NOT-05', 'FR-NOT-05')} />;
  return open(element, permissions, world);
};
const designer = (permissions: readonly string[], world: World, command?: (operation: string, input: unknown) => unknown) => {
  const element = <WorkflowDesignerScreen route={routeOf('NOT-06', 'FR-NOT-06')} />;
  return open(element, permissions, world, command);
};

describe('NOT-05 the event catalogue (UI-NOT-05)', () => {
  it('AC-ST-NOT-004-4 UI-NOT-05: lists the event types with the module, the purposes, the classification and the state', async () => {
    catalogue(ADMIN, { types: [eventRow(EVENT), eventRow('ctr.guarantee.expiring.v1', { owning_module: 'CTR', data_classification: 'CONFIDENTIAL', status: 'Deprecated', allowed_purposes: ['REMINDER'] })] });
    const table = await screen.findByRole('table');
    for (const key of ['eventType', 'module', 'purposes', 'classification', 'status']) expect(within(table).getByRole('columnheader', { name: vi_[`not.catalogue.col.${key}` as keyof typeof vi_] })).toBeTruthy();
    const active = table.querySelector(`[data-event-type="${EVENT}"]`) as HTMLElement;
    expect(within(active).getByText(`${vi_['not.workflow.purpose.operational']}, ${vi_['not.workflow.purpose.reminder']}`)).toBeTruthy();
    expect(within(active).getByText(vi_['not.workflow.classification.internal'])).toBeTruthy();
    expect(within(active).getByText(vi_['not.catalogue.status.active'])).toBeTruthy();
    const old = table.querySelector('[data-event-type="ctr.guarantee.expiring.v1"]') as HTMLElement;
    expect(within(old).getByText(vi_['not.workflow.classification.confidential'])).toBeTruthy();
    expect(within(old).getByText(vi_['not.catalogue.status.deprecated'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.catalogue.page.title']);
  });

  it('AC-ST-NOT-004-4 UI-NOT-05: shows a loading state, then the denied, signed-out, offline and error states, and nothing is asked without the right', async () => {
    const { h } = catalogue(NOBODY, {});
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    const loading = catalogue(ADMIN, { types: [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    const cases: Array<[ApiError, string]> = [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ];
    for (const [error, title] of cases) {
      catalogue(ADMIN, { types: error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
  });

  it('AC-ST-NOT-004-4 UI-NOT-05: says in words when the platform has registered nothing, instead of an empty table', async () => {
    catalogue(ADMIN, { types: [] });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });
});

describe('NOT-06 the workflow designer (UI-NOT-06)', () => {
  it('AC-ST-NOT-004-3 UI-NOT-06: renders the purposes the type allows, its classification, the priority, the quiet-hours override and the fallback order of the channels', async () => {
    designer(ADMIN, { types: [eventRow(EVENT), eventRow('old.v1', { status: 'Deprecated' })], workflows: [workflowRow(1)] });
    expect(await screen.findByRole('form', { name: vi_['not.workflow.form.aria'] })).toBeTruthy();
    // Only the types that are still accepted can be chosen.
    const options = within(screen.getByLabelText(vi_['not.workflow.event.label'])).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual([EVENT]);
    expect(document.querySelector('[data-event-facts]')?.textContent).toContain(vi_['not.workflow.classification.internal']);
    const purposes = within(screen.getByLabelText(vi_['not.workflow.form.purpose.label'])).getAllByRole('option').map((option) => option.textContent);
    expect(purposes).toEqual([vi_['not.workflow.purpose.operational'], vi_['not.workflow.purpose.reminder']]);
    const priorities = within(screen.getByLabelText(vi_['not.workflow.form.priority.label'])).getAllByRole('option');
    expect(priorities).toHaveLength(4);
    expect(screen.getByLabelText(vi_['not.workflow.form.override.label'])).toBeTruthy();
    expect(screen.getByText(vi_['not.workflow.form.channels.fallback'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.workflow.page.title']);
    const row = await screen.findByRole('table');
    expect(row.querySelector('[data-plan]')?.textContent).toBe(`${vi_['not.workflow.channel.inApp']} → ${vi_['not.workflow.channel.email']}`);
  });

  it('AC-ST-NOT-004-3 UI-NOT-06: lets the quiet hours be overridden only for a CRITICAL message, and asks for the reason', async () => {
    designer(ADMIN, { types: [eventRow(EVENT)], workflows: [] });
    const override = (await screen.findByLabelText(vi_['not.workflow.form.override.label'])) as HTMLInputElement;
    expect(override.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.priority.label']), { target: { value: 'CRITICAL' } });
    expect(override.disabled).toBe(false);
    fireEvent.click(override);
    expect(screen.getByLabelText(vi_['not.workflow.form.overrideReason.label'])).toBeTruthy();
    // Back to a lower priority: the override and its reason go.
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.priority.label']), { target: { value: 'HIGH' } });
    expect(override.checked).toBe(false);
    expect(screen.queryByLabelText(vi_['not.workflow.form.overrideReason.label'])).toBeNull();
  });

  it('refuses a form that the server would refuse, saying what is missing, and sends nothing', async () => {
    const { h } = designer(ADMIN, { types: [eventRow(EVENT)], workflows: [] });
    await screen.findByRole('form', { name: vi_['not.workflow.form.aria'] });
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.expiry.label'].replace('{min}', '1').replace('{max}', '525600')), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.resolver.label']), { target: { value: 'role-in-scope' } });
    fireEvent.click(screen.getByLabelText(vi_['not.workflow.channel.email']));
    fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.form.submit.action'] }));
    expect(await screen.findByText(vi_['not.workflow.form.roles.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['not.workflow.form.template.invalid'])).toBeTruthy();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('525600'))).toBe(true);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('writes the draft with the channels in the order chosen, the recipients, the priority, the acknowledgement and the expiry, and says another person must publish', async () => {
    const { h } = designer(ADMIN, { types: [eventRow(EVENT)], workflows: [] }, () => ({ status: 'DRAFT', resource_id: 'workflow-9', resource_version: 1 }));
    await screen.findByRole('form', { name: vi_['not.workflow.form.aria'] });
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.priority.label']), { target: { value: 'CRITICAL' } });
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.resolver.label']), { target: { value: 'role-in-scope' } });
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.roles.label']), { target: { value: 'PROJECT_MANAGER, ACCOUNTANT' } });
    fireEvent.click(screen.getByLabelText(vi_['not.workflow.channel.sms']));
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.template.label'].replace('{channel}', vi_['not.workflow.channel.sms'])), { target: { value: 'sms.a' } });
    fireEvent.click(screen.getByLabelText(vi_['not.workflow.channel.email']));
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.template.label'].replace('{channel}', vi_['not.workflow.channel.email'])), { target: { value: 'mail.a' } });
    // The SMS goes before the e-mail; the inbox stays first.
    fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.form.channels.up'].replace('{channel}', vi_['not.workflow.channel.sms']) }));
    fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.form.channels.up'].replace('{channel}', vi_['not.workflow.channel.sms']) }));
    fireEvent.click(screen.getByLabelText(vi_['not.workflow.form.ack.label']));
    fireEvent.click(screen.getByLabelText(vi_['not.workflow.form.override.label']));
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.overrideReason.label']), { target: { value: 'The incident desk must be reached at night.' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.form.submit.action'] }));
    expect(await screen.findByText(vi_['not.workflow.done.drafted'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { body: { event_type: string; definition: Record<string, unknown> } }];
    expect(operation).toBe('createNotificationWorkflowDraft');
    expect(input.body).toEqual({
      event_type: EVENT,
      definition: {
        priority: 'CRITICAL',
        purpose: 'OPERATIONAL',
        ackRequired: true,
        expiresAfterMinutes: 10080,
        channels: [{ channel: 'IN_APP' }, { channel: 'SMS', templateCode: 'sms.a' }, { channel: 'EMAIL', templateCode: 'mail.a' }],
        resolver: { kind: 'role-in-scope', roles: ['PROJECT_MANAGER', 'ACCOUNTANT'] },
        quietHoursOverride: true,
        quietHoursOverrideReason: 'The incident desk must be reached at night.',
      },
    });
  });

  it('keeps the inbox first and always there for an urgent message, as the core runs the plan', async () => {
    designer(ADMIN, { types: [eventRow(EVENT)], workflows: [] });
    const inbox = (await screen.findByLabelText(vi_['not.workflow.channel.inApp'])) as HTMLInputElement;
    expect(inbox.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.form.priority.label']), { target: { value: 'HIGH' } });
    expect(inbox.disabled).toBe(true);
    expect(inbox.checked).toBe(true);
    expect((screen.getByRole('button', { name: vi_['not.workflow.form.channels.up'].replace('{channel}', vi_['not.workflow.channel.email']) }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: vi_['not.workflow.form.channels.down'].replace('{channel}', vi_['not.workflow.channel.inApp']) }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers an event type once, with the latest schema version that is accepted, so the purposes are the ones the server judges by', async () => {
    designer(ADMIN, {
      types: [eventRow(EVENT, { schema_version: 1, allowed_purposes: ['OPERATIONAL'] }), eventRow(EVENT, { schema_version: 2, allowed_purposes: ['OPERATIONAL', 'DIGEST'] }), eventRow(EVENT, { schema_version: 3, status: 'Deprecated', allowed_purposes: ['SECURITY'] })],
      workflows: [],
    });
    await screen.findByRole('form', { name: vi_['not.workflow.form.aria'] });
    expect(within(screen.getByLabelText(vi_['not.workflow.event.label'])).getAllByRole('option')).toHaveLength(1);
    const purposes = within(screen.getByLabelText(vi_['not.workflow.form.purpose.label'])).getAllByRole('option').map((option) => option.textContent);
    expect(purposes).toEqual([vi_['not.workflow.purpose.operational'], vi_['not.workflow.purpose.digest']]);
  });

  it('shows the whole draft to the person who is to publish it: purpose, recipients, channels with their templates, acknowledgement, expiry and the override with its reason', async () => {
    const definition = {
      priority: 'CRITICAL',
      purpose: 'REMINDER',
      ackRequired: true,
      expiresAfterMinutes: 90,
      channels: [{ channel: 'SMS', templateCode: 'sms.a' }],
      resolver: { kind: 'role-in-scope', roles: ['PROJECT_MANAGER', 'ACCOUNTANT'] },
      quietHoursOverride: true,
      quietHoursOverrideReason: 'The incident desk must be reached at night.',
    };
    designer(ADMIN, { types: [eventRow(EVENT)], workflows: [workflowRow(1, { definition })] });
    fireEvent.click(await screen.findByRole('button', { name: vi_['not.workflow.publish.action'] }));
    const review = document.querySelector('[data-draft-definition]') as HTMLElement;
    expect(review.querySelector('[data-recipients]')?.textContent).toBe('Người giữ vai trò: PROJECT_MANAGER, ACCOUNTANT');
    // The plan as the core runs it: the inbox first and forced for a CRITICAL message, then the SMS with its template.
    expect(review.querySelector('[data-review-plan]')?.textContent).toBe(`${vi_['not.workflow.channel.inApp']} → ${vi_['not.workflow.channel.sms']} (sms.a)`);
    expect(review.querySelector('[data-review-override]')?.textContent).toContain('The incident desk must be reached at night.');
    for (const text of [vi_['not.workflow.purpose.reminder'], '90 phút', vi_['not.workflow.priority.critical']]) expect(within(review).getByText(text)).toBeTruthy();
  });

  it('starts the designer over when the tenant changes, though the catalogue of the other tenant is already cached: nothing prepared for one reaches the other', async () => {
    const h = harness((operation) => (operation === 'listNotificationEventTypes' ? { items: [eventRow(EVENT)] } : { items: [workflowRow(1)], next_cursor: null }));
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
              <WorkflowDesignerScreen route={routeOf('NOT-06', 'FR-NOT-06')} />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
    const first = render(tree(sessionOf('00000000-0000-4000-8000-0000000000a1', 'm-a')));
    fireEvent.click(await screen.findByRole('button', { name: vi_['not.workflow.publish.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.publish.reason.label']), { target: { value: reason } });
    first.rerender(tree(sessionOf('00000000-0000-4000-8000-0000000000b2', 'm-b')));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['not.workflow.publish.aria'] })).toBeNull());
    expect(screen.queryByDisplayValue(reason)).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says why a draft was refused: an event type that is gone, or a definition with a field that is wrong', async () => {
    for (const [error, message] of [
      [problem('EVENT_TYPE_UNKNOWN', 422, 'event_type'), vi_['not.workflow.problem.eventType']],
      [problem('WORKFLOW_DEFINITION_INVALID', 422, 'definition.purpose'), vi_['not.workflow.problem.definitionAt'].replace('{field}', 'definition.purpose')],
    ] as const) {
      designer(ADMIN, { types: [eventRow(EVENT)], workflows: [] }, () => error);
      await screen.findByRole('form', { name: vi_['not.workflow.form.aria'] });
      fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.form.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(message);
      cleanup();
    }
  });

  it('publishes a draft on the version it saw, with a reason, and tells that earlier notifications keep their revision', async () => {
    const { h } = designer(ADMIN, { types: [eventRow(EVENT)], workflows: [workflowRow(2, { version: 4 }), workflowRow(1, { status: 'Published', published_at: '2026-10-29T02:00:00Z', published_by: 'm-2' })] }, () => ({ status: 'PUBLISHED' }));
    const draftRow = (await screen.findByRole('table')).querySelector('[data-workflow-id="workflow-2"]') as HTMLElement;
    expect(within((await screen.findByRole('table')).querySelector('[data-workflow-id="workflow-1"]') as HTMLElement).queryByRole('button')).toBeNull();
    fireEvent.click(within(draftRow).getByRole('button', { name: vi_['not.workflow.publish.action'] }));
    fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.publish.confirm.action'] }));
    expect(await screen.findByText(vi_['not.workflow.publish.reason.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['not.workflow.publish.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.publish.confirm.action'] }));
    expect(await screen.findByText(vi_['not.workflow.done.published'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('post_notification_workflows_id_publish');
    expect(input.path).toEqual({ id: 'workflow-2' });
    expect(input.body).toEqual({ decision: 'approve', reason, evidence_ids: [] });
    expect(input.ifMatchVersion).toBe(4);
  });

  it('says that the author may not publish their own draft, and that the draft changed under them', async () => {
    for (const [error, message] of [
      [problem('SELF_APPROVAL_DENIED', 403), vi_['not.workflow.problem.self']],
      [problem('VERSION_CONFLICT'), vi_['not.workflow.problem.conflict']],
    ] as const) {
      designer(ADMIN, { types: [eventRow(EVENT)], workflows: [workflowRow(1)] }, () => error);
      fireEvent.click(await screen.findByRole('button', { name: vi_['not.workflow.publish.action'] }));
      fireEvent.change(screen.getByLabelText(vi_['not.workflow.publish.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['not.workflow.publish.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(message);
      cleanup();
    }
  });

  it('shows nothing to write in a suspended tenant (read-only) and nothing at all to someone without the right', async () => {
    const element = <WorkflowDesignerScreen route={routeOf('NOT-06', 'FR-NOT-06')} />;
    const h = harness((operation) => (operation === 'listNotificationEventTypes' ? { items: [eventRow(EVENT)] } : { items: [workflowRow(1)], next_cursor: null }));
    mount(element, h, { permissions: ADMIN, mode: 'READ_ONLY' });
    await screen.findByRole('table');
    expect(screen.queryByRole('form', { name: vi_['not.workflow.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['not.workflow.publish.action'] })).toBeNull();
    cleanup();
    const denied = designer(NOBODY, {});
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(denied.h.read).not.toHaveBeenCalled();
  });

  it('AC-ST-NOT-004-3 UI-NOT-06: shows a loading state, then the denied, signed-out, offline and error states, and says when the event type has no workflow', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      designer(ADMIN, { types: error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = designer(ADMIN, { types: [eventRow(EVENT)], workflows: [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['not.workflow.list.none'])).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText(vi_['not.workflow.event.label'])).toBeTruthy());
  });
});

describe('the model of NOT-05 and NOT-06', () => {
  it('reads an event type and a workflow, and takes what is not one for nothing', () => {
    expect(toEventType(null)).toBeUndefined();
    expect(toEventType({ owning_module: 'X' })).toBeUndefined();
    expect(toEventType(eventRow(EVENT))).toMatchObject({ eventType: EVENT, owningModule: 'DIS', allowedPurposes: ['OPERATIONAL', 'REMINDER'], classification: 'INTERNAL', active: true });
    expect(toEventType(eventRow(EVENT, { data_classification: 'WHATEVER', status: 'Deprecated' }))).toMatchObject({ classification: 'PERSONAL', active: false });
    expect(toEventTypes({ items: [eventRow(EVENT), { nope: true }] })).toHaveLength(1);
    expect(toEventTypes('x')).toEqual([]);
    expect(toWorkflow({ id: 'x' })).toBeUndefined();
    expect(toWorkflow(workflowRow(3))).toMatchObject({ id: 'workflow-3', revision: 3, status: 'Draft', version: 1, definition: { priority: 'HIGH', ackRequired: true, expiresAfterMinutes: 120, resolver: 'explicit', roles: [], overrideReason: undefined } });
    // The plan is shown as the core runs it: the inbox first, and forced for an urgent message; a plan of nothing is the inbox alone.
    expect(toWorkflow(workflowRow(3, { definition: { priority: 'LOW', channels: [{ channel: 'EMAIL', templateCode: 'm' }, { channel: 'IN_APP' }] } }))?.definition.channels.map((step) => step.channel)).toEqual(['IN_APP', 'EMAIL']);
    expect(toWorkflow(workflowRow(3, { definition: { priority: 'HIGH', channels: [{ channel: 'EMAIL', templateCode: 'm' }] } }))?.definition.channels.map((step) => step.channel)).toEqual(['IN_APP', 'EMAIL']);
    expect(toWorkflow(workflowRow(3, { definition: { priority: 'LOW', channels: [{ channel: 'EMAIL', templateCode: 'm' }] } }))?.definition.channels.map((step) => step.channel)).toEqual(['EMAIL']);
    expect(toWorkflow(workflowRow(3, { definition: { priority: 'LOW', channels: [] } }))?.definition.channels.map((step) => step.channel)).toEqual(['IN_APP']);
    expect(toWorkflow(workflowRow(3, { status: 'Odd' }))?.status).toBe('Draft');
    // A draft that says nothing runs on the defaults of the core: NORMAL, the operational purpose, no acknowledgement, seven days.
    expect(toWorkflow(workflowRow(3, { definition: {} }))?.definition).toMatchObject({ priority: 'NORMAL', purpose: 'OPERATIONAL', ackRequired: false, expiresAfterMinutes: 10080, quietHoursOverride: false });
    expect(toWorkflowPage({ items: [workflowRow(1), 7], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toWorkflowPage(null)).toEqual({ items: [], nextCursor: undefined });
  });

  it('judges the form the way the server does and builds the definition it reads', () => {
    const form = emptyForm('OPERATIONAL');
    expect(invalidFields(form, ['OPERATIONAL']).size).toBe(0);
    expect([...invalidFields({ ...form, purpose: 'DIGEST' }, ['OPERATIONAL'])]).toEqual(['purpose']);
    expect([...invalidFields({ ...form, expiresAfterMinutes: '1.5' }, ['OPERATIONAL'])]).toEqual(['expiry']);
    expect([...invalidFields({ ...form, resolverKind: 'role-in-scope', roles: ' , ' }, ['OPERATIONAL'])]).toEqual(['roles']);
    expect([...invalidFields({ ...form, channels: form.channels.map((row) => ({ ...row, enabled: false })) }, ['OPERATIONAL'])]).toEqual(['channels']);
    expect([...invalidFields({ ...form, channels: form.channels.map((row) => (row.channel === 'EMAIL' ? { ...row, enabled: true, templateCode: ' bad code' } : row)) }, ['OPERATIONAL'])]).toEqual(['templates']);
    expect([...invalidFields({ ...form, priority: 'HIGH', quietHoursOverride: true, overrideReason: 'The incident desk must be reached.' }, ['OPERATIONAL'])]).toEqual(['override']);
    expect(definitionFromForm(form)).toEqual({ priority: 'NORMAL', purpose: 'OPERATIONAL', ackRequired: false, expiresAfterMinutes: 10080, channels: [{ channel: 'IN_APP' }], resolver: { kind: 'explicit' }, quietHoursOverride: false });
  });

  it('moves a channel one place and leaves the ends alone; knows what can be published and what a good reason is', () => {
    const rows = emptyForm('OPERATIONAL').channels;
    // The inbox stays first and no channel goes above it.
    expect(moveChannel(rows, 1, -1)).toEqual(rows);
    expect(moveChannel(rows, 0, 1)).toEqual(rows);
    expect(moveChannel(rows, 2, -1).map((row) => row.channel).slice(0, 3)).toEqual(['IN_APP', 'SMS', 'EMAIL']);
    expect(moveChannel(rows, rows.length - 1, 1)).toEqual(rows);
    expect([canPublish({ status: 'Draft' }), canPublish({ status: 'Published' })]).toEqual([true, false]);
    expect([isPublishReasonValid('short'), isPublishReasonValid(reason)]).toEqual([false, true]);
  });

  it('names the problem by the code the server answered', () => {
    expect(describeProblem(problem('EVENT_TYPE_UNKNOWN', 422)).reason).toBe('eventType');
    expect(describeProblem(problem('WORKFLOW_DEFINITION_INVALID', 422, 'definition.priority'))).toEqual({ reason: 'definition', field: 'definition.priority' });
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', 403)).reason).toBe('self');
    expect(describeProblem(problem('WORKFLOW_NOT_DRAFT')).reason).toBe('notDraft');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });
});
