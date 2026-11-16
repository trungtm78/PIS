import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOW_VIEWS } from './workflow/WorkflowBody';

const HERE = __dirname;
const WEB = resolve(HERE, '../../..');

const sources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx|css)$/.test(name) ? [path] : [];
  });

const code = sources(resolve(WEB, 'src'))
  .filter((path) => !/no-old-way\.test\.ts$/.test(path))
  .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/**
 * The redesign REPLACES the way the project workflow was shown, started and read (principle 0 of the plan of 16/11/2026): there is no switch between the old and the new, and nothing of the old layouts stays in the source. This test lists
 * what must never come back, so that a merge that brings an old file or an old name back fails here and not in front of a customer.
 */
describe('the project workflow has no old way left', () => {
  it('has none of the files of the old layouts', () => {
    const gone = [
      'workflow/Overview.tsx',
      'workflow/Outline.tsx',
      'process/StepsPanel.tsx',
      'process/ProcessKindSection.tsx',
      'start/StartSuggestion.test.tsx',
    ];
    for (const file of gone) expect(existsSync(join(HERE, file)), file).toBe(false);
  });

  it('has the step table first and no overview, tree or task tab of the workflow, and no tabs on the task', () => {
    expect([...FLOW_VIEWS]).toEqual(['steps', 'schedule', 'gates', 'board']);
    const old = code.filter(({ text }) => /\bTASK_VIEWS\b|pwf6\.flow\.tab\.(overview|tasks)|pwf6\.task\.tab\./.test(text));
    expect(old.map((one) => one.path)).toEqual([]);
  });

  it('names no component of the old layouts anywhere', () => {
    const names = /\b(WorkflowOutline|ProcessKindSection|StepsPanel|stepperSteps)\b/;
    const found = code.filter(({ path, text }) => /[\\/]screens[\\/](pwf|prj)[\\/]/.test(path) && names.test(text));
    expect(found.map((one) => one.path)).toEqual([]);
  });

  it('keeps no key of the catalogues for words of the old layouts', () => {
    const vi = JSON.parse(readFileSync(resolve(WEB, 'src/i18n/vi.json'), 'utf8')) as Record<string, string>;
    const old = Object.keys(vi).filter((key) => /^pwf6\.outline\.|^pwf6\.task\.tab\.|^pwf6\.flow\.attention\.|^pwf6\.flow\.tab\.(overview|tasks)$|^pwf\.start\.preview\.(action|title|critical)/.test(key));
    expect(old).toEqual([]);
  });

  it('has one chooser for the process: the registration and the start of a workflow use the same component', () => {
    const users = code.filter(({ text }) => /<ProcessChooser\b/.test(text)).map((one) => one.path.replace(/\\/g, '/').split('/src/')[1]);
    expect(users.filter((path) => !path?.endsWith('.test.tsx')).sort()).toEqual(['screens/prj/ProjectCreateScreen.tsx', 'screens/pwf/start/StartWorkflowScreen.tsx']);
  });
});
