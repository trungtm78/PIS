import { describe, expect, it } from 'vitest';
import { schedulePreview, scheduleTask } from '../test/fixtures';
import builtIn from './test/builtin-templates.json';
import { diagramOf } from './preview-model';
import { readTemplate } from './template-model';

const words = { provisional: 'tạm tính', missingYear: (year: number) => `thiếu ${year}`, notInProject: 'không thuộc' };

describe('the diagram of the editor from the answer of the server', () => {
  it('draws each task once, even under a step that has several tasks, in the order of the table', () => {
    const template = readTemplate((builtIn as Record<string, never>).PUBLIC_INVESTMENT);
    const preview = schedulePreview({ tasks: template.tasks.map((task) => scheduleTask(task.code, { name: task.name, phase_code: task.phase })) });
    const diagram = diagramOf(preview, template, words);
    expect(diagram.rows).toHaveLength(template.tasks.length);
    expect(new Set(diagram.rows.map((row) => row.code)).size).toBe(template.tasks.length);
  });

  it('says a row has no bar for a year without a calendar and never dates it', () => {
    const template = readTemplate((builtIn as Record<string, never>).PUBLIC_INVESTMENT);
    const first = template.tasks[0]?.code ?? '';
    const preview = schedulePreview({ tasks: [scheduleTask(first, { state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, missing_year: 2028, undated_reason: { code: 'CALENDAR_MISSING', year: 2028 } })] });
    const diagram = diagramOf(preview, template, words);
    expect(diagram.rows[0]).toMatchObject({ actual: null, undated: 'thiếu 2028' });
    expect(diagram.missingYears).toEqual([2028]);
  });
});
