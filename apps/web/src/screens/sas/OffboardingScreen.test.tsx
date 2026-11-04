import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import OffboardingScreen from './OffboardingScreen';
import { canArchive, canOffboard, describeProblem, downloadedOf, isDateValid, isPending, isServable, isWindowValid, looksLikePublicKey, toExport, toExportPage, toLink, toManifest, toTenantExit } from './offboarding/model';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-17', 'FR-SAS-17');
const OWNER = ['tenant.export'];
const ADMIN = ['system.tenant.read', 'system.tenant.manage'];
const READER = ['system.tenant.read'];
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const FUTURE = new Date(Date.now() + 48 * 3_600_000).toISOString();
const reason = 'The province asked for its data at the end of the contract.';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const exportRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `export-${n}`,
  status: 'Ready',
  scope: 'FULL',
  reason: 'End of the contract',
  requested_at: '2026-10-30T02:00:00Z',
  snapshot_at: '2026-10-30T02:00:10Z',
  ready_at: '2026-10-30T02:01:00Z',
  expires_at: FUTURE,
  delivered_at: null,
  file_count: 3,
  total_bytes: '4096',
  manifest_sha256: 'a'.repeat(64),
  row_counts: { project: 2 },
  files_downloaded: ['manifest.json'],
  encrypted: false,
  encryption_key_fingerprint: null,
  error_code: null,
  version: 3,
  ...overrides,
});

const manifest = {
  schema_version: 1,
  job_id: 'export-1',
  tenant_id: TENANT,
  scope: 'FULL',
  snapshot_at: '2026-10-30T02:00:10Z',
  files: [
    { path: 'tables/project.jsonl', bytes: 120, sha256: 'b'.repeat(64), table: 'project', rows: 2 },
    { path: 'tables/unit.jsonl', bytes: 80, sha256: 'c'.repeat(64), table: 'unit', rows: 1 },
  ],
  row_counts: { project: 2, unit: 1 },
  omitted_columns: { integration_connector: ['secret_ref'] },
  missing_files: [],
  encryption_key_fingerprint: null,
};

const exit = (overrides: Record<string, unknown> = {}) => ({
  tenant_status: 'Active',
  tenant_version: 5,
  contract_end_date: null,
  export_window_days: null,
  export_window_ends_at: null,
  offboarding_started_at: null,
  archived_at: null,
  legal_holds_active: 0,
  export_delivered: false,
  items: [],
  next_cursor: null,
  ...overrides,
});

afterEach(cleanup);

interface World {
  exports?: Array<Record<string, unknown>> | Error;
  version?: number;
  exit?: Record<string, unknown> | Error;
}

