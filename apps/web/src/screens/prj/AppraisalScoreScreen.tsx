import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AppraisalFrame, AppraisalLinks, CriteriaBasis } from './appraisal-components';
import { useAppraisal, useRecordSheet } from './appraisal-hooks';
import { fieldProblemMessage, problemMessage, recommendationLabel, sheetStatusLabel } from './appraisal-labels';
import { APPRAISE_PERMISSION, EMPTY_SCORE_FORM, RECOMMENDATIONS, SCORE_VALUES, describeAppraisalProblem, formOfSheet, ownSheet, previewTotal, scoreBody, validateScoreForm } from './appraisal-model';
import type { AppraisalView, CriteriaSet, Recommendation, ScoreField, ScoreForm, Sheet } from './appraisal-model';
import { Field } from './components';
import { useDefaultProject } from './hooks';
import { LIST_PATH } from './model';
import './prj.css';

const NEVER_EMPTY = (): boolean => false;

/** PRJ-15: an appraiser scores the project against the set of criteria in force; the total on the sheet is the server's, the one on the grid is only a preview. */
export default function AppraisalScoreScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The sheet belongs to one membership: a switch starts the screen over.
  return <ScoreContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScoreContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const namedId = params.get('id') ?? undefined;
  // Opened without a project in the address, the first project in appraisal of the register is scored (the register stays one link away).
  const fallback = useDefaultProject(namedId === undefined, 'APPRAISAL');
  const projectId = namedId ?? fallback.project?.id;
  const view = useAppraisal(projectId);
  const state = useScreenState({ isLoading: view.isLoading, error: view.error, data: projectId === undefined ? undefined : (view.data ?? undefined), isEmpty: NEVER_EMPTY });
  const head = view.data === undefined || view.data === null ? undefined : { id: view.data.projectId, code: view.data.code, status: view.data.status };

  return (
    <AppraisalFrame route={route} title={t('prj.score.page.title')} subtitle={t('prj.score.page.subtitle')} project={head}>
      {projectId === undefined && fallback.isLoading ? (
        <StateBoundary state="loading" />
      ) : projectId === undefined || (view.isSuccess && view.data === null) ? (
        <p className="callout warning" role="status" data-testid="no-project">
          {t('prj.score.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void view.refetch()}>
          {namedId === undefined && view.data !== undefined && view.data !== null ? (
            <p className="callout" role="status" data-testid="default-project">
              {t(view.data.status === 'APPRAISAL' ? 'prj.score.default.notice' : 'prj.score.default.fallback.notice')} <Link to={LIST_PATH}>{t('prj.score.default.link')}</Link>
            </p>
          ) : null}
          {view.data === undefined || view.data === null ? null : <Scoring view={view.data} />}
        </StateBoundary>
      )}
    </AppraisalFrame>
  );
}

function Scoring({ view }: { view: AppraisalView }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const allowed = permissions === undefined || permissions.includes(APPRAISE_PERMISSION);
  const own = ownSheet(view);
  // The sheet that was just recorded makes the form start over from the stored sheet; the notice of the save belongs to the screen, not to the form.
  const [saved, setSaved] = useState(false);
  return (
    <>
      {view.status !== 'APPRAISAL' ? (
        <p className="callout" role="status" data-testid="not-appraisal">
          {t('prj.score.notAppraisal.notice')}
        </p>
      ) : !view.hasAppraisal || !allowed ? (
        <p className="callout warning" role="status" data-testid="denied">
          {t('prj.score.denied.notice')}
        </p>
      ) : view.viewerIsProposer ? (
        <p className="callout warning" role="status" data-testid="proposer">
          {t('prj.score.proposer.notice')}
        </p>
      ) : view.criteriaSet === null ? (
        <p className="callout warning" role="status" data-testid="no-set">
          {t('prj.score.noSet.notice')}
        </p>
      ) : frozen ? (
        <p className="callout warning" role="status" data-testid="read-only">
          {t('prj.score.readOnly.frozen.notice')}
        </p>
      ) : (
        // A new version of the own sheet (a save) starts the form over from what is stored.
        <ScoreGrid key={own === undefined ? 'new' : `${own.id}:${own.version}`} view={view} set={view.criteriaSet} own={own} saved={saved} onSaved={setSaved} />
      )}
      <AppraisalLinks projectId={view.projectId} current="score" />
    </>
  );
}

function ScoreGrid({ view, set, own, saved, onSaved }: { view: AppraisalView; set: CriteriaSet; own: Sheet | undefined; saved: boolean; onSaved: (saved: boolean) => void }) {
  const { t } = useTranslation();
  const record = useRecordSheet();
  const [form, setForm] = useState<ScoreForm>(() => (own === undefined ? EMPTY_SCORE_FORM : formOfSheet(own)));
  const [errors, setErrors] = useState<Partial<Record<ScoreField, ReturnType<typeof validateScoreForm>[ScoreField]>>>({});
  const problem = record.isError ? describeAppraisalProblem(record.error) : undefined;
  const preview = previewTotal(set.criteria, form.scores);

  const change = (update: (current: ScoreForm) => ScoreForm, field?: ScoreField): void => {
    setForm(update);
    if (field !== undefined) setErrors((current) => ({ ...current, [field]: undefined }));
    onSaved(false);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (record.isPending) return;
    const found = validateScoreForm(set.criteria, form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    record.mutate({ id: view.projectId, body: scoreBody(set, form) }, { onSuccess: () => onSaved(true) });
  };

  const error = (field: ScoreField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : fieldProblemMessage(t, found);
  };

  return (
    <div className="prj-grid">
      <form className="card" onSubmit={submit} noValidate aria-label={t('prj.score.form.title')}>
        <h2>{t('prj.score.form.title')}</h2>
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="problem">
            {problemMessage(t, problem)}
          </p>
        )}
        {saved ? (
          <p role="status" data-testid="saved">
            {t('prj.score.saved.notice')}
          </p>
        ) : null}
        {error('scores') === undefined ? null : (
          <p className="field-error" role="alert" data-testid="scores-error">
            {error('scores')}
          </p>
        )}
        <table className="data" data-testid="grid">
          <caption>{t('prj.score.grid.caption', { round: view.round ?? 1 })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('prj.score.grid.criterion.header')}</th>
              <th scope="col">{t('prj.score.grid.weight.header')}</th>
              <th scope="col">{t('prj.score.grid.score.header')}</th>
              <th scope="col">{t('prj.score.grid.evidence.header')}</th>
            </tr>
          </thead>
          <tbody>
            {set.criteria.map((criterion) => (
              <tr key={criterion.code} data-criterion={criterion.code}>
                <th scope="row">{criterion.name}</th>
                <td>{criterion.weight}</td>
                <td>
                  <div role="radiogroup" className="prj-segments" aria-label={t('prj.score.grid.score.aria', { criterion: criterion.name })}>
                    {SCORE_VALUES.map((value) => (
                      <label key={value} className="prj-segment">
                        <input
                          type="radio"
                          name={`score-${criterion.code}`}
                          value={String(value)}
                          checked={form.scores[criterion.code] === String(value)}
                          aria-label={t('prj.score.grid.option.aria', { score: value, criterion: criterion.name })}
                          onChange={() => change((current) => ({ ...current, scores: { ...current.scores, [criterion.code]: String(value) } }), 'scores')}
                        />
                        <span aria-hidden="true">{value}</span>
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <input
                    value={form.evidence[criterion.code] ?? ''}
                    aria-label={t('prj.score.grid.evidence.aria', { criterion: criterion.name })}
                    placeholder={t('prj.score.grid.evidence.placeholder')}
                    onChange={(event) => change((current) => ({ ...current, evidence: { ...current.evidence, [criterion.code]: event.target.value } }), 'evidence')}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                {t('prj.score.total.label')}
              </th>
              <td colSpan={2} data-testid="total">
                {preview === null ? t('prj.score.total.none') : t('prj.score.total.preview', { total: preview })}
              </td>
            </tr>
          </tfoot>
        </table>
        {error('evidence') === undefined ? null : (
          <p className="field-error" role="alert">
            {error('evidence')}
          </p>
        )}
        <div className="formgrid">
          <Field id="score-recommendation" label={t('prj.score.recommendation.label')} error={error('recommendation')}>
            <select
              id="score-recommendation"
              value={form.recommendation}
              aria-invalid={error('recommendation') !== undefined}
              onChange={(event) => change((current) => ({ ...current, recommendation: event.target.value as Recommendation | '' }), 'recommendation')}
            >
              <option value="">{t('prj.score.recommendation.choose')}</option>
              {RECOMMENDATIONS.map((recommendation) => (
                <option key={recommendation} value={recommendation}>
                  {recommendationLabel(t, recommendation)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="score-note" label={t('prj.score.note.label')} error={error('note')}>
            <textarea id="score-note" rows={3} value={form.note} aria-invalid={error('note') !== undefined} onChange={(event) => change((current) => ({ ...current, note: event.target.value }), 'note')} />
          </Field>
        </div>
        <div className="formfooter">
          <button type="submit" className="button primary" disabled={record.isPending}>
            {record.isPending ? t('prj.score.submit.pending') : own === undefined ? t('prj.score.submit.action') : t('prj.score.resubmit.action')}
          </button>
        </div>
      </form>
      <aside className="card" aria-label={t('prj.score.set.title')}>
        <h2>{t('prj.score.set.title')}</h2>
        <CriteriaBasis set={set} />
        {own === undefined ? (
          <p className="sub" data-testid="no-own-sheet">
            {t('prj.score.own.none')}
          </p>
        ) : (
          <p data-testid="own-sheet">{t('prj.score.own.text', { total: own.totalScore, status: sheetStatusLabel(t, own.status), recommendation: recommendationLabel(t, own.recommendation) })}</p>
        )}
      </aside>
    </div>
  );
}
