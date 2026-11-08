import { useState } from 'react';
import { ApiError } from '@machvon/api-client';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, MakerCheckerBadge, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn, Tone } from '../../ui';
import { useRedFlag, useRedFlagIndicators, useRedFlagMove } from './hooks';
import type { RedFlagMoveName } from './hooks';
import type { Indicator, Reading, ReviewEntry } from './model';
import { BandPill, Provenance, indicatorLabel, redStatusLabel, when } from './parts';

const REVIEW = 'aud.redflag.review';
const CLEAR = 'aud.redflag.clear';
const READING_TONE: Readonly<Record<Reading['status'], Tone>> = { FIRED: 'danger', CLEAR: 'success', NOT_COMPUTABLE: 'warning' };

type Pending = { move: RedFlagMoveName; needsReason: boolean } | null;

/**
 * AUD-15: one red flag. Every indicator is on the page with the number it measured against the number it was compared with, the ones that could not be computed with the facts that are missing (never as "clear"), and the "i"
 * of each with its formula, source, day and the label "default, not confirmed". The review is two steps for clearing (one auditor proposes with a reason, a different one confirms or sends it back), or a referral with a reason.
 * A person who took part in the procurement, or a finding that does not exist, gets the same "not found".
 */
export default function RedFlagDetailScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <DetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const session = useSession();
  const [params] = useSearchParams();
  const id = params.get('finding') ?? '';
  const detail = useRedFlag(id);
  const indicators = useRedFlagIndicators();
  const move = useRedFlagMove();
  const [pending, setPending] = useState<Pending>(null);
  const finding = detail.data;
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;
  const state = useScreenState({ isLoading: detail.isLoading, error: finding === undefined && !notFound ? detail.error : undefined, data: finding, isEmpty: () => false });
  const permissions = session.permissions ?? [];
  const me = session.tenant?.membershipId ?? '';
  const mayReview = permissions.includes(REVIEW);
  const mayClear = permissions.includes(CLEAR);
  const byCode = new Map<string, Indicator>((indicators.data ?? []).map((entry) => [entry.code, entry]));

  const readingColumns: DataTableColumn<Reading>[] = [
    {
      key: 'indicator',
      header: t('gov10.red.reading.indicator'),
      pinned: true,
      render: (row) => (
        <>
          <strong>{indicatorLabel(t, row.code)}</strong> <span className="dis-code">{row.ocpId}</span>{' '}
          {byCode.has(row.code) ? (
            <Provenance
              name={indicatorLabel(t, row.code)}
              formula={byCode.get(row.code)?.formula ?? null}
              source={byCode.get(row.code)?.source ?? null}
              asOf={byCode.get(row.code)?.indicatorAsOf ?? null}
              version={byCode.get(row.code)?.ruleVersion === 0 || byCode.get(row.code)?.ruleVersion === null ? t('gov10.info.versionDefault') : t('gov10.info.versionRule', { version: byCode.get(row.code)?.ruleVersion ?? 0 })}
              unverified={byCode.get(row.code)?.unverified ?? true}
              owner={t('gov10.red.owner')}
            />
          ) : null}
        </>
      ),
    },
    {
      key: 'status',
      header: t('gov10.red.reading.status'),
      render: (row) => (
        <StatusPill tone={READING_TONE[row.status]}>{row.status === 'FIRED' ? t('gov10.red.reading.fired') : row.status === 'CLEAR' ? t('gov10.red.reading.clear') : t('gov10.red.reading.notComputable')}</StatusPill>
      ),
    },
    {
      key: 'value',
      header: t('gov10.red.reading.value'),
      align: 'right',
      render: (row) => (row.status === 'NOT_COMPUTABLE' || row.value === null ? '—' : t('gov10.red.reading.valueOf', { value: row.value, threshold: row.threshold ?? 0 })),
    },
    { key: 'weight', header: t('gov10.red.reading.weight'), align: 'right', render: (row) => String(row.weight) },
    { key: 'missing', header: t('gov10.red.reading.missing'), render: (row) => (row.missing.length === 0 ? '—' : t('gov10.red.reading.missingFacts', { facts: row.missing.join(', ') })) },
  ];
  const historyColumns: DataTableColumn<ReviewEntry>[] = [
    { key: 'at', header: t('gov10.red.history.at'), render: (row) => <time dateTime={row.at}>{when(row.at)}</time> },
    { key: 'move', header: t('gov10.red.history.move'), render: (row) => row.move },
    { key: 'status', header: t('gov10.red.history.status'), render: (row) => `${row.fromStatus ?? '—'} → ${row.toStatus}` },
    { key: 'score', header: t('gov10.red.history.score'), align: 'right', render: (row) => String(row.score) },
    { key: 'reason', header: t('gov10.red.history.reason'), render: (row) => row.reason ?? '—' },
  ];

  const confirm = (reason?: string): void => {
    if (pending === null || finding === undefined) return;
    move.mutate({ id: finding.id, version: finding.version, move: pending.move, reason }, { onSuccess: () => setPending(null) });
  };
  const open = (name: RedFlagMoveName, needsReason: boolean): void => {
    move.reset();
    setPending({ move: name, needsReason });
  };
  const titleOf = (name: RedFlagMoveName): string => {
    switch (name) {
      case 'takeRedFlag':
        return t('gov10.red.action.take');
      case 'proposeClearRedFlag':
        return t('gov10.red.action.proposeClear');
      case 'confirmClearRedFlag':
        return t('gov10.red.action.confirmClear');
      case 'rejectClearRedFlag':
        return t('gov10.red.action.rejectClear');
      default:
        return t('gov10.red.action.refer');
    }
  };
  const refusal = move.error instanceof ApiError ? (move.error.code === 'SELF_APPROVAL_DENIED' ? t('gov10.red.error.selfApproval') : move.error.code === 'VERSION_CONFLICT' ? t('gov10.red.error.conflict') : t('gov10.red.error.refused')) : move.isError ? t('gov10.red.error.refused') : undefined;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{finding === undefined ? t('gov10.red.detail.title') : t('gov10.red.detail.titleOf', { code: finding.subjectCode })}</h1>
          <p>{t('gov10.red.detail.subtitle')}</p>
        </div>
        <Link to="/aud/aud-14" className="mv-alert-link">
          {t('gov10.red.back')}
        </Link>
      </div>
      <div className="gov10-stack">
        <p className="gov10-notice" data-testid="red-flag-notice">
          {t('gov10.red.notice')}
        </p>
        {notFound ? (
          <div className="gov10-notice" role="alert" data-testid="red-flag-not-found">
            <p>{t('gov10.red.detail.notFound')}</p>
          </div>
        ) : (
          <StateBoundary state={state} onRetry={() => void detail.refetch()}>
            {finding === undefined ? null : (
              <>
                <ContextBar
                  items={[
                    { label: t('gov10.red.detail.score'), value: String(finding.score) },
                    { label: t('gov10.red.detail.status'), value: redStatusLabel(t, finding.status) },
                    { label: t('gov10.red.detail.flagged'), value: when(finding.firstFlaggedAt) },
                    { label: t('gov10.red.detail.ranking'), value: finding.rankingVersion },
                  ]}
                  asOf={when(finding.lastEvaluatedAt)}
                />
                <p>
                  <BandPill band={finding.band} />{' '}
                  {finding.reopenedCount > 0 ? <StatusPill tone="warning">{t('gov10.red.detail.reopened', { count: finding.reopenedCount })}</StatusPill> : null}
                  {finding.clearProposedBy !== null && finding.status === 'CLEAR_PROPOSED' ? <MakerCheckerBadge maker={t('gov10.red.detail.proposer')} /> : null}
                </p>
                {finding.notComputable.length > 0 ? (
                  <p className="gov10-notice gov10-notice--warn" role="status" data-testid="red-flag-lower-bound">
                    {t('gov10.red.detail.lowerBound', { count: finding.notComputable.length })}
                  </p>
                ) : null}
                <SectionCard title={t('gov10.red.detail.readings')}>
                  <DataTable caption={t('gov10.red.detail.readings')} columns={readingColumns} rows={finding.readings} rowKey={(row) => row.code} />
                </SectionCard>
                {finding.clearReason !== null ? <p data-testid="clear-reason">{t('gov10.red.detail.clearReason', { reason: finding.clearReason })}</p> : null}
                {finding.referralReason !== null ? <p data-testid="referral-reason">{t('gov10.red.detail.referralReason', { reason: finding.referralReason })}</p> : null}
                <div className="gov10-actions" role="group" aria-label={t('gov10.red.actions')}>
                  {mayReview && finding.status === 'NEW' ? (
                    <button type="button" className="mv-alert-button mv-alert-button--primary" disabled={move.isPending} onClick={() => open('takeRedFlag', false)}>
                      {t('gov10.red.action.take')}
                    </button>
                  ) : null}
                  {mayReview && finding.status === 'IN_REVIEW' ? (
                    <>
                      <button type="button" className="mv-alert-button" disabled={move.isPending} onClick={() => open('proposeClearRedFlag', true)}>
                        {t('gov10.red.action.proposeClear')}
                      </button>
                      <button type="button" className="mv-alert-button" disabled={move.isPending} onClick={() => open('referRedFlag', true)}>
                        {t('gov10.red.action.refer')}
                      </button>
                    </>
                  ) : null}
                  {mayClear && finding.status === 'CLEAR_PROPOSED' && finding.clearProposedBy !== me ? (
                    <>
                      <button type="button" className="mv-alert-button mv-alert-button--primary" disabled={move.isPending} onClick={() => open('confirmClearRedFlag', false)}>
                        {t('gov10.red.action.confirmClear')}
                      </button>
                      <button type="button" className="mv-alert-button" disabled={move.isPending} onClick={() => open('rejectClearRedFlag', true)}>
                        {t('gov10.red.action.rejectClear')}
                      </button>
                    </>
                  ) : null}
                </div>
                {finding.status === 'CLEAR_PROPOSED' && finding.clearProposedBy === me ? <p data-testid="needs-second">{t('gov10.red.detail.needsSecond')}</p> : null}
                <SectionCard title={t('gov10.red.detail.history')}>
                  <DataTable caption={t('gov10.red.detail.history')} columns={historyColumns} rows={finding.history} rowKey={(row) => row.id} />
                </SectionCard>
                {pending === null ? null : (
                  <ConfirmDialog
                    open
                    title={titleOf(pending.move)}
                    context={[
                      { label: t('gov10.red.detail.code'), value: finding.subjectCode },
                      { label: t('gov10.red.detail.score'), value: String(finding.score) },
                    ]}
                    confirmLabel={titleOf(pending.move)}
                    cancelLabel={t('gov10.dialog.cancel.label')}
                    pending={move.isPending}
                    onConfirm={confirm}
                    onCancel={() => setPending(null)}
                    {...(pending.needsReason ? { reason: { label: t('gov10.red.reason'), required: true, minLength: 5, hint: t('gov10.red.reasonHint') } } : {})}
                    {...(refusal === undefined ? {} : { error: refusal })}
                  />
                )}
              </>
            )}
          </StateBoundary>
        )}
      </div>
    </section>
  );
}
