import { DomainError } from '../src/errors';
import { createHash } from 'node:crypto';
import {
  BUILT_IN_PROTOCOLS,
  FileDropAdapter,
  GeneratorAdapter,
  InMemoryDropFolder,
  InMemorySinkFake,
  InMemorySourceFake,
  NO_EGRESS_EXCEPTIONS,
  RefusingProtocolAdapter,
  TRANSPORT_PROTOCOLS,
  WebhookInboundAdapter,
  assertProtocolDefinition,
  assertReadOnlyStatement,
  detectArrivals,
  egressVerdict,
  makeBatch,
  parseManifest,
  protocolDefinition,
  protocolDefinitions,
  protocolPortFor,
  readFlatXml,
  recordsOfFile,
  registerProtocol,
  runWithNetworkWatch,
  soapEnvelope,
  verifyWebhook,
  webhookSignatureOf,
} from '../src/index';
import type { InboundProtocolPort, SourceRecord } from '../src/index';

const refusal = async (run: () => unknown): Promise<DomainError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const NOW = new Date('2026-11-08T03:00:00Z');
const LAYOUT = { format: 'CSV' as const, version: '1.0', keyColumns: ['code'] };
const CSV = 'code,name\nA1,Alpha\nB2,Beta\n';
const request = { pipeline: 'P', mode: 'INCREMENTAL' as const, watermark: null };

describe('the registry of protocols', () => {
  it('holds the nine built-in protocols, each with security needs, an egress class and failure semantics', () => {
    expect(protocolDefinitions().map((definition) => definition.code)).toEqual(expect.arrayContaining([...TRANSPORT_PROTOCOLS]));
    for (const definition of BUILT_IN_PROTOCOLS) {
      expect(() => assertProtocolDefinition(definition)).not.toThrow();
      expect(definition.security.auth.length).toBeGreaterThan(0);
      expect(['NONE', 'ALLOWLISTED_HOST', 'CUSTOMER_NETWORK']).toContain(definition.egress);
      expect(definition.failure.maxAttempts).toBeGreaterThanOrEqual(1);
    }
  });

  it('implements end to end exactly the protocols that need no outgoing connection', () => {
    const implemented = BUILT_IN_PROTOCOLS.filter((definition) => definition.implementation === 'END_TO_END').map((definition) => definition.code);
    expect(implemented.sort()).toEqual(['FILE_DROP', 'GENERATOR', 'WEBHOOK_INBOUND']);
    for (const definition of BUILT_IN_PROTOCOLS) expect(definition.egress === 'NONE').toBe(definition.implementation === 'END_TO_END');
  });

  it('says what each government style protocol needs: TLS, WS-Security options, a read-only database, a signed webhook', () => {
    expect(protocolDefinition('SOAP_XML')).toMatchObject({ egress: 'CUSTOMER_NETWORK', security: { tls: 'REQUIRED' } });
    expect(protocolDefinition('SOAP_XML')?.security.auth).toContain('WS_SECURITY');
    expect(protocolDefinition('SOAP_XML')?.configuration).toContain('ws_security_mode');
    expect(protocolDefinition('DB_READ')?.directions).toEqual(['INBOUND']);
    expect(protocolDefinition('WEBHOOK_INBOUND')).toMatchObject({ security: { signature: 'REQUIRED' }, failure: { delivery: 'EXACTLY_ONCE_BY_KEY' } });
  });

  it('is open to a new protocol, judged like the others, and refuses a repeat or an unsafe definition', () => {
    const base = { ...(protocolDefinition('HTTPS_REST') as NonNullable<ReturnType<typeof protocolDefinition>>), code: 'GRPC_STREAM', name: 'gRPC stream' };
    expect(() => assertProtocolDefinition({ ...base, security: { auth: ['API_KEY'], tls: 'NOT_APPLICABLE', signature: 'NONE' } })).toThrow('TLS');
    expect(() => assertProtocolDefinition({ ...base, failure: { ...base.failure, idempotencyRequired: false } })).toThrow('idempotent');
    registerProtocol(base);
    expect(protocolDefinition('GRPC_STREAM')).toBeDefined();
    expect(() => registerProtocol(base)).toThrow('already registered');
  });
});

