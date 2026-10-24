import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ContractorProfileScreen from './ContractorProfileScreen';
import { DOCUMENT, MASTER, READER, VERIFIER, client, detail, mount, restriction, routeOf, world } from './test-support';

const ROUTE = routeOf('BID-02', 'FR-BID-02');
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const OK = { operation_id: 'o', status: 'VERIFIED', resource_version: 2, resource_id: detail(1).id };
const open = (contractor: Record<string, unknown> = detail(1)) => `/bid/bid-02?id=${contractor.id as string}`;

afterEach(cleanup);

const facts = (): Array<[string | null, string | undefined]> => Array.from(document.querySelectorAll('dt')).map((term) => [term.textContent, term.nextElementSibling?.textContent ?? undefined]);
const ready = () => screen.findByTestId('tax-id');
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('ContractorProfileScreen (BID-02): the profile of one contractor', () => {
  it('shows the legal identity with the tax id as it was sent, how the tax id was verified and that no official lookup was made (UI-BID-02)', async () => {
    const verified = detail(1, {
      verification_status: 'VERIFIED',
      verification_basis: 'EVIDENCE_DOCUMENT',
      verified_at: '2026-10-20T02:00:00.000000Z',
      verified_by: '00000000-0000-4000-8000-0000000000b1',
      verification_evidence_document_id: DOCUMENT,
      master_record_id: MASTER,
      contract_count: 3,
    });
    mount(<ContractorProfileScreen route={ROUTE} />, client(world({ details: [verified] })), { permissions: READER, path: open(verified) });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Công ty nhà thầu 1');
    expect(facts()).toEqual([
      [vi_['bid.profile.taxId.label'], '0101234561'],
      [vi_['bid.profile.form.label'], 'TNHH'],
      [vi_['bid.profile.master.label'], MASTER],
      [vi_['bid.profile.contracts.label'], '3'],
      [vi_['bid.profile.document.label'], DOCUMENT],
      [vi_['bid.profile.verifiedAt.label'], '2026-10-20T02:00:00.000000Z'],
      [vi_['bid.profile.verifiedBy.label'], '00000000-0000-4000-8000-0000000000b1'],
      [vi_['bid.profile.evidence.label'], DOCUMENT],
    ]);
    expect(screen.queryByTestId('tax-id-masked')).toBeNull();
    expect(screen.getByTestId('verification').textContent).toBe(`${vi_['bid.status.verified.label']}${vi_['bid.basis.document.label']}`);
    expect(screen.getByTestId('lookup-note').textContent).toBe(vi_['bid.lookup.none.text']);
    expect(screen.getByTestId('history-notice').textContent).toBe(vi_['bid.profile.history.notice']);
  });

  it('says the tax id is covered when the caller lacks the full right, and leaves out the documents and the people that were not sent', async () => {
    const covered = detail(1, { tax_identifier: '010****561', tax_identifier_masked: true, profile_document_id: null, restrictions: [restriction(1)], restriction_in_force: restriction(1) });
    mount(<ContractorProfileScreen route={ROUTE} />, client(world({ details: [covered] })), { permissions: READER, path: open(covered) });
    await ready();
    expect(screen.getByTestId('tax-id').textContent).toBe('010****561');
    expect(screen.getByTestId('tax-id-masked').textContent?.trim()).toBe(vi_['bid.profile.taxId.masked']);
    expect(screen.getByTestId('master-none').textContent).toBe(vi_['bid.profile.master.none']);
    expect(facts().map(([label]) => label)).toEqual([
      vi_['bid.profile.taxId.label'],
      vi_['bid.profile.form.label'],
      vi_['bid.profile.master.label'],
      vi_['bid.profile.contracts.label'],
      vi_['bid.profile.verifiedAt.label'],
    ]);
    expect(screen.getByText(vi_['bid.profile.verifiedAt.none'])).toBeTruthy();
    // The restriction shows its kind and its dates, and says that the decision is for those with the full right.
    const table = screen.getByTestId('restrictions');
    expect(within(table).getByText(vi_['bid.kind.debarment.label'])).toBeTruthy();
    expect(within(table).getByText(vi_['bid.profile.restrictions.hidden'])).toBeTruthy();
    expect(screen.getByTestId('restriction-in-force')).toBeTruthy();
  });

  it('shows a restriction with its decision and without an end date, and an empty list in words', async () => {
    const restricted = detail(1, { restrictions: [restriction(1, { effective_until: null, decision_document_id: DOCUMENT, kind: 'SUSPENSION' })] });
    mount(<ContractorProfileScreen route={ROUTE} />, client(world({ details: [restricted] })), { permissions: READER, path: open(restricted) });
    await ready();
    const table = screen.getByTestId('restrictions');
    expect(within(table).getByText(vi_['bid.profile.restrictions.open'])).toBeTruthy();
    expect(within(table).getByText(DOCUMENT)).toBeTruthy();
    cleanup();
    mount(<ContractorProfileScreen route={ROUTE} />, client(world()), { permissions: READER, path: open() });
    await ready();
    expect(screen.getByTestId('restrictions-empty').textContent).toBe(vi_['bid.profile.restrictions.empty']);
  });

  it('shows what an official lookup answered and through which adapter, and never presents a mock or a proposed adapter as a confirmation', async () => {
    const lookedUp = detail(1, { verification_status: 'VERIFIED', verification_basis: 'EVIDENCE_DOCUMENT', identity_lookup: { adapter_status: 'MOCK', outcome: 'MATCH', checked_at: '2026-10-20T02:00:00.000000Z' } });
    mount(<ContractorProfileScreen route={ROUTE} />, client(world({ details: [lookedUp] })), { permissions: READER, path: open(lookedUp) });
    await ready();
    const note = screen.getByTestId('lookup-note').textContent;
    expect(note).toBe(vi_['bid.lookup.summary.text'].replace('{date}', '2026-10-20').replace('{outcome}', vi_['bid.outcome.match.label']).replace('{adapter}', vi_['bid.adapter.mock.label']));
    // The verification still rests on the document: the badge does not mention a lookup.
    expect(screen.getByTestId('basis').textContent).toBe(vi_['bid.basis.document.label']);
  });

  it('offers the decisions to those who may verify, and only while the contractor is unverified', async () => {
    mount(<ContractorProfileScreen route={ROUTE} />, client(world()), { permissions: VERIFIER, path: open() });
    await ready();
    expect(screen.getByTestId('verification-panel')).toBeTruthy();
    expect(screen.getByTestId('restriction-panel')).toBeTruthy();
    cleanup();
    const decided = detail(1, { verification_status: 'VERIFIED', verification_basis: 'EVIDENCE_DOCUMENT' });
    mount(<ContractorProfileScreen route={ROUTE} />, client(world({ details: [decided] })), { permissions: VERIFIER, path: open(decided) });
    await ready();
    expect(screen.queryByTestId('verification-panel')).toBeNull();
    expect(screen.getByTestId('restriction-panel')).toBeTruthy();
    cleanup();
    mount(<ContractorProfileScreen route={ROUTE} />, client(world()), { permissions: READER, path: open() });
    await ready();
    expect(screen.queryByTestId('verification-panel')).toBeNull();
    expect(screen.queryByTestId('restriction-panel')).toBeNull();
    cleanup();
    mount(<ContractorProfileScreen route={ROUTE} />, client(world()), { permissions: VERIFIER, mode: 'READ_ONLY', path: open() });
    await ready();
    expect(screen.queryByTestId('verification-panel')).toBeNull();
    expect(screen.queryByTestId('restriction-panel')).toBeNull();
    cleanup();
    mount(<ContractorProfileScreen route={ROUTE} />, client(world()), { permissions: undefined, path: open() });
    await ready();
    expect(screen.getByTestId('verification-panel')).toBeTruthy();
  });

  it('asks for the evidence document, then sends the decision with the version it read', async () => {
    const h = client(world(), () => OK);
    mount(<ContractorProfileScreen route={ROUTE} />, h, { permissions: VERIFIER, path: open() });
    await ready();
    const panel = within(screen.getByTestId('verification-panel'));
    fireEvent.click(panel.getByRole('button', { name: vi_['bid.verify.submit.action'] }));
    expect(panel.getByRole('alert').textContent).toBe(vi_['bid.field.required.error']);
    set(vi_['bid.verify.evidence.label'], 'nope');
    fireEvent.click(panel.getByRole('button', { name: vi_['bid.verify.submit.action'] }));
    expect(panel.getByRole('alert').textContent).toBe(vi_['bid.field.invalidId.error']);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(panel.getByLabelText(vi_['bid.status.rejected.label']));
    set(vi_['bid.verify.evidence.label'], DOCUMENT);
    fireEvent.click(panel.getByRole('button', { name: vi_['bid.verify.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('verifyContractor');
    expect(input).toMatchObject({ path: { id: detail(1).id }, body: { decision: 'REJECTED', verification_evidence_document_id: DOCUMENT }, ifMatchVersion: 1 });
  });

  it('sends a duplicate to the merge in master data and names the contractor that holds the tax id (AC-ST-BID-002-1)', async () => {
    const holder = detail(7).id;
    const h = client(world(), () => problem('TAX_ID_DUPLICATE_VERIFIED', 409, { merge_suggestion: { target: 'MDM', action: 'MERGE', verified_contractor_id: holder } }));
    mount(<ContractorProfileScreen route={ROUTE} />, h, { permissions: VERIFIER, path: open() });
    await ready();
    set(vi_['bid.verify.evidence.label'], DOCUMENT);
    fireEvent.click(screen.getByRole('button', { name: vi_['bid.verify.submit.action'] }));
    const refusal = await screen.findByTestId('verify-refusal');
    expect(refusal.textContent).toContain(vi_['bid.problem.duplicateVerified.error']);
    const links = Array.from(screen.getByTestId('merge-suggestion').querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(links).toEqual([`/bid/bid-02?id=${holder}`, '/mdm/mdm-37']);
  });

  it.each([
    [problem('SELF_APPROVAL_DENIED', 403), vi_['bid.problem.selfApproval.error']],
    [problem('VERSION_CONFLICT'), vi_['bid.problem.versionConflict.error']],
    [problem('STAGE_TRANSITION_DENIED'), vi_['bid.problem.stageDenied.error']],
    [problem('TAX_ID_INVALID'), vi_['bid.problem.adapterContradicts.error']],
    [problem('RESOURCE_NOT_FOUND', 404), vi_['bid.problem.notFound.error']],
  ])('tells the person why the decision was refused (%#), and shows no merge suggestion for it', async (failure, message) => {
    const h = client(world(), () => failure);
    mount(<ContractorProfileScreen route={ROUTE} />, h, { permissions: VERIFIER, path: open() });
    await ready();
    set(vi_['bid.verify.evidence.label'], DOCUMENT);
    fireEvent.click(screen.getByRole('button', { name: vi_['bid.verify.submit.action'] }));
    expect((await screen.findByTestId('verify-refusal')).textContent).toBe(message);
    expect(screen.queryByTestId('merge-suggestion')).toBeNull();
  });

  it('shows a duplicate without the holder when the refusal does not name it', async () => {
    const h = client(world(), () => problem('TAX_ID_DUPLICATE_VERIFIED'));
    mount(<ContractorProfileScreen route={ROUTE} />, h, { permissions: VERIFIER, path: open() });
    await ready();
    set(vi_['bid.verify.evidence.label'], DOCUMENT);
    fireEvent.click(screen.getByRole('button', { name: vi_['bid.verify.submit.action'] }));
    await screen.findByTestId('merge-suggestion');
    expect(Array.from(screen.getByTestId('merge-suggestion').querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'))).toEqual(['/mdm/mdm-37']);
  });

  it('records a restriction with the dates and the decision, and refuses wrong dates before sending', async () => {
    const h = client(world(), () => ({ operation_id: 'o', status: 'RECORDED', resource_version: 1, resource_id: restriction(1).id }));
    mount(<ContractorProfileScreen route={ROUTE} />, h, { permissions: VERIFIER, path: open() });
    await ready();
    const panel = within(screen.getByTestId('restriction-panel'));
    const send = () => fireEvent.click(panel.getByRole('button', { name: vi_['bid.restrict.submit.action'] }));
    send();
    expect(panel.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([vi_['bid.field.required.error'], vi_['bid.field.required.error']]);
    set(vi_['bid.restrict.from.label'], '2026-05-01');
    set(vi_['bid.restrict.until.label'], '2026-04-30');
    set(vi_['bid.restrict.decision.label'], DOCUMENT);
    send();
    expect(panel.getByRole('alert').textContent).toBe(vi_['bid.field.order.error']);
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['bid.restrict.until.label'], '2027-12-31');
    fireEvent.change(panel.getByLabelText(vi_['bid.restrict.kind.label']), { target: { value: 'SUSPENSION' } });
    set(vi_['bid.restrict.note.label'], 'By decision 12');
    send();
    expect((await screen.findByTestId('restrict-done')).textContent).toBe(vi_['bid.restrict.done.notice']);
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown> }];
    expect(operation).toBe('recordContractorRestriction');
    expect(input).toMatchObject({
      path: { id: detail(1).id },
      body: { kind: 'SUSPENSION', effective_from: '2026-05-01', effective_until: '2027-12-31', decision_document_id: DOCUMENT, note: 'By decision 12' },
    });
    expect((panel.getByLabelText(vi_['bid.restrict.from.label']) as HTMLInputElement).value).toBe('');
  });

  it('tells the person that a decision which is not in force cannot carry a restriction', async () => {
    const h = client(world(), () => problem('DECISION_DOCUMENT_NOT_EFFECTIVE', 422));
    mount(<ContractorProfileScreen route={ROUTE} />, h, { permissions: VERIFIER, path: open() });
    await ready();
    set(vi_['bid.restrict.from.label'], '2026-05-01');
    set(vi_['bid.restrict.decision.label'], DOCUMENT);
    fireEvent.click(screen.getByRole('button', { name: vi_['bid.restrict.submit.action'] }));
    expect((await screen.findByTestId('restrict-refusal')).textContent).toBe(vi_['bid.problem.decisionNotEffective.error']);
    set(vi_['bid.restrict.note.label'], 'changed');
    expect(screen.queryByTestId('restrict-refusal')).toBeNull();
  });

  it('says so when no contractor is chosen or the contractor does not exist, and offers the list', async () => {
    mount(<ContractorProfileScreen route={ROUTE} />, client(world()), { permissions: READER });
    expect((await screen.findByTestId('no-contractor')).textContent).toBe(vi_['bid.profile.noContractor.notice']);
    expect(screen.getByRole('link', { name: new RegExp(vi_['bid.back.list.link']) }).getAttribute('href')).toBe('/bid/bid-01');
  });

  it('says that the contractor could not be read, with a retry, and that the scope refused it', async () => {
    const state = world({ failing: new Set(['get_resources_contractor_id']) });
    mount(<ContractorProfileScreen route={ROUTE} />, client(state), { permissions: READER, path: open() });
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    cleanup();
    mount(<ContractorProfileScreen route={ROUTE} />, client(world({ details: [], missing: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c', extensions: {} }) })), { permissions: READER, path: open() });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<ContractorProfileScreen route={ROUTE} />, client(world({ details: [], missing: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) })), { permissions: READER, path: open() });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });
});
