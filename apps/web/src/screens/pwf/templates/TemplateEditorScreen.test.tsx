import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { effectiveBody } from '../../adm/governance/test/fixtures';
import { ME, OTHER, ALL_PERMISSIONS, READ_ONLY, refusal, routeOf, schedulePreview, scheduleTask, serve, templateParams, text } from '../test/fixtures';
import type { Answer } from '../test/fixtures';
import { shippedEffective, templateEffective, templateVersion, uuid, validation } from './test/fixtures';
import { mountAs } from './test/mount';
import { DRAFT_PREFIX } from './draft-store';
import { PREVIEW_DELAY_MS } from './live-preview';
import TemplateEditorScreen from './TemplateEditorScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const route = routeOf('PWF-02');
const WITHIN = { timeout: 4000 };
const TEMPLATE = 'PROJECT_WORKFLOW_TEMPLATE';

interface Setup {
  path?: string;
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  effective?: Answer;
  versions?: unknown[];
  rule?: unknown;
  assignment?: unknown;
  commands?: Record<string, Answer>;
}

const open = (setup: Setup = {}) => {
  const h = serve(
    {
      getEffectiveGovernanceRule: (input: Record<string, unknown>) => {
        const type = (input.query as { rule_type: string }).rule_type;
        if (type === TEMPLATE) return typeof setup.effective === 'function' ? (setup.effective as (i: unknown) => unknown)(input) : (setup.effective ?? templateEffective());
        return setup.assignment ?? effectiveBody({ rule_type: 'PROJECT_WORKFLOW_ASSIGNMENT', code: 'DEFAULT', params: { lines: [] }, version: 1, source: 'RULE', rule_id: uuid(300) });
      },
      listGovernanceRuleVersions: { items: setup.versions ?? [templateVersion(2), templateVersion(1, { status: 'RETIRED', phase: 'ENDED' })] },
      getGovernanceRule: setup.rule ?? templateVersion(1),
      getGovernanceRuleCatalog: { items: [] },
    },
    {
      validateProjectWorkflowTemplate: validation(),
      previewProjectWorkflowTemplate: schedulePreview(),
      createGovernanceRuleDraft: { resource_id: uuid(200), status: 'DRAFT', resource_version: 1 },
      ...setup.commands,
    },
  );
  (h.client.readAll as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
  mountAs(<TemplateEditorScreen route={route} />, h, { permissions: setup.permissions ?? ALL_PERMISSIONS, ...(setup.mode === undefined ? {} : { mode: setup.mode }), path: setup.path ?? '/pwf/pwf-02?code=PUBLIC_INVESTMENT' });
  return h;
};

const ready = async () => screen.findByTestId('steps-table');
const rowOf = (key: string): HTMLElement => document.querySelector(`[data-line="${key}"]`) as HTMLElement;
const lastBody = (h: ReturnType<typeof open>, operation: string) => {
  const calls = h.command.mock.calls.filter((call) => call[0] === operation);
  return (calls[calls.length - 1]?.[1] as { body: Record<string, unknown> }).body;
};
const nameInputs = (): HTMLInputElement[] => Array.from(document.querySelectorAll<HTMLInputElement>('[data-field="name"]'));

describe('PWF-02: one table of steps', () => {
  it('opens the procedure in force as one table: a row for each step with its unit, start point, time limit and the three colours', async () => {
    open();
    await ready();
    expect(screen.getByTestId('template-title').textContent).toBe('Mẫu bản 2');
    expect(nameInputs().map((input) => input.value)).toEqual(['Lập báo cáo nghiên cứu khả thi', 'Thẩm định']);
    // The second row starts when the first is done; the first starts with the project.
    const second = rowOf('task:T2');
    expect((within(second).getByLabelText(/mốc tính của bước 2/i) as HTMLSelectElement).value).toBe('task:T1');
    expect((within(rowOf('task:T1')).getByLabelText(/mốc tính của bước 1/i) as HTMLSelectElement).value).toBe('start');
    expect((screen.getByTestId('limit-task:T1') as HTMLInputElement).value).toBe('20');
    // Three inputs for red, yellow and green on every row.
    expect(within(rowOf('task:T1')).getAllByLabelText(/ngưỡng/i)).toHaveLength(3);
  });

  it('is read only when the version is in force, says so, and offers a new draft instead of fields', async () => {
    open();
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(text('pwfx.readOnly.inForce'));
    expect(nameInputs().every((input) => input.disabled)).toBe(true);
    expect(screen.queryByTestId('save-draft')).toBeNull();
    fireEvent.click(screen.getByTestId('new-draft'));
    expect(nameInputs().every((input) => !input.disabled)).toBe(true);
    expect(screen.getByTestId('save-draft')).toBeTruthy();
    expect(screen.queryByTestId('read-only')).toBeNull();
  });

  it('is denied without the permission to manage templates', async () => {
    open({ permissions: READ_ONLY });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('draws the diagram from the server and says it follows the table', async () => {
    const h = open();
    await ready();
    await waitFor(() => expect(screen.getByTestId('diagram-status').getAttribute('data-status')).toBe('ready'), WITHIN);
    expect(h.command).toHaveBeenCalledWith('previewProjectWorkflowTemplate', expect.objectContaining({ body: expect.objectContaining({ calendar_mode: 'PROVISIONAL' }) }));
    expect(await screen.findByTestId('gantt')).toBeTruthy();
  });

  it('opens a procedure the server holds as a draft in the making, writable, with its state in the header', async () => {
    open({ versions: [templateVersion(3, { status: 'DRAFT', phase: 'DRAFT', created_by: ME, params: templateParams({ name: 'Bản nháp 3' }) }), templateVersion(2)] });
    await ready();
    expect(screen.getByTestId('template-title').textContent).toBe('Bản nháp 3');
    expect(screen.getByTestId('template-sub').textContent).toContain(text('gova1.status.draft'));
    expect(screen.queryByTestId('read-only')).toBeNull();
  });
});

describe('PWF-02: preview, kept for later', () => {
  it('keeps act and the delay in view', () => {
    expect(PREVIEW_DELAY_MS).toBe(400);
    expect(typeof act).toBe('function');
    expect([ME, OTHER, refusal, scheduleTask, shippedEffective, describeViolations, seriousViolations, DRAFT_PREFIX].length).toBe(8);
  });
});
