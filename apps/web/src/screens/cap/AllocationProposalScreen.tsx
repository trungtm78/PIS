import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field, Money, OriginBadge } from './components';
import { useAppropriations } from './hooks';
import { levelLabel } from './labels';
import { millionsText, vndOfMillions, vndText } from './model';
import { BackLink, PlanChooser, PlanHeader, SignedMoney, YearLockedBanner, usePlanChoice } from './plan-components';
import { useDraftAllocation, usePlanLines, usePlans, useProjects } from './plan-hooks';
import { bucketLabel, planProblemMessage, proposalProblemMessage } from './plan-labels';
import { ALLOCATION_GRID_PATH, BUCKETS, PLAN_LIST_PATH, EMPTY_PROPOSAL, canDraft, appropriationsFor, defaultBucket, describePlanProblem, differenceVnd, isDraft, proposalBody, validateProposal } from './plan-model';
import type { Bucket, ProposalField, ProposalForm, ProposalProblem } from './plan-model';
import './cap.css';

/**
 * CAP-02: a planner proposes capital for a project from one appropriation of a plan that is still a draft. The amount is typed in millions of
 * dong and sent as exact VND; what the appropriation has left, and what it will have left once the line is saved, is shown as the planner types.
 * Another planner may take the same capital at the same moment: the server decides under a lock, and the refusal says what is available.
 */
