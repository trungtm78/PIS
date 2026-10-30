import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, TIMESTAMPED_HMAC_SHA256 } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { ConversationStore, DeliveryEngine, InboundInput, InboundOutcome } from '@machvon/db';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { channelCallbackHandler } from '../../src/notifications/delivery/callback-handler';
import { definitionOf } from '../../src/notifications/definition';
import { ChannelAdapterRegistry, InMemoryChannelAdapter, inMemoryEmailAdapter } from '../../src/notifications/delivery/channel-adapters';
import { renderTemplate, variablesOf } from '../../src/notifications/delivery/template-renderer';
import { EnvironmentWebhookSecrets, ObjectWebhookPayloads } from '../../src/notifications/delivery/webhook-support';
import type { WebhookPayloadStore } from '../../src/notifications/delivery/webhook-support';
import { defaultChannelAdapters } from '../../src/notifications/delivery/wiring';

const TENANT: TenantContext = { tenantId: '00000000-0000-4000-8000-00000000000a', membershipId: '00000000-0000-4000-8000-000000000000', scopeVersion: 0 };

describe('renderTemplate', () => {
  const schema = { properties: { project: {}, amount: {} } };

  it('fills the declared variables the event supplied, in the subject and the body', () => {
    expect(renderTemplate({ subject: '{{project}} is late', body: 'Report of {{ project }}: {{amount}}' }, schema, { project: 'Alpha', amount: '3' })).toEqual({
      subject: 'Alpha is late',
      text: 'Report of Alpha: 3',
    });
    expect(renderTemplate({ body: 'Plain' }, undefined, {})).toEqual({ text: 'Plain' });
  });

  it('does not take what a plain object inherits for a value: a variable named constructor or toString that the event did not supply fails the render', () => {
    const inherited = { properties: { constructor: {}, toString: {} } };
    expect(() => renderTemplate({ body: '{{constructor}}' }, inherited, {})).toThrow(expect.objectContaining({ code: 'TEMPLATE_INVALID' }));
    expect(() => renderTemplate({ body: '{{toString}}' }, inherited, {})).toThrow(expect.objectContaining({ code: 'TEMPLATE_INVALID' }));
    expect(renderTemplate({ body: '{{constructor}}' }, inherited, { constructor: 'own' })).toEqual({ text: 'own' });
  });

  it('fails the render, so nothing is sent half filled, when a placeholder is undeclared or unsupplied', () => {
    expect(() => renderTemplate({ body: '{{secret}}' }, schema, { secret: 'x' })).toThrow(DomainError);
    expect(() => renderTemplate({ body: '{{project}}' }, schema, {})).toThrow(expect.objectContaining({ code: 'TEMPLATE_INVALID' }));
  });

  it('refuses a content that is not a body, or one that is too long', () => {
    for (const bad of [undefined, null, [], { subject: 3, body: 'x' }, { subject: 'x' }, { body: 4 }]) {
      expect(() => renderTemplate(bad, schema, {})).toThrow(expect.objectContaining({ code: 'TEMPLATE_INVALID' }));
    }
    expect(() => renderTemplate({ body: 'x'.repeat(10_001) }, schema, {})).toThrow(expect.objectContaining({ detail: 'length' }));
    expect(() => renderTemplate({ subject: 's'.repeat(201), body: 'x' }, schema, {})).toThrow(expect.objectContaining({ detail: 'length' }));
  });
});

describe('variablesOf', () => {
  it('takes strings, numbers and booleans from the notification member of an event and nothing else', () => {
    expect(variablesOf({ notification: { variables: { a: 'x', b: 2, c: true, d: { nested: 1 }, e: null, f: [1] } } })).toEqual({ a: 'x', b: '2', c: 'true' });
    expect(variablesOf(null)).toEqual({});
    expect(variablesOf({ notification: 'text' })).toEqual({});
    expect(variablesOf({ notification: { variables: [1] } })).toEqual({});
  });
});

