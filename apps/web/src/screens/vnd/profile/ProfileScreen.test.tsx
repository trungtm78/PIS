import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import ProfileScreen from './ProfileScreen';
import { ALL, CONTRACTOR, READER, caseLine, client, duplicate, mount, owner, profileView, registerLine, registerPage, figures, routeOf, venture, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
const route = routeOf('VND-02', 'FR-VND-02');
const PATH = `/vnd/vnd-02?contractor=${CONTRACTOR}`;

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

function open(view: Record<string, unknown> = profileView(), options: { permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; extra?: World['answers']; failing?: World['failing'] } = {}) {
  const world: World = { answers: { getVendorContractor: view, ...(options.extra ?? {}) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<ProfileScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('profile-facts');
};
const tab = (code: string): HTMLElement => screen.getByRole('tab', { name: word(`vnd.profile.tab.${code}.name`) });
const gotoTab = async (code: string): Promise<void> => {
  await loaded();
  fireEvent.click(tab(code));
};
const valueOf = (id: string): string | null | undefined => screen.getByTestId(id).querySelector('dd')?.textContent;
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string | RegExp): RegExp => (typeof label === 'string' ? new RegExp(escaped(label)) : label);
const type = (scope: HTMLElement, label: string | RegExp, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const press = (scope: HTMLElement, name: string): void => {
  fireEvent.click(within(scope).getByRole('button', { name }));
};

describe('ProfileScreen (VND-02): the contractor profile', () => {
  it('without a contractor in the address it is the register, with a note to choose one', async () => {
    const world: World = { answers: { listVendorRegister: registerPage([registerLine(1)]), getVendorFigures: figures() } };
    mount(<ProfileScreen route={route} />, client(world), { permissions: READER });
    expect((await screen.findByTestId('choose-contractor')).textContent).toBe(word('vnd.profile.choose.text'));
    expect(await screen.findByText('Công ty nhà thầu 1')).toBeTruthy();
  });

  it('reads the contractor named in the address and shows the details, the verification and the day of the answer', async () => {
    const { h } = open();
    await loaded();
    expect(h.read).toHaveBeenCalledWith('getVendorContractor', { path: { id: CONTRACTOR } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Công ty nhà thầu 1');
    expect(valueOf('fact-tax')).toBe('0101234561');
    expect(valueOf('fact-legal-rep')).toBe('Nguyễn Văn An · Giám đốc');
    expect(valueOf('fact-address')).toBe('12 Phố Huế, Hà Nội');
    expect(valueOf('fact-phone')).toContain('0901234567');
    expect(valueOf('fact-email')).toBe('lienhe@example.vn');
    expect(valueOf('fact-registration')).toBe('0101234561');
    expect(valueOf('fact-ownership')).toContain(word('vnd.profile.ownership.listed.text'));
    expect(valueOf('fact-review')).toContain('01/10/2027');
    expect(document.body.textContent).toContain('08/11/2026 10:00');
  });

  it('shows the tax code check: the shape, the check digit, the flag that its rule is not verified, and the "i"', async () => {
    open(profileView({ tax_check: { format: 'VALID', checksum: 'MISMATCH', checksum_legal_status: 'UNVERIFIED', normalised: '0101234561' } }));
    await loaded();
    const card = screen.getByTestId('tax-check');
    expect(within(card).getByTestId('tax-format').textContent).toContain(word('vnd.taxFormat.valid.name'));
    expect(within(card).getByTestId('tax-checksum').textContent).toContain(word('vnd.taxChecksum.mismatch.name'));
    expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(0);
    expect(screen.getByText(word('vnd.profile.tax.unverified.text'))).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.profile.figure.tax.name') }) }));
    expect(screen.getByRole('dialog', { name: word('vnd.profile.figure.tax.name') }).querySelector('[data-field=unverified]')).toBeTruthy();
  });

  it('shows the coverage by the rule with the fields that are present and missing, and its definition', async () => {
    open();
    await loaded();
    const line = screen.getByTestId('coverage-line');
    expect(within(line).getByRole('meter').getAttribute('aria-valuenow')).toBe('50');
    const fields = screen.getByTestId('coverage-fields');
    expect(fields.textContent).toContain(word('vnd.profileField.legalRepresentative.name'));
    expect(fields.textContent).toContain(word('vnd.profileField.ownership.name'));
    expect(screen.getByText(word('vnd.profile.coverage.incomplete.text'))).toBeTruthy();
    fireEvent.click(within(line).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.profile.figure.coverage.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.profile.figure.coverage.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toContain('Formula of VENDOR_PROFILE');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
  });

  it('links to the payee accounts and the certificates of the contractor with their counts', async () => {
    open();
    await loaded();
    expect(screen.getByRole('link', { name: text('vnd.profile.links.payee.text', { count: 1, changes: 1 }) }).getAttribute('href')).toBe(`/vnd/vnd-04?contractor=${CONTRACTOR}`);
    expect(screen.getByRole('link', { name: text('vnd.profile.links.certificates.text', { qualifications: 1, staff: 1 }) }).getAttribute('href')).toBe(`/vnd/vnd-05?contractor=${CONTRACTOR}`);
  });

  describe('states', () => {
    it('LOADING: a skeleton, no facts', async () => {
      const h = client({ answers: {} });
      h.read.mockImplementation(() => new Promise(() => undefined));
      mount(<ProfileScreen route={route} />, h, { permissions: ALL, path: PATH });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      expect(screen.queryByTestId('profile-facts')).toBeNull();
    });

    it('ERROR: names the failure and retries in place', async () => {
      open(profileView(), { failing: { getVendorContractor: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await loaded();
    });

    it('FORBIDDEN: says the scope is hidden', async () => {
      open(profileView(), { failing: { getVendorContractor: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
      expect(screen.queryByTestId('profile-facts')).toBeNull();
    });

    it('EMPTY: a contractor that is not there is said as nothing found, with no retry', async () => {
      open(profileView(), { failing: { getVendorContractor: { error: problem(404, 'RESOURCE_NOT_FOUND'), times: 9 } } });
      expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    });

    it('STALE: keeps the last reading when a refresh fails and says so', async () => {
      let calls = 0;
      const world: World = { answers: { getVendorContractor: () => (++calls === 1 ? profileView() : problem(500, 'INTERNAL_ERROR')) } };
      const mounted = mount(<ProfileScreen route={route} />, client(world), { permissions: ALL, path: PATH });
      await loaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect((await screen.findByTestId('stale-notice')).textContent).toContain(word('vnd.stale.text'));
      expect(screen.getByTestId('profile-facts')).toBeTruthy();
    });
  });

  describe('tabs', () => {
    it('is a tablist: one tab is selected, the arrows move between tabs and the panel follows', async () => {
      open();
      await loaded();
      const first = tab('profile');
      expect(first.getAttribute('aria-selected')).toBe('true');
      expect(first.getAttribute('tabindex')).toBe('0');
      expect(tab('owners').getAttribute('tabindex')).toBe('-1');
      fireEvent.keyDown(first, { key: 'ArrowRight' });
      expect(tab('owners').getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tab('owners'));
      expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('vnd-tab-owners');
      fireEvent.keyDown(tab('owners'), { key: 'End' });
      expect(tab('gate').getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(tab('gate'), { key: 'ArrowRight' });
      expect(tab('profile').getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(tab('profile'), { key: 'ArrowLeft' });
      expect(tab('gate').getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(tab('gate'), { key: 'Home' });
      expect(tab('profile').getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('editing the profile', () => {
    it('sends only the fields that changed, under the version the person saw, with an idempotency attempt', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('edit-profile'));
      const form = dialog(word('vnd.profile.edit.title'));
      const save = within(form).getByRole('button', { name: word('vnd.profile.edit.confirm') }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      type(form, labelOf(word('vnd.profile.field.email.label')), ' moi@example.vn ');
      type(form, labelOf(word('vnd.profile.field.phone.label')), '');
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('updateVendorProfile', { path: { id: CONTRACTOR }, ifMatchVersion: 4, body: { email: 'moi@example.vn', phone: null }, attempt: { key: expect.any(String) } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByTestId('receipt').textContent).toContain(word('vnd.profile.edit.title'));
    });

    it('keeps the lengths of the request: a representative of one letter is not accepted', async () => {
      open();
      await loaded();
      fireEvent.click(screen.getByTestId('edit-profile'));
      const form = dialog(word('vnd.profile.edit.title'));
      const name = within(form).getByLabelText(labelOf(word('vnd.profile.field.legalRep.label')));
      fireEvent.change(name, { target: { value: 'A' } });
      fireEvent.blur(name);
      expect(within(form).getByText(text('vnd.field.short.text', { min: 2 }))).toBeTruthy();
      expect((within(form).getByRole('button', { name: word('vnd.profile.edit.confirm') }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('says a version conflict in the dialog and offers to read the record again', async () => {
      open(profileView(), { command: () => Promise.reject(problem(409, 'VERSION_CONFLICT')) });
      await loaded();
      fireEvent.click(screen.getByTestId('edit-profile'));
      const form = dialog(word('vnd.profile.edit.title'));
      type(form, labelOf(word('vnd.profile.field.email.label')), 'moi@example.vn');
      press(form, word('vnd.profile.edit.confirm'));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.conflict.text'));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });

    it('shows the field detail of a 422 the server sends', async () => {
      open(profileView(), { command: () => Promise.reject(problem(422, 'VALIDATION_FAILED', 'email: not an address')) });
      await loaded();
      fireEvent.click(screen.getByTestId('edit-profile'));
      const form = dialog(word('vnd.profile.edit.title'));
      type(form, labelOf(word('vnd.profile.field.email.label')), 'moi@example.vn');
      press(form, word('vnd.profile.edit.confirm'));
      expect((await within(form).findByRole('alert')).textContent).toContain('email: not an address');
    });

    it('is not offered when the answer does not allow it, nor in a read-only workspace', async () => {
      cleanup();
      open(profileView({ actions: { ...(profileView().actions as object), update_profile: false } }));
      await loaded();
      expect(screen.queryByTestId('edit-profile')).toBeNull();
      cleanup();
      open(profileView(), { mode: 'READ_ONLY' });
      await loaded();
      expect(screen.queryByTestId('edit-profile')).toBeNull();
      expect(screen.getByTestId('readonly-note')).toBeTruthy();
    });
  });

  describe('owners', () => {
    const owners = () => profileView({ owners: [owner(1), owner(2, { owner_name: 'Chủ cũ', ended_on: '2026-05-01', ended_reason: 'Chuyển nhượng', beneficial_owner: false, control_basis: null, has_identity_key: false })] });

    it('lists the owners with their share, whether they benefit, the basis of control, and the ones that ended with their reason', async () => {
      open(owners());
      await gotoTab('owners');
      const current = document.querySelector('tr[data-owner-id]') as HTMLElement;
      expect(current.textContent).toContain('Chủ sở hữu 1');
      expect(current.textContent).toContain('60.00%');
      expect(current.textContent).toContain(word('vnd.owners.beneficial.yes'));
      expect(current.textContent).toContain(word('vnd.basis.shareCapital.name'));
      expect(current.textContent).toContain(word('vnd.owners.status.current'));
      const ended = document.querySelectorAll('tr[data-owner-id]')[1] as HTMLElement;
      expect(ended.textContent).toContain(text('vnd.owners.status.ended', { day: '01/05/2026' }));
      expect(ended.textContent).toContain('Chuyển nhượng');
      expect(within(ended).queryByTestId('end-owner')).toBeNull();
    });

    it('says the threshold of a beneficial owner from the rule with its "i" and the unverified flag', async () => {
      open(profileView({ policies: { ...(profileView().policies as object), profile: { code: 'VENDOR_PROFILE', version: 'D-1', unverified: true, formula: 'F', source: 'S', as_of: '2026-11-01', params: { beneficial_owner_pct: 25 } } } }));
      await gotoTab('owners');
      expect(screen.getByTestId('owners-rule').textContent).toContain(text('vnd.owners.rule.text', { pct: 25 }));
      expect(within(screen.getByTestId('owners-rule')).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.owners.figure.threshold.name') }) })).toBeTruthy();
      expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(0);
    });

    it('adds an owner with the body of the request and never asks for the identity number back', async () => {
      const { h } = open(owners());
      await gotoTab('owners');
      fireEvent.click(screen.getByTestId('add-owner'));
      const form = dialog(word('vnd.owners.add.title'));
      type(form, word('vnd.owners.field.name.label'), ' Trần Văn B ');
      type(form, labelOf(word('vnd.owners.field.identity.label')), '001234567890');
      type(form, labelOf(word('vnd.owners.field.share.label')), '33.5');
      fireEvent.click(within(form).getByLabelText(labelOf(word('vnd.owners.field.beneficial.label'))));
      type(form, word('vnd.owners.field.basis.label'), 'VOTING_RIGHTS');
      press(form, word('vnd.owners.add.confirm'));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('addVendorOwner', {
        path: { id: CONTRACTOR },
        body: { owner_kind: 'PERSON', owner_name: 'Trần Văn B', beneficial_owner: true, identity_number: '001234567890', share_pct: '33.5', control_basis: 'VOTING_RIGHTS' },
        attempt: { key: expect.any(String) },
      });
      await waitFor(() => expect(document.body.textContent).not.toContain('001234567890'));
    });

    it('does not accept a share above 100 or an identity number shorter than five characters', async () => {
      open(owners());
      await gotoTab('owners');
      fireEvent.click(screen.getByTestId('add-owner'));
      const form = dialog(word('vnd.owners.add.title'));
      type(form, word('vnd.owners.field.name.label'), 'Trần Văn B');
      const send = within(form).getByRole('button', { name: word('vnd.owners.add.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(false);
      type(form, labelOf(word('vnd.owners.field.share.label')), '120');
      expect(send.disabled).toBe(true);
      type(form, labelOf(word('vnd.owners.field.share.label')), '100');
      expect(send.disabled).toBe(false);
      type(form, labelOf(word('vnd.owners.field.identity.label')), '123');
      expect(send.disabled).toBe(true);
    });

    it('ends an owner with a reason of at least five characters, keeping the history', async () => {
      const { h } = open(owners());
      await gotoTab('owners');
      fireEvent.click(screen.getByTestId('end-owner'));
      const form = dialog(word('vnd.owners.end.title'));
      const confirm = within(form).getByRole('button', { name: word('vnd.owners.end.confirm') }) as HTMLButtonElement;
      type(form, labelOf(word('vnd.field.reason.label')), 'abcd');
      expect(confirm.disabled).toBe(true);
      type(form, labelOf(word('vnd.field.reason.label')), 'Chuyển nhượng vốn');
      fireEvent.click(confirm);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('endVendorOwner', { path: { id: uuid('0002', 1) }, body: { reason: 'Chuyển nhượng vốn' }, attempt: { key: expect.any(String) } }));
    });

    it('declares that no owner is above the threshold under the version of the profile', async () => {
      const { h } = open(owners());
      await gotoTab('owners');
      fireEvent.click(screen.getByTestId('declare-no-owner'));
      const form = dialog(word('vnd.owners.declare.title'));
      press(form, word('vnd.owners.declare.confirm'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('declareVendorNoOwnerAboveThreshold', { path: { id: CONTRACTOR }, ifMatchVersion: 4, body: {}, attempt: { key: expect.any(String) } }));
    });

    it('offers no owner command without the right', async () => {
      open(profileView({ actions: { ...(profileView().actions as object), manage_owners: false } }));
      await gotoTab('owners');
      expect(screen.queryByTestId('add-owner')).toBeNull();
      expect(screen.queryByTestId('declare-no-owner')).toBeNull();
      expect(screen.queryByTestId('end-owner')).toBeNull();
    });

    it('says plainly that there is no owner yet', async () => {
      open(profileView({ owners: [] }));
      await gotoTab('owners');
      expect(screen.getByTestId('owners-empty').textContent).toBe(word('vnd.owners.empty.text'));
    });
  });

  describe('duplicates', () => {
    it('shows a pair with its score, its signals and an "i" for the score, and says that a merge is done in master data', async () => {
      open();
      await gotoTab('duplicates');
      const row = document.querySelector('tr[data-duplicate-id]') as HTMLElement;
      expect(row.textContent).toContain('Công ty nhà thầu 1');
      expect(row.textContent).toContain('Công ty Nhà Thầu 1 chi nhánh');
      expect(row.textContent).toContain('100');
      expect(row.textContent).toContain(`${word('vnd.signal.taxHead.name')}, ${word('vnd.signal.address.name')}`);
      expect(row.textContent).toContain(word('vnd.duplicateStatus.open.name'));
      expect(within(row).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.duplicates.figure.score.name') }) })).toBeTruthy();
      expect(screen.getByTestId('duplicates-rule').textContent).toBe(word('vnd.duplicates.rule.text'));
    });

    it('dismisses a suggestion with a reason of at least five characters', async () => {
      const { h } = open();
      await gotoTab('duplicates');
      fireEvent.click(screen.getByTestId('dismiss-duplicate'));
      const form = dialog(word('vnd.duplicates.dismiss.title'));
      const confirm = within(form).getByRole('button', { name: word('vnd.duplicates.dismiss.confirm') }) as HTMLButtonElement;
      type(form, labelOf(word('vnd.field.reason.label')), 'ngắn');
      expect(confirm.disabled).toBe(true);
      type(form, labelOf(word('vnd.field.reason.label')), 'Hai pháp nhân khác nhau');
      fireEvent.click(confirm);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideVendorDuplicate', { path: { id: uuid('0014', 1) }, ifMatchVersion: 1, body: { decision: 'DISMISSED', reason: 'Hai pháp nhân khác nhau' }, attempt: { key: expect.any(String) } }));
    });

    it('sends a suggestion to the merge of master data, with a reason, and merges nothing here', async () => {
      const { h } = open();
      await gotoTab('duplicates');
      fireEvent.click(screen.getByTestId('merge-duplicate'));
      const form = dialog(word('vnd.duplicates.merge.title'));
      expect(form.textContent).toContain(word('vnd.duplicates.merge.note'));
      type(form, labelOf(word('vnd.field.reason.label')), 'Cùng mã số thuế và địa chỉ');
      press(form, word('vnd.duplicates.merge.confirm'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideVendorDuplicate', expect.objectContaining({ body: { decision: 'MERGE_REQUESTED', reason: 'Cùng mã số thuế và địa chỉ' } })));
    });

    it('scans for duplicates and says how many suggestions came back', async () => {
      const { h } = open(profileView(), { command: (operation) => (operation === 'scanVendorDuplicates' ? { items: [duplicate(1), duplicate(2)], policy: {}, as_of: '2026-11-08T03:00:00.000Z' } : {}) });
      await gotoTab('duplicates');
      fireEvent.click(screen.getByTestId('scan-duplicates'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('scanVendorDuplicates', { path: { id: CONTRACTOR }, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(text('vnd.duplicates.scan.receipt', { count: 2, time: '' }).replace(/\s*\(.*$/, ''));
    });

    it('says a refused scan', async () => {
      open(profileView(), { command: () => Promise.reject(problem(403, 'SCOPE_DENIED')) });
      await gotoTab('duplicates');
      fireEvent.click(screen.getByTestId('scan-duplicates'));
      expect((await screen.findByTestId('scan-error')).textContent).toBe(word('vnd.error.forbidden.text'));
    });

    it('offers the decisions only for an open suggestion and only with the right', async () => {
      cleanup();
      open(profileView({ duplicates: [duplicate(1, { status: 'DISMISSED', decision_reason: 'Khác nhau' })] }));
      await gotoTab('duplicates');
      expect(screen.queryByTestId('dismiss-duplicate')).toBeNull();
      expect(document.body.textContent).toContain('Khác nhau');
      cleanup();
      open(profileView({ actions: { ...(profileView().actions as object), decide_duplicates: false } }));
      await gotoTab('duplicates');
      expect(screen.queryByTestId('dismiss-duplicate')).toBeNull();
    });

    it('says there is nothing to decide when there is no suggestion', async () => {
      open(profileView({ duplicates: [] }));
      await gotoTab('duplicates');
      expect(screen.getByTestId('duplicates-empty').textContent).toBe(word('vnd.duplicates.empty.text'));
    });
  });

  describe('restrictions, cases and reputation', () => {
    it('lists the restrictions with whether they are in force, the cases with their clock, and the events of bid conduct', async () => {
      open(profileView({ cases: [caseLine(1, { clock: 'OVERDUE' })] }));
      await gotoTab('restrictions');
      expect(screen.getAllByText(word('vnd.restrictions.state.inForce')).length).toBeGreaterThan(0);
      const caseRow = document.querySelector('tr[data-case-id]') as HTMLElement;
      expect(within(caseRow).getByRole('link', { name: 'HSC-2026-001' }).getAttribute('href')).toBe(`/vnd/vnd-03?case=${uuid('0010', 1)}`);
      expect(caseRow.textContent).toContain(word('vnd.clock.overdue.name'));
      expect(caseRow.textContent).toContain(word('vnd.caseStatus.proposed.name'));
      expect(screen.getByText(word('vnd.behaviour.noBidSecurity.name'))).toBeTruthy();
      expect(screen.getByRole('link', { name: word('vnd.behaviour.noBidSecurity.name') }).getAttribute('href')).toBe(`/vnd/vnd-06?event=${uuid('0012', 1)}`);
    });

    it('says the bid security factor with its day and the flag that the numbers are not verified', async () => {
      open();
      await gotoTab('restrictions');
      const line = screen.getByTestId('bid-security');
      expect(line.textContent).toContain(text('vnd.restrictions.security.raised.text', { multiplier: 3, until: '01/11/2028' }));
      expect(within(line).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.restrictions.figure.security.name') }) })).toBeTruthy();
      expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(1);
    });

    it('says the normal level when the factor is one', async () => {
      open(profileView({ bid_security: { multiplier: 1, until: null, event_ids: [], policy_version: 'D-1' } }));
      await gotoTab('restrictions');
      expect(screen.getByTestId('bid-security').textContent).toContain(word('vnd.restrictions.security.normal.text'));
    });

    it('shows the suggestion of a wider ban as text and offers no button that bans', async () => {
      open(profileView({ escalation: { decisions_in_force: 3, suggestion: 'PROVINCE' } }));
      await gotoTab('restrictions');
      expect(screen.getByTestId('escalation').textContent).toContain(text('vnd.restrictions.escalation.count.text', { count: 3 }));
      expect(screen.getByTestId('escalation-suggestion').textContent).toBe(text('vnd.restrictions.escalation.suggestion.text', { scope: word('vnd.suggestion.province.name') }));
      expect(screen.queryByRole('button', { name: /cấm tỉnh|cấm toàn quốc/i })).toBeNull();
    });

    it('links to the opening of a case only with the right to propose', async () => {
      cleanup();
      open();
      await gotoTab('restrictions');
      expect(screen.getByTestId('open-case-link').getAttribute('href')).toBe(`/vnd/vnd-03?contractor=${CONTRACTOR}`);
      cleanup();
      open(profileView({ actions: { ...(profileView().actions as object), propose_restriction: false } }));
      await gotoTab('restrictions');
      expect(screen.queryByTestId('open-case-link')).toBeNull();
    });

    it('says there is nothing when the contractor has no restriction, case or event', async () => {
      open(profileView({ restrictions: [], cases: [], reputation_events: [] }));
      await gotoTab('restrictions');
      expect(screen.getByTestId('restrictions-empty')).toBeTruthy();
      expect(screen.getByTestId('cases-empty')).toBeTruthy();
      expect(screen.getByTestId('reputation-empty')).toBeTruthy();
    });
  });

  describe('joint ventures', () => {
    it('lists the ventures with their members, shares and the lead', async () => {
      open(profileView({ ventures: [venture(1)] }));
      await gotoTab('ventures');
      const row = screen.getByText('Liên danh 1').closest('tr') as HTMLElement;
      expect(row.textContent).toContain(text('vnd.ventures.member.text', { name: 'Công ty nhà thầu 1', share: '60' }));
      expect(row.textContent).toContain(text('vnd.ventures.member.text', { name: 'Công ty nhà thầu 2', share: '40' }));
      expect(within(row).getAllByText(word('vnd.ventures.lead.badge'))).toHaveLength(1);
    });

    it('says there is none', async () => {
      open(profileView({ ventures: [] }));
      await gotoTab('ventures');
      expect(screen.getByTestId('ventures-empty').textContent).toBe(word('vnd.ventures.empty.text'));
    });
  });

  describe('the gate check', () => {
    const gate = (over: Record<string, unknown> = {}) => ({
      action: 'PAYMENT',
      contractor_id: CONTRACTOR,
      allowed: false,
      refusal_code: 'PAYEE_ACCOUNT_NOT_VALID',
      refusal_extensions: { reason: 'IN_WAITING_PERIOD' },
      warnings: [{ code: 'PROFILE_INCOMPLETE', detail: {} }],
      checks: ['RESTRICTION', 'PAYEE'],
      as_of: '2026-11-08T03:00:00.000Z',
      ...over,
    });

    it('reads the gate of the step the person chooses and shows the refusal code in words, the warnings and the checks made', async () => {
      const { h } = open(profileView(), { extra: { checkVendorGate: gate() } });
      await gotoTab('gate');
      expect(h.read).not.toHaveBeenCalledWith('checkVendorGate', expect.anything());
      fireEvent.change(screen.getByLabelText(word('vnd.gate.action.label')), { target: { value: 'PAYMENT' } });
      fireEvent.click(screen.getByTestId('gate-run'));
      const result = await screen.findByTestId('gate-result');
      expect(h.read).toHaveBeenCalledWith('checkVendorGate', { query: { contractor_id: CONTRACTOR, action: 'PAYMENT' } });
      expect(result.getAttribute('data-allowed')).toBe('false');
      expect(result.textContent).toContain(word('vnd.gate.result.refused'));
      expect(screen.getByTestId('gate-refusal').textContent).toContain(word('vnd.gate.refusal.payee.text'));
      expect(screen.getByTestId('gate-refusal').textContent).toContain('PAYEE_ACCOUNT_NOT_VALID');
      expect(screen.getByTestId('gate-extensions').textContent).toContain('reason: IN_WAITING_PERIOD');
      expect(screen.getByTestId('gate-warnings').textContent).toContain(word('vnd.warning.profileIncomplete.name'));
      expect(screen.getByTestId('gate-checks').textContent).toContain(`${word('vnd.gateCheck.restriction.name')}, ${word('vnd.gateCheck.payee.name')}`);
    });

    it('says allowed without a refusal', async () => {
      open(profileView(), { extra: { checkVendorGate: gate({ allowed: true, refusal_code: null, refusal_extensions: {}, warnings: [] }) } });
      await gotoTab('gate');
      fireEvent.click(screen.getByTestId('gate-run'));
      const result = await screen.findByTestId('gate-result');
      expect(result.getAttribute('data-allowed')).toBe('true');
      expect(result.textContent).toContain(word('vnd.gate.result.allowed'));
      expect(screen.queryByTestId('gate-refusal')).toBeNull();
    });

    it('says a failed check in place', async () => {
      open(profileView(), { failing: { checkVendorGate: { error: problem(500, 'INTERNAL_ERROR'), times: 9 } }, extra: { checkVendorGate: gate() } });
      await gotoTab('gate');
      fireEvent.click(screen.getByTestId('gate-run'));
      expect((await screen.findByTestId('gate-error')).textContent).toBe(word('vnd.gate.error.text'));
    });

    it('names the rule of the gate with its "i" and the unverified flag', async () => {
      open();
      await gotoTab('gate');
      expect(within(screen.getByTestId('gate-rule')).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.gate.figure.name') }) })).toBeTruthy();
    });
  });
});
