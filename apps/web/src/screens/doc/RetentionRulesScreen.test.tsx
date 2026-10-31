import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import RetentionRulesScreen from './RetentionRulesScreen';
import { CLASS_YEARS, EMPTY_CONFIRM, EMPTY_RULE, canConfirmRule, canPublishRule, confirmBody, describeProblem, ruleBody, validateConfirm, validateRule } from './archive/rules';
import { toRule } from './archive/types';
import { harness, mountInSession, routeOf } from './test-support';

const ROUTE = routeOf('DOC-18', 'FR-DOC-18');
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const THIRD = '00000000-0000-4000-8000-0000000000c3';
const READER = ['doc.retention.read'];
const MANAGER = ['doc.retention.read', 'doc.retention.manage'];
const APPROVER = ['doc.retention.read', 'doc.retention.approve'];
const LEGAL = ['doc.retention.read', 'doc.template.confirm_legal'];
const OK = { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'x' };
const EVIDENCE = '00000000-0000-4000-8000-0000000000e1';

const member = (id: string, name: string) => ({ id, name });

const rule = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  rule_set: 'TENANT_CUSTOM',
  category_code: `CATEGORY_${n}`,
  class_code: 'Y10',
  retention_years: 10,
  start_basis: 'FROM_CLOSED',
  handover_months: 12,
  end_action: 'REVIEW_FOR_DISPOSAL',
  legal_basis: 'Thông tư 10/2022/TT-BNV',
  legal_confirmation_ref: null,
  confirmation_status: 'PENDING_CONFIRMATION',
  precedence: 100,
  effective_from: '2026-01-01',
  effective_until: null,
  status: 'PUBLISHED',
  created_by: member(OTHER, 'Người soạn'),
  approved_by: member(THIRD, 'Người công bố'),
  legal_confirmed_by: null,
  version: 2,
  ...overrides,
});

