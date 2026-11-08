import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { SectionCard } from '../../../ui';
import { Field, ScreenFrame, SourcePicker, SubmitFailure, describedBy } from './assist-components';
import { useCreateRun, usePermit } from './assist-hooks';
import { kindHint, kindLabel, runProblemText, sourceKindLabel } from './assist-labels';
import { ASSIST_USE, FREE_KINDS, MAX_REQUEST_CHARS, SOURCE_KINDS, isUuid, runBody, subjectFromQuery, validateRun } from './assist-model';
import type { AssistRun, RunKind, RunProblem, SourceKind, SourceRef } from './assist-model';
import { RunHistory } from './run-history';
import { CreatedRun } from './run-view';

/**
 * LLM-22, the AI assistant (AI.01, AI.05, AI.07): a question, a summary, the draft of an explanatory note or a feasibility analysis over the sources the person names. The answer is a list of statements, each with what it rests
 * on (a source the asker may read, an assumption, an inference) and the citations; a statement without a verified source is shown as having none. The answer is a proposal and is never applied by itself.
 * A link from a record (`?subject_kind=&subject_id=`) fills the subject and the first source.
 */
export default function AssistantScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { search } = useLocation();
  // What is typed belongs to one membership of one tenant, and to the link the screen was opened with: either changing starts the form over.
  return <AssistantContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${search}`} route={route} search={search} />;
}

function AssistantContent({ route, search }: ScreenProps & { search: string }) {
  const { t } = useTranslation();
  const permit = usePermit();
  const linked = useMemo(() => subjectFromQuery(search), [search]);
  const create = useCreateRun();
  const [kind, setKind] = useState<RunKind>('QA');
  const [text, setText] = useState('');
  const [sources, setSources] = useState<readonly SourceRef[]>(linked === undefined ? [] : [linked]);
  const [subjectKind, setSubjectKind] = useState<SourceKind>(linked?.kind ?? 'PROJECT');
  const [subjectId, setSubjectId] = useState(linked?.id ?? '');
  const [maxCost, setMaxCost] = useState('');
  const [problems, setProblems] = useState<RunProblem[]>([]);
  const [created, setCreated] = useState<AssistRun | undefined>(undefined);
  const allowed = permit.has(ASSIST_USE);
  const sending = create.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (sending) return;
    const subject = isUuid(subjectId) ? { kind: subjectKind, id: subjectId.trim().toLowerCase() } : undefined;
    const form = { kind, text, sources, subject, checklistId: '', criteriaSetId: '', maxCost };
    const found = [...validateRun(form), ...(subjectId.trim() !== '' && subject === undefined ? (['SUBJECT_INVALID'] as RunProblem[]) : [])];
    setProblems(found);
    if (found.length > 0) return;
    setCreated(undefined);
    create.mutate(runBody(form), { onSuccess: (run) => setCreated(run) });
  };
  const problem = (wanted: RunProblem): string | undefined => (problems.includes(wanted) ? runProblemText(t, wanted) : undefined);

  return (
    <ScreenFrame screenId={route.id} title={t('llm.assist.page.title')} subtitle={t('llm.assist.page.subtitle')}>
      {!allowed ? (
        <StateBoundary state="denied" />
      ) : (
        <div className="assist-page">
          <p className="callout" data-testid="page-advisory">
            {t('llm.assist.run.advisory')}
          </p>
          {permit.can(ASSIST_USE) ? null : (
            <p className="callout" data-testid="read-only-note">
              {t('llm.assist.form.readOnly')}
            </p>
          )}
          <SectionCard title={t('llm.assist.form.title')}>
            <form className="assist-form" onSubmit={submit} noValidate aria-label={t('llm.assist.form.title')}>
              <div className="assist-form-grid">
                <Field id="assist-kind" label={t('llm.assist.form.kind')} hint={kindHint(t, kind)}>
                  <select id="assist-kind" value={kind} aria-describedby={describedBy('assist-kind', true, false)} onChange={(event) => setKind(event.target.value as RunKind)}>
                    {FREE_KINDS.map((entry) => (
                      <option key={entry} value={entry}>
                        {kindLabel(t, entry)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="assist-cost" label={t('llm.assist.form.maxCost')} hint={t('llm.assist.form.maxCostHint')} error={problem('COST_INVALID')}>
                  <input id="assist-cost" inputMode="numeric" value={maxCost} aria-invalid={problem('COST_INVALID') !== undefined} aria-describedby={describedBy('assist-cost', true, problem('COST_INVALID') !== undefined)} onChange={(event) => setMaxCost(event.target.value)} />
                </Field>
              </div>
              <Field id="assist-text" label={t('llm.assist.form.text')} hint={t('llm.assist.form.textHint', { max: MAX_REQUEST_CHARS })} error={problem('TEXT_REQUIRED') ?? problem('TEXT_TOO_LONG')}>
                <textarea id="assist-text" value={text} maxLength={MAX_REQUEST_CHARS} aria-invalid={problem('TEXT_REQUIRED') !== undefined} aria-describedby={describedBy('assist-text', true, problem('TEXT_REQUIRED') !== undefined)} onChange={(event) => setText(event.target.value)} />
              </Field>
              <SourcePicker sources={sources} onChange={setSources} legend={t('llm.assist.form.sources')} hint={t('llm.assist.form.sourcesHint')} />
              {problem('SOURCES_REQUIRED') === undefined ? null : (
                <p className="field-error" role="alert">
                  {problem('SOURCES_REQUIRED')}
                </p>
              )}
              <div className="assist-form-grid">
                <Field id="assist-subject-kind" label={t('llm.assist.form.subjectKind')}>
                  <select id="assist-subject-kind" value={subjectKind} onChange={(event) => setSubjectKind(event.target.value as SourceKind)}>
                    {SOURCE_KINDS.map((entry) => (
                      <option key={entry} value={entry}>
                        {sourceKindLabel(t, entry)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="assist-subject-id" label={t('llm.assist.form.subjectId')} hint={t('llm.assist.form.subjectHint')} error={problem('SUBJECT_INVALID')}>
                  <input id="assist-subject-id" value={subjectId} autoComplete="off" spellCheck={false} aria-invalid={problem('SUBJECT_INVALID') !== undefined} aria-describedby={describedBy('assist-subject-id', true, problem('SUBJECT_INVALID') !== undefined)} onChange={(event) => setSubjectId(event.target.value)} />
                </Field>
              </div>
              {create.isError ? <SubmitFailure error={create.error} /> : null}
              <div className="assist-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={sending || !permit.can(ASSIST_USE)} data-testid="ask-button">
                  {sending ? t('llm.assist.form.sending') : t('llm.assist.form.submit')}
                </button>
              </div>
            </form>
          </SectionCard>
          {created === undefined ? null : <CreatedRun key={created.id} run={created} />}
          <RunHistory />
        </div>
      )}
    </ScreenFrame>
  );
}
