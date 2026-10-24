import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ContractPartiesScreen from './ContractPartiesScreen';
import { LEAD, MAKER, READER, SECOND, THIRD, client, contractId, detail, mount, party, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-25', 'FR-CTR-25');
const problem = (code: string, status = 422, detailText?: string) => new ApiError({ status, code, correlationId: 'c', detail: detailText, extensions: {} });
const VALUE = '10000000000';

afterEach(cleanup);

const venture = (overrides: Record<string, unknown> = {}) => detail(1, { is_joint_venture: true, contract_value_vnd: VALUE, estimate_ceiling_vnd: VALUE, ...overrides });
const held = [party(1, LEAD, 'Công ty Xây dựng An Phát', 'LEAD', '60.0000', '6000000000'), party(2, SECOND, 'Công ty Cơ khí Bình Minh', 'MEMBER', '40.0000', '4000000000')];
const opened = (contract: Record<string, unknown> = venture(), command?: (operation: string, input: unknown) => unknown, overrides: Partial<World> = {}) =>
  client(world({ details: [contract], ...overrides }), command ?? (() => ({ operation_id: 'o', status: 'DRAFT', resource_version: 2, resource_id: contractId(1) })));
const open = (h: ReturnType<typeof opened>, permissions: readonly string[] | undefined = MAKER, mode?: 'FULL' | 'READ_ONLY') =>
  mount(<ContractPartiesScreen route={ROUTE} />, h, { permissions, path: `/?id=${contractId(1)}`, ...(mode === undefined ? {} : { mode }) });
const rows = (): HTMLElement[] => within(screen.getByTestId('parties')).getAllByTestId('party-row');
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const label = (key: 'ctr.parties.contractor.label' | 'ctr.parties.role.label' | 'ctr.parties.share.label' | 'ctr.parties.work.label', n: number): string => vi_[key].replace('{n}', String(n));
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['ctr.parties.submit.action'] }));
};
const sent = (h: ReturnType<typeof opened>) => h.command.mock.calls as Array<[string, { path: { id: string }; body: { parties: Array<Record<string, unknown>> }; ifMatchVersion: number }]>;
const ready = () => screen.findByTestId('parties');

