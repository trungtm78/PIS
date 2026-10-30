import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness } from '../../sas/test-support';
import { asset, assetId, mount, routeOf, unitId } from '../asset/test-support';
import OmLinkScreen from './OmLinkScreen';
import { describeProblem, emptyLink, isOperated, linkBody, toOmAsset, validateLink } from './model';

const ROUTE = routeOf('AST-06', 'FR-AST-06');
const READER = ['asset_record.read'];
const ACCOUNTANT = ['asset_record.read', 'asset.manage'];
const DOCUMENT = '00000000-0000-4000-8000-00d000000001';
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c' });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const OK = { operation_id: 'o', status: 'LINKED', resource_version: 1, resource_id: 'link-1' };

const operated = (overrides: Record<string, unknown> = {}) =>
  asset(1, { status: 'TRANSFERRED', transferred_on: '2026-10-24', external_asset_id: 'TS-2027-009', om_link: null, allowed: { transfer: false, link_om: true }, ...overrides });
const linked = {
  id: 'link-1',
  status: 'LINKED',
  operator_unit: { id: unitId(2), code: 'BQL', name: 'Ban Quản lý' },
  om_plan_document_version_id: DOCUMENT,
  om_contract_id: null,
  maintenance_cycle_months: 6,
  next_maintenance_due: '2027-03-01',
  external_system_ref: 'CMMS-77',
};

afterEach(cleanup);

