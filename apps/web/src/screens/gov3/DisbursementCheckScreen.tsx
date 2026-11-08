import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard, StatusPill } from '../../ui';
import { useDisbursementCheck } from './hooks';
import { dayText, idFrom, vnd } from './model';
import type { DisbursementCheck } from './model';
import './gov3.css';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The cause of a refusal in words; each key is written out so the i18n check can see it is in use. */
const causeText = (t: Translate, check: DisbursementCheck, amount: string): string =>
  check.refusal === 'DISBURSEMENT_PROJECT_NOT_LISTED'
    ? t('govb1.pay.cause.notListed', { stage: check.cause.projectStatus })
    : check.refusal === 'DISBURSEMENT_NO_APPROVED_PLAN'
      ? t('govb1.pay.cause.noPlan', { amount })
      : t('govb1.pay.cause.unknown');

/**
 * PAY-19: the precondition of a disbursement (governance deepening G1-2; Decree 85/2025 Article 53). A payment is built and sent only for a project that is on the list of the investment projects and that holds an
 * approved amount in the capital plan on the system. This screen tells a person before a request is filled: the verdict, the cause (the stage of the project, or the approved amount the system holds), the
 * way to fix it with the screen to fix it on, and the warning that a request to appraise the project again is open (the payment is not stopped by it). The number on the system wins over paper.
 */
export default function DisbursementCheckScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DisbursementContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DisbursementContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const [params] = useSearchParams();
  const projectId = idFrom(params.get('project'));
  const check = useDisbursementCheck(projectId);
  const state = useScreenState({ isLoading: check.isLoading, error: check.error, data: check.data, isEmpty: () => false });
  const view = check.data ?? undefined;
  const amount = view === undefined ? '' : vnd(view.cause.allocatedVnd, locale);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govb1.pay.title')}</h1>
          <p>{t('govb1.pay.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[{ label: t('govb1.ctx.scope'), value: tenant?.name ?? t('govb1.ctx.scope.all') }, ...(view === undefined ? [] : [{ label: t('govb1.ctx.project'), value: view.projectCode }])]}
        unit={t('govb1.common.unit')}
        {...(view === undefined ? {} : { asOf: dayText(view.asOf) })}
      />
      {projectId === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('govb1.pay.noTarget')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void check.refetch()}>
          {view === undefined ? (
            <p className="callout" data-testid="missing">
              {t('govb1.pay.missing')}
            </p>
          ) : (
            <>
              <SectionCard title={t('govb1.pay.verdict.title', { code: view.projectCode })} unit={t('govb1.common.unit')}>
                <p className="gov3-verdict" data-testid="verdict" data-allowed={view.allowed ? 'yes' : 'no'}>
                  <StatusPill tone={view.allowed ? 'success' : 'danger'}>{view.allowed ? t('govb1.pay.allowed') : t('govb1.pay.refused')}</StatusPill>
                  <span>{view.allowed ? t('govb1.pay.allowed.text') : t('govb1.pay.refused.text')}</span>
                </p>
                <dl className="gov3-facts" data-testid="facts">
                  <dt>{t('govb1.pay.fact.stage')}</dt>
                  <dd>
                    <StatusPill tone="neutral">{view.cause.projectStatus}</StatusPill>
                  </dd>
                  <dt>{t('govb1.pay.fact.amount')}</dt>
                  <dd>{amount}</dd>
                  <dt>{t('govb1.pay.fact.policy')}</dt>
                  <dd>{t('govb1.pay.fact.policy.value', { version: view.policyVersion })}</dd>
                </dl>
              </SectionCard>

              {view.allowed ? null : (
                <SectionCard title={t('govb1.pay.fix.title')}>
                  <p data-testid="cause" role="status">
                    <strong>{t('govb1.pay.cause.label')}</strong> {causeText(t, view, amount)}
                  </p>
                  {view.fix === 'COMPLETE_STAGE_TRANSITION' ? (
                    <p data-testid="fix" data-fix="COMPLETE_STAGE_TRANSITION">
                      {t('govb1.pay.fix.stage')}{' '}
                      <Link to={`/prj/prj-03?id=${view.projectId}`} data-testid="fix-project">
                        {t('govb1.pay.fix.stage.link')}
                      </Link>
                    </p>
                  ) : null}
                  {view.fix === 'ENTER_APPROVED_PLAN' ? (
                    <p data-testid="fix" data-fix="ENTER_APPROVED_PLAN">
                      {t('govb1.pay.fix.plan')}{' '}
                      <Link to="/cap/cap-06" data-testid="fix-plan">
                        {t('govb1.pay.fix.plan.link')}
                      </Link>{' '}
                      <Link to="/cap/cap-03" data-testid="fix-annual">
                        {t('govb1.pay.fix.annual.link')}
                      </Link>
                    </p>
                  ) : null}
                </SectionCard>
              )}

              {view.warnings.includes('REAPPRAISAL_OPEN') ? (
                <p className="callout" role="status" data-testid="warning-reappraisal">
                  {t('govb1.pay.warning.reappraisal')}{' '}
                  <Link to={`/prj/prj-26?project=${view.projectId}`} data-testid="link-baseline">
                    {t('govb1.pay.warning.reappraisal.link')}
                  </Link>
                </p>
              ) : null}
              <p className="muted" data-testid="paper-note">
                {t('govb1.pay.paper')}
              </p>
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('govb1.pay.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
