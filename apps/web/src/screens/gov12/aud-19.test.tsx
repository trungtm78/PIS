import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import GiftScreen from './aud/GiftScreen';
import { AS_OF, ME, harness, mount, never, problem, routeOf, uuid, word, rx } from './test/docaud';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const route = routeOf('AUD-19', 'AUD', 'FR-AUD-19');
const ALL = ['aud.gift.read', 'aud.gift.declare', 'aud.gift.review'];
const READ = ['aud.gift.read'];
const rule = { version: 0, unverified: true, declare_within_days: 5, review_over_vnd: '200000', keep_up_to_vnd: '1000000' };

const gift = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  recipient_id: uuid(33),
  declared_by: uuid(33),
  giver_name: `ACME ${n}`,
  giver_kind: 'CONTRACTOR',
  project_id: null,
  description: 'A basket of fruit',
  value_vnd: '3000000',
  received_on: '2027-03-01',
  declared_on: '2027-03-08',
  status: 'DECLARED',
  reviewer_id: null,
  outcome: null,
  outcome_note: null,
  closed_on: null,
  flags: { late: true, declare_due_on: '2027-03-06', needs_review: true, may_be_kept: false },
  rule_version: 0,
  version: 1,
  ...over,
});

function open(items: unknown[], command?: (op: string, input: unknown) => unknown, permissions: readonly string[] = ALL) {
  const h = harness((op) => (op === 'listGifts' ? { as_of: AS_OF, items, has_more: false, rule } : {}), command);
  mount(<GiftScreen route={route} />, h, permissions);
  return h;
}

describe('AUD-19, the gifts register', () => {
  it('UI-AUD-19: lists the gifts with their flags and outcome, and the rule with an "i" that says it is not confirmed', async () => {
    open([gift(1), gift(2, { status: 'CLOSED', outcome: 'RETURNED', outcome_note: 'Returned by post', reviewer_id: uuid(34), flags: { late: false, declare_due_on: '2027-03-06', needs_review: false, may_be_kept: true } })]);
    expect(await screen.findByTestId(`flags-${uuid(1)}`)).toBeTruthy();
    const flags = screen.getByTestId(`flags-${uuid(1)}`).textContent ?? '';
    expect(flags).toContain(word('gov12da.aud19.flag.late'));
    expect(flags).toContain(word('gov12da.aud19.flag.review'));
    expect(flags).toContain(word('gov12da.aud19.flag.noKeep'));
    expect(screen.getByTestId(`outcome-${uuid(2)}`).textContent).toContain(word('gov12da.aud.outcome.returned'));
    expect(screen.getByTestId('figure-keep').textContent).toBe('1.000.000');
    fireEvent.click(screen.getByRole('button', { name: rx(word('gov12da.aud19.figure.keep')) }));
    const panel = await screen.findByRole('dialog', { name: word('gov12da.aud19.figure.keep') });
    expect(within(panel).getByText(word('gov12da.info.label.unverified'))).toBeTruthy();
  });

  it('shows a reader no action; the recipient is not offered the review of their own gift', async () => {
    open([gift(1)], undefined, READ);
    await screen.findByTestId(`flags-${uuid(1)}`);
    expect(screen.queryByTestId('declare-open')).toBeNull();
    expect(screen.queryByTestId(`take-${uuid(1)}`)).toBeNull();
    cleanup();
    open([gift(1, { recipient_id: ME })]);
    await screen.findByTestId(`flags-${uuid(1)}`);
    expect(screen.queryByTestId(`take-${uuid(1)}`)).toBeNull();
    expect(screen.getByTestId('declare-open')).toBeTruthy();
  });

  it('declares a gift after checking the fields, and sends the value as exact text', async () => {
    const h = open([gift(1)], () => ({ operation_id: 'x', status: 'DECLARED', resource_version: 1, resource_id: uuid(9) }));
    fireEvent.click(await screen.findByTestId('declare-open'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: word('gov12da.aud19.declare.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.validation.text'));
    fireEvent.change(screen.getByTestId('declare-recipient'), { target: { value: uuid(33) } });
    fireEvent.change(screen.getByTestId('declare-giver'), { target: { value: 'ACME Construction' } });
    fireEvent.change(screen.getByTestId('declare-description'), { target: { value: 'A box of tea' } });
    fireEvent.change(screen.getByTestId('declare-value'), { target: { value: '150000' } });
    fireEvent.change(screen.getByTestId('declare-received'), { target: { value: '2027-03-01' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.aud19.declare.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('declareGift', expect.objectContaining({ body: { recipient_id: uuid(33), giver_name: 'ACME Construction', giver_kind: 'CONTRACTOR', description: 'A box of tea', value_vnd: '150000', received_on: '2027-03-01' } })));
  });

  it('takes the review at the version it saw and says in words when the recipient tries it', async () => {
    const h = open([gift(1, { version: 3 })], () => problem('SELF_APPROVAL_DENIED', 403));
    fireEvent.click(await screen.findByTestId(`take-${uuid(1)}`));
    expect((await screen.findByTestId('notice')).textContent).toBe(word('gov12da.error.selfApproval.text'));
    expect(h.command).toHaveBeenCalledWith('takeGiftReview', expect.objectContaining({ path: { id: uuid(1) }, ifMatchVersion: 3 }));
  });

  it('closes a gift over the line: kept is refused in words, returned is sent with the note', async () => {
    let calls = 0;
    const h = open([gift(1, { status: 'UNDER_REVIEW', reviewer_id: ME, version: 2 })], () => {
      calls += 1;
      return calls === 1 ? problem('GIFT_OUTCOME_REFUSED', 422) : { operation_id: 'x', status: 'CLOSED', resource_version: 3, resource_id: uuid(1) };
    });
    fireEvent.click(await screen.findByTestId(`close-${uuid(1)}`));
    const dialog = await screen.findByRole('dialog');
    const choice = within(dialog).getByLabelText(word('gov12da.aud19.close.outcome')) as HTMLSelectElement;
    expect(choice.value).toBe('RETURNED');
    fireEvent.change(choice, { target: { value: 'KEPT' } });
    fireEvent.change(within(dialog).getByLabelText(rx(word('gov12da.aud19.close.note'))), { target: { value: 'Kept with the approval of the head' } });
    fireEvent.click(within(dialog).getByRole('button', { name: word('gov12da.aud19.close.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toBe(word('gov12da.error.giftOutcome.text'));
    fireEvent.change(choice, { target: { value: 'RETURNED' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('gov12da.aud19.close.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command).toHaveBeenLastCalledWith('closeGift', expect.objectContaining({ path: { id: uuid(1) }, ifMatchVersion: 2, body: { outcome: 'RETURNED', note: 'Kept with the approval of the head' } }));
  });

  it('shows the loading, empty, error and denied states', async () => {
    const loading = harness(() => never());
    mount(<GiftScreen route={route} />, loading, ALL);
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    open([]);
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<GiftScreen route={route} />, harness(() => problem('INTERNAL_ERROR', 500)), ALL);
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    mount(<GiftScreen route={route} />, harness(() => problem('SCOPE_DENIED', 403)), ALL);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});