/** The server as the screen sees it: `readAll` follows the cursors of the list, so the harness answers it with the rows. */
function open(items: unknown[] | Error, command: (operation: string, input: unknown) => unknown = () => OK) {
  const h = harness(() => new Error('unexpected read'), command);
  const readAll = vi.fn((operation: string) => (operation === 'listDocumentRetentionRules' ? (items instanceof Error ? Promise.reject(items) : Promise.resolve(items)) : Promise.reject(new Error(`unexpected readAll ${operation}`))));
  (h.client as unknown as { readAll: unknown }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('RetentionRulesScreen (DOC-18)', () => {
  it('lists the rules with their period, state, confirmation and the three people, and offers a reader no step', async () => {
    const h = open([
      rule(1, { class_code: 'Y20', retention_years: 20, effective_until: '2027-01-01', confirmation_status: 'CONFIRMED', legal_confirmation_ref: 'CXN-05', legal_confirmed_by: member(ME, 'Người xác nhận'), rule_set: 'TT74_2025_BTC', start_basis: 'FROM_SETTLEMENT' }),
      rule(2, { status: 'DRAFT', approved_by: null, class_code: 'PERMANENT', retention_years: null, effective_from: '2027-01-01', rule_set: 'TT10_2022_BNV', start_basis: 'FROM_ISSUED', handover_months: 6 }),
      rule(3, { status: 'SUPERSEDED', created_by: null }),
    ]);
    mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: READER });
    const rows = within(await screen.findByTestId('rules')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.archive.rules.title']);
    expect(rows[0]?.textContent).toContain('CATEGORY_1');
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.ruleSet.tt74']);
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.class.y20']);
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.rules.basis'].replace('{basis}', vi_['doc.archive.basis.settlement']).replace('{months}', '12'));
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.rules.period'].replace('{from}', '2026-01-01').replace('{until}', '2027-01-01'));
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.ruleStatus.published']);
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.rules.confirmed'].replace('{ref}', 'CXN-05'));
    expect(rows[0]?.textContent).toContain(vi_['doc.archive.rules.people'].replace('{drafter}', 'Người soạn').replace('{publisher}', 'Người công bố').replace('{confirmer}', 'Người xác nhận'));
    expect(rows[1]?.textContent).toContain(vi_['doc.archive.ruleStatus.draft']);
    expect(rows[1]?.textContent).toContain(vi_['doc.archive.rules.pending']);
    expect(rows[1]?.textContent).toContain(vi_['doc.archive.rules.period'].replace('{from}', '2027-01-01').replace('{until}', '—'));
    expect(rows[1]?.textContent).toContain(vi_['doc.archive.rules.people'].replace('{drafter}', 'Người soạn').replace('{publisher}', '—').replace('{confirmer}', '—'));
    expect(rows[2]?.textContent).toContain(vi_['doc.archive.ruleStatus.superseded']);
    expect(screen.queryByRole('button', { name: vi_['doc.archive.rules.publish.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['doc.archive.rules.confirm.action'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['doc.archive.rules.form.title'] })).toBeNull();
    expect(screen.getByRole('link', { name: new RegExp(vi_['doc.archive.back.link']) }).getAttribute('href')).toBe('/doc/doc-17');
  });

  it('does not read the rules of someone who may not, and shows nothing when there are none or the read fails; a read-only session takes no step', async () => {
    const denied = open([rule(1)]);
    mountInSession(<RetentionRulesScreen route={ROUTE} />, denied, { permissions: [] });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['doc.archive.rules.denied']);
    expect(denied.readAll).not.toHaveBeenCalled();
    cleanup();
    mountInSession(<RetentionRulesScreen route={ROUTE} />, open([]), { permissions: READER });
    await waitFor(() => expect(screen.queryByTestId('rules')).toBeNull());
    cleanup();
    mountInSession(<RetentionRulesScreen route={ROUTE} />, open(new Error('boom')), { permissions: READER });
    await waitFor(() => expect(screen.queryByTestId('rules')).toBeNull());
    cleanup();
    mountInSession(<RetentionRulesScreen route={ROUTE} />, open([rule(1, { status: 'DRAFT' })]), { permissions: [...APPROVER, ...MANAGER, ...LEGAL], mode: 'READ_ONLY' });
    await screen.findByTestId('rules');
    expect(screen.queryByRole('button', { name: vi_['doc.archive.rules.publish.action'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['doc.archive.rules.form.title'] })).toBeNull();
  });

  it('shows the standard states: loading, empty, failed, denied, offline and signed out, and reads again on retry', async () => {
    const pending = open([]);
    (pending.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mountInSession(<RetentionRulesScreen route={ROUTE} />, pending, { permissions: READER });
    expect((await screen.findByRole('status', { name: vi_['states.loading.label'] })).getAttribute('aria-busy')).toBe('true');
    cleanup();
    mountInSession(<RetentionRulesScreen route={ROUTE} />, open([]), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    for (const [error, title] of [
      [new Error('boom'), 'states.error.title'],
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), 'states.denied.title'],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title'],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), 'states.signedOut.title'],
    ] as const) {
      const h = open(error);
      mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: READER });
      expect(await screen.findByText(vi_[title])).toBeTruthy();
      expect(h.readAll).toHaveBeenCalledTimes(1);
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await waitFor(() => expect(h.readAll).toHaveBeenCalledTimes(2));
      cleanup();
    }
  });

  it('offers to publish a draft to the approver who did not draft it, under the version it saw, and says why the server refuses', async () => {
    const h = open([rule(1, { status: 'PUBLISHED' }), rule(2, { status: 'DRAFT', version: 1 }), rule(3, { status: 'DRAFT', created_by: member(ME, 'Tôi'), version: 1 })], () => new ApiError({ status: 409, code: 'RETENTION_RANGE_OVERLAP', correlationId: 'c' }));
    mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: APPROVER });
    const buttons = await screen.findAllByRole('button', { name: vi_['doc.archive.rules.publish.action'] });
    expect(buttons).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('publishDocumentRetentionRule');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: rule(2).id }, ifMatchVersion: 1 });
    expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['doc.archive.problem.overlap']);
  });

  describe('confirming the legal basis', () => {
    it('is offered for a published rule that waits, to someone who neither drafted nor published it, and sends the reference and the evidence', async () => {
      const h = open([rule(1), rule(2, { confirmation_status: 'CONFIRMED', legal_confirmation_ref: 'CXN-05' }), rule(3, { created_by: member(ME, 'Tôi') }), rule(4, { approved_by: member(ME, 'Tôi') }), rule(5, { status: 'DRAFT' })]);
      mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: LEGAL });
      const buttons = await screen.findAllByRole('button', { name: vi_['doc.archive.rules.confirm.action'] });
      expect(buttons).toHaveLength(1);
      const user = userEvent.setup();
      await user.click(buttons[0] as HTMLElement);
      const form = await screen.findByTestId('confirm-form');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.confirm.submit'] }));
      expect(within(form).getAllByText(vi_['doc.archive.field.required.error'])).toHaveLength(2);
      await user.type(within(form).getByLabelText(vi_['doc.archive.confirm.ref.label']), ' CXN-05 ');
      await user.type(within(form).getByLabelText(vi_['doc.archive.confirm.evidence.label']), 'x');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.confirm.submit'] }));
      expect(await within(form).findByText(vi_['doc.archive.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(form).getByLabelText(vi_['doc.archive.confirm.evidence.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.confirm.evidence.label']), EVIDENCE);
      await user.type(within(form).getByLabelText(vi_['doc.archive.confirm.note.label']), ' Đã đối chiếu ');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.confirm.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('confirmDocumentRetentionRuleLegalBasis');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: rule(1).id }, ifMatchVersion: 2, body: { legal_confirmation_ref: 'CXN-05', evidence_document_id: EVIDENCE, note: 'Đã đối chiếu' } });
      await waitFor(() => expect(screen.queryByTestId('confirm-form')).toBeNull());
    });

    it('can be cancelled, and says what the server refused', async () => {
      const h = open([rule(1)], () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
      mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: LEGAL });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['doc.archive.rules.confirm.action'] }));
      await user.click(within(await screen.findByTestId('confirm-form')).getByRole('button', { name: vi_['doc.archive.action.cancel'] }));
      expect(screen.queryByTestId('confirm-form')).toBeNull();
      await user.click(screen.getByRole('button', { name: vi_['doc.archive.rules.confirm.action'] }));
      const form = await screen.findByTestId('confirm-form');
      await user.type(within(form).getByLabelText(vi_['doc.archive.confirm.ref.label']), 'CXN-05');
      await user.type(within(form).getByLabelText(vi_['doc.archive.confirm.evidence.label']), EVIDENCE);
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.confirm.submit'] }));
      expect((await within(form).findByTestId('confirm-refusal')).textContent).toBe(vi_['doc.archive.problem.selfApproval']);
    });
  });

  describe('drafting', () => {
    const fill = async (user: ReturnType<typeof userEvent.setup>, form: HTMLElement, category = 'RULE_CAT') => {
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.category.label']), category);
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.legal.label']), 'Điều 5 Thông tư 10/2022/TT-BNV');
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.from.label']), '2030-01-01');
    };

    it('judges the form before it sends, shows the years of the class, and sends the body of the contract', async () => {
      const h = open([]);
      mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: MANAGER });
      const user = userEvent.setup();
      const form = await screen.findByRole('form', { name: vi_['doc.archive.rules.form.title'] });
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.form.submit'] }));
      expect((await within(form).findAllByText(vi_['doc.archive.field.required.error'])).length).toBe(3);
      expect(h.command).not.toHaveBeenCalled();
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.category.label']), 'lower');
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.legal.label']), 'ab');
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.from.label']), '2030-01-01');
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.until.label']), '2030-01-01');
      await user.clear(within(form).getByLabelText(vi_['doc.archive.ruleField.handover.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.handover.label']), '-1');
      await user.clear(within(form).getByLabelText(vi_['doc.archive.ruleField.precedence.label']));
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.form.submit'] }));
      expect((await within(form).findAllByText(vi_['doc.archive.field.invalid.error'])).length).toBe(3);
      expect(within(form).getByText(vi_['doc.archive.field.tooShort.error'])).toBeTruthy();
      expect(within(form).getByText(vi_['doc.archive.field.required.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();

      expect(within(form).getByTestId('class-years').textContent).toBe(vi_['doc.archive.ruleField.class.years'].replace('{years}', '10'));
      await user.selectOptions(within(form).getByLabelText(vi_['doc.archive.ruleField.class.label']), 'PERMANENT');
      expect(within(form).getByTestId('class-years').textContent).toBe(vi_['doc.archive.ruleField.class.permanent']);
      await user.selectOptions(within(form).getByLabelText(vi_['doc.archive.ruleField.class.label']), 'Y20');
      expect(within(form).getByTestId('class-years').textContent).toBe(vi_['doc.archive.ruleField.class.years'].replace('{years}', '20'));
      await user.selectOptions(within(form).getByLabelText(vi_['doc.archive.ruleField.ruleSet.label']), 'TT74_2025_BTC');
      await user.selectOptions(within(form).getByLabelText(vi_['doc.archive.ruleField.start.label']), 'FROM_SETTLEMENT');
      await user.clear(within(form).getByLabelText(vi_['doc.archive.ruleField.category.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.category.label']), ' ACCOUNTING ');
      await user.clear(within(form).getByLabelText(vi_['doc.archive.ruleField.legal.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.legal.label']), ' Điều 5 Thông tư 74/2025/TT-BTC ');
      await user.clear(within(form).getByLabelText(vi_['doc.archive.ruleField.until.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.until.label']), '2031-01-01');
      await user.clear(within(form).getByLabelText(vi_['doc.archive.ruleField.handover.label']));
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.handover.label']), '6');
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.precedence.label']), '50');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.form.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createDocumentRetentionRule');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        body: { rule_set: 'TT74_2025_BTC', category_code: 'ACCOUNTING', class_code: 'Y20', retention_years: 20, start_basis: 'FROM_SETTLEMENT', handover_months: 6, precedence: 50, legal_basis: 'Điều 5 Thông tư 74/2025/TT-BTC', effective_from: '2030-01-01', effective_until: '2031-01-01' },
      });
      expect((await screen.findByTestId('saved')).textContent).toBe(vi_['doc.archive.rules.form.saved']);
      // The form starts again empty.
      expect((within(form).getByLabelText(vi_['doc.archive.ruleField.category.label']) as HTMLInputElement).value).toBe('');
    });

    it('sends no years for a permanent class and no end for an open period', async () => {
      const h = open([]);
      mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: MANAGER });
      const user = userEvent.setup();
      const form = await screen.findByRole('form', { name: vi_['doc.archive.rules.form.title'] });
      await fill(user, form);
      await user.selectOptions(within(form).getByLabelText(vi_['doc.archive.ruleField.class.label']), 'PERMANENT');
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.form.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const body = (h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
      expect(body).toMatchObject({ class_code: 'PERMANENT', handover_months: 12, precedence: 100 });
      expect(body).not.toHaveProperty('retention_years');
      expect(body).not.toHaveProperty('effective_until');
    });

    it.each([
      ['RETENTION_RANGE_OVERLAP', 409, 'doc.archive.problem.overlap'],
      ['LEGAL_BASIS_REQUIRED', 422, 'doc.archive.problem.legalBasis'],
      ['CONFIRMATION_REF_REQUIRED', 422, 'doc.archive.problem.confirmationRef'],
      ['RETENTION_STATE_INVALID', 409, 'doc.archive.problem.state'],
      ['VALIDATION_FAILED', 422, 'doc.archive.problem.invalid'],
      ['SCOPE_DENIED', 403, 'doc.archive.problem.scope'],
      ['VERSION_CONFLICT', 409, 'doc.archive.problem.conflict'],
      ['OTHER', 500, 'doc.archive.problem.general'],
    ] as const)('says in words what the server refused: %s', async (code, status, key) => {
      const h = open([], () => new ApiError({ status, code, correlationId: 'c' }));
      mountInSession(<RetentionRulesScreen route={ROUTE} />, h, { permissions: MANAGER });
      const user = userEvent.setup();
      const form = await screen.findByRole('form', { name: vi_['doc.archive.rules.form.title'] });
      await fill(user, form);
      await user.click(within(form).getByRole('button', { name: vi_['doc.archive.rules.form.submit'] }));
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_[key]);
    });

    it('starts the form over when the tenant changes', async () => {
      const view = mountInSession(<RetentionRulesScreen route={ROUTE} />, open([]), { permissions: MANAGER });
      const user = userEvent.setup();
      const form = await screen.findByRole('form', { name: vi_['doc.archive.rules.form.title'] });
      await user.type(within(form).getByLabelText(vi_['doc.archive.ruleField.category.label']), 'KEPT');
      view.rerenderWith({ permissions: MANAGER, tenant: { ...(await import('./test-support')).SECOND_TENANT } });
      await waitFor(() => expect((screen.getByLabelText(vi_['doc.archive.ruleField.category.label']) as HTMLInputElement).value).toBe(''));
    });
  });
});

