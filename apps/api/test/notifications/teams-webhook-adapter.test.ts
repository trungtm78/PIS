import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChannelSendRequest } from '@machvon/kernel';
import { defaultChannelAdapters } from '../../src/notifications/delivery/wiring';
import { TEAMS_WEBHOOK_PROVIDER, TeamsWebhookChannelAdapter, retryAfterSeconds, teamsWebhookAdapterFromEnv, teamsWebhookConfigFromEnv, webhookAllowed } from '../../src/notifications/delivery/teams-webhook-adapter';
import type { WebhookPoster } from '../../src/notifications/delivery/teams-webhook-adapter';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

type Answer = { status: number; headers?: Record<string, string> } | 'hang' | 'close';

/** A webhook endpoint on the loopback: it keeps what it was sent and answers with what the test scripted. */
class FakeWebhook {
  readonly seen: Seen[] = [];
  answer: Answer = { status: 202 };
  private server: Server | undefined;
  port = 0;

  async start(): Promise<void> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        this.seen.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body });
        if (this.answer === 'close') req.socket.destroy();
        else if (this.answer !== 'hang') {
          res.writeHead(this.answer.status, this.answer.headers);
          res.end('1');
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    server?.closeAllConnections();
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const request = (over: Partial<ChannelSendRequest> = {}): ChannelSendRequest => ({
  idempotencyKey: '7f3c2a10-0000-4000-8000-000000000001:TEAMS:1',
  to: '',
  subject: 'Nhắc việc kỳ báo cáo',
  text: 'Hạn nhập số liệu kỳ tháng 9 là 05/10.',
  accountId: 'channel-1',
  ...over,
});

const loopback = (port: number, timeoutMs = 2000) => ({ url: new URL(`http://127.0.0.1:${port}/workflows/abc?sig=SECRET`), allowedSuffixes: [] as string[], timeoutMs, loopbackHttp: true });

describe('TeamsWebhookChannelAdapter (an incoming webhook of Teams, YCK.01 and QT.02)', () => {
  const relay = new FakeWebhook();
  beforeAll(() => relay.start());
  afterAll(() => relay.stop());
  beforeEach(() => {
    relay.seen.length = 0;
    relay.answer = { status: 202 };
  });

  it('posts the adaptive card as JSON and is accepted by a 202 or a 200', async () => {
    const adapter = new TeamsWebhookChannelAdapter(loopback(relay.port), 'MOCK');
    expect(await adapter.send(request())).toEqual({ kind: 'ACCEPTED', providerMessageId: 'webhook:7f3c2a10-0000-4000-8000-000000000001:TEAMS:1' });
    relay.answer = { status: 200 };
    expect((await adapter.send(request())).kind).toBe('ACCEPTED');
    const [first] = relay.seen;
    expect(first).toMatchObject({ method: 'POST', url: '/workflows/abc?sig=SECRET', contentType: 'application/json; charset=utf-8' });
    const card = JSON.parse(first?.body ?? '{}');
    expect(card.type).toBe('message');
    expect(card.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.attachments[0].content.body.map((block: { text: string }) => block.text)).toEqual(['Nhắc việc kỳ báo cáo', 'Hạn nhập số liệu kỳ tháng 9 là 05/10.']);
  });

  it.each([
    [{ status: 429, headers: { 'Retry-After': '90' } }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_429', retryAfterSeconds: 90 }],
    [{ status: 429 }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_429' }],
    [{ status: 503 }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_503' }],
    [{ status: 408 }, { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_408' }],
    [{ status: 400 }, { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_400' }],
    [{ status: 410 }, { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_410' }],
    [{ status: 302, headers: { Location: 'http://127.0.0.1:1/elsewhere' } }, { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_REDIRECT_REFUSED' }],
  ] as Array<[Answer, unknown]>)('answers %j with %j', async (answer, expected) => {
    relay.answer = answer;
    expect(await new TeamsWebhookChannelAdapter(loopback(relay.port), 'MOCK').send(request())).toEqual(expected);
    // A redirect is never followed.
    expect(relay.seen).toHaveLength(1);
  });

  it('says the answer is lost when the webhook took the request and then said nothing, and can try again when it never got there', async () => {
    relay.answer = 'close';
    expect(await new TeamsWebhookChannelAdapter(loopback(relay.port), 'MOCK').send(request())).toEqual({ kind: 'UNKNOWN', errorCode: 'TEAMS_RESULT_LOST' });
    relay.answer = 'hang';
    expect(await new TeamsWebhookChannelAdapter(loopback(relay.port, 300), 'MOCK').send(request())).toEqual({ kind: 'UNKNOWN', errorCode: 'TEAMS_RESULT_LOST' });
    const dead = new FakeWebhook();
    await dead.start();
    const port = dead.port;
    await dead.stop();
    expect(await new TeamsWebhookChannelAdapter(loopback(port), 'MOCK').send(request())).toEqual({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_CONNECT_FAILED' });
  });

  it('never sends a card that is too large for Teams, or to a host that is not on the allow-list', async () => {
    const adapter = new TeamsWebhookChannelAdapter(loopback(relay.port), 'MOCK');
    expect(await adapter.send(request({ text: 'x'.repeat(10_000), subject: 'y'.repeat(200) }))).toMatchObject({ kind: 'ACCEPTED' });
    // Ten thousand Vietnamese letters are about thirty thousand bytes: over the limit of a card, so it never leaves.
    const seenBefore = relay.seen.length;
    expect(await adapter.send(request({ text: 'ệ'.repeat(10_000) }))).toEqual({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_CARD_TOO_LARGE' });
    expect(relay.seen).toHaveLength(seenBefore);
    const posts: string[] = [];
    const poster: WebhookPoster = (url) => {
      posts.push(url.href);
      return Promise.resolve({ status: 202, retryAfter: undefined });
    };
    const offList = new TeamsWebhookChannelAdapter({ url: new URL('https://evil.example.net/hook'), allowedSuffixes: ['webhook.office.com'], timeoutMs: 1000 }, 'MOCK', poster);
    expect(await offList.send(request())).toEqual({ kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_WEBHOOK_HOST_NOT_ALLOWED' });
    expect(posts).toEqual([]);
    const allowed = new TeamsWebhookChannelAdapter({ url: new URL('https://contoso.webhook.office.com/webhookb2/abc'), allowedSuffixes: ['webhook.office.com'], timeoutMs: 1000 }, 'MOCK', poster);
    expect((await allowed.send(request())).kind).toBe('ACCEPTED');
    expect(posts).toEqual(['https://contoso.webhook.office.com/webhookb2/abc']);
  });

  it('cannot say whether a card was posted, and reads no receipt', async () => {
    const adapter = new TeamsWebhookChannelAdapter(loopback(relay.port), 'MOCK');
    expect(await adapter.lookup()).toEqual({ kind: 'UNDETERMINED' });
    expect(adapter.parseCallback()).toBeUndefined();
  });
});

describe('which webhook addresses may be called', () => {
  const suffixes = ['webhook.office.com', 'logic.azure.com', 'relay.corp.example'];

  it('allows https on the default port to a host on the list, and nothing else', () => {
    for (const good of ['https://contoso.webhook.office.com/webhookb2/x', 'https://prod-12.westus.logic.azure.com:443/workflows/x', 'https://teams.relay.corp.example/hook', 'https://webhook.office.com/x']) expect(webhookAllowed(new URL(good), suffixes)).toBe(true);
    for (const bad of [
      'http://contoso.webhook.office.com/x',
      'https://contoso.webhook.office.com:8443/x',
      'https://evil.example.net/webhook.office.com',
      'https://webhook.office.com.evil.example.net/x',
      'https://notwebhook.office.com/x',
      'https://user:pass@contoso.webhook.office.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'http://127.0.0.1:8080/x',
      'ftp://contoso.webhook.office.com/x',
    ]) expect(webhookAllowed(new URL(bad), suffixes)).toBe(false);
    expect(webhookAllowed(new URL('http://127.0.0.1:8080/x'), suffixes, true)).toBe(true);
    expect(webhookAllowed(new URL('http://evil.example.net/x'), suffixes, true)).toBe(false);
  });

  it('reads the address from the vault reference before the plain variable, adds the suffixes of the operator, and keeps the loopback for non-production only', () => {
    const URL_OK = 'https://contoso.webhook.office.com/webhookb2/x';
    expect(teamsWebhookConfigFromEnv({}, 'production')).toBeUndefined();
    expect(teamsWebhookConfigFromEnv({ MACHVON_TEAMS_WEBHOOK_URL: URL_OK }, 'production')?.url.href).toBe(URL_OK);
    expect(teamsWebhookConfigFromEnv({ MACHVON_TEAMS_WEBHOOK_URL: 'https://other.example.net/x', MACHVON_TEAMS_WEBHOOK_URL_REF: 'secret://production/teams', MACHVON_SECRET_PRODUCTION_TEAMS: URL_OK }, 'production')?.url.href).toBe(URL_OK);
    expect(teamsWebhookConfigFromEnv({ MACHVON_TEAMS_WEBHOOK_URL: 'https://hook.relay.corp.example/x' }, 'production')).toBeUndefined();
    expect(teamsWebhookConfigFromEnv({ MACHVON_TEAMS_WEBHOOK_URL: 'https://hook.relay.corp.example/x', MACHVON_TEAMS_WEBHOOK_ALLOWED_HOSTS: '.relay.corp.example, not a host' }, 'production')).toBeDefined();
    expect(teamsWebhookConfigFromEnv({ MACHVON_TEAMS_WEBHOOK_URL: 'not a url' }, 'production')).toBeUndefined();
    const local = { MACHVON_TEAMS_WEBHOOK_URL: 'http://127.0.0.1:9/x', MACHVON_TEAMS_WEBHOOK_ALLOW_LOOPBACK: 'true' };
    expect(teamsWebhookConfigFromEnv(local, 'staging')).toBeDefined();
    expect(teamsWebhookConfigFromEnv(local, 'production')).toBeUndefined();
  });

  it('is MOCK outside production and PROPOSED in production until the operator attests it, and takes the channel from the outbox when it is configured', () => {
    const env = { MACHVON_TEAMS_WEBHOOK_URL: 'https://contoso.webhook.office.com/webhookb2/x', MACHVON_TEAMS_OUTBOX_DIR: '/var/outbox' };
    expect(teamsWebhookAdapterFromEnv(env, 'staging')?.status).toBe('MOCK');
    expect(teamsWebhookAdapterFromEnv(env, 'production')?.status).toBe('PROPOSED');
    expect(teamsWebhookAdapterFromEnv({ ...env, MACHVON_TEAMS_WEBHOOK_VERIFIED: 'true' }, 'production')?.status).toBe('VERIFIED');
    expect(defaultChannelAdapters('production', env).forChannel('TEAMS')?.provider).toBe(TEAMS_WEBHOOK_PROVIDER);
    expect(defaultChannelAdapters('production', env).usable('TEAMS')).toBeUndefined();
    expect(defaultChannelAdapters('production', { ...env, MACHVON_TEAMS_WEBHOOK_VERIFIED: 'true' }).usable('TEAMS')).toBeDefined();
    expect(defaultChannelAdapters('production', { MACHVON_TEAMS_OUTBOX_DIR: '/var/outbox' }).forChannel('TEAMS')?.provider).toBe('teams-outbox');
  });

  it('reads Retry-After as seconds or as a date, at most an hour', () => {
    const now = new Date('2027-10-05T03:00:00Z');
    expect(retryAfterSeconds('120', now)).toBe(120);
    expect(retryAfterSeconds('99999', now)).toBe(3600);
    expect(retryAfterSeconds('Tue, 05 Oct 2027 03:01:00 GMT', now)).toBe(60);
    expect(retryAfterSeconds('soon', now)).toBeUndefined();
    expect(retryAfterSeconds(undefined, now)).toBeUndefined();
    expect(retryAfterSeconds('0', now)).toBeUndefined();
  });
});
