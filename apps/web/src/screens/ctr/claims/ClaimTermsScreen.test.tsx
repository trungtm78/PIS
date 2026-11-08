import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ClaimTermsScreen from './ClaimTermsScreen';
import { CONTRACT, MANAGER, READER, client, commandsOf, mount, routeOf, term, termList, text, uuid } from './test/support';

afterEach(() => cleanup());

const route = routeOf('CTR-34');
const failure = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const proposal = term({ id: uuid(31), status: 'PROPOSED', proposed_by_name: 'Le Thi B', decided_by_name: null, decided_at: null, can_decide: true, version: 1 });

const open = (list: unknown = termList(), permissions: readonly string[] = MANAGER, command?: (operation: string, input: unknown) => unknown) => {
  const h = client({ listClaimTerms: list }, command);
  return { h, ...mount(<ClaimTermsScreen route={route} />, h, permissions, `/?contract=${CONTRACT}`) };
};

describe('the limitation terms of a contract (CTR-34)', () => {
  it('asks for a contract when none is named and reads nothing until one is chosen', () => {
    const h = client({});
    mount(<ClaimTermsScreen route={route} />, h, MANAGER, '/');
    expect(screen.getByTestId('no-contract')).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('lists the terms with the periods, the clause, who proposed and who decided, and the status as a word', async () => {
    open();
    const row = await screen.findByText(text('ctrClaim.termStatus.approved.label'));
    expect(row).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Clause 20.1 of the contract')).toBeTruthy();
    expect(within(table).getByText(/Thông báo claim: 28 ngày/)).toBeTruthy();
    expect(within(table).getByText(/Le Thi B/)).toBeTruthy();
    expect(within(table).getByText(/Tran Van C/)).toBeTruthy();
    expect(screen.queryByTestId('no-approved')).toBeNull();
  });

  it('says that a contract with no approved term has no limitation clock and is never given the numbers of a form', async () => {
    open(termList({ items: [proposal] }));
    expect(await screen.findByTestId('no-approved')).toBeTruthy();
    expect(screen.getByTestId('no-approved').textContent).toBe(text('ctrClaim.terms.noApproved.text'));
    cleanup();
    open(termList({ items: [] }));
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
  });

  it('shows the templates as examples that are not confirmed and copies one into a proposal without sending anything', async () => {
    const { h } = open();
    const template = await screen.findByTestId('templates');
    expect(within(template).getByText(text('ctrClaim.terms.templates.unverified.label'))).toBeTruthy();
    expect(within(template).getByRole('button', { name: text('ctrReg.info.open.label', { name: 'FIDIC_2017_EXAMPLE' }) })).toBeTruthy();
    fireEvent.click(screen.getByTestId('copy-FIDIC_2017_EXAMPLE'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('template-notice').textContent).toBe(text('ctrClaim.terms.propose.templateNotice.text'));
    expect((within(dialog).getByLabelText(text('ctrClaim.terms.noticeDays.label')) as HTMLInputElement).value).toBe('28');
    expect((within(dialog).getByLabelText(text('ctrClaim.terms.particularsDays.label')) as HTMLInputElement).value).toBe('84');
    // The clause of the contract is still to be written: copying applied nothing.
    expect((within(dialog).getByLabelText(text('ctrClaim.terms.clause.label')) as HTMLInputElement).value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.terms.propose.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.form.required.error'))).toBeTruthy();
    expect(commandsOf(h, 'proposeClaimTerm')).toHaveLength(0);
  });

  it('proposes a term typed from the contract: the clause is named and the template that was copied is remembered', async () => {
    const { h } = open();
    fireEvent.click(await screen.findByTestId('copy-FIDIC_2017_EXAMPLE'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.terms.noticeDays.label')), { target: { value: '21' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.terms.clause.label')), { target: { value: 'Clause 8.2 of the contract' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.terms.propose.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'proposeClaimTerm')).toHaveLength(1));
    expect(commandsOf(h, 'proposeClaimTerm')[0]).toMatchObject({ path: { id: CONTRACT }, body: { claimant_side: 'CONTRACTOR', notice_days: 21, particulars_days: 84, response_days: 42, clause_reference: 'Clause 8.2 of the contract', template_code: 'FIDIC_2017_EXAMPLE' } });
    expect(await screen.findByTestId('receipt')).toBeTruthy();
  });

  it('says in the dialog that a term of this side is already waiting', async () => {
    open(termList(), MANAGER, () => failure('CLAIM_TERM_PENDING'));
    fireEvent.click(await screen.findByTestId('propose-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.terms.noticeDays.label')), { target: { value: '21' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrClaim.terms.clause.label')), { target: { value: 'Clause 8.2 of the contract' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.terms.propose.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.problem.termPending.error'))).toBeTruthy();
  });

  it('shows the decision only on a proposal and only to the person who may approve, and approves under the version it saw', async () => {
    const { h } = open(termList({ items: [proposal, term()] }));
    expect(await screen.findByTestId('term-approve')).toBeTruthy();
    expect(screen.getAllByTestId('term-approve')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('term-approve'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('four-eyes-note').textContent).toBe(text('ctrClaim.terms.fourEyes.text'));
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrClaim.terms.approve.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'decideClaimTerm')).toHaveLength(1));
    expect(commandsOf(h, 'decideClaimTerm')[0]).toMatchObject({ path: { id: uuid(31) }, ifMatchVersion: 1, body: { decision: 'APPROVE' } });
    cleanup();
    open(termList({ items: [proposal] }), READER);
    await screen.findByTestId('no-approved');
    expect(screen.queryByTestId('term-approve')).toBeNull();
    expect(screen.queryByTestId('propose-button')).toBeNull();
  });

  it('refuses the person who proposed the term, in words, and asks for the reason of a rejection', async () => {
    const { h } = open(termList({ items: [proposal] }), MANAGER, () => failure('SELF_APPROVAL_DENIED', 403));
    fireEvent.click(await screen.findByTestId('term-approve'));
    const first = await screen.findByRole('dialog');
    fireEvent.click(within(first).getByRole('button', { name: text('ctrClaim.terms.approve.confirm.action') }));
    expect(await within(first).findByText(text('ctrReg.problem.selfApproval.error'))).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: text('ctrReg.dialog.cancel.action') }));
    fireEvent.click(await screen.findByTestId('term-reject'));
    const second = await screen.findByRole('dialog');
    expect(within(second).getByRole('button', { name: text('ctrClaim.terms.reject.confirm.action') }).hasAttribute('disabled')).toBe(true);
    expect(commandsOf(h, 'decideClaimTerm')).toHaveLength(1);
  });

  it('shows an error with a retry and a refusal as denied', async () => {
    const broken = client({ listClaimTerms: new Error('boom') });
    mount(<ClaimTermsScreen route={route} />, broken, MANAGER, `/?contract=${CONTRACT}`);
    expect(await screen.findByRole('button', { name: text('states.retry.action') })).toBeTruthy();
    cleanup();
    const denied = client({ listClaimTerms: failure('SCOPE_DENIED', 403) });
    mount(<ClaimTermsScreen route={route} />, denied, MANAGER, `/?contract=${CONTRACT}`);
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });
});
