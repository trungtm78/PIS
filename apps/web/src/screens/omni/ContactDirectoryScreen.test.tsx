import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import ContactDirectoryScreen from './ContactDirectoryScreen';
import { contactBody, contactProblems, describeProblem, emptyContactForm, emptyVerifyForm, identityProblem, mayMerge, methodsFor, reasonProblem, toContact, toContactPage, verifyBody, verifyProblems } from './contact/model';

const AGENT = ['contact.read', 'omni.contact.manage'];
const SUPERVISOR = ['contact.read', 'omni.contact.manage', 'omni.contact.merge'];
const READER = ['contact.read'];
const NOBODY = ['notification.self'];
const reason = 'The same person wrote on the phone and on WhatsApp.';
const problem = (code: string, status = 409, extensions?: Record<string, unknown>, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, ...(extensions === undefined ? {} : { extensions }) });

const identity = (overrides: Record<string, unknown> = {}) => ({ id: 'identity-1', contact_id: 'contact-1', channel: 'PHONE', masked: '+84*******01', status: 'Pending', verification_method: null, verified_at: null, created_at: '2026-10-30T02:00:00Z', version: 3, ...overrides });
const contact = (overrides: Record<string, unknown> = {}) => ({
  id: 'contact-1',
  display_name: 'Lê Văn C',
  classification: 'CITIZEN',
  status: 'Unverified',
  preferred_channel: null,
  merged_into_id: null,
  identities: [identity()],
  merge_candidates: [],
  created_at: '2026-10-30T02:00:00Z',
  version: 2,
  ...overrides,
});
const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-30T03:00:00Z' });

afterEach(cleanup);

function open(permissions: readonly string[], answer: () => unknown, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation) => (operation === 'get_resources_contact' ? answer() : new Error(`unexpected read ${operation}`)), command);
  return { h, ...mount(<ContactDirectoryScreen route={routeOf('OMNI-03', 'FR-OMNI-03')} />, h, { permissions }) };
}
const card = async (id: string): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector(`[data-contact-id="${id}"]`) as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;

