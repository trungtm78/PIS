import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import DomainsScreen from './DomainsScreen';
import { canRemove, canVerify, choosesTenant, describeProblem, isHostnameValid, isReasonValid, isSettling, toChallenge, toDomain, toDomainPage } from './domains/model';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-05', 'FR-SAS-05');
const ADMIN = ['system.tenant.read', 'system.tenant.manage'];
const READER = ['system.tenant.read'];
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const reason = 'The customer asked for this domain to be attached.';
const problem = (code: string, status = 409, extensions?: Record<string, unknown>) => new ApiError({ status, code, correlationId: 'c', extensions });

const domainRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `domain-${n}`,
  hostname: `portal-${n}.minhha.gov.vn`,
  kind: 'CUSTOM',
  status: 'Active',
  tls_status: 'Issued',
  tls_expires_at: '2027-01-30T00:00:00Z',
  verified_at: '2026-10-30T02:00:00Z',
  last_checked_at: '2026-10-30T02:05:00Z',
  challenge_expires_at: null,
  revoked_at: null,
  reserved_until: null,
  failure_code: null,
  txt_record_name: null,
  created_at: '2026-10-30T01:00:00Z',
  version: 3,
  ...overrides,
});

const pending = (n: number) =>
  domainRow(n, { status: 'PendingVerification', tls_status: 'Pending', tls_expires_at: null, verified_at: null, last_checked_at: null, challenge_expires_at: '2026-11-06T01:00:00Z', txt_record_name: `_machvon-verify.portal-${n}.minhha.gov.vn`, version: 1 });

afterEach(cleanup);

interface World {
  domains?: Array<Record<string, unknown>> | Error;
}

