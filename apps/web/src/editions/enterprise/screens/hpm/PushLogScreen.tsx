import { useState } from 'react';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { ContextBar } from '../../../../ui';
import { switchBlock, vietnamStamp } from '../shared/format';
import { HistorySection, PendingSection, ReadonlyNote, SwitchDialog } from '../shared/parts';
import { AcceptedSection, ActionSection, FreshnessCard, PushDialog, PushLog, ReceiptDialog, ResultNote, RetryDialog, StatusCard } from './components';
import { useHpmConnection, useHpmPushes, useSetHpmConnectionState } from './hooks';
import { CONNECTOR_CODE } from './model';
import type { Push, PushResult, PushStatus } from './model';
import '../shared/shared.css';

/**
 * HPM-01, the push of the issued reports to HPM (ENT-2, R8, R17, R18): what the connection is (a file writer that stands for the platform, so PENDING-EXTERNAL), how fresh the last delivery is by the rule, what
 * waits for a receipt, and the log of every push by its key (organisation, period, revision). A push is repeated under the same key and never twice; the receipt of the receiver is recorded by somebody other than the
 * pusher. The screen opens no connection to HPM.
 */
export default function PushLogScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The connection belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <PushLogContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'push' } | { kind: 'switch' } | { kind: 'retry'; push: Push } | { kind: 'receipt'; push: Push } | undefined;

function PushLogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const query = useHpmConnection();
  const [filter, setFilter] = useState<PushStatus | undefined>(undefined);
  const log = useHpmPushes(filter);
  const switcher = useSetHpmConnectionState();
  const [dialog, setDialog] = useState<Dialog>(undefined);
  const [result, setResult] = useState<PushResult | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const data = query.data;
  // A tenant that never used the connection is not an empty screen: it shows "never pushed" and the first-use hint.
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const block = data === undefined ? null : switchBlock(data.actions.may_switch, mode);
  const mayPush = data !== undefined && mode !== 'READ_ONLY' && data.actions.may_push;
  const stale = refreshFailed || data?.health.status === 'STALE';
  const asOf = data === undefined ? undefined : vietnamStamp(stale && !refreshFailed && data.health.last_delivery_at !== null ? data.health.last_delivery_at : data.as_of);
  const rows = log.data?.pages.flatMap((page) => page.items) ?? [];
  const logState = log.isLoading ? 'loading' : log.isError && rows.length === 0 ? 'error' : 'ready';
  const readonlyActions = mode === 'READ_ONLY';

  const reload = (): void => {
    setResult(undefined);
    setNote(undefined);
    void query.refetch();
    void log.refetch();
  };
  const closeWith = (next: PushResult | undefined, message?: string): void => {
    setDialog(undefined);
    setResult(next);
    setNote(message);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('hpm.push.page.title')}</h1>
          <p>{t('hpm.push.page.subtitle')}</p>
        </div>
        {data !== undefined && (
          <div className="actions">
            {mayPush && (
              <button type="button" className="ui-button ui-button--primary" data-testid="push-button" disabled={!data.enabled} onClick={() => { setResult(undefined); setNote(undefined); setDialog({ kind: 'push' }); }}>
                {t('hpm.header.push.action')}
              </button>
            )}
            {block === null && (
              <button type="button" className={data.enabled ? 'ui-button ui-button--outline' : 'ui-button ui-button--primary'} data-testid="switch-button" onClick={() => { setResult(undefined); setNote(undefined); setDialog({ kind: 'switch' }); }}>
                {data.enabled ? t('hpm.header.disable.action') : t('hpm.header.enable.action')}
              </button>
            )}
          </div>
        )}
      </div>
      <ContextBar
        items={[
          { label: t('hpm.context.scope.label'), value: tenant?.name ?? '–' },
          { label: t('hpm.context.connector.label'), value: data?.connector_code ?? CONNECTOR_CODE },
        ]}
        {...(asOf === undefined ? {} : { asOf })}
        stale={stale}
      />
      {result !== undefined && <ResultNote result={result} />}
      {note !== undefined && (
        <p className="callout ent2-receipt" role="status" data-testid="action-receipt">
          {note}
        </p>
      )}
      {data !== undefined && (readonlyActions ? <ReadonlyNote block="MODE" /> : block === 'RIGHT' && !mayPush ? <ReadonlyNote block="RIGHT" /> : null)}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="ent2-page">
            <ActionSection connection={data} />
            <StatusCard connection={data} />
            <FreshnessCard connection={data} />
            <PushLog
              rows={rows}
              state={logState}
              filter={filter}
              onFilter={setFilter}
              hasMore={log.hasNextPage}
              loadingMore={log.isFetchingNextPage}
              onMore={() => void log.fetchNextPage()}
              onRetryLoad={() => void log.refetch()}
              onRetry={(push) => { setResult(undefined); setNote(undefined); setDialog({ kind: 'retry', push }); }}
              onReceipt={(push) => { setResult(undefined); setNote(undefined); setDialog({ kind: 'receipt', push }); }}
            />
            <AcceptedSection connection={data} />
            <PendingSection items={data.pending_external} />
            <HistorySection history={data.history} />
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'push' && <PushDialog onClose={() => setDialog(undefined)} onDone={(done) => closeWith(done)} />}
      {dialog?.kind === 'retry' && <RetryDialog push={dialog.push} onClose={() => setDialog(undefined)} onDone={(done) => closeWith(done)} />}
      {dialog?.kind === 'receipt' && (
        <ReceiptDialog push={dialog.push} onClose={() => setDialog(undefined)} onDone={(outcome) => closeWith(undefined, outcome === 'ACCEPTED' ? t('hpm.receipt.done.accepted') : t('hpm.receipt.done.rejected'))} />
      )}
      {dialog?.kind === 'switch' && data !== undefined && (
        <SwitchDialog
          connectorCode={data.connector_code}
          enabled={data.enabled}
          version={data.version}
          mutation={switcher}
          onClose={() => setDialog(undefined)}
          onDone={(enabled) => closeWith(undefined, enabled ? t('hpm.switch.done.enabled') : t('hpm.switch.done.disabled'))}
          onReload={reload}
        />
      )}
      <p className="prototype-note">{t('hpm.push.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
