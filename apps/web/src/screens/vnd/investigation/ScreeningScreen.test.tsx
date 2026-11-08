import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import ScreeningScreen from './ScreeningScreen';
import { AUDITOR, CONTRACTOR, HIT, LEAD_READER, client, hitDetail, hitLine, mount, overview, routeOf, uuid } from './test/investigation-fixtures';
import type { World } from './test/investigation-fixtures';
import { labelOf, problem, text, word } from './test/helpers';

const route = routeOf('VND-15', 'FR-VND-15');
const READER = ['vnd.screening.read'];

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  failing?: World['failing'];
  detail?: unknown;
  path?: string;
}

function open(hits: Array<Record<string, unknown>> = [hitLine(1), hitLine(2, { source: 'WORLD_BANK', hold: false, score: 60, basis: ['NAME'], similarity: 1, entry_tax_code: null, egp_record_id: null, status: 'DISMISSED', clock: 'DECIDED' })], options: Options = {}, page: Record<string, unknown> = {}) {
  const world: World = { answers: { getVendorScreening: overview(hits, page), getVendorScreeningHit: options.detail ?? hitDetail(1) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<ScreeningScreen route={route} />, h, { permissions: options.permissions ?? AUDITOR, path: options.path ?? '/vnd/vnd-15', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-hit-id]'));
const loaded = async (): Promise<void> => {
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
};
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });

describe('ScreeningScreen (VND-15): the continuous screening', () => {
  it('lists the hits with the contractor, the list, the entry, the score and its basis, the hold and the status', async () => {
    open();
    await loaded();
    const [first, second] = rows();
    expect(within(first as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 1' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${CONTRACTOR}`);
    expect(first?.textContent).toContain(word('vnd3.source.nationalDebarment.name'));
    expect(within(first as HTMLElement).getByTestId(`score-${HIT}`).textContent).toBe('100');
    expect(first?.textContent).toContain(word('vnd3.basis.taxCode.name'));
    expect(first?.textContent).toContain(word('vnd3.screening.hold.badge'));
    expect(first?.getAttribute('data-hold')).toBe('true');
    expect(first?.textContent).toContain(word('vnd3.hitStatus.pending.name'));
    expect(first?.textContent).toContain(word('vnd3.hitClock.onTime.name'));
    expect(second?.textContent).toContain(word('vnd3.source.worldBank.name'));
    expect(second?.textContent).toContain(word('vnd3.basis.name.name'));
    expect(second?.textContent).toContain(word('vnd3.screening.noHold.badge'));
    expect(second?.textContent).toContain(word('vnd3.hitStatus.dismissed.name'));
  });

  it('explains the hold in words on the page: what it stops and that a name alone never puts it', async () => {
    open();
    await loaded();
    expect(screen.getByTestId('hold-explained').textContent).toBe(word('vnd3.screening.hold.text'));
  });

  it('says a hit on an entry that is not yet in force, and a hold that no longer holds', async () => {
    open([hitLine(1, { in_force: false, hold: false }), hitLine(2, { status: 'DISMISSED', hold: true })]);
    await loaded();
    const [future, dismissed] = rows();
    expect(future?.textContent).toContain(word('vnd3.screening.notInForce.badge'));
    expect(future?.textContent).toContain(word('vnd3.screening.noHold.badge'));
    expect(dismissed?.textContent).toContain(word('vnd3.screening.noHold.badge'));
    expect(dismissed?.textContent).not.toContain(word('vnd3.screening.hold.badge'));
  });

  it('shows the strip with the "i": waiting, on hold, overdue by the days of the rule, decided in time', async () => {
    open();
    await loaded();
    expect(screen.getByTestId('figure-pending').textContent).toBe(text('vnd3.screening.figure.pending.sub', { confirmed: 1, dismissed: 3 }));
    expect(screen.getByTestId('figure-holds')).toBeTruthy();
    expect(screen.getByTestId('figure-overdue').textContent).toBe(text('vnd3.screening.figure.overdue.sub', { days: 5 }));
    const inTime = screen.getByTestId('figure-in-time');
    expect(inTime.textContent).toContain(word('vnd.flag.unverified.badge'));
    fireEvent.click(within(inTime).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd3.screening.figure.inTime.name') }) }));
    expect(screen.getByText('Formula of VENDOR_SCREENING')).toBeTruthy();
  });

  it('shows the lists and the day each is as of, says a list that was never imported, and the runs', async () => {
    open();
    await loaded();
    const national = document.querySelector('tr[data-source="NATIONAL_DEBARMENT"]');
    expect(national?.textContent).toContain('06/11/2026');
    expect(national?.textContent).toContain('tệp-quốc-gia-06');
    expect(national?.textContent).toContain('35');
    expect(document.querySelector('tr[data-source="WORLD_BANK"]')?.textContent).toContain(word('vnd3.screening.sources.never'));
    const run = document.querySelector('tr[data-run-id]');
    expect(run?.textContent).toContain(word('vnd3.screening.trigger.nightly.name'));
    expect(run?.textContent).toContain(text('vnd3.screening.runs.compared.text', { contractors: 120, entries: 40 }));
    expect(run?.textContent).toContain(text('vnd3.screening.runs.found.text', { fresh: 2, reopened: 0, resolved: 1, holds: 1 }));
    expect(run?.textContent).toContain(word('vnd3.screening.aside.system'));
  });

  describe('the hit chosen', () => {
    it('opens the detail with the period of the entry, the score with the rule and the history', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-hit'));
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('getVendorScreeningHit', { path: { id: HIT } }));
      const aside = await screen.findByTestId('hit-facts');
      expect(within(aside).getByTestId('hit-period').textContent).toContain(text('vnd3.screening.aside.period.text', { from: '01/01/2026', until: '31/12/2027' }));
      expect(within(aside).getByTestId('hit-score').textContent).toContain('100');
      expect(screen.getByTestId('hit-events').textContent).toContain(word('vnd3.hitMove.found.name'));
      expect(screen.getByTestId('hit-events').textContent).toContain(word('vnd3.screening.aside.system'));
      fireEvent.click(within(screen.getByTestId('hit-aside')).getByRole('button', { name: word('vnd3.screening.aside.close') }));
      expect(screen.queryByTestId('hit-aside')).toBeNull();
    });

    it('opens the hit named in the address', async () => {
      const { h } = open(undefined, { path: `/vnd/vnd-15?hit=${HIT}` });
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('getVendorScreeningHit', { path: { id: HIT } }));
      expect(await screen.findByTestId('hit-facts')).toBeTruthy();
    });

    it('links the case that a confirmation opened', async () => {
      open(undefined, { detail: hitDetail(1, { hit: hitLine(1, { status: 'CONFIRMED', case_id: uuid('0a00', 1), decided_by_name: 'Lê Thị Hoa', decision_reason: 'Đúng là công ty bị cấm', decided_at: '2026-11-06T02:00:00.000Z' }), may_confirm: false, may_dismiss: false }), path: `/vnd/vnd-15?hit=${HIT}` });
      const facts = await screen.findByTestId('hit-facts');
      expect(within(facts).getByTestId('hit-case').querySelector('a')?.getAttribute('href')).toBe(`/vnd/vnd-03?case=${uuid('0a00', 1)}`);
      expect(within(facts).getByTestId('hit-decision').textContent).toContain('Đúng là công ty bị cấm');
      expect(screen.queryByTestId('confirm-hit')).toBeNull();
      expect(screen.queryByTestId('dismiss-hit')).toBeNull();
    });

    it('confirms a hit on the national list with the violation groups the case needs', async () => {
      const { h } = open(undefined, { path: `/vnd/vnd-15?hit=${HIT}` });
      fireEvent.click(await screen.findByTestId('confirm-hit'));
      const form = dialog(word('vnd3.screening.confirm.title'));
      const send = within(form).getByRole('button', { name: word('vnd3.screening.confirm.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      fireEvent.click(within(form).getByLabelText(word('vnd.group.group1.name')));
      expect(send.disabled).toBe(false);
      type(form, word('vnd3.screening.confirm.summary.label'), 'Quá ngắn');
      expect(send.disabled).toBe(true);
      type(form, word('vnd3.screening.confirm.summary.label'), 'Nhà thầu đã bị cấm theo quyết định của mạng đấu thầu quốc gia');
      fireEvent.click(send);
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith('confirmVendorScreeningHit', {
          path: { id: HIT },
          ifMatchVersion: 3,
          body: { violation_groups: ['GROUP_1'], violation_summary: 'Nhà thầu đã bị cấm theo quyết định của mạng đấu thầu quốc gia' },
          attempt: { key: expect.any(String) },
        }),
      );
    });

    it('confirms a hit on another list with no groups asked', async () => {
      const other = hitLine(2, { source: 'PEP', egp_record_id: null, hold: true });
      const { h } = open([other], { detail: hitDetail(2, { hit: other }), path: `/vnd/vnd-15?hit=${uuid('0200', 2)}` });
      fireEvent.click(await screen.findByTestId('confirm-hit'));
      const form = dialog(word('vnd3.screening.confirm.title'));
      expect(within(form).queryByLabelText(word('vnd.group.group1.name'))).toBeNull();
      expect(form.textContent).toContain(word('vnd3.screening.confirm.noteOther'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd3.screening.confirm.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('confirmVendorScreeningHit', { path: { id: uuid('0200', 2) }, ifMatchVersion: 3, body: {}, attempt: { key: expect.any(String) } }));
    });

    it('dismisses with a reason of twenty characters at least', async () => {
      const { h } = open(undefined, { path: `/vnd/vnd-15?hit=${HIT}` });
      fireEvent.click(await screen.findByTestId('dismiss-hit'));
      const form = dialog(word('vnd3.screening.dismiss.title'));
      const send = within(form).getByRole('button', { name: word('vnd3.screening.dismiss.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'mười chín ký tự');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), 'Khác người sáng lập và khác địa chỉ đăng ký');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('dismissVendorScreeningHit', { path: { id: HIT }, ifMatchVersion: 3, body: { reason: 'Khác người sáng lập và khác địa chỉ đăng ký' }, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd3.screening.dismiss.title'));
    });

    it('says a changed version with a way to read the hit again', async () => {
      open(undefined, { command: () => Promise.reject(problem(409, 'VERSION_CONFLICT')), path: `/vnd/vnd-15?hit=${HIT}` });
      fireEvent.click(await screen.findByTestId('dismiss-hit'));
      const form = dialog(word('vnd3.screening.dismiss.title'));
      type(form, word('vnd.field.reason.label'), 'Khác người sáng lập và khác địa chỉ đăng ký');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd3.screening.dismiss.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.conflict.text'));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });

    it('offers neither move without the right to decide, nor in a read-only workspace', async () => {
      open(undefined, { permissions: READER, path: `/vnd/vnd-15?hit=${HIT}` });
      await screen.findByTestId('hit-facts');
      expect(screen.queryByTestId('confirm-hit')).toBeNull();
      expect(screen.queryByTestId('dismiss-hit')).toBeNull();
      cleanup();
      open(undefined, { mode: 'READ_ONLY', path: `/vnd/vnd-15?hit=${HIT}` });
      await screen.findByTestId('hit-facts');
      expect(screen.queryByTestId('confirm-hit')).toBeNull();
    });

    it('says in place when the hit cannot be read', async () => {
      open(undefined, { failing: { getVendorScreeningHit: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } }, path: `/vnd/vnd-15?hit=${HIT}` });
      expect(await screen.findByTestId('hit-error')).toBeTruthy();
      fireEvent.click(within(screen.getByTestId('hit-error')).getByRole('button', { name: word('states.retry.action') }));
      expect(await screen.findByTestId('hit-facts')).toBeTruthy();
    });
  });

  describe('the run and the import', () => {
    it('runs the screening now and says when', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('run-screening'));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('runVendorScreening', { attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain('Đã chạy sàng lọc lúc');
    });

    it('says a refused run in place', async () => {
      open(undefined, { command: () => Promise.reject(problem(403, 'SCOPE_DENIED')) });
      await loaded();
      fireEvent.click(screen.getByTestId('run-screening'));
      expect((await screen.findByTestId('run-error')).textContent).toBe(word('vnd.error.forbidden.text'));
    });

    it('offers the run and the import only with the rights', async () => {
      open(undefined, { permissions: READER });
      await loaded();
      expect(screen.queryByTestId('run-screening')).toBeNull();
      expect(screen.queryByTestId('import-list')).toBeNull();
    });

    it('previews the entries pasted, names a bad line and keeps the button off until the list is right', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('import-list'));
      const form = dialog(word('vnd3.import.title'));
      const send = within(form).getByRole('button', { name: word('vnd3.import.confirm') }) as HTMLButtonElement;
      fireEvent.change(within(form).getByLabelText(labelOf(word('vnd3.import.field.source.label'))), { target: { value: 'WORLD_BANK' } });
      fireEvent.change(within(form).getByLabelText(labelOf(word('vnd3.import.field.asOf.label'))), { target: { value: '2026-11-07' } });
      type(form, word('vnd3.import.field.reference.label'), 'Danh sách World Bank tháng 11');
      type(form, word('vnd3.import.field.entries.label'), 'WB1,Công ty ABC,0101234567\n,thiếu mã');
      expect(within(form).getByTestId('import-count').textContent).toBe(text('vnd3.import.preview.count', { count: 1 }));
      expect(within(form).getByTestId('import-errors').textContent).toContain(text('vnd3.import.preview.error', { line: 2, problem: word('vnd3.import.problem.ref.text') }));
      expect(send.disabled).toBe(true);
      type(form, word('vnd3.import.field.entries.label'), 'ref,name,tax_code,valid_from,valid_until\nWB1,Công ty ABC,0101234567,2026-01-01,2027-01-01\nWB2,Công ty XYZ');
      expect(within(form).getByTestId('import-count').textContent).toBe(text('vnd3.import.preview.count', { count: 2 }));
      expect(within(form).queryByTestId('import-errors')).toBeNull();
      expect(form.querySelector('.inv-preview')?.textContent).toContain(text('vnd3.import.preview.row', { ref: 'WB1', name: 'Công ty ABC', tax: '0101234567' }));
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() =>
        expect(h.command).toHaveBeenCalledWith('importVendorScreeningList', {
          body: {
            source: 'WORLD_BANK',
            as_of: '2026-11-07',
            reference: 'Danh sách World Bank tháng 11',
            entries: [
              { ref: 'WB1', name: 'Công ty ABC', tax_code: '0101234567', valid_from: '2026-01-01', valid_until: '2027-01-01' },
              { ref: 'WB2', name: 'Công ty XYZ' },
            ],
          },
          attempt: { key: expect.any(String) },
        }),
      );
    });

    it('does not offer the national list for the import', async () => {
      open();
      await loaded();
      fireEvent.click(screen.getByTestId('import-list'));
      const form = dialog(word('vnd3.import.title'));
      const options = Array.from(within(form).getByLabelText(labelOf(word('vnd3.import.field.source.label'))).querySelectorAll('option')).map((option) => option.getAttribute('value'));
      expect(options).not.toContain('NATIONAL_DEBARMENT');
      expect(options).toContain('PEP');
    });
  });

  describe('states', () => {
    it('filters by status and source and asks the server with them', async () => {
      const { h } = open();
      await loaded();
      fireEvent.change(screen.getByLabelText(word('vnd3.screening.filter.status.label')), { target: { value: 'PENDING' } });
      fireEvent.change(screen.getByLabelText(word('vnd3.screening.filter.source.label')), { target: { value: 'PEP' } });
      fireEvent.click(screen.getByRole('button', { name: word('vnd.register.filter.apply.action') }));
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('getVendorScreening', { query: { status: 'PENDING', source: 'PEP' } }));
    });

    it('EMPTY: says there is no hit', async () => {
      open([]);
      expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    });

    it('LOADING, then ERROR with a retry', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<ScreeningScreen route={route} />, pending, { permissions: AUDITOR, path: '/vnd/vnd-15' });
      expect(await screen.findAllByRole('status')).toBeTruthy();
      cleanup();
      open(undefined, { failing: { getVendorScreening: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findAllByRole('alert')).some((alert) => alert.textContent?.includes(word('states.error.title')))).toBe(true);
      fireEvent.click(screen.getAllByRole('button', { name: word('states.retry.action') })[0] as HTMLElement);
      await loaded();
    });

    it('HIDDEN: says the scope is hidden when the server answers 403', async () => {
      open(undefined, { permissions: LEAD_READER, failing: { getVendorScreening: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect((await screen.findByTestId('screening-hidden')).textContent).toBe(word('vnd3.screening.hidden.text'));
      expect(rows()).toHaveLength(0);
    });

    it('STALE: keeps the last list when a refresh fails', async () => {
      let calls = 0;
      const world: World = { answers: { getVendorScreening: () => (++calls === 1 ? overview([hitLine(1)]) : problem(500, 'INTERNAL_ERROR')), getVendorScreeningHit: hitDetail(1) } };
      const mounted = mount(<ScreeningScreen route={route} />, client(world), { permissions: AUDITOR, path: '/vnd/vnd-15' });
      await loaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect(await screen.findByTestId('stale-notice')).toBeTruthy();
      expect(rows()).toHaveLength(1);
    });
  });

  it('speaks English when the language is English', async () => {
    translator.setLocale('en');
    open();
    await loaded();
    expect(screen.getByTestId('hold-explained').textContent).toContain('What a hold is');
    expect(rows()[0]?.textContent).toContain('On hold');
  });
});
