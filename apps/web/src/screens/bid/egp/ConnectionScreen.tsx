import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar } from '../../../ui';
import { ActionSection, CountsSection, FreshnessCard, HistorySection, LayoutsSection, PendingSection, PositionsSection, RunsSection, StatusCard, SwitchDialog } from './connection-components';
import { useEgpConnection } from './connection-hooks';
import { CONNECTOR_CODE, switchBlock, vietnamStamp } from './connection-model';
import './connection.css';

/**
 * BID-22, the connection `egp.muasamcong` to the national e-procurement network (EGP-1): what the connection is (an adapter that is only a proposal and reads files), how fresh the data from it is by the rule, what each of the
 * five positions last did, what the register holds from the network and what we are still waiting for. The one command is to switch the connection on or off with a reason. The screen opens no connection to the network: it reads files
 * that a person hands over (BID-24), and every figure that rests on the assumed file layout says PENDING-EXTERNAL.
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
  const query = useEgpConnection();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const data = query.data;
  // A tenant that never used the connection is not an empty screen: it shows "never imported" and the first-use hint.
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const block = data === undefined ? null : switchBlock(data, mode);
  const stale = refreshFailed || data?.health.status === 'STALE';
  const asOf = data === undefined ? undefined : vietnamStamp(stale && !refreshFailed && data.health.last_import_at !== null ? data.health.last_import_at : data.as_of);

  const reload = (): void => {
    setReceipt(undefined);
    void query.refetch();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('egp.connection.page.title')}</h1>
          <p>{t('egp.connection.page.subtitle')}</p>
        </div>
        {data !== undefined && block === null && (
          <div className="actions">
            <button
              type="button"
              className={data.enabled ? 'ui-button ui-button--outline' : 'ui-button ui-button--primary'}
              data-testid="switch-button"
              onClick={() => {
                setReceipt(undefined);
                setDialogOpen(true);
              }}
            >
              {data.enabled ? t('egp.connection.header.disable.action') : t('egp.connection.header.enable.action')}
            </button>
          </div>
        )}
      </div>
      <ContextBar
        items={[
          { label: t('egp.connection.context.scope.label'), value: tenant?.name ?? '–' },
          { label: t('egp.connection.context.connector.label'), value: data?.connector_code ?? CONNECTOR_CODE },
        ]}
        {...(asOf === undefined ? {} : { asOf })}
        stale={stale}
      />
      {receipt !== undefined && (
        <p className="callout egp1-receipt" role="status" data-testid="switch-receipt">
          {receipt.enabled
            ? t('egp.connection.success.enabled.text', { code: data?.connector_code ?? CONNECTOR_CODE, time: receipt.time })
            : t('egp.connection.success.disabled.text', { code: data?.connector_code ?? CONNECTOR_CODE, time: receipt.time })}
        </p>
      )}
      {block !== null && (
        <p className="callout" data-testid="readonly-note">
          {block === 'MODE' ? t('egp.connection.readonly.mode.text') : t('egp.connection.readonly.right.text')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="egp1-page">
            <ActionSection connection={data} />
            <StatusCard connection={data} />
            <FreshnessCard connection={data} />
            <CountsSection connection={data} />
            <PositionsSection connection={data} />
            <LayoutsSection connection={data} />
            <RunsSection connection={data} />
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
          onReload={reload}
        />
      )}
      <p className="prototype-note">{t('egp.connection.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
