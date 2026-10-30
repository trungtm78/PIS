import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import ContactConsentScreen from './ContactConsentScreen';
import { channelsOf, consentBody, consentProblems, describeProblem, emptyForm, needsEvidence, reasonProblem, takesConsent, toConsent, toConsents } from './consent/model';
import { toContact } from './contact/model';

const AGENT = ['contact.read', 'contact_consent.read', 'omni.consent.manage'];
const READER = ['contact.read', 'contact_consent.read'];
const NOBODY = ['notification.self'];
const reason = 'The person asked by message to stop the conversations.';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const identity = (overrides: Record<string, unknown> = {}) => ({ id: 'identity-1', contact_id: 'contact-1', channel: 'PHONE', masked: '+84*******01', status: 'Verified', verification_method: 'ADMIN_DOCUMENT', verified_at: '2026-10-30T02:30:00Z', created_at: '2026-10-30T02:00:00Z', version: 3, ...overrides });
const contact = (overrides: Record<string, unknown> = {}) => ({ id: 'contact-1', display_name: 'Phạm Văn D', classification: 'CITIZEN', status: 'Verified', preferred_channel: null, merged_into_id: null, identities: [identity(), identity({ id: 'identity-2', channel: 'EMAIL', masked: 'p***@example.com' })], merge_candidates: [], created_at: '2026-10-30T02:00:00Z', version: 2, ...overrides });
const consent = (overrides: Record<string, unknown> = {}) => ({ id: 'consent-1', subject_kind: 'CONTACT', subject_id: 'contact-1', channel: 'SMS', purpose: 'SUPPORT_CONVERSATION', status: 'Granted', effective_at: '2026-10-30T03:00:00Z', revoked_at: null, consent_text_version: 'v3', capture_method: 'CHANNEL_OPT_IN', legal_basis: 'CONSENT', version: 1, ...overrides });
const page = (items: unknown[]) => ({ items, next_cursor: null, as_of: '2026-10-30T03:00:00Z' });

afterEach(cleanup);

interface Answers {
  contacts?: () => unknown;
  consents?: () => unknown;
  command?: (operation: string, input: unknown) => unknown;
}

function open(permissions: readonly string[], answers: Answers = {}) {
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const h = harness((operation) => (operation === 'get_resources_contact' ? (answers.contacts ?? (() => page([contact()])))() : new Error(`unexpected read ${operation}`)), answers.command ?? (() => ({})));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => (operation === 'get_resources_contact_consent' ? respond((answers.consents ?? (() => [consent()]))()) : respond(new Error(`unexpected readAll ${operation}`))));
  return { h, ...mount(<ContactConsentScreen route={routeOf('OMNI-04', 'FR-OMNI-04')} />, h, { permissions }) };
}
const choose = async (id = 'contact-1'): Promise<void> => {
  const select = (await screen.findByLabelText(vi_['omni.consent.contact.label'])) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: id } });
};
const row = async (id: string): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector(`[data-consent-id="${id}"]`) as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;

