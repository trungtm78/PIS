import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AppraisalFrame, AppraisalLinks, CriteriaBasis } from './appraisal-components';
import { useAppraisal, useDecide } from './appraisal-hooks';
import { fieldProblemMessage, problemMessage, recommendationLabel, sheetStatusLabel } from './appraisal-labels';
import { DECIDE_PERMISSION, EMPTY_DECISION, PROJECT_GROUPS, RECOMMENDATIONS, decisionBody, describeAppraisalProblem, needsOverride, validateDecisionForm } from './appraisal-model';
import type { AppraisalView, DecisionField, DecisionForm, ProjectGroup, Recommendation } from './appraisal-model';
import { Field } from './components';
import { useDefaultProject } from './hooks';
import { stageLabel } from './labels';
import { LIST_PATH } from './model';
import { BOARD_PATH } from './pipeline-model';
import './prj.css';

const NEVER_EMPTY = (): boolean => false;

/** PRJ-10: a decision maker sees the sheets of the round and decides: admit to the project bank with a group and the document, reject, or return. */
export default function AppraisalDecisionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The decision belongs to one membership: a switch starts the screen over.
  return <DecisionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DecisionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const namedId = params.get('id') ?? undefined;
  // Opened without a project in the address (the menu), the first project in appraisal of the register is shown (the register stays one link away).
  const fallback = useDefaultProject(namedId === undefined, 'APPRAISAL');
  const projectId = namedId ?? fallback.project?.id;
  const view = useAppraisal(projectId);
  const state = useScreenState({ isLoading: view.isLoading, error: view.error, data: projectId === undefined ? undefined : (view.data ?? undefined), isEmpty: NEVER_EMPTY });
  const head = view.data === undefined || view.data === null ? undefined : { id: view.data.projectId, code: view.data.code, status: view.data.status };

  return (
    <AppraisalFrame route={route} title={t('prj.decision.page.title')} subtitle={t('prj.decision.page.subtitle')} project={head}>
      {projectId === undefined && fallback.isLoading ? (
        <StateBoundary state="loading" />
      ) : projectId === undefined || (view.isSuccess && view.data === null) ? (
        <p className="callout warning" role="status" data-testid="no-project">
          {t('prj.decision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void view.refetch()}>
          {namedId === undefined && view.data !== undefined && view.data !== null ? (
            <p className="callout" role="status" data-testid="default-project">
              {t('prj.decision.default.notice')} <Link to={LIST_PATH}>{t('prj.score.default.link')}</Link>
            </p>
          ) : null}
          {view.data === undefined || view.data === null ? null : <Decision view={view.data} />}
        </StateBoundary>
      )}
    </AppraisalFrame>
  );
}

function Decision({ view }: { view: AppraisalView }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const allowed = permissions === undefined || permissions.includes(DECIDE_PERMISSION);
  // Once decided, the project leaves the appraisal and the read changes under the form: the notice of the decision belongs to the screen, not to the form.
  const [done, setDone] = useState<Recommendation | undefined>(undefined);
  return (
    <>
      {!view.hasAppraisal || !allowed ? (
        <p className="callout warning" role="status" data-testid="denied">
          {t('prj.decision.denied.notice')}
        </p>
      ) : (
        <>
          <Sheets view={view} />
          {done !== undefined ? (
            <div className="card" data-testid="decided">
              <p role="status">{t('prj.decision.done.text', { decision: recommendationLabel(t, done) })}</p>
              <p className="prj-links">
                <Link to={BOARD_PATH}>{t('prj.decision.done.board.link')}</Link>
              </p>
            </div>
          ) : view.status !== 'APPRAISAL' ? (
            <p className="callout" role="status" data-testid="not-appraisal">
              {t('prj.decision.notAppraisal.notice', { stage: stageLabel(t, view.status) })}
            </p>
          ) : view.viewerIsProposer ? (
            <p className="callout warning" role="status" data-testid="proposer">
              {t('prj.decision.proposer.notice')}
            </p>
          ) : view.decisionTarget === null ? (
            <p className="callout" role="status" data-testid="no-sheets">
              {t('prj.decision.noSheets.notice')}
            </p>
          ) : frozen ? (
            <p className="callout warning" role="status" data-testid="read-only">
              {t('prj.decision.readOnly.frozen.notice')}
            </p>
          ) : (
            <DecisionPanel view={view} target={view.decisionTarget} onDone={setDone} />
          )}
        </>
      )}
      <AppraisalLinks projectId={view.projectId} current="decision" />
    </>
  );
}

function Sheets({ view }: { view: AppraisalView }) {
  const { t } = useTranslation();
  const { summary, criteriaSet } = view;
  return (
    <div className="prj-grid">
      <article className="card" aria-label={t('prj.decision.sheets.title')}>
        <h2>{t('prj.decision.sheets.title')}</h2>
        {view.sheets.length === 0 ? (
          <p className="sub" data-testid="no-sheets-list">
            {t('prj.decision.sheets.empty')}
          </p>
        ) : (
          <table className="data" data-testid="sheets">
            <caption>{t('prj.decision.sheets.caption', { round: view.round ?? 1 })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('prj.decision.sheets.appraiser.header')}</th>
                <th scope="col">{t('prj.decision.sheets.total.header')}</th>
                <th scope="col">{t('prj.decision.sheets.recommendation.header')}</th>
                <th scope="col">{t('prj.decision.sheets.status.header')}</th>
                <th scope="col">{t('prj.decision.sheets.note.header')}</th>
              </tr>
            </thead>
            <tbody>
              {view.sheets.map((sheet) => (
                <tr key={sheet.id} data-sheet={sheet.id}>
                  <th scope="row">{sheet.appraiserName ?? t('prj.decision.sheets.unknown')}</th>
                  <td>{sheet.totalScore}</td>
                  <td>{recommendationLabel(t, sheet.recommendation)}</td>
                  <td>{sheetStatusLabel(t, sheet.status)}</td>
                  <td>{sheet.note ?? t('prj.decision.sheets.noNote')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
      <aside className="card" aria-label={t('prj.decision.summary.title')}>
        <h2>{t('prj.decision.summary.title')}</h2>
        {summary === null || summary.meanScore === null ? (
          <p className="sub" data-testid="no-summary">
            {t('prj.decision.summary.none')}
          </p>
        ) : (
          <dl className="prj-facts" data-testid="summary">
            <dt>{t('prj.decision.summary.count.label')}</dt>
            <dd>{summary.sheetCount}</dd>
            <dt>{t('prj.decision.summary.mean.label')}</dt>
            <dd data-testid="mean">{summary.meanScore}</dd>
            <dt>{t('prj.decision.summary.threshold.label')}</dt>
            <dd data-testid="threshold-recommendation">
              {summary.thresholdRecommendation === null ? t('prj.decision.summary.none') : recommendationLabel(t, summary.thresholdRecommendation)}
            </dd>
          </dl>
        )}
        {criteriaSet === null ? null : <CriteriaBasis set={criteriaSet} />}
      </aside>
    </div>
  );
}

function DecisionPanel({ view, target, onDone }: { view: AppraisalView; target: { id: string; version: number }; onDone: (decision: Recommendation) => void }) {
  const { t } = useTranslation();
  const decide = useDecide();
  const [form, setForm] = useState<DecisionForm>(EMPTY_DECISION);
  const [errors, setErrors] = useState<Partial<Record<DecisionField, ReturnType<typeof validateDecisionForm>[DecisionField]>>>({});
  const problem = decide.isError ? describeAppraisalProblem(decide.error) : undefined;
  const override = needsOverride(view, form.decision);

  const setField = <K extends DecisionField>(field: K, value: DecisionForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (decide.isPending) return;
    const found = validateDecisionForm(view, form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    decide.mutate({ sheetId: target.id, sheetVersion: target.version, body: decisionBody(view, form) }, { onSuccess: () => onDone(form.decision as Recommendation) });
  };

  const error = (field: DecisionField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : fieldProblemMessage(t, found);
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('prj.decision.form.title')}>
      <h2>{t('prj.decision.form.title')}</h2>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem">
          {problemMessage(t, problem)}
        </p>
      )}
      <fieldset className="prj-moves">
        <legend>{t('prj.decision.choose.label')}</legend>
        {RECOMMENDATIONS.map((decision) => (
          <label key={decision} className="check" data-decision={decision}>
            <input type="radio" name="decision" value={decision} checked={form.decision === decision} onChange={() => setField('decision', decision)} />
            {recommendationLabel(t, decision)}
            {view.summary?.overrideRequired?.[decision] === true ? <span className="prj-badge warning"> {t('prj.decision.override.badge')}</span> : null}
          </label>
        ))}
        {error('decision') === undefined ? null : (
          <small role="alert" className="field-error">
            {error('decision')}
          </small>
        )}
      </fieldset>
      <fieldset className="formgrid">
        <Field id="decision-reason" label={t('prj.decision.reason.label')} error={error('reason')}>
          <textarea id="decision-reason" rows={3} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
        </Field>
        <Field id="decision-document" label={t('prj.decision.document.label')} error={error('documentId')} hint={t('prj.decision.document.help')}>
          <input id="decision-document" value={form.documentId} aria-invalid={error('documentId') !== undefined} onChange={(event) => setField('documentId', event.target.value)} />
        </Field>
        {form.decision === 'ADMIT' ? (
          <Field id="decision-group" label={t('prj.decision.group.label')} error={error('projectGroup')} hint={t('prj.decision.group.help')}>
            <select id="decision-group" value={form.projectGroup} aria-invalid={error('projectGroup') !== undefined} onChange={(event) => setField('projectGroup', event.target.value as ProjectGroup | '')}>
              <option value="">{t('prj.decision.group.choose')}</option>
              {PROJECT_GROUPS.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {override ? (
          <Field id="decision-override" label={t('prj.decision.overrideReason.label')} error={error('overrideReason')} hint={t('prj.decision.overrideReason.help')}>
            <textarea id="decision-override" rows={3} value={form.overrideReason} aria-invalid={error('overrideReason') !== undefined} onChange={(event) => setField('overrideReason', event.target.value)} />
          </Field>
        ) : null}
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={decide.isPending}>
          {decide.isPending ? t('prj.decision.submit.pending') : t('prj.decision.submit.action')}
        </button>
      </div>
    </form>
  );
}
