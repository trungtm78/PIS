import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import viJson from '../../../i18n/vi.json';
import { harness, mountInSession } from '../security/test-support';
import AuditDetailPolicyScreen from './AuditDetailPolicyScreen';
import { parseKeys, toDetail, toPolicies, toSaveBody, validateForm } from './model';

const vi_ = viJson as Record<string, string>;
const ROUTE = { id: 'ADM-29', req: 'FR-ADM-AUDIT-DETAIL', title: 'x', path: '/adm/adm-29', kind: 'form', area: 'admin', module: 'ADM', group: 'g', role: 'workspace', parent: null } as never;
const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const MANAGER = ['adm.audit_detail.read', 'adm.audit_detail.manage'];

afterEach(cleanup);

const policy = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  resource_type: 'period_reopen',
  enabled: true,
  max_bytes: 16384,
  sensitive_keys: ['pin'],
  reason: 'HT.06 opt-in',
  version: 3,
  updated_at: '2026-11-08T01:00:00.000Z',
  updated_by: '00000000-0000-4000-8000-000000000001',
  ...overrides,
});
const detail = (overrides: Record<string, unknown> = {}) => ({
  audit_event_id: EVENT_ID,
  resource_type: 'period_reopen',
  resource_id: '00000000-0000-4000-8000-0000000000f1',
  before: { status: 'REQUESTED' },
  after: { status: 'APPROVED', token: '[REDACTED]' },
  sha256: 'a'.repeat(64),
  bytes: 70,
  redacted_paths: ['after.token'],
  truncated: false,
  changed_paths: ['status', 'token'],
  matches_sealed_row: true,
  created_at: '2026-11-08T01:00:00.000Z',
  ...overrides,
});
const empty = { items: [], as_of: 'x' };

describe('the audit detail model', () => {
  it('reads the policies in the order of their class and drops what is not a policy', () => {
    expect(toPolicies({ items: [policy({ resource_type: 'hpm_push', id: 'b' }), policy(), { nonsense: true }] }).map((p) => p.resourceType)).toEqual(['hpm_push', 'period_reopen']);
    expect(toDetail({ audit_event_id: EVENT_ID })).toBeUndefined();
  });

  it('judges the form and builds the body with the version the person saw', () => {
    const form = { resourceType: 'period_reopen', enabled: true, maxBytes: '16384', sensitiveKeys: 'pin, otp\nsecretx', reason: 'because of HT.06' };
    expect(validateForm(form)).toEqual({});
    expect(validateForm({ ...form, resourceType: 'Bad Name', maxBytes: '10', reason: '' })).toEqual({ resourceType: 'format', maxBytes: 'range', reason: 'required' });
    expect(parseKeys('a, b;a  c')).toEqual(['a', 'b', 'c']);
    expect(toSaveBody(form, toPolicies({ items: [policy()] })[0])).toMatchObject({ expected_version: 3, sensitive_keys: ['pin', 'otp', 'secretx'] });
  });
});

describe('AuditDetailPolicyScreen (ADM-29)', () => {
  it('lists the classes and says when nothing is switched on', async () => {
    mountInSession(<AuditDetailPolicyScreen route={ROUTE} />, harness(() => ({ items: [policy()], as_of: 'x' })), { permissions: MANAGER });
    const table = await screen.findByTestId('policies');
    expect(table.querySelector('tr[data-resource-type="period_reopen"]')?.getAttribute('data-enabled')).toBe('true');
    cleanup();
    mountInSession(<AuditDetailPolicyScreen route={ROUTE} />, harness(() => empty), { permissions: MANAGER });
    expect((await screen.findByTestId('empty-policies')).textContent).toBe(vi_['adm.auditDetail.empty.text']);
  });

  it('shows the stored values of an audit row and whether they still match the sealed row', async () => {
    mountInSession(<AuditDetailPolicyScreen route={ROUTE} />, harness((operation) => (operation === 'getAuditEventDetail' ? detail() : empty)), { permissions: MANAGER });
    await userEvent.setup().type(await screen.findByLabelText(vi_['adm.auditDetail.lookup.label'] ?? ''), EVENT_ID);
    const panel = await screen.findByTestId('detail');
    expect(panel.getAttribute('data-matches')).toBe('true');
    expect(within(panel).getByTestId('detail-after').textContent).toContain('[REDACTED]');
    cleanup();
    mountInSession(<AuditDetailPolicyScreen route={ROUTE} />, harness((operation) => (operation === 'getAuditEventDetail' ? detail({ matches_sealed_row: false }) : empty)), { permissions: MANAGER });
    await userEvent.setup().type(await screen.findByLabelText(vi_['adm.auditDetail.lookup.label'] ?? ''), EVENT_ID);
    expect((await screen.findByTestId('detail')).getAttribute('data-matches')).toBe('false');
  });

  it('saves a class with its version and a reason', async () => {
    const h = harness(() => empty, () => ({ resource_id: 'x' }));
    mountInSession(<AuditDetailPolicyScreen route={ROUTE} />, h, { permissions: MANAGER });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['adm.auditDetail.form.aria'] });
    await user.type(within(form).getByLabelText(vi_['adm.auditDetail.field.class'] ?? ''), 'hpm_push');
    await user.type(within(form).getByLabelText(vi_['adm.auditDetail.field.reason'] ?? ''), 'needed for HT.06');
    await user.click(within(form).getByRole('button', { name: vi_['adm.auditDetail.form.save'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ resource_type: 'hpm_push', enabled: true, expected_version: 0 });
  });

  it('is denied without the read permission', async () => {
    mountInSession(<AuditDetailPolicyScreen route={ROUTE} />, harness(() => empty), { permissions: [] });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
