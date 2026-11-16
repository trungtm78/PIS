import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The hard guarantee of R74 (docs PWF 22.6), read from the sources: a DRAFT work calendar is read in ONE place, the preview of a workflow template (pwf-template-preview.ts), and that preview is called by ONE operation
 * (`previewProjectWorkflowTemplate`). Starting and adopting a workflow, registering a project with one, rescheduling, progress and the recomputation when a year is published pin their calendars with `pinPublishedCalendars`,
 * so none of them can ever lay a date of a real project on a draft. The behaviour is proved over HTTP in apps/api/test/pwf/template-preview.test.ts; this test fails the day somebody wires the draft reader anywhere else.
 */

const DB_SRC = resolve(__dirname, '../src');
const API_SRC = resolve(__dirname, '../../../apps/api/src');

function sources(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (name.endsWith('.ts')) found.push(path);
  }
  return found;
}

const naming = (root: string, pattern: RegExp): string[] =>
  sources(root)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path).replace(/\\/g, '/'))
    .sort();

describe('a draft work calendar is read by the preview of a template and by nothing else (R74)', () => {
  it('names the reader of draft calendars in its own file only', () => {
    expect(naming(DB_SRC, /pinProvisionalCalendars/)).toEqual(['pwf-template-preview.ts']);
    expect(naming(API_SRC, /pinProvisionalCalendars/)).toEqual([]);
  });

  it('lets no other module of the workflow or of the project read a calendar that is not published', () => {
    const readers = sources(DB_SRC).filter((path) => /[\\/](pwf|prj)-[^\\/]+\.ts$/.test(path) && readFileSync(path, 'utf8').includes('work_calendar_version'));
    expect(readers.length).toBeGreaterThan(1);
    const readsDraft = readers.filter((path) => /'Draft'/.test(readFileSync(path, 'utf8'))).map((path) => relative(DB_SRC, path));
    expect(readsDraft).toEqual(['pwf-template-preview.ts']);
    // The pins of every real schedule come from here, and it asks for the published version by name.
    const support = readFileSync(join(DB_SRC, 'pwf-schedule-support.ts'), 'utf8');
    expect(support).toContain(`status = 'Published'`);
    expect(support).not.toContain('Draft');
  });

  it('calls the preview that may read a draft from one operation only, and no command of a project takes a calendar mode', () => {
    expect(naming(DB_SRC, /previewWorkflowTemplate/)).toEqual(['index.ts', 'pwf-template-preview.ts']);
    expect(naming(API_SRC, /previewWorkflowTemplate/)).toEqual(['modules/pwf/workflow.controller.ts']);
    const controller = readFileSync(join(API_SRC, 'modules/pwf/workflow.controller.ts'), 'utf8');
    expect(controller.match(/previewWorkflowTemplate\(/g)).toHaveLength(1);
    expect(naming(API_SRC, /calendar_mode/)).toEqual(['modules/pwf/workflow.controller.ts']);
    expect(naming(DB_SRC, /calendarMode|CalendarMode|calendar_mode/)).toEqual(['index.ts', 'pwf-template-preview.ts']);
  });
});
