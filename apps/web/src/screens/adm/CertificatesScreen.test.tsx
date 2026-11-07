import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { harness, mount, routeOf } from '../doc/test-support';
import CertificatesScreen from './CertificatesScreen';
import { SECOND_TENANT, mountInSession } from './security/test-support';

const ROUTE = routeOf('ADM-08', 'FR-ADM-08');
const MEMBER = '00000000-0000-4000-8000-000000000a01';
const UNIT = '00000000-0000-4000-8000-000000000f01';
const MANAGER = ['adm.signature.manage', 'adm.signature.read'];
const READER = ['adm.signature.read'];
const DAY = 86_400_000;
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

const certificate = (id: string, subject: string, days: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'PERSONAL',
  holder_membership_id: MEMBER,
  organization_unit_id: null,
  certificate_serial: `S-${id}`,
  issuer_dn: 'CN=CA',
  subject_dn: subject,
  provider_code: 'VNPT-CA',
  valid_from: new Date(Date.now() - 100 * DAY).toISOString(),
  valid_until: new Date(Date.now() + days * DAY + DAY / 2).toISOString(),
  fingerprint_sha256: 'a'.repeat(64),
  status: 'Active',
  status_reason: null,
  registered_by: MEMBER,
  version: 1,
  ...extra,
});

const ITEMS = [
  certificate('c1', 'CN=Soon', 12),
  certificate('c2', 'CN=Later', 200),
  certificate('c3', 'CN=Revoked', 5, { status: 'Revoked', status_reason: 'Key compromise' }),
  certificate('c4', 'CN=Ended', -3, { status: 'Active' }),
];

function withReads(h: ReturnType<typeof harness>, items: unknown[] = ITEMS) {
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = (operation: string) => {
    if (operation === 'get_resources_signing_certificate') return Promise.resolve(items);
    if (operation === 'get_resources_membership') return Promise.resolve([{ id: MEMBER, display_name: 'Nguyen Van A' }, { id: 5 }]);
    if (operation === 'get_resources_organization_unit') return Promise.resolve([{ id: UNIT, code: 'U1', name: 'Board' }]);
    return Promise.reject(new Error('unexpected read'));
  };
  return h;
}

afterEach(cleanup);

const ready = () => waitFor(() => expect(document.querySelector('[data-certificate-id="c1"]')).not.toBeNull());
const rowOf = (id: string): HTMLElement => document.querySelector(`[data-certificate-id="${id}"]`) as HTMLElement;

