import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { AuditSealJob, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, verifyAuditExport } from '@machvon/db';
import type { ExportFormat } from '@machvon/db';
import { loadErrorRegistry, objectKey, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { AuditEventsController } from '../../src/modules/adm/audit-events.controller';
import { AUDIT_EXPORT_METRIC, AuditExportsController } from '../../src/modules/adm/audit-export.controller';
import { ADM_CLOCK, ADM_METRICS } from '../../src/modules/adm/tokens';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const EXPORTER = 1; // audit.export and audit_event.read on the whole tenant
const SUBTREE_EXPORTER = 2; // audit.export on the subtree of unit 2 only
const READER = 3; // audit_event.read only
const GUEST = 4; // contract.read only: a guest contractor
const NOBODY = 5;
const OTHER_TENANT_EXPORTER = 1; // of tenant B
const FIXED_NOW = new Date('2027-02-01T08:00:00.000Z');
const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const REDACTED = '[REDACTED]';
// Values that must never reach a reader; built from pieces so that no literal in the file looks like a credential.
const PLANTED_KEY = ['k', 'secret', '1'].join('-');
const PLANTED_WORD = ['hunter', '2'].join('');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the audit viewer reads and the sealed export (ST-ADM-016, ADM-11)', () => {
  const harness = new AuthzHarness();
  const metrics: Array<{ name: string; labels?: Record<string, string> }> = [];
  const root = mkdtempSync(join(tmpdir(), 'machvon-audit-export-'));
  let app: RunningApp;
  let files: FileService;
  let planted = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const exportRequest = (member: number, body: Record<string, unknown>, options: { tenantId?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', '/audit-exports', { member, body, ...options });
  const wholeYear = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    from: new Date(START).toISOString(),
    to: new Date(START + 366 * DAY).toISOString(),
    format: 'JSONL',
    ...extra,
  });
  /** The first hundred days of the year: everything the tests plant, and none of the rows that the calls themselves write now. */
  const early = (extra: Record<string, unknown> = {}): Record<string, unknown> => wholeYear({ to: new Date(START + 100 * DAY).toISOString(), ...extra });
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  /** Plants an audit row at a day of the year; `diff` and `outcome` default to a plain success. */
  async function plant(tenant: string, day: number, extra: { actor?: string; outcome?: string; diff?: Record<string, unknown>; reason?: string; action?: string } = {}): Promise<string> {
    planted += 1;
    const rowId = id(0x70, planted);
    await harness.owner(tenant, [
      [
        `insert into machvon.audit_event
           (tenant_id, id, actor_id, action, resource_type, resource_id, safe_diff, reason, correlation_id, request_id, occurred_at, outcome)
         values ($1, $2, $3, $4, 'widget', $5, $6::jsonb, $7, $5, $5, $8::timestamptz, $9)`,
        [tenant, rowId, extra.actor ?? memberId(EXPORTER), extra.action ?? `widget.change.${planted}`, id(0x71, planted), JSON.stringify(extra.diff ?? { n: planted }), extra.reason ?? null, new Date(START + day * DAY).toISOString(), extra.outcome ?? 'SUCCESS'],
      ],
    ]);
    return rowId;
  }

  const sealAll = (tenant = TENANT_A): Promise<unknown> => new AuditSealJob(harness.tenants, { windowRows: 5 }).seal({ tenantId: tenant, membershipId: memberId(EXPORTER), scopeVersion: 1 });

  /** The object an export wrote, read back through the file service as the tenant. */
  async function stored(reply: Reply, tenant = TENANT_A): Promise<string> {
    const key = objectKey(tenant, 'audit_export', reply.json.resource_id as string);
    const { bytes } = await files.download({ tenantId: tenant, membershipId: memberId(EXPORTER), scopeVersion: 1 }, key);
    return Buffer.from(bytes).toString('utf8');
  }
  const objectsOf = async (tenant = TENANT_A): Promise<number> => (await new FsObjectStorage(root).list({ tenantId: tenant, membershipId: memberId(EXPORTER), scopeVersion: 1 }, 'audit_export')).length;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    const unitOf: Record<number, number> = { [EXPORTER]: 1, [SUBTREE_EXPORTER]: 2, [READER]: 1, [GUEST]: 2, [NOBODY]: 1 };
    for (const [member, unit] of Object.entries(unitOf)) await harness.seedMembership(TENANT_A, Number(member), unit);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_EXPORTER, 1);
    await harness.seedRole(TENANT_A, 1, 'AUDIT_EXPORTER', ['audit.export', 'audit_event.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'AUDIT_READER', ['audit_event.read'], 20);
    await harness.seedRole(TENANT_A, 3, 'GUEST_CONTRACTOR', ['contract.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'AUDIT_EXPORTER', ['audit.export', 'audit_event.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: EXPORTER, role: 1, kind: 'TENANT' },
      { n: 2, member: SUBTREE_EXPORTER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 3, member: READER, role: 2, kind: 'TENANT' },
      { n: 4, member: GUEST, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_EXPORTER, role: 1, kind: 'TENANT' }]);
    // Twelve days of activity in tenant A (three seal windows of five rows, the last one short) and a row that only tenant B has.
    for (let day = 10; day < 22; day += 1) await plant(TENANT_A, day);
    await sealAll();
    await plant(TENANT_B, 15, { action: 'secret.of.tenant.b' });
    await sealAll(TENANT_B);

    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    const recorder: MetricsSink = { increment: (name, labels) => void metrics.push({ name, ...(labels === undefined ? {} : { labels }) }), gauge: () => undefined };
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AuditEventsController, AuditExportsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: ADM_METRICS, useValue: recorder },
        { provide: ADM_CLOCK, useValue: () => FIXED_NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  describe('exportAuditLog', () => {
    it('rejects 367 days with 422 EXPORT_RANGE_TOO_LARGE and keeps no file and no audit row, and a 366-day export holds the seal list (AC-ST-ADM-016-1, UAT-AC139)', async () => {
      const tooLong = await exportRequest(EXPORTER, wholeYear({ to: new Date(START + 367 * DAY).toISOString() }));
      expect([tooLong.status, tooLong.json.code]).toEqual([422, 'EXPORT_RANGE_TOO_LARGE']);
      expect(await objectsOf()).toBe(0);
      expect(await rows("select 1 from machvon.audit_event where action = 'audit.exported'")).toEqual([]);

      const reply = await exportRequest(EXPORTER, wholeYear());
      expect(reply.status).toBe(202);
      expect(reply.json).toMatchObject({ status: 'READY', resource_version: 1 });
      const text = await stored(reply);
      const records = text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]).toMatchObject({ record_type: 'MANIFEST', tenant_id: TENANT_A, generated_at: FIXED_NOW.toISOString(), events: 12, seals: 3, unsealed_events: 0 });
      expect(records.filter((record) => record.record_type === 'SEAL')).toHaveLength(3);
      expect(verifyAuditExport(text, 'JSONL')).toEqual({ ok: true, findings: [], seals: 3, events: 12, leafOnly: 0, unsealedEvents: 0, boundEvents: 12 });
      expect(text).not.toContain('secret.of.tenant.b');

      const [audit] = await rows<{ classification: string; safe_diff: Record<string, unknown>; resource_id: string }>("select classification, safe_diff, resource_id from machvon.audit_event where action = 'audit.exported'");
      expect(audit).toMatchObject({ classification: 'CONFIDENTIAL', resource_id: reply.json.resource_id, safe_diff: { format: 'JSONL', events: 12, seals: 3, leaf_only: 0, unsealed_events: 0, resource_types: null } });
      expect(metrics).toContainEqual({ name: AUDIT_EXPORT_METRIC, labels: { tenant_id: TENANT_A, format: 'JSONL' } });
    });

    it('cuts a period short of the whole trail: only its events, the seals that touch it and the leaves of their windows', async () => {
      const reply = await exportRequest(EXPORTER, early({ from: new Date(START + 12 * DAY).toISOString(), to: new Date(START + 17 * DAY).toISOString() }));
      const text = await stored(reply);
      const verdict = verifyAuditExport(text, 'JSONL');
      expect(verdict).toMatchObject({ ok: true, events: 5, seals: 2 });
      expect(verdict.leafOnly).toBe(5);
    });

    it('writes CSV when asked and keeps only the asked resource types as events', async () => {
      const reply = await exportRequest(EXPORTER, early({ format: 'CSV' as ExportFormat }));
      const text = await stored(reply);
      expect(text.startsWith('record_type,')).toBe(true);
      expect(verifyAuditExport(text, 'CSV')).toMatchObject({ ok: true, seals: 3, events: 12 });
      const none = await exportRequest(EXPORTER, early({ resource_types: ['gadget'] }));
      expect(verifyAuditExport(await stored(none), 'JSONL')).toMatchObject({ ok: true, events: 0 });
    });

    it('answers a retry with the same key with the first export and writes one file only (Idempotency-Key)', async () => {
      const before = await objectsOf();
      const key = `key-${randomUUID()}`;
      const first = await exportRequest(EXPORTER, early({ resource_types: ['widget'] }), { key });
      const again = await exportRequest(EXPORTER, early({ resource_types: ['widget'] }), { key });
      expect([first.status, again.status]).toEqual([202, 202]);
      expect(again.json.resource_id).toBe(first.json.resource_id);
      expect(await objectsOf()).toBe(before + 1);
    });

    it('is for a grant on the whole tenant: a subtree grant, a reader without the permission and a guest are refused, and the refusals are audited', async () => {
      const subtree = await exportRequest(SUBTREE_EXPORTER, wholeYear());
      expect([subtree.status, subtree.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows("select actor_id from machvon.audit_event where action = 'command.denied:exportAuditLog' and outcome = 'DENIED'")).toEqual([{ actor_id: memberId(SUBTREE_EXPORTER) }]);
      const reader = await exportRequest(READER, wholeYear());
      expect(reader.status).toBe(403);
      const guest = await exportRequest(GUEST, wholeYear());
      expect(guest.status).toBe(403);
      const denied = await rows<{ actor_id: string }>("select actor_id from machvon.audit_event where action = 'authz.denied:exportAuditLog' and outcome = 'DENIED' order by occurred_at");
      expect(denied.map((row) => row.actor_id)).toEqual([memberId(READER), memberId(GUEST)]);
    });

    it('lets the auditor find the refusal of a guest by the outcome DENIED, with the diff redacted (AC-ST-ADM-016-2, UAT-AC140)', async () => {
      await plant(TENANT_A, 40, { actor: memberId(GUEST), outcome: 'DENIED', action: 'authz.denied:placeLegalHold', diff: { reason: 'MISSING_PERMISSION', api_key: PLANTED_KEY, nested: { password: PLANTED_WORD } } });
      const reply = await call('GET', '/resources/audit_event?outcome=DENIED', { member: EXPORTER });
      expect(reply.status).toBe(200);
      const items = reply.json.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items.every((item) => item.outcome === 'DENIED')).toBe(true);
      const planted = items.find((item) => item.action === 'authz.denied:placeLegalHold');
      expect(planted).toMatchObject({ actor_id: memberId(GUEST), safe_diff: { reason: 'MISSING_PERMISSION', api_key: REDACTED, nested: { password: REDACTED } } });
      expect(JSON.stringify(reply.json)).not.toContain(PLANTED_KEY);
      expect(JSON.stringify(reply.json)).not.toContain(PLANTED_WORD);
    });

    it('refuses a period that is empty or reversed, an unknown type name, an unparseable instant and an unknown format', async () => {
      const reversed = await exportRequest(EXPORTER, wholeYear({ from: new Date(START + DAY).toISOString(), to: new Date(START).toISOString() }));
      expect([reversed.status, reversed.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await exportRequest(EXPORTER, wholeYear({ to: wholeYear().from }))).status).toBe(422);
      expect((await exportRequest(EXPORTER, wholeYear({ resource_types: ['Not A Type'] }))).status).toBe(422);
      expect((await exportRequest(EXPORTER, wholeYear({ resource_types: [] }))).status).toBe(422);
      expect((await exportRequest(EXPORTER, wholeYear({ from: '2026-01-01' }))).status).toBe(422);
      expect((await exportRequest(EXPORTER, wholeYear({ format: 'XML' }))).status).toBe(422);
    });

    it('refuses a file the antivirus does not pass with 422 FILE_NOT_CLEAN and audits nothing (a CSV carries the test string as it is)', async () => {
      await plant(TENANT_A, 60, { reason: Buffer.from(eicarBytes()).toString('latin1'), action: 'widget.eicar' });
      const exported = async (): Promise<number> => (await rows("select 1 from machvon.audit_event where action = 'audit.exported'")).length;
      const before = await exported();
      const reply = await exportRequest(EXPORTER, early({ format: 'CSV' }));
      expect([reply.status, reply.json.code]).toEqual([422, 'FILE_NOT_CLEAN']);
      expect(await exported()).toBe(before);
      // JSON lines escape the backslash of the test string, so the same period still exports in that form.
      expect((await exportRequest(EXPORTER, early())).status).toBe(202);
    });

    it('exports the trail of the tenant of the caller only', async () => {
      const reply = await exportRequest(OTHER_TENANT_EXPORTER, wholeYear(), { tenantId: TENANT_B });
      expect(reply.status).toBe(202);
      const text = await stored(reply, TENANT_B);
      expect(text).toContain('secret.of.tenant.b');
      expect(text).not.toContain('widget.change.');
      expect(verifyAuditExport(text, 'JSONL')).toMatchObject({ ok: true, events: 1 });
    });
  });
});
