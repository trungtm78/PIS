import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { SectionCard } from '../../../ui';
import { Field, ScreenFrame, SectionDenied, SectionFailed, SourcePicker, SubmitFailure, describedBy } from './assist-components';
import { useChecklists, useCreateRun, usePermit } from './assist-hooks';
import { runProblemText } from './assist-labels';
import { ASSIST_REVIEW, failureStatus, isUuid, runBody, validateRun } from './assist-model';
import type { AssistRun, RunProblem, SourceRef } from './assist-model';
import { CreatedRun } from './run-view';

/**
 * LLM-24, the review of a file before it is sent up (AI.02): a published checklist and the version of the document. Each item is answered by a rule the server runs on the text or by the assistant with a verified citation;
 * an item that is not proven is shown as not proven and never as a pass. The verdict is advice: it does not block sending.
 */
export default function ReviewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ReviewContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReviewContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const permit = usePermit();
  const checklists = useChecklists('PUBLISHED');
  const create = useCreateRun();
  const [checklistId, setChecklistId] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [extra, setExtra] = useState<readonly SourceRef[]>([]);
  const [problems, setProblems] = useState<RunProblem[]>([]);
  const [created, setCreated] = useState<AssistRun | undefined>(undefined);
  const forbidden = failureStatus(checklists.error) === 403;
  const published = checklists.data ?? [];
  const sending = create.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (sending) return;
    const document: SourceRef[] = isUuid(documentId) ? [{ kind: 'DOCUMENT_VERSION', id: documentId.trim().toLowerCase() }] : [];
    const sources = [...document, ...extra.filter((entry) => !document.some((first) => first.kind === entry.kind && first.id === entry.id))];
    const form = { kind: 'DOC_REVIEW' as const, text: '', sources, subject: undefined, checklistId, criteriaSetId: '', maxCost: '' };
    const found = validateRun(form).filter((problem) => problem !== 'SOURCES_REQUIRED' || document.length > 0);
    setProblems(found);
    if (found.length > 0) return;
    setCreated(undefined);
    create.mutate(runBody(form), { onSuccess: (run) => setCreated(run) });
  };
  const problem = (wanted: RunProblem): string | undefined => (problems.includes(wanted) ? runProblemText(t, wanted) : undefined);

  return (
    <ScreenFrame screenId={route.id} title={t('llm.review.page.title')} subtitle={t('llm.review.page.subtitle')}>
      {!permit.has(ASSIST_REVIEW) ? (
        <StateBoundary state="denied" />
      ) : (
        <div className="assist-page">
          <p className="callout" data-testid="review-advice">
            {t('llm.review.page.advice')}
          </p>
          <SectionCard title={t('llm.review.form.title')}>
            <form className="assist-form" onSubmit={submit} noValidate aria-label={t('llm.review.form.title')}>
              {forbidden ? <SectionDenied what={t('llm.review.form.checklist')} /> : null}
              {checklists.isError && !forbidden ? <SectionFailed what={t('llm.review.form.checklist')} onRetry={() => void checklists.refetch()} /> : null}
              {!checklists.isLoading && !checklists.isError && published.length === 0 ? (
                <p className="callout" data-testid="no-published-checklist">
                  {t('llm.review.form.noChecklist')}
                </p>
              ) : null}
              <div className="assist-form-grid">
                <Field id="review-checklist" label={t('llm.review.form.checklist')} error={problem('CHECKLIST_REQUIRED')}>
                  <select id="review-checklist" value={checklistId} disabled={checklists.isLoading || published.length === 0} aria-invalid={problem('CHECKLIST_REQUIRED') !== undefined} aria-describedby={describedBy('review-checklist', false, problem('CHECKLIST_REQUIRED') !== undefined)} onChange={(event) => setChecklistId(event.target.value)}>
                    <option value="">{checklists.isLoading ? t('llm.review.form.loading') : t('llm.review.form.choose')}</option>
                    {published.map((checklist) => (
                      <option key={checklist.id} value={checklist.id}>
                        {t('llm.review.form.option', { code: checklist.code, revision: checklist.revision, title: checklist.title })}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="review-document" label={t('llm.review.form.document')} hint={t('llm.review.form.documentHint')} error={problem('DOCUMENT_REQUIRED')}>
                  <input id="review-document" value={documentId} autoComplete="off" spellCheck={false} aria-invalid={problem('DOCUMENT_REQUIRED') !== undefined} aria-describedby={describedBy('review-document', true, problem('DOCUMENT_REQUIRED') !== undefined)} onChange={(event) => setDocumentId(event.target.value)} />
                </Field>
              </div>
              <SourcePicker sources={extra} onChange={setExtra} legend={t('llm.review.form.more')} hint={t('llm.review.form.moreHint')} />
              {create.isError ? <SubmitFailure error={create.error} /> : null}
              <div className="assist-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={sending || !permit.can(ASSIST_REVIEW)} data-testid="review-button">
                  {sending ? t('llm.review.form.sending') : t('llm.review.form.submit')}
                </button>
              </div>
            </form>
          </SectionCard>
          {created === undefined ? null : <CreatedRun key={created.id} run={created} />}
        </div>
      )}
    </ScreenFrame>
  );
}
