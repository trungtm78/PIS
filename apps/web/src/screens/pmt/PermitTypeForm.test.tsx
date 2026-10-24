import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { PermitTypeForm } from './PermitTypeForm';
import { MANAGER, client, mount } from './test-support';

const TODAY = '2026-08-01';
const problem = (code: string, detail?: string, status = 409) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const submit = async (): Promise<void> => {
  await userEvent.setup().click(screen.getByRole('button', { name: vi_['pmt.type.save.action'] }));
};
const form = () => screen.getByRole('form', { name: vi_['pmt.type.form.aria'] });
const fieldError = (id: string): HTMLElement | null => (document.querySelector(`[data-field="${id}"] [role="alert"]`) as HTMLElement | null);
const NO_CODES: ReadonlySet<string> = new Set();

/** Fills what the form needs for the first revision of a permit type. */
function fillValid(): void {
  set(vi_['pmt.type.form.code.label'], 'BUILDING_PERMIT');
  set(vi_['pmt.type.form.name.label'], 'Giấy phép xây dựng');
  set(vi_['pmt.type.form.authority.label'], 'Sở Xây dựng');
  set(vi_['pmt.type.form.legalBasis.label'], 'Luật Xây dựng 135/2025, điều 43');
  set(vi_['pmt.type.form.effectiveFrom.label'], '2026-09-01');
}

describe('PermitTypeForm (PMT-03): publishing a permit type version', () => {
  it('offers the categories in the order of the contract', () => {
    mount(<PermitTypeForm today={TODAY} existingCodes={NO_CODES} />, client(), MANAGER);
    expect(within(screen.getByLabelText(vi_['pmt.type.form.category.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([
      vi_['pmt.category.environment.text'],
      vi_['pmt.category.designAppraisal.text'],
      vi_['pmt.category.fireSafety.text'],
      vi_['pmt.category.constructionPermit.text'],
      vi_['pmt.category.land.text'],
      vi_['pmt.category.traffic.text'],
      vi_['pmt.category.waterResources.text'],
      vi_['pmt.category.other.text'],
    ]);
  });

  it('says what is missing, the legal basis among it, and sends nothing until the form is complete (AC-ST-PMT-001-1)', async () => {
    const h = client();
    mount(<PermitTypeForm today={TODAY} existingCodes={NO_CODES} />, h, MANAGER);
    await submit();
    for (const id of ['type-code', 'type-name', 'type-authority', 'type-legal-basis', 'type-effective-from']) {
      expect(within(document.querySelector(`[data-field="${id}"]`) as HTMLElement).getByText(vi_['pmt.field.required.error'])).toBeTruthy();
    }
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['pmt.type.form.code.label'], 'bad code');
    set(vi_['pmt.type.form.cxn.label'], 'EXE-03');
    set(vi_['pmt.type.form.min.label'], '10');
    set(vi_['pmt.type.form.max.label'], '9');
    await submit();
    expect(fieldError('type-code')?.textContent).toBe(vi_['pmt.field.invalidCode.error']);
    expect(fieldError('type-cxn')?.textContent).toBe(vi_['pmt.field.invalidReference.error']);
    expect(fieldError('type-max')?.textContent).toBe(vi_['pmt.field.amountOrder.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('publishes a complete form with only what was filled in, then clears itself and says so', async () => {
    const h = client(() => ({ operation_id: 'o', status: 'PUBLISHED', resource_version: 1, resource_id: 'x' }));
    mount(<PermitTypeForm today={TODAY} existingCodes={NO_CODES} />, h, MANAGER);
    fillValid();
    set(vi_['pmt.type.form.category.label'], 'CONSTRUCTION_PERMIT');
    set(vi_['pmt.type.form.cxn.label'], 'CXN-EXE-02');
    set(vi_['pmt.type.form.groups.label'], 'A, B');
    set(vi_['pmt.type.form.validity.label'], '24');
    fireEvent.click(screen.getByLabelText(vi_['pmt.type.form.exempt.label']));
    await submit();
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('publishPermitType', {
        body: {
          code: 'BUILDING_PERMIT',
          name: 'Giấy phép xây dựng',
          category: 'CONSTRUCTION_PERMIT',
          authority_text: 'Sở Xây dựng',
          legal_basis: 'Luật Xây dựng 135/2025, điều 43',
          cxn_ref: 'CXN-EXE-02',
          effective_from: '2026-09-01',
          applies_to_rule: { project_group_keys: ['A', 'B'] },
          default_validity_months: 24,
          exemption_allowed: true,
        },
        attempt: expect.anything(),
      }),
    );
    expect(await screen.findByTestId('type-saved')).toBeTruthy();
    expect((screen.getByLabelText(vi_['pmt.type.form.code.label']) as HTMLInputElement).value).toBe('');
    // Typing again takes the notice away.
    set(vi_['pmt.type.form.code.label'], 'X');
    expect(screen.queryByTestId('type-saved')).toBeNull();
  });

  it('says that a code in the catalogue gets its next revision, and refuses a first day that has passed for it only', async () => {
    const h = client();
    mount(<PermitTypeForm today={TODAY} existingCodes={new Set(['BUILDING_PERMIT'])} />, h, MANAGER);
    expect(screen.queryByTestId('next-revision')).toBeNull();
    fillValid();
    expect(screen.getByTestId('next-revision').textContent).toBe(vi_['pmt.type.form.revision.notice']);
    set(vi_['pmt.type.form.effectiveFrom.label'], '2026-07-01');
    await submit();
    expect(fieldError('type-effective-from')?.textContent).toBe(vi_['pmt.field.past.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows the refusal of the server for an overlap, naming the rule', async () => {
    const h = client(() => problem('PERMIT_TYPE_OVERLAP'));
    mount(<PermitTypeForm today={TODAY} existingCodes={NO_CODES} />, h, MANAGER);
    fillValid();
    await submit();
    expect((await within(form()).findByRole('alert')).textContent).toBe(vi_['pmt.problem.overlap.error']);
    // Changing a field takes the refusal away.
    set(vi_['pmt.type.form.name.label'], 'Another name');
    expect(within(form()).queryByRole('alert')).toBeNull();
  });

  it('shows the refusal of the server for a missing legal basis, and a refused field on the field itself', async () => {
    let refusal = problem('LEGAL_BASIS_REQUIRED', 'legal_basis', 422);
    const h = client(() => refusal);
    mount(<PermitTypeForm today={TODAY} existingCodes={NO_CODES} />, h, MANAGER);
    fillValid();
    await submit();
    expect((await within(form()).findByRole('alert')).textContent).toBe(vi_['pmt.problem.legalBasis.error']);
    refusal = problem('VALIDATION_FAILED', 'effective_until', 422);
    await submit();
    await waitFor(() => expect(fieldError('type-effective-until')?.textContent).toBe(vi_['pmt.field.rejected.error']));
    // A refusal that names a field is shown on it, not as a general message.
    expect(within(form()).queryAllByRole('alert')).toHaveLength(1);
  });

  it('shows a general message for a failure that is not a problem of the server', async () => {
    mount(<PermitTypeForm today={TODAY} existingCodes={NO_CODES} />, client(() => new Error('network')), MANAGER);
    fillValid();
    await submit();
    expect((await within(form()).findByRole('alert')).textContent).toBe(vi_['pmt.problem.general.error']);
  });
});
