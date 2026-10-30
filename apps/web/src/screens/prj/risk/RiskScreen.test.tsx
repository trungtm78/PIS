import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { client, line, master, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import RiskScreen from './RiskScreen';
import { cellOf, closureBody, describeRisk, entryBody, formOfRisk, holds, isLive, movesFrom, previewScore, toRiskPage, validateClosure, validateForm } from './model';
import type { Cell, RiskForm, RiskView } from './model';

const ROUTE = routeOf('PRJ-16', 'FR-PRJ-16');
const MANAGER = ['project.read', 'project.risk.manage'];
const READER = ['project.read'];
const OK = { operation_id: 'o', status: 'OPEN', resource_version: 1, resource_id: 'x' };
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CATEGORY = '00000000-0000-4000-8000-0000000000b1';
const ISSUE = '00000000-0000-4000-8000-0000000000c1';
const PROJECT = line(1).id;

const risk = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  code: `R-${n}`,
  category_master_version_id: CATEGORY,
  category_label: 'Giải phóng mặt bằng',
  title: `Rủi ro số ${n}`,
  description: 'Hộ dân chưa nhận tiền bồi thường',
  likelihood: 4,
  impact: 5,
  score: 20,
  level: 'CRITICAL',
  owner: { membership_id: OWNER, display_name: 'Nguyễn Văn An' },
  mitigation: 'Họp dân hằng tuần',
  due_date: '2099-12-31',
  overdue: false,
  linked_issue_id: null,
  status: 'OPEN',
  closed_reason: null,
  version: 1,
  updated_at: '2026-10-31T01:00:00.000000Z',
  ...overrides,
});

const levelOf = (score: number): string => (score >= 15 ? 'CRITICAL' : score >= 6 ? 'MEDIUM' : 'LOW');
const grid = (held: Record<string, number> = {}): Array<Record<string, unknown>> =>
  [1, 2, 3, 4, 5].flatMap((likelihood) => [1, 2, 3, 4, 5].map((impact) => ({ likelihood, impact, score: likelihood * impact, level: levelOf(likelihood * impact), count: held[`${likelihood}:${impact}`] ?? 0 })));

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  next_cursor: null,
  matrix: grid({ '4:5': 1, '2:3': 2 }),
  live_count: 3,
  critical_count: 1,
  overdue_count: 1,
  as_of: '2026-10-31',
  ...extra,
});

afterEach(cleanup);

interface Served {
  pages: Array<Record<string, unknown>>;
  failing?: Error;
}

function open(served: Served, command: (operation: string, input: unknown) => unknown = () => OK, masters = [master(CATEGORY, 'RISK_CATEGORY', 'LAND', 'Giải phóng mặt bằng')]): Harness {
  const h = client(world({ masters }), command);
  const previous = h.read.getMockImplementation();
  let call = 0;
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'listProjectRisks') {
      if (served.failing !== undefined) return Promise.reject(served.failing);
      const answer = served.pages[Math.min(call, served.pages.length - 1)];
      call += 1;
      return Promise.resolve(answer);
    }
    return previous === undefined ? Promise.reject(new Error(`unexpected read ${operation}`)) : previous(operation, input);
  });
  return h;
}

const show = (h: Harness, permissions: readonly string[], options: { mode?: 'FULL' | 'READ_ONLY'; project?: boolean } = {}) =>
  mount(<RiskScreen route={ROUTE} />, h, { permissions, ...(options.mode === undefined ? {} : { mode: options.mode }), path: `/prj/prj-16${options.project === false ? '' : `?id=${PROJECT}`}` });
function Jump({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      jump
    </button>
  );
}
const asked = (h: Harness) => h.read.mock.calls.filter(([name]) => name === 'listProjectRisks').map(([, input]) => input as { path?: Record<string, string>; query?: Record<string, unknown> });