function open(answer: () => unknown, options: { permissions?: readonly string[]; query?: string; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY'; units?: () => Promise<unknown> } = {}) {
  const h = harness((operation) => (operation === 'get_resources_asset_record_id' ? answer() : new Error(`unexpected read ${operation}`)), options.command ?? (() => OK));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(options.units ?? (() => Promise.resolve([{ id: unitId(1), code: 'SOGT', name: 'Sở Giao thông' }, { id: unitId(2), code: 'BQL', name: 'Ban Quản lý' }])));
  mount(<OmLinkScreen route={ROUTE} />, h, { permissions: options.permissions ?? ACCOUNTANT, path: `/ast/ast-06${options.query ?? `?id=${assetId(1)}`}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const ready = async (): Promise<void> => {
  await screen.findByTestId('asset');
};
const commandsOf = (h: ReturnType<typeof open>) => h.command.mock.calls.filter((call) => call[0] === 'linkOmPlan').map((call) => call[1] as { path?: { id?: string }; body: Record<string, unknown> });

describe('OmLinkScreen (AST-06): the link of an asset to the unit that operates it', () => {
  it('UI-AST-06: shows the asset, its code in the outside system marked as typed by hand, and the link it has', async () => {
    const h = open(() => operated({ om_link: linked, allowed: { transfer: false, link_om: false } }));
    await ready();
    expect(screen.getByTestId('code').textContent).toBe('AS-001');
    expect(screen.getByTestId('external').textContent).toBe(text('ast.omlink.external.manual', { code: 'TS-2027-009' }));
    expect(screen.getByTestId('operator').textContent).toBe('Ban Quản lý');
    expect(screen.getByTestId('plan').textContent).toBe(DOCUMENT);
    expect(screen.getByTestId('cycle').textContent).toBe(text('ast.omlink.cycle.months', { months: 6 }));
    expect(screen.getByTestId('due').textContent).toBe('2027-03-01');
    expect(screen.getByTestId('reference').textContent).toBe(text('ast.omlink.reference.manual', { code: 'CMMS-77' }));
    expect(screen.getByTestId('om-contract').textContent).toBe(text('ast.omlink.none'));
    expect(document.querySelector('[data-testid="link-form"]')).toBeNull();
    expect(h.read.mock.calls[0]).toEqual(['get_resources_asset_record_id', { path: { id: assetId(1) } }]);
  });

  it('AC-ST-AST-005-1 UAT-AC393: says an asset that was not transferred takes no link, and offers no form for it', async () => {
    open(() => asset(1, { status: 'REGISTERED', allowed: { transfer: true } }));
    expect((await screen.findByTestId('not-transferred')).textContent).toBe(text('ast.omlink.notTransferred.notice'));
    expect(document.querySelector('[data-testid="link-form"]')).toBeNull();
    expect(screen.getByTestId('external').textContent).toBe(text('ast.omlink.external.none'));
  });

  it('AC-ST-AST-005-1 UAT-AC393: links a transferred asset with the unit, the cycle and the next maintenance, and sends what was typed without the spaces', async () => {
    const h = open(() => operated());
    const form = await screen.findByTestId('link-form');
    expect(form).toBeTruthy();
    await waitFor(() => expect((document.getElementById('link-operator') as HTMLSelectElement).options.length).toBe(3));
    pick('link-operator', unitId(2));
    pick('link-plan', DOCUMENT.toUpperCase());
    pick('link-cycle', ' 6 ');
    pick('link-due', '2027-03-01');
    pick('link-reference', '  CMMS-77  ');
    fireEvent.submit(form);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(commandsOf(h)[0]).toMatchObject({ path: { id: assetId(1) }, body: { operator_unit_id: unitId(2), om_plan_document_version_id: DOCUMENT, maintenance_cycle_months: 6, next_maintenance_due: '2027-03-01', external_system_ref: 'CMMS-77' } });
  });

  it('names what is wrong before sending: no unit, a plan that is no id, a cycle out of the range, a day that is not real', async () => {
    const h = open(() => operated());
    const form = await screen.findByTestId('link-form');
    fireEvent.submit(form);
    expect(await screen.findByText(text('ast.omlink.problem.required'))).toBeTruthy();
    pick('link-operator', unitId(1));
    pick('link-plan', 'x');
    pick('link-contract', 'y');
    pick('link-cycle', '121');
    pick('link-due', '2027-02-30');
    fireEvent.submit(form);
    expect(await screen.findAllByText(text('ast.omlink.problem.uuid'))).toHaveLength(2);
    expect(screen.getByText(text('ast.omlink.problem.cycle'))).toBeTruthy();
    expect(screen.getByText(text('ast.omlink.problem.date'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says in words why the server refused: not transferred, already linked, a plan that is not clean, a bad datum, not found, denied, session, general', async () => {
    for (const [code, key] of [
      ['ASSET_NOT_TRANSFERRED', 'notTransferred'],
      ['OM_LINK_EXISTS', 'linked'],
      ['DOCUMENT_NOT_CLEAN', 'notClean'],
      ['VALIDATION_FAILED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['INTERNAL_ERROR', 'general'],
    ] as const) {
      open(() => operated(), { command: () => problem(code, code === 'INTERNAL_ERROR' ? 500 : 409) });
      const form = await screen.findByTestId('link-form');
      await waitFor(() => expect((document.getElementById('link-operator') as HTMLSelectElement).options.length).toBe(3));
      pick('link-operator', unitId(1));
      fireEvent.submit(form);
      expect((await screen.findByTestId('refusal')).textContent).toBe(text(`ast.omlink.error.${key}`));
      cleanup();
    }
  });

  it('offers no form to one who may not link, or while the tenant is read-only, and says why', async () => {
    open(() => operated({ allowed: { transfer: false, link_om: false } }), { permissions: READER });
    expect((await screen.findByTestId('no-right')).textContent).toBe(text('ast.omlink.noRight.notice'));
    cleanup();
    open(() => operated(), { mode: 'READ_ONLY' });
    expect(await screen.findByTestId('no-right')).toBeTruthy();
    expect(document.querySelector('[data-testid="link-form"]')).toBeNull();
  });

  it('says the units could not be loaded, and keeps the form', async () => {
    open(() => operated(), { units: () => Promise.reject(new Error('down')) });
    expect(await screen.findByTestId('units-failed')).toBeTruthy();
    expect(document.querySelector('[data-testid="link-form"]')).not.toBeNull();
  });

  it('shows the seven states: loading, denied, signed out, offline, error, empty (no asset named) and not found', async () => {
    open(() => operated());
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(() => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const nobody = open(() => operated(), { permissions: ['notification.self'] });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(nobody.read).not.toHaveBeenCalled();
    cleanup();
    const none = open(() => operated(), { query: '' });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(none.read).not.toHaveBeenCalled();
    cleanup();
    open(() => ({ id: 3 }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  describe('the rules of the form', () => {
    it('reads the asset and its link, and tells an operated asset from one that is not', () => {
      expect(toOmAsset(operated({ om_link: linked }))?.omLink).toMatchObject({ operatorUnit: 'Ban Quản lý', maintenanceCycleMonths: 6, externalSystemRef: 'CMMS-77' });
      expect(toOmAsset(operated())?.omLink).toBeUndefined();
      expect(toOmAsset(operated())?.canLink).toBe(true);
      expect(toOmAsset({ id: 'a' })).toBeUndefined();
      expect(toOmAsset(null)).toBeUndefined();
      expect([isOperated({ status: 'TRANSFERRED' }), isOperated({ status: 'IN_OPERATION' }), isOperated({ status: 'REGISTERED' }), isOperated({ status: 'DISPOSED' })]).toEqual([true, true, false, false]);
    });

    it('judges the form before it is sent, and builds the body without what is empty', () => {
      expect(validateLink({ ...emptyLink(), operatorUnitId: unitId(1) })).toEqual({});
      expect(validateLink(emptyLink())).toEqual({ operatorUnitId: 'required' });
      expect(validateLink({ ...emptyLink(), operatorUnitId: 'u', cycle: '0' })).toEqual({ cycle: 'cycle' });
      expect(validateLink({ ...emptyLink(), operatorUnitId: 'u', cycle: '120' })).toEqual({});
      expect(validateLink({ ...emptyLink(), operatorUnitId: 'u', cycle: '6.5', nextDue: '01/03/2027', externalRef: 'x'.repeat(2001) })).toEqual({ cycle: 'cycle', nextDue: 'date', externalRef: 'tooLong' });
      expect(linkBody({ ...emptyLink(), operatorUnitId: unitId(1) })).toEqual({ operator_unit_id: unitId(1) });
      expect(linkBody({ operatorUnitId: unitId(1), documentVersionId: DOCUMENT.toUpperCase(), omContractId: ` ${DOCUMENT} `, cycle: '12', nextDue: '2027-01-01', externalRef: ' R ' })).toEqual({
        operator_unit_id: unitId(1),
        om_plan_document_version_id: DOCUMENT,
        om_contract_id: DOCUMENT,
        maintenance_cycle_months: 12,
        next_maintenance_due: '2027-01-01',
        external_system_ref: 'R',
      });
    });

    it('does not take a failure that is not the server\'s for one of its refusals', () => {
      expect(describeProblem(new Error('x'))).toBe('general');
      expect(describeProblem(problem('SOMETHING_NEW'))).toBe('general');
      expect(describeProblem(problem('FIELD_NOT_ALLOWED', 400))).toBe('validation');
      expect(describeProblem(problem('ENTITLEMENT_DENIED', 403))).toBe('denied');
    });
  });

  it('is reached from the asset dossier for a transferred asset only', async () => {
    const { default: AssetScreen } = await import('../asset/AssetScreen');
    const h = harness((operation) => {
      if (operation === 'get_resources_handover') return { items: [], next_cursor: null, as_of: 'x' };
      if (operation === 'get_resources_asset_record') return { items: [operated(), asset(2, { status: 'REGISTERED' })], next_cursor: null, as_of: 'x' };
      return new Error(`unexpected read ${operation}`);
    }, () => OK);
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.resolve([]));
    mount(<AssetScreen route={routeOf('AST-03', 'FR-AST-03')} />, h, { permissions: READER, path: '/ast/ast-03' });
    await screen.findByTestId('assets');
    const links = document.querySelectorAll('[data-om-link]');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(`/ast/ast-06?id=${assetId(1)}`);
  });
});
