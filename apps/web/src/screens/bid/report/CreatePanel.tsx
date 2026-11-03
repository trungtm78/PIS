import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { wireControl } from '../../field-wiring';
import { Field } from '../components';
import { useCreateReport } from './hooks';
import { formProblemMessage, problemMessage } from './labels';
import { MAX_CONCLUSION, MIN_CONCLUSION, createBody, describeProblem, emptyCreate, reviewRunPath, unreviewedCount, validateCreate, withRun, withoutRun } from './model';
import type { Candidate, CreateForm } from './model';
import './report.css';
import '../bid.css';

export interface CreatePanelProps {
  packageId: string;
  packageCode: string;
  criteriaVersionId: string;
  candidates: readonly Candidate[];
}

/**
 * The draft of the evaluation report (BID-13): the proposals whose analyses it covers, each with how far the experts have decided its findings, and the conclusion of the team in its own words. The rest of
 * the minutes is taken from what the experts decided, never from what the model said. The server judges everything again; a refusal is shown in words and what was typed stays.
 */
export function CreatePanel({ packageId, packageCode, criteriaVersionId, candidates }: CreatePanelProps) {
  const { t } = useTranslation();
  const ids = { conclusion: useId(), runs: useId() };
  const create = useCreateReport();
  const [form, setForm] = useState<CreateForm>(emptyCreate());
  const [submitted, setSubmitted] = useState(false);
  const problems = validateCreate(form, candidates);
  const pending = create.isPending;
  const conclusionProblem = submitted && problems.conclusion !== undefined ? formProblemMessage(t, problems.conclusion) : undefined;
  const runsProblem = submitted && problems.runs !== undefined ? formProblemMessage(t, problems.runs) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (pending || Object.keys(problems).length > 0) return;
    create.mutate(createBody(packageId, criteriaVersionId, form, candidates), {
      onSuccess: () => {
        setForm(emptyCreate());
        setSubmitted(false);
      },
    });
  };
  const refusal = create.isError ? describeProblem(create.error) : undefined;
  const undecided = candidates.filter((candidate) => candidate.decidedCount < candidate.criteriaCount);

  return (
    <div className="card" data-testid="create-panel">
      <h2>{t('bid.report.create.title', { code: packageCode })}</h2>
      {candidates.length === 0 ? (
        <p className="callout" role="status" data-testid="no-candidates">
          {t('bid.report.create.noCandidates')}
        </p>
      ) : (
        <form onSubmit={submit} noValidate data-testid="create-form">
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="create-refusal">
              {problemMessage(t, refusal, unreviewedCount(create.error))}
            </p>
          )}
          {create.isSuccess ? (
            <p className="callout" role="status" data-testid="created">
              {t('bid.report.create.created')}
            </p>
          ) : null}
          <fieldset className="bid-report-runs" aria-describedby={runsProblem === undefined ? undefined : ids.runs}>
            <legend>{t('bid.report.create.runs.legend')}</legend>
            {candidates.map((candidate) => (
              <label key={candidate.runId} className="bid-report-run">
                <input
                  type="checkbox"
                  checked={!form.taken.includes(candidate.runId)}
                  disabled={pending}
                  onChange={(event) => setForm({ ...form, taken: event.target.checked ? withoutRun(form.taken, candidate.runId) : withRun(form.taken, candidate.runId) })}
                />{' '}
                {t('bid.report.create.runs.item', { name: candidate.contractorName, decided: candidate.decidedCount, total: candidate.criteriaCount })}
              </label>
            ))}
            {runsProblem === undefined ? null : (
              <small role="alert" className="field-error" id={ids.runs}>
                {runsProblem}
              </small>
            )}
          </fieldset>
          {undecided.length === 0 ? null : (
            <p className="callout warning" role="note" data-testid="undecided-note">
              {t('bid.report.create.undecided')}{' '}
              {undecided.map((candidate) => (
                <Link key={candidate.runId} to={reviewRunPath(candidate.runId)} data-testid={`review-link-${candidate.runId}`} className="bid-report-link">
                  {t('bid.report.create.undecided.link', { name: candidate.contractorName })}
                </Link>
              ))}
            </p>
          )}
          <Field id={ids.conclusion} label={t('bid.report.create.conclusion.label')} error={conclusionProblem} hint={t('bid.report.create.conclusion.hint')}>
            {wireControl(<textarea id={ids.conclusion} rows={6} readOnly={pending} value={form.conclusion} onChange={(event) => setForm({ ...form, conclusion: event.target.value })} />, ids.conclusion, {
              hint: false,
              error: conclusionProblem !== undefined,
            })}
            <small className="sub" data-testid="conclusion-count">
              {t('bid.report.create.conclusion.count', { count: form.conclusion.trim().length, min: MIN_CONCLUSION, max: MAX_CONCLUSION })}
            </small>
          </Field>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={pending}>
              {pending ? t('bid.report.create.pending') : t('bid.report.create.submit')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
