import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { taskDetail, text } from '../test/fixtures';
import { LegalBasisList } from './LegalBasisList';
import { FormRevision, TaskProcessSection, mergedBasis } from './TaskProcessSection';
import { legalBasis } from './test/fixtures';

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