describe('ContractPartiesScreen (CTR-25): the members of a joint venture', () => {
  it('starts from the lead holding the whole contract when there are no members yet, with the sums shown live (UI-CTR-25)', async () => {
    open(opened());
    await ready();
    expect(rows()).toHaveLength(1);
    expect((screen.getByLabelText(label('ctr.parties.contractor.label', 1)) as HTMLSelectElement).value).toBe(LEAD);
    expect((screen.getByLabelText(label('ctr.parties.share.label', 1)) as HTMLInputElement).value).toBe('100');
    expect(screen.getByTestId('share-total').textContent).toBe(vi_['ctr.parties.total.shareOk'].replace('{share}', '100.0000'));
    expect(screen.getByTestId('work-total').textContent).toBe(vi_['ctr.parties.total.workOk'].replace('{amount}', '10.000.000.000'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`HD-A-001 · ${vi_['ctr.parties.page.title']}`);
    // A contractor that is not verified is not offered; the one the contract has stays.
    const choices = () => within(screen.getByLabelText(label('ctr.parties.contractor.label', 1))).getAllByRole('option').map((option) => option.textContent);
    await waitFor(() => expect(choices()).toEqual([vi_['ctr.parties.choose.option'], 'Công ty Xây dựng An Phát', 'Công ty Cơ khí Bình Minh']));
    expect(screen.queryByRole('button', { name: vi_['ctr.parties.remove.action'].replace('{n}', '1') })).toBeNull();
  });

  it('refuses 60 and 30, and shows the sums while they are typed (AC-ST-CTR-001-3)', async () => {
    const h = opened(venture({ parties: held }));
    open(h);
    await ready();
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId('share-total').textContent).toBe(vi_['ctr.parties.total.shareOk'].replace('{share}', '100.0000'));
    set(label('ctr.parties.share.label', 2), '30');
    expect(screen.getByTestId('share-total').textContent).toBe(vi_['ctr.parties.total.shareBad'].replace('{share}', '90.0000'));
    save();
    expect(h.command).not.toHaveBeenCalled();
    set(label('ctr.parties.share.label', 2), '40');
    set(label('ctr.parties.work.label', 2), '4000000001');
    expect(screen.getByTestId('work-total').textContent).toBe(vi_['ctr.parties.total.workBad'].replace('{amount}', '10.000.000.001').replace('{value}', '10.000.000.000'));
    save();
    expect(h.command).not.toHaveBeenCalled();
    set(label('ctr.parties.share.label', 2), '');
    expect(screen.getByTestId('share-total').textContent).toBe(vi_['ctr.parties.total.shareUnknown']);
    set(label('ctr.parties.work.label', 2), 'abc');
    expect(screen.getByTestId('work-total').textContent).toBe(vi_['ctr.parties.total.workUnknown']);
  });

  it('sends the members under the version it saw once the shares are 100 and the work is the value, and shows that they were saved (AC-ST-CTR-001-3)', async () => {
    const h = opened();
    open(h);
    await ready();
    set(label('ctr.parties.share.label', 1), '60');
    set(label('ctr.parties.work.label', 1), '6000000000');
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.parties.add.action'] }));
    expect(rows()).toHaveLength(2);
    set(label('ctr.parties.contractor.label', 2), SECOND);
    set(label('ctr.parties.share.label', 2), '40');
    set(label('ctr.parties.work.label', 2), '4000000000');
    expect(screen.getByTestId('share-total').className).toBe('ok');
    save();
    expect((await screen.findByTestId('saved')).textContent).toBe(vi_['ctr.parties.saved.notice']);
    const [operation, input] = sent(h)[0] as [string, { path: { id: string }; body: { parties: Array<Record<string, unknown>> }; ifMatchVersion: number }];
    expect(operation).toBe('replaceContractParties');
    expect(input.path.id).toBe(contractId(1));
    expect(input.ifMatchVersion).toBe(1);
    expect(input.body.parties).toEqual([
      { contractor_id: LEAD, role: 'LEAD', share_pct: '60', work_value_vnd: '6000000000' },
      { contractor_id: SECOND, role: 'MEMBER', share_pct: '40', work_value_vnd: '4000000000' },
    ]);
  });

  it('changes a role, removes a member, and names the problem of a row before sending anything', async () => {
    const h = opened(venture({ parties: held }));
    open(h);
    await ready();
    set(label('ctr.parties.role.label', 2), 'LEAD');
    expect((screen.getByLabelText(label('ctr.parties.role.label', 2)) as HTMLSelectElement).value).toBe('LEAD');
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.parties.remove.action'].replace('{n}', '2') }));
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: vi_['ctr.parties.add.action'] }));
    set(label('ctr.parties.share.label', 2), '0');
    save();
    expect(within(rows()[1] as HTMLElement).getByRole('alert').textContent).toBe(vi_['ctr.parties.problem.contractorRequired.error']);
    set(label('ctr.parties.contractor.label', 2), LEAD);
    save();
    expect(within(rows()[1] as HTMLElement).getByRole('alert').textContent).toBe(vi_['ctr.parties.problem.contractorTwice.error']);
    set(label('ctr.parties.contractor.label', 2), SECOND);
    save();
    expect(within(rows()[1] as HTMLElement).getByRole('alert').textContent).toBe(vi_['ctr.parties.problem.invalidShare.error']);
    set(label('ctr.parties.share.label', 2), '5');
    set(label('ctr.parties.work.label', 2), '1.5');
    save();
    expect(within(rows()[1] as HTMLElement).getByRole('alert').textContent).toBe(vi_['ctr.parties.problem.invalidAmount.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each([
    [problem('JV_SHARE_NOT_100'), vi_['ctr.problem.shareNot100.error']],
    [problem('BOQ_TOTAL_MISMATCH'), vi_['ctr.problem.workMismatch.error']],
    [problem('CONTRACTOR_NOT_VERIFIED'), vi_['ctr.problem.contractorNotVerified.error']],
    [problem('CONTRACT_STATE_INVALID', 409), vi_['ctr.problem.stateInvalid.error']],
    [problem('VERSION_CONFLICT', 409), vi_['ctr.problem.versionConflict.error']],
  ])('shows the sentence of a refusal of the server (%#)', async (error, sentence) => {
    const h = opened(venture({ parties: held }), () => error);
    open(h);
    await ready();
    save();
    expect((await screen.findByTestId('problem')).textContent).toBe(sentence);
    expect(rows()).toHaveLength(2);
  });

  it('shows the members as they are when the contract is not a draft any more, without a way to change them', async () => {
    open(opened(venture({ status: 'SIGNED', parties: held })));
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['ctr.parties.notDraft.notice']);
    expect((screen.getByLabelText(label('ctr.parties.share.label', 1)) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['ctr.parties.submit.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['ctr.parties.add.action'] })).toBeNull();
  });

  it('shows a reader and a read-only session the members without a way to change them', async () => {
    const h = opened(venture({ parties: held }));
    const reader = open(h, READER);
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['ctr.readOnly.denied.notice']);
    expect(screen.queryByRole('button', { name: vi_['ctr.parties.submit.action'] })).toBeNull();
    reader.unmount();
    open(h, MAKER, 'READ_ONLY');
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['ctr.readOnly.frozen.notice']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('keeps a member that the contract has even when it is not on the list of verified contractors', async () => {
    const outsider = [party(1, LEAD, 'Công ty Xây dựng An Phát', 'LEAD', '60.0000', '6000000000'), party(2, THIRD, null as unknown as string, 'MEMBER', '40.0000', '4000000000')];
    open(opened(venture({ parties: outsider })));
    await ready();
    const choices = within(screen.getByLabelText(label('ctr.parties.contractor.label', 2))).getAllByRole('option').map((option) => option.textContent);
    expect(choices).toContain(THIRD);
    expect((screen.getByLabelText(label('ctr.parties.contractor.label', 2)) as HTMLSelectElement).value).toBe(THIRD);
  });

  it('says so when the contract is not a venture, has no id in the address, or is not in the scope of the member', async () => {
    open(opened(detail(1)));
    expect((await screen.findByTestId('not-venture')).textContent).toBe(vi_['ctr.parties.notVenture.notice']);
    cleanup();
    mount(<ContractPartiesScreen route={ROUTE} />, opened(), { permissions: MAKER });
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['ctr.parties.noContract.notice']);
    cleanup();
    const forbidden = opened(venture(), undefined, { details: [], missing: new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }) });
    open(forbidden);
    await waitFor(() => expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy());
  });
});
