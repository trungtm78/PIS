import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { ConfirmDialog, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { sourceLabel } from '../../ui/alerts/AlertRow';
import { useMyFeedback, useWithdrawFeedback } from './hooks';
import type { Feedback } from './model';
import { feedbackReasonLabel, feedbackStatusLabel, when } from './parts';

/**
 * The reporter side of the reports "this alert is wrong" (G2-9): a person sees their own reports and the answer of the owner of the alert type, and withdraws a report that nobody reviewed yet. A report that was reviewed
 * can no longer be withdrawn (the server says so with `ALERT_FEEDBACK_STATE_INVALID`); withdrawing never changes the alert, which was never hidden by the report.
 */
export function MyFeedbackSection() {
  const { t } = useTranslation();
  const mine = useMyFeedback();
  const withdraw = useWithdrawFeedback();
  const [target, setTarget] = useState<Feedback | null>(null);
  const items = mine.data?.items ?? [];
  const refusal =
    withdraw.error instanceof ApiError
      ? withdraw.error.code === 'ALERT_FEEDBACK_STATE_INVALID'
        ? t('gov10.feedback.mine.error.state')
        : withdraw.error.code === 'VERSION_CONFLICT'
          ? t('gov10.feedback.mine.error.conflict')
          : t('gov10.feedback.mine.error.failed')
      : withdraw.isError
        ? t('gov10.feedback.mine.error.failed')
        : undefined;
  const columns: DataTableColumn<Feedback>[] = [
    { key: 'type', header: t('gov10.feedback.column.type'), pinned: true, render: (row) => <><strong>{row.alertType}</strong> <span className="dis-code">{sourceLabel(t, row.source)}</span></> },
    { key: 'reason', header: t('gov10.feedback.column.reason'), render: (row) => feedbackReasonLabel(t, row.reason) },
    { key: 'status', header: t('gov10.feedback.column.status'), render: (row) => <StatusPill tone={row.status === 'PENDING' ? 'warning' : 'neutral'}>{feedbackStatusLabel(t, row.status)}</StatusPill> },
    { key: 'answer', header: t('gov10.feedback.mine.answer'), render: (row) => row.reviewNote ?? row.proposalNote ?? '—' },
    { key: 'created', header: t('gov10.feedback.column.created'), render: (row) => <time dateTime={row.createdAt}>{when(row.createdAt)}</time> },
    {
      key: 'actions',
      header: t('gov10.feedback.column.actions'),
      render: (row) =>
        row.status === 'PENDING' ? (
          <button
            type="button"
            className="mv-alert-button"
            data-testid={`withdraw-${row.id}`}
            onClick={() => {
              withdraw.reset();
              setTarget(row);
            }}
          >
            {t('gov10.feedback.mine.withdraw')}
          </button>
        ) : (
          '—'
        ),
    },
  ];
  return (
    <SectionCard title={t('gov10.feedback.mine.title')}>
      <p className="gov10-notice">{t('gov10.feedback.mine.notice')}</p>
      {mine.isLoading ? (
        <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
      ) : mine.data === undefined ? (
        <p role="status" data-testid="mine-error">
          {t('gov10.feedback.mine.failed')}{' '}
          <button type="button" className="mv-alert-link" onClick={() => void mine.refetch()}>
            {t('gov10.state.retry.label')}
          </button>
        </p>
      ) : items.length === 0 ? (
        <p className="gov10-notice" role="status" data-testid="mine-empty">
          {t('gov10.feedback.mine.empty')}
        </p>
      ) : (
        <DataTable caption={t('gov10.feedback.mine.title')} columns={columns} rows={items} rowKey={(row) => row.id} />
      )}
      {target === null ? null : (
        <ConfirmDialog
          open
          title={t('gov10.feedback.mine.withdraw')}
          context={[
            { label: t('gov10.feedback.column.type'), value: target.alertType },
            { label: t('gov10.feedback.column.reason'), value: feedbackReasonLabel(t, target.reason) },
          ]}
          confirmLabel={t('gov10.feedback.mine.withdraw')}
          cancelLabel={t('gov10.dialog.cancel.label')}
          pending={withdraw.isPending}
          onConfirm={() => withdraw.mutate({ id: target.id, version: target.version }, { onSuccess: () => setTarget(null) })}
          onCancel={() => setTarget(null)}
          {...(refusal === undefined ? {} : { error: refusal })}
        />
      )}
    </SectionCard>
  );
}