describe('the egress gate and the refusing adapters', () => {
  it('needs no host for a protocol with egress NONE and an approved exception for any other', () => {
    expect(egressVerdict({ connectorCode: 'x.y', protocol: 'FILE_DROP', host: null, now: NOW, exceptions: NO_EGRESS_EXCEPTIONS })).toBe('NOT_NEEDED');
    expect(egressVerdict({ connectorCode: 'x.y', protocol: 'HTTPS_REST', host: 'api.example.org', now: NOW, exceptions: NO_EGRESS_EXCEPTIONS })).toBe('EXCEPTION_REQUIRED');
    expect(egressVerdict({ connectorCode: 'x.y', protocol: 'HTTPS_REST', host: 'api.example.org', now: NOW, exceptions: { isApproved: (r) => r.host === 'api.example.org' && r.connectorCode === 'x.y' } })).toBe('APPROVED');
    expect(egressVerdict({ connectorCode: 'x.y', protocol: 'HTTPS_REST', host: null, now: NOW, exceptions: { isApproved: () => true } })).toBe('EXCEPTION_REQUIRED');
    expect(egressVerdict({ connectorCode: 'x.y', protocol: 'NOPE', host: 'h', now: NOW, exceptions: NO_EGRESS_EXCEPTIONS })).toBe('UNKNOWN_PROTOCOL');
  });

  it('refuses every call with 503 HUB_PROTOCOL_UNAVAILABLE, naming whether an exception is missing or the adapter is', async () => {
    const waiting = protocolPortFor({ connectorCode: 'x.y', protocol: 'SFTP', host: 'sftp.example.org', now: NOW });
    expect(waiting).toBeInstanceOf(RefusingProtocolAdapter);
    const error = await refusal(() => waiting.extract());
    expect(error).toMatchObject({ code: 'HUB_PROTOCOL_UNAVAILABLE', status: 503, extensions: { protocol: 'SFTP', reason: 'EGRESS_EXCEPTION_REQUIRED' } });
    expect((await refusal(() => waiting.send())).code).toBe('HUB_PROTOCOL_UNAVAILABLE');
    const approved = protocolPortFor({ connectorCode: 'x.y', protocol: 'SFTP', host: 'sftp.example.org', now: NOW, exceptions: { isApproved: () => true } });
    expect((await refusal(() => approved.extract())).extensions).toMatchObject({ reason: 'ADAPTER_NOT_IMPLEMENTED' });
    expect(() => protocolPortFor({ connectorCode: 'x.y', protocol: 'NOPE', host: null, now: NOW })).toThrow(DomainError);
  });
});

