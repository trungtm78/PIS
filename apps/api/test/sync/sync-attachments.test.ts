import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, SyncAttachmentStore, TenantDatabase } from '@machvon/db';
import { ATTACHMENT_CHUNK_BYTES, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { FileService } from '../../src/modules/files';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { ScanUnavailableError } from '../../src/modules/files/clamd-scan';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { SyncAttachmentsController } from '../../src/sync/attachments.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const PHONE_USER = 1;
const OTHER_USER = 2;
const OTHER_TENANT_USER = 1; // of tenant B
const MIB = ATTACHMENT_CHUNK_BYTES;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A file that starts like a JPEG, of the size asked for. */
const photo = (size: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), randomBytes(size - 8)]);
/** A file that starts like a PDF and carries the antivirus test string. */
const infected = (): Buffer => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(eicarBytes())]);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
interface Link {
  index: number;
  url: string;
}

jest.setTimeout(60_000);

describe('the attachments a phone uploads in chunks (ST-MOB-009, MOB-19)', () => {
  const harness = new AuthzHarness();
  const root = mkdtempSync(join(tmpdir(), 'machvon-sync-'));
  const scanner = new MockScanPort();
  const store = new SyncAttachmentStore();
  let clock = new Date();
  let app: RunningApp;
  let files: FileService;
  let storage: FsObjectStorage;
  const devices = new Map<number, string>();

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? PHONE_USER, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `att-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const start = (bytes: Buffer, overrides: Record<string, unknown> = {}, member = PHONE_USER) =>
    call('POST', '/sync/attachments', { member, body: { device_id: devices.get(member), sha256: sha(bytes), size_bytes: bytes.length, mime: 'image/jpeg', ...overrides } });
  const complete = (id: string, hash: string, options: { member?: number; key?: string } = {}) => call('POST', `/sync/attachments/${id}/complete`, { ...options, body: { sha256: hash } });
  const status = (id: string, member = PHONE_USER) => call('GET', `/sync/attachments/${id}`, { member });

  /** Sends one chunk to its link, as the phone does. */
  async function send(link: Link, bytes: Buffer, tamper?: (url: string) => string): Promise<Reply> {
    const slice = bytes.subarray(link.index * MIB, Math.min(bytes.length, (link.index + 1) * MIB));
    const response = await fetch(`${app.baseUrl}${tamper === undefined ? link.url : tamper(link.url)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: slice });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const linksOf = (reply: Reply): Link[] => reply.json.chunks as Link[];
  const idOf = (reply: Reply): string => (reply.json.resource_id ?? reply.json.id) as string;
  const row = async (id: string) => {
    const [found] = await rows<{ status: string; reason: string | null; storage_key: string; received: number[] }>('select status, reason, storage_key, received from machvon.sync_attachment where id = $1', [id]);
    if (found === undefined) throw new Error('no attachment');
    return found;
  };

  async function device(tenant: string, member: number): Promise<string> {
    const deviceId = randomUUID();
    await harness.owner(tenant, [
      [
        `insert into machvon.device_registration (tenant_id, id, membership_id, device_public_id, push_secret_ref, platform, last_seen_at, token_fingerprint, permission_state, app_version)
         values ($1, $2, $3, $4, $5, 'android', now(), repeat('a', 64), 'granted', '1.0.0')`,
        [tenant, deviceId, memberId(member), `public-${deviceId}`, `secret://push/${tenant}/${deviceId}`],
      ],
    ]);
    return deviceId;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const member of [PHONE_USER, OTHER_USER]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_USER, 1, { validFrom: '2026-01-01T00:00:00Z' });
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedRole(tenant, 1, 'PHONE', ['sync.upload'], 5);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PHONE_USER, role: 1, kind: 'TENANT' },
      { n: 2, member: OTHER_USER, role: 1, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_USER, role: 1, kind: 'TENANT' }]);
    for (const member of [PHONE_USER, OTHER_USER]) devices.set(member, await device(TENANT_A, member));
    storage = new FsObjectStorage(root, () => clock);
    files = new FileService({ storage, scanner, urlSecret: randomBytes(32), now: () => clock });
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [SyncAttachmentsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  beforeEach(() => {
    clock = new Date();
  });

  it('AC-ST-MOB-009-1 UAT-PLAN-34: a file of 12 MiB with the network cut at chunk 7 goes on from the chunk it stopped at, and the whole matches: UPLOADING, then CLEAN', async () => {
    const bytes = photo(12 * MIB);
    const started = await start(bytes);
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ status: 'UPLOADING', chunk_bytes: MIB, chunk_count: 12 });
    const id = idOf(started);
    const links = linksOf(started);
    expect(links.map((link) => link.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Chunks 0 to 5 arrive, in any order, and the network is cut.
    for (const index of [3, 0, 5, 1, 4, 2]) expect((await send(links[index] as Link, bytes)).status).toBe(200);
    const sentBefore = await status(id);
    expect(sentBefore.json).toMatchObject({ status: 'UPLOADING', received: [0, 1, 2, 3, 4, 5] });
    // The phone asks what the server holds and sends only what is missing: 6 to 11, with fresh links.
    const resumed = linksOf(sentBefore);
    expect(resumed.map((link) => link.index)).toEqual([6, 7, 8, 9, 10, 11]);
    for (const link of resumed) expect((await send(link, bytes)).status).toBe(200);
    expect((await status(id)).json).toMatchObject({ received: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], chunks: [] });
    const done = await complete(id, sha(bytes));
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'CLEAN', resource_id: id });
    const finished = await row(id);
    expect(finished).toMatchObject({ status: 'CLEAN', reason: null });
    // The file is stored under the prefix of the tenant, with the bytes that were sent, and the chunks are gone.
    expect(finished.storage_key.startsWith(`tenants/${TENANT_A}/`)).toBe(true);
    const stored = await storage.get({ tenantId: TENANT_A, membershipId: memberId(PHONE_USER), scopeVersion: 0 }, finished.storage_key);
    expect(stored?.bytes.length).toBe(bytes.length);
    expect(sha(stored?.bytes as Uint8Array)).toBe(sha(bytes));
    expect(stored?.object.scanStatus).toBe('CLEAN');
    expect(await storage.list({ tenantId: TENANT_A, membershipId: memberId(PHONE_USER), scopeVersion: 0 }, 'sync_chunk')).toEqual([]);
    expect(await rows("select 1 from machvon.outbox_event where type = 'sync.attachment_clean.v1' and aggregate_id = $1", [id])).toHaveLength(1);
    // A CLEAN attachment may be linked to a record.
    expect(await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PHONE_USER), scopeVersion: 1 }, (tx) => store.linkableKey(tx, id))).toBe(finished.storage_key);
  }, 120_000);

  it('AC-ST-MOB-009-2 UAT-AC506: an infected file is INFECTED with the reason, is not linked to a record, and a new upload is the way to try again', async () => {
    const bytes = infected();
    const started = await start(bytes, { mime: 'application/pdf' });
    const id = idOf(started);
    for (const link of linksOf(started)) await send(link, bytes);
    const done = await complete(id, sha(bytes));
    expect(done.json).toMatchObject({ status: 'INFECTED' });
    expect(await row(id)).toMatchObject({ status: 'INFECTED', reason: 'FILE_INFECTED' });
    expect((await status(id)).json).toMatchObject({ status: 'INFECTED', reason: 'FILE_INFECTED', chunks: [] });
    await expect(harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(PHONE_USER), scopeVersion: 1 }, (tx) => store.linkableKey(tx, id))).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_CLEAN', status: 409 });
    expect(await rows("select 1 from machvon.outbox_event where type = 'sync.attachment_clean.v1' and aggregate_id = $1", [id])).toEqual([]);
    // The file in the store is INFECTED and is not served.
    const key = (await row(id)).storage_key;
    await expect(files.download({ tenantId: TENANT_A, membershipId: memberId(PHONE_USER), scopeVersion: 1 }, key)).rejects.toMatchObject({ status: 422 });
    // Complete again is not a second scan.
    expect((await complete(id, sha(bytes))).status).toBe(409);
  });

  it('YCK.07: a scanner that gives no verdict neither cleans nor condemns the file: complete is refused with 409 and the phone completes again once the scanner is back', async () => {
    const bytes = photo(MIB + 10);
    const started = await start(bytes);
    const id = idOf(started);
    for (const link of linksOf(started)) await send(link, bytes);
    const away = jest.spyOn(scanner, 'scan').mockRejectedValueOnce(new ScanUnavailableError('CONNECTION'));
    const refused = await complete(id, sha(bytes));
    expect(refused.status).toBe(409);
    away.mockRestore();
    expect(await row(id)).toMatchObject({ status: 'UPLOADING' });
    const done = await complete(id, sha(bytes));
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: 'CLEAN' });
  });

  it('AC-ST-MOB-009-3 UAT-NFR-TENANCY-05: a link of one tenant used for the key of another, and an expired link, are both refused, and the storage key is always under the tenant prefix', async () => {
    const bytes = photo(MIB + 10);
    const started = await start(bytes);
    const id = idOf(started);
    const [first, second] = linksOf(started) as [Link, Link];
    const withTenant = (url: string, tenant: string): string => url.replace(`tenant=${TENANT_A}`, `tenant=${tenant}`);
    const foreign = await send(first, bytes, (url) => withTenant(url, TENANT_B));
    expect([foreign.status, foreign.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    // The link of chunk 0 used for chunk 1, a changed signature, a missing one.
    const other = await send(second, bytes, (url) => url.replace('/chunks/1?', '/chunks/0?'));
    expect([other.status, other.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    expect((await send(first, bytes, (url) => url.replace(/signature=([0-9a-f])/, (_match, digit: string) => `signature=${digit === '0' ? '1' : '0'}`))).status).toBe(401);
    expect((await send(first, bytes, (url) => url.split('&signature=')[0] as string)).status).toBe(401);
    expect((await row(id)).received).toEqual([]);
    // Expired: the link lives a few minutes.
    clock = new Date(clock.getTime() + 301_000);
    const late = await send(first, bytes);
    expect([late.status, late.json.code]).toEqual([401, 'SIGNATURE_INVALID']);
    clock = new Date();
    expect((await send(first, bytes)).status).toBe(200);
    expect((await row(id)).storage_key.startsWith(`tenants/${TENANT_A}/sync_attachment/`)).toBe(true);
    // The database refuses a key under another prefix.
    await expect(rows("update machvon.sync_attachment set storage_key = 'tenants/' || $2 || '/sync_attachment/x' where id = $1", [id, TENANT_B])).rejects.toThrow();
  });

  it('AC-ST-MOB-009-4 UAT-NFR-SECURITY-12: a script renamed to .jpg is refused when the upload is completed, by its bytes, and the chunks are dropped', async () => {
    const bytes = Buffer.from('<script>alert("x")</script>'.repeat(40));
    const started = await start(bytes);
    const id = idOf(started);
    for (const link of linksOf(started)) await send(link, bytes);
    const refused = await complete(id, sha(bytes));
    expect([refused.status, refused.json.code]).toEqual([422, 'FILE_TYPE_NOT_ALLOWED']);
    expect(await row(id)).toMatchObject({ status: 'UPLOADING', received: [] });
  });

  it('keeps the chunks of a new generation apart from the old: after the chunks are dropped, the old links stop working and a chunk sent late cannot be acknowledged and then lost', async () => {
    const bytes = photo(MIB + 5);
    const started = await start(bytes);
    const id = idOf(started);
    const oldLinks = linksOf(started);
    for (const link of oldLinks) await send(link, bytes);
    // The completion is refused and drops the chunks; a chunk of the old generation arrives at the same moment.
    const [refused, late] = await Promise.all([complete(id, sha(Buffer.from('another file'))), send(oldLinks[0] as Link, bytes)]);
    expect(refused.json).toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect([200, 409]).toContain(late.status);
    // Whichever came first, what the server says it holds is what it holds: nothing is acknowledged and lost.
    const after = await status(id);
    expect(after.json.received).toEqual([]);
    expect((await send(oldLinks[1] as Link, bytes)).status).toBe(409);
    // The new links belong to the new generation and work.
    const fresh = linksOf(after);
    expect(fresh.map((link) => link.index)).toEqual([0, 1]);
    for (const link of fresh) expect((await send(link, bytes)).status).toBe(200);
    expect((await status(id)).json.received).toEqual([0, 1]);
    for (const link of fresh) expect(await files.readPart(TENANT_A, `tenants/${TENANT_A}/sync_chunk/${id}-1-${link.index}`)).toBeDefined();
  });

  it('does not remove a stored file when an attempt does not commit: the next attempt completes the same upload and the file is there', async () => {
    const bytes = photo(MIB + 7);
    const started = await start(bytes);
    const id = idOf(started);
    for (const link of linksOf(started)) await send(link, bytes);
    // The first attempt stores the file and then fails (the audit trail is not available), so its transaction rolls back.
    const original = storage.setScanStatus.bind(storage);
    let failed = false;
    storage.setScanStatus = (async (...args: Parameters<typeof original>) => {
      if (!failed) {
        failed = true;
        throw new Error('the scanner crashed');
      }
      return original(...args);
    }) as typeof storage.setScanStatus;
    try {
      expect((await complete(id, sha(bytes))).status).toBe(500);
      expect(await row(id)).toMatchObject({ status: 'UPLOADING' });
      expect((await complete(id, sha(bytes))).json).toMatchObject({ status: 'CLEAN' });
    } finally {
      storage.setScanStatus = original;
    }
    const stored = await storage.get({ tenantId: TENANT_A, membershipId: memberId(PHONE_USER), scopeVersion: 0 }, (await row(id)).storage_key);
    expect(sha(stored?.bytes as Uint8Array)).toBe(sha(bytes));
    expect(stored?.object.scanStatus).toBe('CLEAN');
  });

  it('refuses a whole that is not what was declared: another SHA-256 from the phone, or bytes that differ, is 422 CHECKSUM_MISMATCH and the chunks are dropped to be sent again', async () => {
    const bytes = photo(MIB + 5);
    const started = await start(bytes);
    const id = idOf(started);
    for (const link of linksOf(started)) await send(link, bytes);
    const wrong = await complete(id, sha(Buffer.from('another file')));
    expect([wrong.status, wrong.json.code]).toEqual([422, 'CHECKSUM_MISMATCH']);
    expect((await row(id)).received).toEqual([]);
    // Bytes that differ from the declared hash: the same.
    const other = photo(MIB + 5);
    const second = await start(bytes);
    const secondId = idOf(second);
    for (const link of linksOf(second)) await send(link, other);
    expect((await complete(secondId, sha(bytes))).json).toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect((await row(secondId)).received).toEqual([]);
  });

  it('asks for the chunks that are missing, and a chunk that has not its size, or an upload that is over, is refused', async () => {
    const bytes = photo(2 * MIB + 3);
    const started = await start(bytes);
    const id = idOf(started);
    const links = linksOf(started);
    expect(links).toHaveLength(3);
    await send(links[0] as Link, bytes);
    const early = await complete(id, sha(bytes));
    expect([early.status, early.json.code]).toEqual([409, 'ATTACHMENT_CHUNKS_MISSING']);
    expect(early.json.missing).toEqual([1, 2]);
    const short = await fetch(`${app.baseUrl}${(links[1] as Link).url}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes.subarray(0, 100) });
    expect(short.status).toBe(422);
    const long = await fetch(`${app.baseUrl}${(links[2] as Link).url}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes.subarray(0, MIB) });
    expect(long.status).toBe(413);
    for (const link of links.slice(1)) await send(link, bytes);
    expect((await complete(id, sha(bytes))).json).toMatchObject({ status: 'CLEAN' });
    // The upload is over: another chunk is refused.
    const after = await send(links[0] as Link, bytes);
    expect([after.status, after.json.code]).toEqual([409, 'ATTACHMENT_STATE_INVALID']);
  });

  it('sends the same chunk twice as one, and answers a completion sent again with the key it was sent with from the stored answer', async () => {
    const bytes = photo(MIB + 1);
    const started = await start(bytes);
    const id = idOf(started);
    const links = linksOf(started);
    await send(links[0] as Link, bytes);
    await send(links[0] as Link, bytes);
    await send(links[1] as Link, bytes);
    expect((await row(id)).received).toEqual([0, 1]);
    const key = `att-${randomUUID()}`;
    const first = await complete(id, sha(bytes), { key });
    const again = await complete(id, sha(bytes), { key });
    expect(again.json).toEqual(first.json);
    const other = await complete(id, sha(bytes));
    expect([other.status, other.json.code]).toEqual([409, 'ATTACHMENT_STATE_INVALID']);
  });

  it('is for the member who started it, on a device of theirs: another member sees no such upload, another device is 403, and what cannot be uploaded is refused at the start', async () => {
    const bytes = photo(MIB);
    const started = await start(bytes);
    const id = idOf(started);
    expect((await status(id, OTHER_USER)).status).toBe(404);
    expect((await complete(id, sha(bytes), { member: OTHER_USER })).status).toBe(404);
    expect((await call('GET', `/sync/attachments/${id}`, { member: OTHER_TENANT_USER, tenantId: TENANT_B })).status).toBe(404);
    expect((await call('POST', '/sync/attachments', { body: { device_id: devices.get(OTHER_USER), sha256: sha(bytes), size_bytes: bytes.length, mime: 'image/jpeg' } })).status).toBe(403);
    expect((await start(bytes, { size_bytes: 50 * MIB + 1 })).status).toBe(422);
    expect((await start(bytes, { mime: 'image/svg+xml' })).status).toBe(422);
    expect((await start(bytes, { sha256: 'F'.repeat(64) })).status).toBe(422);
  });

  it('keeps no secret in the audit trail: the size and the type only, never the checksum, the key or a link', async () => {
    const bytes = photo(MIB);
    const started = await start(bytes);
    const id = idOf(started);
    const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'sync.attachment_started' and resource_id = $1", [id]);
    expect(audit[0]?.safe_diff).toMatchObject({ size_bytes: MIB, mime: 'image/jpeg', chunk_count: 1 });
    expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${sha(bytes)}|signature|tenants/`));
  });

  it('keeps the moves of an attachment in the database: it never goes back, and a finished file gets no more chunks', async () => {
    const bytes = photo(MIB);
    const started = await start(bytes);
    const id = idOf(started);
    for (const link of linksOf(started)) await send(link, bytes);
    await complete(id, sha(bytes));
    await expect(rows("update machvon.sync_attachment set status = 'UPLOADING' where id = $1", [id])).rejects.toThrow(/does not go from/);
    await expect(rows("update machvon.sync_attachment set received = '{9}' where id = $1", [id])).rejects.toThrow(/no longer being uploaded/);
    await expect(rows("update machvon.sync_attachment set sha256 = repeat('b', 64) where id = $1", [id])).rejects.toThrow(/is not changed/);
  });
});
