import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditionProvider } from '../../editions/EditionContext';
import { PUBLIC_BUNDLE } from '../../editions/edition';
import type { WebEditionBundle } from '../../editions/edition';
import vi_ from '../../i18n/vi.json';
import AppropriationBookScreen from './AppropriationBookScreen';
import { DOCUMENT, FUND_NSDP, PLANNER, client, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('CAP-16', 'FR-CAP-16');
const ENTERPRISE = { manifest: { ...PUBLIC_BUNDLE.manifest, edition: 'enterprise' } } as unknown as WebEditionBundle;
const answer = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: '00000000-0000-4000-8000-000000000999' };

afterEach(cleanup);

const formScope = () => within(document.querySelector<HTMLElement>('form.cap-form') ?? document.body);
const set = (label: string, value: string): void => {
  fireEvent.change(formScope().getByLabelText(label), { target: { value } });
};
const optionValues = (label: string): string[] => within(formScope().getByLabelText(label)).getAllByRole('option').map((option) => (option as HTMLOptionElement).value);

/** CAP-16 in the enterprise edition (ENT-3e): the register of the edition refuses the origins and the levels of the public pack, so the form must open on a line it accepts. */
describe('AppropriationBookScreen (CAP-16) in the enterprise edition', () => {
  const open = async (edition: WebEditionBundle) => {
    const h = client(world(), () => answer);
    mount(
      <EditionProvider edition={edition}>
        <AppropriationBookScreen route={ROUTE} />
      </EditionProvider>,
      h,
      { permissions: PLANNER },
    );
    await waitFor(() => expect(document.querySelectorAll('tr[data-appropriation-id]').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.book.register.action'] }));
    await waitFor(() => expect(within(formScope().getByLabelText(vi_['cap.form.fund.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    return h;
  };

  it('opens on an origin, a level and a kind of document of the enterprise pack, and offers no public origin or level', async () => {
    await open(ENTERPRISE);
    expect(optionValues(vi_['cap.form.origin.label'])).toEqual(['GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER']);
    expect(optionValues(vi_['cap.form.level.label'])).toEqual(['ALL']);
    expect(optionValues(vi_['cap.form.decisionKind.label'])).toEqual(['GROUP_RESOLUTION', 'GROUP_DECISION']);
    expect((formScope().getByLabelText(vi_['cap.form.origin.label']) as HTMLSelectElement).value).toBe('GROUP_ASSIGNED');
    expect((formScope().getByLabelText(vi_['cap.form.decisionKind.label']) as HTMLSelectElement).value).toBe('GROUP_RESOLUTION');
  });

  it('sends the default origin, level and kind when only the required fields are filled in, and the kinds follow the origin', async () => {
    const h = await open(ENTERPRISE);
    set(vi_['cap.form.fund.label'], FUND_NSDP);
    set(vi_['cap.form.year.label'], '2027');
    set(vi_['cap.form.amount.label'], '100');
    set(vi_['cap.form.decision.label'], DOCUMENT);
    set(vi_['cap.form.authority.label'], 'Hội đồng thành viên');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('registerAppropriation');
    expect(input.body).toMatchObject({ origin: 'GROUP_ASSIGNED', budget_level: 'ALL', decision_kind: 'GROUP_RESOLUTION', plan_year: 2027, source_year: 2027 });
    await waitFor(() => expect(formScope().queryByLabelText(vi_['cap.form.fund.label'])).toBeNull());
  });

  it('moves to a kind of the company when the origin becomes the decision of the company', async () => {
    await open(ENTERPRISE);
    set(vi_['cap.form.origin.label'], 'BOARD_APPROVED');
    expect(optionValues(vi_['cap.form.decisionKind.label'])).toEqual(['COMPANY_RESOLUTION', 'COMPANY_DECISION']);
    expect((formScope().getByLabelText(vi_['cap.form.decisionKind.label']) as HTMLSelectElement).value).toBe('COMPANY_RESOLUTION');
  });

  it('lists the origins and the level of the enterprise pack in the filters from the start, then any other the book holds', async () => {
    await open(ENTERPRISE);
    const filter = (label: string): string[] => within(within(screen.getByRole('search')).getByLabelText(label)).getAllByRole('option').map((option) => (option as HTMLOptionElement).value);
    // The book of the test holds public lines: they are listed after the origins and the level of the pack, and the pack's own come first.
    expect(filter(vi_['cap.book.origin.label']).slice(0, 4)).toEqual(['', 'GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER']);
    expect(filter(vi_['cap.book.level.label']).slice(0, 2)).toEqual(['', 'ALL']);
  });

  it('keeps the public form as it was: the five origins, the two levels, no kind of document', async () => {
    await open(PUBLIC_BUNDLE);
    expect(optionValues(vi_['cap.form.origin.label'])).toEqual(['PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE']);
    expect(optionValues(vi_['cap.form.level.label'])).toEqual(['CENTRAL', 'LOCAL']);
    expect(formScope().queryByLabelText(vi_['cap.form.decisionKind.label'])).toBeNull();
  });
});
