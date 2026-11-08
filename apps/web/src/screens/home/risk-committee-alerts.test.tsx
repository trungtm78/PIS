import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requestSchemaOf } from '@machvon/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WEB_ROUTES } from '../../routes/web-routes';
import { useTranslation } from '../../i18n';
import en from '../../i18n/en.json';
import vi from '../../i18n/vi.json';
import { pathOfAlert, sourceLabel } from '../../ui/alerts/AlertRow';
import { sourceSuffix } from '../../ui/alerts/format';
import { WORK_SOURCES } from '../../ui/alerts/types';
import { WORK_KINDS, pathOf, toWorkPage } from './work-model';

afterEach(() => cleanup());

const ID = '00000000-0000-4000-8000-000000000b01';
const RISK_KINDS = ['RISK_SCORE_CRITICAL', 'RISK_SCORE_JUMP'];
const COMMITTEE_KINDS = ['COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE_SECTOR_BEHIND', 'COMMITTEE_UNIT_NOT_REPORTING', 'COMMITTEE_DIRECTIVE_OVERDUE'];
const FEED_KINDS = ['FEED_STALE', 'FEED_UNIT_LATE', 'FEED_DISCREPANCY_LARGE'];

function Label({ source }: { source: string }) {
  const { t } = useTranslation();
  return <span data-testid="label">{sourceLabel(t, source)}</span>;
}

const sourceEnumOf = (operation: string): string[] => {
  const schema = requestSchemaOf(operation) as { properties?: { source?: { enum?: string[] } } } | undefined;
  return schema?.properties?.source?.enum ?? [];
};

/** The kinds of the kernel, read from its source, so that a kind the server can send is never dropped by the web as unknown. */
const kernelKinds = (): string[] => {
  let root = process.cwd();
  while (!existsSync(join(root, 'packages/kernel/src/home-work.ts')) && dirname(root) !== root) root = dirname(root);
  const text = readFileSync(join(root, 'packages/kernel/src/home-work.ts'), 'utf8');
  const start = text.indexOf('export const WORK_KINDS');
  const end = text.indexOf('] as const', start);
  return [...text.slice(start, end).matchAll(/^\s*'([A-Z_0-9]+)',/gm)].map((match) => match[1] as string);
};

/** HUBADAPT step 4: the alerts of the risk register (MR-1) and of the committee (BAN-1) in the alert centre of the web. */
describe('the risk register and committee alerts in the alert centre of the web', () => {
  it('lists the sources exactly as the contract does, in all three operations that name one', () => {
    const own = [...WORK_SOURCES].sort();
    for (const operation of ['claimWork', 'pauseWorkClock', 'resumeWorkClock']) expect([...sourceEnumOf(operation)].sort(), operation).toEqual(own);
    expect(WORK_SOURCES).toEqual(expect.arrayContaining(['PROJECT_RISK', 'COMMITTEE', 'CONTRACT_CLAIM', 'CONTRACT_EARLY_WARNING']));
  });

  it('knows every kind of work the kernel has, and none that it has not', () => {
    expect([...WORK_KINDS].sort()).toEqual([...kernelKinds()].sort());
    expect(WORK_KINDS).toEqual(expect.arrayContaining([...RISK_KINDS, ...COMMITTEE_KINDS, ...FEED_KINDS]));
  });

  it('keeps an item of each new kind in the list with its target instead of dropping it as unknown', () => {
    const kinds = [...RISK_KINDS, ...COMMITTEE_KINDS];
    const page = toWorkPage({
      items: kinds.map((kind, index) => ({
        id: `${ID}-${index}`,
        kind,
        title: kind,
        subtitle: null,
        status: 'OPEN',
        due_on: '2027-10-15',
        original_due_on: '2027-10-12',
        bucket: 'NEAR',
        days_late: 0,
        target: { screen: kind.startsWith('RISK') ? 'PRJ-28' : 'BAN-05', id: ID },
      })),
      counts: {},
    });
    expect(page.items.map((item) => item.kind)).toEqual(kinds);
    expect(page.items.map((item) => item.target.screen)).toEqual(['PRJ-28', 'PRJ-28', 'BAN-05', 'BAN-05', 'BAN-05', 'BAN-05']);
  });

  it('opens the risk board of the project by its id and the alerts of the committee on their own page', () => {
    expect(pathOf({ target: { screen: 'PRJ-28', id: ID } })).toBe(`/prj/prj-28?id=${ID}`);
    expect(pathOfAlert({ target: { screen: 'PRJ-28', id: ID } })).toBe(`/prj/prj-28?id=${ID}`);
    for (const screenId of ['BAN-05', 'FEED-01', 'FEED-04']) {
      const route = WEB_ROUTES.find((candidate) => candidate.id === screenId);
      expect(route, screenId).toBeDefined();
      expect(pathOfAlert({ target: { screen: screenId, id: ID } })).toBe(route?.path);
    }
  });

  it('has words for every source of the list, in both languages (a source without words is shown as it came, which is what this must not be)', () => {
    for (const source of WORK_SOURCES) {
      const key = `alerts.source.${sourceSuffix(source)}`;
      expect((vi as Record<string, string>)[key], key).toBeTruthy();
      expect((en as Record<string, string>)[key], key).toBeTruthy();
      render(<Label source={source} />);
      expect(screen.getByTestId('label').textContent, source).not.toBe(source);
      expect(screen.getByTestId('label').textContent, source).not.toBe('');
      cleanup();
    }
  });
});