describe('FILE_DROP, end to end with no network', () => {
  it('reads CSV, JSON, flat XML and refuses a DOCTYPE', () => {
    expect(recordsOfFile('a.csv', new TextEncoder().encode(CSV), LAYOUT).map((record) => record.key)).toEqual(['A1', 'B2']);
    expect(recordsOfFile('a.csv', new TextEncoder().encode(CSV), LAYOUT)[1]).toMatchObject({ sourceRef: 'a.csv#3', line: 3, fields: { code: 'B2', name: 'Beta' } });
    expect(recordsOfFile('a.json', new TextEncoder().encode('[{"code":"J1","n":1},{"code":"J2","n":2}]'), { ...LAYOUT, format: 'JSON' }).map((record) => record.fields.n)).toEqual([1, 2]);
    expect(recordsOfFile('a.xml', new TextEncoder().encode('<?xml version="1.0"?><rows><row><code>X1</code><name>A &amp; B</name></row></rows>'), { ...LAYOUT, format: 'XML' })[0]?.fields).toEqual({ code: 'X1', name: 'A & B' });
    expect(() => readFlatXml('<!DOCTYPE x [<!ENTITY e "x">]><rows><row><code>&e;</code></row></rows>')).toThrow(DomainError);
    expect(() => recordsOfFile('a.csv', new TextEncoder().encode('code,name\n,Alpha\n'), LAYOUT)).toThrow(DomainError);
  });

  it('parses a manifest and refuses a malformed line or a repeated name', () => {
    expect([...parseManifest(`# delivery\n${sha('x')}  a.csv\n${sha('y')} *b.csv\n`)]).toEqual([['a.csv', sha('x')], ['b.csv', sha('y')]]);
    expect(() => parseManifest('not a manifest line')).toThrow(DomainError);
    expect(() => parseManifest(`${sha('x')}  a.csv\n${sha('y')}  a.csv\n`)).toThrow(DomainError);
  });

  it('detects arrival only once a file looked the same on enough polls, and holds the manifest back', () => {
    const entry = { name: 'a.csv', size: 10, modifiedAtMs: 1 };
    const first = detectArrivals([entry], { seen: new Map() }, { stablePolls: 2, manifestName: 'M' });
    expect(first.arrived).toEqual([]);
    expect(detectArrivals([entry], first.state, { stablePolls: 2, manifestName: 'M' }).arrived).toEqual(['a.csv']);
    const growing = detectArrivals([{ ...entry, size: 20 }], first.state, { stablePolls: 2, manifestName: 'M' });
    expect(growing.arrived).toEqual([]);
    const withManifest = detectArrivals([{ name: 'M', size: 1, modifiedAtMs: 1 }], { seen: new Map([['M', { size: 1, modifiedAtMs: 1, stable: 5 }]]) }, { stablePolls: 2, manifestName: 'M' });
    expect(withManifest.arrived).toEqual([]);
  });

  it('takes a file after two polls, checks its checksum against the manifest, gives records with lines and a batch hash, and settles it only on confirm', async () => {
    const folder = new InMemoryDropFolder();
    folder.put('a.csv', CSV, 5);
    folder.put('MANIFEST.sha256', `${sha(CSV)}  a.csv\n`, 5);
    const adapter = new FileDropAdapter(folder, LAYOUT);
    expect((await adapter.extract(request)).records).toEqual([]);
    const batch = await adapter.extract(request);
    expect(batch.records.map((record) => record.key)).toEqual(['A1', 'B2']);
    expect(batch.nextWatermark).toBe('a.csv');
    expect(batch.batchSha256).toMatch(/^[0-9a-f]{64}$/);
    // Until the load succeeded and confirm is called, the same file is read again: a failed load loses nothing.
    expect((await adapter.extract(request)).batchSha256).toBe(batch.batchSha256);
    expect(folder.settled).toEqual([]);
    await adapter.confirm();
    expect(folder.settled).toEqual([{ name: 'a.csv', outcome: 'PROCESSED' }]);
    expect((await adapter.extract(request)).records).toEqual([]);
  });

  it('rejects a file whose bytes differ from the manifest and one the manifest does not list, and reads neither', async () => {
    const folder = new InMemoryDropFolder();
    folder.put('a.csv', CSV, 5);
    folder.put('b.csv', CSV, 5);
    folder.put('MANIFEST.sha256', `${sha('other bytes')}  a.csv\n`, 5);
    const adapter = new FileDropAdapter(folder, LAYOUT);
    await adapter.extract(request);
    const batch = await adapter.extract(request);
    expect(batch.records).toEqual([]);
    expect(adapter.rejected).toEqual([{ name: 'a.csv', reason: 'CHECKSUM_MISMATCH' }, { name: 'b.csv', reason: 'NOT_IN_MANIFEST' }]);
    expect(folder.settled).toEqual([{ name: 'a.csv', outcome: 'REJECTED' }]);
  });

  it('refuses a layout version it does not read and a file that is not in the layout', async () => {
    const folder = new InMemoryDropFolder();
    folder.put('a.csv', CSV, 5);
    folder.put('bad.csv', 'x\n1\n', 5);
    const adapter = new FileDropAdapter(folder, LAYOUT);
    await adapter.extract(request);
    expect((await refusal(() => adapter.extract({ ...request, layoutVersion: '9.9' }))).extensions).toMatchObject({ supported: ['1.0'] });
    const batch = await adapter.extract(request);
    expect(batch.records.map((record) => record.key)).toEqual(['A1', 'B2']);
    expect(adapter.rejected).toContainEqual({ name: 'bad.csv', reason: 'LAYOUT_INVALID' });
  });

  it('opens no connection while it works', async () => {
    const attempts = await runWithNetworkWatch(async () => {
      const folder = new InMemoryDropFolder();
      folder.put('a.csv', CSV, 5);
      const adapter = new FileDropAdapter(folder, LAYOUT, { stablePolls: 1 });
      await adapter.extract(request);
      await adapter.confirm();
    });
    expect(attempts).toEqual([]);
  });
});

