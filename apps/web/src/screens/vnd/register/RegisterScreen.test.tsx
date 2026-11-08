import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import RegisterScreen from './RegisterScreen';
import { READER, client, coverage, figures, mount, policy, registerLine, registerPage, routeOf } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const route = routeOf('VND-01', 'FR-VND-01');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const rows = () => [
  registerLine(1),
  registerLine(2, { restricted: true, open_cases: 2, active_accounts: 0, qualifications_expiring: 3, verification_status: 'UNVERIFIED', coverage: coverage({ coverage_pct: 100, missing: [], present: ['LEGAL_REPRESENTATIVE', 'REGISTERED_ADDRESS', 'CONTACT', 'OWNERSHIP'], complete: true }), next_review_due: null }),
];

function open(over: Partial<World['answers']> = {}, permissions: string[] = READER) {
  const world: World = { answers: { listVendorRegister: registerPage(rows()), getVendorFigures: figures(), ...PANELS, ...over } };
  const h = client(world);
  mount(<RegisterScreen route={route} />, h, { permissions });
  return { h, world };
}

// the panels of the controls and of the duplicate queue read their own operations; these screens' tests are about the register
const PANELS = { getVendorControlFigures: { indicators: [], as_of: '2026-11-08T03:00:00.000Z' }, listVendorDuplicates: { items: [], policy: policy('VENDOR_DUPLICATE_SIGNALS'), as_of: '2026-11-08T03:00:00.000Z' } };

const tableRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-contractor-id]'));

