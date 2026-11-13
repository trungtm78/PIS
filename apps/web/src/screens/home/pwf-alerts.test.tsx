import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requestSchemaOf } from '@machvon/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WEB_ROUTES } from '../../routes/web-routes';
import { useTranslation } from '../../i18n';
import { pathOfAlert, sourceLabel } from '../../ui/alerts/AlertRow';
import { WORK_SOURCES } from '../../ui/alerts/types';
import { WORK_KINDS, pathOf, toWorkPage } from './work-model';

afterEach(() => cleanup());

const ID = '00000000-0000-4000-8000-000000000c01';
const PWF_KINDS = ['PWF_TASK_DUE_SOON', 'PWF_TASK_OVERDUE', 'PWF_MILESTONE_AT_RISK'];

function Label({ source }: { source: string }) {
  const { t } = useTranslation();
  return <span data-testid="label">{sourceLabel(t, source)}</span>;
}

const kernelKinds = (): string[] => {
  let root = process.cwd();
  while (!existsSync(join(root, 'packages/kernel/src/home-work.ts')) && dirname(root) !== root) root = dirname(root);
  const text = readFileSync(join(root, 'packages/kernel/src/home-work.ts'), 'utf8');
  const start = text.indexOf('export const WORK_KINDS');
  const end = text.indexOf('] as const', start);
  return [...text.slice(start, end).matchAll(/^\s*'([A-Z_0-9]+)',/gm)].map((match) => match[1] as string);
};

/** PWF-2: the tasks of a project workflow as a source of the alert centre of the web (R30). */
describe('the tasks of a project workflow in the alert centre of the web', () => {
  it('names the source PROJECT_TASK in all three operations that name a source, and the three kinds the kernel has', () => {
    expect(WORK_SOURCES).toContain('PROJECT_TASK');
    for (const operation of ['claimWork', 'pauseWorkClock', 'resumeWorkClock']) {
      const schema = requestSchemaOf(operation) as { properties?: { source?: { enum?: string[] } } } | undefined;
      expect(schema?.properties?.source?.enum, operation).toContain('PROJECT_TASK');
    }
    expect([...WORK_KINDS].sort()).toEqual([...kernelKinds()].sort());
    expect(WORK_KINDS).toEqual(expect.arrayContaining(PWF_KINDS));
  });

  it('keeps an item of each kind with its target instead of dropping it as unknown', () => {
    const page = toWorkPage({
      items: PWF_KINDS.map((kind, index) => ({ id: `${ID}:${index + 1}`, kind, title: kind, subtitle: null, status: 'DUE_SOON', due_on: '2027-10-15', original_due_on: '2027-10-12', bucket: 'NEAR', days_late: 0, target: { screen: 'PWF-04', id: ID } })),
      counts: {},
    });
    expect(page.items.map((item) => item.kind)).toEqual(PWF_KINDS);
  });

  it('opens the detail of the task by its id, on a screen that exists', () => {
    expect(pathOf({ target: { screen: 'PWF-04', id: ID } })).toBe(`/pwf/pwf-04?id=${ID}`);
    expect(pathOfAlert({ target: { screen: 'PWF-04', id: ID } })).toBe(`/pwf/pwf-04?id=${ID}`);
    expect(WEB_ROUTES.some((route) => route.id === 'PWF-04')).toBe(true);
  });

  it('has words for the source, in the language of the screen', () => {
    render(<Label source="PROJECT_TASK" />);
    expect(screen.getByTestId('label').textContent).not.toBe('PROJECT_TASK');
    expect(screen.getByTestId('label').textContent).not.toBe('');
  });
});