describe('WEBHOOK_INBOUND', () => {
  const fixtureKey = 'test-signing-fixture-only';
  const body = new TextEncoder().encode('{"code":"W1","amount":5}');
  const timestamp = Math.floor(NOW.getTime() / 1000);
  const delivery = (patch: Record<string, unknown> = {}) => ({ body, timestamp, signature: webhookSignatureOf(fixtureKey, timestamp, body), idempotencyKey: 'delivery-0001', ...patch });
  const options = { secret: fixtureKey, now: NOW, toleranceSeconds: 300, seenKeys: new Set<string>() };

  it('accepts a signed delivery and answers a repeat of the key as a duplicate', () => {
    expect(verifyWebhook(delivery(), options)).toBe('ACCEPTED');
    expect(verifyWebhook(delivery(), { ...options, seenKeys: new Set(['delivery-0001']) })).toBe('DUPLICATE');
  });

  it('refuses a wrong signature, a changed body, a captured delivery replayed later and a malformed key, without saying which part failed', () => {
    for (const bad of [delivery({ signature: 'a'.repeat(64) }), delivery({ body: new TextEncoder().encode('{"code":"W2"}') }), delivery({ timestamp: timestamp - 3600, signature: webhookSignatureOf(fixtureKey, timestamp - 3600, body) }), delivery({ signature: 'zz' })]) {
      let thrown: unknown;
      try {
        verifyWebhook(bad, options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID', status: 401 });
    }
    expect(() => verifyWebhook(delivery({ idempotencyKey: 'short' }), options)).toThrow(DomainError);
  });

  it('keeps a delivery once, hands it over as a record and drops it only on confirm', async () => {
    const adapter = new WebhookInboundAdapter({ secret: fixtureKey, toleranceSeconds: 300, now: () => NOW });
    expect(adapter.receive(delivery())).toBe('ACCEPTED');
    expect(adapter.receive(delivery())).toBe('DUPLICATE');
    const batch = await adapter.extract(request);
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0]).toMatchObject({ key: 'delivery-0001', fields: { code: 'W1', amount: 5 } });
    expect((await adapter.extract(request)).records).toHaveLength(1);
    await adapter.confirm();
    expect((await adapter.extract(request)).records).toEqual([]);
    expect(adapter.receive(delivery())).toBe('DUPLICATE');
  });
});

describe('GENERATOR', () => {
  it('gives the same bytes and the same hash for the same input', () => {
    const generator = new GeneratorAdapter((input) => new TextEncoder().encode(JSON.stringify(input)));
    const first = generator.generate({ period: '2026-M10' });
    expect(generator.generate({ period: '2026-M10' })).toEqual(first);
    expect(generator.generate({ period: '2026-M11' }).sha256).not.toBe(first.sha256);
    expect(first.sha256).toBe(sha('{"period":"2026-M10"}'));
  });
});

