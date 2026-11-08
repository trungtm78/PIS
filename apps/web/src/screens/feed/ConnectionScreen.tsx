import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar } from '../../ui';
import { ActionSection, AlertsSection, ChannelsSection, CountsSection, HealthSection, HistorySection, LateUnitsSection, LayoutsSection, PendingSection, PositionsSection, QualitySection, RunsSection, StatusCard, SwitchDialog } from './connection-sections';
import { useFeedConnection, useReload } from './feed-hooks';
import { CONNECTOR_CODE, commandBlock, vietnamStamp } from './feed-model';
import { FeedLinks, StaleNote } from './feed-parts';
import './feed.css';

/**
 * FEED-01, the connection `fin.sotaichinh` to the application of the Finance Department: what the connection is, which channels bring records in (a file, a push, the data generator) and in what state each adapter is, how fresh the data is by the rule,
 * the quality of the month (completeness, timeliness, discrepancy rate, each with its numbers and its "i"), the units that are late, the open alerts and the findings. The one command is to switch the connection on or off with a reason.
 * The screen opens no connection to the Finance application: every figure that rests on the assumed file layout says PENDING-EXTERNAL.
 */
export default function ConnectionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The connection belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ConnectionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

interface Receipt {
  enabled: boolean;
  time: string;
}

function ConnectionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const query = useFeedConnection();
  const reload = useReload();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const data = query.data;
  // A tenant that never used the connection is not an empty screen: it shows "never received" and the first-use hint.
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const block = data === undefined ? null : commandBlock(data.actions.setState, mode);
  const stale = refreshFailed || data?.health.status === 'STALE';
  const asOf = data === undefined ? undefined : vietnamStamp(stale && !refreshFailed && data.health.lastRunAt !== null ? data.health.lastRunAt : data.asOf);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="feed-head">
        <div>
          <h1 id="screen-title">{t('feed.connection.page.title')}</h1>
          <p>{t('feed.connection.page.subtitle')}</p>
          <FeedLinks current="connection" />
        </div>
        {data !== undefined && block === null && (
          <div className="feed-actions">
            <button
              type="button"
              className={data.enabled ? 'ui-button ui-button--outline' : 'ui-button ui-button--primary'}
              data-testid="switch-button"
              onClick={() => {
                setReceipt(undefined);
                setDialogOpen(true);
              }}
            >
              {data.enabled ? t('feed.connection.header.disable.action') : t('feed.connection.header.enable.action')}
            </button>
          </div>
        )}
      </div>
      <ContextBar
        items={[
          { label: t('feed.connection.context.scope.label'), value: tenant?.name ?? '–' },
          { label: t('feed.connection.context.connector.label'), value: data?.connectorCode ?? CONNECTOR_CODE },
        ]}
        {...(asOf === undefined ? {} : { asOf })}
        stale={stale}
      />
      {refreshFailed && <StaleNote asOf={data.asOf === '' ? null : data.asOf} onRetry={() => void query.refetch()} />}
      {receipt !== undefined && (
        <p className="callout feed-receipt" role="status" data-testid="switch-receipt">
          {receipt.enabled
            ? t('feed.connection.success.enabled.text', { code: data?.connectorCode ?? CONNECTOR_CODE, time: receipt.time })
            : t('feed.connection.success.disabled.text', { code: data?.connectorCode ?? CONNECTOR_CODE, time: receipt.time })}
        </p>
      )}
      {block !== null && (
        <p className="callout" data-testid="readonly-note">
          {block === 'MODE' ? t('feed.common.readonly.mode') : t('feed.common.readonly.right')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="feed-page">
            <ActionSection connection={data} />
            <StatusCard connection={data} />
            <ChannelsSection connection={data} />
            <HealthSection connection={data} />
            <QualitySection connection={data} />
            <LateUnitsSection connection={data} />
            <AlertsSection connection={data} />
            <CountsSection connection={data} />
            <RunsSection connection={data} />
            <PositionsSection connection={data} />
            <LayoutsSection connection={data} />
            <PendingSection connection={data} />
            <HistorySection connection={data} />
          </div>
        )}
      </StateBoundary>
      {dialogOpen && data !== undefined && (
        <SwitchDialog
          connection={data}
          onClose={() => setDialogOpen(false)}
          onDone={(enabled) => {
            setDialogOpen(false);
            setReceipt({ enabled, time: vietnamStamp(new Date().toISOString()) });
          }}
          onReload={() => {
            setReceipt(undefined);
            void reload();
          }}
        />
      )}
      <p className="prototype-note">{t('feed.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
