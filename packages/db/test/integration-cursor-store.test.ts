import { randomUUID } from 'node:crypto';
import { DEFAULT_CURSORS, IntegrationCursorStore } from '../src/integration-cursor-store';
import { applyBaseline, sealPack } from '../src/master-baseline';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const cursors = new IntegrationCursorStore();
const ACTOR = 1;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

describe('IntegrationCursorStore (positions of the integration connectors, ST-MDM-007)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, ACTOR, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  const idOf = async (connector: string, tenant = TENANT_A): Promise<string> => {
    const rows = await as((tx) => cursors.list(tx, { limit: 50, after: undefined }), tenant);
    return rows.find((row) => row.connectorCode === connector)?.id as string;
  };

  it('gives a tenant the default connectors once, each with an adapter that is only PROPOSED', async () => {
    expect(await as((tx) => cursors.ensureDefaults(tx, memberId(ACTOR)))).toBe(DEFAULT_CURSORS.length);
    expect(await as((tx) => cursors.ensureDefaults(tx, memberId(ACTOR)))).toBe(0);
    const rows = await as((tx) => cursors.list(tx, { limit: 50, after: undefined }));
    expect(rows.map((row) => row.connectorCode)).toEqual(['BUDGET_CODE_FILE', 'NATIONAL_PIM_FILE', 'PROCUREMENT_FILE', 'TREASURY_STATEMENT_FILE']);
    expect(rows.every((row) => row.adapterStatus === 'PROPOSED' && row.status === 'ACTIVE' && row.version === 1 && row.resetReason === null)).toBe(true);
    expect(await as((tx) => cursors.list(tx, { limit: 50, after: undefined }), TENANT_B)).toEqual([]);
  });

  it('is part of applying the baseline, which keeps a position that the connector already moved', async () => {
    await as((tx) => applyBaseline(tx, sealPack('EMPTY', []), memberId(ACTOR)), TENANT_B);
    expect((await as((tx) => cursors.list(tx, { limit: 50, after: undefined }), TENANT_B)).length).toBe(DEFAULT_CURSORS.length);
    const id = await idOf('NATIONAL_PIM_FILE', TENANT_B);
    await owner("update machvon.integration_cursor set cursor_json = '{\"offset\": 7}'::jsonb where id = $1::uuid", [id], TENANT_B);
    await as((tx) => applyBaseline(tx, sealPack('EMPTY', []), memberId(ACTOR)), TENANT_B);
    expect((await as((tx) => cursors.find(tx, id), TENANT_B))?.cursor).toEqual({ offset: 7 });
  });

  it('pages the list by connector', async () => {
    const first = await as((tx) => cursors.list(tx, { limit: 2, after: undefined }));
    const last = first[first.length - 1];
    const next = await as((tx) => cursors.list(tx, { limit: 2, after: { code: last?.connectorCode as string, id: last?.id as string } }));
    expect([...first, ...next].map((row) => row.connectorCode)).toEqual(['BUDGET_CODE_FILE', 'NATIONAL_PIM_FILE', 'PROCUREMENT_FILE', 'TREASURY_STATEMENT_FILE']);
  });

  describe('resetting a position (AC-ST-MDM-007-2)', () => {
    it('sets the position and the reason, starts a failed connector again and keeps the verdict on the adapter', async () => {
      const id = await idOf('TREASURY_STATEMENT_FILE');
      await owner(
        "update machvon.integration_cursor set status = 'FAILED', last_error_code = 'FILE_REJECTED', last_file_sha256 = repeat('a', 64), adapter_status = 'VERIFIED', last_success_at = now() where id = $1::uuid",
        [id],
      );
      const reset = await as((tx) => cursors.reset(tx, id, 1, { reason: 'Re-read the statements of March', cursor: { after_date: '2026-03-01' } }, memberId(ACTOR)));
      expect(reset.before).toMatchObject({ status: 'FAILED', lastErrorCode: 'FILE_REJECTED', version: 1 });
      expect(reset.row).toMatchObject({
        cursor: { after_date: '2026-03-01' },
        resetReason: 'Re-read the statements of March',
        status: 'ACTIVE',
        lastErrorCode: null,
        lastFileSha256: null,
        adapterStatus: 'VERIFIED',
        version: 2,
      });
      expect(reset.row.lastSuccessAt).not.toBeNull();
    });

    it('refuses a short or long reason, a position that is not an object or is too large', async () => {
      const id = await idOf('PROCUREMENT_FILE');
      const attempt = (reason: string, cursor: unknown) => refusal(as((tx) => cursors.reset(tx, id, 1, { reason, cursor: cursor as Record<string, unknown> }, memberId(ACTOR))));
      expect(await attempt('too short', {})).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await attempt('         ', {})).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await attempt('x'.repeat(2001), {})).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await attempt('A reason that is long enough', [])).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor_json' });
      expect(await attempt('A reason that is long enough', null)).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor_json' });
      expect(await attempt('A reason that is long enough', { blob: 'x'.repeat(9000) })).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor_json' });
      expect((await as((tx) => cursors.find(tx, id)))?.version).toBe(1);
    });

    it('refuses a stale version, an unknown connector and a connector of another tenant', async () => {
      const id = await idOf('BUDGET_CODE_FILE');
      const input = { reason: 'A reason that is long enough', cursor: {} };
      await expect(as((tx) => cursors.reset(tx, id, 5, input, memberId(ACTOR)))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => cursors.reset(tx, randomUUID(), 1, input, memberId(ACTOR))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => cursors.reset(tx, id, 1, input, memberId(ACTOR)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });
});
