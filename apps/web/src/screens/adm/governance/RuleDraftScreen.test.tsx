import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import RuleDraftScreen from './RuleDraftScreen';
import { ALL, MANAGE, READ, catalogueBody, effectiveBody, refusal, routeOf, serve, text, uuid, version } from './test/fixtures';
import type { Answer } from './test/fixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeOf('ADM-21');
const FULL = { source: 'EXPLANATION', owner: 'RESPONDENT', expected_action: 'Trả lời đúng hạn', consequence: 'Bị tính quá hạn', response_hours: 48, default_severity: 'ACTION', reason_to_exist: 'Bảo đảm có giải trình', review_on: '2027-05-08', enabled: true };

interface Setup {
  path?: string;
  permissions?: readonly string[];
  effective?: Answer;
  versions?: unknown[];
  catalogue?: unknown;
  rule?: unknown;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getGovernanceRuleCatalog: setup.catalogue ?? catalogueBody(),
      getEffectiveGovernanceRule: setup.effective ?? effectiveBody({ params: FULL }),
      listGovernanceRuleVersions: { items: setup.versions ?? [] },
      getGovernanceRule: setup.rule ?? version(1, { params: { ...FULL, response_hours: 24 } }),
    },
    setup.commands ?? { createGovernanceRuleDraft: { resource_id: uuid(200), status: 'DRAFT', resource_version: 1 } },
  );
  mount(<RuleDraftScreen route={route} />, h, setup.permissions ?? ALL, setup.path ?? '/adm/adm-21?type=ALERT_TYPE&code=EXPLANATION');
  return h;
};

const field = (path: string) => screen.getByTestId(`field-${path}`) as HTMLInputElement;
const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const ready = async () => screen.findByTestId('params-form');

