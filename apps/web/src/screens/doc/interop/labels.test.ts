import { describe, expect, it } from 'vitest';
import en from '../../../i18n/en.json';
import vi_ from '../../../i18n/vi.json';
import { adapterLabel, adapterPill, directionLabel, problemMessage, statusLabel, statusPill } from './labels';
import { ADAPTER_STATUSES, DIRECTIONS, STATUSES } from './model';
import type { Problem } from './model';

const words = (dictionary: Record<string, string>) => ((key: string) => dictionary[key] ?? `MISSING:${key}`) as never;
const PROBLEMS: Problem[] = ['versionConflict', 'stateInvalid', 'notFound', 'denied', 'session', 'general'];

describe.each([
  ['vi', vi_ as Record<string, string>],
  ['en', en as Record<string, string>],
])('the words of the monitor of the LGSP in %s', (_locale, dictionary) => {
  const t = words(dictionary);

  it('has a word for every status, direction, adapter and refusal, each different from the others of its kind', () => {
    const groups = [
      STATUSES.map((status) => statusLabel(t, status)),
      DIRECTIONS.map((direction) => directionLabel(t, direction)),
      ADAPTER_STATUSES.map((adapter) => adapterLabel(t, adapter)),
      PROBLEMS.map((problem) => problemMessage(t, problem)),
    ];
    for (const labels of groups) {
      expect(labels.filter((label) => label.startsWith('MISSING:'))).toEqual([]);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe('the pills of the monitor', () => {
  it('shows a message that was delivered as the plain pill, one that waits as amber, and one that died or was refused as red', () => {
    expect(STATUSES.map(statusPill)).toEqual(['pill warn', 'pill warn', 'pill', 'pill red', 'pill warn', 'pill red', 'pill warn', 'pill']);
  });

  it('shows only a verified adapter as the plain pill, as ADM-09 does', () => {
    expect(ADAPTER_STATUSES.map(adapterPill)).toEqual(['pill', 'pill warn', 'pill red', 'pill gray']);
  });
});