export default function AllocationProposalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ProposalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProposalContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const mayDraft = canDraft(permissions, mode);
  const plans = usePlans();
  const drafts = useMemo(() => (plans.data ?? []).filter(isDraft), [plans.data]);
  const { planId, choose } = usePlanChoice(drafts);
  const detail = usePlanLines(planId);
  const book = useAppropriations();
  const projects = useProjects(mayDraft);
  const draft = useDraftAllocation();
  const [form, setForm] = useState<ProposalForm>(EMPTY_PROPOSAL);
  const [errors, setErrors] = useState<Partial<Record<ProposalField, ProposalProblem>>>({});
  const [saved, setSaved] = useState(false);
  const [locked, setLocked] = useState(false);
  const plan = detail.data?.plan;
  const offered = useMemo(() => (plan === undefined ? [] : appropriationsFor(plan, book.data ?? [])), [plan, book.data]);
  const appropriation = offered.find((line) => line.id === form.appropriationId);
  const exact = vndOfMillions(form.amount, locale);
  const state = useScreenState({ isLoading: plans.isLoading || detail.isLoading, error: plans.error ?? detail.error, data: drafts });
  const problem = draft.isError ? describePlanProblem(draft.error) : undefined;
  const writable = mayDraft && !locked;
  const after = appropriation !== undefined && exact !== undefined ? differenceVnd(appropriation.remainingVnd, exact) : undefined;

  const setField = (field: ProposalField, value: string): void => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'appropriationId') next.bucket = defaultBucket(offered.find((line) => line.id === value));
      return next;
    });
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaved(false);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.isPending || !writable || plan === undefined) return;
    const found = validateProposal(form, appropriation, locale);
    setErrors(found);
    if (Object.keys(found).length > 0 || appropriation === undefined) return;
    draft.mutate(
      { planId: plan.id, version: plan.version, body: proposalBody(form, appropriation, locale) },
      {
        onSuccess: () => {
          setSaved(true);
          setForm({ ...EMPTY_PROPOSAL, projectId: form.projectId });
        },
        onError: (error) => setLocked(describePlanProblem(error).reason === 'yearLocked'),
      },
    );
  };
  const message = (field: ProposalField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : proposalProblemMessage(t, found);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={PLAN_LIST_PATH}>{t('cap.back.plans.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.proposal.page.title')}</h1>
          <p>{t('cap.proposal.page.subtitle')}</p>
        </div>
      </div>
      {locked ? <YearLockedBanner /> : null}
      {!mayDraft ? (
        <p className="callout" role="status">
          {mode === 'READ_ONLY' ? t('cap.readOnly.frozen.notice') : t('cap.readOnly.denied.notice')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem">
          {planProblemMessage(t, problem, locale)}
        </p>
      )}
      {saved && plan !== undefined ? (
        <p className="callout" role="status" data-testid="saved">
          {t('cap.proposal.saved.notice')} <Link to={`${ALLOCATION_GRID_PATH}?plan=${plan.id}`}>{t('cap.proposal.saved.link')}</Link>
        </p>
      ) : null}
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        <PlanChooser id="proposal-plan" plans={drafts} value={planId} onChange={choose} />
        {plan === undefined ? null : <PlanHeader plan={plan} />}
        <form className="card cap-form" onSubmit={submit} noValidate aria-label={t('cap.proposal.form.title')}>
          <h2>{t('cap.proposal.form.title')}</h2>
          <fieldset disabled={!writable} className="formgrid">
            <Field id="proposal-project" label={t('cap.proposal.project.label')} error={message('projectId')} hint={projects.isError ? t('cap.proposal.project.unreadable.notice') : undefined}>
              <select id="proposal-project" value={form.projectId} aria-invalid={message('projectId') !== undefined} onChange={(event) => setField('projectId', event.target.value)}>
                <option value="">{t('cap.form.choose.option')}</option>
                {(projects.data ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.code} · {project.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="proposal-source" label={t('cap.proposal.source.label')} error={message('appropriationId')} hint={offered.length === 0 ? t('cap.proposal.source.empty.notice') : undefined}>
              <select id="proposal-source" value={form.appropriationId} aria-invalid={message('appropriationId') !== undefined} onChange={(event) => setField('appropriationId', event.target.value)}>
                <option value="">{t('cap.form.choose.option')}</option>
                {offered.map((line) => (
                  <option key={line.id} value={line.id}>
                    {t('cap.proposal.source.option', { fund: line.fundSource.businessKey, year: line.planYear, remaining: millionsText(line.remainingVnd, locale) })}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="proposal-bucket" label={t('cap.proposal.bucket.label')} error={undefined}>
              <select id="proposal-bucket" value={form.bucket} onChange={(event) => setField('bucket', event.target.value as Bucket)}>
                {BUCKETS.map((bucket) => (
                  <option key={bucket} value={bucket}>
                    {bucketLabel(t, bucket)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="proposal-amount" label={t('cap.proposal.amount.label')} error={message('amount')} hint={t('cap.proposal.amount.hint')}>
              <input id="proposal-amount" inputMode="decimal" value={form.amount} aria-invalid={message('amount') !== undefined} aria-describedby="proposal-exact" onChange={(event) => setField('amount', event.target.value)} />
            </Field>
            <p id="proposal-exact" className="cap-exact" role="status" data-testid="exact-amount">
              {exact === undefined ? t('cap.form.amountExact.empty') : t('cap.form.amountExact.text', { amount: vndText(exact, locale) })}
            </p>
            <Field id="proposal-ctmtqg" label={t('cap.proposal.ctmtqg.label')} error={message('ctmtqg')} hint={t('cap.proposal.ctmtqg.hint')}>
              <input id="proposal-ctmtqg" inputMode="decimal" value={form.ctmtqg} aria-invalid={message('ctmtqg') !== undefined} onChange={(event) => setField('ctmtqg', event.target.value)} />
            </Field>
          </fieldset>
          {appropriation === undefined ? null : (
            <p className="cap-ceiling" role="status" data-testid="ceiling" data-exceeded={after !== undefined && after.startsWith('-') ? 'true' : 'false'}>
              <OriginBadge origin={appropriation.origin} /> {levelLabel(t, appropriation.budgetLevel)} · {t('cap.proposal.remaining.label')} <Money vnd={appropriation.remainingVnd} />
              {after === undefined ? null : (
                <>
                  {' '}
                  · {t('cap.proposal.after.label')} <SignedMoney vnd={after} />
                </>
              )}
            </p>
          )}
          <div className="formfooter">
            <button type="submit" className="button primary" disabled={!writable || draft.isPending || plan === undefined}>
              {draft.isPending ? t('cap.form.submit.pending') : t('cap.proposal.submit.action')}
            </button>
          </div>
        </form>
      </StateBoundary>
      <p className="prototype-note">{t('cap.proposal.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
