import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PermitTypeCatalogueScreen from './PermitTypeCatalogueScreen';
import { MANAGER, READER, client, mount, permitType, routeOf } from './test-support';

const ROUTE = routeOf('PMT-03', 'FR-PMT-03');
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-group-code]'));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));

describe('PermitTypeCatalogueScreen (PMT-03): the catalogue of permit types', () => {
  it('reads the catalogue of the tenant and shows each code with the version that matters, with the form for the one who manages it (UI-PMT-03, AC-ST-PMT-001-1)', async () => {
    const h = client(undefined, () => [permitType(2, { cxn_ref: 'CXN-EXE-03' }), permitType(1)]);
    mount(<PermitTypeCatalogueScreen route={ROUTE} />, h, MANAGER);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pmt.type.page.title']);
    expect(rows().map((row) => row.getAttribute('data-group-code'))).toEqual(['PERMIT_1', 'PERMIT_2']);
    expect(screen.getByTestId('unconfirmed-banner')).toBeTruthy();
    expect(screen.getByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeTruthy();
    expect(document.querySelector('[data-screen-id="PMT-03"]')).toBeTruthy();
  });

  it('shows the catalogue and no form to someone who may only read it', async () => {
    mount(<PermitTypeCatalogueScreen route={ROUTE} />, client(undefined, () => [permitType(1)]), READER);
    await ready();
    expect(screen.queryByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeNull();
  });

  it('shows an empty catalogue as a screen of its own with the form that publishes the first version, not as an empty state', async () => {
    mount(<PermitTypeCatalogueScreen route={ROUTE} />, client(), MANAGER);
    expect((await screen.findByTestId('empty-catalogue')).textContent).toBe(vi_['pmt.type.empty.text']);
    expect(screen.getByRole('form', { name: vi_['pmt.type.form.aria'] })).toBeTruthy();
  });

  it('shows the list again after a version is published', async () => {
    let published = false;
    const h = client(
      () => {
        published = true;
        return { operation_id: 'o', status: 'PUBLISHED', resource_version: 1, resource_id: 'x' };
      },
      () => (published ? [permitType(1)] : []),
    );
    mount(<PermitTypeCatalogueScreen route={ROUTE} />, h, MANAGER);
    await screen.findByTestId('empty-catalogue');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['pmt.type.form.code.label']), 'ENV_EIA');
    await user.type(screen.getByLabelText(vi_['pmt.type.form.name.label']), 'EIA');
    await user.type(screen.getByLabelText(vi_['pmt.type.form.authority.label']), 'Authority');
    await user.type(screen.getByLabelText(vi_['pmt.type.form.legalBasis.label']), 'Law 2020');
    await user.type(screen.getByLabelText(vi_['pmt.type.form.effectiveFrom.label']), '2026-01-01');
    await user.click(screen.getByRole('button', { name: vi_['pmt.type.save.action'] }));
    await ready();
    expect(rows().map((row) => row.getAttribute('data-group-code'))).toEqual(['PERMIT_1']);
  });

  it('says so when the read is refused, fails or the session ended, and reads again on retry', async () => {
    let answer: Array<Record<string, unknown>> | Error = problem(403, 'SCOPE_DENIED');
    const h = client(undefined, () => answer);
    mount(<PermitTypeCatalogueScreen route={ROUTE} />, h, MANAGER);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    answer = new Error('boom');
    const failing = mount(<PermitTypeCatalogueScreen route={ROUTE} />, client(undefined, () => answer), MANAGER);
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    answer = [permitType(1)];
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    failing.unmount();
  });
});
