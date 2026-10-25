import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { CONTRACT, PROJECT, READER, client, mount, routeOf, world } from '../test-support';
import type { World } from '../test-support';
import SectionScreen from './SectionScreen';

const ROUTE = routeOf('LND-10', 'FR-LND-10');
const PATH = `/lnd/lnd-10?project=${PROJECT}`;
const HANDOVER = ['land.handover', 'land.read'];
const WITH_CREATE = ['land.manage', 'land.handover', 'land.read'];
const OK = { operation_id: 'o', status: 'PARTIAL', resource_version: 3, resource_id: 'x' };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const section = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0006${String(n).padStart(8, '0')}`,
  project_id: PROJECT,
  contract_id: CONTRACT,
  code: `SEC-0${n}`,
  name: `Km ${n}`,
  from_km: '0.00',
  to_km: '3.00',
  required_area_m2: '30000.00',
  handed_area_m2: '0.00',
  target_date: '2026-12-31',
  handed_over_on: null,
  status: 'NOT_READY',
  version: 1,
  ...overrides,
});

const worldOf = (sections = [section(1), section(2, { required_area_m2: '28000.00', contract_id: null })]) => world({ sections });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rowOf = (code: string): HTMLElement => document.querySelector(`[data-section="${code}"]`) as HTMLElement;
const ready = () => screen.findByTestId('sections');
const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const UUID = '00000000-0000-4000-8000-0000000000a1';

function open(state: World, options: { permissions?: readonly string[]; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = client(state, options.command ?? (() => OK));
  mount(<SectionScreen route={ROUTE} />, h, { permissions: options.permissions ?? HANDOVER, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

describe('SectionScreen (LND-10): the handover of land by section and km', () => {
  it('UI-LND-10: asks for a project first and lists the sections of the one chosen', async () => {
    open(worldOf(), { path: '/lnd/lnd-10' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(vi_['lnd.sections.project.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['lnd.sections.page.title']);
    await screen.findByRole('option', { name: /DA-2026-001/ });
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.project.label']), { target: { value: PROJECT } });
    await ready();
    expect(Array.from(document.querySelectorAll('[data-section]'))).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(vi_['lnd.parcels.project.label']), { target: { value: '' } });
    expect(screen.getByTestId('choose-project')).toBeTruthy();
  });

  it('UI-LND-10: shows the section, the kilometres, the area it needs and the area handed over with its share, the contract that receives it, the target and the status', async () => {
    open(worldOf([section(1, { handed_area_m2: '18000.00', handed_over_on: '2026-10-20', status: 'PARTIAL' }), section(2, { from_km: null, to_km: null, contract_id: null, target_date: null, required_area_m2: '28000.00' })]));
    await ready();
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
      vi_['lnd.sections.column.section'],
      vi_['lnd.sections.column.km'],
      vi_['lnd.sections.column.required'],
      vi_['lnd.sections.column.handed'],
      vi_['lnd.sections.column.contract'],
      vi_['lnd.sections.column.target'],
      vi_['lnd.sections.column.status'],
      vi_['lnd.sections.column.actions'],
    ]);
    const first = rowOf('SEC-01');
    expect(within(first).getByText('SEC-01')).toBeTruthy();
    expect(first.textContent).toContain(text('lnd.sections.km.range', { from: '0.00', to: '3.00' }));
    expect(within(first).getByTestId('contract').textContent).toBe('HD-A-001');
    expect(within(first).getByTestId('handed').textContent).toBe(new Intl.NumberFormat('vi', { minimumFractionDigits: 2 }).format(18000));
    expect(first.textContent).toContain(text('lnd.sections.ratio.value', { ratio: '60.00' }));
    expect(within(first).getByTestId('status').textContent).toBe(vi_['lnd.sections.status.partial']);
    const second = rowOf('SEC-02');
    expect(second.textContent).toContain(vi_['lnd.sections.km.none']);
    expect(within(second).getByTestId('contract').textContent).toBe(vi_['lnd.sections.contract.none']);
    expect(within(second).getByTestId('status').textContent).toBe(vi_['lnd.sections.status.notReady']);
  });

  it('AC-ST-LND-009-1, UAT-AC386: computes the share of the project from the sums of the areas: 30,000 of 58,000 is 51.72%', async () => {
    open(worldOf([section(1, { handed_area_m2: '30000.00', handed_over_on: '2026-10-20', status: 'HANDED_OVER' }), section(2, { required_area_m2: '28000.00' })]));
    await ready();
    expect(screen.getByTestId('total-ratio').textContent).toBe(text('lnd.sections.ratio.value', { ratio: '51.72' }));
    expect(screen.getByTestId('total-sections').textContent).toBe('1/2');
    const format = new Intl.NumberFormat('vi', { minimumFractionDigits: 2 });
    expect(screen.getByTestId('total-required').textContent).toBe(format.format(58000));
    expect(screen.getByTestId('total-handed').textContent).toBe(format.format(30000));
  });

  it('says so when the project has no section, and still offers to create the first one to someone who manages the land', async () => {
    open(worldOf([]), { permissions: WITH_CREATE });
    expect((await screen.findByTestId('no-sections')).textContent).toBe(vi_['lnd.sections.none.notice']);
    expect(screen.getByTestId('total-ratio').textContent).toBe(text('lnd.sections.ratio.value', { ratio: '0.00' }));
    fireEvent.click(screen.getByRole('button', { name: vi_['lnd.sections.create.action'] }));
    expect(within(dialog()).getByText(vi_['lnd.sectionDialog.title.text'])).toBeTruthy();
  });

  describe('who is offered what', () => {
    it('offers the handover on a section that has a contract and still has area to hand over, and on no other', async () => {
      open(worldOf([section(1), section(2, { contract_id: null }), section(3, { handed_area_m2: '30000.00', handed_over_on: '2026-10-20', status: 'HANDED_OVER' })]));
      await ready();
      expect(Array.from(document.querySelectorAll('[data-handover]')).map((button) => button.getAttribute('data-handover'))).toEqual(['SEC-01']);
      expect(screen.queryByRole('button', { name: vi_['lnd.sections.create.action'] })).toBeNull();
    });

    it('offers nothing to someone who only reads, and nothing in a read-only session', async () => {
      open(worldOf(), { permissions: READER });
      await ready();
      expect(document.querySelectorAll('[data-handover]')).toHaveLength(0);
      cleanup();
      open(worldOf(), { permissions: WITH_CREATE, mode: 'READ_ONLY' });
      await ready();
      expect(document.querySelectorAll('[data-handover]')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: vi_['lnd.sections.create.action'] })).toBeNull();
    });

    it('falls back on the start of the identifier when the caller cannot read the contract', async () => {
      open(world({ sections: [section(1)], contracts: [] }));
      await ready();
      expect(within(rowOf('SEC-01')).getByTestId('contract').textContent).toBe(CONTRACT.slice(0, 8));
    });
  });

  describe('handing the land over', () => {
    const start = async (state: World = worldOf(), options: Parameters<typeof open>[1] = {}) => {
      const h = open(state, options);
      await ready();
      fireEvent.click(document.querySelector('[data-handover="SEC-01"]') as HTMLElement);
      return h;
    };

    it('AC-ST-LND-009-1, UAT-AC386: says what is handed over and what is left, asks for the whole area by now, the day and the record, and sends them under the version it showed', async () => {
      const h = await start(worldOf([section(1, { handed_area_m2: '18000.00', handed_over_on: '2026-10-20', status: 'PARTIAL', version: 4 })]));
      expect(within(dialog()).getByText(text('lnd.sections.handover.title', { code: 'SEC-01' }))).toBeTruthy();
      expect(screen.getByTestId('handover-summary').textContent).toBe(text('lnd.sections.handover.summary', { contract: 'HD-A-001', handed: '18000.00', required: '30000.00', remaining: '12000.00' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect(within(dialog()).getAllByText(vi_['lnd.field.required.error'])).toHaveLength(2);
      type('handover-area', '30000.01');
      type('handover-document', 'nope');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect(within(dialog()).getByText(vi_['lnd.sections.problem.exceeds.error'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      type('handover-area', '30000');
      type('handover-day', '2026-10-22');
      type('handover-document', UUID.toUpperCase());
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'recordSectionHandover',
        expect.objectContaining({ path: { id: section(1).id }, ifMatchVersion: 4, body: { handed_area_m2: '30000', handed_over_on: '2026-10-22', handover_document_version_id: UUID } }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('refuses what does not grow, a day before the last handover and a day that has not come, before it asks the server', async () => {
      const h = await start(worldOf([section(1, { handed_area_m2: '18000.00', handed_over_on: '2026-10-20', status: 'PARTIAL' })]));
      type('handover-document', UUID);
      type('handover-area', '18000');
      type('handover-day', '2026-10-19');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect(within(dialog()).getByText(vi_['lnd.sections.problem.notIncreasing.error'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['lnd.sections.problem.beforeLast.error'])).toBeTruthy();
      type('handover-area', '18000.5');
      type('handover-day', '2999-01-01');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect(within(dialog()).getByText(vi_['lnd.field.future.error'])).toBeTruthy();
      type('handover-area', '18000.123');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
      expect(within(dialog()).getByText(vi_['lnd.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says why the server refused it, and keeps the dialog open with what was typed', async () => {
      for (const [error, expected] of [
        [problem('HANDED_AREA_EXCEEDS_REQUIRED'), vi_['lnd.problem.areaExceeded.error']],
        [problem('PARCELS_NOT_READY'), vi_['lnd.problem.parcelsNotReady.error']],
        [problem('CONTRACT_STATE_INVALID', 409, { contract_status: 'SIGNED' }), vi_['lnd.problem.contractNotActive.error']],
        [problem('VALIDATION_FAILED', 422, { reason: 'NO_CONTRACT' }), vi_['lnd.problem.noContract.error']],
        [problem('VALIDATION_FAILED', 422, { reason: 'NOT_A_CONSTRUCTION_CONTRACT' }), vi_['lnd.problem.notBuilding.error']],
        [problem('VALIDATION_FAILED'), vi_['lnd.problem.validation.error']],
        [problem('DOCUMENT_NOT_CLEAN'), vi_['lnd.problem.documentNotClean.error']],
        [problem('VERSION_CONFLICT', 409), vi_['lnd.problem.versionConflict.error']],
        [problem('SCOPE_DENIED', 403), vi_['lnd.problem.denied.error']],
        [new Error('boom'), vi_['lnd.problem.general.error']],
      ] as const) {
        await start(worldOf(), { command: () => error });
        type('handover-area', '100');
        type('handover-document', UUID);
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['lnd.dialog.submit.action'] }));
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        expect((document.getElementById('handover-area') as HTMLInputElement).value).toBe('100');
        cleanup();
      }
    });
  });

  describe('the seven states (UI-LND-10)', () => {
    const failing = (error: ApiError) => {
      const h = client(worldOf());
      (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
        if (operation === 'listLandSections') return Promise.reject(error);
        if (operation === 'get_resources_project') return Promise.resolve(worldOf().projects);
        return Promise.resolve([]);
      });
      mount(<SectionScreen route={ROUTE} />, h, { permissions: HANDOVER, path: PATH });
    };

    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      failing(problem('SCOPE_DENIED', 403));
      expect(screen.getByRole('status')).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      failing(problem('SESSION_EXPIRED', 401));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      failing(problem('INTERNAL_ERROR', 500));
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });

    it('reads the sections again on retry', async () => {
      const state = worldOf();
      state.failing.add('listLandSections');
      const h = client(state);
      mount(<SectionScreen route={ROUTE} />, h, { permissions: HANDOVER, path: PATH });
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.failing.delete('listLandSections');
      fireEvent.click(retry);
      await ready();
    });
  });
});
