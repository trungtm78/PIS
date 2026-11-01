import { ApiError } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import SupportScreen from './SupportScreen';
import { MEMBER, READER_ONLY, client, mount, routeOf, ticket, ticketId, world } from './support/test-support';

const ROUTE = routeOf('IAM-08', 'FR-IAM-08');
const answer = { operation_id: 'o', status: 'Open', resource_version: 1, resource_id: ticketId(9) };
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

beforeEach(() => {
  // The screen tells a ticket is overdue by the clock of now: pin it (only the clock, so the timers of the test library keep running).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T05:00:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-ticket-id="${ticketId(n)}"]`) as HTMLElement;
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const send = () => userEvent.click(screen.getByRole('button', { name: vi_['iam.support.form.send.action'] }));
const fill = (): void => {
  set(vi_['iam.support.form.category.label'], 'INCIDENT');
  set(vi_['iam.support.form.subject.label'], '  Máy chủ báo lỗi khi mở dự án  ');
  set(vi_['iam.support.form.description.label'], '  Từ sáng nay màn hình báo lỗi.\nXin giúp.  ');
};

describe('SupportScreen (IAM-08): help and support requests', () => {
  it('lists the tickets of the caller with the code, the group, the priority and the state in words, and the time the answer is due in Vietnam time (UI-IAM-08)', async () => {
    const state = world({
      tickets: [
        ticket(1),
        ticket(2, { category: 'INCIDENT', priority: 'P1', status: 'InProgress', sla_due_at: '2026-10-27T08:00:00.000000Z', attachment_count: 2 }),
        ticket(3, { status: 'Resolved', own: false }),
      ],
    });
    mount(<SupportScreen route={ROUTE} />, client(state), { permissions: MEMBER });
    await screen.findByTestId('tickets');
    const first = within(rowOf(1));
    expect(first.getByText('SUP-2026-000001')).toBeTruthy();
    expect(first.getByText('Tôi không mở được sổ đăng ký dự án số 1')).toBeTruthy();
    expect(first.getByText(vi_['iam.support.category.access.label'], { exact: false })).toBeTruthy();
    expect(first.getByText(vi_['iam.support.priority.p2.label'])).toBeTruthy();
    expect(first.getByText(vi_['iam.support.status.open.label'])).toBeTruthy();
    expect(first.getByText('27/10/2026 09:00')).toBeTruthy();
    // The first is overdue (its 09:00 is before the 12:00 of now); the second is not.
    expect(rowOf(1).getAttribute('data-overdue')).toBe('true');
    expect(first.getByTestId('overdue').textContent).toBe(vi_['iam.support.overdue.label']);
    const second = within(rowOf(2));
    expect(rowOf(2).getAttribute('data-overdue')).toBe('false');
    expect(second.queryByTestId('overdue')).toBeNull();
    expect(second.getByText('2 tệp đính kèm', { exact: false })).toBeTruthy();
    expect(second.getByText(vi_['iam.support.status.inProgress.label'])).toBeTruthy();
    // A ticket of someone else (shown to who manages support) says so; a resolved one is never overdue.
    expect(within(rowOf(3)).getByText(vi_['iam.support.other.text'], { exact: false })).toBeTruthy();
    expect(rowOf(3).getAttribute('data-overdue')).toBe('false');
    expect(screen.getByTestId('privacy').textContent).toBe(vi_['iam.support.privacy.text']);
    expect(document.querySelector('[data-screen-id="IAM-08"]')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['iam.support.page.title']);
  });

  it('shows the form even when the caller has no ticket yet, and the error state of the read', async () => {
    mount(<SupportScreen route={ROUTE} />, client(world()), { permissions: MEMBER });
    expect((await screen.findByTestId('no-tickets')).textContent).toBe(vi_['iam.support.list.empty.text']);
    expect(screen.getByRole('form', { name: vi_['iam.support.form.aria'] })).toBeTruthy();
    cleanup();
    mount(<SupportScreen route={ROUTE} />, client(world({ failing: new Set(['get_resources_support_ticket']) })), { permissions: MEMBER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });

  it('gives someone who may not send requests the list and not the form, in a read-only session as well', async () => {
    mount(<SupportScreen route={ROUTE} />, client(world({ tickets: [ticket(1)] })), { permissions: READER_ONLY });
    await screen.findByTestId('tickets');
    expect(screen.queryByRole('form', { name: vi_['iam.support.form.aria'] })).toBeNull();
    expect(screen.getByText(vi_['iam.support.readonly.text'])).toBeTruthy();
    cleanup();
    mount(<SupportScreen route={ROUTE} />, client(world({ tickets: [ticket(1)] })), { permissions: MEMBER, mode: 'READ_ONLY' });
    await screen.findByTestId('tickets');
    expect(screen.queryByRole('form', { name: vi_['iam.support.form.aria'] })).toBeNull();
  });

  describe('the form', () => {
    it('names every empty field and sends nothing (UI-IAM-08)', async () => {
      const h = client(world(), () => answer);
      mount(<SupportScreen route={ROUTE} />, h, { permissions: MEMBER });
      await screen.findByRole('form', { name: vi_['iam.support.form.aria'] });
      await send();
      expect(screen.getAllByText(vi_['iam.support.field.required.error'])).toHaveLength(2);
      set(vi_['iam.support.form.subject.label'], 'Help');
      set(vi_['iam.support.form.description.label'], 'Help me');
      await send();
      expect(screen.getAllByText('Cần ít nhất 5 ký tự.', { exact: false }).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Cần ít nhất 10 ký tự.')).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the group and the two texts, trimmed, tells the code of the new ticket once the list has it and starts over (UI-IAM-08)', async () => {
      const state = world();
      const h = client(state, () => {
        state.tickets = [ticket(9, { category: 'INCIDENT', priority: 'P1' })];
        return answer;
      });
      mount(<SupportScreen route={ROUTE} />, h, { permissions: MEMBER });
      await screen.findByRole('form', { name: vi_['iam.support.form.aria'] });
      fill();
      await send();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createSupportTicket');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { category: 'INCIDENT', subject: 'Máy chủ báo lỗi khi mở dự án', description: 'Từ sáng nay màn hình báo lỗi.\nXin giúp.' } });
      await waitFor(() => expect(screen.getByTestId('raised').textContent).toBe('Đã gửi yêu cầu hỗ trợ, mã SUP-2026-000009.'));
      expect(within(rowOf(9)).getByText(vi_['iam.support.priority.p1.label'])).toBeTruthy();
      expect((screen.getByLabelText(vi_['iam.support.form.subject.label']) as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText(vi_['iam.support.form.category.label']) as HTMLSelectElement).value).toBe('INCIDENT');
    });

    it('keeps what the person went on typing while the request is being sent', async () => {
      let settle: () => void = () => undefined;
      const h = client(world(), () => new Promise((resolve) => (settle = () => resolve(answer))));
      mount(<SupportScreen route={ROUTE} />, h, { permissions: MEMBER });
      await screen.findByRole('form', { name: vi_['iam.support.form.aria'] });
      fill();
      await send();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      set(vi_['iam.support.form.subject.label'], 'Một yêu cầu khác');
      await act(async () => settle());
      await screen.findByTestId('raised');
      expect((screen.getByLabelText(vi_['iam.support.form.subject.label']) as HTMLInputElement).value).toBe('Một yêu cầu khác');
      expect((screen.getByLabelText(vi_['iam.support.form.description.label']) as HTMLTextAreaElement).value).toContain('Từ sáng nay');
      expect(h.command).toHaveBeenCalledTimes(1);
    });

    it('tells the request is sent even when the list does not show it yet', async () => {
      const h = client(world(), () => answer);
      mount(<SupportScreen route={ROUTE} />, h, { permissions: MEMBER });
      await screen.findByRole('form', { name: vi_['iam.support.form.aria'] });
      fill();
      await send();
      expect((await screen.findByTestId('raised')).textContent).toBe(vi_['iam.support.raised.notice']);
    });

    it.each([
      [problem(422, 'VALIDATION_FAILED'), vi_['iam.support.problem.validation.error']],
      [problem(403, 'SCOPE_DENIED'), vi_['iam.support.problem.denied.error']],
      [new Error('offline'), vi_['iam.support.problem.general.error']],
    ])('says in words why the request was refused', async (failure, sentence) => {
      const h = client(world(), () => {
        throw failure;
      });
      mount(<SupportScreen route={ROUTE} />, h, { permissions: MEMBER });
      await screen.findByRole('form', { name: vi_['iam.support.form.aria'] });
      fill();
      await send();
      expect((await screen.findByTestId('problem')).textContent).toBe(sentence);
      expect(screen.queryByTestId('raised')).toBeNull();
      // Typing again takes the refusal away.
      set(vi_['iam.support.form.subject.label'], 'Một tiêu đề khác hẳn');
      expect(screen.queryByTestId('problem')).toBeNull();
    });

    it('points at the field the server found wrong', async () => {
      const h = client(world(), () => {
        throw problem(422, 'VALIDATION_FAILED', 'description');
      });
      mount(<SupportScreen route={ROUTE} />, h, { permissions: MEMBER });
      await screen.findByRole('form', { name: vi_['iam.support.form.aria'] });
      fill();
      await send();
      expect(await screen.findByText(vi_['iam.support.field.rejected.error'])).toBeTruthy();
      expect(screen.queryByTestId('problem')).toBeNull();
    });
  });
});
