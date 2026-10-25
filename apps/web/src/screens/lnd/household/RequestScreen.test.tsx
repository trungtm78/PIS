import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { DPO, HOUSEHOLD_READER, PROJECT, client, household, mount, routeOf, world } from '../test-support';
import RequestScreen from './RequestScreen';

const ROUTE = routeOf('LND-13', 'FR-LND-13');
const OK = { operation_id: 'o', status: 'PARTIAL', resource_version: 2, resource_id: household(1).id };
const PATH = `/lnd/lnd-13?project=${PROJECT}&household=${household(1).id}`;
const REASON = 'The voucher of the payment names the head of the household';
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const worldOf = () => world({ households: [household(1), household(2, { processing_restricted: true, anonymised: true, status: 'DISPUTED', legal_basis: 'CONSENT' })] });
const fill = (kind: string, outcome: string, options: { verified?: boolean; reason?: string } = {}): void => {
  fireEvent.change(screen.getByLabelText(vi_['lnd.dataRequest.form.kind.label']), { target: { value: kind } });
  if (options.verified !== false) fireEvent.click(screen.getByLabelText(vi_['lnd.dataRequest.form.verified.label']));
  fireEvent.change(screen.getByLabelText(vi_['lnd.dataRequest.form.outcome.label']), { target: { value: outcome } });
  fireEvent.change(screen.getByLabelText(vi_['lnd.dataRequest.form.reason.label']), { target: { value: options.reason ?? REASON } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['lnd.dataRequest.form.submit.action'] }));
};