describe('CertificatesScreen (ADM-08)', () => {
  it('lists the register and warns only about the certificate that ends within 30 days and has not ended (AC-ST-ADM-008-2)', async () => {
    mount(<CertificatesScreen route={ROUTE} />, withReads(harness(() => new Error('no read'))), MANAGER);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.certificates.page.title']);
    expect(within(rowOf('c1')).getByText(vi_['adm.certificates.expiry.warning'].replace('{days}', '12'))).toBeTruthy();
    expect(rowOf('c1').querySelector('[data-expiry]')?.getAttribute('data-expiry')).toBe('expiring');
    expect(rowOf('c2').querySelector('[data-expiry]')).toBeNull();
    expect(rowOf('c3').querySelector('[data-expiry]')).toBeNull();
    expect(rowOf('c4').querySelector('[data-expiry]')?.getAttribute('data-expiry')).toBe('expired');
    expect(screen.getByTestId('expiry-banner').textContent).toBe(vi_['adm.certificates.expiring.banner'].replace('{count}', '1').replace('{days}', '30'));
  });

  it('tells the expiry and the status of a certificate on pills of the kit, and keeps the register in a scroll region of its own', async () => {
    mount(<CertificatesScreen route={ROUTE} />, withReads(harness(() => new Error('no read'))), MANAGER);
    await ready();
    expect(rowOf('c1').querySelector('[data-expiry="expiring"] .ui-pill')?.className).toContain('ui-tone-warning');
    expect(rowOf('c4').querySelector('[data-expiry="expired"] .ui-pill')?.className).toContain('ui-tone-danger');
    expect(screen.getByRole('region', { name: translator.t('w2adm.certificates.table.caption') })).toBeTruthy();
  });

  it('shows no banner when nothing ends soon, and the empty state for an empty register', async () => {
    mount(<CertificatesScreen route={ROUTE} />, withReads(harness(() => new Error('no read')), [certificate('c2', 'CN=Later', 200)]), MANAGER);
    await waitFor(() => expect(document.querySelector('[data-certificate-id="c2"]')).not.toBeNull());
    expect(screen.queryByTestId('expiry-banner')).toBeNull();
    cleanup();
    mount(<CertificatesScreen route={ROUTE} />, withReads(harness(() => new Error('no read')), []), MANAGER);
    expect(await screen.findByText(vi_['adm.certificates.list.empty'])).toBeTruthy();
  });

  it('refuses an empty form before anything is sent', async () => {
    const h = withReads(harness(() => new Error('no read')));
    mount(<CertificatesScreen route={ROUTE} />, h, MANAGER);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: vi_['adm.certificates.register.submit.action'] }));
    expect((await screen.findAllByText(vi_['adm.certificates.field.required'])).length).toBe(3);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('registers a personal certificate once and empties the form', async () => {
    const h = withReads(harness(() => new Error('no read'), () => ({ status: 'REGISTERED', resource_version: 1, resource_id: 'c9' })));
    mount(<CertificatesScreen route={ROUTE} />, h, MANAGER);
    await ready();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Nguyen Van A' });
    await user.selectOptions(screen.getByLabelText(vi_['adm.certificates.holder.label']), MEMBER);
    await user.type(screen.getByLabelText(vi_['adm.certificates.provider.label']), 'VNPT-CA');
    await user.click(screen.getByLabelText(vi_['adm.certificates.pem.label']));
    await user.paste(PEM);
    await user.click(screen.getByRole('button', { name: vi_['adm.certificates.register.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('registerSigningCertificate');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { kind: 'PERSONAL', holder_membership_id: MEMBER, certificate_pem: PEM, provider_code: 'VNPT-CA' } });
    expect(await screen.findByText(vi_['adm.certificates.register.accepted.notice'])).toBeTruthy();
    expect((screen.getByLabelText(vi_['adm.certificates.pem.label']) as HTMLTextAreaElement).value).toBe('');
  });

  it('registers an organisation certificate for a unit', async () => {
    const h = withReads(harness(() => new Error('no read'), () => ({ status: 'REGISTERED', resource_version: 1, resource_id: 'c9' })));
    mount(<CertificatesScreen route={ROUTE} />, h, MANAGER);
    await ready();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['adm.certificates.kind.label']), 'ORGANIZATION');
    await screen.findByRole('option', { name: /U1/ });
    await user.selectOptions(screen.getByLabelText(vi_['adm.certificates.unit.label']), UNIT);
    await user.type(screen.getByLabelText(vi_['adm.certificates.provider.label']), 'VNPT-CA');
    await user.click(screen.getByLabelText(vi_['adm.certificates.pem.label']));
    await user.paste(PEM);
    await user.click(screen.getByRole('button', { name: vi_['adm.certificates.register.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { kind: 'ORGANIZATION', organization_unit_id: UNIT } });
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('holder_membership_id');
  });

  it.each([
    ['CERTIFICATE_INVALID', 422, 'adm.certificates.error.invalid', undefined],
    ['CERTIFICATE_INVALID', 422, 'adm.certificates.error.notYetValid', 'valid_from'],
    ['CERTIFICATE_EXPIRED', 422, 'adm.certificates.error.expired', undefined],
    ['CERTIFICATE_DUPLICATE', 409, 'adm.certificates.error.duplicate', undefined],
    ['SCOPE_DENIED', 403, 'adm.certificates.error.denied', undefined],
  ] as const)('shows what the server refused: %s %s', async (code, status, key, detail) => {
    const h = withReads(harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c', detail })));
    mount(<CertificatesScreen route={ROUTE} />, h, MANAGER);
    await ready();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Nguyen Van A' });
    await user.selectOptions(screen.getByLabelText(vi_['adm.certificates.holder.label']), MEMBER);
    await user.type(screen.getByLabelText(vi_['adm.certificates.provider.label']), 'VNPT-CA');
    await user.click(screen.getByLabelText(vi_['adm.certificates.pem.label']));
    await user.paste(PEM);
    await user.click(screen.getByRole('button', { name: vi_['adm.certificates.register.submit.action'] }));
    expect(await screen.findByText(vi_[key])).toBeTruthy();
    // The text the person pasted stays so it can be corrected.
    expect((screen.getByLabelText(vi_['adm.certificates.pem.label']) as HTMLTextAreaElement).value).toBe(PEM);
  });

  it('revokes with a reason of at least ten characters, sending the version of the row', async () => {
    const h = withReads(harness(() => new Error('no read'), () => ({ status: 'REVOKED', resource_version: 2, resource_id: 'c1' })));
    mount(<CertificatesScreen route={ROUTE} />, h, MANAGER);
    await ready();
    const user = userEvent.setup();
    expect(within(rowOf('c3')).queryByRole('button', { name: vi_['adm.certificates.revoke.action'] })).toBeNull();
    await user.click(within(rowOf('c1')).getByRole('button', { name: vi_['adm.certificates.revoke.action'] }));
    await user.type(screen.getByLabelText(vi_['adm.certificates.revoke.reason.label']), 'short');
    await user.click(screen.getByRole('button', { name: vi_['adm.certificates.revoke.confirm.action'] }));
    expect(await screen.findByText(vi_['adm.certificates.field.tooShort'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(vi_['adm.certificates.revoke.reason.label']), ' reason is long enough');
    await user.click(screen.getByRole('button', { name: vi_['adm.certificates.revoke.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('revokeSigningCertificate');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { certificateId: 'c1' }, ifMatchVersion: 1, body: { reason: 'short reason is long enough' } });
  });

  it('shows a conflict on revoking a certificate someone else changed', async () => {
    const h = withReads(harness(() => new Error('no read'), () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' })));
    mount(<CertificatesScreen route={ROUTE} />, h, MANAGER);
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('c2')).getByRole('button', { name: vi_['adm.certificates.revoke.action'] }));
    await user.type(screen.getByLabelText(vi_['adm.certificates.revoke.reason.label']), 'Holder left the organisation');
    await user.click(screen.getByRole('button', { name: vi_['adm.certificates.revoke.confirm.action'] }));
    expect(await screen.findByText(vi_['adm.certificates.error.conflict'])).toBeTruthy();
  });

  it('offers a reader the register without the register form actions or revoke buttons', async () => {
    mount(<CertificatesScreen route={ROUTE} />, withReads(harness(() => new Error('no read'))), READER);
    await ready();
    expect(screen.getByText(vi_['adm.certificates.readOnly.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['adm.certificates.register.submit.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['adm.certificates.revoke.action'] })).toBeNull();
  });

  it('starts over when the person switches tenant: the holder, the text and an open revocation do not cross', async () => {
    const h = withReads(harness(() => new Error('no read'), () => ({ status: 'REVOKED', resource_version: 2, resource_id: 'c1' })));
    const view = mountInSession(<CertificatesScreen route={ROUTE} />, h, { permissions: MANAGER });
    await ready();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Nguyen Van A' });
    await user.selectOptions(screen.getByLabelText(vi_['adm.certificates.holder.label']), MEMBER);
    await user.type(screen.getByLabelText(vi_['adm.certificates.provider.label']), 'VNPT-CA');
    await user.click(screen.getByLabelText(vi_['adm.certificates.pem.label']));
    await user.paste(PEM);
    await user.click(within(rowOf('c1')).getByRole('button', { name: vi_['adm.certificates.revoke.action'] }));
    await user.type(screen.getByLabelText(vi_['adm.certificates.revoke.reason.label']), 'Holder left the organisation');
    view.rerenderWith({ permissions: MANAGER, tenant: SECOND_TENANT });
    await ready();
    await screen.findByRole('option', { name: 'Nguyen Van A' });
    expect((screen.getByLabelText(vi_['adm.certificates.holder.label']) as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText(vi_['adm.certificates.provider.label']) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(vi_['adm.certificates.pem.label']) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByLabelText(vi_['adm.certificates.revoke.reason.label'])).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('is read-only in a suspended tenant: no registration and no revocation, whatever the grants say', async () => {
    mountInSession(<CertificatesScreen route={ROUTE} />, withReads(harness(() => new Error('no read'))), { permissions: MANAGER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByText(vi_['adm.certificates.frozen.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['adm.certificates.register.submit.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['adm.certificates.revoke.action'] })).toBeNull();
  });

  it('stops a revocation that was opened before the tenant was suspended', async () => {
    const h = withReads(harness(() => new Error('no read'), () => ({ status: 'REVOKED', resource_version: 2, resource_id: 'c1' })));
    const view = mountInSession(<CertificatesScreen route={ROUTE} />, h, { permissions: MANAGER });
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('c1')).getByRole('button', { name: vi_['adm.certificates.revoke.action'] }));
    await user.type(screen.getByLabelText(vi_['adm.certificates.revoke.reason.label']), 'Holder left the organisation');
    view.rerenderWith({ permissions: MANAGER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['adm.certificates.revoke.confirm.action'] })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the denied state when the register may not be read', async () => {
    const h = harness(() => new Error('no read'));
    (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = () => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    mount(<CertificatesScreen route={ROUTE} />, h, READER);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });
});
