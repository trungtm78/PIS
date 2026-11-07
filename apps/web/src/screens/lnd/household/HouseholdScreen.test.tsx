import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { DPO, HOUSEHOLD_OFFICER, HOUSEHOLD_READER, PROJECT, UNIT_TTQD, UNIT_XA, client, household, mount, parcel, routeOf, world } from '../test-support';
import HouseholdScreen from './HouseholdScreen';

const ROUTE = routeOf('LND-03', 'FR-LND-03');
const OK = { operation_id: 'o', status: 'REGISTERED', resource_version: 1, resource_id: household(1).id };
const PATH = `/lnd/lnd-03?project=${PROJECT}`;
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () =>
  world({
    households: [
      household(1, { parcels: [{ id: 'link-1', parcel_id: parcel(1).id, parcel_code: 'TB-1/10', right_kind: 'OWNER', share_pct: '60.0000' }] }),
      household(2, { head_name_masked: 'T*** T** B', national_id_masked: '************', phone_masked: '************', address_masked: null, status: 'DISPUTED', dsr_open: true, legal_basis: 'CONSENT' }),
      household(3, { national_id_masked: null, phone_masked: null, status: 'CLOSED', legal_basis: 'LEGAL_OBLIGATION' }),
      household(4, { processing_restricted: true }),
      household(5, { anonymised: true, head_name_masked: '[erased]', national_id_masked: null, phone_masked: null, address_masked: null }),
    ],
    parcels: [parcel(1), parcel(2, { owner_unit_id: UNIT_TTQD, owner_unit_name: 'Trung tâm phát triển quỹ đất' })],
  });
/** The code of the household is marked in its cell; the row is the table row around it. */
const rowOf = (n: number): HTMLElement => (document.querySelector(`[data-household-id="${household(n).id}"]`) as HTMLElement).closest('tr') as HTMLElement;
const ready = () => screen.findByTestId('households');
const REASON = 'Checking the record before the payment';
const IDENTITY = { id: household(1).id, project_id: PROJECT, owner_unit_id: UNIT_XA, household_code: 'HH-000001', head_name: 'Nguyễn Văn Anh', national_id: '079000000001', phone: '0912345678', address_text: '12 Lê Lợi, Quận 1' };

