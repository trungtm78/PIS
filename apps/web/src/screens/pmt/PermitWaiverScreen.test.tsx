import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PermitWaiverScreen from './PermitWaiverScreen';
import { DOCUMENT, client, mount, projectId, projectRow, waiverLine, world } from './dossier-test-support';
import type { World } from './dossier-test-support';
import { permitType, routeOf } from './test-support';

const ROUTE = routeOf('PMT-06', 'FR-PMT-06');
const LEADER = ['permit.gate.waive', 'permit.read'];
const READER = ['permit.read'];
const REASON = 'Cơ quan có thẩm quyền cho phép khởi công trước';
const answer = { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'r' };
const problem = (status: number, code: string, detail?: string, extensions: Record<string, unknown> = {}) =>
  new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions });

beforeEach(() => {
  // The screen judges the days by the Vietnam date of now: pin it (only the clock, so the timers of the test library keep running).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T05:00:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function state(overrides: Partial<World> = {}): World {
  return world({
    projects: [projectRow(1), projectRow(2)],
    types: [permitType(1), permitType(2)],
    waivers: [
      waiverLine(1),
      waiverLine(2, { gate_code: 'HANDOVER', valid_until: '2026-10-24', status: 'ACTIVE' }),
      waiverLine(3, { valid_until: '2026-10-10', status: 'EXPIRED' }),
      waiverLine(4, { status: 'REVOKED', revoked_on: '2026-10-22', revoked_reason: 'Giấy phép đã có' }),
    ],
    ...overrides,
  });
}

const rows = () => within(screen.getByTestId('waivers')).getAllByRole('row').slice(1);
const rowOf = (n: number): HTMLElement => document.querySelector(`[data-waiver-id="${waiverLine(n).id}"]`) as HTMLElement;
/** The form once the projects and the permit types it offers have been read: a choice can only be made among options that are there. */
async function form(): Promise<HTMLElement> {
  const found = await screen.findByRole('form', { name: vi_['pmt.waiver.form.aria'] });
  await within(found).findByRole('option', { name: /DA-2026-001/ });
  await within(found).findByRole('option', { name: /PERMIT_1/ });
  return found;
}
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const send = () => userEvent.click(screen.getByRole('button', { name: vi_['pmt.waiver.form.save.action'] }));
const fillForm = (): void => {
  set(vi_['pmt.waiver.form.project.label'], projectId(1));
  set(vi_['pmt.waiver.form.gate.label'], 'HANDOVER');
  set(vi_['pmt.waiver.form.type.label'], permitType(1).id);
  set(vi_['pmt.waiver.form.reason.label'], ` ${REASON} `);
  set(vi_['pmt.waiver.form.document.label'], DOCUMENT.toUpperCase());
  set(vi_['pmt.waiver.form.until.label'], '2026-11-20');
};

describe('PermitWaiverScreen (PMT-06): the waivers of the permit gates', () => {
  it('lists the waivers with the project, the gate, the permit type, the reason, the last day with the days left and the state in words (UI-PMT-06)', async () => {
    mount(<PermitWaiverScreen route={ROUTE} />, client(state()), { permissions: READER });
    await screen.findByTestId('waivers');
    expect(rows().filter((row) => row.hasAttribute('data-waiver-id'))).toHaveLength(4);
    const first = within(rowOf(1));
    expect(first.getByText('DA-2026-001')).toBeTruthy();
    expect(first.getByText(vi_['pmt.gate.code.startConstruction.label'])).toBeTruthy();
    expect(first.getByText('PERMIT_1')).toBeTruthy();
    expect(first.getByText('Giấy phép 1')).toBeTruthy();
    expect(first.getByText(`${REASON} 1`)).toBeTruthy();
    expect(first.getByText('2026-11-20')).toBeTruthy();
    expect(first.getByTestId('days-left').textContent).toBe('còn 27 ngày');
    expect(first.getByText(vi_['pmt.waiver.phase.inForce.label'])).toBeTruthy();
    expect(rowOf(1).getAttribute('data-phase')).toBe('inForce');
    // The last day counts: a waiver that ends today is told in words.
    expect(within(rowOf(2)).getByTestId('days-left').textContent).toBe(vi_['pmt.waiver.left.today.text']);
    expect(rowOf(3).getAttribute('data-phase')).toBe('lapsed');
    expect(within(rowOf(3)).queryByTestId('days-left')).toBeNull();
    expect(within(rowOf(3)).getByText(vi_['pmt.waiver.status.expired.label'])).toBeTruthy();
    expect(rowOf(4).getAttribute('data-phase')).toBe('revoked');
    expect(within(rowOf(4)).getByText('Thu hồi ngày 2026-10-22: Giấy phép đã có')).toBeTruthy();
    expect(document.querySelector('[data-screen-id="PMT-06"]')).toBeTruthy();
    expect(screen.getByText(vi_['pmt.waiver.page.exemption.text'], { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['pmt.waiver.page.exemption.link'] }).getAttribute('href')).toBe('/pmt/pmt-01');
  });

  it('gives a reader the waivers and neither the form nor a way to revoke (UI-PMT-06)', async () => {
    mount(<PermitWaiverScreen route={ROUTE} />, client(state()), { permissions: READER });
    await screen.findByTestId('waivers');
    expect(screen.queryByRole('form', { name: vi_['pmt.waiver.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['pmt.waiver.revoke.action'] })).toBeNull();
    expect(screen.getByText(vi_['pmt.waiver.readonly.text'])).toBeTruthy();
  });

  it('is read-only in a read-only session, whatever the permissions', async () => {
    mount(<PermitWaiverScreen route={ROUTE} />, client(state()), { permissions: LEADER, mode: 'READ_ONLY' });
    await screen.findByTestId('waivers');
    expect(screen.queryByRole('form', { name: vi_['pmt.waiver.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['pmt.waiver.revoke.action'] })).toBeNull();
  });

  it('filters the waivers by state, and says in words when none is left', async () => {
    mount(<PermitWaiverScreen route={ROUTE} />, client(state()), { permissions: READER });
    await screen.findByTestId('waivers');
    fireEvent.change(screen.getByLabelText(vi_['pmt.waiver.filters.status.label']), { target: { value: 'REVOKED' } });
    expect(rows().filter((row) => row.hasAttribute('data-waiver-id'))).toHaveLength(1);
    expect(rowOf(4)).toBeTruthy();
    cleanup();
    mount(<PermitWaiverScreen route={ROUTE} />, client(state({ waivers: [waiverLine(1)] })), { permissions: READER });
    await screen.findByTestId('waivers');
    fireEvent.change(screen.getByLabelText(vi_['pmt.waiver.filters.status.label']), { target: { value: 'EXPIRED' } });
    expect(screen.getByTestId('empty-waivers').textContent).toBe(vi_['pmt.waiver.empty.text']);
  });

  it('shows the form even when there is no waiver yet, and the error and loading states of the read', async () => {
    mount(<PermitWaiverScreen route={ROUTE} />, client(state({ waivers: [] })), { permissions: LEADER });
    expect(await form()).toBeTruthy();
    expect(screen.getByTestId('empty-waivers')).toBeTruthy();
    cleanup();
    mount(<PermitWaiverScreen route={ROUTE} />, client(state({ failing: new Set(['get_resources_permit_gate_waiver']) })), { permissions: LEADER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });

  describe('the form', () => {
    it('names every empty field and sends nothing (UI-PMT-06)', async () => {
      const h = client(state(), () => answer);
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await form();
      await send();
      expect(screen.getAllByText(vi_['pmt.waiver.field.required.error']).length).toBeGreaterThanOrEqual(5);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('refuses a last day beyond the longest before sending, and says the last day that is allowed (AC-ST-PMT-005-1)', async () => {
      const h = client(state(), () => answer);
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await form();
      fillForm();
      set(vi_['pmt.waiver.form.until.label'], '2027-01-22');
      await send();
      expect(await screen.findByText('Miễn trừ tối đa 90 ngày, tức đến hết 2027-01-21.', { selector: '.field-error' })).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      const input = screen.getByLabelText(vi_['pmt.waiver.form.until.label']) as HTMLInputElement;
      expect([input.min, input.max]).toEqual(['2026-10-24', '2027-01-21']);
    });

    it('sends the allowlisted body, trimmed, and tells the waiver is granted (UI-PMT-06)', async () => {
      const h = client(state(), () => answer);
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await form();
      fillForm();
      await send();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('grantPermitGateWaiver');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: { project_id: projectId(1), gate_code: 'HANDOVER', permit_type_id: permitType(1).id, reason: REASON, decision_document_version_id: DOCUMENT, valid_until: '2026-11-20' },
      });
      expect((await screen.findByTestId('granted')).textContent).toBe(vi_['pmt.waiver.form.granted.notice']);
      // The form starts over for the next waiver and keeps the gate.
      expect((screen.getByLabelText(vi_['pmt.waiver.form.reason.label']) as HTMLTextAreaElement).value).toBe('');
      expect((screen.getByLabelText(vi_['pmt.waiver.form.gate.label']) as HTMLSelectElement).value).toBe('HANDOVER');
    });

    it.each([
      ['WAIVER_TOO_LONG', 422, 'valid_until', { max_days: 90, requested_days: 120, latest_day: '2027-01-21' }, 'Miễn trừ dài hơn tối đa 90 ngày; ngày cuối cùng được chọn là 2027-01-21. Chưa cấp miễn trừ.'],
      ['SELF_APPROVAL_DENIED', 403, undefined, {}, vi_['pmt.waiver.problem.selfApproval.error']],
      ['DECISION_DOCUMENT_REQUIRED', 422, 'decision_document_version_id', {}, vi_['pmt.waiver.problem.documentRequired.error']],
      ['WAIVER_STATE_INVALID', 409, 'status', {}, vi_['pmt.waiver.problem.stateInvalid.error']],
      ['RESOURCE_NOT_FOUND', 404, undefined, {}, vi_['pmt.waiver.problem.notFound.error']],
      ['SCOPE_DENIED', 403, undefined, {}, vi_['pmt.waiver.problem.denied.error']],
    ] as const)('says in words why the server refused the waiver with %s', async (code, status, detail, extensions, sentence) => {
      const h = client(state(), () => {
        throw problem(status, code, detail, extensions);
      });
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await form();
      fillForm();
      await send();
      const refusal = await screen.findByTestId('problem');
      expect(refusal.textContent).toBe(sentence);
      expect(screen.queryByTestId('granted')).toBeNull();
    });

    it('points at the field the server found wrong, and the general sentence for anything else', async () => {
      let failure: unknown = problem(422, 'VALIDATION_FAILED', 'reason');
      const h = client(state(), () => {
        throw failure;
      });
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await form();
      fillForm();
      await send();
      await waitFor(() => expect(screen.getByText(vi_['pmt.waiver.field.rejected.error'])).toBeTruthy());
      expect(screen.queryByTestId('problem')).toBeNull();
      failure = problem(422, 'VALIDATION_FAILED');
      set(vi_['pmt.waiver.form.reason.label'], `${REASON} hơn`);
      await send();
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['pmt.waiver.problem.validation.error']));
      failure = new Error('offline');
      set(vi_['pmt.waiver.form.reason.label'], `${REASON} nữa`);
      await send();
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['pmt.waiver.problem.general.error']));
    });
  });

  describe('the revocation', () => {
    it('offers it for a waiver in force only, asks for the words, and sends them (UI-PMT-06)', async () => {
      const h = client(state(), () => ({ ...answer, status: 'REVOKED', resource_version: 2 }));
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await screen.findByTestId('waivers');
      expect(within(rowOf(1)).getByRole('button', { name: vi_['pmt.waiver.revoke.action'] })).toBeTruthy();
      expect(within(rowOf(2)).getByRole('button', { name: vi_['pmt.waiver.revoke.action'] })).toBeTruthy();
      expect(within(rowOf(3)).queryByRole('button', { name: vi_['pmt.waiver.revoke.action'] })).toBeNull();
      expect(within(rowOf(4)).queryByRole('button', { name: vi_['pmt.waiver.revoke.action'] })).toBeNull();
      await userEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['pmt.waiver.revoke.action'] }));
      const revoke = await screen.findByRole('form', { name: 'Thu hồi miễn trừ PERMIT_1' });
      await userEvent.click(within(revoke).getByRole('button', { name: vi_['pmt.waiver.revoke.confirm'] }));
      expect(within(revoke).getByText(vi_['pmt.waiver.field.required.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(revoke).getByLabelText(vi_['pmt.waiver.revoke.reason.label']), { target: { value: '  Giấy phép đã có  ' } });
      await userEvent.click(within(revoke).getByRole('button', { name: vi_['pmt.waiver.revoke.confirm'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('revokePermitGateWaiver');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: waiverLine(1).id }, body: { reason: 'Giấy phép đã có' } });
      await waitFor(() => expect(screen.queryByRole('form', { name: 'Thu hồi miễn trừ PERMIT_1' })).toBeNull());
    });

    it('refuses a reason that is too long before sending, and can be dropped', async () => {
      const h = client(state(), () => answer);
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await screen.findByTestId('waivers');
      await userEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['pmt.waiver.revoke.action'] }));
      const revoke = await screen.findByRole('form', { name: 'Thu hồi miễn trừ PERMIT_1' });
      fireEvent.change(within(revoke).getByLabelText(vi_['pmt.waiver.revoke.reason.label']), { target: { value: 'x'.repeat(2001) } });
      await userEvent.click(within(revoke).getByRole('button', { name: vi_['pmt.waiver.revoke.confirm'] }));
      expect(within(revoke).getByText(vi_['pmt.waiver.field.tooLong.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await userEvent.click(within(revoke).getByRole('button', { name: vi_['pmt.waiver.revoke.cancel'] }));
      expect(screen.queryByRole('form', { name: 'Thu hồi miễn trừ PERMIT_1' })).toBeNull();
    });

    it('says why the server refused the revocation', async () => {
      const h = client(state(), () => {
        throw problem(409, 'WAIVER_STATE_INVALID', 'status');
      });
      mount(<PermitWaiverScreen route={ROUTE} />, h, { permissions: LEADER });
      await screen.findByTestId('waivers');
      await userEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['pmt.waiver.revoke.action'] }));
      const revoke = await screen.findByRole('form', { name: 'Thu hồi miễn trừ PERMIT_1' });
      fireEvent.change(within(revoke).getByLabelText(vi_['pmt.waiver.revoke.reason.label']), { target: { value: 'Giấy phép đã có' } });
      await userEvent.click(within(revoke).getByRole('button', { name: vi_['pmt.waiver.revoke.confirm'] }));
      expect((await screen.findByTestId('revoke-problem')).textContent).toBe(vi_['pmt.waiver.problem.stateInvalid.error']);
    });
  });
});