describe('the registry of channel adapters', () => {
  it('serves an adapter by channel and by provider and says MISSING for a channel without one', () => {
    const registry = new ChannelAdapterRegistry([inMemoryEmailAdapter()], 'test');
    expect(registry.forChannel('EMAIL')?.provider).toBe('smtp-relay');
    expect(registry.forProvider('smtp-relay')?.channel).toBe('EMAIL');
    expect(registry.forChannel('SMS')).toBeUndefined();
    expect(registry.statusOf('EMAIL')).toBe('MOCK');
    expect(registry.statusOf('SMS')).toBe('MISSING');
    expect(registry.providers()).toEqual(['smtp-relay']);
  });

  it('lets a MOCK adapter send outside production only, and never a PROPOSED one', () => {
    const adapters = [inMemoryEmailAdapter(), new InMemoryChannelAdapter({ provider: 'sms-gateway', channel: 'SMS', status: 'PROPOSED', paid: true })];
    for (const environment of ['staging', 'ci', 'test', 'local']) {
      const registry = new ChannelAdapterRegistry(adapters, environment);
      expect(registry.usable('EMAIL')).toBeDefined();
      expect(registry.usable('SMS')).toBeUndefined();
    }
    for (const environment of ['production', 'dr', undefined, 'something-else']) expect(new ChannelAdapterRegistry(adapters, environment).usable('EMAIL')).toBeUndefined();
    const verified = new InMemoryChannelAdapter({ provider: 'real', channel: 'EMAIL', status: 'VERIFIED' });
    expect(new ChannelAdapterRegistry([verified], 'production').usable('EMAIL')).toBe(verified);
  });

  it('refuses two adapters for one channel or one provider', () => {
    expect(() => new ChannelAdapterRegistry([inMemoryEmailAdapter(), inMemoryEmailAdapter()], 'test')).toThrow('already has an adapter');
    const a = new InMemoryChannelAdapter({ provider: 'p', channel: 'EMAIL' });
    const b = new InMemoryChannelAdapter({ provider: 'p', channel: 'SMS' });
    expect(() => new ChannelAdapterRegistry([a, b], 'test')).toThrow('provider p already has an adapter');
  });

  it('registers the in-memory e-mail adapter and the two push stand-ins outside production only: the honest default is no adapter', () => {
    expect(defaultChannelAdapters('production').providers()).toEqual([]);
    expect(defaultChannelAdapters(undefined).providers()).toEqual([]);
    expect(defaultChannelAdapters('test').providers()).toEqual(['mock-apns', 'mock-fcm', 'mock-sms', 'smtp-relay']);
  });
});

describe('the in-memory adapter (MOCK)', () => {
  const request = { idempotencyKey: 'n:EMAIL:1', accountId: 'relay-1', to: 'a@example.test', subject: 'S', text: 'T' };

  it('accepts by default, once per idempotency key, and says so honestly', async () => {
    const adapter = inMemoryEmailAdapter();
    expect([adapter.status, adapter.paid, adapter.signature]).toEqual(['MOCK', false, TIMESTAMPED_HMAC_SHA256]);
    const first = await adapter.send(request);
    const second = await adapter.send(request);
    expect(first).toEqual(second);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.messages.size).toBe(1);
    expect(first.kind === 'ACCEPTED' && adapter.messageIdOf(request.idempotencyKey) === first.providerMessageId).toBe(true);
  });

  it('answers the script it was given, then accepts again', async () => {
    const adapter = new InMemoryChannelAdapter({ provider: 'sms-gateway', channel: 'SMS', paid: true });
    adapter.enqueue({ kind: 'UNKNOWN', errorCode: 'TIMEOUT_AFTER_SEND' }, 'THROW');
    expect(await adapter.send(request)).toEqual({ kind: 'UNKNOWN', errorCode: 'TIMEOUT_AFTER_SEND' });
    await expect(adapter.send(request)).rejects.toThrow('adapter failure');
    expect((await adapter.send(request)).kind).toBe('ACCEPTED');
  });

  it('answers a lookup like a provider that keeps idempotency keys', async () => {
    const adapter = inMemoryEmailAdapter();
    expect(await adapter.lookup('unknown')).toEqual({ kind: 'NOT_FOUND' });
    adapter.lookupOfUnknown = { kind: 'UNDETERMINED' };
    expect(await adapter.lookup('unknown')).toEqual({ kind: 'UNDETERMINED' });
    const id = adapter.holds('k1', 'DELIVERED');
    expect(await adapter.lookup('k1')).toEqual({ kind: 'FOUND', status: 'DELIVERED', providerMessageId: id });
    adapter.holds('k2', 'SENDING');
    expect(await adapter.lookup('k2')).toEqual({ kind: 'UNDETERMINED' });
    expect(adapter.holds('k1')).toBe(id);
  });

  it('reads the receipts of its provider and nothing else', () => {
    const adapter = inMemoryEmailAdapter();
    const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
    expect(adapter.parseCallback(body({ id: 'e1', account: 'relay-1', message: 'm1', status: 'DELIVERED', type: 'delivery.status', at: '2026-10-24T03:00:00.000Z' }))).toEqual({
      eventKey: 'e1',
      eventType: 'delivery.status',
      externalAccountId: 'relay-1',
      providerMessageId: 'm1',
      status: 'DELIVERED',
      occurredAt: new Date('2026-10-24T03:00:00.000Z'),
    });
    const defaulted = adapter.parseCallback(body({ id: 'e2', account: 'a', message: 'm', status: 'READ', at: 'not a date' }));
    expect(defaulted?.eventType).toBe('delivery.status');
    expect(Math.abs((defaulted?.occurredAt.getTime() ?? 0) - Date.now())).toBeLessThan(5000);
    for (const bad of [Buffer.from('not json'), body([1]), body('text'), body({ id: 'e', account: 'a', message: 'm', status: 'LOST' }), body({ id: 'e', account: 'a', status: 'READ' }), body(null)]) {
      expect(adapter.parseCallback(bad)).toBeUndefined();
    }
  });
});

