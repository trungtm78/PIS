import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEAMS_CHANNEL, TEAMS_OUTBOX_VARIABLE, TEAMS_PROVIDER, consentRequirement, isQuietHoursChannel, preferenceChannelOf, teamsCardOf } from '@machvon/kernel';
import type { ChannelSendRequest } from '@machvon/kernel';
import { defaultChannelAdapters } from '../../src/notifications/delivery/wiring';
import { FileTeamsCardSink, InMemoryTeamsCardSink, TeamsOutboxChannelAdapter } from '../../src/notifications/delivery/teams-adapter';

const request = (overrides: Partial<ChannelSendRequest> = {}): ChannelSendRequest => ({
  idempotencyKey: 'ntf-1:TEAMS:1',
  to: 'someone@example.org',
  subject: 'Report waits for your review',
  text: 'The weekly report of the project waits at the planning review.',
  accountId: 'teams-channel-planning',
  ...overrides,
});

/** The Teams channel (WF-1): a card handed to an outbox, never a call to Teams, never an address kept. */
describe('the Teams outbox channel', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'machvon-teams-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('turns a message into an adaptive card that names the channel account and the key, and holds no address', () => {
    const card = teamsCardOf({ subject: 'Heading', text: 'Body', accountId: 'acct', idempotencyKey: 'k1' });
    expect(card.type).toBe('message');
    expect(card.routing).toEqual({ account_id: 'acct', idempotency_key: 'k1' });
    expect(card.attachments[0]?.content).toMatchObject({ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'Heading' }, { type: 'TextBlock', text: 'Body' }] });
    expect(teamsCardOf({ text: 'Only a body', accountId: 'acct', idempotencyKey: 'k2' }).attachments[0]?.content.body).toHaveLength(1);
  });

  it('writes one file per message into the outbox directory and writes a repeated key once', async () => {
    const adapter = new TeamsOutboxChannelAdapter(new FileTeamsCardSink(directory), 'MOCK');
    const first = await adapter.send(request());
    const again = await adapter.send(request({ text: 'A different text for the same key' }));
    expect(first).toEqual({ kind: 'ACCEPTED', providerMessageId: 'ntf-1_TEAMS_1.json' });
    expect(again).toEqual(first);
    expect(await readdir(directory)).toEqual(['ntf-1_TEAMS_1.json']);
    const stored = await readFile(join(directory, 'ntf-1_TEAMS_1.json'), 'utf8');
    expect(stored).toContain('The weekly report of the project waits at the planning review.');
    expect(stored).not.toContain('someone@example.org');
    expect(await adapter.lookup('ntf-1:TEAMS:1')).toEqual({ kind: 'FOUND', status: 'ACCEPTED', providerMessageId: 'ntf-1_TEAMS_1.json' });
    expect(await adapter.lookup('ntf-2:TEAMS:1')).toEqual({ kind: 'NOT_FOUND' });
    expect(adapter.parseCallback()).toBeUndefined();
    expect([adapter.channel, adapter.provider, adapter.paid]).toEqual([TEAMS_CHANNEL, TEAMS_PROVIDER, false]);
  });

  it('answers a failure that can be tried again when the outbox cannot be written', async () => {
    const adapter = new TeamsOutboxChannelAdapter({ put: () => Promise.reject(new Error('disk full')), has: () => Promise.reject(new Error('disk full')) }, 'MOCK');
    expect(await adapter.send(request())).toEqual({ kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_OUTBOX_WRITE_FAILED' });
    expect(await adapter.lookup('k')).toEqual({ kind: 'UNDETERMINED' });
  });

  it('keeps cards in memory for a test that reads what the relay would get', async () => {
    const sink = new InMemoryTeamsCardSink();
    await new TeamsOutboxChannelAdapter(sink, 'MOCK').send(request());
    expect([...sink.cards.keys()]).toEqual(['ntf-1:TEAMS:1']);
  });

  it('exists only where the outbox directory is named; MOCK outside production, PROPOSED (never sends) in production', () => {
    expect(defaultChannelAdapters('production', {}).forChannel(TEAMS_CHANNEL)).toBeUndefined();
    expect(defaultChannelAdapters('test', {}).forChannel(TEAMS_CHANNEL)).toBeUndefined();
    const outside = defaultChannelAdapters('test', { [TEAMS_OUTBOX_VARIABLE]: directory });
    expect(outside.statusOf(TEAMS_CHANNEL)).toBe('MOCK');
    expect(outside.usable(TEAMS_CHANNEL)).toBeDefined();
    const real = defaultChannelAdapters('production', { [TEAMS_OUTBOX_VARIABLE]: directory });
    expect(real.providers()).toEqual([TEAMS_PROVIDER]);
    expect(real.statusOf(TEAMS_CHANNEL)).toBe('PROPOSED');
    expect(real.usable(TEAMS_CHANNEL)).toBeUndefined();
  });

  it('is judged like the inbox: a staff channel with no consent of an outside person and no quiet hours of a phone', () => {
    expect(preferenceChannelOf(TEAMS_CHANNEL)).toBe('IN_APP');
    expect(consentRequirement(preferenceChannelOf(TEAMS_CHANNEL), 'REMINDER')).toBe('NONE');
    expect(isQuietHoursChannel(TEAMS_CHANNEL)).toBe(false);
  });
});
