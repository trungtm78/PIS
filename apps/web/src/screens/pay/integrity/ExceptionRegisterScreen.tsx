import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import { useDecideException, useExceptions } from './hooks';
import { ceilingLabel, statusLabel } from './labels';
import { EXCEPTION_STATUSES, dayText, exceptionTone, requestLink, vnd } from './model';
import type { Exception, ExceptionStatus } from './model';
import './integrity.css';

type T = Translator['t'];
type Move = 'approve' | 'reject' | 'revoke';

const refusalText = (t: T, error: unknown): string => (error instanceof ApiError ? t('govd.integrity.error.refused', { code: error.code }) : t('govd.integrity.error.failed'));

/**
 * PAY-21: the register of exceptions to the ceilings of disbursement (G4-2, G4-5). Each row is an exception asked for a draft request that the capital plan line or the price of the contract blocks: the most it lets go over,
 * the day it lapses, who asked and who decided. An approved one that lapses within a week says so; one past its day is EXPIRED and covers nothing. Deciding needs a person other than the one who asked (and than the one who drew up or sent the request).
 */
export default function ExceptionRegisterScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <RegisterContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RegisterContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode, permissions } = useSession();
  const [status, setStatus] = useState<ExceptionStatus | ''>('');
  const [decision, setDecision] = useState<{ exception: Exception; move: Move } | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const list = useExceptions({ status: status === '' ? undefined : status });
  const decide = useDecideException();
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: (data) => (data as { items: unknown[] }).items.length === 0 });
  const may = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const writable = mode !== 'READ_ONLY';
  const items = list.data?.items ?? [];
  const money = (value: string): string => vnd(value, locale);
  const expiring = (item: Exception): boolean => item.status === 'APPROVED' && item.daysLeft !== null && item.daysLeft <= (list.data?.expiringWithinDays ?? 7);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govd.integrity.register.title')}</h1>
          <p>{t('govd.integrity.register.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('govd.integrity.ctx.scope'), value: tenant?.name ?? t('govd.integrity.ctx.all') }]} unit={t('govd.integrity.unit')} {...(list.data?.asOf ? { asOf: dayText(list.data.asOf) } : {})} />
      <FilterPanel applied={status === '' ? 0 : 1}>
        <label>
          {t('govd.integrity.register.filter.status')}
          <select value={status} onChange={(event) => setStatus(event.target.value as ExceptionStatus | '')} data-testid="status-filter">
            <option value="">{t('govd.integrity.register.filter.all')}</option>
            {EXCEPTION_STATUSES.map((one) => (
              <option key={one} value={one}>
                {statusLabel(t, one)}
              </option>
            ))}
          </select>
        </label>
      </FilterPanel>
      {message === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {message}
        </p>
      )}
      <SectionCard title={t('govd.integrity.register.list')} unit={t('govd.integrity.unit')}>
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          <DataTable
            caption={t('govd.integrity.register.list')}
            rows={items}
            rowKey={(row) => row.id}
            emptyKind={status === '' ? 'none' : 'filtered'}
            onClearFilters={() => setStatus('')}
            columns={[
              { key: 'request', header: t('govd.integrity.register.col.request'), render: (row) => <Link to={requestLink(row.paymentRequestId)}>{row.requestNo ?? row.paymentRequestId.slice(0, 8)}</Link> },
              { key: 'contract', header: t('govd.integrity.register.col.contract'), render: (row) => row.contractCode },
              { key: 'ceiling', header: t('govd.integrity.register.col.ceiling'), render: (row) => ceilingLabel(t, row.ceiling) },
              { key: 'amount', header: t('govd.integrity.register.col.amount'), align: 'right', render: (row) => money(row.allowedAmountVnd) },
              {
                key: 'validTo',
                header: t('govd.integrity.register.col.validTo'),
                render: (row) => (
                  <>
                    {dayText(row.validTo)} {expiring(row) ? <StatusPill tone="warning">{t('govd.integrity.register.expiring', { days: row.daysLeft ?? 0 })}</StatusPill> : null}
                  </>
                ),
              },
              { key: 'reason', header: t('govd.integrity.register.col.reason'), render: (row) => row.reason },
              { key: 'status', header: t('govd.integrity.register.col.status'), render: (row) => <StatusPill tone={exceptionTone(row.status)}>{statusLabel(t, row.status)}</StatusPill> },
              {
                key: 'actions',
                header: t('govd.integrity.register.col.actions'),
                render: (row) =>
                  writable && may('disbursement.exception.approve') && (row.status === 'REQUESTED' || row.status === 'APPROVED') ? (
                    <span className="integrity-actions">
                      {row.status === 'REQUESTED' ? (
                        <>
                          <button type="button" className="ui-button ui-button--primary" onClick={() => setDecision({ exception: row, move: 'approve' })} data-action="approve" data-exception={row.id}>
                            {t('govd.integrity.exception.approve')}
                          </button>
                          <button type="button" className="ui-button ui-button--outline" onClick={() => setDecision({ exception: row, move: 'reject' })} data-action="reject" data-exception={row.id}>
                            {t('govd.integrity.exception.reject')}
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ui-button ui-button--outline" onClick={() => setDecision({ exception: row, move: 'revoke' })} data-action="revoke" data-exception={row.id}>
                          {t('govd.integrity.exception.revoke')}
                        </button>
                      )}
                    </span>
                  ) : null,
              },
            ]}
          />
        </StateBoundary>
      </SectionCard>
      <ConfirmDialog
        open={decision !== undefined}
        title={decision === undefined ? '' : decision.move === 'approve' ? t('govd.integrity.decide.approve.title') : decision.move === 'reject' ? t('govd.integrity.decide.reject.title') : t('govd.integrity.decide.revoke.title')}
        context={decision === undefined ? [] : [{ label: t('govd.integrity.register.col.ceiling'), value: ceilingLabel(t, decision.exception.ceiling) }, { label: t('govd.integrity.register.col.amount'), value: money(decision.exception.allowedAmountVnd) }, { label: t('govd.integrity.register.col.validTo'), value: dayText(decision.exception.validTo) }, { label: t('govd.integrity.register.col.reason'), value: decision.exception.reason }]}
        confirmLabel={decision === undefined || decision.move === 'approve' ? t('govd.integrity.exception.approve') : decision.move === 'reject' ? t('govd.integrity.exception.reject') : t('govd.integrity.exception.revoke')}
        cancelLabel={t('govd.integrity.form.cancel')}
        pending={decide.isPending}
        reason={{ label: decision?.move === 'approve' ? t('govd.integrity.exception.note.optional') : t('govd.integrity.exception.note.required'), required: decision !== undefined && decision.move !== 'approve' }}
        onCancel={() => setDecision(undefined)}
        onConfirm={(text) => {
          if (decision === undefined) return;
          const said = (text ?? '').trim();
          if (decision.move !== 'approve' && said === '') return;
          decide.mutate(
            { id: decision.exception.id, version: decision.exception.version, move: decision.move, text: said },
            {
              onSuccess: () => {
                setMessage(t('govd.integrity.decide.done'));
                setDecision(undefined);
              },
              onError: (error) => {
                setMessage(refusalText(t, error));
                setDecision(undefined);
              },
            },
          );
        }}
      />
      <p className="prototype-note">{t('govd.integrity.register.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