describe('RiskScreen (PRJ-16): the risk register of a project', () => {
  it('AC-ST-PRJ-010-2, UI-PRJ-16: lists the risks of the project with the score and the band in words, the owner, the group, the day, the overdue mark and the status; a 5 by 5 matrix puts a number and a word in every cell', async () => {
    const h = open({ pages: [page([risk(1), risk(2, { code: 'R-2', title: 'Chậm giải ngân', likelihood: 2, impact: 3, score: 6, level: 'MEDIUM', overdue: true, due_date: '2026-01-01', status: 'MITIGATING' }), risk(3, { status: 'CLOSED', closed_reason: 'Đã bàn giao mặt bằng đợt 1', likelihood: 1, impact: 1, score: 1, level: 'LOW' })])] });
    show(h, READER);
    const table = await screen.findByTestId('risks');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.risk.page.title']);
    for (const key of ['prj.risk.col.code', 'prj.risk.col.title', 'prj.risk.col.category', 'prj.risk.col.owner', 'prj.risk.col.score', 'prj.risk.col.due', 'prj.risk.col.status'] as const) {
      expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    }
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('R-1');
    expect(rows[0]?.textContent).toContain(vi_['prj.risk.score.pill'].replace('{score}', '20').replace('{level}', vi_['prj.risk.level.critical']));
    expect(rows[0]?.textContent).toContain('Nguyễn Văn An');
    expect(rows[0]?.textContent).toContain('Giải phóng mặt bằng');
    expect(rows[0]?.textContent).toContain(vi_['prj.risk.status.open']);
    expect(rows[1]?.textContent).toContain(vi_['prj.risk.overdue.pill']);
    expect(rows[1]?.textContent).toContain(vi_['prj.risk.score.pill'].replace('{score}', '6').replace('{level}', vi_['prj.risk.level.medium']));
    expect(rows[1]?.textContent).toContain(vi_['prj.risk.status.mitigating']);
    expect(rows[2]?.textContent).toContain(vi_['prj.risk.closed.note'].replace('{reason}', 'Đã bàn giao mặt bằng đợt 1'));
    expect(rows[2]?.textContent).toContain(vi_['prj.risk.status.closed']);
    expect((await screen.findByTestId('summary')).textContent).toBe(vi_['prj.risk.summary.counts'].replace('{live}', '3').replace('{critical}', '1').replace('{overdue}', '1'));
    expect(asked(h)[0]).toEqual({ path: { id: PROJECT }, query: { limit: 25 } });
    const matrix = screen.getByTestId('matrix');
    const cells = Array.from(matrix.querySelectorAll('td[data-cell]'));
    expect(cells).toHaveLength(25);
    for (const cell of cells) {
      const [likelihood, impact] = (cell.getAttribute('data-cell') ?? '').split(':').map(Number);
      const score = (likelihood ?? 0) * (impact ?? 0);
      const word = levelOf(score) === 'CRITICAL' ? vi_['prj.risk.level.critical'] : levelOf(score) === 'MEDIUM' ? vi_['prj.risk.level.medium'] : vi_['prj.risk.level.low'];
      expect(cell.textContent).toContain(String(score));
      expect(cell.textContent).toContain(word);
      expect(cell.getAttribute('aria-label')).toContain(word);
    }
    expect(matrix.querySelector('td[data-cell="4:5"]')?.getAttribute('data-count')).toBe('1');
    expect(matrix.querySelector('td[data-cell="2:3"]')?.textContent).toContain(vi_['prj.risk.matrix.cell.count'].replace('{count}', '2'));
    expect(within(matrix).getAllByRole('row')[1]?.textContent).toContain(vi_['prj.risk.matrix.likelihood'].replace('{value}', '5'));
    // A reader only reads.
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.risk.edit.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['prj.risk.close.action'] })).toBeNull();
  });

  it('asks the caller to choose a project when the address names none, and reads the register of the one chosen', async () => {
    const h = open({ pages: [page([risk(1)])] });
    show(h, READER, { project: false });
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.risk.noProject.notice']);
    expect(asked(h)).toHaveLength(0);
    const chooser = (await screen.findByLabelText(vi_['prj.risk.filter.project.label'])) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(chooser.options).some((option) => option.value === PROJECT)).toBe(true));
    fireEvent.change(chooser, { target: { value: PROJECT } });
    expect(await screen.findByTestId('risks')).toBeTruthy();
    expect(asked(h)[0]?.path).toEqual({ id: PROJECT });
  });

  it('narrows the register by status and goes on with the next page, which keeps the matrix of the first page', async () => {
    const h = open({ pages: [page([risk(1)], { next_cursor: 'CURSOR-1' }), page([risk(2)]), page([risk(3, { status: 'CLOSED', closed_reason: 'Đã bàn giao mặt bằng đợt 1' })])] });
    show(h, READER);
    await screen.findByTestId('risks');
    fireEvent.click(await screen.findByRole('button', { name: vi_['prj.risk.more.action'] }));
    await waitFor(() => expect(within(screen.getByTestId('risks')).getAllByRole('row')).toHaveLength(3));
    expect(asked(h)[1]?.query).toEqual({ limit: 25, cursor: 'CURSOR-1' });
    expect(screen.queryByRole('button', { name: vi_['prj.risk.more.action'] })).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['prj.risk.filter.status.label']), { target: { value: 'CLOSED' } });
    await waitFor(() => expect(asked(h).at(-1)?.query).toEqual({ limit: 25, status: 'CLOSED' }));
    expect(await screen.findByText(vi_['prj.risk.status.closed'], { selector: 'span.pill' })).toBeTruthy();
  });

  it('says in words that the register could not be read and reads it again on request', async () => {
    const h = open({ pages: [page([])], failing: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) });
    show(h, READER);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(asked(h).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId('risks')).toBeNull();
  });

  it('starts over when the address moves to another project (the browser going back, not only a choice): the form, the dialog and the filter of one project never reach another', async () => {
    const h = open({ pages: [page([risk(1)])] });
    mount(
      <>
        <RiskScreen route={ROUTE} />
        <Jump to={`/prj/prj-16?id=${line(2).id}`} />
      </>,
      h,
      { permissions: MANAGER, path: `/prj/prj-16?id=${PROJECT}` },
    );
    fireEvent.click(await screen.findByRole('button', { name: vi_['prj.risk.edit.action'] }));
    await screen.findByRole('form', { name: vi_['prj.risk.form.edit.title'].replace('{code}', 'R-1') });
    const filter = (): HTMLSelectElement => document.getElementById('risk-status') as HTMLSelectElement;
    fireEvent.change(filter(), { target: { value: 'OPEN' } });
    fireEvent.click(screen.getByRole('button', { name: 'jump' }));
    await waitFor(() => expect(asked(h).at(-1)?.path).toEqual({ id: line(2).id }));
    await screen.findByRole('form', { name: vi_['prj.risk.form.new.title'] });
    expect(screen.queryByRole('form', { name: vi_['prj.risk.form.edit.title'].replace('{code}', 'R-1') })).toBeNull();
    expect(filter().value).toBe('');
    expect(asked(h).at(-1)?.query).toEqual({ limit: 25 });
  });

  describe('registering', () => {
    it('refuses before it sends what is missing or not valid, and previews the score of the likelihood and the impact chosen', async () => {
      const h = open({ pages: [page([])] });
      show(h, MANAGER);
      const form = await screen.findByRole('form', { name: vi_['prj.risk.form.new.title'] });
      expect(within(form).getByTestId('score-preview').textContent).toBe(vi_['prj.risk.preview.choose']);
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.risk.form.register.action'] }));
      expect((await within(form).findAllByText(vi_['prj.risk.field.required.error'])).length).toBeGreaterThanOrEqual(8);
      fireEvent.change(within(form).getByLabelText(vi_['prj.risk.field.likelihood.label']), { target: { value: '4' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.risk.field.impact.label']), { target: { value: '5' } });
      expect(within(form).getByTestId('score-preview').textContent).toBe(vi_['prj.risk.preview.score'].replace('{score}', '20').replace('{level}', vi_['prj.risk.level.critical']));
      fireEvent.change(within(form).getByLabelText(vi_['prj.risk.field.code.label']), { target: { value: '-bad code' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.risk.field.ownerId.label']), { target: { value: 'not an identifier' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.risk.field.dueDate.label']), { target: { value: '2026-12-01' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.risk.field.linkedIssueId.label']), { target: { value: 'x' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.risk.form.register.action'] }));
      expect((await within(form).findAllByText(vi_['prj.risk.field.invalid.error'])).length).toBeGreaterThanOrEqual(3);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the risk to the project it was chosen for, without a status, and starts the form over once it is saved', async () => {
      const h = open({ pages: [page([])] });
      show(h, MANAGER);
      const form = await screen.findByRole('form', { name: vi_['prj.risk.form.new.title'] });
      const category = within(form).getByLabelText(vi_['prj.risk.field.categoryId.label']) as HTMLSelectElement;
      await waitFor(() => expect(Array.from(category.options).some((option) => option.value === CATEGORY)).toBe(true));
      fireEvent.change(category, { target: { value: CATEGORY } });
      const type = (label: string, value: string) => fireEvent.change(within(form).getByLabelText(label), { target: { value } });
      type(vi_['prj.risk.field.code.label'], ' R-NEW ');
      type(vi_['prj.risk.field.title.label'], 'Mặt bằng chậm bàn giao');
      type(vi_['prj.risk.field.description.label'], 'Hộ dân chưa nhận tiền bồi thường');
      type(vi_['prj.risk.field.likelihood.label'], '4');
      type(vi_['prj.risk.field.impact.label'], '5');
      type(vi_['prj.risk.field.ownerId.label'], OWNER);
      type(vi_['prj.risk.field.mitigation.label'], 'Họp dân hằng tuần');
      type(vi_['prj.risk.field.dueDate.label'], '2099-12-31');
      type(vi_['prj.risk.field.linkedIssueId.label'], ISSUE);
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.risk.form.register.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('registerProjectRisk');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: PROJECT },
        body: { code: 'R-NEW', category_master_version_id: CATEGORY, title: 'Mặt bằng chậm bàn giao', likelihood: 4, impact: 5, owner_membership_id: OWNER, due_date: '2099-12-31', linked_issue_id: ISSUE },
      });
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown>; ifMatchVersion?: number }).body).not.toHaveProperty('status');
      expect((h.command.mock.calls[0]?.[1] as { ifMatchVersion?: number }).ifMatchVersion).toBeUndefined();
      expect((await screen.findByTestId('form-saved')).textContent).toBe(vi_['prj.risk.form.saved']);
      expect((within(form).getByLabelText(vi_['prj.risk.field.code.label']) as HTMLInputElement).value).toBe('');
      await waitFor(() => expect(asked(h).length).toBeGreaterThanOrEqual(2));
    });

    it('takes the identifier of the group when the master list offers none, and says in words that the code is taken', async () => {
      const h = open({ pages: [page([])] }, () => new ApiError({ status: 409, code: 'RISK_CODE_DUPLICATE', correlationId: 'c' }), []);
      show(h, MANAGER);
      const form = await screen.findByRole('form', { name: vi_['prj.risk.form.new.title'] });
      await waitFor(() => expect(within(form).getByLabelText(vi_['prj.risk.field.categoryId.label']).tagName).toBe('INPUT'));
      const type = (label: string, value: string) => fireEvent.change(within(form).getByLabelText(label), { target: { value } });
      type(vi_['prj.risk.field.categoryId.label'], CATEGORY);
      type(vi_['prj.risk.field.code.label'], 'R-1');
      type(vi_['prj.risk.field.title.label'], 'Mặt bằng chậm bàn giao');
      type(vi_['prj.risk.field.description.label'], 'Hộ dân chưa nhận tiền bồi thường');
      type(vi_['prj.risk.field.likelihood.label'], '2');
      type(vi_['prj.risk.field.impact.label'], '2');
      type(vi_['prj.risk.field.ownerId.label'], OWNER);
      type(vi_['prj.risk.field.mitigation.label'], 'Họp dân hằng tuần');
      type(vi_['prj.risk.field.dueDate.label'], '2099-12-31');
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.risk.form.register.action'] }));
      expect((await within(form).findByTestId('form-refusal')).textContent).toBe(vi_['prj.risk.problem.codeDuplicate']);
    });

    it('hides the form and the actions from a caller without the right, and from one whose session is read only', async () => {
      const h = open({ pages: [page([risk(1)])] });
      show(h, MANAGER, { mode: 'READ_ONLY' });
      await screen.findByTestId('risks');
      expect(screen.queryByRole('form')).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['prj.risk.edit.action'] })).toBeNull();
    });
  });

  describe('updating and ending', () => {
    it('opens a live risk in the form with what it holds, offers its status and the ones after it only, and sends it under the version shown', async () => {
      const h = open({ pages: [page([risk(1, { status: 'MITIGATING', version: 3, linked_issue_id: ISSUE })])] });
      show(h, MANAGER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.risk.edit.action'] }));
      const form = await screen.findByRole('form', { name: vi_['prj.risk.form.edit.title'].replace('{code}', 'R-1') });
      expect((within(form).getByLabelText(vi_['prj.risk.field.title.label']) as HTMLInputElement).value).toBe('Rủi ro số 1');
      expect((within(form).getByLabelText(vi_['prj.risk.field.linkedIssueId.label']) as HTMLInputElement).value).toBe(ISSUE);
      const status = within(form).getByLabelText(vi_['prj.risk.field.status.label']) as HTMLSelectElement;
      expect(Array.from(status.options).map((option) => option.value)).toEqual(['MITIGATING', 'ESCALATED']);
      fireEvent.change(status, { target: { value: 'ESCALATED' } });
      fireEvent.change(within(form).getByLabelText(vi_['prj.risk.field.impact.label']), { target: { value: '3' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.risk.form.update.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('updateProjectRisk');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: risk(1).id }, ifMatchVersion: 3, body: { code: 'R-1', impact: 3, likelihood: 4, status: 'ESCALATED', linked_issue_id: ISSUE } });
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['prj.risk.form.edit.title'].replace('{code}', 'R-1') })).toBeNull());
    });

    it('says in words that someone else changed the risk first, and that an ended risk cannot be moved back', async () => {
      const h = open({ pages: [page([risk(1)])] }, () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
      show(h, MANAGER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.risk.edit.action'] }));
      const form = await screen.findByRole('form', { name: vi_['prj.risk.form.edit.title'].replace('{code}', 'R-1') });
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.risk.form.update.action'] }));
      expect((await within(form).findByTestId('form-refusal')).textContent).toBe(vi_['prj.risk.problem.versionConflict']);
      fireEvent.click(within(form).getByRole('button', { name: vi_['prj.risk.form.cancel.action'] }));
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['prj.risk.form.edit.title'].replace('{code}', 'R-1') })).toBeNull());
    });

    it('closes a risk with the reason, refusing a reason that is too short before it sends, and sends the version shown', async () => {
      const h = open({ pages: [page([risk(1, { version: 2 })])] });
      show(h, MANAGER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.risk.close.action'] }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('closure-summary').textContent).toBe(vi_['prj.risk.closure.summary'].replace('{title}', 'Rủi ro số 1').replace('{score}', '20'));
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.risk.closure.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.risk.field.required.error'])).toBeTruthy();
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.risk.closure.reason.label']), { target: { value: 'ngắn' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.risk.closure.submit.action'] }));
      expect(await within(dialog).findByText(vi_['prj.risk.field.invalid.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByLabelText(vi_['prj.risk.status.accepted']));
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.risk.closure.reason.label']), { target: { value: '  Rủi ro nằm trong mức chấp nhận được  ' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.risk.closure.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('closeProjectRisk');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: risk(1).id }, ifMatchVersion: 2, body: { status: 'ACCEPTED', closed_reason: 'Rủi ro nằm trong mức chấp nhận được' } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('keeps the dialog open and says in words why the server refused to end the risk; the buttons of the dialog close it', async () => {
      const h = open({ pages: [page([risk(1)])] }, () => new ApiError({ status: 409, code: 'RISK_STATE_INVALID', correlationId: 'c' }));
      show(h, MANAGER);
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.risk.close.action'] }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(vi_['prj.risk.closure.reason.label']), { target: { value: 'Đã bàn giao mặt bằng đợt 1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.risk.closure.submit.action'] }));
      expect((await within(dialog).findByTestId('closure-refusal')).textContent).toBe(vi_['prj.risk.problem.stateInvalid']);
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['prj.risk.closure.dismiss.label'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(await screen.findByRole('button', { name: vi_['prj.risk.close.action'] }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: vi_['prj.risk.closure.cancel.action'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('offers no action on a risk that has ended', async () => {
      const h = open({ pages: [page([risk(1, { status: 'ACCEPTED', closed_reason: 'Rủi ro nằm trong mức chấp nhận được' })])] });
      show(h, MANAGER);
      await screen.findByTestId('risks');
      expect(screen.queryByRole('button', { name: vi_['prj.risk.edit.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['prj.risk.close.action'] })).toBeNull();
    });
  });
});

describe('the model of the risk register', () => {
  const view = (): RiskView => toRiskPage(page([risk(1)])).items[0] as RiskView;

  it('reads a page, leaves out what is not a risk or a cell, and keeps the figures of the server', () => {
    const read = toRiskPage(page([risk(1), { id: 'x' }, risk(2, { likelihood: 9 }), risk(3, { status: 'LOST' }), risk(4, { owner: {} }), null], { matrix: [...grid({ '1:1': 2 }), { likelihood: 7 }, null], next_cursor: 'N', live_count: 'x' }));
    expect(read.items.map((item) => item.code)).toEqual(['R-1']);
    expect(read.matrix).toHaveLength(25);
    expect(cellOf(read.matrix, 1, 1)).toEqual({ likelihood: 1, impact: 1, score: 1, level: 'LOW', count: 2 });
    expect(cellOf(read.matrix, 6, 1)).toBeUndefined();
    expect([read.nextCursor, read.liveCount, read.criticalCount, read.overdueCount]).toEqual(['N', 0, 1, 1]);
    expect(toRiskPage(undefined)).toEqual({ items: [], nextCursor: undefined, matrix: [], liveCount: 0, criticalCount: 0, overdueCount: 0 });
    expect(view()).toMatchObject({ ownerName: 'Nguyễn Văn An', linkedIssueId: null, closedReason: null, categoryLabel: 'Giải phóng mặt bằng' });
    const bare = toRiskPage(page([risk(1, { category_label: 5, owner: { membership_id: OWNER }, linked_issue_id: ISSUE })])).items[0];
    expect([bare?.categoryLabel, bare?.ownerName, bare?.linkedIssueId]).toEqual([null, null, ISSUE]);
  });

  it('knows who may manage, which risks are live and where a live risk may go', () => {
    expect([holds(MANAGER, 'project.risk.manage', undefined), holds(READER, 'project.risk.manage', undefined), holds(undefined, 'project.risk.manage', 'FULL'), holds(MANAGER, 'project.risk.manage', 'READ_ONLY')]).toEqual([true, false, true, false]);
    expect(['OPEN', 'MITIGATING', 'ESCALATED', 'ACCEPTED', 'CLOSED'].map((status) => isLive(status as RiskView['status']))).toEqual([true, true, true, false, false]);
    expect([movesFrom('OPEN'), movesFrom('MITIGATING'), movesFrom('ESCALATED')]).toEqual([['OPEN', 'MITIGATING', 'ESCALATED'], ['MITIGATING', 'ESCALATED'], ['ESCALATED']]);
    const cells: Cell[] = [{ likelihood: 2, impact: 2, score: 4, level: 'LOW', count: 0 }];
    expect([cellOf(cells, 2, 2)?.score, cellOf(cells, 3, 2)]).toEqual([4, undefined]);
  });

  const FORM: RiskForm = { code: 'R-1', categoryId: CATEGORY, title: 'Mặt bằng chậm', description: 'Hộ dân chưa nhận tiền', likelihood: '4', impact: '5', ownerId: OWNER, mitigation: 'Họp dân', dueDate: '2099-12-31', linkedIssueId: '', status: 'OPEN' };

  it('checks a form field by field and builds the body the server takes', () => {
    expect(validateForm(FORM)).toEqual({});
    expect(validateForm({ ...FORM, linkedIssueId: ISSUE })).toEqual({});
    expect(Object.keys(validateForm({ code: '', categoryId: '', title: '', description: '', likelihood: '', impact: '', ownerId: '', mitigation: '', dueDate: '', linkedIssueId: '', status: 'OPEN' })).sort()).toEqual(
      ['categoryId', 'code', 'description', 'dueDate', 'impact', 'likelihood', 'mitigation', 'ownerId', 'title'],
    );
    expect(validateForm({ ...FORM, code: '-x', categoryId: 'x', title: 'ab', description: 'x'.repeat(2001), likelihood: '6', impact: '2.5', ownerId: 'x', mitigation: 'x'.repeat(2001), dueDate: '2026-02-30', linkedIssueId: 'x' })).toEqual({
      code: 'invalid', categoryId: 'invalid', title: 'invalid', description: 'invalid', likelihood: 'invalid', impact: 'invalid', ownerId: 'invalid', mitigation: 'invalid', dueDate: 'invalid', linkedIssueId: 'invalid',
    });
    expect(entryBody({ ...FORM, code: ' R-1 ', title: ' Mặt bằng chậm ' }, false)).toEqual({
      code: 'R-1', category_master_version_id: CATEGORY, title: 'Mặt bằng chậm', description: 'Hộ dân chưa nhận tiền', likelihood: 4, impact: 5, owner_membership_id: OWNER, mitigation: 'Họp dân', due_date: '2099-12-31',
    });
    expect(entryBody({ ...FORM, linkedIssueId: ISSUE, status: 'ESCALATED' }, true)).toMatchObject({ linked_issue_id: ISSUE, status: 'ESCALATED' });
    expect(previewScore(FORM)).toBe(20);
    expect([previewScore({ likelihood: '', impact: '5' }), previewScore({ likelihood: '6', impact: '5' })]).toEqual([undefined, undefined]);
    expect(formOfRisk(view())).toMatchObject({ code: 'R-1', likelihood: '4', impact: '5', linkedIssueId: '', status: 'OPEN' });
    expect(formOfRisk({ ...view(), status: 'CLOSED' }).status).toBe('OPEN');
  });

  it('checks the reason of an end and tells what the server refused', () => {
    expect([validateClosure({ status: 'CLOSED', reason: '  ' }), validateClosure({ status: 'CLOSED', reason: 'x'.repeat(9) }), validateClosure({ status: 'CLOSED', reason: 'x'.repeat(2001) }), validateClosure({ status: 'ACCEPTED', reason: 'x'.repeat(10) })]).toEqual(['required', 'invalid', 'invalid', undefined]);
    expect(closureBody({ status: 'ACCEPTED', reason: ' Đã chấp nhận rủi ro này ' })).toEqual({ status: 'ACCEPTED', closed_reason: 'Đã chấp nhận rủi ro này' });
    const refusal = (status: number, code: string) => describeRisk(new ApiError({ status, code, correlationId: 'c' }));
    expect([refusal(409, 'RISK_CODE_DUPLICATE'), refusal(409, 'RISK_STATE_INVALID'), refusal(409, 'VERSION_CONFLICT'), refusal(403, 'SCOPE_DENIED'), refusal(422, 'VALIDATION_FAILED'), refusal(400, 'INVALID_REQUEST'), refusal(404, 'RESOURCE_NOT_FOUND'), refusal(500, 'X'), describeRisk(new Error('x'))]).toEqual([
      'codeDuplicate', 'stateInvalid', 'versionConflict', 'scopeDenied', 'validation', 'validation', 'notFound', 'general', 'general',
    ]);
  });
});