describe('RequestScreen (LND-13): the requests of the people whose data a household holds', () => {
  it('UI-LND-13: asks for a household first and points back to the list', async () => {
    mount(<RequestScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, path: '/lnd/lnd-13' });
    expect((await screen.findByTestId('choose-household')).textContent).toContain(vi_['lnd.dataRequest.none.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['lnd.dataRequest.page.title']);
    expect(screen.getByTestId('privacy-note').textContent).toBe(vi_['lnd.dataRequest.privacy.note']);
    expect(screen.queryByTestId('household')).toBeNull();
    expect(screen.getByRole('link', { name: new RegExp(vi_['lnd.dataRequest.back.list']) }).getAttribute('href')).toBe('/lnd/lnd-03');
  });

  it('UI-LND-13: shows the household masked, with the basis, the retention and the status', async () => {
    mount(<RequestScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, path: PATH });
    expect((await screen.findByTestId('household-code')).textContent).toBe('HH-000001');
    expect(screen.getByTestId('household-head').textContent).toBe('N***** V** A');
    expect(screen.getByTestId('household-basis').textContent).toBe(vi_['lnd.legalBasis.publicTask.label']);
    expect(screen.getByTestId('household-retention').textContent).toBe('2036-12-31');
    expect(screen.getByTestId('household-status').textContent).toBe(vi_['lnd.householdStatus.registered.label']);
    expect(screen.queryByTestId('household-restricted')).toBeNull();
    expect(screen.queryByTestId('household-anonymised')).toBeNull();
    expect(screen.getByRole('link', { name: new RegExp(vi_['lnd.dataRequest.back.list']) }).getAttribute('href')).toBe(`/lnd/lnd-03?project=${PROJECT}`);
  });

  it('says that the processing is restricted and that the data was erased', async () => {
    mount(<RequestScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, path: `/lnd/lnd-13?project=${PROJECT}&household=${household(2).id}` });
    expect((await screen.findByTestId('household-restricted')).textContent).toBe(vi_['lnd.households.restricted.badge']);
    expect(screen.getByTestId('household-anonymised').textContent).toBe(vi_['lnd.households.anonymised.badge']);
  });

  it('says what each kind of request does before it is sent', async () => {
    mount(<RequestScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, path: PATH });
    await screen.findByTestId('household');
    const select = screen.getByLabelText(vi_['lnd.dataRequest.form.kind.label']);
    for (const [kind, key] of [
      ['ACCESS', 'lnd.requestKind.access.help'],
      ['RECTIFY', 'lnd.requestKind.rectify.help'],
      ['WITHDRAW_CONSENT', 'lnd.requestKind.withdrawConsent.help'],
      ['ERASE', 'lnd.requestKind.erase.help'],
      ['RESTRICT', 'lnd.requestKind.restrict.help'],
    ] as const) {
      fireEvent.change(select, { target: { value: kind } });
      expect(screen.getByText(vi_[key])).toBeTruthy();
    }
  });

  it('AC-ST-LND-003-1, UAT-AC381, UI-LND-13: sends nothing until the kind, the person identified, the outcome and the reason are given', async () => {
    const h = client(worldOf(), () => OK);
    mount(<RequestScreen route={ROUTE} />, h, { permissions: DPO, path: PATH });
    await screen.findByTestId('household');
    submit();
    expect(screen.getAllByRole('alert').length).toBe(4);
    fill('ERASE', 'PARTIAL', { verified: false });
    submit();
    expect(screen.getByText(vi_['lnd.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['lnd.dataRequest.form.reason.label']), { target: { value: 'x'.repeat(2001) } });
    submit();
    expect(screen.getByText(vi_['lnd.field.tooLong.error'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(vi_['lnd.dataRequest.form.reason.label']), { target: { value: 'a\u0007b' } });
    submit();
    expect(screen.getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-LND-003-1, UAT-AC381, UI-LND-13: records the outcome with the reason, says so, and starts the form over', async () => {
    const h = client(worldOf(), () => OK);
    mount(<RequestScreen route={ROUTE} />, h, { permissions: DPO, path: PATH });
    await screen.findByTestId('household');
    fill('ERASE', 'PARTIAL', { reason: `  ${REASON}  ` });
    submit();
    expect((await screen.findByTestId('handled')).textContent).toBe(
      vi_['lnd.dataRequest.handled.text'].replace('{kind}', vi_['lnd.requestKind.erase.label']).replace('{outcome}', vi_['lnd.requestOutcome.partial.label']),
    );
    expect(h.command).toHaveBeenCalledWith(
      'handleHouseholdDataRequest',
      expect.objectContaining({ path: { id: household(1).id }, body: { request_kind: 'ERASE', requester_verified: true, outcome: 'PARTIAL', reason: REASON } }),
    );
    await waitFor(() => expect((screen.getByLabelText(vi_['lnd.dataRequest.form.reason.label']) as HTMLInputElement).value).toBe(''));
    expect((screen.getByLabelText(vi_['lnd.dataRequest.form.verified.label']) as HTMLInputElement).checked).toBe(false);
  });

  it('AC-ST-LND-003-1, UAT-AC381: says that an erasure is held back by the vouchers that must be kept, and keeps what was typed', async () => {
    const h = client(worldOf(), () => problem('RETENTION_LEGAL_HOLD'));
    mount(<RequestScreen route={ROUTE} />, h, { permissions: DPO, path: PATH });
    await screen.findByTestId('household');
    fill('ERASE', 'FULFILLED');
    submit();
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['lnd.dataRequest.problem.retention.error']);
    expect((screen.getByLabelText(vi_['lnd.dataRequest.form.reason.label']) as HTMLInputElement).value).toBe(REASON);
    expect(screen.queryByTestId('handled')).toBeNull();
  });

  it('says that the person has to be identified when the server says so', async () => {
    const h = client(worldOf(), () => problem('REQUESTER_NOT_VERIFIED', 422));
    mount(<RequestScreen route={ROUTE} />, h, { permissions: DPO, path: PATH });
    await screen.findByTestId('household');
    fill('ACCESS', 'FULFILLED');
    submit();
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['lnd.dataRequest.problem.requester.error']);
  });

  it('shows a reader the household and no form; a read-only session too', async () => {
    mount(<RequestScreen route={ROUTE} />, client(worldOf()), { permissions: HOUSEHOLD_READER, path: PATH });
    expect((await screen.findByTestId('request-denied')).textContent).toBe(vi_['lnd.dataRequest.denied.notice']);
    expect(screen.queryByRole('button', { name: vi_['lnd.dataRequest.form.submit.action'] })).toBeNull();
    cleanup();
    mount(<RequestScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, mode: 'READ_ONLY', path: PATH });
    expect(await screen.findByTestId('request-denied')).toBeTruthy();
  });

  it('says so when the household is not in the list, and when the read fails offers a retry', async () => {
    mount(<RequestScreen route={ROUTE} />, client(worldOf()), { permissions: DPO, path: `/lnd/lnd-13?project=${PROJECT}&household=00000000-0000-4000-8000-00000000ffff` });
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByTestId('household')).toBeNull();
    cleanup();
    const broken = worldOf();
    broken.failing.add('listAffectedHouseholds');
    mount(<RequestScreen route={ROUTE} />, client(broken), { permissions: DPO, path: PATH });
    expect(await screen.findByRole('button', { name: /thử lại|retry/i })).toBeTruthy();
  });
});
