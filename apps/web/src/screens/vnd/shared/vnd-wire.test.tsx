import { createApiClient } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import CertificatesScreen from '../certificates/CertificatesScreen';
import PayeeScreen from '../payee/PayeeScreen';
import ProfileScreen from '../profile/ProfileScreen';
import { ALL, CONTRACTOR, change, mount, profileView, qualification, routeOf, uuid } from './test/vnd-test-support';
import type { Harness } from './test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/** A client over a fake network: the real client builds the request, so the test sees the headers and the body the server would. */
function wire(view: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const entry: Sent = { url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : undefined };
    sent.push(entry);
    const json = (value: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }));
    if (entry.method === 'GET' && entry.url.includes('/vendor/contractors/')) return json(view);
    if (entry.method === 'POST') return json({ operation_id: '00000000-0000-4000-8000-000000000001', status: 'OK', resource_version: 9 });
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  const client = createApiClient({ baseUrl: 'http://api.test/', session: () => Promise.resolve({ token: 'tkn' }), fetch: fakeFetch as unknown as typeof fetch, newKey: () => 'idem-key-0000000000000001', newCorrelationId: () => '00000000-0000-4000-8000-0000000000cc' });
  const harness = { client, read: vi.fn(), command: vi.fn() } as unknown as Harness;
  return { harness, sent };
}

describe('the commands of the module on the wire', () => {
  it('sends the update of a profile as a POST with the idempotency key, If-Match with the version the person saw, and only the changed field', async () => {
    const { harness, sent } = wire(profileView());
    mount(<ProfileScreen route={routeOf('VND-02', 'FR-VND-02')} />, harness, { permissions: ALL, path: `/vnd/vnd-02?contractor=${CONTRACTOR}` });
    fireEvent.click(await screen.findByTestId('edit-profile'));
    const form = screen.getByRole('dialog', { name: word('vnd.profile.edit.title') });
    fireEvent.change(within(form).getByLabelText(new RegExp(escaped(word('vnd.profile.field.email.label')))), { target: { value: 'moi@example.vn' } });
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.profile.edit.confirm') }));
    await waitFor(() => expect(sent.some((entry) => entry.method === 'POST')).toBe(true));
    const post = sent.find((entry) => entry.method === 'POST') as Sent;
    expect(post.url).toBe(`http://api.test/vendor/contractors/${CONTRACTOR}/profile`);
    expect(post.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.headers.get('if-match')).toBe('"4"');
    expect(post.headers.get('content-type')).toBe('application/json');
    expect(post.headers.get('authorization')).toBe('Bearer tkn');
    expect(JSON.parse(post.body ?? '{}')).toEqual({ email: 'moi@example.vn' });
    const get = sent.find((entry) => entry.method === 'GET') as Sent;
    expect(get.url).toBe(`http://api.test/vendor/contractors/${CONTRACTOR}`);
    expect(get.headers.get('idempotency-key')).toBeNull();
  });

  it('sends the approval of a change request to its own route with the version of the request', async () => {
    const { harness, sent } = wire(profileView({ payee_changes: [change(1)] }));
    mount(<PayeeScreen route={routeOf('VND-04', 'FR-VND-04')} />, harness, { permissions: ALL, path: `/vnd/vnd-04?contractor=${CONTRACTOR}` });
    fireEvent.click(await screen.findByTestId('approve-contract'));
    const form = screen.getByRole('dialog', { name: word('vnd.payee.approve.contract.title') });
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.changeStep.contractMatch.name') }));
    await waitFor(() => expect(sent.some((entry) => entry.method === 'POST')).toBe(true));
    const post = sent.find((entry) => entry.method === 'POST') as Sent;
    expect(post.url).toBe(`http://api.test/vendor/payee-changes/${uuid('0004', 1)}/approval`);
    expect(post.headers.get('if-match')).toBe('"3"');
    expect(post.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(post.body ?? '{}')).toEqual({ role: 'CONTRACT_MATCH' });
  });

  it('sends the check of a certificate with no body, on the route of its own kind', async () => {
    const { harness, sent } = wire(profileView({ qualifications: [qualification(2, { verified_at: null, verified_by_name: null, may_verify: true })], key_staff: [] }));
    mount(<CertificatesScreen route={routeOf('VND-05', 'FR-VND-05')} />, harness, { permissions: ALL, path: `/vnd/vnd-05?contractor=${CONTRACTOR}` });
    fireEvent.click(await screen.findByTestId('verify'));
    const form = screen.getByRole('dialog', { name: word('vnd.certs.verify.title') });
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.certs.verify.confirm') }));
    await waitFor(() => expect(sent.some((entry) => entry.method === 'POST')).toBe(true));
    const post = sent.find((entry) => entry.method === 'POST') as Sent;
    expect(post.url).toBe(`http://api.test/vendor/qualifications/${uuid('0006', 2)}/verification`);
    expect(post.body).toBeUndefined();
    expect(post.headers.get('content-type')).toBeNull();
    expect(post.headers.get('if-match')).toBe('"2"');
  });

  it('puts the account number only in the body of the request, never in the address or in a header', async () => {
    const { harness, sent } = wire(profileView());
    mount(<PayeeScreen route={routeOf('VND-04', 'FR-VND-04')} />, harness, { permissions: ALL, path: `/vnd/vnd-04?contractor=${CONTRACTOR}` });
    fireEvent.click(await screen.findByTestId('request-change'));
    const form = screen.getByRole('dialog', { name: word('vnd.payee.request.title') });
    const set = (label: string, value: string): void => {
      fireEvent.change(within(form).getByLabelText(new RegExp(escaped(label))), { target: { value } });
    };
    set(word('vnd.payee.field.bank.label'), 'Ngân hàng Ngoại Thương');
    set(word('vnd.payee.field.holder.label'), 'CÔNG TY NHÀ THẦU 1');
    set(word('vnd.payee.field.number.label'), '0123456789012');
    set(word('vnd.payee.field.reason.label'), 'Đổi sang tài khoản mới theo thư');
    set(word('vnd.payee.field.evidence.label'), uuid('0009', 1));
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.payee.request.confirm') }));
    await waitFor(() => expect(sent.some((entry) => entry.method === 'POST')).toBe(true));
    const post = sent.find((entry) => entry.method === 'POST') as Sent;
    expect(post.url).toBe(`http://api.test/vendor/contractors/${CONTRACTOR}/payee-changes`);
    expect(post.url).not.toContain('0123456789012');
    expect([...post.headers.values()].join(' ')).not.toContain('0123456789012');
    expect(JSON.parse(post.body ?? '{}').account_number).toBe('0123456789012');
    for (const entry of sent.filter((one) => one.method === 'GET')) expect(entry.url).not.toContain('0123456789012');
  });
});
