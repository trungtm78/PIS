import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEAMS_CHANNEL, TEAMS_PROVIDER, TIMESTAMPED_HMAC_SHA256, teamsCardOf } from '@machvon/kernel';
import type { AdapterStatus, ChannelAdapter, ChannelLookupResult, ChannelSendRequest, ChannelSendResult, ParsedChannelCallback, ProviderSignatureScheme, TeamsCard } from '@machvon/kernel';

/** Where the cards go: the port between the adapter and whatever carries them to Teams (a relay of the operator reads the outbox). Nothing here calls out. */
export interface TeamsCardSink {
  /** Keeps the card under the key and answers with its reference; the same key is the same card, kept once. */
  put(key: string, card: TeamsCard): Promise<string>;
  has(key: string): Promise<boolean>;
}

const safeName = (key: string): string => `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

/** The outbox as a directory: one JSON file per message, written once (a second write of the key finds the file and changes nothing). */
export class FileTeamsCardSink implements TeamsCardSink {
  constructor(private readonly directory: string) {}

  async put(key: string, card: TeamsCard): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const name = safeName(key);
    try {
      await writeFile(join(this.directory, name), `${JSON.stringify(card, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    return name;
  }

  async has(key: string): Promise<boolean> {
    try {
      await readFile(join(this.directory, safeName(key)));
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  }
}

/** The outbox in memory, for the tests that read what would have been handed to the relay. */
export class InMemoryTeamsCardSink implements TeamsCardSink {
  readonly cards = new Map<string, TeamsCard>();

  put(key: string, card: TeamsCard): Promise<string> {
    if (!this.cards.has(key)) this.cards.set(key, card);
    return Promise.resolve(safeName(key));
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.cards.has(key));
  }
}

/**
 * The adapter of the Teams channel (WF-1): it turns a message into an adaptive card and hands it to the outbox. It is honest about what it is: a hand-off to a relay, so its status is MOCK where the platform is not
 * serving real data and PROPOSED where it is (the relay and the Teams app registration are not contracted yet), which the registry never lets send in production. It calls no one, so there is no callback to read and a send
 * cannot be lost after it left: a failure to write is a failure that can be tried again.
 */
export class TeamsOutboxChannelAdapter implements ChannelAdapter {
  readonly provider = TEAMS_PROVIDER;
  readonly channel = TEAMS_CHANNEL;
  readonly paid = false;
  readonly signature: ProviderSignatureScheme = TIMESTAMPED_HMAC_SHA256;

  constructor(
    private readonly sink: TeamsCardSink,
    readonly status: AdapterStatus,
  ) {}

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    const card = teamsCardOf({ subject: request.subject, text: request.text, accountId: request.accountId, idempotencyKey: request.idempotencyKey });
    try {
      return { kind: 'ACCEPTED', providerMessageId: await this.sink.put(request.idempotencyKey, card) };
    } catch {
      return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_OUTBOX_WRITE_FAILED' };
    }
  }

  async lookup(idempotencyKey: string): Promise<ChannelLookupResult> {
    try {
      return (await this.sink.has(idempotencyKey)) ? { kind: 'FOUND', status: 'ACCEPTED', providerMessageId: safeName(idempotencyKey) } : { kind: 'NOT_FOUND' };
    } catch {
      return { kind: 'UNDETERMINED' };
    }
  }

  /** The relay reports nothing back: the card is delivered when the relay has taken it, and the platform never learns more. */
  parseCallback(): ParsedChannelCallback | undefined {
    return undefined;
  }
}
