import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import type { TenantContext } from '@machvon/kernel';
import { PipelinePortalScan, ScanPortPortalScan, portalScanFromEnvironment, scanFailClosed } from '../../src/modules/bid/portal-upload-scan';
import { ClamdScanPort, ScanUnavailableError, UnconfiguredScanPort, clamdFromEnvironment, parseClamdReply, scanPortFromEnvironment } from '../../src/modules/files/clamd-scan';
import { FileService } from '../../src/modules/files/file.service';
import type { ScanEvent } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort, eicarBytes } from '../../src/modules/files/mock-scan';
import { quarantineStateOf } from '../../src/modules/files/quarantine';
import { scanPortContract } from './scan-port.contract';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fake clamd: it speaks the INSTREAM protocol (zINSTREAM NUL, then chunks of a 4 byte big endian length, ended by a zero length chunk) and keeps what it received. The verdict of the
 * fake follows what real clamd does with the EICAR test string; `mode` makes it misbehave.
 */
type Mode = 'normal' | 'error-reply' | 'garbage' | 'silent' | 'refuse-limit' | 'close-early';

interface FakeClamd {
  server: Server;
  port: number;
  received: Buffer[];
  commands: string[];
  mode: Mode;
}

async function startFakeClamd(): Promise<FakeClamd> {
  const fake: FakeClamd = { server: createServer(), port: 0, received: [], commands: [], mode: 'normal' };
  fake.server.on('connection', (socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let commandRead = false;
    const payload: Buffer[] = [];
    socket.on('error', () => undefined);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (fake.mode === 'close-early') {
        socket.destroy();
        return;
      }
      if (!commandRead) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        fake.commands.push(buffer.subarray(0, end).toString('latin1'));
        buffer = buffer.subarray(end + 1);
        commandRead = true;
      }
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const whole = Buffer.concat(payload);
          fake.received.push(whole);
          if (fake.mode === 'silent') return;
          if (fake.mode === 'refuse-limit') socket.end('INSTREAM size limit exceeded. ERROR\0');
          else if (fake.mode === 'error-reply') socket.end('lstat() failed: No such file or directory. ERROR\0');
          else if (fake.mode === 'garbage') socket.end('hello\0');
          else socket.end(whole.includes(Buffer.from(eicarBytes())) ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffer.length < 4 + length) return;
        payload.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.port = (fake.server.address() as AddressInfo).port;
  return fake;
}

const text = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'utf8'));

