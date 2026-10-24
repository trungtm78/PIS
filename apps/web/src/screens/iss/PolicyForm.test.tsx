import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { PolicyForm } from './PolicyForm';
import { MANAGER, category, client, mount, unit, world } from './test-support';

const TODAY = '2026-08-01';
const problem = (code: string, detail?: string, status = 409) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const submit = async (): Promise<void> => {
  await userEvent.setup().click(screen.getByRole('button', { name: vi_['iss.sla.save.action'] }));
};
const form = () => screen.getByRole('form', { name: vi_['iss.sla.form.aria'] });

/** Fills what the form needs for a policy of two working days (16 hours) for the first category. */
async function fillValid(): Promise<void> {
  await waitFor(() => expect(within(form()).getAllByRole('option').length).toBeGreaterThan(3));
  set(vi_['iss.sla.form.code.label'], 'SLA-GPMB-HIGH');
  set(vi_['iss.sla.form.category.label'], category(1).version_id);
  set(vi_['iss.sla.form.severity.label'], 'HIGH');
  set(vi_['iss.sla.form.response.label'], '4');
  set(vi_['iss.sla.form.resolve.label'], '16');
  set(vi_['iss.sla.form.validFrom.label'], '2026-08-15');
}

describe('PolicyForm (ISS-09): publishing a policy', () => {
  it('offers the categories in force and the units, with the tenant default first', async () => {
    mount(<PolicyForm today={TODAY} />, client(world()), MANAGER);
    await waitFor(() => expect(screen.getAllByRole('option', { name: /GPMB-1/ })).toHaveLength(1));
    const categories = within(screen.getByLabelText(vi_['iss.sla.form.category.label'])).getAllByRole('option').map((option) => option.textContent);
    expect(categories).toEqual([vi_['iss.sla.form.category.option'], 'GPMB-1 · Giải phóng mặt bằng 1', 'GPMB-2 · Giải phóng mặt bằng 2']);
    await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.sla.form.unit.label'])).getAllByRole('option')).toHaveLength(2));
    expect(within(screen.getByLabelText(vi_['iss.sla.form.unit.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['iss.sla.unit.default.text'], `${unit(1).code} · ${unit(1).name}`]);
    expect(within(screen.getByLabelText(vi_['iss.sla.form.severity.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([
      vi_['iss.severity.low.text'],
      vi_['iss.severity.medium.text'],
      vi_['iss.severity.high.text'],
      vi_['iss.severity.critical.text'],
    ]);
  });

  it('says what is missing and sends nothing until the form is complete', async () => {
    const h = client(world());
    mount(<PolicyForm today={TODAY} />, h, MANAGER);
    await submit();
    for (const label of ['sla-code', 'sla-category', 'sla-response', 'sla-resolve', 'sla-valid-from']) {
      expect(within(document.querySelector(`[data-field="${label}"]`) as HTMLElement).getByText(vi_['iss.field.required.error'])).toBeTruthy();
    }
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['iss.sla.form.code.label'], 'bad code');
    set(vi_['iss.sla.form.response.label'], '30');
    set(vi_['iss.sla.form.resolve.label'], '10');
    set(vi_['iss.sla.form.level2.label'], '150');
    set(vi_['iss.sla.form.validFrom.label'], '2026-07-31');
    await submit();
    expect(screen.getByText(vi_['iss.field.invalidCode.error'])).toBeTruthy();
    expect(screen.getByText(vi_['iss.field.resolveOrder.error'])).toBeTruthy();
    expect(screen.getByText(vi_['iss.field.levelOrder.error'])).toBeTruthy();
    expect(screen.getByText(vi_['iss.field.past.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    // The error of a field goes away when the field is changed.
    set(vi_['iss.sla.form.code.label'], 'SLA-OK');
    expect(screen.queryByText(vi_['iss.field.invalidCode.error'])).toBeNull();
  });

  it('publishes a policy of two working days with the thresholds of the contract, then empties the form (AC-ST-ISS-001-1)', async () => {
    const h = client(world(), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: category(1).id }));
    mount(<PolicyForm today={TODAY} />, h, MANAGER);
    await fillValid();
    await submit();
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'upsertIssueSlaPolicy',
        expect.objectContaining({
          body: {
            code: 'SLA-GPMB-HIGH',
            category_version_id: category(1).version_id,
            severity: 'HIGH',
            calendar_code: 'WORKDAY_VN',
            response_hours: 4,
            resolve_hours: 16,
            escalate_l2_pct: 100,
            escalate_l3_pct: 150,
            require_independent_verifier: true,
            require_evidence: true,
            valid_from: '2026-08-15',
          },
        }),
      ),
    );
    expect((await screen.findByTestId('policy-saved')).textContent).toBe(vi_['iss.sla.saved.notice']);
    expect((screen.getByLabelText(vi_['iss.sla.form.code.label']) as HTMLInputElement).value).toBe('');
    // Typing again removes the notice.
    set(vi_['iss.sla.form.code.label'], 'SLA-NEXT');
    expect(screen.queryByTestId('policy-saved')).toBeNull();
  });

  it('sends the unit, the thresholds and the closing rules that were chosen', async () => {
    const h = client(world(), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: category(1).id }));
    mount(<PolicyForm today={TODAY} />, h, MANAGER);
    await fillValid();
    await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.sla.form.unit.label'])).getAllByRole('option')).toHaveLength(2));
    set(vi_['iss.sla.form.unit.label'], unit(1).id);
    set(vi_['iss.sla.form.level2.label'], '80');
    set(vi_['iss.sla.form.level3.label'], '120');
    set(vi_['iss.sla.form.calendar.label'], 'WORKDAY_HCM');
    fireEvent.click(screen.getByLabelText(vi_['iss.sla.form.verifier.label']));
    fireEvent.click(screen.getByLabelText(vi_['iss.sla.form.evidence.label']));
    await submit();
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'upsertIssueSlaPolicy',
        expect.objectContaining({ body: expect.objectContaining({ owner_unit_id: unit(1).id, escalate_l2_pct: 80, escalate_l3_pct: 120, calendar_code: 'WORKDAY_HCM', require_independent_verifier: false, require_evidence: false }) }),
      ),
    );
  });

  it('shows that another policy overlaps and keeps what was typed (AC-ST-ISS-001-2)', async () => {
    const h = client(world(), () => problem('SLA_POLICY_OVERLAP'));
    mount(<PolicyForm today={TODAY} />, h, MANAGER);
    await fillValid();
    await submit();
    expect((await within(form()).findByRole('alert')).textContent).toBe(vi_['iss.problem.overlap.error']);
    expect((screen.getByLabelText(vi_['iss.sla.form.code.label']) as HTMLInputElement).value).toBe('SLA-GPMB-HIGH');
    expect(screen.queryByTestId('policy-saved')).toBeNull();
    // Changing a field clears the refusal.
    set(vi_['iss.sla.form.code.label'], 'SLA-OTHER');
    await waitFor(() => expect(within(form()).queryByRole('alert')).toBeNull());
  });

  it('puts a rejection that names a field on that field, and any other refusal in a message above the form', async () => {
    let answer: ApiError = problem('VALIDATION_FAILED', 'calendar_code', 422);
    const h = client(world(), () => answer);
    mount(<PolicyForm today={TODAY} />, h, MANAGER);
    await fillValid();
    await submit();
    const calendar = document.querySelector('[data-field="sla-calendar"]') as HTMLElement;
    expect((await within(calendar).findByRole('alert')).textContent).toBe(vi_['iss.field.rejected.error']);
    expect(within(form()).getAllByRole('alert')).toHaveLength(1);
    answer = problem('VALIDATION_FAILED', 'something_unknown', 422);
    set(vi_['iss.sla.form.code.label'], 'SLA-AGAIN');
    await submit();
    expect((await within(form()).findByRole('alert')).textContent).toBe(vi_['iss.problem.validation.error']);
    answer = problem('SCOPE_DENIED', undefined, 403);
    set(vi_['iss.sla.form.code.label'], 'SLA-DENIED');
    await submit();
    expect((await within(form()).findByRole('alert')).textContent).toBe(vi_['iss.problem.denied.error']);
  });

  it('says when the categories or the units could not be read', async () => {
    mount(<PolicyForm today={TODAY} />, client(world({ failing: new Set(['searchMasterRecords', 'get_resources_organization_unit']) })), MANAGER);
    expect(await screen.findByText(vi_['iss.sla.categories.error'])).toBeTruthy();
    expect(await screen.findByText(vi_['iss.sla.units.error'])).toBeTruthy();
    expect(within(screen.getByLabelText(vi_['iss.sla.form.category.label'])).getAllByRole('option')).toHaveLength(1);
  });
});
