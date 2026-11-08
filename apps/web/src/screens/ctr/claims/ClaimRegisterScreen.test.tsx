import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ClaimRegisterScreen from './ClaimRegisterScreen';
import { CLAIM, CONTRACT, MANAGER, READER, client, commandsOf, limitation, line, mount, page, readsOf, routeOf, text, totals, uuid } from './test/support';

afterEach(() => cleanup());

const route = routeOf('CTR-32');
const forbidden = new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} });

const open = (answers: Record<string, unknown> = {}, permissions: readonly string[] = MANAGER, path = '/') => {
  const h = client({ listClaims: page(), ...answers });
  return { h, ...mount(<ClaimRegisterScreen route={route} />, h, permissions, path) };
};

describe('the claim register (CTR-32)', () => {
  it('lists the claims with the limitation of each as a word and a day, never as a colour alone', async () => {
    open();
    const links = await screen.findAllByTestId('claim-link');
    expect(links.map((link) => link.textContent)).toEqual(['CLM-001', 'CLM-002']);
    expect(links[0]?.getAttribute('href')).toBe(`/ctr/ctr-33?claim=${CLAIM}`);
    const cells = screen.getAllByTestId('limitation');
    expect(cells[0]?.textContent).toContain(text('ctrClaim.limitation.state.running.label'));
    expect(cells[0]?.textContent).toContain('01/12/2026');
    // A claim whose contract has no approved term has no day: the register says so and gives none.
    expect(cells[1]?.textContent).toContain(text('ctrClaim.limitation.state.noTerm.label'));
    expect(cells[1]?.textContent).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(screen.getAllByText(text('ctrClaim.kind.extensionOfTime.label'), { selector: 'td' })).toHaveLength(2);
  });

  it('puts an "i" on the limitation day and on every total, naming the figure, and says that the working numbers are not confirmed', async () => {
    open();
    await screen.findAllByTestId('claim-link');
    const limitationName = text('ctrClaim.column.limitation.label');
    expect(screen.getAllByRole('button', { name: text('ctrReg.info.open.label', { name: limitationName }) }).length).toBe(1);
    for (const key of ['ctrClaim.summary.count.label', 'ctrClaim.summary.open.label', 'ctrClaim.summary.withoutTerm.label', 'ctrClaim.summary.claimed.label', 'ctrClaim.summary.openClaimed.label', 'ctrClaim.summary.settled.label']) {
      expect(screen.getByRole('button', { name: text('ctrReg.info.open.label', { name: text(key) }) })).toBeTruthy();
    }
    expect(screen.getByText(text('ctrClaim.context.policy.unverified'))).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: text('ctrReg.info.open.label', { name: limitationName }) })[0] as HTMLElement);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(text('ctrClaim.figure.limitation.formula'))).toBeTruthy();
    expect(within(panel).getByText(text('ctrReg.info.unverified.text'))).toBeTruthy();
  });

  it('shows the totals of the server over the whole filter, in a total row and in tiles', async () => {
    open();
    await screen.findAllByTestId('claim-link');
    expect(screen.getByText(text('ctrClaim.register.totals.label'))).toBeTruthy();
    expect(within(screen.getByTestId('tile-claimed')).getByText('1.200.000.000')).toBeTruthy();
    expect(within(screen.getByTestId('tile-withoutTerm')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('tile-count')).getByText('2')).toBeTruthy();
  });

  it('says that the totals are a lower bound when the list was cut, and that no working-day deadline can be given when the calendar is not published', async () => {
    open({ listClaims: page({ truncated: true, calendar_published: false }) });
    await screen.findAllByTestId('claim-link');
    expect(screen.getByTestId('truncated-notice').textContent).toBe(text('ctrReg.truncated.text'));
    expect(screen.getByTestId('calendar-notice').textContent).toBe(text('ctrReg.calendar.unavailable.text'));
    expect(within(screen.getByTestId('tile-count')).getByText(text('ctrClaim.summary.lowerBound.text'))).toBeTruthy();
  });

  it('shows a skeleton while it reads, never a zero', () => {
    const h = client({ listClaims: () => new Promise(() => undefined) });
    mount(<ClaimRegisterScreen route={route} />, h, MANAGER);
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    expect(screen.queryByTestId('tile-count')).toBeNull();
  });

  it('says why it cannot show the register: an error with a retry that reads again, and a refusal as denied', async () => {
    let calls = 0;
    const h = client({
      listClaims: () => {
        calls += 1;
        return calls === 1 ? new Error('boom') : page();
      },
    });
    mount(<ClaimRegisterScreen route={route} />, h, MANAGER);
    fireEvent.click(await screen.findByRole('button', { name: text('states.retry.action') }));
    expect(await screen.findAllByTestId('claim-link')).toHaveLength(2);
    cleanup();
    const denied = client({ listClaims: forbidden });
    mount(<ClaimRegisterScreen route={route} />, denied, MANAGER);
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('tells a register with no claim at all from a filter that matches none, and clears the filter', async () => {
    const h = client({
      listClaims: (input: unknown) => ((input as { query?: { status?: string } }).query?.status === undefined ? page({ items: [], totals: totals({ count: 0, open: 0, without_term: 0, claimed_vnd: '0', open_claimed_vnd: '0' }) }) : page({ items: [] })),
    });
    mount(<ClaimRegisterScreen route={route} />, h, MANAGER);
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'SETTLED' } });
    expect(await screen.findByText(text('ui.dataTable.emptyFiltered'))).toBeTruthy();
    expect(readsOf(h, 'listClaims').at(-1)?.query).toMatchObject({ status: 'SETTLED' });
    fireEvent.click(screen.getByTestId('filter-clear'));
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
  });

  it('reads the register with the filter the person chose, and starts from the contract named in the address', async () => {
    const { h } = open({}, MANAGER, `/?contract=${CONTRACT}`);
    await screen.findAllByTestId('claim-link');
    expect(readsOf(h, 'listClaims')[0]?.query).toEqual({ limit: 50, contract_id: CONTRACT });
    fireEvent.click(screen.getByTestId('filter-open'));
    fireEvent.change(screen.getByTestId('filter-limitation'), { target: { value: 'MISSED' } });
    await waitFor(() => expect(readsOf(h, 'listClaims').at(-1)?.query).toMatchObject({ contract_id: CONTRACT, open: true, limitation: 'MISSED' }));
  });

  it('loads the next page and keeps the totals of the first', async () => {
    const second = page({ items: [line({ id: uuid(22), code: 'CLM-003' })] });
    const h = client({ listClaims: (input: unknown) => ((input as { query?: { cursor?: string } }).query?.cursor === undefined ? page({ next_cursor: 'more' }) : second) });
    mount(<ClaimRegisterScreen route={route} />, h, MANAGER);
    fireEvent.click(await screen.findByTestId('load-more'));
    await waitFor(() => expect(screen.getAllByTestId('claim-link')).toHaveLength(3));
    expect(screen.queryByTestId('load-more')).toBeNull();
    expect(within(screen.getByTestId('tile-count')).getByText('2')).toBeTruthy();
  });

  it('marks a claim whose limitation day was missed as the most urgent row', async () => {
    open({ listClaims: page({ items: [line({ limitation: limitation({ status: 'MISSED', days_left: -3 }) })] }) });
    await screen.findAllByTestId('claim-link');
    expect(document.querySelector('[data-limitation="MISSED"]')).toBeTruthy();
    expect(within(screen.getByTestId('limitation')).getByText(text('ctrClaim.limitation.state.missed.label'))).toBeTruthy();
  });

  it('keeps the register button from a reader and shows it to the person who may register', async () => {
    open({}, READER);
    await screen.findAllByTestId('claim-link');
    expect(screen.queryByTestId('register-button')).toBeNull();
    cleanup();
    open();
    expect(await screen.findByTestId('register-button')).toBeTruthy();
  });

  it('registers a claim: refuses an incomplete form before sending, then sends the contract and the body', async () => {
    const { h } = open();
    fireEvent.click(await screen.findByTestId('register-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.registerDialog.confirm.action') }));
    expect(await within(dialog).findAllByText(text('ctrReg.form.required.error'))).not.toHaveLength(0);
    expect(commandsOf(h, 'registerClaim')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.registerDialog.contract.label')), { target: { value: CONTRACT } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.registerDialog.claimTitle.label')), { target: { value: 'Late handover of the site' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.registerDialog.description.label')), { target: { value: 'The site was handed over twenty days late.' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.registerDialog.amount.label')), { target: { value: '500000000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.registerDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'registerClaim')).toHaveLength(1));
    const sent = commandsOf(h, 'registerClaim')[0];
    expect(sent?.path).toEqual({ id: CONTRACT });
    expect(sent?.body).toMatchObject({ claimant_side: 'CONTRACTOR', kind: 'EXTENSION_OF_TIME', title: 'Late handover of the site', claimed_amount_vnd: '500000000' });
    expect(await screen.findByTestId('receipt')).toBeTruthy();
  });

  it('says in the dialog why a claim was refused: a contract that has not begun', async () => {
    const h = client(
      { listClaims: page() },
      () => new ApiError({ status: 409, code: 'CONTRACT_STATE_INVALID', correlationId: 'c', extensions: {} }),
    );
    mount(<ClaimRegisterScreen route={route} />, h, MANAGER);
    fireEvent.click(await screen.findByTestId('register-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.registerDialog.contract.label')), { target: { value: CONTRACT } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.registerDialog.claimTitle.label')), { target: { value: 'Late handover of the site' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.registerDialog.description.label')), { target: { value: 'The site was handed over twenty days late.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.registerDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.problem.contractState.error'))).toBeTruthy();
  });
});