describe('the contract of the ports that are not implemented, proved on in-memory fakes', () => {
  const rows: SourceRecord[] = ['r1', 'r2', 'r3', 'r4', 'r5'].map((key, index) => ({ key, sourceRef: `src:${key}`, line: index + 1, fields: { code: key } }));

  it.each(['HTTPS_REST', 'SOAP_XML', 'SFTP', 'DB_READ', 'MESSAGE_QUEUE', 'EMAIL_INBOX'])('%s: pages after the watermark, the same input gives the same hash, the watermark only moves forward and a snapshot starts again', async (protocol) => {
    const port: InboundProtocolPort = new InMemorySourceFake(protocol, rows, 2);
    const first = await port.extract({ ...request, watermark: null });
    expect(first.records.map((record) => record.key)).toEqual(['r1', 'r2']);
    expect(first.complete).toBe(false);
    expect((await port.extract({ ...request, watermark: null })).batchSha256).toBe(first.batchSha256);
    const second = await port.extract({ ...request, watermark: first.nextWatermark });
    expect(second.records.map((record) => record.key)).toEqual(['r3', 'r4']);
    const last = await port.extract({ ...request, watermark: second.nextWatermark });
    expect(last).toMatchObject({ complete: true });
    expect((await port.extract({ ...request, watermark: last.nextWatermark })).records).toEqual([]);
    expect((await port.extract({ ...request, mode: 'FULL_SNAPSHOT', watermark: 'r4' })).records.map((record) => record.key)).toEqual(['r1', 'r2']);
  });

  it('refuses a fake of an unknown protocol, and answers a repeated idempotency key of a send with the first receipt', async () => {
    expect(() => new InMemorySourceFake('NOPE', rows)).toThrow('unknown protocol');
    const sink = new InMemorySinkFake('HTTPS_REST');
    const message = { pipeline: 'P', idempotencyKey: 'k-1', body: new TextEncoder().encode('x'), contentType: 'text/plain' };
    const first = await sink.send(message);
    expect(await sink.send({ ...message, body: new TextEncoder().encode('changed') })).toEqual(first);
    expect(sink.sent).toHaveLength(1);
  });

  it('builds a SOAP envelope the same way every time, with WS-Security as configuration and the body escaped', () => {
    const envelope = soapEnvelope({ version: '1.1', body: '<a>&</a>', securityMode: 'TIMESTAMP_SIGNATURE', createdAt: '2026-11-08T03:00:00Z' });
    expect(envelope).toContain('schemas.xmlsoap.org/soap/envelope');
    expect(envelope).toContain('mode="TIMESTAMP_SIGNATURE"');
    expect(envelope).toContain('&lt;a&gt;&amp;&lt;/a&gt;');
    expect(soapEnvelope({ version: '1.2', body: 'x' })).toContain('2003/05/soap-envelope');
    expect(soapEnvelope({ version: '1.2', body: 'x' })).not.toContain('Header');
  });

  it('lets DB_READ run a single select and never anything that writes', () => {
    expect(() => assertReadOnlyStatement('select id from v_orders where day > $1;')).not.toThrow();
    expect(() => assertReadOnlyStatement('with a as (select 1) select * from a')).not.toThrow();
    for (const sql of ['delete from t', 'select 1; drop table t', 'select * into t2 from t', 'update t set a = 1', 'with x as (delete from t returning *) select * from x', 'call p()']) {
      expect(() => assertReadOnlyStatement(sql)).toThrow(DomainError);
    }
  });

  it('makes a batch whose hash does not depend on anything but the records', () => {
    expect(makeBatch(rows, 'r5').batchSha256).toBe(makeBatch(rows, null).batchSha256);
    expect(makeBatch(rows.slice(1), null).batchSha256).not.toBe(makeBatch(rows, null).batchSha256);
  });
});