describe('the rules of the retention forms', () => {
  it('judges a rule: the category, the whole numbers, the legal basis and the days', () => {
    expect(validateRule(EMPTY_RULE)).toMatchObject({ categoryCode: 'required', legalBasis: 'required', effectiveFrom: 'required', handoverMonths: undefined, precedence: undefined });
    const ok = { ...EMPTY_RULE, categoryCode: 'ACCOUNTING', legalBasis: 'Điều 5', effectiveFrom: '2030-01-01' };
    expect(Object.values(validateRule(ok)).filter((problem) => problem !== undefined)).toEqual([]);
    expect(validateRule({ ...ok, categoryCode: 'a' }).categoryCode).toBe('invalid');
    expect(validateRule({ ...ok, handoverMonths: '' }).handoverMonths).toBe('required');
    expect(validateRule({ ...ok, handoverMonths: '241' }).handoverMonths).toBe('invalid');
    expect(validateRule({ ...ok, handoverMonths: '0' }).handoverMonths).toBeUndefined();
    expect(validateRule({ ...ok, precedence: '0' }).precedence).toBe('invalid');
    expect(validateRule({ ...ok, precedence: '1001' }).precedence).toBe('invalid');
    expect(validateRule({ ...ok, precedence: '1.5' }).precedence).toBe('invalid');
    expect(validateRule({ ...ok, legalBasis: 'ab' }).legalBasis).toBe('tooShort');
    expect(validateRule({ ...ok, legalBasis: 'x'.repeat(2001) }).legalBasis).toBe('tooLong');
    expect(validateRule({ ...ok, effectiveFrom: '2030-02-30' }).effectiveFrom).toBe('invalid');
    expect(validateRule({ ...ok, effectiveFrom: 'soon' }).effectiveFrom).toBe('invalid');
    expect(validateRule({ ...ok, effectiveUntil: '2030-01-01' }).effectiveUntil).toBe('invalid');
    expect(validateRule({ ...ok, effectiveUntil: '2029-01-01' }).effectiveUntil).toBe('invalid');
    expect(validateRule({ ...ok, effectiveUntil: '2031-13-01' }).effectiveUntil).toBe('invalid');
    expect(validateRule({ ...ok, effectiveUntil: '2030-01-02' }).effectiveUntil).toBeUndefined();
    expect(validateRule({ ...ok, effectiveFrom: 'soon', effectiveUntil: '2030-01-02' }).effectiveUntil).toBeUndefined();
  });

  it('builds the body of a rule from the years of its class', () => {
    expect(CLASS_YEARS).toEqual({ PERMANENT: null, Y70: 70, Y20: 20, Y10: 10, Y5: 5 });
    expect(ruleBody({ ...EMPTY_RULE, categoryCode: ' ACCOUNTING ', classCode: 'Y70', legalBasis: ' Điều 5 ', effectiveFrom: '2030-01-01', effectiveUntil: ' 2031-01-01 ' })).toEqual({
      rule_set: 'TENANT_CUSTOM',
      category_code: 'ACCOUNTING',
      class_code: 'Y70',
      retention_years: 70,
      start_basis: 'FROM_CLOSED',
      handover_months: 12,
      precedence: 100,
      legal_basis: 'Điều 5',
      effective_from: '2030-01-01',
      effective_until: '2031-01-01',
    });
    expect(ruleBody({ ...EMPTY_RULE, classCode: 'PERMANENT', effectiveFrom: '2030-01-01' })).not.toHaveProperty('retention_years');
  });

  it('judges a confirmation and builds its body', () => {
    expect(validateConfirm(EMPTY_CONFIRM)).toMatchObject({ reference: 'required', evidenceDocumentId: 'required', note: undefined });
    expect(validateConfirm({ reference: 'ab', evidenceDocumentId: EVIDENCE, note: '' }).reference).toBe('tooShort');
    expect(validateConfirm({ reference: 'x'.repeat(51), evidenceDocumentId: EVIDENCE, note: '' }).reference).toBe('tooLong');
    expect(validateConfirm({ reference: 'CXN', evidenceDocumentId: 'nope', note: '' }).evidenceDocumentId).toBe('invalid');
    expect(validateConfirm({ reference: 'CXN', evidenceDocumentId: EVIDENCE, note: 'x'.repeat(1001) }).note).toBe('tooLong');
    expect(confirmBody({ reference: ' CXN-05 ', evidenceDocumentId: ` ${EVIDENCE.toUpperCase()} `, note: '  ' })).toEqual({ legal_confirmation_ref: 'CXN-05', evidence_document_id: EVIDENCE });
    expect(confirmBody({ reference: 'CXN-05', evidenceDocumentId: EVIDENCE, note: ' ghi chú ' })).toMatchObject({ note: 'ghi chú' });
  });

  it('tells who may publish and who may confirm', () => {
    const base = toRule(rule(1));
    expect(canPublishRule({ ...base, status: 'DRAFT' }, ME)).toBe(true);
    expect(canPublishRule({ ...base, status: 'DRAFT' }, OTHER)).toBe(false);
    expect(canPublishRule({ ...base, status: 'DRAFT' }, undefined)).toBe(true);
    expect(canPublishRule({ ...base, status: 'PUBLISHED' }, ME)).toBe(false);
    expect(canConfirmRule(base, ME)).toBe(true);
    expect(canConfirmRule(base, OTHER)).toBe(false);
    expect(canConfirmRule(base, THIRD)).toBe(false);
    expect(canConfirmRule(base, undefined)).toBe(true);
    expect(canConfirmRule({ ...base, confirmationStatus: 'CONFIRMED' }, ME)).toBe(false);
    expect(canConfirmRule({ ...base, status: 'DRAFT' }, ME)).toBe(false);
    expect(canConfirmRule({ ...base, createdBy: null, approvedBy: null }, ME)).toBe(true);
  });

  it('reads a rule as the server gives it, with defaults for what is missing, and maps a failure that is not the server to a general one', () => {
    expect(toRule(rule(1, { created_by: 'x', approved_by: { name: 'no id' } }))).toMatchObject({ createdBy: null, approvedBy: null, legalConfirmedBy: null, retentionYears: 10 });
    expect(toRule(undefined)).toMatchObject({ id: '', ruleSet: 'TENANT_CUSTOM', classCode: 'PERMANENT', retentionYears: null, status: 'DRAFT', confirmationStatus: 'PENDING_CONFIRMATION', version: 0 });
    expect(toRule(rule(1, { created_by: { id: OTHER } })).createdBy).toEqual({ id: OTHER, name: null });
    expect(describeProblem(new Error('network'))).toBe('general');
    expect(describeProblem(new ApiError({ status: 409, code: 'RETENTION_RANGE_OVERLAP', correlationId: 'c' }))).toBe('overlap');
  });
});
