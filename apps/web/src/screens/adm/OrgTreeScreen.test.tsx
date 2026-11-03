import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import vi_ from '../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import type { WebRoute } from '../../routes/types';
import { SessionContext } from '../../session/SessionContext';
import type { SessionMode, SessionValue } from '../../session/SessionContext';
import { TENANT_A, TENANT_B } from '../../test/render';
import OrgTreeScreen from './OrgTreeScreen';

const ROUTE: WebRoute = { id: 'ADM-01', path: '/adm/adm-01', title: 'Cây tổ chức', kind: 'tree', area: 'admin', module: 'ADM', group: 'Tổ chức', role: 'workspace', parent: null, req: 'FR-ADM-01' };

function row(id: string, code: string, parent: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    code,
    name: `Đơn vị ${code}`,
    parent_id: parent,
    valid_from: '2025-01-01',
    valid_until: null,
    unit_type: 'DEPARTMENT',
    administrative_code: null,
    is_investor: false,
    legal_basis_ref: null,
    status: 'Active',
    successor_id: null,
    depth: 0,
    version: 3,
    ...extra,
  };
}

const UNITS = [
  row('a', 'A', null),
  row('b', 'B', 'a'),
  row('c', 'C', 'b'),
  row('old', 'OLD', null, { valid_until: '2025-03-01', successor_id: 'new', status: 'Superseded' }),
  row('new', 'NEW', null, { valid_from: '2025-03-01' }),
];

const MANAGER = ['iam.unit.manage', 'organization_unit.read'];

function problem(code: string, status: number, init: { detail?: string; extensions?: Record<string, unknown> } = {}): ApiError {
  return new ApiError({ status, code, detail: init.detail, extensions: init.extensions, correlationId: 'corr-1' });
}

const result = (id = 'new-unit', version = 1) => ({ operation_id: 'op-1', status: 'CREATED', resource_version: version, resource_id: id });

interface Harness {
  client: ApiClient;
  readAll: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
}

function harness(rows: unknown[] | Promise<unknown[]> | Error = UNITS): Harness {
  const readAll = vi.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)));
  const command = vi.fn(() => Promise.resolve(result()));
  return { client: { read: vi.fn(), readAll, command } as unknown as ApiClient, readAll, command };
}

