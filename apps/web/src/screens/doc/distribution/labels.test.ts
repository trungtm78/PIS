import { describe, expect, it } from 'vitest';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { channelLabel, distributionPill, distributionStatusLabel, errorLabel, overrideMessage, problemMessage, statusLabel } from './labels';
import type { ProblemReason } from './problems';
import { CHANNELS, DISTRIBUTION_STATUSES, DOCUMENT_STATUSES } from './types';

const translate = (catalogue: Record<string, string>) => (key: string): string => catalogue[key] ?? `MISSING ${key}`;
const REASONS: ProblemReason[] = ['conflict', 'state', 'signature', 'incremental', 'chain', 'time', 'revocation', 'template', 'recipient', 'channel', 'distributionState', 'receipt', 'invalid', 'notFound', 'denied', 'session', 'general'];

describe.each([
  ['vi', vi_ as Record<string, string>],
  ['en', en as Record<string, string>],
])('the words of DOC-08 in %s', (_locale, catalogue) => {
  const t = translate(catalogue) as never;

  it('has a word for every state of a document, of a row and of a channel, each different', () => {
    const documents = DOCUMENT_STATUSES.map((status) => statusLabel(t, status));
    const rows = DISTRIBUTION_STATUSES.map((status) => distributionStatusLabel(t, status));
    const channels = CHANNELS.map((channel) => channelLabel(t, channel));
    for (const group of [documents, rows, channels]) {
      expect(group.some((text) => text.startsWith('MISSING'))).toBe(false);
      expect(new Set(group).size).toBe(group.length);
    }
  });

  it('has a sentence for every problem and every problem with the reason', () => {
    const problems = REASONS.map((reason) => problemMessage(t, reason));
    expect(problems.some((text) => text.startsWith('MISSING'))).toBe(false);
    expect(new Set(problems).size).toBe(REASONS.length);
    expect(['required', 'tooShort', 'tooLong'].map((problem) => overrideMessage(t, problem as 'required')).some((text) => text.startsWith('MISSING'))).toBe(false);
  });

  it('names the reasons a row failed in words, and shows any other code as it is', () => {
    expect(errorLabel(t, 'PROVIDER_UNAVAILABLE')).toBe(catalogue['doc.distribution.error.provider']);
    expect(errorLabel(t, 'CHANNEL_ERROR')).toBe(catalogue['doc.distribution.error.channel']);
    expect(errorLabel(t, 'CHANNEL_NOT_SUPPORTED')).toBe(catalogue['doc.distribution.error.unsupported']);
    expect(errorLabel(t, 'SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });
});

describe('the colour of a row', () => {
  it('is good for a receipt, red for a failure, warm for what is on its way and grey for what ended', () => {
    expect(DISTRIBUTION_STATUSES.map((status) => distributionPill(status))).toEqual(['pill warn', 'pill warn', 'pill', 'pill', 'pill red', 'pill gray']);
  });
});
