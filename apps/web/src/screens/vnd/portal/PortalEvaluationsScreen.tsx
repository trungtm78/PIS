import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { dayText, vietnamStamp } from '../shared/vnd-model';
import { CountInfo, Empty, PartialNotice, ReceiptNote, StaleNotice, useReceipt, useWriter } from '../shared/vnd-ui';
import { ActionDoneDialog, AgreePlanDialog, AnswerRequestDialog } from './portal-dialogs';
import { usePortalEvaluations, usePortalPlans, usePortalRequests } from './portal-hooks';
import { actionStatusLabel, planStatusLabel, ratingLabel } from './portal-labels';
import { PORTAL_PERMISSION, actionIcon, actionTone, actionsOwed, planIcon, planTone, ratingIcon, ratingTone, responseRequestOf } from './portal-model';
import type { PortalAction, PortalEvaluation, PortalPlan, PortalRequest } from './portal-model';
import { PortalBoundary, PortalLayout } from './portal-ui';

type Dialog = { kind: 'answer'; request: PortalRequest } | { kind: 'agree'; plan: PortalPlan } | { kind: 'done'; action: PortalAction };

/**
 * VND-19, the evaluations of the contractor's performance (approved ones only, its own) and its plans of remediation. The contractor answers an evaluation through the request that asks for it, agrees to a plan proposed
 * to it, and reports each action of the plan as done; staff verify the actions.
 */
export default function PortalEvaluationsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Evaluations key={scope} route={route} />;
}