function mount(h: Harness, permissions: readonly string[] | undefined = MANAGER, mode?: SessionMode) {
  const session: SessionValue = {
    tenant: TENANT_A,
    tenants: [TENANT_A],
    user: { displayName: 'Nguyễn An', initials: 'AN' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions,
    ...(mode === undefined ? {} : { mode }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={h.client}>
          <OrgTreeScreen route={ROUTE} />
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
}

const unitItem = (code: string) => screen.getByRole('treeitem', { name: new RegExp(`^${code} Đơn vị`) });
const selectButton = (code: string) => within(unitItem(code)).getByRole('button', { name: new RegExp(`^${code} Đơn vị ${code}$`) });
// "Đơn vị" is the name field; "Đơn vị kế thừa" is another field whose label starts the same way.
const nameInput = () => screen.getByRole('textbox', { name: /^Đơn vị(?! kế thừa)/ });

async function loaded(h: Harness, permissions?: readonly string[] | undefined, mode?: SessionMode): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  mount(h, permissions, mode);
  await screen.findByRole('tree');
  return user;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ADM-01 organisation tree: tenant switch', () => {
  afterEach(cleanup);

  it('keeps what the user typed in a new unit while the list reloads for the other tenant', async () => {
    let release: (rows: unknown[]) => void = () => undefined;
    const reloading = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    const readAll = vi.fn().mockResolvedValueOnce(UNITS).mockReturnValueOnce(reloading);
    const client = { read: vi.fn(), readAll, command: vi.fn() } as unknown as ApiClient;
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const sessionOf = (tenant: typeof TENANT_A): SessionValue => ({
      tenant,
      tenants: [TENANT_A, TENANT_B],
      user: { displayName: 'Nguyễn An', initials: 'AN' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: MANAGER,
    });
    const tree = (tenant: typeof TENANT_A) => (
      <SessionContext.Provider value={sessionOf(tenant)}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={client}>
            <OrgTreeScreen route={ROUTE} />
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
    const view = render(tree(TENANT_A));
    await userEvent.click(await screen.findByRole('button', { name: vi_['adm.orgUnit.create.action'] }));
    await userEvent.type(document.querySelector<HTMLInputElement>('#unit-name') as HTMLInputElement, 'Đơn vị chưa lưu');

    view.rerender(tree(TENANT_B));
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeInTheDocument();
    await act(async () => {
      release(UNITS);
    });
    await waitFor(() => expect(document.querySelector<HTMLInputElement>('#unit-name')?.value).toBe('Đơn vị chưa lưu'));
  });
});


describe('ADM-01 organisation tree', () => {
  it('shows the page frame of the mockup: title, subtitle, card, create action and the reference note', async () => {
    await loaded(harness());
    expect(screen.getByRole('heading', { level: 1, name: vi_['adm.orgUnit.page.title'] })).toBeInTheDocument();
    expect(screen.getByText(vi_['adm.orgUnit.page.subtitle'])).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: vi_['adm.orgUnit.tree.title'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: vi_['adm.orgUnit.create.action'] })).toBeInTheDocument();
    expect(screen.getByText(/ADM-01 \/ FR-ADM-01/)).toBeInTheDocument();
  });

  it('renders the units as a tree with levels, expanded by default, and selects a unit into the form', async () => {
    const user = await loaded(harness());
    const tree = screen.getByRole('tree', { name: vi_['adm.orgUnit.tree.label'] });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((item) => item.getAttribute('aria-level'))).toEqual(['1', '2', '3', '1', '1']);
    expect(unitItem('A')).toHaveAttribute('aria-expanded', 'true');
    expect(unitItem('C')).not.toHaveAttribute('aria-expanded');
    await user.click(selectButton('B'));
    expect(unitItem('B')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(vi_['adm.orgUnit.field.code.label'], { exact: false })).toHaveValue('B');
    expect(screen.getByLabelText(vi_['adm.orgUnit.field.parent.label'], { exact: false })).toHaveValue('A · Đơn vị A');
  });

  it('dims a superseded unit and links its successor, and the as-of date decides which are dimmed (AC-ST-ADM-004-3)', async () => {
    const user = await loaded(harness());
    const old = unitItem('OLD');
    expect(old).toHaveClass('dimmed');
    expect(unitItem('NEW')).not.toHaveClass('dimmed');
    await user.click(within(old).getByRole('button', { name: vi_['adm.orgUnit.node.successor.label'].replace('{name}', 'Đơn vị NEW') }));
    expect(unitItem('NEW')).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByLabelText(vi_['adm.orgUnit.asOf.label']), { target: { value: '2025-02-01' } });
    expect(unitItem('OLD')).not.toHaveClass('dimmed');
    expect(unitItem('NEW')).toHaveClass('dimmed');
  });

  it('collapses and expands a unit with the caret and moves with the arrow keys', async () => {
    const user = await loaded(harness());
    await user.click(within(unitItem('A')).getByRole('button', { name: vi_['adm.orgUnit.tree.expand.label'].replace('{name}', 'Đơn vị A') }));
    expect(screen.queryByRole('treeitem', { name: /Đơn vị B/ })).not.toBeInTheDocument();
    unitItem('A').focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('treeitem', { name: /Đơn vị B/ })).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(unitItem('B')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(unitItem('C')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(unitItem('B')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(unitItem('B')).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{End}');
    // Roots are in code order: A, NEW, OLD.
    expect(unitItem('OLD')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(unitItem('A')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(unitItem('A')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(unitItem('A')).toHaveAttribute('aria-selected', 'true');
  });

  describe('create', () => {
    async function fillCreate(user: ReturnType<typeof userEvent.setup>, code = 'D1'): Promise<void> {
      await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.create.action'] }));
      await user.type(nameInput(), 'Phòng mới');
      await user.type(screen.getByLabelText(vi_['adm.orgUnit.field.code.label'], { exact: false }), code);
      await user.selectOptions(screen.getByLabelText(vi_['adm.orgUnit.field.parent.label'], { exact: false }), 'a');
    }

    it('sends OrgUnitCreate with a fresh idempotency attempt, announces the result and reloads the list', async () => {
      const h = harness();
      const user = await loaded(h);
      await fillCreate(user);
      await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.create.submit'] }));
      await screen.findByText(vi_['adm.orgUnit.saved.notice']);
      expect(h.command).toHaveBeenCalledTimes(1);
      const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown>; attempt: { key: string } }];
      expect(operation).toBe('createOrganizationUnit');
      expect(input.body).toMatchObject({ code: 'D1', name: 'Phòng mới', parent_id: 'a', unit_type: 'DEPARTMENT' });
      expect(input.body).not.toHaveProperty('is_investor');
      expect(input.attempt.key).toMatch(/\S{16,}/);
      await waitFor(() => expect(h.readAll).toHaveBeenCalledTimes(2));
    });

    it('sends one request for a double click', async () => {
      const h = harness();
      let finish: (value: unknown) => void = () => undefined;
      h.command.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      const user = await loaded(h);
      await fillCreate(user);
      const submit = screen.getByRole('button', { name: vi_['adm.orgUnit.create.submit'] });
      await user.dblClick(submit);
      expect(h.command).toHaveBeenCalledTimes(1);
      await act(async () => finish(result()));
      await screen.findByText(vi_['adm.orgUnit.saved.notice']);
    });

    it('reuses the attempt for a retry of the same form and starts a new one when the form changed', async () => {
      const h = harness();
      h.command.mockRejectedValueOnce(problem(NETWORK_ERROR_CODE, 0)).mockRejectedValueOnce(problem(NETWORK_ERROR_CODE, 0)).mockResolvedValue(result());
      const user = await loaded(h);
      await fillCreate(user);
      const submit = screen.getByRole('button', { name: vi_['adm.orgUnit.create.submit'] });
      await user.click(submit);
      await screen.findByText(vi_['adm.orgUnit.error.general']);
      await user.click(submit);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      await screen.findByText(vi_['adm.orgUnit.error.general']);
      await user.type(screen.getByLabelText(vi_['adm.orgUnit.field.code.label'], { exact: false }), '2');
      await user.click(submit);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it.each([
      ['UNIT_CODE_TAKEN', 409, undefined, vi_['adm.orgUnit.error.codeTaken'], vi_['adm.orgUnit.field.code.label']],
      ['UNIT_DEPTH_EXCEEDED', 422, undefined, vi_['adm.orgUnit.error.depth'], vi_['adm.orgUnit.field.parent.label']],
      ['UNIT_VALIDITY_INVALID', 422, undefined, vi_['adm.orgUnit.error.validity'], vi_['adm.orgUnit.field.validFrom.label']],
      ['VALIDATION_FAILED', 422, 'administrative_code', vi_['adm.orgUnit.error.invalid'], vi_['adm.orgUnit.field.administrativeCode.label']],
      ['FIELD_NOT_ALLOWED', 400, 'name', vi_['adm.orgUnit.error.fieldNotAllowed'], vi_['adm.orgUnit.field.name.label']],
    ])('shows %s on its own field and keeps what the user typed', async (code, status, detail, message, label) => {
      const h = harness();
      h.command.mockRejectedValue(problem(code, status, { detail }));
      const user = await loaded(h);
      await fillCreate(user);
      await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.create.submit'] }));
      const alert = await screen.findByText(message);
      const field = label === vi_['adm.orgUnit.field.name.label'] ? nameInput() : screen.getByLabelText(label, { exact: false });
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field.closest('.field')).toContainElement(alert);
      expect(screen.getByLabelText(vi_['adm.orgUnit.field.code.label'], { exact: false })).toHaveValue('D1');
      expect(nameInput()).toHaveValue('Phòng mới');
    });

    it('sends the optional fields only when they are filled', async () => {
      const h = harness();
      const user = await loaded(h);
      await fillCreate(user, 'D2');
      await user.type(screen.getByLabelText(vi_['adm.orgUnit.field.administrativeCode.label'], { exact: false }), '12345');
      await user.type(screen.getByLabelText(vi_['adm.orgUnit.field.legalBasis.label'], { exact: false }), 'QĐ 12');
      await user.click(screen.getByLabelText(vi_['adm.orgUnit.field.isInvestor.label']));
      await user.selectOptions(screen.getByLabelText(vi_['adm.orgUnit.field.unitType.label'], { exact: false }), 'COMMUNE');
      await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.create.submit'] }));
      await screen.findByText(vi_['adm.orgUnit.saved.notice']);
      expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toMatchObject({ administrative_code: '12345', legal_basis_ref: 'QĐ 12', is_investor: true, unit_type: 'COMMUNE' });
    });
  });

  describe('update', () => {
    it('sends only the changed fields with the version the user saw as If-Match', async () => {
      const h = harness();
      const user = await loaded(h);
      await user.click(selectButton('B'));
      const save = screen.getByRole('button', { name: vi_['adm.orgUnit.update.submit'] });
      expect(save).toBeDisabled();
      const name = nameInput();
      await user.clear(name);
      await user.type(name, 'Phòng B mới');
      await user.click(save);
      await screen.findByText(vi_['adm.orgUnit.saved.notice']);
      expect(h.command).toHaveBeenCalledWith('updateOrganizationUnit', expect.objectContaining({ path: { unitId: 'b' }, body: { name: 'Phòng B mới' }, ifMatchVersion: 3 }));
    });

    it('keeps the user\'s edit visible on a version conflict, reloads the unit and offers the server values', async () => {
      const h = harness();
      h.command.mockRejectedValue(problem('VERSION_CONFLICT', 409, { extensions: { current_version: 8 } }));
      const user = await loaded(h);
      await user.click(selectButton('B'));
      const name = nameInput();
      await user.clear(name);
      await user.type(name, 'Bản của tôi');
      await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.update.submit'] }));
      await screen.findByText(vi_['adm.orgUnit.conflict.message'].replace('{version}', '8'));
      await waitFor(() => expect(h.readAll).toHaveBeenCalledTimes(2));
      expect(nameInput()).toHaveValue('Bản của tôi');
      await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.conflict.reload'] }));
      expect(nameInput()).toHaveValue('Đơn vị B');
    });
  });

  describe('move', () => {
    async function openMove(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(selectButton('C'));
      await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.move.action'] }));
    }

    it('moves a unit with the new parent, the date and a reason of at least ten characters', async () => {
      const h = harness();
      const user = await loaded(h);
      await openMove(user);
      const dialog = screen.getByRole('dialog');
      const submit = within(dialog).getByRole('button', { name: vi_['adm.orgUnit.move.submit'] });
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.orgUnit.move.parent.label']), 'a');
      expect(submit).toBeDisabled();
      await user.type(within(dialog).getByLabelText(vi_['adm.orgUnit.move.reason.label']), 'Tổ chức lại các phòng');
      await user.click(submit);
      await screen.findByText(vi_['adm.orgUnit.moved.notice']);
      expect(h.command).toHaveBeenCalledWith(
        'moveOrganizationUnit',
        expect.objectContaining({ path: { unitId: 'c' }, ifMatchVersion: 3, body: expect.objectContaining({ new_parent_id: 'a', reason: 'Tổ chức lại các phòng' }) as unknown }),
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it.each([
      ['UNIT_CYCLE', 'adm.orgUnit.error.cycle'],
      ['UNIT_DEPTH_EXCEEDED', 'adm.orgUnit.error.depth'],
    ] as const)('shows %s on the new parent field of the dialog and keeps the dialog open', async (code, key) => {
      const h = harness();
      h.command.mockRejectedValue(problem(code, 422));
      const user = await loaded(h);
      await openMove(user);
      const dialog = screen.getByRole('dialog');
      await user.selectOptions(within(dialog).getByLabelText(vi_['adm.orgUnit.move.parent.label']), 'a');
      await user.type(within(dialog).getByLabelText(vi_['adm.orgUnit.move.reason.label']), 'Tổ chức lại các phòng');
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.orgUnit.move.submit'] }));
      const alert = await within(dialog).findByText(vi_[key]);
      expect(within(dialog).getByLabelText(vi_['adm.orgUnit.move.parent.label'])).toHaveAttribute('aria-invalid', 'true');
      expect(alert.closest('.field')).toContainElement(within(dialog).getByLabelText(vi_['adm.orgUnit.move.parent.label']));
      expect(within(dialog).getByLabelText(vi_['adm.orgUnit.move.reason.label'])).toHaveValue('Tổ chức lại các phòng');
    });

    it('closes the dialog with cancel and never offers the unit itself as its parent', async () => {
      const user = await loaded(harness());
      await openMove(user);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).queryByRole('option', { name: /C · Đơn vị C/ })).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: vi_['adm.orgUnit.move.cancel'] }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('read-only mode', () => {
    it('hides the create and submit controls and disables the fields without iam.unit.manage', async () => {
      const user = await loaded(harness(), ['organization_unit.read']);
      expect(screen.queryByRole('button', { name: vi_['adm.orgUnit.create.action'] })).not.toBeInTheDocument();
      await user.click(selectButton('B'));
      expect(screen.getByText(vi_['adm.orgUnit.readonly.notice'])).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: vi_['adm.orgUnit.update.submit'] })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: vi_['adm.orgUnit.move.action'] })).not.toBeInTheDocument();
      expect(nameInput()).toBeDisabled();
    });

    it('is read-only in READ_ONLY mode (a suspended tenant) even for a user who may manage units', async () => {
      const user = await loaded(harness(), MANAGER, 'READ_ONLY');
      expect(screen.queryByRole('button', { name: vi_['adm.orgUnit.create.action'] })).not.toBeInTheDocument();
      await user.click(selectButton('B'));
      expect(screen.queryByRole('button', { name: vi_['adm.orgUnit.update.submit'] })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: vi_['adm.orgUnit.move.action'] })).not.toBeInTheDocument();
      expect(nameInput()).toBeDisabled();
    });

    it('does not restrict the controls when the session does not list permissions (the server decides)', async () => {
      await loaded(harness(), undefined);
      expect(screen.getByRole('button', { name: vi_['adm.orgUnit.create.action'] })).toBeInTheDocument();
    });
  });

  describe('standard UI states (AC-ST-ADM-004-3)', () => {
    it('shows the loading skeleton while the list loads', () => {
      mount(harness(new Promise(() => undefined)));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeInTheDocument();
    });

    it('shows the empty state for a tenant without units, and no create action', async () => {
      mount(harness([]));
      expect(await screen.findByText(vi_['states.empty.title'])).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: vi_['adm.orgUnit.create.action'] })).not.toBeInTheDocument();
    });

    it.each([
      ['denied', problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ['signedOut', problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
      ['offline', problem(NETWORK_ERROR_CODE, 0), 'states.offline.title'],
      ['error', problem('INTERNAL_ERROR', 500), 'states.error.title'],
    ] as const)('shows the %s state for the matching failure', async (_state, error, titleKey) => {
      mount(harness(error));
      expect(await screen.findByText(vi_[titleKey])).toBeInTheDocument();
    });

    it('retries the load from the state card', async () => {
      const h = harness(problem('INTERNAL_ERROR', 500));
      mount(h);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
      await waitFor(() => expect(h.readAll).toHaveBeenCalledTimes(2));
    });
  });
});

