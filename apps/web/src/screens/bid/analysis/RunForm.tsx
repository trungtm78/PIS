import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { CriteriaVersion } from '../criteria-model';
import { thresholdText } from '../ocr/model';
import type { OcrListing } from '../ocr/model';
import { endedWithoutAnswer, describeProblem, failureKind, progressPath, startBody, validateForm } from './model';
import type { FormProblem, RunForm as RunFormValue, Started } from './model';
import { failureMessage, formProblemMessage, problemMessage } from './labels';
import '../bid.css';

export interface RunFormProps {
  form: RunFormValue;
  criteria: readonly CriteriaVersion[];
  /** The caller may read the criteria; without it none is offered and nothing can be chosen. */
  mayReadCriteria: boolean;
  /** The gate of the analysis, when it could be read: no page of the proposal waits for a person. */
  gate: OcrListing | undefined;
  /** The caller holds the right to ask for a run and the session is not read-only. */
  allowed: boolean;
  pending: boolean;
  /** What the last attempt answered. */
  started: Started | undefined;
  /** The refusal of the last attempt, when there was one. */
  refusal: unknown;
  onChange(change: Partial<RunFormValue>): void;
  onStart(body: ReturnType<typeof startBody>): void;
}

/** The answer to a request: the run that was made (or the one that stood for the same input), and why it ended without findings when it did. */
function Answer({ started }: { started: Started }) {
  const { t } = useTranslation();
  const kind = endedWithoutAnswer(started.status) ? failureKind(started.failureCode) : undefined;
  return (
    <div className="callout" role="status" data-testid="started">
      <p>{started.reused ? t('bid.analysis.started.reused') : t('bid.analysis.started.made')}</p>
      {kind === undefined ? null : (
        <p className="warning" data-testid="started-failure">
          {failureMessage(t, kind)}
        </p>
      )}
      <Link to={progressPath(started.runId)}>{t('bid.analysis.started.open')}</Link>
    </div>
  );
}

/**
 * BID-07: what a run is asked with (ST-BID-009). The proposal, the criteria in force and the profile of the task are chosen; the class of the data and the routes it may take are the server's, and are shown, not asked.
 * The request does not go while a page of the proposal waits for a person. One attempt stands for one request, so a retry after a lost answer is the same request.
 */
export function RunForm({ form, criteria, mayReadCriteria, gate, allowed, pending, started, refusal, onChange, onStart }: RunFormProps) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<FormProblem | undefined>(undefined);
  const blocked = gate !== undefined && !gate.financialReady;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateForm(form);
    setProblem(found);
    if (found === undefined && !pending && !blocked) onStart(startBody(form));
  };
  const fieldError = (field: FormProblem) =>
    problem === field ? (
      <small role="alert" className="field-error">
        {formProblemMessage(t, field)}
      </small>
    ) : null;
  return (
    <form className="card" onSubmit={submit} noValidate data-testid="run-form">
      <h2>{t('bid.analysis.form.heading')}</h2>
      {fieldError('proposal')}
      <div className="field">
        <label htmlFor="analysis-criteria">{t('bid.analysis.criteria.label')}</label>
        <select id="analysis-criteria" value={form.criteriaVersionId} disabled={!allowed || pending} onChange={(event) => onChange({ criteriaVersionId: event.target.value })}>
          <option value="">{t('bid.analysis.criteria.choose')}</option>
          {criteria.map((version) => (
            <option key={version.id} value={version.id}>
              {t('bid.analysis.criteria.option', { revision: version.revision, count: version.criteria.length })}
            </option>
          ))}
        </select>
        {mayReadCriteria ? (
          criteria.length === 0 ? (
            <small className="sub" data-testid="no-criteria">
              {t('bid.analysis.criteria.none')}
            </small>
          ) : null
        ) : (
          <small className="sub" data-testid="criteria-hidden">
            {t('bid.analysis.criteria.hidden')}
          </small>
        )}
        {fieldError('criteria')}
      </div>
      <div className="field">
        <label htmlFor="analysis-profile">{t('bid.analysis.profile.label')}</label>
        <input id="analysis-profile" autoComplete="off" spellCheck={false} readOnly={!allowed || pending} value={form.profileVersionId} onChange={(event) => onChange({ profileVersionId: event.target.value })} />
        <small className="sub">{t('bid.analysis.profile.hint')}</small>
        {fieldError('profile')}
      </div>
      <div className="field">
        <label htmlFor="analysis-cost">{t('bid.analysis.cost.label')}</label>
        <input id="analysis-cost" inputMode="numeric" autoComplete="off" readOnly={!allowed || pending} value={form.maxCostVnd} onChange={(event) => onChange({ maxCostVnd: event.target.value })} />
        <small className="sub">{t('bid.analysis.cost.hint')}</small>
        {fieldError('cost')}
      </div>
      <dl className="bid-facts" data-testid="routing">
        <dt>{t('bid.analysis.classification.label')}</dt>
        <dd>{t('bid.analysis.classification.value')}</dd>
        <dt>{t('bid.analysis.routes.label')}</dt>
        <dd>{t('bid.analysis.routes.value')}</dd>
      </dl>
      {gate === undefined ? (
        <p className="callout" role="status" data-testid="gate-unknown">
          {t('bid.analysis.gate.unknown')}
        </p>
      ) : blocked ? (
        <p className="callout warning" role="status" data-testid="gate-blocked">
          {t('bid.analysis.gate.blocked', { count: gate.blockedPages, threshold: thresholdText(gate.threshold) })}
        </p>
      ) : (
        <p className="callout" role="status" data-testid="gate-ready">
          {t('bid.analysis.gate.ready')}
        </p>
      )}
      {refusal === undefined || refusal === null ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(refusal))}
        </p>
      )}
      {started === undefined ? null : <Answer started={started} />}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={!allowed || pending || blocked}>
          {pending ? t('bid.analysis.start.pending') : t('bid.analysis.start.action')}
        </button>
      </div>
    </form>
  );
}
