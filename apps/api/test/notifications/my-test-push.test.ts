import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import type { CommandScope } from '../../src/command-scope';
import { ChannelAdapterRegistry } from '../../src/notifications/delivery/channel-adapters';
import { InMemoryPushTokenVault } from '../../src/notifications/devices/push-vault';
import { PushChannelAdapter } from '../../src/notifications/push/push-adapter';
import { MockPushProvider } from '../../src/notifications/push/ports';
import { MyTestPushController } from '../../src/notifications/push/my-test-push.controller';
import { MockWebPushSender, WebPushProvider } from '../../src/notifications/push/web-push';
import { WEB_PUSH_PROVIDER, webPushRuntime } from '../../src/notifications/push/web-push-wiring';
import type { WebPushRuntime } from '../../src/notifications/push/web-push-wiring';

const MEMBER = randomUUID();
const TENANT = randomUUID();

function subscription(): string {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  return JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
}

interface Row {
  push_secret_ref: string | null;
  platform: string;
}

function scopeWith(rows: Row[]): { scope: CommandScope; audits: Array<Record<string, unknown>>; queries: unknown[][] } {
  const audits: Array<Record<string, unknown>> = [];
  const queries: unknown[][] = [];
  const scope = {
    tx: {
      query: (_text: string, params: unknown[]) => {
        queries.push(params);
        return Promise.resolve(rows);
      },
    },
    tenant: { tenantId: TENANT, membershipId: MEMBER, scopeVersion: 1 },
    requestId: 'request-1',
    audit: (entry: Record<string, unknown>) => {
      audits.push(entry);
      return Promise.resolve('audit-1');
    },
  } as unknown as CommandScope;
  return { scope, audits, queries };
}

describe('the test notification to myself (YCK.01)', () => {
  const sender = new MockWebPushSender();
  const runtime: WebPushRuntime = { provider: new WebPushProvider(sender), mode: 'mock', state: 'MOCK' };
  const vault = new InMemoryPushTokenVault();
  const active = new ChannelAdapterRegistry([new PushChannelAdapter('mock-fcm', 'PUSH_FCM', new MockPushProvider())], 'test');
  const none = new ChannelAdapterRegistry([], 'production');

  beforeEach(() => {
    sender.sent.length = 0;
    sender.recover();
  });

  async function put(token: string): Promise<string> {
    const ref = `secret://test/${randomUUID()}`;
    await vault.put(ref, token);
    return ref;
  }

  it('sends one message of the start page to the device of the caller, audits the outcome and names no address', async () => {
    const ref = await put(subscription());
    const { scope, audits, queries } = scopeWith([{ push_secret_ref: ref, platform: 'web' }]);
    const device = randomUUID();
    const result = await new MyTestPushController(active, vault, runtime).send(scope, device);
    expect(result).toMatchObject({ status: 'SENT', resource_id: device, operation_id: 'request-1' });
    expect(queries[0]).toEqual([device, MEMBER]);
    expect(sender.sent).toHaveLength(1);
    expect(JSON.parse((sender.sent[0] as { payload: string }).payload)).toEqual({ v: 1, title: '', url: '/m' });
    expect(audits).toEqual([{ action: 'device.test_push_sent', resourceType: 'device_registration', resourceId: device, diff: { outcome: 'SENT' } }]);
    expect(JSON.stringify([result, audits])).not.toContain('fcm.googleapis.com');
  });

  it('is a 404 for a device that is not the caller, not a web device, revoked or without a token reference', async () => {
    for (const rows of [[], [{ push_secret_ref: 'x', platform: 'android' }], [{ push_secret_ref: null, platform: 'web' }]]) {
      await expect(new MyTestPushController(active, vault, runtime).send(scopeWith(rows).scope, randomUUID())).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    }
    expect(sender.sent).toHaveLength(0);
  });

  it('says what happened without failing: gone, try later, channel not active, no token', async () => {
    const ref = await put(subscription());
    const row = [{ push_secret_ref: ref, platform: 'web' }];
    const device = (): string => randomUUID();
    sender.failAll({ status: 410 });
    expect(await new MyTestPushController(active, vault, runtime).send(scopeWith(row).scope, device())).toMatchObject({ status: 'GONE' });
    sender.failAll({ status: 503 });
    expect(await new MyTestPushController(active, vault, runtime).send(scopeWith(row).scope, device())).toMatchObject({ status: 'RETRY_LATER' });
    expect(await new MyTestPushController(none, vault, runtime).send(scopeWith(row).scope, device())).toMatchObject({ status: 'CHANNEL_NOT_ACTIVE' });
    expect(await new MyTestPushController(active, vault, runtime).send(scopeWith([{ push_secret_ref: 'secret://test/missing', platform: 'web' }]).scope, device())).toMatchObject({ status: 'NO_TOKEN' });
  });

  it('allows three tests a minute for one device', async () => {
    const ref = await put(subscription());
    const controller = new MyTestPushController(active, vault, runtime);
    const device = randomUUID();
    for (let index = 0; index < 3; index += 1) await controller.send(scopeWith([{ push_secret_ref: ref, platform: 'web' }]).scope, device);
    await expect(controller.send(scopeWith([{ push_secret_ref: ref, platform: 'web' }]).scope, device)).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });
    await expect(controller.send(scopeWith([{ push_secret_ref: ref, platform: 'web' }]).scope, randomUUID())).resolves.toMatchObject({ status: 'SENT' });
  });

  it('shares one runtime for one environment, so the channel and the test message use one sender', () => {
    const env = {};
    expect(webPushRuntime(env)).toBe(webPushRuntime(env));
    expect(webPushRuntime({})).not.toBe(webPushRuntime(env));
    expect(WEB_PUSH_PROVIDER).toBe('web-push');
  });
});