describe('OMNI-04 the consent of the contacts (UI-OMNI-04)', () => {
  it('AC-ST-OMNI-003-2 UI-OMNI-04: shows for the contact chosen what it agreed to, the version of the terms, how it was taken, since when, and the withdraw action', async () => {
    open(AGENT, { consents: () => [consent(), consent({ id: 'consent-2', purpose: 'REMINDER', status: 'Withdrawn', revoked_at: '2026-10-30T05:00:00Z', capture_method: 'PAPER_SCANNED' })] });
    expect(await screen.findByText(vi_['omni.consent.contact.choose'])).toBeTruthy();
    await choose();
    const first = await row('consent-1');
    expect(first.querySelector('[data-version]')?.textContent).toBe('v3');
    expect(first.querySelector('[data-method]')?.textContent).toBe(vi_['omni.consent.method.optIn']);
    expect(first.querySelector('[data-consent-status]')?.textContent).toContain(vi_['omni.consent.status.granted']);
    expect(within(first).getByRole('button', { name: vi_['omni.consent.withdraw.aria'].replace('{channel}', vi_['omni.consent.channel.sms']).replace('{purpose}', vi_['omni.consent.purpose.support']) })).toBeTruthy();
    const ended = await row('consent-2');
    expect(ended.querySelector('[data-revoked]')).not.toBeNull();
    expect(ended.querySelector('[data-method]')?.textContent).toBe(vi_['omni.consent.method.paper']);
    expect(within(ended).queryByRole('button')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['omni.consent.page.title']);
  });

  it('AC-ST-OMNI-003-2 UI-OMNI-04: shows a loading state, then the denied, signed-out, offline and error states, and says in words when the contact has no consent', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(READER, { contacts: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    open(READER, { consents: () => new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) });
    await choose();
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    cleanup();
    const loading = open(READER, { consents: () => [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    await choose();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    const { h } = open(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(READER, { contacts: () => page([]) });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('reads the consents of the contact chosen, with its id', async () => {
    const { h } = open(READER);
    await choose();
    await row('consent-1');
    expect((h.client.readAll as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual(['get_resources_contact_consent', { query: { contact_id: 'contact-1' } }]);
  });

  it('withdraws with a reason at the version read, asking for the reason before it sends anything', async () => {
    const { h } = open(AGENT, { command: () => ({ operation_id: 'o', status: 'Withdrawn', resource_version: 2, resource_id: 'consent-1' }) });
    await choose();
    const first = await row('consent-1');
    fireEvent.click(within(first).getByRole('button', { name: new RegExp(vi_['omni.consent.withdraw.action']) }));
    const form = (await screen.findByRole('form', { name: vi_['omni.consent.withdraw.form.aria'].replace('{channel}', vi_['omni.consent.channel.sms']).replace('{purpose}', vi_['omni.consent.purpose.support']) })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.consent.withdraw.confirm.action'] }));
    expect(within(form).getByText(vi_['omni.consent.withdraw.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.withdraw.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.consent.withdraw.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['withdrawContactConsent', expect.objectContaining({ path: { consentId: 'consent-1' }, body: { reason }, ifMatchVersion: 1 })]);
    expect(await screen.findByText(vi_['omni.consent.done.withdrawn'])).toBeTruthy();
  });

  it('says in words that the consent already ended or changed, and keeps the reason typed', async () => {
    for (const [code, key] of [['CONSENT_STATE_INVALID', 'omni.consent.problem.state'], ['VERSION_CONFLICT', 'omni.consent.problem.conflict']] as const) {
      open(AGENT, { command: () => problem(code) });
      await choose();
      const first = await row('consent-1');
      fireEvent.click(within(first).getByRole('button', { name: new RegExp(vi_['omni.consent.withdraw.action']) }));
      const form = (await waitFor(() => document.querySelector('[data-withdraw-form]') as HTMLElement | null ?? Promise.reject(new Error('not yet')))) as HTMLElement;
      fireEvent.change(within(form).getByLabelText(vi_['omni.consent.withdraw.reason.label']), { target: { value: reason } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['omni.consent.withdraw.confirm.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      expect((within(form).getByLabelText(vi_['omni.consent.withdraw.reason.label']) as HTMLTextAreaElement).value).toBe(reason);
      cleanup();
    }
  });

  it('offers the channels of the verified identities of the contact only, and tells that there is none when the contact has no verified identity', async () => {
    open(AGENT);
    await choose();
    const form = (await screen.findByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Phạm Văn D') })) as HTMLElement;
    const select = within(form).getByLabelText(vi_['omni.consent.form.channel.label']) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['EMAIL', 'SMS']);
    cleanup();
    open(AGENT, { contacts: () => page([contact({ identities: [identity({ status: 'Pending', verification_method: null, verified_at: null })] })]) });
    await choose();
    expect(await screen.findByText(vi_['omni.consent.form.noChannel'])).toBeTruthy();
    const none = (await screen.findByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Phạm Văn D') })) as HTMLElement;
    expect((within(none).getByRole('button', { name: vi_['omni.consent.form.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('records a consent, telling before it sends what the server would refuse, and sends the terms version, the way of capture and the proof', async () => {
    const { h } = open(AGENT, { command: () => ({ operation_id: 'o', status: 'Granted', resource_version: 1, resource_id: 'consent-9' }) });
    await choose();
    const form = (await screen.findByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Phạm Văn D') })) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.method.label']), { target: { value: 'PAPER_SCANNED' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.consent.form.submit.action'] }));
    expect(within(form).getByText(vi_['omni.consent.form.version.invalid'])).toBeTruthy();
    expect(within(form).getByText(vi_['omni.consent.form.evidence.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.channel.label']), { target: { value: 'EMAIL' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.purpose.label']), { target: { value: 'REMINDER' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.version.label']), { target: { value: ' v4 ' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.evidence.required']), { target: { value: ' minutes-3 ' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.consent.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['recordContactConsent', expect.objectContaining({ path: { contactId: 'contact-1' }, body: { channel: 'EMAIL', purpose: 'REMINDER', consent_text_version: 'v4', capture_method: 'PAPER_SCANNED', evidence_reference: 'minutes-3' } })]);
    expect(await screen.findByText(vi_['omni.consent.done.granted'])).toBeTruthy();
  });

  it('says in words that the contact has agreed already or has no verified identity on the channel', async () => {
    for (const [code, status, key] of [['CONSENT_ALREADY_GRANTED', 409, 'omni.consent.problem.already'], ['IDENTITY_UNVERIFIED', 422, 'omni.consent.problem.unverified'], ['SCOPE_DENIED', 403, 'omni.consent.problem.denied']] as const) {
      open(AGENT, { command: () => problem(code, status) });
      await choose();
      const form = (await screen.findByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Phạm Văn D') })) as HTMLElement;
      fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.version.label']), { target: { value: 'v4' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['omni.consent.form.submit.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('starts the form again when another contact is chosen, so the terms and the proof typed for one are not sent for another', async () => {
    const { h } = open(AGENT, { contacts: () => page([contact(), contact({ id: 'contact-2', display_name: 'Another one' })]), command: () => ({ operation_id: 'o', status: 'Granted', resource_version: 1, resource_id: 'consent-9' }) });
    await choose('contact-1');
    let form = (await screen.findByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Phạm Văn D') })) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.method.label']), { target: { value: 'PAPER_SCANNED' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.version.label']), { target: { value: 'v9' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.evidence.required']), { target: { value: 'minutes-of-the-first' } });
    await choose('contact-2');
    form = (await screen.findByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Another one') })) as HTMLElement;
    expect((within(form).getByLabelText(vi_['omni.consent.form.version.label']) as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText(vi_['omni.consent.form.method.label']) as HTMLSelectElement).value).toBe('IN_APP');
    fireEvent.change(within(form).getByLabelText(vi_['omni.consent.form.version.label']), { target: { value: 'v1' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.consent.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(h.command.mock.calls[0])).not.toContain('minutes-of-the-first');
  });

  it('takes no consent for a contact that was merged away, and offers nothing to a person who only reads', async () => {
    open(AGENT, { contacts: () => page([contact({ status: 'Merged', merged_into_id: 'contact-2' })]) });
    await choose();
    await row('consent-1');
    expect(screen.queryByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Phạm Văn D') })).toBeNull();
    cleanup();
    open(READER);
    await choose();
    const first = await row('consent-1');
    expect(within(first).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['omni.consent.form.aria'].replace('{name}', 'Phạm Văn D') })).toBeNull();
  });
});

describe('the model of the consent screen', () => {
  it('reads a consent as the API answers it and leaves out what is not one', () => {
    expect(toConsent(consent())).toMatchObject({ id: 'consent-1', subjectId: 'contact-1', channel: 'SMS', status: 'Granted', textVersion: 'v3', captureMethod: 'CHANNEL_OPT_IN', version: 1 });
    expect(toConsent(consent({ status: 'Nope' }))).toBeUndefined();
    expect(toConsent({})).toBeUndefined();
    expect(toConsents([consent(), null, consent({ id: 'consent-3' })])).toHaveLength(2);
  });

  it('finds the channels of a contact from its verified identities, own and inherited, and not from the pending ones', () => {
    const view = toContact(contact({ identities: [identity(), identity({ id: 'i2', channel: 'WHATSAPP', status: 'Pending', verification_method: null, verified_at: null }), identity({ id: 'i3', channel: 'ZALO' })] }));
    expect(channelsOf(view ?? { identities: [] })).toEqual(['SMS', 'ZALO']);
    expect(takesConsent({ status: 'Verified' })).toBe(true);
    expect(takesConsent({ status: 'Merged' })).toBe(false);
    expect(takesConsent({ status: 'Blocked' })).toBe(false);
  });

  it('judges the form the way the server does and builds the body', () => {
    expect(consentProblems(emptyForm(''))).toEqual(['channel', 'textVersion']);
    expect(consentProblems({ ...emptyForm('SMS'), textVersion: 'v1', method: 'CHANNEL_OPT_IN' })).toEqual(['evidence']);
    expect(consentProblems({ ...emptyForm('SMS'), textVersion: 'v1', method: 'IN_APP' })).toEqual([]);
    expect(needsEvidence('PAPER_SCANNED')).toBe(true);
    expect(needsEvidence('WEB_FORM')).toBe(false);
    expect(consentBody({ ...emptyForm('SMS'), textVersion: ' v1 ' })).toEqual({ channel: 'SMS', purpose: 'SUPPORT_CONVERSATION', consent_text_version: 'v1', capture_method: 'IN_APP' });
    expect(reasonProblem('short')).toBe(true);
    expect(reasonProblem(reason)).toBe(false);
  });

  it('maps the codes of the server to what the person is told', () => {
    expect(describeProblem(problem('CONSENT_ALREADY_GRANTED'))).toEqual({ reason: 'already', field: undefined });
    expect(describeProblem(problem('IDENTITY_UNVERIFIED', 422))).toEqual({ reason: 'unverified', field: undefined });
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'channel'))).toEqual({ reason: 'invalid', field: 'channel' });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });

  it('has every string of the screen in both languages', () => {
    const keys = Object.keys(vi_).filter((key) => key.startsWith('omni.consent.'));
    expect(keys.length).toBeGreaterThan(55);
    for (const key of keys) expect(Object.keys(en_)).toContain(key);
  });
});