function Evaluations({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const evaluations = usePortalEvaluations();
  const plans = usePortalPlans();
  const requests = usePortalRequests('OPEN');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const list = evaluations.data;
  const state: ScreenState = useScreenState({ isLoading: evaluations.isLoading, error: list === undefined ? evaluations.error : undefined, data: list, isEmpty: () => false });
  const refreshFailed = evaluations.isError && list !== undefined;
  const open = requests.data?.items ?? [];
  const canAnswer = !writer.readOnly && writer.can(PORTAL_PERMISSION.respond);
  const canWork = !writer.readOnly && writer.can(PORTAL_PERMISSION.remediation);
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return (
    <PortalLayout route={route} active="VND-19" title={t('vnp.evaluations.page.title')} subtitle={t('vnp.evaluations.page.subtitle')} asOf={list?.as_of} stale={refreshFailed}>
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void evaluations.refetch()} />}
      <PortalBoundary state={state} onRetry={() => void evaluations.refetch()}>
        {list !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnp.evaluations.section.title')}>
              {list.items.length === 0 ? (
                <Empty text={t('vnp.evaluations.empty.text')} testId="evaluations-empty" />
              ) : (
                <>
                <p className="vnd-note vnd-row">
                  <span>{t('vnp.evaluations.score.note')}</span>
                  <CountInfo name={t('vnp.evaluations.column.score')} formula={t('vnp.evaluations.score.formula')} source={t('vnp.evaluations.score.source')} asOf={list.as_of} unverified />
                </p>
                <DataTable<PortalEvaluation>
                  caption={t('vnp.evaluations.caption')}
                  rows={list.items}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-evaluation-id': row.id })}
                  columns={[
                    { key: 'contract', header: t('vnp.evaluations.column.contract'), pinned: true, render: (row) => row.contract_code ?? '–' },
                    { key: 'period', header: t('vnp.evaluations.column.period'), render: (row) => row.period_label },
                    {
                      key: 'score',
                      header: t('vnp.evaluations.column.score'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <strong>{row.overall_score.toFixed(2)}</strong>
                          <span className="vnd-days">
                            {t('vnp.evaluations.scores.text', { quality: row.score_quality, schedule: row.score_schedule, safety: row.score_safety_env, cooperation: row.score_cooperation, financial: row.score_financial })}
                          </span>
                        </span>
                      ),
                    },
                    {
                      key: 'rating',
                      header: t('vnp.evaluations.column.rating'),
                      render: (row) => (
                        <StatusPill tone={ratingTone(row.rating)} icon={ratingIcon(row.rating)}>
                          {ratingLabel(t, row.rating)}
                        </StatusPill>
                      ),
                    },
                    { key: 'remarks', header: t('vnp.evaluations.column.remarks'), render: (row) => row.remarks ?? '–' },
                    {
                      key: 'actions',
                      header: t('vnp.evaluations.column.actions'),
                      render: (row) => {
                        const request = responseRequestOf(row, open);
                        return canAnswer && request !== undefined ? (
                          <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="respond-evaluation" onClick={() => setDialog({ kind: 'answer', request })}>
                            {t('vnp.evaluations.respond.action')}
                          </button>
                        ) : null;
                      },
                    },
                  ]}
                />
                </>
              )}
            </SectionCard>
            <PlansSection plans={plans.data?.items} failed={plans.isError} loading={plans.isLoading} onRetry={() => void plans.refetch()} asOf={plans.data?.as_of ?? list.as_of} canWork={canWork} onAgree={(plan) => setDialog({ kind: 'agree', plan })} onDone={(action) => setDialog({ kind: 'done', action })} />
          </div>
        )}
      </PortalBoundary>
      {dialog?.kind === 'answer' && <AnswerRequestDialog request={dialog.request} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.answer.title.text'))} />}
      {dialog?.kind === 'agree' && <AgreePlanDialog plan={dialog.plan} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.plan.agree.title'))} />}
      {dialog?.kind === 'done' && <ActionDoneDialog action={dialog.action} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.plan.done.title'))} />}
    </PortalLayout>
  );
}

function PlansSection({ plans, failed, loading, onRetry, asOf, canWork, onAgree, onDone }: { plans: readonly PortalPlan[] | undefined; failed: boolean; loading: boolean; onRetry: () => void; asOf: string; canWork: boolean; onAgree: (plan: PortalPlan) => void; onDone: (action: PortalAction) => void }) {
  const { t } = useTranslation();
  if (plans === undefined) {
    if (failed) return <PartialNotice text={t('vnp.plans.partial.text')} onRetry={onRetry} />;
    return loading ? <p className="vnd-none" role="status" aria-busy="true">{t('vnp.plans.loading.text')}</p> : null;
  }
  return (
    <SectionCard title={t('vnp.plans.section.title')}>
      {plans.length === 0 ? (
        <Empty text={t('vnp.plans.empty.text')} testId="plans-empty" />
      ) : (
        plans.map((plan) => (
          <article key={plan.id} className="portal-plan" data-plan-id={plan.id} data-status={plan.status} aria-label={plan.title}>
            <div className="portal-request__head">
              <strong>{plan.title}</strong>
              <span className="vnd-row">
                <StatusPill tone={planTone(plan.status)} icon={planIcon(plan.status)}>
                  {planStatusLabel(t, plan.status)}
                </StatusPill>
                {canWork && plan.status === 'PROPOSED' && (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="agree-plan" onClick={() => onAgree(plan)}>
                    {t('vnp.plans.agree.action')}
                  </button>
                )}
              </span>
            </div>
            <p className="portal-request__body">{plan.objective}</p>
            <p className="vnd-note vnd-row">
              <span>{t('vnp.plans.owed.text', { count: actionsOwed(plan) })}</span>
              <CountInfo name={t('vnp.plans.owed.label')} formula={t('vnp.plans.owed.formula')} source={t('vnp.plans.owed.source')} asOf={asOf} />
            </p>
            <DataTable<PortalAction>
              caption={t('vnp.plans.actions.caption', { title: plan.title })}
              rows={plan.actions}
              rowKey={(row) => row.id}
              rowAttrs={(row) => ({ 'data-action-id': row.id })}
              columns={[
                { key: 'seq', header: t('vnp.plans.column.seq'), render: (row) => row.seq },
                { key: 'description', header: t('vnp.plans.column.description'), pinned: true, render: (row) => row.description },
                {
                  key: 'due',
                  header: t('vnp.plans.column.due'),
                  render: (row) => (
                    <span className="vnd-stack">
                      <span>{dayText(row.due_on)}</span>
                      {row.overdue && <span className="portal-late">{t('vnp.plans.overdue.label')}</span>}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: t('vnp.plans.column.status'),
                  render: (row) => (
                    <span className="vnd-stack">
                      <StatusPill tone={actionTone(row.status)} icon={actionIcon(row.status)}>
                        {actionStatusLabel(t, row.status)}
                      </StatusPill>
                      {row.verify_note !== null && <span className="vnd-days">{row.verify_note}</span>}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: t('vnp.plans.column.actions'),
                  render: (row) =>
                    canWork && plan.status === 'IN_PROGRESS' && row.status === 'OPEN' ? (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="mark-done" onClick={() => onDone(row)}>
                        {t('vnp.plans.done.action')}
                      </button>
                    ) : null,
                },
              ]}
            />
          </article>
        ))
      )}
    </SectionCard>
  );
}