describe('clamd scan adapter against a fake clamd', () => {
  let fake: FakeClamd;
  beforeAll(async () => {
    fake = await startFakeClamd();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });
  beforeEach(() => {
    fake.mode = 'normal';
    fake.received.length = 0;
    fake.commands.length = 0;
  });

  const adapter = (extra: Partial<ConstructorParameters<typeof ClamdScanPort>[0]> = {}): ClamdScanPort => new ClamdScanPort({ host: '127.0.0.1', port: fake.port, timeoutMs: 2_000, ...extra });

  // The contract of every adapter; the port of the fake is known only once it listens, so the adapter is made at the time of the call.
  scanPortContract('ClamdScanPort over a fake clamd', () => ({ scan: (bytes: Uint8Array) => adapter().scan(bytes) }));

  it('sends zINSTREAM, the bytes in length prefixed chunks and a zero chunk, and reads CLEAN', async () => {
    const bytes = Uint8Array.from(Buffer.alloc(150_000, 7));
    expect(await adapter({ chunkBytes: 64 * 1024 }).scan(bytes)).toBe('CLEAN');
    expect(fake.commands).toEqual(['zINSTREAM']);
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]?.equals(Buffer.from(bytes))).toBe(true);
  });

  it('reads FOUND as INFECTED and an empty file as CLEAN', async () => {
    expect(await adapter().scan(eicarBytes())).toBe('INFECTED');
    expect(await adapter().scan(new Uint8Array())).toBe('CLEAN');
  });

  it('is unavailable, never clean, when clamd answers with an error, with garbage, or says nothing', async () => {
    fake.mode = 'error-reply';
    await expect(adapter().scan(text('x'))).rejects.toMatchObject({ reason: 'SCANNER_ERROR' });
    fake.mode = 'refuse-limit';
    await expect(adapter().scan(text('x'))).rejects.toMatchObject({ reason: 'SCANNER_ERROR' });
    fake.mode = 'garbage';
    await expect(adapter().scan(text('x'))).rejects.toMatchObject({ reason: 'BAD_REPLY' });
    fake.mode = 'silent';
    await expect(adapter({ timeoutMs: 150 }).scan(text('x'))).rejects.toMatchObject({ reason: 'TIMEOUT' });
    fake.mode = 'close-early';
    await expect(adapter().scan(text('x'))).rejects.toBeInstanceOf(ScanUnavailableError);
  });

  it('is unavailable when nothing listens on the port, and when the file is above the limit (nothing is sent)', async () => {
    const closed = await startFakeClamd();
    const deadPort = closed.port;
    await new Promise<void>((resolve) => closed.server.close(() => resolve()));
    await expect(new ClamdScanPort({ host: '127.0.0.1', port: deadPort, timeoutMs: 1_000 }).scan(text('x'))).rejects.toMatchObject({ reason: 'CONNECTION' });
    await expect(adapter({ maxBytes: 10 }).scan(Uint8Array.from(Buffer.alloc(11)))).rejects.toMatchObject({ reason: 'TOO_LARGE' });
    expect(fake.commands).toEqual([]);
  });

  it('the portal hook on top of it answers CLEAN, INFECTED and UNAVAILABLE', async () => {
    const hook = new ScanPortPortalScan(adapter());
    expect(await hook.scan(text('%PDF-1.7 ordinary'))).toBe('CLEAN');
    expect(await hook.scan(eicarBytes())).toBe('INFECTED');
    fake.mode = 'error-reply';
    expect(await hook.scan(text('x'))).toBe('UNAVAILABLE');
    expect(await scanFailClosed(hook, text('x'), { tenantId: 't', mime: 'application/pdf' })).toBe('UNAVAILABLE');
  });

  describe('the upload pipeline with this scanner', () => {
    const root = mkdtempSync(join(tmpdir(), 'machvon-clamd-'));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const tenant: TenantContext = { tenantId: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', membershipId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', scopeVersion: 1 };
    const pdf = (extra = ''): Uint8Array => Uint8Array.from(Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nendobj\n${extra}\n%%EOF`, 'latin1'));
    const service = (events: ScanEvent[]): FileService =>
      new FileService({ storage: new FsObjectStorage(root), scanner: adapter(), urlSecret: 'a-secret-of-sixteen-bytes-or-more', onScanEvent: (event) => events.push(event) });

    it('a clean upload is released, an infected one is quarantined for good, an unavailable scanner holds the file and a later scan releases it', async () => {
      const events: ScanEvent[] = [];
      const files = service(events);
      const clean = await files.upload(tenant, { purpose: 'document', declaredType: 'application/pdf', bytes: pdf('clean') });
      expect(clean.scanStatus).toBe('CLEAN');
      expect(quarantineStateOf(clean.scanStatus)).toBe('RELEASED');

      const infected = await files.upload(tenant, { purpose: 'document', declaredType: 'application/pdf', bytes: pdf(Buffer.from(eicarBytes()).toString('latin1')) });
      expect(infected.scanStatus).toBe('INFECTED');
      expect(quarantineStateOf(infected.scanStatus)).toBe('QUARANTINED');
      await expect(files.open(tenant, infected.key)).rejects.toMatchObject({ code: 'FILE_NOT_CLEAN' });
      expect(events.map((event) => event.kind)).toEqual(['QUARANTINED']);

      fake.mode = 'error-reply';
      const held = await files.upload(tenant, { purpose: 'document', declaredType: 'application/pdf', bytes: pdf('held') });
      expect(held.scanStatus).toBe('PENDING');
      expect(quarantineStateOf(held.scanStatus)).toBe('HELD');
      await expect(files.open(tenant, held.key)).rejects.toMatchObject({ code: 'SCAN_PENDING' });
      expect(events.at(-1)).toMatchObject({ kind: 'HELD', key: held.key, reason: 'SCANNER_ERROR' });

      fake.mode = 'normal';
      expect((await files.scan(tenant, held.key)).scanStatus).toBe('CLEAN');
      expect((await files.open(tenant, held.key)).key).toBe(held.key);
    });
  });
});

describe('the scanner is chosen by the environment and closed by default', () => {
  it('clamav with a host is the ClamAV adapter; without a host it is unconfigured', async () => {
    expect(scanPortFromEnvironment({ MACHVON_SCAN_ADAPTER: 'clamav', MACHVON_CLAMD_HOST: 'clamav.internal' })).toBeInstanceOf(ClamdScanPort);
    const none = scanPortFromEnvironment({ MACHVON_SCAN_ADAPTER: 'clamav' });
    expect(none).toBeInstanceOf(UnconfiguredScanPort);
    await expect(none.scan(text('x'))).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
  });

  it('production without an adapter, with the MOCK, or with an unknown name refuses; development and tests keep the MOCK', () => {
    expect(scanPortFromEnvironment({ NODE_ENV: 'production' })).toBeInstanceOf(UnconfiguredScanPort);
    expect(scanPortFromEnvironment({ NODE_ENV: 'production', MACHVON_SCAN_ADAPTER: 'mock' })).toBeInstanceOf(UnconfiguredScanPort);
    expect(scanPortFromEnvironment({ NODE_ENV: 'development', MACHVON_SCAN_ADAPTER: 'clam-av' })).toBeInstanceOf(UnconfiguredScanPort);
    expect(scanPortFromEnvironment({ NODE_ENV: 'test' })).toBeInstanceOf(MockScanPort);
    expect(scanPortFromEnvironment({})).toBeInstanceOf(MockScanPort);
    expect(scanPortFromEnvironment({ MACHVON_SCAN_ADAPTER: 'mock', NODE_ENV: 'test' })).toBeInstanceOf(MockScanPort);
  });

  it('the host, the port (default 3310) and the time limit are read and checked', () => {
    expect(clamdFromEnvironment({})).toBeUndefined();
    expect(clamdFromEnvironment({ MACHVON_CLAMD_HOST: ' ' })).toBeUndefined();
    expect(clamdFromEnvironment({ MACHVON_CLAMD_HOST: 'h' })).toBeInstanceOf(ClamdScanPort);
    expect(clamdFromEnvironment({ MACHVON_CLAMD_HOST: 'h', MACHVON_CLAMD_PORT: '99999' })).toBeUndefined();
    expect(clamdFromEnvironment({ MACHVON_CLAMD_HOST: 'h', MACHVON_CLAMD_PORT: 'x' })).toBeUndefined();
    expect(clamdFromEnvironment({ MACHVON_CLAMD_HOST: 'h', MACHVON_CLAMD_TIMEOUT_MS: '0' })).toBeUndefined();
  });

  it('the portal hook: CLAMAV without a host or with a bad port is UNAVAILABLE for every file; PIPELINE is the opt in; the default is closed', async () => {
    expect(await portalScanFromEnvironment({ MACHVON_PORTAL_SCAN: 'CLAMAV' }).scan(text('x'), { tenantId: 't', mime: 'application/pdf' })).toBe('UNAVAILABLE');
    expect(await portalScanFromEnvironment({ MACHVON_PORTAL_SCAN: 'CLAMAV', MACHVON_CLAMD_HOST: 'h', MACHVON_CLAMD_PORT: '0' }).scan(text('x'), { tenantId: 't', mime: 'application/pdf' })).toBe('UNAVAILABLE');
    expect(portalScanFromEnvironment({ MACHVON_PORTAL_SCAN: 'CLAMAV', MACHVON_CLAMD_HOST: 'h' })).toBeInstanceOf(ScanPortPortalScan);
    expect(portalScanFromEnvironment({ MACHVON_PORTAL_SCAN: 'PIPELINE' })).toBeInstanceOf(PipelinePortalScan);
    expect(await portalScanFromEnvironment({}).scan(text('x'), { tenantId: 't', mime: 'application/pdf' })).toBe('UNAVAILABLE');
  });
});

describe('reading the reply of clamd', () => {
  it('only "stream: OK" is clean and only "<signature> FOUND" is infected', () => {
    expect(parseClamdReply('stream: OK\0')).toBe('CLEAN');
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND\0')).toBe('INFECTED');
    expect(() => parseClamdReply('stream: OK but not really')).toThrow(ScanUnavailableError);
    expect(() => parseClamdReply('')).toThrow(ScanUnavailableError);
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR')).toThrow(/SCANNER_ERROR/);
    expect(() => parseClamdReply('stream: OK\nstream: Virus FOUND')).toThrow(ScanUnavailableError);
  });

  it('maps a scan status to its quarantine state', () => {
    expect([quarantineStateOf('CLEAN'), quarantineStateOf('PENDING'), quarantineStateOf('INFECTED')]).toEqual(['RELEASED', 'HELD', 'QUARANTINED']);
  });
});
