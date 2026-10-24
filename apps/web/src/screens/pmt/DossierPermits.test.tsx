import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { DossierPermits } from './DossierPermits';
import { toDossier } from './dossier-model';
import type { DossierView } from './dossier-model';
import { OFFICER, TODAY, client, dossier, mount, permitId, permitLine, world } from './dossier-test-support';
import { toPermitType } from './model';
import type { PermitTypeView } from './model';
import { permitType } from './test-support';

afterEach(cleanup);

const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const types = (...rows: Array<Record<string, unknown>>): PermitTypeView[] => rows.flatMap((row) => toPermitType(row) ?? []);
const show = (view: DossierView, catalogue: PermitTypeView[], options: { mayAdd?: boolean; command?: (operation: string, input: unknown) => unknown } = {}) => {
  const h = client(world(), options.command);
  mount(<DossierPermits dossier={view} types={catalogue} today={TODAY} mayAdd={options.mayAdd ?? true} />, h, { permissions: OFFICER });
  return h;
};
const read = (...permits: Array<Record<string, unknown>>): DossierView => toDossier(dossier(1, permits)) as DossierView;
const row = (n: number): HTMLElement => document.querySelector(`tr[data-permit-id="${permitId(n)}"]`) as HTMLElement;

describe('DossierPermits (PMT-01): the permits of one dossier', () => {
  it('shows each permit with the version of its type, its status as a word, its number and days in force, and the way to its detail (UI-PMT-01, AC-ST-PMT-002-1)', () => {
    show(
      read(
        permitLine(1, { status: 'ISSUED', permit_no: 'GP-0001', valid_from: '2026-01-01', valid_until: '2026-12-01', permit_type_revision: 2 }),
        permitLine(2, { is_required: false, cxn_ref: 'CXN-EXE-03', responsible_membership: { membership_id: 'm', display_name: 'Trần B' } }),
      ),
      types(permitType(3)),
    );
    const issued = within(row(1));
    expect(issued.getByText(vi_['pmt.dossier.revision.text'].replace('{revision}', '2'))).toBeTruthy();
    expect(issued.getByText(vi_['pmt.permit.status.issued.text']).className).toContain('green');
    expect(issued.getByText('GP-0001')).toBeTruthy();
    expect(issued.getByText(/2026-01-01 → 2026-12-01/)).toBeTruthy();
    expect(issued.getByTestId('remaining').textContent).toBe(vi_['pmt.dossier.remaining.days.text'].replace('{days}', '38'));
    expect(issued.getByTestId('remaining').className).toContain('warn');
    expect(issued.getByText(vi_['pmt.dossier.required.yes.text'])).toBeTruthy();
    expect(issued.getByRole('link', { name: vi_['pmt.dossier.detail.action'] }).getAttribute('href')).toBe(`/pmt/pmt-02?permit=${permitId(1)}`);
    const planned = within(row(2));
    expect(planned.getByText(vi_['pmt.dossier.optional.text'])).toBeTruthy();
    expect(planned.getByTestId('unconfirmed').textContent).toBe(vi_['pmt.type.unconfirmed.text'].replace('{cxn}', 'CXN-EXE-03'));
    expect(planned.getByText(vi_['pmt.permit.status.planned.text']).className).toContain('gray');
    expect(planned.getByText(vi_['pmt.dossier.number.none.text'])).toBeTruthy();
    expect(planned.getByText('Trần B')).toBeTruthy();
    expect(planned.getByText(vi_['pmt.dossier.validity.none.text'])).toBeTruthy();
  });

  it('says a permit has no expiry, counts a long validity as no warning, and shows no time left for a permit that is not valid', () => {
    show(
      read(
        permitLine(1, { status: 'ISSUED', permit_no: 'A', valid_from: '2026-01-01', no_expiry: true }),
        permitLine(2, { status: 'ISSUED', permit_no: 'B', valid_from: '2026-01-01', valid_until: '2027-12-31' }),
        permitLine(3, { status: 'EXPIRED', permit_no: 'C', valid_from: '2025-01-01', valid_until: '2025-12-31' }),
      ),
      types(),
    );
    expect(within(row(1)).getAllByText(vi_['pmt.dossier.remaining.none.text']).length).toBeGreaterThan(0);
    expect(within(row(2)).getByTestId('remaining').className).not.toContain('warn');
    expect(within(row(3)).queryByTestId('remaining')).toBeNull();
    expect(within(row(3)).getByText(vi_['pmt.permit.status.expired.text']).className).toContain('red');
  });

  it('offers to add a permit of a type in force that the dossier does not hold, and sends it (AC-ST-PMT-002-1)', async () => {
    const h = show(read(permitLine(1, { permit_type_code: 'PERMIT_1' })), types(permitType(1), permitType(2, { name: 'Giấy phép hai' }), permitType(3, { status: 'RETIRED', effective_until: '2026-01-31', effective_from: '2025-01-01' })), {
      command: () => ({ operation_id: 'o', status: 'PLANNED', resource_version: 1, resource_id: 'x' }),
    });
    const form = screen.getByRole('form', { name: vi_['pmt.dossier.add.aria'] });
    expect(within(form).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['pmt.dossier.add.type.placeholder'], 'PERMIT_2 · Giấy phép hai']);
    const user = userEvent.setup();
    await user.click(within(form).getByRole('button', { name: vi_['pmt.dossier.add.action'] }));
    expect(within(form).getByText(vi_['pmt.permit.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.selectOptions(within(form).getByLabelText(vi_['pmt.dossier.add.type.label']), 'PERMIT_2 · Giấy phép hai');
    fireEvent.change(within(form).getByLabelText(vi_['pmt.dossier.add.expected.label']), { target: { value: '2026-12-31' } });
    await user.click(within(form).getByRole('button', { name: vi_['pmt.dossier.add.action'] }));
    await screen.findByTestId('permit-added');
    expect(h.command).toHaveBeenCalledWith(
      'addPermit',
      expect.objectContaining({ path: { id: dossier(1).id }, body: { permit_type_id: permitType(2).id, expected_decision_on: '2026-12-31' } }),
    );
  });

  it('says why a permit was refused, and that every type in force is already held', async () => {
    const h = show(read(permitLine(1)), types(permitType(2)), { command: () => problem('PERMIT_ALREADY_CURRENT') });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['pmt.dossier.add.type.label']), permitType(2).id);
    await user.click(screen.getByRole('button', { name: vi_['pmt.dossier.add.action'] }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['pmt.permit.problem.alreadyCurrent.error']);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    cleanup();
    show(read(permitLine(1, { permit_type_code: 'PERMIT_1' })), types(permitType(1)));
    expect(screen.getByTestId('nothing-to-add').textContent).toBe(vi_['pmt.dossier.add.none.text']);
  });

  it('shows no form to someone who may not add', () => {
    show(read(permitLine(1)), types(permitType(2)), { mayAdd: false });
    expect(screen.queryByRole('form', { name: vi_['pmt.dossier.add.aria'] })).toBeNull();
    expect(screen.queryByTestId('nothing-to-add')).toBeNull();
  });
});
