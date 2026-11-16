import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { taskDetail, text } from '../test/fixtures';
import { LegalBasisList } from './LegalBasisList';
import { EMPTY_CHOICE } from './model';
import type { ChoiceForm } from './model';
import { ProcessKindSection } from './ProcessKindSection';
import { FormRevision, TaskProcessSection, mergedBasis } from './TaskProcessSection';
import { legalBasis, suggestion } from './test/fixtures';

afterEach(cleanup);

describe('the legal grounds of a step or a task', () => {
  it('names the document as the catalogue does, the article, the days of effect, and that nobody confirmed the citation yet', () => {
    render(<LegalBasisList of="Thẩm định" basis={[legalBasis({ article: 'Điều 22', effective_to: '2025-08-04', note: 'Thời gian thẩm định' })]} testId="basis" />);
    const item = within(screen.getByTestId('basis')).getByRole('listitem');
    expect(item.textContent).toContain(`${text('pwf.process.docKind.decree.word')} 24/2024/NĐ-CP`);
    expect(item.textContent).toContain('Điều 22');
    expect(item.textContent).toContain('Chính phủ');
    expect(item.textContent).toContain(text('pwf.process.legal.effect.closed', { from: '27/02/2024', to: '04/08/2025' }));
    expect(item.textContent).toContain(text('pwf.process.legal.unverified.word'));
    expect(item.textContent).toContain(text('pwf.process.legal.inForce.word'));
    expect(item.textContent).toContain('Thời gian thẩm định');
    expect(screen.getByRole('list').getAttribute('aria-label')).toBe(text('pwf.process.legal.list.label', { of: 'Thẩm định' }));
  });

  it('says in words that a document was replaced, lapsed or is no longer in the catalogue, and that an article is still to be confirmed', () => {
    render(
      <LegalBasisList
        of="Bước"
        basis={[
          legalBasis({ state: 'SUPERSEDED', superseded_by: 'DECREE_214_2025_ND_CP' }),
          legalBasis({ document_code: 'OLD_ONE', state: 'EXPIRED' }),
          legalBasis({ document_code: 'GONE', state: 'UNKNOWN', number: null, title: null, doc_kind: null, issuer: null, effective_from: null, document_verification: null }),
          legalBasis({ document_code: 'LAW_OK', verification: 'VERIFIED', document_verification: 'VERIFIED', article: 'Điều 5' }),
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain(text('pwf.process.legal.replaced.text', { code: 'DECREE_214_2025_ND_CP' }));
    expect(items[0]?.textContent).toContain(text('pwf.process.legal.article.pending'));
    expect(items[1]?.textContent).toContain(text('pwf.process.legal.lapsed.text'));
    expect(items[2]?.textContent).toContain(text('pwf.process.legal.missing.text', { code: 'GONE' }));
    expect(items[2]?.textContent).toContain('GONE');
    expect(items[3]?.textContent).toContain(text('pwf.process.legal.verified.word'));
    expect(items[3]?.textContent).not.toContain(text('pwf.process.legal.lapsed.text'));
  });

  it('says that nothing is declared rather than showing an empty list', () => {
    render(<LegalBasisList of="Bước" basis={[]} testId="basis" />);
    expect(screen.getByTestId('basis-empty').textContent).toBe(text('pwf.process.legal.none.text'));
  });
});

describe('the place of a task in the procedure (PWF-04)', () => {
  const form = (over: Record<string, unknown> = {}) => ({ code: 'BM_01', satisfied: true, document_id: null, policy: 'LATEST_APPROVED' as const, pinned_revision: null, current_revision: 3, current_title: 'Tờ trình thẩm định', current_effective_from: '2026-11-01', used_revision: 2, used_sha256: 'ab'.repeat(32), newer_available: true, ...over });

  it('names the step, the legal grounds of the task and of its step, and warns that a form was revised after the task made its document', () => {
    render(
      <TaskProcessSection
        task={taskDetail({
          step: { code: 'S_APPRAISAL', name: 'Thẩm định dự án', phase_code: 'FEASIBILITY', order: 2, implicit: false, responsible_role: 'DPI_APPRAISER' },
          legal_basis: [legalBasis({ document_code: 'DECREE_85_2025_ND_CP', number: '85/2025/NĐ-CP', article: 'Điều 22' })],
          step_legal_basis: [legalBasis({ document_code: 'LAW_58_2024_QH15', doc_kind: 'LAW', number: '58/2024/QH15' })],
          form_templates: [form(), form({ code: 'BM_02', policy: 'PINNED', pinned_revision: 1, current_revision: 4, used_revision: 1, newer_available: false })],
        })}
      />,
    );
    // One list of grounds: what the task cites and what its step cites, each marked with where it comes from.
    const grounds = screen.getByTestId('task-legal');
    expect(grounds.textContent).toContain('85/2025/NĐ-CP');
    expect(grounds.textContent).toContain(`${text('pwf.process.docKind.law.word')} 58/2024/QH15`);
    expect((grounds.querySelector('[data-document="DECREE_85_2025_ND_CP"]') as HTMLElement).textContent).toContain(text('pwf6.legal.from.task'));
    expect((grounds.querySelector('[data-document="LAW_58_2024_QH15"]') as HTMLElement).textContent).toContain(text('pwf6.legal.from.step'));
    cleanup();
    // The revisions of the forms are said with each form.
    render(
      <>
        <FormRevision form={form()} />
        <FormRevision form={form({ code: 'BM_02', policy: 'PINNED', pinned_revision: 1, current_revision: 4, used_revision: 1, newer_available: false })} />
      </>,
    );
    expect(screen.getByTestId('form-current-BM_01').textContent).toBe(text('pwf.process.forms.current.text', { revision: 3, from: '01/11/2026' }));
    expect(screen.getByTestId('form-used-BM_01').textContent).toBe(text('pwf6.forms.used.text', { revision: 2 }));
    expect(screen.getByTestId('form-newer-BM_01').textContent).toBe(text('pwf.process.forms.newer.text', { used: 2, current: 3 }));
    expect(screen.queryByTestId('form-newer-BM_02')).toBeNull();
    expect((document.querySelector('[data-form-revision="BM_02"]') as HTMLElement).textContent).toContain(text('pwf.process.forms.pinned.word', { revision: 1 }));
  });

  it('says a ground the task and its step both cite once, as cited by both', () => {
    const same = legalBasis({ document_code: 'LAW_58_2024_QH15', doc_kind: 'LAW', number: '58/2024/QH15', article: 'Điều 5' });
    expect(mergedBasis([same], [same, legalBasis({ document_code: 'LAW_58_2024_QH15', doc_kind: 'LAW', number: '58/2024/QH15', article: 'Điều 9' })]).map((one) => [one.basis.article, one.from])).toEqual([
      ['Điều 5', 'both'],
      ['Điều 9', 'step'],
    ]);
  });

  it('says that a task belongs to no step, that a form has no approved revision, and that no document was made yet', () => {
    render(
      <>
        <TaskProcessSection task={taskDetail({ step: null, legal_basis: [], step_legal_basis: [] })} />
        <FormRevision form={form({ satisfied: false, current_revision: null, current_title: null, current_effective_from: null, used_revision: null, used_sha256: null, newer_available: false })} />
      </>,
    );
    expect(screen.getByTestId('task-legal-empty').textContent).toBe(text('pwf.process.legal.none.text'));
    expect(screen.getByTestId('form-current-BM_01').textContent).toBe(text('pwf.process.forms.current.none'));
    expect(screen.getByTestId('form-used-BM_01').textContent).toBe(text('pwf.process.forms.used.none'));
  });

  it('shows nothing for an answer kept from before these facts existed', () => {
    const { container } = render(<TaskProcessSection task={taskDetail()} />);
    expect(container.textContent).toBe('');
  });
});

describe('the kind of workflow and the planned start (PRJ-02, PWF-05)', () => {
  const show = (form: Partial<ChoiceForm> = {}, over: Partial<Parameters<typeof ProcessKindSection>[0]> = {}) => {
    const onChange = vi.fn();
    render(<ProcessKindSection form={{ ...EMPTY_CHOICE, ...form }} onChange={onChange} suggestion={suggestion()} loading={false} failed={false} onRetry={() => undefined} disabled={false} showProblems={false} withoutStart={text('pwf.process.kind.start.registerHint')} {...over} />);
    return onChange;
  };

  it('says what the rule suggests and why, offers every template, and previews the schedule before anything is saved', () => {
    show({ plannedStart: '2026-12-01' });
    expect(screen.getByTestId('kind-suggestion').textContent).toContain(text('pwf6.kind.suggested.label'));
    expect(screen.getByTestId('kind-suggestion').textContent).toContain('Dự án đầu tư công xây dựng');
    expect(screen.getByTestId('kind-suggestion').getAttribute('data-suggested')).toBe('PUBLIC_INVESTMENT');
    expect(screen.getByTestId('kind-suggestion').textContent).toContain(text('pwf6.kind.reason.label'));
    expect(screen.getByTestId('kind-suggestion').textContent).toContain(text('pwf.process.basis.default.text'));
    expect(within(screen.getByTestId('kind-template')).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'PUBLIC_INVESTMENT', 'PUBLIC_REPAIR']);
    expect(screen.getByTestId('kind-unverified')).toBeTruthy();
    expect(screen.getByTestId('preview-finish').textContent).toBe('15/03/2028');
    expect(screen.getByTestId('preview-total').textContent).toBe(text('pwf.process.preview.days.text', { days: 330 }));
    expect(screen.getByTestId('preview-counts').textContent).toBe(text('pwf.process.preview.counts.text', { phases: 6, steps: 13, tasks: 31 }));
    const rows = within(screen.getByTestId('kind-preview')).getAllByRole('row');
    expect(rows[1]?.textContent).toContain('Quyết định chủ trương đầu tư');
    expect(rows[1]?.textContent).toContain('35');
    expect(rows[2]?.textContent).toContain(text('pwf.process.step.notApplicable.word'));
  });

  it('asks for the facts only the chosen template branches on, and for a reason only when the choice goes against the rule', () => {
    const onChange = show({ templateCode: 'PUBLIC_REPAIR' });
    expect(screen.queryByTestId('kind-group')).toBeNull();
    expect(screen.queryByTestId('kind-funding')).toBeNull();
    fireEvent.change(screen.getByTestId('kind-reason'), { target: { value: 'Dự án sửa chữa' } });
    expect(onChange).toHaveBeenCalledWith({ reason: 'Dự án sửa chữa' });
    cleanup();
    show({ templateCode: 'PUBLIC_INVESTMENT' });
    expect(screen.getByTestId('kind-group')).toBeTruthy();
    expect(screen.getByTestId('kind-funding')).toBeTruthy();
    expect(screen.queryByTestId('kind-reason')).toBeNull();
  });

  it('names what keeps the workflow from starting once the person tried to save, and what the schedule is missing', () => {
    show({ plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR' }, { showProblems: true, suggestion: suggestion({ preview: { missing_facts: ['funding_source'], project_finish: null, total_working_days: null } }) });
    const problems = within(screen.getByTestId('kind-problems')).getAllByRole('listitem').map((item) => item.getAttribute('data-problem'));
    expect(problems).toEqual(['reasonRequired', 'factsRequired']);
    expect(screen.getByTestId('preview-facts').textContent).toBe(text('pwf.process.preview.missingFacts.text', { facts: text('pwf.process.fact.funding.label') }));
  });

  it('says that no template is suggested, that the caller may not start a workflow, and that the suggestion could not be read', () => {
    show({}, { suggestion: suggestion({ suggested_template_code: null, basis: 'NONE', can_start: false, preview: null, unknown_templates: ['RETIRED_ONE'] }), failed: true });
    expect(screen.getByTestId('kind-suggestion').textContent).toBe(text('pwf.process.basis.none.text'));
    expect(screen.getByTestId('kind-denied').textContent).toBe(text('pwf.process.kind.denied.text'));
    expect(screen.getByTestId('kind-failed').textContent).toContain(text('pwf.process.kind.failed.text'));
    expect(screen.getByTestId('kind-unknown').textContent).toBe(text('pwf.process.kind.unknownTemplates.text', { codes: 'RETIRED_ONE' }));
    expect((screen.getByTestId('kind-start') as HTMLInputElement).disabled).toBe(true);
  });

  it('has no serious accessibility violation', async () => {
    const onChange = vi.fn();
    const { container } = render(<ProcessKindSection form={{ ...EMPTY_CHOICE, plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR' }} onChange={onChange} suggestion={suggestion()} loading={false} failed={false} onRetry={() => undefined} disabled={false} showProblems withoutStart="x" />);
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