describe('OMNI-03 the contact directory (UI-OMNI-03)', () => {
  it('AC-ST-OMNI-002-2 UI-OMNI-03: shows each contact with its identities masked, the state of each, and how it was verified', async () => {
    open(AGENT, () =>
      page([
        contact({ identities: [identity(), identity({ id: 'identity-2', channel: 'WHATSAPP', masked: '+84*******02', status: 'Verified', verification_method: 'PROVIDER_VERIFIED', verified_at: '2026-10-30T02:30:00Z' })] }),
        contact({ id: 'contact-2', display_name: 'Merged away', status: 'Merged', merged_into_id: 'contact-1', identities: [] }),
      ]),
    );
    const first = await card('contact-1');
    expect(within(first).getAllByText(/\*\*\*/).length).toBeGreaterThan(0);
    expect(first.querySelector('[data-identity-id="identity-1"] [data-masked]')?.textContent).toBe('+84*******01');
    expect(first.querySelector('[data-identity-id="identity-2"]')?.textContent).toContain(vi_['omni.contact.method.provider']);
    expect(first.querySelector('[data-identity-id="identity-1"]')?.textContent).toContain(vi_['omni.contact.identity.pending']);
    expect(first.querySelector('[data-contact-status]')?.textContent).toBe(vi_['omni.contact.status.unverified']);
    const second = await card('contact-2');
    expect(second.querySelector('[data-merged-into]')?.textContent).toContain('Lê Văn C');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['omni.contact.page.title']);
  });

  it('AC-ST-OMNI-002-2 UI-OMNI-03: shows a loading state, then the denied, signed-out, offline and error states, and says in words when there is no contact', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(READER, () => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = open(READER, () => page([]));
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    const { h } = open(NOBODY, () => page([]));
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('AC-ST-OMNI-002-2 UI-OMNI-03: offers the merge only with a verified identity shared, as a disabled button with the reason otherwise, and never to a person who may not merge', async () => {
    open(SUPERVISOR, () =>
      page([
        contact({ id: 'contact-1', display_name: 'Lê Văn C', status: 'Verified', merge_candidates: [{ contact_id: 'contact-2', display_name: 'Lê Văn C', identity_id: 'identity-9' }] }),
        contact({ id: 'contact-3', display_name: 'Lê Văn C', identities: [] }),
      ]),
    );
    const shared = await card('contact-1');
    const offered = within(shared).getByRole('button', { name: vi_['omni.contact.merge.action.aria'].replace('{name}', 'Lê Văn C') });
    expect((offered as HTMLButtonElement).disabled).toBe(false);
    // Two contacts with the same name and nothing shared: the button is there and off, and says why.
    const alike = await card('contact-3');
    const off = alike.querySelector('[data-merge-button]') as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(alike.querySelector('[data-merge-none]')?.textContent).toBe(vi_['omni.contact.merge.none']);
    cleanup();
    open(AGENT, () => page([contact({ status: 'Verified', merge_candidates: [{ contact_id: 'contact-2', display_name: 'Other', identity_id: 'identity-9' }] })]));
    await card('contact-1');
    expect(document.querySelector('[data-merge]')).toBeNull();
  });

  it('merges on the shared identity with a reason, asking for the reason before it sends anything', async () => {
    const { h } = open(SUPERVISOR, () => page([contact({ status: 'Verified', merge_candidates: [{ contact_id: 'contact-2', display_name: 'Other C', identity_id: 'identity-9' }] })]), () => ({ operation_id: 'o', status: 'MERGED', resource_version: 5, resource_id: 'contact-1' }));
    const first = await card('contact-1');
    fireEvent.click(within(first).getByRole('button', { name: vi_['omni.contact.merge.action.aria'].replace('{name}', 'Other C') }));
    const form = (await screen.findByRole('form', { name: vi_['omni.contact.merge.form.aria'].replace('{name}', 'Other C') })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.merge.confirm.action'] }));
    expect(within(form).getByText(vi_['omni.contact.merge.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.merge.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.merge.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['mergeContacts', expect.objectContaining({ body: { survivor_contact_id: 'contact-1', merged_contact_id: 'contact-2', shared_verified_identity_id: 'identity-9', reason } })]);
    expect(await screen.findByText(vi_['omni.contact.done.merged'])).toBeTruthy();
  });

  it('says in words that the contacts share nothing verified, or that the identity named is not verified', async () => {
    for (const [code, status, key] of [
      ['RECIPIENT_AMBIGUOUS', 422, 'omni.contact.problem.ambiguous'],
      ['IDENTITY_UNVERIFIED', 422, 'omni.contact.problem.unverified'],
      ['CONTACT_STATE_INVALID', 409, 'omni.contact.problem.state'],
    ] as const) {
      open(SUPERVISOR, () => page([contact({ status: 'Verified', merge_candidates: [{ contact_id: 'contact-2', display_name: 'Other C', identity_id: 'identity-9' }] })]), () => problem(code, status));
      const first = await card('contact-1');
      fireEvent.click(within(first).getByRole('button', { name: vi_['omni.contact.merge.action.aria'].replace('{name}', 'Other C') }));
      const form = (await screen.findByRole('form', { name: vi_['omni.contact.merge.form.aria'].replace('{name}', 'Other C') })) as HTMLElement;
      fireEvent.change(within(form).getByLabelText(vi_['omni.contact.merge.reason.label']), { target: { value: reason } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.merge.confirm.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('makes a contact: tells before sending what the server would refuse, then sends the name, the class and the preferred channel', async () => {
    const { h } = open(AGENT, () => page([]), () => ({ operation_id: 'o', status: 'UNVERIFIED', resource_version: 1, resource_id: 'contact-9' }));
    const form = (await screen.findByRole('form', { name: vi_['omni.contact.form.aria'] })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.form.submit.action'] }));
    expect(within(form).getByText(vi_['omni.contact.form.name.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.form.name.label']), { target: { value: '  Trần Thị B ' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.form.class.label']), { target: { value: 'CONTRACTOR_STAFF' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.form.preferred.label']), { target: { value: 'ZALO' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['createContact', expect.objectContaining({ body: { display_name: 'Trần Thị B', classification: 'CONTRACTOR_STAFF', preferred_channel: 'ZALO' } })]);
    expect(await screen.findByText(vi_['omni.contact.done.created'])).toBeTruthy();
  });

  it('adds an identity, tells that another contact holds it (IDENTITY_TAKEN) and keeps what was typed', async () => {
    const { h } = open(AGENT, () => page([contact()]), () => problem('IDENTITY_TAKEN'));
    const first = await card('contact-1');
    fireEvent.click(within(first).getByRole('button', { name: vi_['omni.contact.add.action'] }));
    const form = (await screen.findByRole('form', { name: vi_['omni.contact.add.form.aria'].replace('{name}', 'Lê Văn C') })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.add.submit.action'] }));
    expect(within(form).getByText(vi_['omni.contact.add.value.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.add.channel.label']), { target: { value: 'WHATSAPP' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.add.value.label']), { target: { value: ' 0900000001 ' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.add.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['addContactIdentity', expect.objectContaining({ path: { contactId: 'contact-1' }, body: { channel: 'WHATSAPP', external_id: '0900000001' } })]);
    expect(await screen.findByText(vi_['omni.contact.problem.taken'])).toBeTruthy();
    expect((within(form).getByLabelText(vi_['omni.contact.add.value.label']) as HTMLInputElement).value).toBe(' 0900000001 ');
  });

  it('verifies by the code at the version it read, wants six digits first, and tells until when the identity is locked after too many wrong codes', async () => {
    const { h } = open(AGENT, () => page([contact()]), () => problem('OTP_INVALID', 422, { locked_until: '2026-10-30T11:30:00Z' }, 'otp'));
    const first = await card('contact-1');
    fireEvent.click(within(first).getByRole('button', { name: vi_['omni.contact.verify.aria'].replace('{masked}', '+84*******01') }));
    const form = (await screen.findByRole('form', { name: vi_['omni.contact.verify.form.aria'].replace('{masked}', '+84*******01') })) as HTMLElement;
    // An agent is offered the code and nothing else for a phone number.
    expect([...(within(form).getByLabelText(vi_['omni.contact.verify.method.label']) as HTMLSelectElement).options].map((option) => option.value)).toEqual(['OTP']);
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.verify.otp.label']), { target: { value: '12345' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.verify.submit.action'] }));
    expect(within(form).getByText(vi_['omni.contact.verify.otp.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.verify.otp.label']), { target: { value: '123456' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.verify.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['verifyContactIdentity', expect.objectContaining({ path: { contactId: 'contact-1', identityId: 'identity-1' }, body: { method: 'OTP', otp: '123456' }, ifMatchVersion: 3 })]);
    const locked = await within(form).findByRole('alert');
    expect(locked.textContent).toMatch(/18:30|11:30/);
    expect(locked.textContent).not.toContain('{until}');
  });

  it('offers an agent no way to verify a Zalo or WhatsApp identity (the provider writes that), a supervisor a document, and verifies by a document with its reference', async () => {
    const zalo = contact({ identities: [identity({ id: 'identity-z', channel: 'ZALO', masked: 'u1***89' })] });
    open(AGENT, () => page([zalo]));
    let first = await card('contact-1');
    expect(within(first).queryByRole('button', { name: vi_['omni.contact.verify.aria'].replace('{masked}', 'u1***89') })).toBeNull();
    cleanup();
    open(SUPERVISOR, () => page([zalo]));
    first = await card('contact-1');
    fireEvent.click(within(first).getByRole('button', { name: vi_['omni.contact.verify.aria'].replace('{masked}', 'u1***89') }));
    let form = (await screen.findByRole('form', { name: vi_['omni.contact.verify.form.aria'].replace('{masked}', 'u1***89') })) as HTMLElement;
    expect([...(within(form).getByLabelText(vi_['omni.contact.verify.method.label']) as HTMLSelectElement).options].map((option) => option.value)).toEqual(['ADMIN_DOCUMENT']);
    cleanup();
    const { h } = open(SUPERVISOR, () => page([contact()]), () => ({ operation_id: 'o', status: 'VERIFIED', resource_version: 4, resource_id: 'identity-1' }));
    first = await card('contact-1');
    fireEvent.click(within(first).getByRole('button', { name: vi_['omni.contact.verify.aria'].replace('{masked}', '+84*******01') }));
    form = (await screen.findByRole('form', { name: vi_['omni.contact.verify.form.aria'].replace('{masked}', '+84*******01') })) as HTMLElement;
    const method = within(form).getByLabelText(vi_['omni.contact.verify.method.label']) as HTMLSelectElement;
    expect([...method.options].map((option) => option.value)).toEqual(['OTP', 'ADMIN_DOCUMENT']);
    fireEvent.change(method, { target: { value: 'ADMIN_DOCUMENT' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.verify.submit.action'] }));
    expect(within(form).getByText(vi_['omni.contact.verify.document.invalid'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.verify.document.label']), { target: { value: ' decision-17 ' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.verify.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['verifyContactIdentity', expect.objectContaining({ body: { method: 'ADMIN_DOCUMENT', document_ref: 'decision-17' } })]);
    expect(await screen.findByText(vi_['omni.contact.done.verified'])).toBeTruthy();
  });

  it('reads the directory again after a wrong code, which raised the version of the identity, so the next try does not go with a version that is gone', async () => {
    let version = 3;
    const { h } = open(AGENT, () => page([contact({ identities: [identity({ version })] })]), () => {
      version += 1;
      return problem('OTP_INVALID', 422, undefined, 'otp');
    });
    const first = await card('contact-1');
    fireEvent.click(within(first).getByRole('button', { name: vi_['omni.contact.verify.aria'].replace('{masked}', '+84*******01') }));
    const form = (await screen.findByRole('form', { name: vi_['omni.contact.verify.form.aria'].replace('{masked}', '+84*******01') })) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['omni.contact.verify.otp.label']), { target: { value: '123456' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.verify.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThanOrEqual(2));
    await screen.findByText(vi_['omni.contact.problem.otp']);
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.contact.verify.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((h.command.mock.calls[1] as [string, { ifMatchVersion: number }])[1].ifMatchVersion).toBe(4);
  });

  it('shows a person who only reads the contacts and nothing to change', async () => {
    open(READER, () => page([contact({ status: 'Verified', merge_candidates: [{ contact_id: 'contact-2', display_name: 'Other', identity_id: 'identity-9' }] })]));
    await card('contact-1');
    expect(screen.queryByRole('form', { name: vi_['omni.contact.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['omni.contact.add.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(vi_['omni.contact.verify.action']) })).toBeNull();
    expect(document.querySelector('[data-merge]')).toBeNull();
  });

  it('reads the next page when there is one', async () => {
    const { h } = open(READER, () => page([contact()], 'cursor-2'));
    await card('contact-1');
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.contact.list.more'] }));
    await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['get_resources_contact', { query: { cursor: 'cursor-2' } }]));
  });
});

describe('the model of the contact directory', () => {
  it('reads a contact as the API answers it and leaves out what is not one', () => {
    expect(toContact(contact())).toMatchObject({ id: 'contact-1', displayName: 'Lê Văn C', status: 'Unverified', identities: [{ id: 'identity-1', channel: 'PHONE', status: 'Pending', version: 3 }], mergeCandidates: [], version: 2 });
    expect(toContact(contact({ status: 'Nope' }))).toBeUndefined();
    expect(toContact(contact({ classification: 'VIP' }))).toBeUndefined();
    expect(toContact({})).toBeUndefined();
    expect(toContact(contact({ identities: [identity({ channel: 'FAX' })] }))?.identities).toEqual([]);
    expect(toContactPage(page([contact()], 'next'))).toMatchObject({ nextCursor: 'next' });
    expect(toContactPage(null)).toEqual({ items: [], nextCursor: undefined });
  });

  it('offers the methods that fit the channel and the person', () => {
    expect(methodsFor('PHONE', false)).toEqual(['OTP']);
    expect(methodsFor('EMAIL', true)).toEqual(['OTP', 'ADMIN_DOCUMENT']);
    expect(methodsFor('ZALO', false)).toEqual([]);
    expect(methodsFor('WHATSAPP', true)).toEqual(['ADMIN_DOCUMENT']);
  });

  it('offers the merge only to whoever may merge, for a contact that is alive and has a candidate', () => {
    const candidate = [{ contactId: 'x', displayName: 'X', identityId: 'i' }];
    expect(mayMerge({ status: 'Verified', mergeCandidates: candidate }, true)).toBe(true);
    expect(mayMerge({ status: 'Verified', mergeCandidates: candidate }, false)).toBe(false);
    expect(mayMerge({ status: 'Verified', mergeCandidates: [] }, true)).toBe(false);
    expect(mayMerge({ status: 'Merged', mergeCandidates: candidate }, true)).toBe(false);
  });

  it('judges the forms the way the server does and builds the bodies', () => {
    expect(contactProblems(emptyContactForm())).toEqual(['name']);
    expect(contactBody({ name: ' A ', classification: 'OTHER', preferredChannel: '' })).toEqual({ display_name: 'A', classification: 'OTHER' });
    expect(identityProblem({ channel: 'PHONE', value: '  ' })).toBe(true);
    expect(identityProblem({ channel: 'PHONE', value: '0900000001' })).toBe(false);
    expect(verifyProblems({ ...emptyVerifyForm('OTP'), otp: '12345a' })).toEqual(['otp']);
    expect(verifyProblems({ ...emptyVerifyForm('ADMIN_DOCUMENT'), documentRef: ' ' })).toEqual(['document']);
    expect(verifyBody({ method: 'OTP', otp: '123456', documentRef: '' })).toEqual({ method: 'OTP', otp: '123456' });
    expect(reasonProblem('short')).toBe(true);
    expect(reasonProblem(reason)).toBe(false);
  });

  it('maps the codes of the server to what the person is told, and the lock to its time', () => {
    expect(describeProblem(problem('OTP_INVALID', 422, { locked_until: '2026-10-30T11:30:00Z' }))).toEqual({ reason: 'otp', field: undefined, lockedUntil: '2026-10-30T11:30:00Z' });
    expect(describeProblem(problem('IDENTITY_TAKEN'))).toMatchObject({ reason: 'taken' });
    expect(describeProblem(problem('VALIDATION_FAILED', 422, undefined, 'external_id'))).toEqual({ reason: 'invalid', field: 'external_id', lockedUntil: undefined });
    expect(describeProblem(new Error('x'))).toMatchObject({ reason: 'general' });
  });

  it('has every string of the screen in both languages', () => {
    const keys = Object.keys(vi_).filter((key) => key.startsWith('omni.contact.'));
    expect(keys.length).toBeGreaterThan(60);
    for (const key of keys) expect(Object.keys(en_)).toContain(key);
  });
});