describe('ADM-01 organisation tree: the draft keeps the version it was made from', () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  // A window focus refetches the list, which is how another admin's change reaches an open form.
  const refetchNow = (): void => {
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
  };

  const sequence = (...answers: Array<unknown[] | Error>): Harness => {
    const readAll = vi.fn();
    for (const answer of answers) readAll.mockImplementationOnce(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
    readAll.mockImplementation(() => Promise.resolve(answers[answers.length - 1] as unknown[]));
    const command = vi.fn(() => Promise.resolve(result()));
    return { client: { read: vi.fn(), readAll, command } as unknown as ApiClient, readAll, command };
  };

  const WITH_CODE = [row('a', 'A', null), row('b', 'B', 'a', { administrative_code: 'OLD1' })];
  const CHANGED_BY_OTHER = [row('a', 'A', null), row('b', 'B', 'a', { administrative_code: 'NEW1', version: 4 })];

  it("sends the version and the fields of the snapshot, so another admin's change is never restored over", async () => {
    const h = sequence(WITH_CODE, CHANGED_BY_OTHER);
    const user = await loaded(h);
    await user.click(selectButton('B'));
    const name = nameInput();
    await user.clear(name);
    await user.type(name, 'Tên mới');
    refetchNow();
    await waitFor(() => expect(h.readAll).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(vi_['adm.orgUnit.stale.message'].replace('{version}', '4'))).toBeInTheDocument();
    expect(nameInput()).toHaveValue('Tên mới');
    await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.update.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('updateOrganizationUnit', expect.objectContaining({ path: { unitId: 'b' }, body: { name: 'Tên mới' }, ifMatchVersion: 3 }));
  });

  it('adopts the server values without a notice when the user has not typed anything', async () => {
    const h = sequence(WITH_CODE, [row('a', 'A', null), row('b', 'B', 'a', { name: 'Tên từ máy chủ', version: 4 })]);
    const user = await loaded(h);
    await user.click(selectButton('B'));
    refetchNow();
    await waitFor(() => expect(nameInput()).toHaveValue('Tên từ máy chủ'));
    expect(screen.queryByText(vi_['adm.orgUnit.stale.message'].replace('{version}', '4'))).not.toBeInTheDocument();
  });

  it('offers the server values from the notice and drops the draft on reload', async () => {
    const h = sequence(WITH_CODE, CHANGED_BY_OTHER);
    const user = await loaded(h);
    await user.click(selectButton('B'));
    await user.type(nameInput(), ' sửa');
    refetchNow();
    await screen.findByText(vi_['adm.orgUnit.stale.message'].replace('{version}', '4'));
    await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.conflict.reload'] }));
    expect(nameInput()).toHaveValue('Đơn vị B');
    expect(screen.queryByText(vi_['adm.orgUnit.stale.message'].replace('{version}', '4'))).not.toBeInTheDocument();
  });

  it('keeps the editor and what was typed when a background refresh fails, with a banner', async () => {
    const h = sequence(WITH_CODE, problem('INTERNAL_ERROR', 500));
    const user = await loaded(h);
    await user.click(selectButton('B'));
    await user.type(nameInput(), ' sửa');
    refetchNow();
    expect(await screen.findByText(vi_['adm.orgUnit.refresh.error'])).toBeInTheDocument();
    expect(nameInput()).toHaveValue('Đơn vị B sửa');
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });

  it('sends an empty string for an optional text the user cleared', async () => {
    const h = sequence(WITH_CODE);
    const user = await loaded(h);
    await user.click(selectButton('B'));
    await user.clear(screen.getByLabelText(new RegExp(vi_['adm.orgUnit.field.administrativeCode.label'])));
    await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.update.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('updateOrganizationUnit', expect.objectContaining({ body: { administrative_code: '' } }));
  });

  it('continues keyboard navigation from the unit that was clicked', async () => {
    const h = harness();
    const user = await loaded(h);
    await user.click(selectButton('A'));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(unitItem('C')).toHaveFocus();
    await user.click(selectButton('B'));
    await user.keyboard('{ArrowDown}');
    expect(unitItem('C')).toHaveFocus();
  });

  it('freezes the snapshot it adopted: a second change by another admin is not overwritten once the user types', async () => {
    const v4 = [row('a', 'A', null), row('b', 'B', 'a', { administrative_code: 'NEW1', version: 4 })];
    const v5 = [row('a', 'A', null), row('b', 'B', 'a', { administrative_code: 'NEWER', version: 5 })];
    const h = sequence(WITH_CODE, v4, v5);
    const user = await loaded(h);
    await user.click(selectButton('B'));
    const code = () => screen.getByLabelText(new RegExp(vi_['adm.orgUnit.field.administrativeCode.label']));
    refetchNow();
    await waitFor(() => expect(code()).toHaveValue('NEW1'));
    await user.type(nameInput(), ' sửa');
    refetchNow();
    await screen.findByText(vi_['adm.orgUnit.stale.message'].replace('{version}', '5'));
    await user.click(screen.getByRole('button', { name: vi_['adm.orgUnit.update.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('updateOrganizationUnit', expect.objectContaining({ body: { name: 'Đơn vị B sửa' }, ifMatchVersion: 4 }));
  });

  it('keeps the draft and the snapshot when the selected unit is clicked again', async () => {
    const h = sequence(WITH_CODE, CHANGED_BY_OTHER);
    const user = await loaded(h);
    await user.click(selectButton('B'));
    await user.type(nameInput(), ' sửa');
    await user.click(selectButton('B'));
    expect(nameInput()).toHaveValue('Đơn vị B sửa');
    refetchNow();
    await screen.findByText(vi_['adm.orgUnit.stale.message'].replace('{version}', '4'));
    expect(nameInput()).toHaveValue('Đơn vị B sửa');
  });

  it.each([
    ['signedOut', problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
    ['denied', problem('SCOPE_DENIED', 403), 'states.denied.title'],
  ] as const)('leaves the editor for the %s state when a background refresh is refused', async (_state, error, titleKey) => {
    const h = sequence(WITH_CODE, error);
    const user = await loaded(h);
    await user.click(selectButton('B'));
    await user.type(nameInput(), ' sửa');
    refetchNow();
    expect(await screen.findByText(vi_[titleKey])).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.queryByText(vi_['adm.orgUnit.refresh.error'])).not.toBeInTheDocument();
  });

  it('does not carry an edit draft to the other tenant, even when the unit id exists there too', async () => {
    const readAll = vi.fn().mockResolvedValue(UNITS);
    const client = { read: vi.fn(), readAll, command: vi.fn() } as unknown as ApiClient;
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const sessionOf = (tenant: typeof TENANT_A): SessionValue => ({
      tenant,
      tenants: [TENANT_A, TENANT_B],
      user: { displayName: 'Nguyễn An', initials: 'AN' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: MANAGER,
    });
    const tree = (tenant: typeof TENANT_A) => (
      <SessionContext.Provider value={sessionOf(tenant)}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={client}>
            <OrgTreeScreen route={ROUTE} />
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
    const view = render(tree(TENANT_A));
    await userEvent.click(await screen.findByRole('button', { name: /^B Đơn vị B$/ }));
    await userEvent.type(nameInput(), ' của A');
    view.rerender(tree(TENANT_B));
    await screen.findByRole('tree');
    expect(screen.queryByDisplayValue('Đơn vị B của A')).not.toBeInTheDocument();
    expect(screen.getByText(vi_['adm.orgUnit.form.idle.hint'])).toBeInTheDocument();
  });
});
