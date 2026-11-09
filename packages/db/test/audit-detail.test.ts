import { sha256Hex, canonicalJson } from '@machvon/kernel';
import { AuditDetailPolicyStore, AuditDetailReads } from '../src/audit-detail-store';
import { MEMBERSHIP, RESOURCE, TENANT_A, TENANT_B, contextOf, entryOf, startAuditHarness } from './support/audit-fixtures';
import type { AuditHarness } from './support/audit-fixtures';

const policies = new AuditDetailPolicyStore();
const reads = new AuditDetailReads();
const BEFORE = { status: 'REQUESTED', window_hours: 24 };
const AFTER = { status: 'APPROVED', window_hours: 48, api_token: 'must-not-be-kept', phone: '0900000000' };

describe('the full before and after of the audit trail (HT.06)', () => {
  let harness: AuditHarness;

  const write = (tenant: string, action: string, withDetail = true): Promise<string> =>
    harness.tenantDatabase.withTenant(contextOf(tenant), (tx) => harness.writer.recordInTx(tx, MEMBERSHIP, entryOf(action, { resourceType: 'period_reopen', resourceId: RESOURCE, ...(withDetail ? { detail: { before: BEFORE, after: AFTER } } : {}) })));
  const enable = (tenant: string, expectedVersion = 0, enabled = true) =>
    harness.tenantDatabase.withTenant(contextOf(tenant), (tx) => policies.save(tx, MEMBERSHIP, { resourceType: 'period_reopen', enabled, maxBytes: 4096, sensitiveKeys: ['window_hours'], reason: 'HT.06 for the reopening' }, expectedVersion));

  beforeAll(async () => {
    harness = await startAuditHarness();
  }, 180_000);

  afterAll(async () => {
    if (harness) await harness.stop();
  }, 60_000);

  it('keeps nothing extra while the class is not switched on', async () => {
    const id = await write(TENANT_A, 'before-optin');
    expect(await harness.tenantDatabase.withTenant(contextOf(TENANT_A), (tx) => reads.forEvent(tx, id))).toBeUndefined();
    const [row] = await harness.tenantDatabase.withTenant(contextOf(TENANT_A), (tx) => tx.query<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where id = $1::uuid', [id]));
    expect(row?.safe_diff).not.toHaveProperty('detail_ref');
  });

  it('stores the redacted values once the class is on, and the sealed row carries their hash', async () => {
    const saved = await enable(TENANT_A);
    expect(saved).toMatchObject({ action: 'CREATED', row: { enabled: true, version: 1 } });
    const id = await write(TENANT_A, 'after-optin');
    const view = await harness.tenantDatabase.withTenant(contextOf(TENANT_A), (tx) => reads.forEvent(tx, id));
    expect(view).toMatchObject({ before: { status: 'REQUESTED', window_hours: '[REDACTED]' }, resourceType: 'period_reopen', matchesSealedRow: true });
    expect(view?.after).toMatchObject({ status: 'APPROVED', window_hours: '[REDACTED]', api_token: '[REDACTED]', phone: '[PERSONAL]' });
    expect(view?.redactedPaths).toEqual(expect.arrayContaining(['after.api_token', 'after.phone', 'after.window_hours']));
    expect(view?.sha256).toBe(sha256Hex(canonicalJson({ before: view?.before, after: view?.after })));
    expect(view?.changedPaths).toContain('status');
  });

  it('does not reach into another tenant, and is switched off by a versioned change with a reason', async () => {
    await expect(write(TENANT_B, 'other-tenant')).resolves.toMatch(/^[0-9a-f-]{36}$/);
    const id = await write(TENANT_A, 'second');
    expect(await harness.tenantDatabase.withTenant(contextOf(TENANT_B), (tx) => reads.forEvent(tx, id))).toBeUndefined();
    await expect(enable(TENANT_A, 0, false)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await enable(TENANT_A, 1, false)).action).toBe('DISABLED');
    const off = await write(TENANT_A, 'after-off');
    expect(await harness.tenantDatabase.withTenant(contextOf(TENANT_A), (tx) => reads.forEvent(tx, off))).toBeUndefined();
  });

  it('refuses an invalid policy and never lets the stored detail change', async () => {
    await expect(harness.tenantDatabase.withTenant(contextOf(TENANT_A), (tx) => policies.save(tx, MEMBERSHIP, { resourceType: 'Bad Class', enabled: true, maxBytes: 10, sensitiveKeys: [], reason: '' }, 0))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await enable(TENANT_A, 2, true)).action).toBe('ENABLED');
    const id = await write(TENANT_A, 'third');
    await expect(
      harness.tenantDatabase.withTenant(contextOf(TENANT_A), (tx) => tx.query("update machvon.audit_event_detail set after_value = '{}'::jsonb where audit_event_id = $1::uuid", [id])),
    ).rejects.toThrow();
  });
});