describe('HouseholdScreen (LND-03): the households affected by a land recovery', () => {
  it('UI-LND-03: asks for a project first and lists the households of the one chosen', async () => {
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_OFFICER, path: '/lnd/lnd-03' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.households.project.notice']);
    expect(screen.queryByTestId('households')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['lnd.households.register.action'] })).toBeNull();
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(Array.from(document.querySelectorAll('[data-household-id]'))).toHaveLength(5);
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('AC-ST-LND-002-1, UI-LND-03: shows the code, the masked name and identity number, the parcels, the basis for the data and the status', async () => {
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['lnd.households.page.title']);
    expect(screen.getByTestId('privacy-note').textContent).toBe(vi_['lnd.households.privacy.note']);
    const headers = Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent);
    expect(headers).toEqual([
      vi_['lnd.households.column.code'],
      vi_['lnd.households.column.head'],
      vi_['lnd.households.column.nationalId'],
      vi_['lnd.households.column.parcels'],
      vi_['lnd.households.column.basis'],
      vi_['lnd.households.column.status'],
      vi_['lnd.households.column.action'],
    ]);
    const first = rowOf(1);
    expect(first.querySelector('td')?.textContent).toBe('HH-000001');
    expect(within(first).getByTestId('head').textContent).toBe('N***** V** A');
    expect(within(first).getByTestId('national-id').textContent).toBe('********0001');
    expect(within(first).getByTestId('parcels').textContent).toBe(vi_['lnd.households.parcels.line'].replace('{code}', 'TB-1/10').replace('{right}', vi_['lnd.rightKind.owner.label']).replace('{share}', '60.0000'));
    expect(within(first).getByTestId('basis').textContent).toBe(vi_['lnd.legalBasis.publicTask.label']);
    expect(within(first).getByTestId('retention').textContent).toBe(vi_['lnd.households.retention.line'].replace('{until}', '2036-12-31'));
    expect(within(first).getByTestId('status').textContent).toBe(vi_['lnd.householdStatus.registered.label']);
    expect(within(first).queryByTestId('dsr-open')).toBeNull();
    // A household the caller may not open shows its identity number hidden whole, and one that has none says so.
    expect(within(rowOf(2)).getByTestId('national-id').textContent).toBe('************');
    expect(within(rowOf(2)).getByTestId('dsr-open').textContent).toBe(vi_['lnd.households.dsr.open']);
    expect(within(rowOf(2)).getByTestId('basis').textContent).toBe(vi_['lnd.legalBasis.consent.label']);
    expect(within(rowOf(3)).getByTestId('national-id').textContent).toBe(vi_['lnd.households.nationalId.none']);
    expect(within(rowOf(3)).getByTestId('parcels').textContent).toBe(vi_['lnd.households.parcels.none']);
    expect(within(rowOf(3)).getByTestId('basis').textContent).toBe(vi_['lnd.legalBasis.legalObligation.label']);
    expect(document.body.textContent).not.toContain('Nguyễn');
  });

  it('filters by a word and by status, and says when nothing matches', async () => {
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.query.label']), { target: { value: 'hh-000002' } });
    expect(Array.from(document.querySelectorAll('[data-household-id]')).map((tr) => tr.getAttribute('data-household-id'))).toEqual([household(2).id]);
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.query.label']), { target: { value: 'quận 1' } });
    expect(Array.from(document.querySelectorAll('[data-household-id]'))).toHaveLength(3);
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.query.label']), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.status.label']), { target: { value: 'CLOSED' } });
    expect(Array.from(document.querySelectorAll('[data-household-id]')).map((tr) => tr.getAttribute('data-household-id'))).toEqual([household(3).id]);
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.status.label']), { target: { value: 'RESETTLED' } });
    expect(screen.getByTestId('no-match').textContent).toBe(vi_['lnd.households.noMatch.notice']);
  });

  it('says so when the project has no household yet, and when the read fails it offers a retry', async () => {
    mount(<HouseholdScreen route={ROUTE} />, client(world()), { permissions: HOUSEHOLD_OFFICER, path: PATH });
    expect((await screen.findByTestId('no-match')).textContent).toBe(vi_['lnd.households.empty.notice']);
    cleanup();
    const broken = worldOf();
    broken.failing.add('listAffectedHouseholds');
    mount(<HouseholdScreen route={ROUTE} />, client(broken), { permissions: HOUSEHOLD_OFFICER, path: PATH });
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
  });

  it('AC-ST-LND-003-1, UI-LND-03: says that the processing of a household is restricted or its data erased, and opens neither', async () => {
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    expect(within(rowOf(4)).getByTestId('restricted').textContent).toBe(vi_['lnd.households.restricted.badge']);
    expect(within(rowOf(5)).getByTestId('anonymised').textContent).toBe(vi_['lnd.households.anonymised.badge']);
    for (const n of [4, 5]) expect(within(rowOf(n)).queryByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-00000' + n) })).toBeNull();
    expect(within(rowOf(1)).queryByTestId('restricted')).toBeNull();
    expect(within(rowOf(1)).queryByTestId('anonymised')).toBeNull();
    expect(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-000001') })).toBeTruthy();
  });

  it('UI-LND-03: offers the handling of a request to whoever holds land.dsr.handle, to the page of the household', async () => {
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, path: PATH });
    await ready();
    const link = within(rowOf(1)).getByRole('link', { name: vi_['lnd.households.request.aria'].replace('{code}', 'HH-000001') });
    expect(link.getAttribute('href')).toBe('/lnd/lnd-13?project=' + PROJECT + '&household=' + household(1).id);
    cleanup();
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    expect(within(rowOf(1)).queryByRole('link')).toBeNull();
    cleanup();
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, mode: 'READ_ONLY', path: PATH });
    await ready();
    expect(within(rowOf(1)).queryByRole('link')).toBeNull();
  });

  it('shows a reader the households and no button that changes or opens them; a read-only session cannot register or link but may open', async () => {
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_READER, path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.households.register.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button')).toBeNull();
    cleanup();
    mount(<HouseholdScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_OFFICER, mode: 'READ_ONLY', path: PATH });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['lnd.households.register.action'] })).toBeNull();
    expect(within(rowOf(1)).queryByRole('button', { name: vi_['lnd.households.link.aria'].replace('{code}', 'HH-000001') })).toBeNull();
    expect(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-000001') })).toBeTruthy();
  });

  it('AC-ST-LND-002-2: registers a household on a legal basis with its retention, sending the numbers without their spaces', async () => {
    const h = client(worldOf(), () => OK);
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.households.register.action'] }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('register-note').textContent).toBe(vi_['lnd.households.registerDialog.note.text']);
    await within(dialog).findByRole('option', { name: 'Trung tâm phát triển quỹ đất' });
    // Nothing is sent until the form is right, and the fields that are wrong say why.
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(within(dialog).getAllByRole('alert').length).toBeGreaterThanOrEqual(4);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.unit.label']), { target: { value: UNIT_XA } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.head.label']), { target: { value: ' Nguyễn Văn Anh ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.nationalId.label']), { target: { value: '079 000 000 001' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.phone.label']), { target: { value: '+84 912 345 678' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.address.label']), { target: { value: '12 Lê Lợi, Quận 1' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.members.label']), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.policy.label']));
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.basis.label']), { target: { value: 'CONSENT' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.basisRef.label']), { target: { value: ' Luật BVDLCN 91/2025, Điều 11 ' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.consent.label']), { target: { value: '00000000-0000-4000-8000-000000000001' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.retention.label']), { target: { value: '2036-12-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'registerAffectedHousehold',
      expect.objectContaining({
        body: {
          project_id: PROJECT,
          owner_unit_id: UNIT_XA,
          head_name: 'Nguyễn Văn Anh',
          legal_basis: 'CONSENT',
          legal_basis_ref: 'Luật BVDLCN 91/2025, Điều 11',
          retention_until: '2036-12-31',
          national_id: '079000000001',
          phone: '0912345678',
          address_text: '12 Lê Lợi, Quận 1',
          member_count: 4,
          policy_beneficiary: true,
          consent_record_id: '00000000-0000-4000-8000-000000000001',
        },
      }),
    );
  });

  it('asks for the record of the consent only when the basis is consent, and sends only what was filled in', async () => {
    const h = client(worldOf(), () => OK);
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.households.register.action'] }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'UBND xã An Phú' });
    expect(within(dialog).queryByLabelText(vi_['lnd.households.registerDialog.consent.label'])).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.unit.label']), { target: { value: UNIT_XA } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.head.label']), { target: { value: 'Trần Thị B' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.basis.label']), { target: { value: 'PUBLIC_TASK_LAND_LAW' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.basisRef.label']), { target: { value: 'Luật Đất đai 2024' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.retention.label']), { target: { value: '2036-12-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'registerAffectedHousehold',
      expect.objectContaining({
        body: { project_id: PROJECT, owner_unit_id: UNIT_XA, head_name: 'Trần Thị B', legal_basis: 'PUBLIC_TASK_LAND_LAW', legal_basis_ref: 'Luật Đất đai 2024', retention_until: '2036-12-31' },
      }),
    );
  });

  it('says why the server refused a registration and keeps the dialog open', async () => {
    const h = client(worldOf(), () => problem('HOUSEHOLD_DUPLICATE', 409));
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.households.register.action'] }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('option', { name: 'UBND xã An Phú' });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.unit.label']), { target: { value: UNIT_XA } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.head.label']), { target: { value: 'Trần Thị B' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.basis.label']), { target: { value: 'LEGAL_OBLIGATION' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.basisRef.label']), { target: { value: 'Luật Đất đai 2024' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.registerDialog.retention.label']), { target: { value: '2036-12-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_['lnd.households.problem.duplicate.error']);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('UI-LND-03: links a household to a parcel of its own unit only, with the right and the share', async () => {
    const h = client(worldOf(), () => ({ ...OK, status: 'LINKED' }));
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.link.aria'].replace('{code}', 'HH-000001') }));
    const dialog = screen.getByRole('dialog');
    const offered = within(dialog).getAllByRole('option').map((option) => option.textContent);
    expect(offered).toContain('TB-1/10');
    expect(offered).not.toContain('TB-2/10');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.linkDialog.parcel.label']), { target: { value: parcel(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.linkDialog.right.label']), { target: { value: 'LESSEE' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.linkDialog.share.label']), { target: { value: '40.5' } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.linkDialog.title.label']), { target: { value: '00000000-0000-4000-8000-000000000004' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith(
      'linkHouseholdParcel',
      expect.objectContaining({ path: { id: household(1).id }, body: { parcel_id: parcel(1).id, right_kind: 'LESSEE', share_pct: '40.5', title_document_version_id: '00000000-0000-4000-8000-000000000004' } }),
    );
  });

  it('says that the shares of the parcel would come to more than the whole', async () => {
    const h = client(worldOf(), () => problem('SHARE_EXCEEDS_100'));
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.link.aria'].replace('{code}', 'HH-000001') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.linkDialog.parcel.label']), { target: { value: parcel(1).id } });
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.linkDialog.right.label']), { target: { value: 'OWNER' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
    expect((await within(dialog).findByTestId('refusal')).textContent).toBe(vi_['lnd.households.problem.share.error']);
  });

  it('AC-ST-LND-002-1, UI-LND-03: opens the personal data only when asked, says that it is recorded, and keeps it in the dialog alone', async () => {
    const h = client(worldOf(), () => ({}), (operation) => (operation === 'revealHouseholdIdentity' ? IDENTITY : new Error('unexpected read')));
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-000001') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('reveal-note').textContent).toBe(vi_['lnd.households.revealDialog.note.text']);
    expect(h.read).not.toHaveBeenCalled();
    expect(within(dialog).queryByTestId('identity')).toBeNull();
    // The reading wants the reason first; nothing is read without it.
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.households.revealDialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.revealDialog.reason.label']), { target: { value: 'too short' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.households.revealDialog.submit.action'] }));
    expect(within(dialog).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(vi_['lnd.households.revealDialog.reason.label']), { target: { value: `  ${REASON}  ` } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.households.revealDialog.submit.action'] }));
    expect((await within(dialog).findByTestId('identity-head')).textContent).toBe('Nguyễn Văn Anh');
    expect(within(dialog).getByTestId('identity-national-id').textContent).toBe('079000000001');
    expect(within(dialog).getByTestId('identity-phone').textContent).toBe('0912345678');
    expect(within(dialog).getByTestId('identity-address').textContent).toBe('12 Lê Lợi, Quận 1');
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith('revealHouseholdIdentity', { path: { id: household(1).id }, query: { reason: REASON } });
    // The list behind the dialog is as masked as before, and closing the dialog takes the data with it.
    expect(within(rowOf(1)).getByTestId('national-id').textContent).toBe('********0001');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['lnd.dialog.cancel.action'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain('Nguyễn Văn Anh');
    expect(document.body.textContent).not.toContain('079000000001');
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-000001') }));
    expect(within(screen.getByRole('dialog')).queryByTestId('identity')).toBeNull();
  });

  it('shows the fields that a household does not hold as not given, and tells a refusal of the reading in words', async () => {
    const sparse = { ...IDENTITY, national_id: null, phone: null, address_text: null };
    const h = client(worldOf(), () => ({}), () => sparse);
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-000001') }));
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.revealDialog.reason.label']), { target: { value: REASON } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['lnd.households.revealDialog.submit.action'] }));
    expect((await screen.findByTestId('identity-national-id')).textContent).toBe(vi_['lnd.households.revealDialog.none.text']);
    expect(screen.getByTestId('identity-phone').textContent).toBe(vi_['lnd.households.revealDialog.none.text']);
    expect(screen.getByTestId('identity-address').textContent).toBe(vi_['lnd.households.revealDialog.none.text']);
    cleanup();
    const refused = client(worldOf(), () => ({}), () => problem('SCOPE_DENIED', 403));
    mount(<HouseholdScreen route={ROUTE} />, refused, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-000001') }));
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.revealDialog.reason.label']), { target: { value: REASON } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['lnd.households.revealDialog.submit.action'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.denied.error']);
    expect(screen.queryByTestId('identity')).toBeNull();
  });

  it('does not take an answer it cannot understand for the personal data of a household', async () => {
    const h = client(worldOf(), () => ({}), () => ({ unexpected: true }));
    mount(<HouseholdScreen route={ROUTE} />, h, { permissions: HOUSEHOLD_OFFICER, path: PATH });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['lnd.households.reveal.aria'].replace('{code}', 'HH-000001') }));
    fireEvent.change(screen.getByLabelText(vi_['lnd.households.revealDialog.reason.label']), { target: { value: REASON } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: vi_['lnd.households.revealDialog.submit.action'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['lnd.problem.general.error']);
    expect(screen.queryByTestId('identity')).toBeNull();
  });
});