describe('RegisterScreen (VND-01): the contractor register', () => {
  it('lists each contractor with its name as a link to the profile, the verification, the coverage bar and the badges', async () => {
    open();
    await screen.findByText('Công ty nhà thầu 1');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('vnd.register.page.title'));
    const [first, second] = tableRows();
    expect(first).toBeTruthy();
    expect(within(first as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 1' }).getAttribute('href')).toBe('/vnd/vnd-02?contractor=00000000-0000-4000-8000-000100000001');
    expect(first?.textContent).toContain(text('vnd.register.taxCode.text', { code: '0101234561' }));
    expect(first?.textContent).toContain(word('vnd.verification.verified.name'));
    const meter = within(first as HTMLElement).getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('50');
    expect(meter.getAttribute('aria-label')).toBe(text('vnd.register.coverage.label', { name: 'Công ty nhà thầu 1' }));
    expect(first?.textContent).toContain(text('vnd.register.missing.text', { fields: `${word('vnd.profileField.registeredAddress.name')}, ${word('vnd.profileField.ownership.name')}` }));
    expect(first?.textContent).toContain('01/03/2027');
    expect(first?.textContent).not.toContain(word('vnd.register.badge.restricted'));
    expect(second?.textContent).toContain(word('vnd.register.badge.restricted'));
    expect(second?.textContent).toContain(text('vnd.register.badge.cases', { count: 2 }));
    expect(second?.textContent).toContain(text('vnd.register.badge.accounts', { count: 0 }));
    expect(second?.textContent).toContain(text('vnd.register.badge.expiring', { count: 3 }));
    expect(second?.textContent).toContain(word('vnd.verification.unverified.name'));
    expect(second?.textContent).toContain(word('vnd.register.review.none'));
    expect(within(second as HTMLElement).getByRole('link', { name: new RegExp(text('vnd.register.badge.cases', { count: 2 })) }).getAttribute('href')).toContain('/vnd/vnd-03?contractor=');
    expect(within(second as HTMLElement).getByRole('link', { name: new RegExp(text('vnd.register.badge.expiring', { count: 3 })) }).getAttribute('href')).toContain('/vnd/vnd-05?contractor=');
    expect(within(second as HTMLElement).getByRole('link', { name: new RegExp(text('vnd.register.badge.accounts', { count: 0 })) }).getAttribute('href')).toContain('/vnd/vnd-04?contractor=');
  });

  it('says the legal status is not verified in the head of the list', async () => {
    open();
    await screen.findByText('Công ty nhà thầu 1');
    expect(screen.getAllByText(word('vnd.flag.unverified.badge')).length).toBeGreaterThan(0);
  });

  it('shows the four indicators with their numbers, each with an "i" that opens the formula, the source, the day and the unverified flag', async () => {
    open();
    await screen.findByText('Công ty nhà thầu 1');
    const strip = screen.getByRole('group', { name: word('vnd.register.figures.label') });
    const tile = (kind: string): HTMLElement => within(strip).getByTestId(`figure-${kind}`).closest('article') as HTMLElement;
    expect(tile('coverage').textContent).toContain('60%');
    expect(tile('coverage').textContent).toContain(text('vnd.register.indicator.coverage.sub', { complete: 6, total: 10 }));
    expect(tile('debarment').textContent).toContain('80%');
    expect(tile('debarment').textContent).toContain(text('vnd.register.indicator.debarment.sub', { open: 3, overdue: 1 }));
    expect(tile('reputation').textContent).toContain('100%');
    expect(tile('payee').textContent).toContain('5');
    expect(tile('payee').textContent).toContain(text('vnd.register.indicator.payee.sub', { callback: 4, waiting: 1, shared: 0 }));
    for (const kind of ['coverage', 'debarment', 'reputation', 'payee']) expect(within(tile(kind)).getByText(word('vnd.flag.unverified.badge'))).toBeTruthy();
    fireEvent.click(within(tile('coverage')).getByRole('button', { name: text('vnd.info.open.label', { name: 'Indicator PROFILE_COVERAGE' }) }));
    const panel = screen.getByRole('dialog', { name: 'Indicator PROFILE_COVERAGE' });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toContain('Formula PROFILE_COVERAGE');
    expect(panel.querySelector('[data-field=source] dd')?.textContent).toContain('Source PROFILE_COVERAGE');
    expect(panel.querySelector('[data-field=asOf] dd')?.textContent).toContain('08/11/2026');
    expect(panel.querySelector('[data-field=version] dd')?.textContent).toContain('PROFILE_COVERAGE');
    expect(panel.querySelector('[data-field=unverified]')?.textContent).toBe(word('vnd.info.unverified.text'));
  });

  it('uses its own words, flagged unverified, for an indicator the server gave no definition of', async () => {
    open({ getVendorFigures: figures({ indicators: [] }) });
    await screen.findByText('Công ty nhà thầu 1');
    const strip = screen.getByRole('group', { name: word('vnd.register.figures.label') });
    fireEvent.click(within(strip).getAllByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.register.indicator.coverage.name') }) })[0] as HTMLElement);
    const panel = screen.getByRole('dialog', { name: word('vnd.register.indicator.coverage.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe(word('vnd.register.indicator.coverage.formula'));
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
  });

  it('gives the numbers of a line their "i" in the legend: the coverage by the rule, and the three counts', async () => {
    open({ listVendorRegister: registerPage(rows(), { profile_policy: { code: 'VENDOR_PROFILE', version: 'TENANT-3', unverified: false, formula: 'Coverage formula', source: 'Coverage source', as_of: '2026-11-02', params: {} } }) });
    await screen.findByText('Công ty nhà thầu 1');
    const legend = screen.getByTestId('register-legend');
    expect(within(legend).getAllByRole('button')).toHaveLength(4);
    fireEvent.click(within(legend).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.register.figure.coverage.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.register.figure.coverage.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Coverage formula');
    expect(panel.querySelector('[data-field=version] dd')?.textContent).toContain('VENDOR_PROFILE TENANT-3');
    expect(panel.querySelector('[data-field=asOf] dd')?.textContent).toContain('02/11/2026');
    expect(panel.querySelector('[data-field=unverified]')).toBeNull();
  });

  it('asks for the page with the filters the person applies and moves between pages by the cursor', async () => {
    const { h } = open({ listVendorRegister: (input: unknown) => (((input as { query?: { cursor?: string } })?.query?.cursor ?? '') === 'next-1' ? registerPage([registerLine(3)], { next_cursor: null }) : registerPage(rows(), { next_cursor: 'next-1' })) });
    await screen.findByText('Công ty nhà thầu 1');
    expect(h.read).toHaveBeenCalledWith('listVendorRegister', { query: { limit: 20 } });
    fireEvent.change(screen.getByLabelText(word('vnd.register.filter.q.label')), { target: { value: ' Cao ' } });
    fireEvent.change(screen.getByLabelText(word('vnd.register.filter.verification.label')), { target: { value: 'VERIFIED' } });
    fireEvent.change(screen.getByLabelText(word('vnd.register.filter.coverage.label')), { target: { value: 'INCOMPLETE' } });
    fireEvent.click(screen.getByLabelText(word('vnd.register.filter.restricted.label')));
    fireEvent.click(screen.getByLabelText(word('vnd.register.filter.openCase.label')));
    fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorRegister', { query: { q: 'Cao', verification: 'VERIFIED', coverage: 'INCOMPLETE', restricted: true, has_open_case: true, limit: 20 } }));
    fireEvent.click(screen.getByRole('button', { name: word('vnd.pager.next.action') }));
    await screen.findByText('Công ty nhà thầu 3');
    expect(h.read).toHaveBeenCalledWith('listVendorRegister', { query: { q: 'Cao', verification: 'VERIFIED', coverage: 'INCOMPLETE', restricted: true, has_open_case: true, cursor: 'next-1', limit: 20 } });
    expect(screen.getByText(text('vnd.pager.page.text', { page: 2 }))).toBeTruthy();
    expect((screen.getByRole('button', { name: word('vnd.pager.next.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: word('vnd.pager.prev.action') }));
    await waitFor(() => expect(screen.getByText(text('vnd.pager.page.text', { page: 1 }))).toBeTruthy());
  });

  it('goes back to the first page when a filter is applied', async () => {
    const { h } = open({ listVendorRegister: (input: unknown) => (((input as { query?: { cursor?: string } })?.query?.cursor ?? '') === 'next-1' ? registerPage([registerLine(3)]) : registerPage(rows(), { next_cursor: 'next-1' })) });
    await screen.findByText('Công ty nhà thầu 1');
    fireEvent.click(screen.getByRole('button', { name: word('vnd.pager.next.action') }));
    await screen.findByText('Công ty nhà thầu 3');
    fireEvent.click(screen.getByLabelText(word('vnd.register.filter.restricted.label')));
    fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listVendorRegister', { query: { restricted: true, limit: 20 } }));
  });

  it('LOADING: shows a skeleton and never a zero while the answer is on its way', async () => {
    const pending = new Promise(() => undefined);
    const h = client({ answers: {} });
    h.read.mockImplementation(() => pending);
    mount(<RegisterScreen route={route} />, h, { permissions: READER });
    expect((await screen.findAllByRole('status', { name: word('states.loading.label') })).length).toBeGreaterThan(0);
    expect(document.querySelector('tr[data-contractor-id]')).toBeNull();
    expect(document.querySelector('.ui-kpi__value')).toBeNull();
  });

  it('EMPTY: says there is no contractor, and when a filter found nothing offers to clear it', async () => {
    open({ listVendorRegister: registerPage([]) });
    expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    cleanup();
    const { h } = open({ listVendorRegister: (input: unknown) => registerPage((input as { query?: { restricted?: boolean } })?.query?.restricted === true ? [] : rows()) });
    await screen.findByText('Công ty nhà thầu 1');
    fireEvent.click(screen.getByLabelText(word('vnd.register.filter.restricted.label')));
    fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
    expect(await screen.findByText(word('ui.dataTable.emptyFiltered'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('ui.dataTable.clearFilters') }));
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listVendorRegister', { query: { limit: 20 } }));
    expect(await screen.findByText('Công ty nhà thầu 1')).toBeTruthy();
  });

  it('ERROR: names the failure and retries in place', async () => {
    const world: World = { answers: { listVendorRegister: registerPage(rows()), getVendorFigures: figures(), ...PANELS }, failing: { listVendorRegister: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } };
    mount(<RegisterScreen route={route} />, client(world), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByText('Công ty nhà thầu 1')).toBeTruthy();
  });

  it('FORBIDDEN: says the scope is hidden and offers no list and no retry', async () => {
    const world: World = { answers: { getVendorFigures: figures(), ...PANELS }, failing: { listVendorRegister: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } };
    mount(<RegisterScreen route={route} />, client(world), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    expect(document.querySelector('tr[data-contractor-id]')).toBeNull();
  });

  it('PARTIAL: a failed strip does not hide the list, and says which part failed with a retry', async () => {
    const world: World = { answers: { listVendorRegister: registerPage(rows()), ...PANELS }, failing: { getVendorFigures: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } };
    world.answers.getVendorFigures = figures();
    const h = client(world);
    mount(<RegisterScreen route={route} />, h, { permissions: READER });
    expect(await screen.findByText('Công ty nhà thầu 1')).toBeTruthy();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBe(4);
    expect(alerts[0]?.textContent).toContain(text('ui.kpiTile.error', { label: word('vnd.register.indicator.coverage.name') }));
    fireEvent.click(within(alerts[0] as HTMLElement).getByRole('button', { name: word('ui.common.retry') }));
    await waitFor(() => expect(screen.getByText('60%')).toBeTruthy());
  });

  it('STALE: keeps the last good list when a refresh fails and says so with a retry', async () => {
    let calls = 0;
    const world: World = {
      answers: {
        listVendorRegister: () => {
          calls += 1;
          return calls === 1 ? registerPage(rows()) : problem(500, 'INTERNAL_ERROR');
        },
        getVendorFigures: figures(),
      },
    };
    const mounted = mount(<RegisterScreen route={route} />, client(world), { permissions: READER });
    await screen.findByText('Công ty nhà thầu 1');
    await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
    const notice = await screen.findByTestId('stale-notice');
    expect(notice.textContent).toContain(word('vnd.stale.text'));
    expect(screen.getByText('Công ty nhà thầu 1')).toBeTruthy();
  });

  it('SUCCESS: puts the day the figures are as of in the scope bar', async () => {
    open();
    await screen.findByText('Công ty nhà thầu 1');
    expect(document.body.textContent).toContain('08/11/2026 10:00');
    expect(document.body.textContent).toContain('Cao Bang');
  });

  it('offers no command: the register only reads', async () => {
    open({}, ['vnd.read', 'vnd.profile.write']);
    await screen.findByText('Công ty nhà thầu 1');
    expect(screen.queryByRole('button', { name: /sửa|thêm|mở hồ sơ/i })).toBeNull();
  });

});
