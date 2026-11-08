import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import type { ScreenState } from '../../../states/StateBoundary';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { dayText, failureStatus, vietnamStamp } from '../shared/vnd-model';
import { Empty, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { ClosePlanDialog, CreatePlanDialog, PlanStepDialog, VerifyActionDialog } from './portal-dialogs';
import { usePlan, usePlans } from './portal-hooks';
import { actionStatusLabel, planStatusLabel, triggerKindLabel } from './portal-labels';
import { PLAN_STATUSES, PORTAL_PERMISSION, actionIcon, actionTone, planIcon, planTone } from './portal-model';
import type { PlanActionLine, PlanDetail, PlanLine } from './portal-model';
import './portal.css';

type Dialog =
  | { kind: 'create' }
  | { kind: 'start'; plan: PlanLine }
  | { kind: 'complete'; plan: PlanLine }
  | { kind: 'close'; plan: PlanLine }
  | { kind: 'verify'; action: PlanActionLine };

/**
 * VND-21, the plans of remediation of contractors (staff). A plan is proposed with actions that have a due day each, agreed by the contractor on its portal, worked, and each action verified by staff; it is completed only
 * when every action is verified, and closed as failed or cancelled with a reason. With `?plan=` in the address it is one plan with its actions and its history; without, the list.
 */
export default function RemediationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const planId = useIdParam('plan', 'id');
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return planId === undefined ? <PlanList key={scope} route={route} /> : <PlanView key={`${scope}:${planId}`} route={route} id={planId} />;
}

function PlanPill({ status }: { status: PlanLine['status'] }) {
  const { t } = useTranslation();
  return (
    <StatusPill tone={planTone(status)} icon={planIcon(status)}>
      {planStatusLabel(t, status)}
    </StatusPill>
  );
}