describe('the keys of a channel account', () => {
  it('reads them from the environment under the name the reference gives, several while a provider rotates', async () => {
    const secrets = new EnvironmentWebhookSecrets({ MACHVON_SECRET_PRODUCTION_MAIL_HOOK: 'k1:first-secret, k2:second:secret', MACHVON_SECRET_EMPTY: '', MACHVON_SECRET_BROKEN: 'no-separator,:no-id,k:' });
    expect((await secrets.resolve('secret://production/mail-hook')).map((key) => [key.keyId, key.secret.toString()])).toEqual([
      ['k1', 'first-secret'],
      ['k2', 'second:secret'],
    ]);
    expect(await secrets.resolve('secret://production/absent')).toEqual([]);
    expect(await secrets.resolve('secret://empty')).toEqual([]);
    expect(await secrets.resolve('secret://broken')).toEqual([]);
  });

  it('reads the process environment by default', async () => {
    process.env.MACHVON_SECRET_UNITTEST_DEFAULT = 'k:s';
    try {
      expect((await new EnvironmentWebhookSecrets().resolve('secret://unittest/default')).map((key) => key.keyId)).toEqual(['k']);
    } finally {
      delete process.env.MACHVON_SECRET_UNITTEST_DEFAULT;
    }
  });

  it('signs the way the registry says: the timestamp and the raw body', () => {
    const body = Buffer.from('{"a":1}');
    expect(TIMESTAMPED_HMAC_SHA256.signedPayload(7, body).toString()).toBe('7.{"a":1}');
    expect(createHmac('sha256', 'k').update(TIMESTAMPED_HMAC_SHA256.signedPayload(7, body)).digest('hex')).toHaveLength(64);
  });
});

describe('the store of provider receipts', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'machvon-payloads-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the first body of an event by a reference of the tenant and returns it', async () => {
    const payloads = new ObjectWebhookPayloads(new FsObjectStorage(root));
    const reference = await payloads.put(TENANT, 'smtp-relay', 'e1', Buffer.from('first'));
    expect(reference.startsWith(`tenants/${TENANT.tenantId}/webhook/`)).toBe(true);
    // A repeat of the event with other bytes gets the same reference and does not replace the evidence.
    expect(await payloads.put(TENANT, 'smtp-relay', 'e1', Buffer.from('second'))).toBe(reference);
    expect((await payloads.read(TENANT, reference))?.toString()).toBe('first');
    expect(await payloads.put(TENANT, 'smtp-relay', 'e2', Buffer.from('other'))).not.toBe(reference);
  });

  it('answers undefined for a body that is gone, and for a reference of another tenant', async () => {
    const payloads = new ObjectWebhookPayloads(new FsObjectStorage(root));
    const reference = await payloads.put(TENANT, 'smtp-relay', 'e1', Buffer.from('first'));
    expect(await payloads.read({ ...TENANT, tenantId: '00000000-0000-4000-8000-00000000000b' }, reference)).toBeUndefined();
    expect(await payloads.read(TENANT, `tenants/${TENANT.tenantId}/webhook/missing`)).toBeUndefined();
  });
});