function open(permissions: readonly string[], world: World = {}, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation, input) => {
    switch (operation) {
      case 'listTenantExports':
        return world.exports instanceof Error ? world.exports : { items: world.exports ?? [], next_cursor: null, exports_version: world.version ?? (world.exports as unknown[] | undefined)?.length ?? 0 };
      case 'getTenantExportManifest':
        return manifest;
      case 'downloadTenantExportFile':
        return { export_id: 'export-1', path: (input as { query: { path: string } }).query.path, url: '/tenant-exports/export-1/content?x=1', expires_at: FUTURE, bytes: 120, sha256: 'b'.repeat(64) };
      case 'listSystemTenants':
        return { items: [{ id: TENANT, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: null };
      case 'listSystemTenantExports':
        return world.exit ?? exit();
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  const element = <OffboardingScreen route={ROUTE} />;
  return { h, ...mount(element, h, permissions, '/sas/sas-17') };
}

describe('SAS-17 the export of the data of a tenant (UI-SAS-17)', () => {
  it('shows the request form and the exports to the owner, and nothing of the System Admin', async () => {
    open(OWNER, { exports: [exportRow(1)] });
    expect(await screen.findByRole('form', { name: vi_['sas.exit.export.aria'] })).toBeTruthy();
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.queryByText(vi_['sas.exit.leaving.title'])).toBeNull();
    expect(screen.queryByLabelText(vi_['sas.exit.tenant.label'])).toBeNull();
  });

  it('refuses a request with a short reason or a key that is not a public key, and sends nothing', async () => {
    const { h } = open(OWNER, { exports: [] });
    fireEvent.change(await screen.findByLabelText(vi_['sas.exit.export.key.label']), { target: { value: 'not a key' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.export.submit.action'] }));
    expect(await screen.findByText(vi_['sas.exit.export.reason.tooShort'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.exit.export.key.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('asks for the export on the version of the list it saw, with the scope, the key and the reason, and says it was received', async () => {
    const key = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----';
    const { h } = open(OWNER, { exports: [exportRow(1, { status: 'Delivered' })], version: 4 }, () => ({ status: 'REQUESTED' }));
    await screen.findByRole('table');
    fireEvent.click(screen.getByLabelText(vi_['sas.exit.scope.business']));
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.export.key.label']), { target: { value: key } });
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.export.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.export.submit.action'] }));
    expect(await screen.findByText(vi_['sas.exit.export.done'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('post_tenants_id_export');
    expect(input.path).toEqual({ id: '00000000-0000-4000-8000-0000000000aa' });
    expect(input.body).toEqual({ scope: 'BUSINESS_DATA_ONLY', reason, encryption_public_key_pem: key });
    expect(input.ifMatchVersion).toBe(4);
  });

  it('does not offer a second request while one waits or runs', async () => {
    open(OWNER, { exports: [exportRow(1, { status: 'Running', ready_at: null, expires_at: null, file_count: null, total_bytes: null })] });
    await screen.findByRole('table');
    expect((screen.getByRole('button', { name: vi_['sas.exit.export.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(vi_['sas.exit.export.waiting'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.exit.manifest.show.action'] })).toBeNull();
  });

  it('says why a request was refused: one is running, or the list changed', async () => {
    for (const [error, message] of [
      [problem('EXPORT_ALREADY_RUNNING'), vi_['sas.exit.problem.running']],
      [problem('VERSION_CONFLICT'), vi_['sas.exit.problem.conflict']],
      [problem('VALIDATION_FAILED', 422, 'encryption_public_key_pem'), vi_['sas.exit.problem.key']],
    ] as const) {
      open(OWNER, { exports: [] }, () => error);
      fireEvent.change(await screen.findByLabelText(vi_['sas.exit.export.reason.label']), { target: { value: reason } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.export.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(message);
      cleanup();
    }
  });

  it('opens the manifest of a Ready export: every file with its size, rows and the start of its sha256, the columns left out, and a link for each file and the manifest', async () => {
    const { h } = open(OWNER, { exports: [exportRow(1)] });
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.exit.manifest.show.action'] }));
    const rows = await waitFor(() => {
      const found = document.querySelectorAll('[data-files] tbody tr');
      expect(found.length).toBe(3);
      return [...found];
    });
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual(['manifest.json', 'tables/project.jsonl', 'tables/unit.jsonl']);
    expect(rows[1]?.textContent).toContain('b'.repeat(16));
    expect(screen.getByText(/integration_connector/)).toBeTruthy();
    expect(screen.getByText(vi_['sas.exit.manifest.verify'])).toBeTruthy();
    // A link is asked for each time, for one file; with it the file can be downloaded.
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: vi_['sas.exit.file.link.action'] }));
    const anchor = await within(rows[1] as HTMLElement).findByRole('link', { name: vi_['sas.exit.file.download.link'] });
    expect(anchor.getAttribute('href')).toBe('/tenant-exports/export-1/content?x=1');
    const asked = h.read.mock.calls.filter((call) => call[0] === 'downloadTenantExportFile');
    expect(asked).toHaveLength(1);
    expect((asked[0]?.[1] as { query: { path: string } }).query.path).toBe('tables/project.jsonl');
  });

  it('warns that the data refers to files the store did not return, and asks for a new link once the one it has ended', async () => {
    const link = (expiresAt: string) => ({ export_id: 'export-1', path: 'tables/project.jsonl', url: '/tenant-exports/export-1/content?x=1', expires_at: expiresAt, bytes: 120, sha256: 'b'.repeat(64) });
    const answers = [link(new Date(Date.now() - 1000).toISOString()), link(FUTURE)];
    const h = harness((operation) => {
      if (operation === 'listTenantExports') return { items: [exportRow(1)], next_cursor: null, exports_version: 1 };
      if (operation === 'getTenantExportManifest') return { ...manifest, missing_files: ['tenants/x/documents/a.pdf', 'tenants/x/sigreport/b.pdf'] };
      if (operation === 'downloadTenantExportFile') return answers.shift();
      return new Error('unexpected');
    });
    const element = <OffboardingScreen route={ROUTE} />;
    mount(element, h, OWNER, '/sas/sas-17');
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.exit.manifest.show.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain('2');
    const row = await waitFor(() => {
      const found = document.querySelector('[data-path="tables/project.jsonl"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(row).getByRole('button', { name: vi_['sas.exit.file.link.action'] }));
    // The link that came back had ended already: the button is offered again, and the second link is shown.
    await waitFor(() => expect(within(row).queryByRole('link')).toBeNull());
    fireEvent.click(within(row).getByRole('button', { name: vi_['sas.exit.file.link.action'] }));
    expect(await within(row).findByRole('link', { name: vi_['sas.exit.file.download.link'] })).toBeTruthy();
  });

  it('replaces a link by the button that asks for another when its five minutes end, with nothing else making the screen draw again', async () => {
    const endsAt = new Date(Date.now() + 1500).toISOString();
    const h = harness((operation) => {
      if (operation === 'listTenantExports') return { items: [exportRow(1)], next_cursor: null, exports_version: 1 };
      if (operation === 'getTenantExportManifest') return manifest;
      if (operation === 'downloadTenantExportFile') return { export_id: 'export-1', path: 'tables/project.jsonl', url: '/tenant-exports/export-1/content?x=1', expires_at: endsAt, bytes: 120, sha256: 'b'.repeat(64) };
      return new Error('unexpected');
    });
    const element = <OffboardingScreen route={ROUTE} />;
    mount(element, h, OWNER, '/sas/sas-17');
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.exit.manifest.show.action'] }));
    const row = await waitFor(() => {
      const found = document.querySelector('[data-path="tables/project.jsonl"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(row).getByRole('button', { name: vi_['sas.exit.file.link.action'] }));
    expect(await within(row).findByRole('link', { name: vi_['sas.exit.file.download.link'] })).toBeTruthy();
    // No click, no new data: the link ends by itself and the button to ask for another is back.
    await waitFor(() => expect(within(row).queryByRole('link')).toBeNull(), { timeout: 4000 });
    expect(within(row).getByRole('button', { name: vi_['sas.exit.file.link.action'] })).toBeTruthy();
  });

  it('shows how many files were downloaded, and offers nothing for an export that expired or failed', async () => {
    open(OWNER, { exports: [exportRow(1), exportRow(2, { status: 'Expired' }), exportRow(3, { status: 'Failed', error_code: 'StorageError', ready_at: null, expires_at: null, file_count: null })] });
    await screen.findByRole('table');
    const rows = [...document.querySelectorAll('[data-exports] tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[data-downloaded]')?.textContent).toContain('1/3');
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: vi_['sas.exit.manifest.show.action'] })).toBeNull();
    expect(within(rows[2] as HTMLElement).queryByRole('button')).toBeNull();
    expect(rows[2]?.textContent).toContain('StorageError');
  });

  it('reads the exports again while one is being made, and only slowly otherwise', async () => {
    const waiting = open(OWNER, { exports: [exportRow(1, { status: 'Running', ready_at: null, expires_at: null, file_count: null })] });
    await screen.findByRole('table');
    const intervals = () =>
      waiting.queries
        .getQueryCache()
        .getAll()
        .map((query) => query.observers[0]?.options.refetchInterval as ((q: unknown) => number) | number | undefined);
    const fast = intervals().map((value) => (typeof value === 'function' ? value(waiting.queries.getQueryCache().getAll()[0]) : value));
    expect(fast).toContain(5_000);
    cleanup();
    const idle = open(OWNER, { exports: [exportRow(1)] });
    await screen.findByRole('table');
    const slow = idle.queries
      .getQueryCache()
      .getAll()
      .map((query) => {
        const value = query.observers[0]?.options.refetchInterval;
        return typeof value === 'function' ? (value as (q: unknown) => number)(query) : value;
      });
    expect(slow).toContain(60_000);
  });
});

describe('SAS-17 the end of service of a tenant (UI-SAS-17)', () => {
  it('shows the System Admin the state of the tenant, the window, whether an export was delivered and the legal holds in force', async () => {
    open(ADMIN, {
      exit: exit({ tenant_status: 'Offboarding', contract_end_date: '2026-12-31', export_window_days: 90, export_window_ends_at: '2027-04-01T00:00:00Z', legal_holds_active: 2, export_delivered: true, items: [exportRow(1, { status: 'Delivered', delivered_at: '2026-11-01T00:00:00Z' })] }),
    });
    await screen.findByText(vi_['sas.exit.leaving.title']);
    const window = document.querySelector('[data-window]') as HTMLElement;
    expect(window.textContent).toContain('2026-12-31');
    expect(window.textContent).toContain('90');
    expect(document.querySelector('[data-delivered]')?.textContent).toBe(vi_['sas.exit.leaving.yes']);
    expect(document.querySelector('[data-holds]')?.textContent).toContain('2');
    expect(screen.getByText(vi_['sas.exit.leaving.holdsRule'])).toBeTruthy();
    expect(document.querySelectorAll('[data-tenant-exports] tbody tr')).toHaveLength(1);
    // The System Admin does not see the owner's form.
    expect(screen.queryByRole('form', { name: vi_['sas.exit.export.aria'] })).toBeNull();
  });

  it('starts the offboarding of an Active tenant with the end of the contract, the days and a reason, on the version it saw', async () => {
    const { h } = open(ADMIN, { exit: exit() }, () => ({ status: 'Offboarding', version: 6 }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.exit.offboard.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.act.reason.label']), { target: { value: 'no' } });
    fireEvent.change(screen.getByLabelText(/Số ngày/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.exit.offboard.end.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.exit.act.reason.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.offboard.end.label']), { target: { value: '2026-12-31' } });
    fireEvent.change(screen.getByLabelText(/Số ngày/), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.act.reason.label']), { target: { value: 'The contract ends and will not be renewed.' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.exit.done.offboard'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('startTenantOffboarding');
    expect(input.path).toEqual({ tenantId: TENANT });
    expect(input.body).toEqual({ contract_end_date: '2026-12-31', export_window_days: 90, reason: 'The contract ends and will not be renewed.' });
    expect(input.ifMatchVersion).toBe(5);
  });

  it('leaves a confirmation behind when another tenant is chosen: an action prepared for one tenant never reaches another', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000b2';
    const h = harness((operation) => {
      if (operation === 'listSystemTenants')
        return {
          items: [
            { id: TENANT, code: 'cao-bang', name: 'Cao Bằng' },
            { id: OTHER, code: 'lang-son', name: 'Lạng Sơn' },
          ],
          next_cursor: null,
        };
      if (operation === 'listSystemTenantExports') return exit();
      return new Error('unexpected');
    });
    const element = <OffboardingScreen route={ROUTE} />;
    mount(element, h, ADMIN, '/sas/sas-17');
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.exit.offboard.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.act.reason.label']), { target: { value: 'The contract ends and will not be renewed.' } });
    expect(screen.queryByRole('form', { name: vi_['sas.exit.act.aria'] })).not.toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.tenant.label']), { target: { value: OTHER } });
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.exit.act.aria'] })).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
    // Back on the first tenant the confirmation is not there either: it was dropped, not hidden, and what was typed with it.
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.tenant.label']), { target: { value: TENANT } });
    await screen.findByRole('button', { name: vi_['sas.exit.offboard.action'] });
    expect(screen.queryByRole('form', { name: vi_['sas.exit.act.aria'] })).toBeNull();
  });

  it('archives an Offboarding tenant, or brings it back when the contract is renewed, and says why an early archive is refused', async () => {
    const leaving = exit({ tenant_status: 'Offboarding', contract_end_date: '2026-12-31', export_window_days: 90, export_window_ends_at: FUTURE });
    const { h } = open(ADMIN, { exit: leaving }, (operation) => (operation === 'archiveTenant' ? problem('EXPORT_NOT_CONFIRMED') : { status: 'Active' }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.exit.archive.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.act.reason.label']), { target: { value: 'The export was delivered.' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.act.confirm.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['sas.exit.problem.notConfirmed']);
    expect((h.command.mock.calls[0] as [string, unknown])[0]).toBe('archiveTenant');
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.renew.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.exit.act.reason.label']), { target: { value: 'The contract was renewed.' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.exit.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.exit.done.renew'])).toBeTruthy();
    expect((h.command.mock.calls[1] as [string, unknown])[0]).toBe('resumeTenant');
  });

  it('offers no action to a registry reader, and none that the state of the tenant does not allow', async () => {
    open(READER, { exit: exit() });
    await screen.findByText(vi_['sas.exit.leaving.title']);
    expect(screen.queryByRole('button', { name: vi_['sas.exit.offboard.action'] })).toBeNull();
    cleanup();
    open(ADMIN, { exit: exit({ tenant_status: 'Archived', archived_at: '2026-12-01T00:00:00Z' }) });
    await screen.findByText(vi_['sas.exit.leaving.title']);
    for (const name of [vi_['sas.exit.offboard.action'], vi_['sas.exit.archive.action'], vi_['sas.exit.renew.action']]) expect(screen.queryByRole('button', { name })).toBeNull();
  });
});

describe('the seven states of SAS-17 (AC-ST-SAS-016-3, UI-SAS-17)', () => {
  const failing = (error: ApiError) => open(OWNER, { exports: error });

  it('AC-ST-SAS-016-3 UI-SAS-17: shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });

  it('AC-ST-SAS-016-3 UI-SAS-17: says in words that there is no export yet, with the page title and the manifest, legal hold and window fields on the System Admin side', async () => {
    open(OWNER, { exports: [] });
    expect(await screen.findByText(vi_['sas.exit.list.none'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.exit.page.title']);
    cleanup();
    open(ADMIN, { exit: exit() });
    await screen.findByText(vi_['sas.exit.leaving.title']);
    expect(screen.getByText(vi_['sas.exit.leaving.window'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.exit.leaving.holds'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.exit.leaving.noExports'])).toBeTruthy();
  });

  it('AC-ST-SAS-016-3 UI-SAS-17: shows the denied state for the System Admin side too', async () => {
    open(ADMIN, { exit: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });
});

describe('the model of SAS-17', () => {
  it('reads an export, a page, a manifest, a link and the state of a tenant that leaves, and takes what is not one for nothing', () => {
    expect(toExport(null)).toBeUndefined();
    expect(toExport({ status: 'Ready' })).toBeUndefined();
    expect(toExport(exportRow(1))).toMatchObject({ id: 'export-1', status: 'Ready', scope: 'FULL', fileCount: 3, totalBytes: '4096', filesDownloaded: ['manifest.json'], encrypted: false, deliveredAt: undefined, errorCode: undefined });
    expect(toExport(exportRow(2, { status: 'Whatever' }))?.status).toBe('Requested');
    expect(toExportPage({ items: [exportRow(1), { nope: true }], next_cursor: 'c', exports_version: 7 })).toMatchObject({ nextCursor: 'c', exportsVersion: 7 });
    expect(toExportPage('x')).toEqual({ items: [], nextCursor: undefined, exportsVersion: 0 });
    expect(toManifest({ files: 'x' })).toBeUndefined();
    expect(toManifest(manifest)).toMatchObject({ jobId: 'export-1', rowCounts: { project: 2, unit: 1 }, omittedColumns: { integration_connector: ['secret_ref'] }, files: [{ path: 'tables/project.jsonl', bytes: 120, rows: 2, encrypted: false }, { path: 'tables/unit.jsonl' }] });
    expect(toLink({ url: 1 })).toBeUndefined();
    expect(toLink({ export_id: 'e', path: 'p', url: '/u', expires_at: 't', bytes: 3, sha256: 's' })).toEqual({ exportId: 'e', path: 'p', url: '/u', expiresAt: 't', bytes: 3, sha256: 's' });
    expect(toTenantExit({ tenant_status: 'Nope' })).toBeUndefined();
    expect(toTenantExit(exit({ tenant_status: 'Offboarding', legal_holds_active: 1 }))).toMatchObject({ status: 'Offboarding', version: 5, legalHoldsActive: 1, exportDelivered: false });
  });

  it('knows what is pending, what can still be served, how much was downloaded, and what each state of a tenant allows', () => {
    const view = toExport(exportRow(1)) as NonNullable<ReturnType<typeof toExport>>;
    expect(isPending({ status: 'Running' })).toBe(true);
    expect(isPending(view)).toBe(false);
    expect(isServable(view, new Date())).toBe(true);
    expect(isServable(view, new Date(Date.now() + 72 * 3_600_000))).toBe(false);
    expect(isServable({ ...view, status: 'Expired' }, new Date())).toBe(false);
    expect(downloadedOf(view)).toBe('1/3');
    expect([canOffboard('Active'), canOffboard('Suspended'), canOffboard('Offboarding'), canArchive('Offboarding'), canArchive('Active')]).toEqual([true, true, false, true, false]);
  });

  it('judges the form the way the server does', () => {
    expect([isWindowValid(29), isWindowValid(30), isWindowValid(180), isWindowValid(181), isWindowValid(45.5)]).toEqual([false, true, true, false, false]);
    expect([isDateValid('2026-12-31'), isDateValid('2026-02-31'), isDateValid('31/12/2026')]).toEqual([true, false, false]);
    expect([looksLikePublicKey('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----'), looksLikePublicKey(`-----BEGIN ${'PRIVATE'} KEY-----\nabc\n-----END PRIVATE KEY-----`), looksLikePublicKey('x')]).toEqual([true, false, false]);
  });

  it('names the problem by the code the server answered', () => {
    expect(describeProblem(problem('EXPORT_ALREADY_RUNNING')).reason).toBe('running');
    expect(describeProblem(problem('EXPORT_NOT_CONFIRMED')).reason).toBe('notConfirmed');
    expect(describeProblem(problem('EXPORT_EXPIRED', 422)).reason).toBe('expired');
    expect(describeProblem(problem('TENANT_STATE_INVALID')).reason).toBe('state');
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'encryption_public_key_pem')).reason).toBe('key');
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'reason'))).toEqual({ reason: 'invalid', field: 'reason' });
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });
});
