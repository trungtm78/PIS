import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AppraisalFrame } from './appraisal-components';
import { useSubmitProposal } from './appraisal-hooks';
import { fieldProblemMessage, problemMessage } from './appraisal-labels';
import { DECISION_PATH, EMPTY_PROPOSAL, SCORE_PATH, SUBMIT_PERMISSION, appraisalLink, describeAppraisalProblem, proposalBody, validateProposal } from './appraisal-model';
import type { ProposalForm } from './appraisal-model';
import { Field, SuggestionPanel } from './components';
import { useDefaultProject, useProject } from './hooks';
import { LIST_PATH, amountText } from './model';
import type { ProjectView } from './model';
import './prj.css';

const NEVER_EMPTY = (): boolean => false;

/** PRJ-09: the proposal that sends a project in CONCEPT to appraisal, with the document of the proposal as its ground (F2 step 1). */
export default function ProposalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The project and the form belong to one membership: a switch starts the screen over.
  return <ProposalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProposalContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const namedId = params.get('id') ?? undefined;
  // Opened without a project in the address (the menu), the first project still in concept of the register is shown (the register stays one link away).
  const fallback = useDefaultProject(namedId === undefined, 'CONCEPT');
  const projectId = namedId ?? fallback.project?.id;
  const project = useProject(projectId);
  const state = useScreenState({ isLoading: project.isLoading, error: project.error, data: projectId === undefined ? undefined : (project.data ?? undefined), isEmpty: NEVER_EMPTY });
  const head = project.data === undefined || project.data === null ? undefined : project.data;

  return (
    <AppraisalFrame route={route} title={t('prj.proposal.page.title')} subtitle={t('prj.proposal.page.subtitle')} project={head}>
      {projectId === undefined && fallback.isLoading ? (
        <StateBoundary state="loading" />
      ) : projectId === undefined || (project.isSuccess && project.data === null) ? (
        <p className="callout warning" role="status" data-testid="no-project">
          {t('prj.proposal.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void project.refetch()}>
          {namedId === undefined && head !== undefined ? (
            <p className="callout" role="status" data-testid="default-project">
              {t('prj.proposal.default.notice')} <Link to={LIST_PATH}>{t('prj.score.default.link')}</Link>
            </p>
          ) : null}
          {head === undefined ? null : <Proposal project={head} />}
        </StateBoundary>
      )}
    </AppraisalFrame>
  );
}

function Proposal({ project }: { project: ProjectView }) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const send = useSubmitProposal();
  const [form, setForm] = useState<ProposalForm>(EMPTY_PROPOSAL);
  const [errors, setErrors] = useState<ReturnType<typeof validateProposal>>({});
  const [sent, setSent] = useState(false);
  const frozen = mode === 'READ_ONLY';
  const allowed = permissions === undefined || permissions.includes(SUBMIT_PERMISSION);
  const open = project.status === 'CONCEPT' && !sent;
  const canSend = allowed && !frozen && open;
  const problem = send.isError ? describeAppraisalProblem(send.error) : undefined;
  const none = t('prj.proposal.value.none');

  const setField = (field: keyof ProposalForm, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (send.isPending || !canSend) return;
    const found = validateProposal(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    send.mutate({ id: project.id, version: project.version, body: proposalBody(form) }, { onSuccess: () => setSent(true) });
  };

  const error = (field: keyof ProposalForm): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : fieldProblemMessage(t, found);
  };

  return (
    <div className="prj-grid">
      <form className="card" onSubmit={submit} noValidate aria-label={t('prj.proposal.form.title')}>
        <h2>{t('prj.proposal.form.title')}</h2>
        {sent ? (
          <div data-testid="sent">
            <p role="status">{t('prj.proposal.done.text')}</p>
            <p className="prj-links">
              <Link to={appraisalLink(SCORE_PATH, project.id)}>{t('prj.proposal.done.score.link')}</Link> · <Link to={appraisalLink(DECISION_PATH, project.id)}>{t('prj.proposal.done.decision.link')}</Link>
            </p>
          </div>
        ) : !open ? (
          <p className="callout" role="status" data-testid="not-concept">
            {t('prj.proposal.notConcept.notice')}
          </p>
        ) : !allowed || frozen ? (
          <p className="callout warning" role="status" data-testid="read-only">
            {frozen ? t('prj.proposal.readOnly.frozen.notice') : t('prj.proposal.readOnly.denied.notice')}
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="problem">
            {problemMessage(t, problem)}
          </p>
        )}
        <fieldset disabled={!canSend} className="formgrid">
          <Field id="proposal-reason" label={t('prj.proposal.reason.label')} error={error('reason')} hint={t('prj.proposal.reason.help')}>
            <textarea id="proposal-reason" rows={4} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
          </Field>
          <Field id="proposal-document" label={t('prj.proposal.document.label')} error={error('documentId')} hint={t('prj.proposal.document.help')}>
            <input id="proposal-document" value={form.documentId} aria-invalid={error('documentId') !== undefined} onChange={(event) => setField('documentId', event.target.value)} />
          </Field>
          <Field id="proposal-date" label={t('prj.proposal.date.label')} error={error('effectiveDate')}>
            <input id="proposal-date" type="date" value={form.effectiveDate} aria-invalid={error('effectiveDate') !== undefined} onChange={(event) => setField('effectiveDate', event.target.value)} />
          </Field>
        </fieldset>
        <div className="formfooter">
          <button type="submit" className="button primary" disabled={!canSend || send.isPending}>
            {send.isPending ? t('prj.proposal.submit.pending') : t('prj.proposal.submit.action')}
          </button>
        </div>
      </form>
      <aside className="card" aria-label={t('prj.proposal.summary.title')}>
        <h2>{t('prj.proposal.summary.title')}</h2>
        <dl className="prj-facts" data-testid="summary">
          <dt>{t('prj.proposal.summary.name.label')}</dt>
          <dd>{project.name}</dd>
          <dt>{t('prj.proposal.summary.scale.label')}</dt>
          <dd>{t('prj.proposal.summary.amount.text', { amount: amountText(project.totalInvestmentVnd, locale) })}</dd>
          <dt>{t('prj.proposal.summary.area.label')}</dt>
          <dd>{project.area.label}</dd>
          <dt>{t('prj.proposal.summary.sector.label')}</dt>
          <dd>{project.sector?.label ?? none}</dd>
          <dt>{t('prj.proposal.summary.program.label')}</dt>
          <dd>{project.program?.label ?? none}</dd>
        </dl>
        <h3>{t('prj.proposal.summary.group.title')}</h3>
        <SuggestionPanel suggestion={project.suggestion} />
      </aside>
    </div>
  );
}