describe('the channels of a workflow definition', () => {
  it('defaults to the inbox alone', () => {
    expect(definitionOf({}).channels).toEqual([{ channel: 'IN_APP' }]);
    expect(definitionOf(undefined).channels).toEqual([{ channel: 'IN_APP' }]);
  });

  it('keeps the order of the plan and puts the inbox first, always for urgent messages and where the workflow names it', () => {
    const plan = [{ channel: 'SMS', templateCode: 'sms.a' }, { channel: 'EMAIL', templateCode: 'mail.a' }];
    expect(definitionOf({ channels: plan }).channels).toEqual([...plan]);
    expect(definitionOf({ priority: 'HIGH', channels: plan }).channels).toEqual([{ channel: 'IN_APP' }, ...plan]);
    expect(definitionOf({ priority: 'LOW', channels: plan }).channels).toEqual([...plan]);
    expect(definitionOf({ priority: 'CRITICAL', channels: plan }).channels).toEqual([{ channel: 'IN_APP' }, ...plan]);
    expect(definitionOf({ priority: 'LOW', channels: [...plan, { channel: 'IN_APP' }] }).channels).toEqual([{ channel: 'IN_APP' }, ...plan]);
    expect(definitionOf({ priority: 'LOW', channels: [] }).channels).toEqual([{ channel: 'IN_APP' }]);
  });

  it('refuses a channel that does not exist, one twice, an external one without a template, too many, and a plan that is not a list', () => {
    const bad = (channels: unknown): unknown => (): unknown => definitionOf({ channels });
    for (const channels of [
      'EMAIL',
      [{ channel: 'FAX', templateCode: 'x' }],
      [{ channel: 'EMAIL', templateCode: 'a' }, { channel: 'EMAIL', templateCode: 'b' }],
      [{ channel: 'EMAIL' }],
      [{ channel: 'EMAIL', templateCode: 'has space' }],
      [{ channel: 3 }],
      [null],
      Array.from({ length: 7 }, () => ({ channel: 'IN_APP' })),
    ]) {
      expect(bad(channels)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
    }
  });
});

describe('the inbox adapter of a provider (callback handler)', () => {
  const adapters = new ChannelAdapterRegistry([inMemoryEmailAdapter()], 'test');
  const applied: unknown[] = [];
  const engine = { applyCallback: (_tx: unknown, input: unknown) => Promise.resolve(void applied.push(input)) } as unknown as DeliveryEngine;
  const delivery = { id: 'inbox-1', provider: 'smtp-relay', eventKey: 'e1', eventType: 'delivery.status', payloadReference: 'ref', attempts: 0 };
  const body = Buffer.from(JSON.stringify({ id: 'e1', account: 'relay-1', message: 'm1', status: 'DELIVERED', at: '2026-10-24T03:00:00.000Z' }));
  const tx = (row: unknown): { query: () => Promise<unknown[]> } => ({ query: () => Promise.resolve(row === undefined ? [] : [row]) });
  const payloads = (value: Buffer | undefined): WebhookPayloadStore => ({ put: () => Promise.resolve('ref'), read: () => Promise.resolve(value) });
  const trail: Array<{ action: string; resourceId: string; diff: Record<string, unknown> }> = [];
  const audit = { recordInTx: (_tx: unknown, _actor: string, entry: { action: string; resourceId: string; diff: Record<string, unknown> }) => Promise.resolve(String(trail.push(entry))) };
  const received: InboundInput[] = [];
  let outcome: InboundOutcome = { kind: 'BLOCKED' };
  const conversations = { receiveInbound: (_tx: unknown, input: InboundInput) => Promise.resolve((received.push(input), outcome)) } as unknown as ConversationStore;
  const receipts: Array<[string, string, string]> = [];
  let receiptOutcome: 'APPLIED' | 'IGNORED' | 'UNKNOWN' = 'UNKNOWN';
  const outbound = { applyReceipt: (_tx: unknown, account: string, message: string, status: string) => Promise.resolve((receipts.push([account, message, status]), receiptOutcome)) };
  const handler = (provider: string, stored: Buffer | undefined) => channelCallbackHandler(provider, { adapters, payloads: payloads(stored), engine, audit: audit as never, conversations, outbound: outbound as never });

  it('applies the status of the stored receipt to the send of the account named on the inbox row', async () => {
    receiptOutcome = 'UNKNOWN';
    receipts.length = 0;
    applied.length = 0;
    await handler('smtp-relay', body)(delivery, tx({ tenant_id: TENANT.tenantId, channel_account_id: 'acct-1' }) as never);
    expect(applied).toEqual([{ inboxId: 'inbox-1', channelAccountId: 'acct-1', providerMessageId: 'm1', status: 'DELIVERED', occurredAt: new Date('2026-10-24T03:00:00.000Z') }]);
  });

  it.each([['APPLIED'], ['IGNORED']] as const)('leaves a receipt for a message that an agent sent in a conversation (%s) to that message, and applies it to no notification', async (outcome) => {
    receiptOutcome = outcome;
    receipts.length = 0;
    applied.length = 0;
    await handler('smtp-relay', body)(delivery, tx({ tenant_id: TENANT.tenantId, channel_account_id: 'acct-1' }) as never);
    expect(receipts).toEqual([['acct-1', 'm1', 'DELIVERED']]);
    expect(applied).toEqual([]);
  });

  it.each([
    ['a provider without an adapter', 'other', body, { tenant_id: TENANT.tenantId, channel_account_id: 'a' }, 'RESOURCE_NOT_FOUND'],
    ['an inbox row that is gone', 'smtp-relay', body, undefined, 'CHANNEL_ACCOUNT_UNKNOWN'],
    ['an inbox row without an account', 'smtp-relay', body, { tenant_id: TENANT.tenantId, channel_account_id: null }, 'CHANNEL_ACCOUNT_UNKNOWN'],
    ['a body that retention removed', 'smtp-relay', undefined, { tenant_id: TENANT.tenantId, channel_account_id: 'a' }, 'RESOURCE_NOT_FOUND'],
    ['a body the adapter cannot read', 'smtp-relay', Buffer.from('nope'), { tenant_id: TENANT.tenantId, channel_account_id: 'a' }, 'VALIDATION_FAILED'],
  ])('fails, so the inbox keeps the event, for %s', async (_name, provider, stored, row, code) => {
    await expect(handler(provider, stored)(delivery, tx(row) as never)).rejects.toMatchObject({ code });
  });

  describe('a message that came in', () => {
    const inbound = Buffer.from(JSON.stringify({ id: 'e2', account: 'relay-1', at: '2026-10-30T03:00:00.000Z', inbound: { message: 'm9', thread: 't1', from: 'a@b.vn', name: 'An', text: 'Xin chào' } }));
    const row = { tenant_id: TENANT.tenantId, channel_account_id: 'acct-1' };
    beforeEach(() => {
      received.length = 0;
      trail.length = 0;
      applied.length = 0;
    });

    it('goes into its conversation with the account of the inbox row, and applies no receipt', async () => {
      outcome = { kind: 'DUPLICATE', conversationId: 'c1' };
      await handler('smtp-relay', inbound)(delivery, tx(row) as never);
      expect(received).toEqual([
        { inboxId: 'inbox-1', channelAccountId: 'acct-1', providerMessageId: 'm9', externalThreadId: 't1', sender: { externalId: 'a@b.vn', displayName: 'An' }, text: 'Xin chào', occurredAt: new Date('2026-10-30T03:00:00.000Z') },
      ]);
      expect(applied).toEqual([]);
      expect(trail).toEqual([]);
    });

    it('is told in the trail when it opened a conversation, and when it brought a resolved one back', async () => {
      outcome = { kind: 'RECEIVED', conversationId: 'c1', messageId: 'm', created: true, reopened: false, newContact: true, withdrawn: [] };
      await handler('smtp-relay', inbound)(delivery, tx(row) as never);
      outcome = { kind: 'RECEIVED', conversationId: 'c1', messageId: 'm', created: false, reopened: true, newContact: false, withdrawn: [] };
      await handler('smtp-relay', inbound)(delivery, tx(row) as never);
      outcome = { kind: 'RECEIVED', conversationId: 'c1', messageId: 'm', created: false, reopened: false, newContact: false, withdrawn: [] };
      await handler('smtp-relay', inbound)(delivery, tx(row) as never);
      expect(trail).toEqual([
        { action: 'conversation.opened', resourceType: 'conversation', resourceId: 'c1', diff: { channel_account_id: 'acct-1', new_contact: true }, correlationId: expect.any(String), requestId: expect.any(String) },
        { action: 'conversation.reopened', resourceType: 'conversation', resourceId: 'c1', diff: { by: 'inbound_message' }, correlationId: expect.any(String), requestId: expect.any(String) },
      ]);
    });

    it('tells every consent that a stop word ended', async () => {
      const consent = { id: 'k1', channel: 'SMS', purpose: 'MARKETING' };
      outcome = { kind: 'RECEIVED', conversationId: 'c1', messageId: 'm', created: false, reopened: false, newContact: false, withdrawn: [consent as never] };
      await handler('smtp-relay', inbound)(delivery, tx(row) as never);
      expect(trail).toMatchObject([{ action: 'contact_consent.withdrawn', resourceId: 'k1', diff: { channel: 'SMS', purpose: 'MARKETING', by: 'stop_keyword' } }]);
    });
  });
});