describe('ADM-21: write the next version of a rule', () => {
  it('builds the form from the schema of the type, starts from the rule in force and says so', async () => {
    open();
    await ready();
    expect(field('response_hours').value).toBe('48');
    expect(field('consequence').value).toBe('Bị tính quá hạn');
    expect(field('default_severity').value).toBe('ACTION');
    expect((field('enabled') as HTMLInputElement).checked).toBe(true);
    expect(field('review_on').type).toBe('date');
    // The fields of an alert type carry their own names, and the schema's range and unit are next to the number.
    expect(screen.getByLabelText(new RegExp(text('gova1.field.responseHours')))).toBe(field('response_hours'));
    expect(screen.getByText(text('gova1.hint.range', { min: 1, max: 8760 }))).toBeTruthy();
    expect(screen.getAllByText(text('ui.unitChip.label', { unit: text('gova1.unit.hours') })).length).toBeGreaterThan(0);
    expect(screen.getByTestId('params-base').textContent).toBe(text('gova1.form.base.rule', { version: 2 }));
    // A long text is a text area; an optional field says so.
    expect(field('consequence').tagName).toBe('TEXTAREA');
    expect(screen.getAllByText(`(${text('gova1.form.optional')})`).length).toBeGreaterThan(0);
  });

  it('starts from the version chosen when the address names one', async () => {
    open({ path: `/adm/adm-21?type=ALERT_TYPE&code=EXPLANATION&from=${uuid(101)}` });
    await ready();
    await waitFor(() => expect(field('response_hours').value).toBe('24'));
    expect(screen.getByTestId('params-base').textContent).toBe(text('gova1.form.base.version', { version: 1 }));
  });

  it('asks for a type first, then shows a blank form with money in đồng, and lets the list of bands grow and shrink', async () => {
    open({ path: '/adm/adm-21', effective: refusal('GOVERNANCE_RULE_NOT_FOUND', 404) });
    expect((await screen.findByTestId('pick-type')).textContent).toBe(text('gova1.form.pickType'));
    change('type', 'CHANGE_ORDER_TIER');
    change('code', 'central');
    expect((screen.getByTestId('code') as HTMLInputElement).value).toBe('CENTRAL');
    await ready();
    expect(screen.getByTestId('params-base').textContent).toBe(text('gova1.form.base.blank'));
    // The schema asks for at least one band; the money field of a band says the unit.
    expect(screen.getByTestId('list-bands')).toBeTruthy();
    expect(within(screen.getByTestId('list-bands')).getAllByText(text('ui.unitChip.label', { unit: text('gova1.unit.vnd') })).length).toBe(1);
    fireEvent.click(document.querySelector('[data-action="add-bands"]') as HTMLElement);
    expect(document.querySelectorAll('[data-item]').length).toBe(2);
    expect(within(screen.getByTestId('list-bands')).getAllByText(text('ui.unitChip.label', { unit: text('gova1.unit.vnd') })).length).toBe(2);
    fireEvent.click(document.querySelector('[data-action="remove-bands[1]"]') as HTMLElement);
    expect(document.querySelectorAll('[data-item]').length).toBe(1);
  });

  it('refuses to send a form with a problem, names every field in a summary and next to the field, and sends nothing', async () => {
    const h = open();
    await ready();
    change('field-response_hours', '0');
    change('field-consequence', '');
    fireEvent.click(screen.getByTestId('save'));
    const summary = await screen.findByTestId('summary');
    expect(summary.textContent).toContain(text('gova1.problem.range', { min: 1, max: 8760 }));
    expect(summary.textContent).toContain(text('gova1.problem.required'));
    expect(summary.textContent).toContain(text('gova1.form.error.reason', { min: 5, max: 500 }));
    expect(screen.getByTestId('error-response_hours').textContent).toContain(text('gova1.problem.range', { min: 1, max: 8760 }));
    expect(field('response_hours').getAttribute('aria-invalid')).toBe('true');
    expect(field('response_hours').getAttribute('aria-describedby')).toContain('error');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('checks the whole-number, number, text length and time rules of the schema in words', async () => {
    open();
    await ready();
    change('field-response_hours', '1.5');
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('error-response_hours')).textContent).toContain(text('gova1.problem.integer'));
    change('field-response_hours', 'abc');
    expect(screen.getByTestId('error-response_hours').textContent).toContain(text('gova1.problem.integer'));
    change('field-consequence', 'x'.repeat(501));
    expect(screen.getByTestId('error-consequence').textContent).toContain(text('gova1.problem.length', { max: 500 }));
    change('field-consequence', ' có khoảng trắng ');
    expect(screen.getByTestId('error-consequence').textContent).toContain(text('gova1.problem.trim'));
  });

  it('AC-ADM-14 says that an alert type with no expected action can only be at the watch level', async () => {
    open();
    await ready();
    change('field-expected_action', '');
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('error-default_severity')).textContent).toContain(text('gova1.problem.watchOnly'));
    change('field-default_severity', 'WATCH');
    expect(screen.queryByTestId('error-default_severity')).toBeNull();
  });

  it('warns before writing: a version that takes over, one that overlaps, and a first day in the past', async () => {
    const approvedV2 = version(2, { status: 'APPROVED', phase: 'IN_FORCE', approved_by: uuid(9), approved_at: '2026-10-03T03:00:00.000Z', effective_from: '2026-10-05', effective_to: null });
    open({ versions: [approvedV2] });
    await ready();
    change('from', '2026-12-01');
    expect((await screen.findByTestId('notice-takeover')).textContent).toContain(text('gova1.notice.takeover', { version: 2, day: '01/12/2026' }));
    change('from', '2026-11-01');
    expect(screen.getByTestId('notice-past').textContent).toContain(text('gova1.notice.startPast'));
    change('to', '2026-10-01');
    expect(screen.getByTestId('notice-end').textContent).toContain(text('gova1.notice.endBeforeStart'));
    cleanup();
    // A version that begins after the one in force cannot be taken over by one that ends before it does.
    const later = version(3, { status: 'APPROVED', phase: 'SCHEDULED', approved_by: uuid(9), approved_at: '2026-10-03T03:00:00.000Z', effective_from: '2027-01-01', effective_to: null });
    open({ versions: [later] });
    await ready();
    change('from', '2026-12-01');
    expect((await screen.findByTestId('notice-conflict')).textContent).toContain(text('gova1.notice.conflict', { version: 3, from: '01/01/2027', to: text('gova1.period.noEnd') }));
  });

  it('writes the draft with typed params, the days and the reason, then says what comes next', async () => {
    const h = open();
    await ready();
    change('field-response_hours', '36');
    change('from', '2026-12-01');
    change('to', '2027-12-01');
    change('reason', '  Rút thời hạn trả lời theo chỉ đạo  ');
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[0]).toBe('createGovernanceRuleDraft');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({
      body: { rule_type: 'ALERT_TYPE', code: 'EXPLANATION', params: { ...FULL, response_hours: 36 }, effective_from: '2026-12-01', effective_to: '2027-12-01', reason: 'Rút thời hạn trả lời theo chỉ đạo' },
    });
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('unit_id');
    const written = await screen.findByTestId('written');
    expect(written.textContent).toContain('EXPLANATION');
    expect(screen.getByTestId('open-versions').getAttribute('href')).toBe('/adm/adm-20?type=ALERT_TYPE&code=EXPLANATION');
    // Nothing can be sent twice: the form is locked until the person asks for another.
    expect(screen.getByTestId('save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('again'));
    expect(screen.getByTestId('save')).toBeEnabled();
  });

  it('sends the unit when the rule is an override, and refuses a unit id that is not one', async () => {
    const h = open({ path: `/adm/adm-21?type=ALERT_TYPE&code=EXPLANATION&unit_id=${uuid(55)}` });
    await ready();
    change('from', '2026-12-01');
    change('reason', 'Riêng cho đơn vị này');
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { unit_id: uuid(55) } });
    cleanup();
    const refused = open();
    await ready();
    change('unit', 'not-a-unit');
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('summary')).textContent).toContain(text('gova1.form.error.unit'));
    expect(refused.command).not.toHaveBeenCalled();
  });

  it('shows the field the server refuses, next to the field, and keeps what was typed', async () => {
    const h = open();
    await ready();
    h.command.mockImplementationOnce(() => Promise.reject(refusal('GOVERNANCE_RULE_PARAMS_INVALID', 422, 'response_hours')));
    change('field-response_hours', '36');
    change('from', '2026-12-01');
    change('reason', 'Một lý do đủ dài');
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('gova1.refusal.params', { path: 'response_hours' }));
    expect(screen.getByTestId('error-response_hours').textContent).toContain(text('gova1.problem.server'));
    expect(field('response_hours').value).toBe('36');
    expect(screen.getByTestId('save')).toBeEnabled();
  });

  it('words an overlap the server finds at write time', async () => {
    const h = open();
    await ready();
    h.command.mockImplementationOnce(() => Promise.reject(refusal('GOVERNANCE_RULE_PERIOD_OVERLAP', 409)));
    change('from', '2026-12-01');
    change('reason', 'Một lý do đủ dài');
    fireEvent.click(screen.getByTestId('save'));
    expect((await screen.findByTestId('refusal')).textContent).toBe(text('gova1.refusal.overlap'));
  });

  it('writes nothing when the server sent no schema it can understand', async () => {
    const body = catalogueBody();
    (body.items[0] as { schema: unknown }).schema = { odd: { kind: 'matrix' } };
    open({ catalogue: body });
    expect((await screen.findByTestId('no-schema')).textContent).toBe(text('gova1.form.noSchema', { type: 'ALERT_TYPE' }));
    expect(screen.queryByTestId('save')).toBeNull();
  });

  it('names a type the system does not know', async () => {
    open({ path: '/adm/adm-21?type=NO_SUCH_TYPE&code=ABC' });
    expect(await screen.findByTestId('unknown-type')).toBeTruthy();
  });

  it('is denied for a person who may only read, and reads nothing', () => {
    const h = open({ permissions: [READ] });
    expect(screen.getByText(text('states.denied.title'))).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    expect(MANAGE).toBe('adm.governance.manage');
  });

  it('shows a skeleton while the rule to start from is read', async () => {
    open({ effective: new Promise(() => undefined) });
    expect(await screen.findByTestId('params-loading')).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open();
    await ready();
    change('from', '2026-12-01');
    fireEvent.click(screen.getByTestId('save'));
    await screen.findByTestId('summary');
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