function PlanList({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const query = usePlans({ status, contractor: '' });
  const page = query.data;
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: page === undefined ? query.error : undefined, data: page, isEmpty: (data) => status === '' && (data as { items: unknown[] }).items.length === 0 });
  const refreshFailed = query.isError && page !== undefined;
  const canManage = !writer.readOnly && writer.can(PORTAL_PERMISSION.remediationManage);
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnp.remediation.page.title')}
        subtitle={t('vnp.remediation.page.subtitle')}
        asOf={page?.as_of}
        stale={refreshFailed}
        actions={
          canManage ? (
            <button type="button" className="ui-button ui-button--primary" data-testid="create-plan" onClick={() => setDialog({ kind: 'create' })}>
              {t('vnp.remediation.create.action')}
            </button>
          ) : undefined
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {page !== undefined && (
          <SectionCard title={t('vnp.remediation.list.title')} status={page.policy.unverified ? <UnverifiedPill /> : undefined}>
            <p className="vnd-note vnd-row">
              <span>{t('vnp.remediation.rule.text')}</span>
              <PolicyInfo name={t('vnp.remediation.rule.name')} policy={page.policy} />
            </p>
            <div className="vnd-filters">
              <label>
                {t('vnp.requests.filter.status.label')}
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">{t('vnp.requests.filter.all.text')}</option>
                  {PLAN_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {planStatusLabel(t, value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {page.items.length === 0 ? (
              <Empty text={t('vnp.requests.filtered.empty.text')} testId="plans-filtered-empty" />
            ) : (
              <DataTable<PlanLine>
                caption={t('vnp.remediation.list.caption')}
                rows={page.items}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-plan-id': row.id })}
                columns={[
                  { key: 'contractor', header: t('vnp.manage.column.contractor'), pinned: true, render: (row) => row.contractor_name },
                  { key: 'title', header: t('vnp.remediation.column.title'), render: (row) => <Link to={`${route.path}?plan=${row.id}`}>{row.title}</Link> },
                  { key: 'status', header: t('vnp.manage.column.status'), render: (row) => <PlanPill status={row.status} /> },
                  { key: 'progress', header: t('vnp.remediation.column.progress'), render: (row) => t('vnp.remediation.progress.text', { verified: row.verified_count, total: row.action_count }) },
                  { key: 'overdue', header: t('vnp.remediation.column.overdue'), render: (row) => (row.overdue_count > 0 ? <span className="portal-late">{t('vnp.remediation.overdue.text', { count: row.overdue_count })}</span> : '–') },
                ]}
              />
            )}
          </SectionCard>
        )}
      </StateBoundary>
      {dialog?.kind === 'create' && (
        <CreatePlanDialog
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            receipt.show(t('vnd.receipt.done.text', { what: t('vnp.planCreate.title.text'), time: vietnamStamp(new Date().toISOString()) }));
          }}
        />
      )}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function PlanView({ route, id }: ScreenProps & { id: string }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = usePlan(id);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const detail: PlanDetail | undefined = query.data;
  const base = useScreenState({ isLoading: query.isLoading, error: detail === undefined ? query.error : undefined, data: detail, isEmpty: () => false });
  const state: ScreenState = detail === undefined && failureStatus(query.error) === 404 ? 'empty' : base;
  const refreshFailed = query.isError && detail !== undefined;
  const canManage = !writer.readOnly && writer.can(PORTAL_PERMISSION.remediationManage);
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnp.remediation.detail.title')}
        subtitle={detail === undefined ? t('vnp.remediation.page.subtitle') : t('vnp.remediation.detail.contractor.text', { name: detail.plan.contractor_name })}
        asOf={detail?.as_of}
        stale={refreshFailed}
        actions={
          <>
            <Link className="ui-button ui-button--outline" to={route.path}>
              {t('vnp.remediation.back.link')}
            </Link>
            {canManage && detail !== undefined && detail.may_start && (
              <button type="button" className="ui-button ui-button--primary" data-testid="start-plan" onClick={() => setDialog({ kind: 'start', plan: detail.plan })}>
                {t('vnp.planStart.confirm.action')}
              </button>
            )}
            {canManage && detail !== undefined && detail.may_complete && (
              <button type="button" className="ui-button ui-button--primary" data-testid="complete-plan" onClick={() => setDialog({ kind: 'complete', plan: detail.plan })}>
                {t('vnp.planComplete.confirm.action')}
              </button>
            )}
            {canManage && detail !== undefined && detail.may_close && (
              <button type="button" className="ui-button ui-button--outline" data-testid="close-plan" onClick={() => setDialog({ kind: 'close', plan: detail.plan })}>
                {t('vnp.close.confirm.action')}
              </button>
            )}
          </>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {detail !== undefined && (
          <div className="vnd-page">
            <SectionCard title={detail.plan.title} status={<PlanPill status={detail.plan.status} />}>
              <p className="portal-request__body">{detail.plan.objective}</p>
              <p className="vnd-note">
                {t('vnp.remediation.trigger.text', { trigger: triggerKindLabel(t, detail.plan.trigger_kind), proposer: detail.plan.proposed_by_name ?? '–', time: vietnamStamp(detail.plan.proposed_at) })}
              </p>
              {detail.plan.closed_reason !== null && <p className="callout">{detail.plan.closed_reason}</p>}
            </SectionCard>
            <SectionCard title={t('vnp.remediation.actions.title')} status={detail.policy.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note vnd-row">
                <span>{t('vnp.remediation.rule.text')}</span>
                <PolicyInfo name={t('vnp.remediation.rule.name')} policy={detail.policy} />
              </p>
              <DataTable<PlanActionLine>
                caption={t('vnp.remediation.actions.caption')}
                rows={detail.actions}
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
                        {row.done_note !== null && <span className="vnd-days">{t('vnp.remediation.doneNote.text', { name: row.done_by_name ?? '–', note: row.done_note })}</span>}
                        {row.verify_note !== null && <span className="vnd-days">{row.verify_note}</span>}
                      </span>
                    ),
                  },
                  {
                    key: 'actions',
                    header: t('vnp.plans.column.actions'),
                    render: (row) =>
                      canManage && row.status === 'DONE' ? (
                        <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="verify-action" onClick={() => setDialog({ kind: 'verify', action: row })}>
                          {t('vnp.remediation.verify.action')}
                        </button>
                      ) : null,
                  },
                ]}
              />
            </SectionCard>
            <SectionCard title={t('vnp.remediation.history.title')}>
              {detail.events.length === 0 ? (
                <Empty text={t('vnp.remediation.history.empty.text')} testId="history-empty" />
              ) : (
                <ol className="portal-timeline" data-testid="timeline">
                  {detail.events.map((event) => (
                    <li key={event.id}>
                      {t('vnp.remediation.event.text', { time: vietnamStamp(event.at), actor: event.actor_name ?? '–', move: event.move, to: event.to_status })}
                      {event.note !== null && ` · ${event.note}`}
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'start' && <PlanStepDialog step="start" plan={dialog.plan} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.planStart.title.text'))} />}
      {dialog?.kind === 'complete' && <PlanStepDialog step="complete" plan={dialog.plan} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.planComplete.title.text'))} />}
      {dialog?.kind === 'close' && <ClosePlanDialog plan={dialog.plan} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.close.title.text'))} />}
      {dialog?.kind === 'verify' && <VerifyActionDialog action={dialog.action} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.verify.title.text'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

