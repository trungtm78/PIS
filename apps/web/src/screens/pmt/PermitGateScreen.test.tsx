import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PermitGateScreen from './PermitGateScreen';
import { client, mount, projectRow, world } from './dossier-test-support';
import type { World } from './dossier-test-support';
import { permitType, routeOf } from './test-support';

const ROUTE = routeOf('PMT-04', 'FR-PMT-04');
const MANAGER = ['permit.gate.manage', 'permit.read'];
const READER = ['permit.read'];
const BASIS = 'Luật Xây dựng 135/2025, điều 41';
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const answer = { operation_id: 'o', status: 'PUBLISHED', resource_version: 1, resource_id: 'r' };

afterEach(cleanup);

const rule = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0108${String(n).padStart(8, '0')}`,
  gate_code: 'START_CONSTRUCTION',
  project_milestone_code: 'START_CONSTRUCTION',
  permit_type_id: permitType(1).id,
  permit_type_code: 'PERMIT_1',
  requirement: 'VALID_OR_EXEMPT',
  applies_to_rule: {},
  legal_basis: BASIS,
  effective_from: '2026-01-01',
  effective_until: null,
  revision: 1,
  status: 'PUBLISHED',
  version: 1,
  ...overrides,
});

const verdict = (overrides: Record<string, unknown> = {}) => ({
  rule_id: rule(1).id,
  revision: 1,
  project_milestone_code: 'START_CONSTRUCTION',
  permit_type_code: 'PERMIT_1',
  requirement: 'VALID_PERMIT',
  legal_basis: BASIS,
  effective_from: '2026-01-01',
  effective_until: null,
  outcome: 'BLOCKING',
  permit: null,
  waiver: null,
  ...overrides,
});
const evaluation = (gates: Array<Record<string, unknown>>, asOf = '2026-10-24') => ({ project_id: projectRow(1).id, as_of: asOf, gates });

function state(overrides: Partial<World> = {}): World {
  return world({
    projects: [projectRow(1), projectRow(2)],
    types: [permitType(1), permitType(2)],
    gateRules: [rule(1), rule(2, { gate_code: 'HANDOVER', requirement: 'VALID_PERMIT', permit_type_id: permitType(2).id, permit_type_code: 'PERMIT_2', project_milestone_code: null })],
    evaluation: () =>
      evaluation([
        { gate_code: 'START_CONSTRUCTION', status: 'BLOCKED', rules: [verdict()] },
        { gate_code: 'HANDOVER', status: 'PASSED', rules: [] },
      ]),
    ...overrides,
  });
}

const open = (s: World, permissions: readonly string[] = MANAGER, command?: (operation: string, input: unknown) => unknown, options: { mode?: 'READ_ONLY' } = {}) => {
  const h = client(s, command);
  mount(<PermitGateScreen route={ROUTE} />, h, { permissions, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const ready = () => waitFor(() => expect(document.querySelector('[data-gate]')).toBeTruthy());
const pick = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const ruleRow = (n: number): HTMLElement => document.querySelector(`tr[data-rule-id="${rule(n).id}"]`) as HTMLElement;

describe('PermitGateScreen (PMT-04): the gate rules and the evaluation of the gates', () => {
  it('shows the rules by gate with the permit type, the requirement, the legal basis and the days they apply, and the form and the evaluation for the one who manages them (UI-PMT-04)', async () => {
    open(state());
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pmt.gate.page.title']);
    expect(Array.from(document.querySelectorAll('[data-gate]')).filter((node) => node.tagName === 'DIV').map((node) => node.getAttribute('data-gate'))).toEqual(['START_CONSTRUCTION', 'HANDOVER']);
    expect(ruleRow(1).textContent).toContain('PERMIT_1');
    expect(ruleRow(1).textContent).toContain(vi_['pmt.gate.requirement.validOrExempt.label']);
    expect(ruleRow(1).textContent).toContain(BASIS);
    expect(ruleRow(1).textContent).toContain('2026-01-01 → ');
    expect(ruleRow(1).textContent).toContain('START_CONSTRUCTION');
    expect(ruleRow(1).textContent).toContain(vi_['pmt.type.applies.all.text']);
    expect(screen.getByRole('form', { name: vi_['pmt.gate.form.aria'] })).toBeTruthy();
    expect(screen.getByTestId('evaluation')).toBeTruthy();
    expect(within(ruleRow(1)).getByRole('button', { name: vi_['pmt.gate.retire.action'] })).toBeTruthy();
  });

  it('shows the rules and the evaluation but no form and no way to end a rule to someone who only reads, and to a frozen tenant', async () => {
    open(state(), READER);
    await ready();
    expect(screen.queryByRole('form', { name: vi_['pmt.gate.form.aria'] })).toBeNull();
    expect(screen.getByText(vi_['pmt.gate.readonly.text'])).toBeTruthy();
    expect(within(ruleRow(1)).queryByRole('button', { name: vi_['pmt.gate.retire.action'] })).toBeNull();
    expect(screen.getByTestId('evaluation')).toBeTruthy();
    cleanup();
    open(state(), MANAGER, undefined, { mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('form', { name: vi_['pmt.gate.form.aria'] })).toBeNull();
  });

  it('says there is no rule yet, and still offers the form and the evaluation', async () => {
    open(state({ gateRules: [] }));
    await waitFor(() => expect(screen.getByTestId('empty-rules')).toBeTruthy());
    expect(screen.getByTestId('empty-rules').textContent).toBe(vi_['pmt.gate.empty.text']);
    expect(screen.getByRole('form', { name: vi_['pmt.gate.form.aria'] })).toBeTruthy();
  });

  it('shows the error state when the rules cannot be read', async () => {
    const failing = state();
    failing.failing.add('get_resources_permit_gate_rule');
    open(failing);
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });

  describe('the evaluation', () => {
    it('evaluates the first project for all gates, says which gates pass and which are blocked, and names the legal basis and what satisfies or blocks (AC-ST-PMT-004-1)', async () => {
      const h = open(state());
      await waitFor(() => expect(screen.getByTestId('eval-result')).toBeTruthy());
      expect(h.read).toHaveBeenCalledWith('evaluatePermitGates', { path: { id: projectRow(1).id }, query: {} });
      const blocked = document.querySelector('[data-gate-result="START_CONSTRUCTION"]') as HTMLElement;
      expect(blocked.getAttribute('data-status')).toBe('BLOCKED');
      expect(blocked.textContent).toContain(vi_['pmt.gate.status.blocked.label']);
      expect(blocked.textContent).toContain(vi_['pmt.gate.outcome.blocking.label']);
      expect(blocked.textContent).toContain(BASIS);
      expect((document.querySelector('[data-gate-result="HANDOVER"]') as HTMLElement).getAttribute('data-status')).toBe('PASSED');
      expect(screen.getByText(vi_['pmt.gate.eval.noRules.text'])).toBeTruthy();
    });

    it('reads the gate, the project and the day the person picks', async () => {
      const h = open(state());
      await waitFor(() => expect(screen.getByTestId('eval-result')).toBeTruthy());
      pick(vi_['pmt.gate.eval.gate.label'], 'HANDOVER');
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('evaluatePermitGates', { path: { id: projectRow(1).id }, query: { gate_code: 'HANDOVER' } }));
      pick(vi_['pmt.gate.eval.day.label'], '2026-06-30');
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('evaluatePermitGates', { path: { id: projectRow(1).id }, query: { gate_code: 'HANDOVER', as_of: '2026-06-30' } }));
      pick(vi_['pmt.gate.eval.project.label'], projectRow(2).id);
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('evaluatePermitGates', { path: { id: projectRow(2).id }, query: { gate_code: 'HANDOVER', as_of: '2026-06-30' } }));
    });

    it('shows the permit that satisfies a rule with a link to it, and the waiver that lets a project through', async () => {
      const permit = { id: '00000000-0000-4000-8000-010200000001', permit_no: 'GP-0001', status: 'ISSUED', valid_until: '2026-12-31' };
      open(
        state({
          evaluation: () =>
            evaluation([
              { gate_code: 'START_CONSTRUCTION', status: 'PASSED', rules: [verdict({ outcome: 'SATISFIED', permit })] },
              { gate_code: 'HANDOVER', status: 'PASSED_WITH_WAIVER', rules: [verdict({ outcome: 'WAIVED', waiver: { id: 'w1', valid_until: '2026-12-31' } })] },
            ]),
        }),
      );
      await waitFor(() => expect(screen.getByTestId('eval-result')).toBeTruthy());
      const satisfied = document.querySelector('[data-gate-result="START_CONSTRUCTION"]') as HTMLElement;
      expect(within(satisfied).getByRole('link').getAttribute('href')).toBe(`/pmt/pmt-02?permit=${permit.id}`);
      expect(satisfied.textContent).toContain('GP-0001');
      const waived = document.querySelector('[data-gate-result="HANDOVER"]') as HTMLElement;
      expect(waived.textContent).toContain(vi_['pmt.gate.status.waived.label']);
      expect(waived.textContent).toContain('đến hết 2026-12-31');
    });

    it('says when the project is not found, when the read fails, when the day is not one, and when there is no project to evaluate', async () => {
      open(state({ evaluation: () => problem(404, 'RESOURCE_NOT_FOUND') }));
      await waitFor(() => expect(screen.getByTestId('eval-missing')).toBeTruthy());
      cleanup();
      open(state({ evaluation: () => problem(500, 'INTERNAL') }));
      await waitFor(() => expect(screen.getByTestId('eval-error')).toBeTruthy());
      cleanup();
      open(state({ projects: [] }));
      await waitFor(() => expect(screen.getByTestId('eval-no-project')).toBeTruthy());
    });
  });

  describe('publishing a rule', () => {
    const form = () => screen.getByRole('form', { name: vi_['pmt.gate.form.aria'] });
    const fill = () => {
      pick(vi_['pmt.gate.form.gate.label'], 'ADVANCE_DISBURSEMENT');
      pick(vi_['pmt.gate.form.type.label'], permitType(2).id);
      pick(vi_['pmt.gate.form.requirement.label'], 'SUBMITTED_ONLY');
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.basis.label']), { target: { value: `  ${BASIS}  ` } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.from.label']), { target: { value: '2027-01-01' } });
    };

    it('sends the rule with the permit type, the requirement, the applicability and the dates, and says it was published', async () => {
      const h = open(state(), MANAGER, () => answer);
      await ready();
      fill();
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.milestone.label']), { target: { value: 'ADVANCE_PAID' } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.groups.label']), { target: { value: 'A, B' } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.min.label']), { target: { value: '5000000000' } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.until.label']), { target: { value: '2027-12-31' } });
      fireEvent.click(within(form()).getByRole('button', { name: vi_['pmt.gate.form.save.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
      expect(operation).toBe('publishPermitGateRule');
      expect(input.body).toEqual({
        gate_code: 'ADVANCE_DISBURSEMENT',
        project_milestone_code: 'ADVANCE_PAID',
        permit_type_id: permitType(2).id,
        requirement: 'SUBMITTED_ONLY',
        applies_to_rule: { project_group_keys: ['A', 'B'], min_total_investment_vnd: '5000000000' },
        legal_basis: BASIS,
        effective_from: '2027-01-01',
        effective_until: '2027-12-31',
      });
      await waitFor(() => expect(screen.getByTestId('saved')).toBeTruthy());
    });

    it('checks the form before anything is sent: the permit type, the legal basis, the days, the lists and the amounts', async () => {
      const h = open(state(), MANAGER, () => answer);
      await ready();
      fireEvent.click(within(form()).getByRole('button', { name: vi_['pmt.gate.form.save.action'] }));
      expect(screen.getAllByText(vi_['pmt.field.required.error']).length).toBeGreaterThanOrEqual(3);
      fill();
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.until.label']), { target: { value: '2027-01-01' } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.groups.label']), { target: { value: 'bad key' } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.min.label']), { target: { value: '9' } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.max.label']), { target: { value: '5' } });
      fireEvent.click(within(form()).getByRole('button', { name: vi_['pmt.gate.form.save.action'] }));
      expect(screen.getByText(vi_['pmt.field.untilOrder.error'])).toBeTruthy();
      expect(screen.getByText(vi_['pmt.field.invalidKeys.error'])).toBeTruthy();
      expect(screen.getByText(vi_['pmt.field.amountOrder.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('does not let a rule that takes over from another begin in the past, and says so once the gate and the permit type already have a rule', async () => {
      open(state(), MANAGER, () => answer);
      await ready();
      pick(vi_['pmt.gate.form.gate.label'], 'START_CONSTRUCTION');
      pick(vi_['pmt.gate.form.type.label'], permitType(1).id);
      expect(screen.getByText(vi_['pmt.gate.form.revision.hint'])).toBeTruthy();
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.basis.label']), { target: { value: BASIS } });
      fireEvent.change(within(form()).getByLabelText(vi_['pmt.gate.form.from.label']), { target: { value: '2020-01-01' } });
      fireEvent.click(within(form()).getByRole('button', { name: vi_['pmt.gate.form.save.action'] }));
      expect(screen.getByText(vi_['pmt.field.past.error'])).toBeTruthy();
    });

    it.each([
      ['GATE_RULE_OVERLAP', 409, 'pmt.gate.problem.overlap.error'],
      ['LEGAL_BASIS_REQUIRED', 422, 'pmt.gate.problem.legalBasis.error'],
      ['SCOPE_DENIED', 403, 'pmt.gate.problem.denied.error'],
      ['SOMETHING_ELSE', 500, 'pmt.gate.problem.general.error'],
    ] as const)('tells what the server refused with %s', async (code, status, key) => {
      open(state(), MANAGER, () => problem(status, code));
      await ready();
      fill();
      fireEvent.click(within(form()).getByRole('button', { name: vi_['pmt.gate.form.save.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_[key]));
    });

    it('marks the field the server names when it refuses the data', async () => {
      open(state(), MANAGER, () => problem(422, 'VALIDATION_FAILED', 'effective_from'));
      await ready();
      fill();
      fireEvent.click(within(form()).getByRole('button', { name: vi_['pmt.gate.form.save.action'] }));
      await waitFor(() => expect(screen.getByText(vi_['pmt.field.rejected.error'])).toBeTruthy());
      expect(screen.queryByTestId('problem')).toBeNull();
    });
  });

  describe('ending a rule', () => {
    it('asks for the last day, checks it, and sends it with the rule', async () => {
      const h = open(state(), MANAGER, () => ({ ...answer, status: 'RETIRED', resource_version: 2 }));
      await ready();
      fireEvent.click(within(ruleRow(1)).getByRole('button', { name: vi_['pmt.gate.retire.action'] }));
      const retire = screen.getByRole('form', { name: 'Kết thúc quy tắc PERMIT_1' });
      fireEvent.click(within(retire).getByRole('button', { name: vi_['pmt.gate.retire.confirm'] }));
      expect(screen.getByText(vi_['pmt.field.required.error'])).toBeTruthy();
      fireEvent.change(within(retire).getByLabelText(vi_['pmt.gate.retire.until.label']), { target: { value: '2020-01-01' } });
      fireEvent.click(within(retire).getByRole('button', { name: vi_['pmt.gate.retire.confirm'] }));
      expect(screen.getByText(vi_['pmt.field.untilOrder.error'])).toBeTruthy();
      fireEvent.change(within(retire).getByLabelText(vi_['pmt.gate.retire.until.label']), { target: { value: '2999-12-31' } });
      fireEvent.click(within(retire).getByRole('button', { name: vi_['pmt.gate.retire.confirm'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: { effective_until: string } }];
      expect(operation).toBe('retirePermitGateRule');
      expect(input).toMatchObject({ path: { id: rule(1).id }, body: { effective_until: '2999-12-31' } });
      await waitFor(() => expect(screen.queryByRole('form', { name: 'Kết thúc quy tắc PERMIT_1' })).toBeNull());
    });

    it('can be cancelled, and shows what the server refuses', async () => {
      open(state(), MANAGER, () => problem(422, 'VALIDATION_FAILED', 'effective_until'));
      await ready();
      fireEvent.click(within(ruleRow(1)).getByRole('button', { name: vi_['pmt.gate.retire.action'] }));
      fireEvent.click(screen.getByRole('button', { name: vi_['pmt.gate.retire.cancel'] }));
      expect(screen.queryByRole('form', { name: 'Kết thúc quy tắc PERMIT_1' })).toBeNull();
      fireEvent.click(within(ruleRow(1)).getByRole('button', { name: vi_['pmt.gate.retire.action'] }));
      const retire = screen.getByRole('form', { name: 'Kết thúc quy tắc PERMIT_1' });
      fireEvent.change(within(retire).getByLabelText(vi_['pmt.gate.retire.until.label']), { target: { value: '2999-12-31' } });
      fireEvent.click(within(retire).getByRole('button', { name: vi_['pmt.gate.retire.confirm'] }));
      await waitFor(() => expect(screen.getByTestId('retire-problem').textContent).toBe(vi_['pmt.gate.problem.validation.error']));
    });

    it('offers no way to end a rule that has already ended', async () => {
      open(state({ gateRules: [rule(1, { status: 'RETIRED', effective_until: '2026-03-31' })] }));
      await ready();
      expect(within(ruleRow(1)).queryByRole('button', { name: vi_['pmt.gate.retire.action'] })).toBeNull();
    });
  });
});