function open(permissions: readonly string[], world: World = {}, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation) => {
    switch (operation) {
      case 'listSystemTenants':
        return { items: [{ id: TENANT, code: 'minh-ha', name: 'Minh Hà' }], next_cursor: null };
      case 'listTenantDomains':
        return world.domains instanceof Error ? world.domains : { items: world.domains ?? [], next_cursor: null };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  const element = <DomainsScreen route={ROUTE} />;
  return { h, ...mount(element, h, permissions, '/sas/sas-05') };
}

describe('SAS-05 the domains of a tenant (UI-SAS-05)', () => {
  it('AC-ST-SAS-017-3 UI-SAS-05: renders the fields Domain, TXT verification, TLS and Status, and the form to add a domain', async () => {
    open(ADMIN, { domains: [domainRow(1), pending(2)] });
    expect(await screen.findByRole('form', { name: vi_['sas.domain.add.aria'] })).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.domain.add.hostname.label'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.domain.kind.custom'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.domain.kind.platform'])).toBeTruthy();
    const table = await screen.findByRole('table');
    for (const name of ['domain', 'status', 'txt', 'tls', 'checked']) expect(within(table).getByRole('columnheader', { name: vi_[`sas.domain.column.${name}` as keyof typeof vi_] })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.domain.page.title']);
    const active = table.querySelector('[data-domain-id="domain-1"]') as HTMLElement;
    expect(within(active).getByText(vi_['sas.domain.status.active'])).toBeTruthy();
    expect(within(active).getByText(vi_['sas.domain.tls.issued'])).toBeTruthy();
    expect(active.querySelector('[data-chooses]')).not.toBeNull();
    const waiting = table.querySelector('[data-domain-id="domain-2"]') as HTMLElement;
    expect(within(waiting).getByText('_machvon-verify.portal-2.minhha.gov.vn')).toBeTruthy();
    expect(waiting.querySelector('[data-chooses]')).toBeNull();
  });

  it('AC-ST-SAS-017-3 UI-SAS-05: refuses a hostname that is not a name, and sends nothing', async () => {
    const { h } = open(ADMIN, { domains: [] });
    fireEvent.change(await screen.findByLabelText(vi_['sas.domain.add.hostname.label']), { target: { value: 'Not A Host' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.add.submit.action'] }));
    expect(await screen.findByText(vi_['sas.domain.add.hostname.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('adds the domain, shows the TXT record once with its name and value, and does not keep the value once it is hidden', async () => {
    const challenge = { domain_id: 'domain-9', txt_record_name: '_machvon-verify.dautu.minhha.gov.vn', txt_record_value: 'machvon-verify=abc123', expires_at: '2026-11-06T01:00:00Z' };
    const { h } = open(ADMIN, { domains: [] }, () => challenge);
    fireEvent.change(await screen.findByLabelText(vi_['sas.domain.add.hostname.label']), { target: { value: 'dautu.minhha.gov.vn' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.add.submit.action'] }));
    expect(await screen.findByText(vi_['sas.domain.done.added'])).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown }];
    expect(operation).toBe('addTenantDomain');
    expect(input.path).toEqual({ tenantId: TENANT });
    expect(input.body).toEqual({ hostname: 'dautu.minhha.gov.vn', kind: 'CUSTOM' });
    const shown = document.querySelector('[data-challenge]') as HTMLElement;
    expect(shown.querySelector('[data-txt-name]')?.textContent).toBe('_machvon-verify.dautu.minhha.gov.vn');
    expect(shown.querySelector('[data-txt-value]')?.textContent).toBe('machvon-verify=abc123');
    expect(screen.getByText(vi_['sas.domain.challenge.once'])).toBeTruthy();
    expect((screen.getByLabelText(vi_['sas.domain.add.hostname.label']) as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.challenge.hide.action'] }));
    expect(document.body.textContent).not.toContain('machvon-verify=abc123');
  });

  it('adds a platform subdomain, which comes with no value to publish', async () => {
    const { h } = open(ADMIN, { domains: [] }, () => ({ domain_id: 'domain-8', txt_record_name: '_machvon-verify.b.machvon.vn', txt_record_value: '' }));
    fireEvent.change(await screen.findByLabelText(vi_['sas.domain.add.hostname.label']), { target: { value: 'b.machvon.vn' } });
    fireEvent.click(screen.getByLabelText(vi_['sas.domain.kind.platform']));
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.add.submit.action'] }));
    expect(await screen.findByText(vi_['sas.domain.done.added'])).toBeTruthy();
    expect((h.command.mock.calls[0] as [string, { body: unknown }])[1].body).toEqual({ hostname: 'b.machvon.vn', kind: 'PLATFORM_SUBDOMAIN' });
    expect(document.querySelector('[data-challenge]')).toBeNull();
  });

  it('says why a domain was refused: taken by another tenant, or held for 90 days', async () => {
    for (const [error, message] of [
      [problem('DOMAIN_TAKEN'), vi_['sas.domain.problem.taken']],
      [problem('DOMAIN_TAKEN', 409, { reason: 'RESERVED' }), vi_['sas.domain.problem.reserved']],
    ] as const) {
      open(ADMIN, { domains: [] }, () => error);
      fireEvent.change(await screen.findByLabelText(vi_['sas.domain.add.hostname.label']), { target: { value: 'dautu.minhha.gov.vn' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.add.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(message);
      cleanup();
    }
  });

  it('verifies a domain on the version it saw, with a reason, and says it was found', async () => {
    const { h } = open(ADMIN, { domains: [pending(2)] }, () => ({ status: 'VERIFIED' }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.domain.verify.action'] }));
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.domain.act.reason.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['sas.domain.act.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.domain.done.verified'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('verifyTenantDomain');
    expect(input.path).toEqual({ domainId: 'domain-2' });
    expect(input.body).toEqual({ reason });
    expect(input.ifMatchVersion).toBe(1);
  });

  it('says the record was not found, and reads the list again so the time of the check shows', async () => {
    const { h } = open(ADMIN, { domains: [pending(2)] }, () => problem('DOMAIN_UNVERIFIED', 422));
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.domain.verify.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['sas.domain.act.reason.label']), { target: { value: reason } });
    const reads = h.read.mock.calls.filter(([operation]) => operation === 'listTenantDomains').length;
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.act.confirm.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['sas.domain.problem.unverified']);
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listTenantDomains').length).toBeGreaterThan(reads));
  });

  it('releases a domain after a reason and tells that its name is held for 90 days; a released domain has no action and shows until when it is held', async () => {
    const { h } = open(ADMIN, { domains: [domainRow(1), domainRow(3, { status: 'Revoked', tls_status: 'Issued', revoked_at: '2026-10-01T00:00:00Z', reserved_until: '2026-12-30T00:00:00Z' })] }, () => ({ status: 'REVOKED' }));
    const released = (await screen.findByRole('table')).querySelector('[data-domain-id="domain-3"]') as HTMLElement;
    expect(within(released).queryByRole('button')).toBeNull();
    expect(released.querySelector('[data-reserved]')).not.toBeNull();
    const row = (await screen.findByRole('table')).querySelector('[data-domain-id="domain-1"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: vi_['sas.domain.remove.action'] }));
    expect(screen.getByText(/portal-1\.minhha\.gov\.vn: tên miền không còn chọn tenant/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['sas.domain.act.reason.label']), { target: { value: reason } });
    fireEvent.click(screen.getByRole('button', { name: vi_['sas.domain.act.confirm.action'] }));
    expect(await screen.findByText(vi_['sas.domain.done.removed'])).toBeTruthy();
    const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; ifMatchVersion: number }];
    expect(operation).toBe('removeTenantDomain');
    expect(input.path).toEqual({ domainId: 'domain-1' });
    expect(input.ifMatchVersion).toBe(3);
  });

  it('shows the list to a reader of the registry, with no way to write', async () => {
    open(READER, { domains: [domainRow(1), pending(2)] });
    await screen.findByRole('table');
    expect(screen.queryByRole('form', { name: vi_['sas.domain.add.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.domain.verify.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.domain.remove.action'] })).toBeNull();
  });

  it('shows nothing of the tenants to someone who may not read the registry', () => {
    const { h } = open([], {});
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('keeps what was prepared for a tenant from reaching another: choosing another tenant drops the confirmation and the notice', async () => {
    const other = '00000000-0000-4000-8000-0000000000a2';
    const h = harness((operation) => {
      if (operation === 'listSystemTenants') return { items: [{ id: TENANT, code: 'minh-ha', name: 'Minh Hà' }, { id: other, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: null };
      return { items: [domainRow(1)], next_cursor: null };
    }, () => ({ status: 'REVOKED' }));
    const element = <DomainsScreen route={ROUTE} />;
    mount(element, h, ADMIN, '/sas/sas-05');
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.domain.remove.action'] }));
    expect(screen.getByRole('form', { name: vi_['sas.domain.act.aria'] })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['sas.domain.tenant.label']), { target: { value: other } });
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['sas.domain.act.aria'] })).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });
});

describe('the seven states of SAS-05 (AC-ST-SAS-017-3, UI-SAS-05)', () => {
  const failing = (error: ApiError) => open(ADMIN, { domains: error });

  it('AC-ST-SAS-017-3 UI-SAS-05: shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
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

  it('AC-ST-SAS-017-3 UI-SAS-05: waits with a status while the list is read, and says in words that the tenant has no domain', async () => {
    open(ADMIN, { domains: [] });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByText(vi_['sas.domain.list.none'])).toBeTruthy();
  });
});

describe('the model of SAS-05', () => {
  it('reads a domain, a page and a challenge, and takes what is not one for nothing', () => {
    expect(toDomain(null)).toBeUndefined();
    expect(toDomain({ id: 'x' })).toBeUndefined();
    expect(toDomain(domainRow(1))).toMatchObject({ id: 'domain-1', hostname: 'portal-1.minhha.gov.vn', kind: 'CUSTOM', status: 'Active', tlsStatus: 'Issued', txtRecordName: undefined, version: 3 });
    expect(toDomain(domainRow(2, { status: 'Whatever', tls_status: 'Odd', kind: 'PLATFORM_SUBDOMAIN' }))).toMatchObject({ status: 'PendingVerification', tlsStatus: 'Pending', kind: 'PLATFORM_SUBDOMAIN' });
    expect(toDomainPage({ items: [domainRow(1), { nope: true }], next_cursor: 'c' })).toMatchObject({ nextCursor: 'c' });
    expect(toDomainPage('x')).toEqual({ items: [], nextCursor: undefined });
    expect(toChallenge({ domain_id: 'd' })).toBeUndefined();
    expect(toChallenge({ domain_id: 'd', txt_record_name: 'n', txt_record_value: 'v', expires_at: 't' })).toEqual({ domainId: 'd', txtRecordName: 'n', txtRecordValue: 'v', expiresAt: 't' });
  });

  it('knows what each state allows', () => {
    expect([canVerify({ status: 'PendingVerification', kind: 'CUSTOM' }), canVerify({ status: 'Failed', kind: 'CUSTOM' }), canVerify({ status: 'Active', kind: 'CUSTOM' }), canVerify({ status: 'PendingVerification', kind: 'PLATFORM_SUBDOMAIN' })]).toEqual([true, true, false, false]);
    expect([canRemove({ status: 'Active' }), canRemove({ status: 'Revoked' })]).toEqual([true, false]);
    expect([choosesTenant({ status: 'Verified' }), choosesTenant({ status: 'Active' }), choosesTenant({ status: 'Failed' }), choosesTenant({ status: 'PendingVerification' })]).toEqual([true, true, false, false]);
    expect([isSettling({ status: 'Verified' }), isSettling({ status: 'Active' })]).toEqual([true, false]);
  });

  it('judges the form the way the contract does', () => {
    expect([isHostnameValid('dautu.minhha.gov.vn'), isHostnameValid('DAUTU.minhha.gov.vn'), isHostnameValid('localhost'), isHostnameValid('10.0.0.1'), isHostnameValid('a b.vn')]).toEqual([true, false, false, false, false]);
    expect([isReasonValid('short'), isReasonValid(reason)]).toEqual([false, true]);
  });

  it('names the problem by the code the server answered', () => {
    expect(describeProblem(problem('DOMAIN_TAKEN')).reason).toBe('taken');
    expect(describeProblem(problem('DOMAIN_TAKEN', 409, { reason: 'RESERVED' })).reason).toBe('reserved');
    expect(describeProblem(problem('DOMAIN_UNVERIFIED', 422)).reason).toBe('unverified');
    expect(describeProblem(problem('VERSION_CONFLICT')).reason).toBe('conflict');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', 404)).reason).toBe('notFound');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });
});
