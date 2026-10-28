import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { contractId } from '../../ctr/test-support';
import DiaryCatalogueScreen from './DiaryCatalogueScreen';
import DiaryComposeScreen from './DiaryComposeScreen';
import DiaryReviewScreen from './DiaryReviewScreen';
import { CONTRACTOR, READER, actions, client, copy, diary, diaryId, mount, routeOf, signature, world } from './test-support';
import type { World } from './test-support';

const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 3, resource_id: diaryId(9) };
const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Options = { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' };

function open(Screen: typeof DiaryCatalogueScreen, id: string, req: string, state: World, options: Options = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<Screen route={routeOf(id, req)} />, h, { permissions: options.permissions ?? READER, path: `/qms/${id.toLowerCase()}${options.query ?? ''}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const catalogue = (state: World, options: Options = {}) => open(DiaryCatalogueScreen, 'QMS-01', 'FR-QMS-01', state, options);
const compose = (state: World, options: Options = {}) => open(DiaryComposeScreen, 'QMS-02', 'FR-QMS-02', state, options);
const review = (state: World, options: Options = {}) => open(DiaryReviewScreen, 'QMS-03', 'FR-QMS-03', state, options);

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const submit = (name: string): void => {
  fireEvent.click(within(dialog()).getByRole('button', { name }));
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-diary]')).map((row) => row.getAttribute('data-diary') as string);
const row = (id: string): HTMLElement => document.querySelector(`[data-diary="${id}"]`) as HTMLElement;
type Sent = { path?: { id?: string }; body: Record<string, unknown>; ifMatchVersion?: number };
const commandsOf = (h: ReturnType<typeof client>, operation: string): Sent[] => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as Sent);
const readsOf = (h: ReturnType<typeof client>, operation: string): Array<{ query?: Record<string, unknown> }> => h.read.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { query?: Record<string, unknown> });

describe('DiaryCatalogueScreen (QMS-01): the site diaries', () => {
  it('UI-QMS-01: lists the diaries, newest first as the server answers, with who signed and in which order', async () => {
    catalogue(
      world({
        diaries: [
          diary(2, { status: 'SUPERVISED', signatures: [signature('CONTRACTOR', 'Nhà thầu An Phát'), signature('SUPERVISOR', 'Giám sát Bình')], actions: actions({ ownerConfirm: true }) }),
          diary(1, { status: 'LOCKED', signatures: [signature('CONTRACTOR', 'Nhà thầu An Phát', { valid: false })], actions: actions() }),
        ],
      }),
    );
    await screen.findByTestId('diaries');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('qms.diary.catalogue.title'));
    expect(screen.getByText(text('qms.diary.footer.reference', { id: 'QMS-01', req: 'FR-QMS-01' }))).toBeTruthy();
    expect(rows()).toEqual([diaryId(2), diaryId(1)]);
    const first = row(diaryId(2));
    expect(within(first).getByTestId('diary').textContent).toContain('NK-HD-A-002-20261022');
    expect(within(first).getByTestId('day').textContent).toBe('2026-10-22');
    expect(within(first).getByTestId('status').textContent).toBe(word('qms.diary.status.supervised'));
    expect(Array.from(first.querySelectorAll('[data-role]')).map((item) => [item.getAttribute('data-role'), item.getAttribute('data-signed')])).toEqual([
      ['CONTRACTOR', 'yes'],
      ['SUPERVISOR', 'yes'],
      ['OWNER', 'no'],
    ]);
    // A signature over other content is void and is not shown as a signer.
    const second = row(diaryId(1));
    expect(second.querySelector('[data-role="CONTRACTOR"]')?.getAttribute('data-signed')).toBe('void');
    expect(within(second).getByText(word('qms.diary.signature.void'), { exact: false })).toBeTruthy();
    // Only a diary that waits for someone is offered for review.
    expect(first.querySelector('[data-review]')).not.toBeNull();
    expect(second.querySelector('[data-review]')).toBeNull();
    expect(first.querySelector(`a[href="/qms/qms-02?diary=${diaryId(2)}"]`)).not.toBeNull();
  });

  it('says when there is no diary, and narrows the list by contract, status and days, sending only what was chosen', async () => {
    const h = catalogue(
      world({
        diaries: [diary(1), diary(2, { status: 'CONTRACTOR_SIGNED', contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE' } }), diary(3)],
      }),
    );
    await screen.findByTestId('diaries');
    expect((document.getElementById('diary-filter-contract') as HTMLSelectElement).options.length).toBe(3);
    expect(readsOf(h, 'get_resources_site_diary')[0]?.query).toEqual({ limit: 50 });
    pick('diary-filter-contract', contractId(1));
    await waitFor(() => expect(rows()).toEqual([diaryId(2)]));
    pick('diary-filter-contract', '');
    pick('diary-filter-status', 'DRAFT');
    await waitFor(() => expect(rows()).toEqual([diaryId(1), diaryId(3)]));
    pick('diary-filter-from', '2026-10-23');
    await waitFor(() => expect(rows()).toEqual([diaryId(3)]));
    pick('diary-filter-to', '2026-10-22');
    expect((await screen.findByTestId('no-diaries')).textContent).toBe(word('qms.diary.none.notice'));
    const last = readsOf(h, 'get_resources_site_diary').at(-1)?.query;
    expect(last).toEqual({ limit: 50, status: 'DRAFT', from: '2026-10-23', to: '2026-10-22' });
  });

  it('reads the list a page at a time', async () => {
    const h = catalogue(world({ page: 2, diaries: [diary(1), diary(2), diary(3)] }));
    await screen.findByTestId('diaries');
    expect(rows()).toEqual([diaryId(1), diaryId(2)]);
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.more.action') }));
    await waitFor(() => expect(rows()).toEqual([diaryId(1), diaryId(2), diaryId(3)]));
    expect(screen.queryByRole('button', { name: word('qms.diary.more.action') })).toBeNull();
    expect(readsOf(h, 'get_resources_site_diary').at(-1)?.query).toMatchObject({ cursor: '2' });
  });

  it('shows a read that failed and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_site_diary']) });
    const h = catalogue(state);
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-diaries');
    expect(readsOf(h, 'get_resources_site_diary').length).toBeGreaterThan(1);
  });

  it('offers the drafting only to whoever may write, in a session that is not read-only', async () => {
    catalogue(world(), { permissions: READER });
    await screen.findByTestId('no-diaries');
    expect(screen.queryByRole('button', { name: word('qms.diary.new.action') })).toBeNull();
    cleanup();
    catalogue(world(), { permissions: CONTRACTOR, mode: 'READ_ONLY' });
    await screen.findByTestId('no-diaries');
    expect(screen.queryByRole('button', { name: word('qms.diary.new.action') })).toBeNull();
    cleanup();
    catalogue(world(), { permissions: CONTRACTOR });
    expect(await screen.findByRole('button', { name: word('qms.diary.new.action') })).toBeTruthy();
  });

  describe('drafting', () => {
    const start = async (options: Options = {}, state: World = world()) => {
      const h = catalogue(state, { permissions: CONTRACTOR, ...options });
      fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.new.action') }));
      return h;
    };

    it('offers the contracts that are in force, today as the day and no later day', async () => {
      await start({}, world({ contracts: [world().contracts[0] as Record<string, unknown>, world().contracts[1] as Record<string, unknown>] }));
      const options = Array.from((document.getElementById('diary-contract') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(options).toEqual([word('qms.diary.field.contract.choose'), 'HD-A-002']);
      const day = document.getElementById('diary-date') as HTMLInputElement;
      expect(day.value).toBe(day.max);
    });

    it('asks for the contract and the work before it sends anything, and refuses a day that has not come', async () => {
      const h = await start();
      submit(word('qms.diary.new.submit'));
      expect(within(dialog()).getAllByText(word('qms.diary.problem.required'))).toHaveLength(2);
      pick('diary-contract', contractId(2));
      pick('new-summary', 'Đổ bê tông');
      pick('new-workforce', '12x');
      pick('diary-date', '2999-01-01');
      submit(word('qms.diary.new.submit'));
      expect(within(dialog()).getByText(word('qms.diary.problem.futureDate'))).toBeTruthy();
      expect(within(dialog()).getByText(word('qms.diary.problem.invalidNumber'))).toBeTruthy();
      expect(commandsOf(h, 'saveSiteDiaryDraft')).toHaveLength(0);
    });

    it('sends the diary under one identifier, with the content as the form says it, and closes', async () => {
      const h = await start();
      const day = (document.getElementById('diary-date') as HTMLInputElement).value;
      pick('diary-contract', contractId(2));
      pick('new-summary', '  Đổ bê tông móng  ');
      pick('new-weather', 'RAIN');
      pick('new-workforce', '15');
      submit(word('qms.diary.new.submit'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const [sent] = commandsOf(h, 'saveSiteDiaryDraft');
      expect(sent?.body).toMatchObject({ contract_id: contractId(2), record_date: day, content: { summary: 'Đổ bê tông móng', weather_code: 'RAIN', workforce_count: 15 } });
      expect(sent?.body.client_operation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent?.body.content).not.toHaveProperty('notes');
      expect(sent?.body).not.toHaveProperty('base_server_version');
    });

    it('says what the server refused for the draft, in words', async () => {
      const cases: Array<[Error, string]> = [
        [refusal('DIARY_DAY_EXISTS', 409), 'qms.diary.error.dayExists'],
        [refusal('CONTRACT_STATE_INVALID', 409), 'qms.diary.error.contractState'],
        [refusal('PERMIT_GATE_BLOCKED', 409), 'qms.diary.error.permitGate'],
        [refusal('SCOPE_DENIED', 403), 'qms.diary.error.denied'],
      ];
      for (const [error, key] of cases) {
        await start({ command: () => Promise.reject(error) });
        pick('diary-contract', contractId(2));
        pick('new-summary', 'Đổ bê tông');
        submit(word('qms.diary.new.submit'));
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word(key));
        cleanup();
      }
    });
  });
});

describe('DiaryComposeScreen (QMS-02): writing and signing the diary of a day', () => {
  const at = (n: number) => ({ query: `?diary=${diaryId(n)}`, permissions: CONTRACTOR });

  it('asks to choose a diary when none is named, and says when the diary is not there', async () => {
    compose(world(), { permissions: CONTRACTOR });
    expect((await screen.findByTestId('no-diary-chosen')).textContent).toBe(word('qms.diary.compose.choose'));
    cleanup();
    compose(world(), { query: `?diary=${diaryId(5)}`, permissions: CONTRACTOR });
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
  });

  it('shows a draft as a form with the signature chain and the note that an in-app signature is not settled', async () => {
    compose(world({ diaries: [diary(1)] }), at(1));
    await screen.findByTestId('draft-form');
    expect(screen.getByTestId('diary-title').textContent).toContain('NK-HD-A-002-20261021');
    expect((document.getElementById('draft-summary') as HTMLTextAreaElement).value).toBe('Đổ bê tông móng đợt 1');
    expect((document.getElementById('draft-weather') as HTMLSelectElement).value).toBe('SUNNY');
    expect((document.getElementById('draft-workforce') as HTMLInputElement).value).toBe('12');
    expect(screen.getByTestId('legal-note').textContent).toBe(text('qms.diary.legal.unconfirmed', { cxn: 'CXN-EXE-05' }));
    expect(Array.from(screen.getByTestId('signers').querySelectorAll('li')).map((item) => item.getAttribute('data-signed'))).toEqual(['no', 'no', 'no']);
    expect(screen.queryByTestId('to-review')).toBeNull();
  });

  it('saves the draft as the version it was read at, keeping the fields the form does not show, and says so', async () => {
    const h = compose(world({ diaries: [diary(1, { content: { summary: 'Cũ', weather_code: 'SUNNY', workforce_count: 12, other_client: { photos: 2 } }, version: 5 })] }), at(1));
    await screen.findByTestId('draft-form');
    pick('draft-summary', '');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    expect(screen.getByText(word('qms.diary.problem.required'))).toBeTruthy();
    expect(commandsOf(h, 'reviseSiteDiaryDraft')).toHaveLength(0);
    pick('draft-summary', 'Mới');
    pick('draft-weather', '');
    pick('draft-workforce', '');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    expect((await screen.findByTestId('saved')).textContent).toBe(word('qms.diary.draft.saved'));
    const [sent] = commandsOf(h, 'reviseSiteDiaryDraft');
    expect(sent).toMatchObject({ path: { id: diaryId(1) }, ifMatchVersion: 5, body: { content: { summary: 'Mới', other_client: { photos: 2 } } } });
    expect(sent?.body.content).not.toHaveProperty('weather_code');
    expect(sent?.body.content).not.toHaveProperty('workforce_count');
    expect(sent?.body.client_operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says that someone else changed the draft, in words, and keeps what was typed', async () => {
    compose(world({ diaries: [diary(1)] }), { ...at(1), command: () => Promise.reject(refusal('DIARY_SYNC_CONFLICT', 409)) });
    await screen.findByTestId('draft-form');
    pick('draft-summary', 'Của tôi');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('qms.diary.error.syncConflict'));
    expect((document.getElementById('draft-summary') as HTMLTextAreaElement).value).toBe('Của tôi');
  });

  it('shows what the diary says, read only, once it is no longer a draft, with the signatures, their value and the remarks', async () => {
    compose(
      world({
        diaries: [
          diary(1, {
            status: 'OWNER_CONFIRMED',
            supervisor_remark: 'Đạt yêu cầu',
            owner_note: 'Đồng ý',
            signatures: [signature('CONTRACTOR', 'Nhà thầu An Phát'), signature('SUPERVISOR', 'Giám sát Bình', { method: 'DIGITAL_CERT', legal_effect: 'LEGAL_E_SIGNATURE', cert_serial: 'SN-0099' }), signature('OWNER', 'Chủ đầu tư', { valid: false })],
            actions: actions({ lock: true }),
          }),
        ],
      }),
      at(1),
    );
    await screen.findByTestId('diary-content');
    expect(screen.queryByTestId('draft-form')).toBeNull();
    expect(screen.getByTestId('content-summary').textContent).toBe('Đổ bê tông móng đợt 1');
    expect(screen.getByTestId('content-weather').textContent).toBe(word('qms.diary.weather.sunny'));
    expect(screen.getByTestId('supervisor-remark').textContent).toBe('Đạt yêu cầu');
    expect(screen.getByTestId('owner-note').textContent).toBe('Đồng ý');
    const signers = screen.getByTestId('signers');
    expect(
      within(signers)
        .getAllByTestId('effect')
        .map((item) => item.textContent?.replace(/^[\s·]+/, '')),
    ).toEqual([word('qms.diary.effect.internal'), word('qms.diary.effect.legal'), word('qms.diary.effect.internal')]);
    expect(within(signers).getByTestId('cert-serial').textContent).toContain('SN-0099');
    expect(signers.querySelector('[data-role="OWNER"]')?.getAttribute('data-signed')).toBe('void');
    expect(screen.getByTestId('to-review').getAttribute('href')).toBe(`/qms/qms-03?diary=${diaryId(1)}`);
    expect(screen.queryByRole('button', { name: word('qms.diary.sign.contractor.action') })).toBeNull();
  });

  describe('signing as the contractor', () => {
    it('asks for the way of signing, for the serial of a certificate and for none with an in-app confirmation', async () => {
      const h = compose(world({ diaries: [diary(1, { version: 4 })] }), at(1));
      fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.contractor.action') }));
      expect(within(dialog()).getByText(text('qms.diary.legal.unconfirmed', { cxn: 'CXN-EXE-05' }))).toBeTruthy();
      submit(word('qms.diary.sign.submit'));
      expect(within(dialog()).getByText(word('qms.diary.problem.required'))).toBeTruthy();
      pick('sign-method', 'DIGITAL_CERT');
      expect(within(dialog()).getByTestId('sign-effect').textContent).toBe(word('qms.diary.effect.legal'));
      submit(word('qms.diary.sign.submit'));
      expect(within(dialog()).getByText(word('qms.diary.problem.certSerial'))).toBeTruthy();
      // A serial typed for a certificate is not carried over to an in-app confirmation: the field stays, to be emptied, and the diary is not sent with it.
      pick('sign-serial', 'SN-1');
      pick('sign-method', 'IN_APP_OTP');
      expect(within(dialog()).getByTestId('sign-effect').textContent).toBe(word('qms.diary.effect.internal'));
      submit(word('qms.diary.sign.submit'));
      expect(within(dialog()).getByText(word('qms.diary.problem.certSerial'))).toBeTruthy();
      pick('sign-serial', '');
      submit(word('qms.diary.sign.submit'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const [sent] = commandsOf(h, 'signSiteDiaryByContractor');
      expect(sent).toMatchObject({ path: { id: diaryId(1) }, ifMatchVersion: 4, body: { signature_method: 'IN_APP_OTP' } });
      expect(sent?.body).not.toHaveProperty('cert_serial');
    });

    it('signs with a certificate and its serial', async () => {
      const h = compose(world({ diaries: [diary(1)] }), at(1));
      fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.contractor.action') }));
      pick('sign-method', 'DIGITAL_CERT');
      pick('sign-serial', ' SN-0099 ');
      submit(word('qms.diary.sign.submit'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(commandsOf(h, 'signSiteDiaryByContractor')[0]?.body).toMatchObject({ signature_method: 'DIGITAL_CERT', cert_serial: 'SN-0099' });
    });

    it('says what the server refused for the signature, in words', async () => {
      const cases: Array<[Error, string]> = [
        [refusal('ALREADY_SIGNED', 409), 'qms.diary.error.alreadySigned'],
        [refusal('SIGNATURE_METHOD_NOT_ACCEPTED'), 'qms.diary.error.methodNotAccepted'],
        [refusal('SCOPE_DENIED', 403, {}, 'signer_role'), 'qms.diary.error.notYourRole'],
        [refusal('DIARY_STATE_INVALID', 409), 'qms.diary.error.diaryState'],
        [refusal('VERSION_CONFLICT', 409), 'qms.diary.error.versionConflict'],
      ];
      for (const [error, key] of cases) {
        compose(world({ diaries: [diary(1)] }), { ...at(1), command: () => Promise.reject(error) });
        fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.contractor.action') }));
        pick('sign-method', 'IN_APP_OTP');
        submit(word('qms.diary.sign.submit'));
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word(key));
        cleanup();
      }
    });
  });

  describe('correcting a locked diary', () => {
    const locked = () => world({ diaries: [diary(1, { status: 'LOCKED', actions: actions({ correct: true }) })] });

    it('asks for the reason and sends the new content under one identifier', async () => {
      const h = compose(locked(), at(1));
      fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.correct.action') }));
      expect((document.getElementById('correct-summary') as HTMLTextAreaElement).value).toBe('Đổ bê tông móng đợt 1');
      submit(word('qms.diary.correct.submit'));
      expect(within(dialog()).getByText(word('qms.diary.problem.required'))).toBeTruthy();
      pick('correct-reason', 'Nhập sai số nhân lực');
      pick('correct-workforce', '20');
      submit(word('qms.diary.correct.submit'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const [sent] = commandsOf(h, 'correctSiteDiary');
      expect(sent).toMatchObject({ path: { id: diaryId(1) }, body: { correction_reason: 'Nhập sai số nhân lực', content: { summary: 'Đổ bê tông móng đợt 1', workforce_count: 20 } } });
      expect(sent?.body.client_operation_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('says that a correction is open already, in words', async () => {
      compose(locked(), { ...at(1), command: () => Promise.reject(refusal('DIARY_STATE_INVALID', 409, { reason: 'CORRECTION_OPEN' })) });
      fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.correct.action') }));
      pick('correct-reason', 'Sai');
      submit(word('qms.diary.correct.submit'));
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word('qms.diary.error.correctionOpen'));
    });
  });

  it('offers no button to whoever the server says may do nothing, in a read-only session, or for what the diary does not allow', async () => {
    compose(world({ diaries: [diary(1, { actions: actions(), signable_roles: [] })] }), { query: `?diary=${diaryId(1)}`, permissions: READER });
    await screen.findByTestId('diary-content');
    expect(screen.queryByTestId('draft-form')).toBeNull();
    expect(screen.queryByRole('button', { name: word('qms.diary.sign.contractor.action') })).toBeNull();
    cleanup();
    compose(world({ diaries: [diary(1)] }), { ...at(1), mode: 'READ_ONLY' });
    await screen.findByTestId('diary-content');
    expect(screen.queryByRole('button', { name: word('qms.diary.sign.contractor.action') })).toBeNull();
    cleanup();
    compose(world({ diaries: [diary(1, { status: 'CONTRACTOR_SIGNED', actions: actions() })] }), at(1));
    await screen.findByTestId('diary-content');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('what the server allows is what the screens offer (Codex review of ST-QMS-001)', () => {
  it('offers the supervisor, the owner and whoever locks their actions without the right to write diaries, and the contractor the correction only by the flag', async () => {
    review(world({ diaries: [diary(1, { status: 'CONTRACTOR_SIGNED', signatures: [signature('CONTRACTOR', 'Nhà thầu')], actions: actions({ supervise: true }), signable_roles: ['SUPERVISOR'] })] }), { query: `?diary=${diaryId(1)}`, permissions: ['site_diary.read', 'diary.sign.supervisor'] });
    expect(await screen.findByRole('button', { name: word('qms.diary.sign.supervisor.action') })).toBeTruthy();
    cleanup();
    compose(world({ diaries: [diary(1, { status: 'LOCKED', actions: actions({ correct: true }) })] }), { query: `?diary=${diaryId(1)}`, permissions: ['site_diary.read', 'diary.correct'] });
    expect(await screen.findByRole('button', { name: word('qms.diary.correct.action') })).toBeTruthy();
  });

  it('does not let the contractor sign or correct what is typed and not saved, and lets them once it is saved', async () => {
    const h = compose(world({ diaries: [diary(1, { version: 3 })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    await screen.findByTestId('draft-form');
    const sign = screen.getByRole('button', { name: word('qms.diary.sign.contractor.action') }) as HTMLButtonElement;
    expect(sign.disabled).toBe(false);
    expect(screen.queryByTestId('unsaved')).toBeNull();
    pick('draft-summary', 'Chưa lưu');
    expect(sign.disabled).toBe(true);
    expect(screen.getByTestId('unsaved').textContent).toBe(word('qms.diary.draft.unsaved'));
    fireEvent.click(sign);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Typing the draft back to what was saved leaves nothing unsaved.
    pick('draft-summary', 'Đổ bê tông móng đợt 1');
    expect(sign.disabled).toBe(false);
    expect(commandsOf(h, 'reviseSiteDiaryDraft')).toHaveLength(0);
  });
});

describe('a refresh behind the screen changes neither what is typed nor what is signed (Codex review of ST-QMS-001)', () => {
  const refresh = async (): Promise<void> => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  it('keeps what the contractor typed when someone else changes the draft, says so, and asks the save at the version that was read until the new one is loaded', async () => {
    const state = world({ diaries: [diary(1, { version: 3 })] });
    const h = compose(state, { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR, command: () => Promise.reject(refusal('VERSION_CONFLICT', 409)) });
    await screen.findByTestId('draft-form');
    pick('draft-summary', 'Việc của tôi');
    state.diaries = [diary(1, { version: 4, content: { summary: 'Việc của người khác', weather_code: 'RAIN' }, weather_code: 'RAIN' })];
    await refresh();
    expect((await screen.findByTestId('moved')).textContent).toContain(word('qms.diary.draft.moved'));
    expect((document.getElementById('draft-summary') as HTMLTextAreaElement).value).toBe('Việc của tôi');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('qms.diary.error.versionConflict'));
    expect(commandsOf(h, 'reviseSiteDiaryDraft')[0]?.ifMatchVersion).toBe(3);
    // Loading the new version drops the edits and shows the draft as it is now.
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.reload') }));
    await waitFor(() => expect((document.getElementById('draft-summary') as HTMLTextAreaElement).value).toBe('Việc của người khác'));
    expect(screen.queryByTestId('moved')).toBeNull();
  });

  it('keeps what was typed when the diary is signed by someone else meanwhile, says so, and drops it only when asked', async () => {
    const state = world({ diaries: [diary(1, { version: 3 })] });
    const h = compose(state, { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR, command: () => Promise.reject(refusal('DIARY_STATE_INVALID', 409)) });
    await screen.findByTestId('draft-form');
    pick('draft-summary', 'Việc tôi vừa viết');
    state.diaries = [diary(1, { version: 4, status: 'CONTRACTOR_SIGNED', signatures: [signature('CONTRACTOR', 'Nhà thầu')], actions: actions() })];
    await refresh();
    expect(await screen.findByTestId('moved')).toBeTruthy();
    expect((document.getElementById('draft-summary') as HTMLTextAreaElement).value).toBe('Việc tôi vừa viết');
    expect((screen.queryByRole('button', { name: word('qms.diary.sign.contractor.action') }) as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('qms.diary.error.diaryState'));
    expect(commandsOf(h, 'reviseSiteDiaryDraft')[0]?.ifMatchVersion).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.reload') }));
    await waitFor(() => expect(screen.queryByTestId('draft-form')).toBeNull());
    expect(screen.getByTestId('content-summary').textContent).toBe('Đổ bê tông móng đợt 1');
  });

  it('holds the fields of a dialog while its command is on its way', async () => {
    let release: (value: unknown) => void = () => undefined;
    compose(world({ diaries: [diary(1, { status: 'LOCKED', actions: actions({ correct: true }) })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR, command: () => new Promise((resolve) => (release = resolve)) });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.correct.action') }));
    pick('correct-reason', 'Sai số liệu');
    submit(word('qms.diary.correct.submit'));
    await waitFor(() => expect((document.getElementById('correct-reason') as HTMLTextAreaElement).matches(':disabled')).toBe(true));
    release(OK);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('starts the screen over, with no dialog or notice of the one before, when another diary is opened', async () => {
    const state = world({ diaries: [diary(1, { status: 'LOCKED', actions: actions({ correct: true }) })] });
    const h = compose(state, { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR, command: () => ({ ...OK, resource_id: diaryId(2) }) });
    state.diaries.push(diary(2));
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.correct.action') }));
    pick('correct-reason', 'Sai số');
    submit(word('qms.diary.correct.submit'));
    await waitFor(() => expect(commandsOf(h, 'correctSiteDiary')).toHaveLength(1));
    await screen.findByTestId('draft-form');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('diary-title').textContent).toContain('20261022');
  });

  it('follows the diary when nothing is typed', async () => {
    const state = world({ diaries: [diary(1, { version: 3 })] });
    compose(state, { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    await screen.findByTestId('draft-form');
    state.diaries = [diary(1, { version: 4, content: { summary: 'Mới từ người khác' } })];
    await refresh();
    await waitFor(() => expect((document.getElementById('draft-summary') as HTMLTextAreaElement).value).toBe('Mới từ người khác'));
    expect(screen.queryByTestId('moved')).toBeNull();
  });

  it('signs the version the dialog was opened on, not the one a refresh brought in behind it', async () => {
    const state = world({ diaries: [diary(1, { version: 3 })] });
    const h = compose(state, { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.contractor.action') }));
    state.diaries = [diary(1, { version: 4, content: { summary: 'Đã bị đổi' } })];
    await refresh();
    pick('sign-method', 'IN_APP_OTP');
    submit(word('qms.diary.sign.submit'));
    await waitFor(() => expect(commandsOf(h, 'signSiteDiaryByContractor')).toHaveLength(1));
    expect(commandsOf(h, 'signSiteDiaryByContractor')[0]).toMatchObject({ path: { id: diaryId(1) }, ifMatchVersion: 3 });
  });
});

describe('everything that is signed is on the screen, and nothing typed is lost to a save (Codex review of ST-QMS-001)', () => {
  const extra = { summary: 'Đổ bê tông', equipment: [{ name: 'Máy trộn', hours: 6 }], incident: 'Không' };

  it('shows the fields of the content that the form does not edit before the supervisor signs, in the draft and in the correction', async () => {
    review(world({ diaries: [diary(1, { status: 'CONTRACTOR_SIGNED', content: extra, actions: actions({ supervise: true }) })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    const other = await screen.findByTestId('other-content');
    expect(other.textContent).toContain('Máy trộn');
    expect(other.textContent).toContain('"incident": "Không"');
    expect(other.textContent).not.toContain('Đổ bê tông');
    cleanup();
    compose(world({ diaries: [diary(1, { content: extra })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    expect((await screen.findByTestId('other-content')).textContent).toContain('Máy trộn');
    cleanup();
    compose(world({ diaries: [diary(1, { status: 'LOCKED', content: extra, actions: actions({ correct: true }) })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.correct.action') }));
    expect(within(dialog()).getByTestId('other-content').textContent).toContain('Máy trộn');
    cleanup();
    review(world({ diaries: [diary(1, { status: 'CONTRACTOR_SIGNED', actions: actions({ supervise: true }) })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    await screen.findByTestId('diary-content');
    expect(screen.queryByTestId('other-content')).toBeNull();
  });

  it('keeps what the form cannot show (notes as a list) when only the workforce is edited, and shows it', async () => {
    const h = compose(world({ diaries: [diary(1, { content: { summary: 'Đổ bê tông', notes: ['An toàn lao động đã kiểm tra'], workforce_count: 12 }, weather_code: null, version: 2 })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    await screen.findByTestId('draft-form');
    expect(screen.getByTestId('other-content').textContent).toContain('An toàn lao động đã kiểm tra');
    pick('draft-workforce', '20');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    await waitFor(() => expect(commandsOf(h, 'reviseSiteDiaryDraft')).toHaveLength(1));
    expect(commandsOf(h, 'reviseSiteDiaryDraft')[0]?.body.content).toEqual({ summary: 'Đổ bê tông', notes: ['An toàn lao động đã kiểm tra'], workforce_count: 20 });
  });

  it('holds the fields while the draft is being saved', async () => {
    let release: (value: unknown) => void = () => undefined;
    compose(world({ diaries: [diary(1)] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR, command: () => new Promise((resolve) => (release = resolve)) });
    await screen.findByTestId('draft-form');
    pick('draft-summary', 'Bản gửi đi');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    await waitFor(() => expect((document.getElementById('draft-summary') as HTMLTextAreaElement).matches(':disabled')).toBe(true));
    release(OK);
    await waitFor(() => expect((document.getElementById('draft-summary') as HTMLTextAreaElement).matches(':disabled')).toBe(false));
  });
});

describe('one operation per payload, and the content the server takes (Codex review of ST-QMS-001)', () => {
  it('keeps the operation of a diary that is sent again as it was, and gives a diary that was changed after a send that got no answer another', async () => {
    let calls = 0;
    const h = catalogue(world(), {
      permissions: CONTRACTOR,
      command: () => {
        calls += 1;
        return calls <= 2 ? Promise.reject(new Error('no answer')) : OK;
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.new.action') }));
    pick('diary-contract', contractId(2));
    pick('new-summary', 'Bản đầu');
    submit(word('qms.diary.new.submit'));
    await within(dialog()).findByTestId('refusal');
    submit(word('qms.diary.new.submit'));
    await waitFor(() => expect(commandsOf(h, 'saveSiteDiaryDraft')).toHaveLength(2));
    pick('new-summary', 'Bản đã sửa');
    submit(word('qms.diary.new.submit'));
    await waitFor(() => expect(commandsOf(h, 'saveSiteDiaryDraft')).toHaveLength(3));
    const [first, again, changed] = commandsOf(h, 'saveSiteDiaryDraft').map((sent) => sent.body.client_operation_id);
    expect(again).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('keeps the operation of a draft that is saved again as it was, and gives a draft that was changed after a send that got no answer another', async () => {
    let calls = 0;
    const h = compose(world({ diaries: [diary(1)] }), {
      query: `?diary=${diaryId(1)}`,
      permissions: CONTRACTOR,
      command: () => {
        calls += 1;
        return calls <= 2 ? Promise.reject(new Error('no answer')) : OK;
      },
    });
    await screen.findByTestId('draft-form');
    pick('draft-summary', 'Bản đầu');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    await screen.findByTestId('refusal');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    await waitFor(() => expect(commandsOf(h, 'reviseSiteDiaryDraft')).toHaveLength(2));
    pick('draft-summary', 'Bản đã sửa');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    await waitFor(() => expect(commandsOf(h, 'reviseSiteDiaryDraft')).toHaveLength(3));
    const [first, again, changed] = commandsOf(h, 'reviseSiteDiaryDraft').map((sent) => sent.body.client_operation_id);
    expect(again).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('gives a signature that was changed after a send that got no answer another operation', async () => {
    let calls = 0;
    const h = compose(world({ diaries: [diary(1)] }), {
      query: `?diary=${diaryId(1)}`,
      permissions: CONTRACTOR,
      command: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('no answer')) : OK;
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.contractor.action') }));
    pick('sign-method', 'IN_APP_OTP');
    submit(word('qms.diary.sign.submit'));
    await within(dialog()).findByTestId('refusal');
    pick('sign-method', 'IN_APP_WEBAUTHN');
    submit(word('qms.diary.sign.submit'));
    await waitFor(() => expect(commandsOf(h, 'signSiteDiaryByContractor')).toHaveLength(2));
    const [first, changed] = commandsOf(h, 'signSiteDiaryByContractor').map((sent) => sent.body.client_operation_id);
    expect(changed).not.toBe(first);
  });

  it('edits a diary with a weather code the server takes and the form does not offer, without replacing it', async () => {
    const h = compose(world({ diaries: [diary(1, { content: { summary: 'Đổ bê tông', weather_code: 'FOG', workforce_count: 12 }, weather_code: 'FOG' })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    await screen.findByTestId('draft-form');
    expect((document.getElementById('draft-weather') as HTMLSelectElement).value).toBe('FOG');
    pick('draft-workforce', '15');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.draft.save') }));
    await waitFor(() => expect(commandsOf(h, 'reviseSiteDiaryDraft')).toHaveLength(1));
    expect(commandsOf(h, 'reviseSiteDiaryDraft')[0]?.body.content).toMatchObject({ weather_code: 'FOG', workforce_count: 15 });
  });
});

describe('the conflict of two devices (ST-QMS-002, QMS-01, QMS-02, QMS-03)', () => {
  const conflicted = (overrides: Record<string, unknown> = {}) => diary(1, { version: 4, actions: actions({ revise: true, contractorSign: true, resolveConflict: true }), conflicts: [copy(1)], ...overrides });

  it('AC-ST-QMS-002-1: UAT-AC62 shows on the catalogue and the diary that a device left a copy that waits, and what it said', async () => {
    catalogue(world({ diaries: [conflicted(), diary(2)] }));
    await screen.findByTestId('diaries');
    expect(within(row(diaryId(1))).getByTestId('conflicts-waiting').textContent).toBe(text('qms.diary.conflicts.count', { count: 1 }));
    expect(within(row(diaryId(2))).queryByTestId('conflicts-waiting')).toBeNull();
    expect(row(diaryId(1)).querySelector('[data-review]')).not.toBeNull();
    cleanup();
    compose(world({ diaries: [conflicted()] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    const panel = await screen.findByTestId('conflicts');
    expect(within(panel).getByTestId('conflict-summary').textContent).toBe('Việc ghi trên thiết bị thứ 2');
    expect(within(panel).getByTestId('conflict-state').textContent).toBe(word('qms.diary.conflicts.pending'));
    expect(within(panel).getByText(text('qms.diary.conflicts.device', { device: '00000000-0000-4000-8000-0000000000d1' }), { exact: false })).toBeTruthy();
    expect(screen.getByTestId('to-review').getAttribute('href')).toBe(`/qms/qms-03?diary=${diaryId(1)}`);
  });

  it('shows everything a copy says, the weather, the workforce, the notes and the rest, on the diary and where it is settled (Codex review of ST-QMS-002)', async () => {
    const whole = copy(1, { content: { summary: 'Thiết bị hai', weather_code: 'RAIN', workforce_count: 44, notes: 'Mưa từ trưa', equipment: ['máy trộn'] } });
    review(world({ diaries: [diary(1, { version: 4, actions: actions({ revise: true, resolveConflict: true }), conflicts: [whole] })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    const panel = await screen.findByTestId('conflicts');
    expect(within(panel).getByTestId('conflict-weather').textContent).toBe(word('qms.diary.weather.rain'));
    expect(within(panel).getByTestId('conflict-workforce').textContent).toBe('44');
    expect(within(panel).getByTestId('conflict-notes').textContent).toBe('Mưa từ trưa');
    expect(within(panel).getByTestId('other-content').textContent).toContain('máy trộn');
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.resolve.action') }));
    expect(within(dialog()).getByTestId('resolve-copy-workforce').textContent).toBe('44');
    expect(within(dialog()).getByTestId('resolve-copy-notes').textContent).toBe('Mưa từ trưa');
    expect(within(dialog()).getByTestId('resolve-main-workforce').textContent).toBe('12');
    expect(within(dialog()).getByTestId('resolve-main-weather').textContent).toBe(word('qms.diary.weather.sunny'));
  });

  it('shows a diary once in the queue when it waits for two reasons (Codex review of ST-QMS-002)', async () => {
    review(world({ diaries: [conflicted({ status: 'SUPERVISED', signatures: [signature('CONTRACTOR', 'Nhà thầu')], actions: actions({ ownerConfirm: true, lock: true, resolveConflict: true }) })] }), { permissions: CONTRACTOR });
    await screen.findByTestId('queue');
    expect(rows()).toEqual([diaryId(1)]);
  });

  it('finds the diaries with a copy that waits whatever state they are in, in the queue and with a filter on the catalogue (Codex review of ST-QMS-002)', async () => {
    const locked = conflicted({ status: 'LOCKED', actions: actions({ resolveConflict: true }) });
    review(world({ diaries: [locked, diary(2)] }), { permissions: CONTRACTOR });
    await screen.findByTestId('queue');
    expect(rows()).toEqual([diaryId(1)]);
    cleanup();
    const h = catalogue(world({ diaries: [locked, diary(2)] }));
    await screen.findByTestId('diaries');
    expect(rows()).toEqual([diaryId(1), diaryId(2)]);
    fireEvent.click(document.getElementById('diary-filter-conflict') as HTMLElement);
    await waitFor(() => expect(rows()).toEqual([diaryId(1)]));
    expect(readsOf(h, 'get_resources_site_diary').at(-1)?.query).toMatchObject({ has_conflict: 'true' });
  });

  it('shows how a copy was settled and what the settling said, and offers nothing more for it', async () => {
    review(world({ diaries: [diary(1, { conflicts: [copy(1, { state: 'RESOLVED', resolution: 'ADOPT_CONFLICT', note: 'Bản thứ hai đúng', resolved_at: '2026-10-25T05:00:00.000Z' })] })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    const panel = await screen.findByTestId('conflicts');
    expect(within(panel).getByTestId('conflict-state').textContent).toBe(word('qms.diary.conflicts.resolved'));
    expect(within(panel).getByTestId('conflict-resolution').textContent).toBe(`${text('qms.diary.conflicts.how', { resolution: word('qms.diary.resolution.adopt') })} — Bản thứ hai đúng`);
    expect(screen.queryByTestId('conflicts-waiting')).toBeNull();
    expect(screen.queryByRole('button', { name: word('qms.diary.resolve.action') })).toBeNull();
  });

  it('asks for the copy, the way and the reason before it sends anything', async () => {
    const h = review(world({ diaries: [conflicted()] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.resolve.action') }));
    expect(within(dialog()).getByTestId('resolve-copy-summary').textContent).toBe('Việc ghi trên thiết bị thứ 2');
    expect(within(dialog()).getByTestId('resolve-main-summary').textContent).toBe('Đổ bê tông móng đợt 1');
    submit(word('qms.diary.resolve.submit'));
    expect(within(dialog()).getAllByText(word('qms.diary.problem.required'))).toHaveLength(2);
    pick('resolve-resolution', 'MERGED');
    pick('resolve-note', 'Ghép lại');
    pick('merge-summary', '');
    submit(word('qms.diary.resolve.submit'));
    expect(within(dialog()).getByText(word('qms.diary.problem.required'))).toBeTruthy();
    expect(commandsOf(h, 'resolveDiaryConflict')).toHaveLength(0);
  });

  it('keeps the diary, under the version shown, with the reason', async () => {
    const h = review(world({ diaries: [conflicted()] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.resolve.action') }));
    pick('resolve-resolution', 'KEEP_PRIMARY');
    pick('resolve-note', '  Kỹ sư thứ nhất có mặt  ');
    submit(word('qms.diary.resolve.submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [sent] = commandsOf(h, 'resolveDiaryConflict');
    expect(sent).toEqual({ path: { id: diaryId(1) }, ifMatchVersion: 4, body: { conflict_diary_id: copy(1).id, resolution: 'KEEP_PRIMARY', note: 'Kỹ sư thứ nhất có mặt' }, attempt: expect.anything() });
  });

  it('takes the copy of the device, and merges the two with the content that the person wrote', async () => {
    const h = review(world({ diaries: [conflicted({ content: { summary: 'Đổ bê tông', other_client: { photos: 2 } } })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.resolve.action') }));
    pick('resolve-resolution', 'ADOPT_CONFLICT');
    pick('resolve-note', 'Bản của thiết bị đầy đủ hơn');
    submit(word('qms.diary.resolve.submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'resolveDiaryConflict')[0]?.body).toEqual({ conflict_diary_id: copy(1).id, resolution: 'ADOPT_CONFLICT', note: 'Bản của thiết bị đầy đủ hơn' });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.resolve.action') }));
    pick('resolve-resolution', 'MERGED');
    expect(
      within(dialog())
        .getAllByTestId('other-content')
        .map((entry) => entry.textContent)
        .join(' '),
    ).toContain('photos');
    pick('merge-summary', 'Cả hai đều đúng');
    pick('merge-workforce', '25');
    pick('resolve-note', 'Ghép số nhân lực');
    submit(word('qms.diary.resolve.submit'));
    await waitFor(() => expect(commandsOf(h, 'resolveDiaryConflict')).toHaveLength(2));
    expect(commandsOf(h, 'resolveDiaryConflict')[1]?.body).toMatchObject({ resolution: 'MERGED', merged_content: { summary: 'Cả hai đều đúng', workforce_count: 25, other_client: { photos: 2 } }, note: 'Ghép số nhân lực' });
  });

  it('offers only to keep the diary once it was signed, and says what the server refused, in words', async () => {
    review(world({ diaries: [conflicted({ status: 'CONTRACTOR_SIGNED', signatures: [signature('CONTRACTOR', 'Nhà thầu')], actions: actions({ supervise: true, resolveConflict: true }) })] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.resolve.action') }));
    expect(Array.from((document.getElementById('resolve-resolution') as HTMLSelectElement).options).map((option) => option.value)).toEqual(['', 'KEEP_PRIMARY']);
    expect(within(dialog()).getByText(word('qms.diary.resolve.onlyKeep'))).toBeTruthy();
    cleanup();
    const cases: Array<[Error, string]> = [
      [refusal('DIARY_STATE_INVALID', 409), 'qms.diary.error.diaryState'],
      [refusal('VERSION_CONFLICT', 409), 'qms.diary.error.versionConflict'],
      [refusal('VALIDATION_FAILED'), 'qms.diary.error.validation'],
    ];
    for (const [error, key] of cases) {
      review(world({ diaries: [conflicted()] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR, command: () => Promise.reject(error) });
      fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.resolve.action') }));
      pick('resolve-resolution', 'KEEP_PRIMARY');
      pick('resolve-note', 'Lý do');
      submit(word('qms.diary.resolve.submit'));
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word(key));
      cleanup();
    }
  });

  it('offers no way to settle it to whoever the server says may not, or in a read-only session, and lists the drafts with a copy that waits in the queue', async () => {
    review(world({ diaries: [conflicted({ actions: actions() })] }), { query: `?diary=${diaryId(1)}`, permissions: READER });
    await screen.findByTestId('conflicts');
    expect(screen.queryByRole('button', { name: word('qms.diary.resolve.action') })).toBeNull();
    cleanup();
    review(world({ diaries: [conflicted()] }), { query: `?diary=${diaryId(1)}`, permissions: CONTRACTOR, mode: 'READ_ONLY' });
    await screen.findByTestId('conflicts');
    expect(screen.queryByRole('button', { name: word('qms.diary.resolve.action') })).toBeNull();
    cleanup();
    review(world({ diaries: [conflicted(), diary(2)] }), { permissions: CONTRACTOR });
    await screen.findByTestId('queue');
    expect(rows()).toEqual([diaryId(1)]);
  });
});

describe('DiaryReviewScreen (QMS-03): the remark of the supervisor and the confirmation of the owner', () => {
  const at = (n: number, permissions: readonly string[] = CONTRACTOR) => ({ query: `?diary=${diaryId(n)}`, permissions });
  const waiting = (n: number, status: string, on: Partial<ReturnType<typeof actions>>) => diary(n, { status, signatures: [signature('CONTRACTOR', 'Nhà thầu An Phát')], actions: actions(on), signable_roles: [] });

  it('lists the diaries that wait for someone when none is named, oldest day first, and none that do not', async () => {
    review(
      world({
        diaries: [waiting(3, 'OWNER_CONFIRMED', { lock: true }), waiting(2, 'CONTRACTOR_SIGNED', { supervise: true }), waiting(1, 'SUPERVISED', {}), waiting(4, 'SUPERVISED', { ownerConfirm: true, lock: true })],
      }),
      { permissions: CONTRACTOR },
    );
    await screen.findByTestId('queue');
    expect(rows()).toEqual([diaryId(2), diaryId(3), diaryId(4)]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('qms.diary.review.title'));
    expect(row(diaryId(2)).querySelector(`a[href="/qms/qms-03?diary=${diaryId(2)}"]`)).not.toBeNull();
    expect(within(row(diaryId(3))).getByText(word('qms.diary.status.ownerConfirmed'))).toBeTruthy();
  });

  it('keeps the button to read more while the pages read so far hold nothing that waits for the caller', async () => {
    review(world({ page: 1, diaries: [waiting(1, 'SUPERVISED', {}), waiting(2, 'SUPERVISED', { ownerConfirm: true })] }), { permissions: CONTRACTOR });
    expect((await screen.findByTestId('queue-empty')).textContent).toBe(word('qms.diary.queue.none'));
    fireEvent.click(screen.getByRole('button', { name: word('qms.diary.more.action') }));
    await waitFor(() => expect(rows()).toEqual([diaryId(2)]));
    expect(screen.queryByTestId('queue-empty')).toBeNull();
  });

  it('shows the diary with what each role may do, and nothing the diary does not allow', async () => {
    review(world({ diaries: [waiting(1, 'CONTRACTOR_SIGNED', { supervise: true })] }), at(1));
    await screen.findByTestId('diary-content');
    expect(screen.getByRole('button', { name: word('qms.diary.sign.supervisor.action') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: word('qms.diary.sign.owner.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: word('qms.diary.lock.action') })).toBeNull();
    expect(screen.getByTestId('to-compose').getAttribute('href')).toBe(`/qms/qms-02?diary=${diaryId(1)}`);
    expect(screen.getByTestId('legal-note')).toBeTruthy();
  });

  it('asks the supervisor for the remark and the way of signing, and sends them under the version shown', async () => {
    const h = review(world({ diaries: [{ ...waiting(1, 'CONTRACTOR_SIGNED', { supervise: true }), version: 6 }] }), at(1));
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.supervisor.action') }));
    submit(word('qms.diary.sign.submit'));
    expect(within(dialog()).getAllByText(word('qms.diary.problem.required'))).toHaveLength(2);
    pick('sign-words', '  Cần bổ sung ảnh  ');
    pick('sign-method', 'IN_APP_WEBAUTHN');
    submit(word('qms.diary.sign.submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [sent] = commandsOf(h, 'addSupervisorRemark');
    expect(sent).toMatchObject({ path: { id: diaryId(1) }, ifMatchVersion: 6, body: { remark: 'Cần bổ sung ảnh', signature_method: 'IN_APP_WEBAUTHN' } });
    expect(sent?.body.client_operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lets the owner confirm with or without a note', async () => {
    const h = review(world({ diaries: [waiting(1, 'SUPERVISED', { ownerConfirm: true })] }), at(1));
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.owner.action') }));
    pick('sign-method', 'IN_APP_OTP');
    submit(word('qms.diary.sign.submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'confirmSiteDiaryByOwner')[0]?.body).not.toHaveProperty('note');
    cleanup();
    const second = review(world({ diaries: [waiting(1, 'SUPERVISED', { ownerConfirm: true })] }), at(1));
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.owner.action') }));
    pick('sign-words', 'Đồng ý');
    pick('sign-method', 'IN_APP_OTP');
    submit(word('qms.diary.sign.submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(second, 'confirmSiteDiaryByOwner')[0]?.body).toMatchObject({ note: 'Đồng ý' });
  });

  it('locks a diary with or without a reason', async () => {
    const h = review(world({ diaries: [waiting(1, 'OWNER_CONFIRMED', { lock: true })] }), at(1));
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.lock.action') }));
    expect(within(dialog()).getByText(word('qms.diary.lock.hint'))).toBeTruthy();
    submit(word('qms.diary.lock.submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'lockSiteDiary')[0]).toMatchObject({ path: { id: diaryId(1) }, body: {} });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.lock.action') }));
    pick('lock-reason', 'Hết hạn ba ngày');
    submit(word('qms.diary.lock.submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'lockSiteDiary')[1]?.body).toEqual({ reason: 'Hết hạn ba ngày' });
  });

  it('says what the server refused, in words, and offers no button in a read-only session', async () => {
    review(world({ diaries: [waiting(1, 'CONTRACTOR_SIGNED', { supervise: true })] }), { ...at(1), command: () => Promise.reject(refusal('SCOPE_DENIED', 403, {}, 'signer_role')) });
    fireEvent.click(await screen.findByRole('button', { name: word('qms.diary.sign.supervisor.action') }));
    pick('sign-words', 'Ý kiến');
    pick('sign-method', 'IN_APP_OTP');
    submit(word('qms.diary.sign.submit'));
    expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(word('qms.diary.error.notYourRole'));
    cleanup();
    review(world({ diaries: [waiting(1, 'CONTRACTOR_SIGNED', { supervise: true })] }), { ...at(1), mode: 'READ_ONLY' });
    await screen.findByTestId('diary-content');
    expect(screen.queryByRole('button', { name: word('qms.diary.sign.supervisor.action') })).toBeNull();
  });
});
