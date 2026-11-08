import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar } from '../../ui';
import { clockText } from '../home/overview-model';
import { AlertCard, EmptyReason, Guarded, PolicyNotice, refusalText, typeLabelOf } from './components';
import { useAcknowledge, useAlerts, useEvaluateAlerts } from './hooks';
import { ALERT_STATUSES, PERMISSION, alertStatusOf, canAcknowledge, dayText, may } from './model';
import type { Alert } from './model';

/**
 * BAN-05, the alerts of the committee: one open line for each condition that holds (province behind the curve, a sector behind, a unit not reporting, a directive overdue), each with the owner, what is expected, what follows
 * and the hours to answer in. The secretariat evaluates them again; the head acknowledges one with a note (the alert changed in the meantime is said, not overwritten); a condition that stops holding closes its line by itself.
 */
export default function AlertsScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Guarded route={route} permission={PERMISSION.read} title={t('ban.alr.page.title')} subtitle={t('ban.alr.page.subtitle')}>
      <AlertsContent />
    </Guarded>
  );
}

function AlertsContent() {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const status = alertStatusOf(params.get('status'));
  const query = useAlerts(status);
  const evaluate = useEvaluateAlerts();
  const acknowledge = useAcknowledge();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const [acting, setActing] = useState<Alert | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [evaluateError, setEvaluateError] = useState<string | undefined>(undefined);
  const mayAcknowledge = may(permissions, PERMISSION.acknowledge);
  const mayEvaluate = may(permissions, PERMISSION.evaluate);
  const statusLabel = (one: (typeof ALERT_STATUSES)[number]): string => (one === 'LIVE' ? t('ban.alr.status.live') : one === 'OPEN' ? t('ban.alr.status.open') : one === 'ACKNOWLEDGED' ? t('ban.alr.status.acknowledged') : t('ban.alr.status.resolved'));

  return (
    <>
      <ContextBar
        items={[
          { label: t('ban.dash.context.scope'), value: tenant?.name ?? '–' },
          { label: t('ban.dash.context.asOf'), value: data === undefined ? '–' : dayText(data.as_of) },
        ]}
        {...(query.dataUpdatedAt > 0 ? { asOf: clockText(query.dataUpdatedAt) } : {})}
        stale={query.isError && data !== undefined}
      />
      {data === undefined ? null : <PolicyNotice policy={data.policy} />}
      <div className="ban-audit-filters">
        <label htmlFor="ban-alert-status">
          <span>{t('ban.alr.filter.status')}</span>
          <select id="ban-alert-status" value={status} onChange={(event) => setParams(event.target.value === 'LIVE' ? new URLSearchParams() : new URLSearchParams({ status: event.target.value }))}>
            {ALERT_STATUSES.map((one) => (
              <option key={one} value={one}>
                {statusLabel(one)}
              </option>
            ))}
          </select>
        </label>
        {mayEvaluate ? (
          <button
            type="button"
            className="ui-button ui-button--outline"
            disabled={evaluate.isPending}
            data-testid="alerts-evaluate"
            onClick={() => {
              setEvaluateError(undefined);
              evaluate.mutate(null, {
                onSuccess: (result) => {
                  const done = result as { opened?: number; kept?: number; resolved?: number };
                  setReceipt(t('ban.alr.evaluate.receipt', { opened: done.opened ?? 0, kept: done.kept ?? 0, resolved: done.resolved ?? 0 }));
                },
                onError: (failure) => setEvaluateError(refusalText(t, failure)),
              });
            }}
          >
            {evaluate.isPending ? t('ban.alr.evaluate.sending') : t('ban.alr.evaluate.action')}
          </button>
        ) : null}
      </div>
      {evaluateError === undefined ? null : (
        <p className="ban-error" role="alert">
          {evaluateError}
        </p>
      )}
      {receipt === undefined ? null : (
        <p className="callout" role="status" data-testid="alerts-receipt">
          {receipt}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : data.alerts.length === 0 ? (
          <EmptyReason text={status === 'LIVE' || status === 'OPEN' ? t('ban.alr.empty.live.text') : t('ban.alr.empty.filtered.text')} testId="alerts-empty" />
        ) : (
          <div className="ban-alerts" data-testid="alerts-list">
            {data.alerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                actions={
                  canAcknowledge(alert) && mayAcknowledge ? (
                    <div className="ban-actions">
                      <button
                        type="button"
                        className="ui-button ui-button--primary ui-button--small"
                        data-testid={`acknowledge-${alert.id}`}
                        onClick={() => {
                          setError(undefined);
                          setActing(alert);
                        }}
                      >
                        {t('ban.alr.acknowledge.action')}
                      </button>
                    </div>
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
      </StateBoundary>
      {acting === undefined ? null : (
        <ConfirmDialog
          open
          title={t('ban.alr.acknowledge.title')}
          context={[
            { label: t('ban.alr.acknowledge.what'), value: typeLabelOf(t, acting.alert_type) },
            { label: t('ban.alr.acknowledge.subject'), value: acting.subject_label ?? acting.subject_key },
          ]}
          confirmLabel={t('ban.alr.acknowledge.action')}
          cancelLabel={t('ban.att.dialog.cancel')}
          pending={acknowledge.isPending}
          reason={{ label: t('ban.alr.acknowledge.note'), required: true }}
          {...(error === undefined ? {} : { error })}
          onCancel={() => setActing(undefined)}
          onConfirm={(note) => {
            if ((note ?? '').trim() === '') {
              setError(t('ban.att.dialog.note.error'));
              return;
            }
            acknowledge.mutate(
              { alert: acting, note: note ?? '' },
              {
                onSuccess: () => {
                  setActing(undefined);
                  setReceipt(t('ban.alr.acknowledge.receipt'));
                },
                onError: (failure) => {
                  setError(refusalText(t, failure));
                  void query.refetch();
                },
              },
            );
          }}
        >
          <p>{t('ban.alr.acknowledge.text')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
