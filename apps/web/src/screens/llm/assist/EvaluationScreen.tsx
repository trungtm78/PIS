import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { SectionCard } from '../../../ui';
import { Field, ScreenFrame, SectionDenied, SectionFailed, SourcePicker, SubmitFailure, describedBy } from './assist-components';
import { useCreateRun, useCriteriaSets, usePermit } from './assist-hooks';
import { runProblemText } from './assist-labels';
import { ASSIST_EVALUATE, failureStatus, isUuid, runBody, validateRun } from './assist-model';
import type { AssistRun, RunProblem, SourceRef } from './assist-model';
import { CreatedRun } from './run-view';

/**
 * LLM-25, the proposal of an evaluation of the performance of a contract (AI.04): a published set of criteria and the contract. The assistant proposes a score for each criterion with its citations, and withholds the score of a
 * criterion that needs evidence it cannot cite. The person accepts or sets each score, the weighted total is computed from those scores only, and nothing is written to another module.
 */
export default function EvaluationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <EvaluationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EvaluationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const permit = usePermit();
  const sets = useCriteriaSets('PUBLISHED');
  const create = useCreateRun();
  const [setId, setSetId] = useState('');
  const [contractId, setContractId] = useState('');
  const [extra, setExtra] = useState<readonly SourceRef[]>([]);
  const [problems, setProblems] = useState<RunProblem[]>([]);
  const [created, setCreated] = useState<AssistRun | undefined>(undefined);
  const forbidden = failureStatus(sets.error) === 403;
  const published = sets.data ?? [];
  const sending = create.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (sending) return;
    const contract: SourceRef[] = isUuid(contractId) ? [{ kind: 'CONTRACT', id: contractId.trim().toLowerCase() }] : [];
    const sources = [...contract, ...extra.filter((entry) => !contract.some((first) => first.kind === entry.kind && first.id === entry.id))];
    const form = { kind: 'CONTRACT_EVAL' as const, text: '', sources, subject: undefined, checklistId: '', criteriaSetId: setId, maxCost: '' };
    const found = validateRun(form).filter((problem) => problem !== 'SOURCES_REQUIRED' || contract.length > 0);
    setProblems(found);
    if (found.length > 0) return;
    setCreated(undefined);
    create.mutate(runBody(form), { onSuccess: (run) => setCreated(run) });
  };
  const problem = (wanted: RunProblem): string | undefined => (problems.includes(wanted) ? runProblemText(t, wanted) : undefined);

  return (
    <ScreenFrame screenId={route.id} title={t('llm.evaluation.page.title')} subtitle={t('llm.evaluation.page.subtitle')}>
      {!permit.has(ASSIST_EVALUATE) ? (
        <StateBoundary state="denied" />
      ) : (
        <div className="assist-page">
          <p className="callout" data-testid="evaluation-note">
            {t('llm.evaluation.page.note')}
          </p>
          <SectionCard title={t('llm.evaluation.form.title')}>
            <form className="assist-form" onSubmit={submit} noValidate aria-label={t('llm.evaluation.form.title')}>
              {forbidden ? <SectionDenied what={t('llm.evaluation.form.set')} /> : null}
              {sets.isError && !forbidden ? <SectionFailed what={t('llm.evaluation.form.set')} onRetry={() => void sets.refetch()} /> : null}
              {!sets.isLoading && !sets.isError && published.length === 0 ? (
                <p className="callout" data-testid="no-published-set">
                  {t('llm.evaluation.form.noSet')}
                </p>
              ) : null}
              <div className="assist-form-grid">
                <Field id="evaluation-set" label={t('llm.evaluation.form.set')} error={problem('CRITERIA_REQUIRED')}>
                  <select id="evaluation-set" value={setId} disabled={sets.isLoading || published.length === 0} aria-invalid={problem('CRITERIA_REQUIRED') !== undefined} aria-describedby={describedBy('evaluation-set', false, problem('CRITERIA_REQUIRED') !== undefined)} onChange={(event) => setSetId(event.target.value)}>
                    <option value="">{sets.isLoading ? t('llm.evaluation.form.loading') : t('llm.evaluation.form.choose')}</option>
                    {published.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {t('llm.evaluation.form.option', { code: entry.code, revision: entry.revision, title: entry.title })}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="evaluation-contract" label={t('llm.evaluation.form.contract')} hint={t('llm.evaluation.form.contractHint')} error={problem('CONTRACT_REQUIRED')}>
                  <input id="evaluation-contract" value={contractId} autoComplete="off" spellCheck={false} aria-invalid={problem('CONTRACT_REQUIRED') !== undefined} aria-describedby={describedBy('evaluation-contract', true, problem('CONTRACT_REQUIRED') !== undefined)} onChange={(event) => setContractId(event.target.value)} />
                </Field>
              </div>
              <SourcePicker sources={extra} onChange={setExtra} legend={t('llm.evaluation.form.more')} hint={t('llm.evaluation.form.moreHint')} />
              {create.isError ? <SubmitFailure error={create.error} /> : null}
              <div className="assist-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={sending || !permit.can(ASSIST_EVALUATE)} data-testid="evaluation-button">
                  {sending ? t('llm.evaluation.form.sending') : t('llm.evaluation.form.submit')}
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
