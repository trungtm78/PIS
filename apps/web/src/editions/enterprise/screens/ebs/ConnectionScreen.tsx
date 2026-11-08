import { useState } from 'react';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { ContextBar } from '../../../../ui';
import { switchBlock, vietnamStamp } from '../shared/format';
import { HistorySection, PendingSection, ReadonlyNote, SwitchDialog } from '../shared/parts';
import { ActionSection, FreshnessCard, LayoutSection, RunsSection, StatusCard } from './connection-components';
import { useEbsConnection, useSetEbsConnectionState } from './hooks';
import { ImportFlow } from './ImportFlow';
import { CONNECTOR_CODE } from './model';
import '../shared/shared.css';

/**
 * EBS-01, the connection to Oracle EBS (ENT-2, R18): what the connection is (a reader of files a person hands over, so the layout is a working assumption and PENDING-EXTERNAL), how fresh the data from it is by the
 * rule, the columns the file must carry, the import in steps (dry run, then apply, once per file) and what we are still waiting for. The screen opens no connection to Oracle EBS.
 */
export default function ConnectionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The connection belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ConnectionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ConnectionContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const query = useEbsConnection();
  const switcher = useSetEbsConnectionState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const block = data === undefined ? null : switchBlock(data.actions.may_switch, mode);
  const readOnly = mode === 'READ_ONLY';
  const stale = refreshFailed || data?.health.status === 'STALE';
  const asOf = data === undefined ? undefined : vietnamStamp(stale && !refreshFailed && data.health.last_import_at !== null ? data.health.last_import_at : data.as_of);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ebs.connection.page.title')}</h1>
          <p>{t('ebs.connection.page.subtitle')}</p>
        </div>
        {data !== undefined && block === null && (
          <div className="actions">
            <button
              type="button"
              className={data.enabled ? 'ui-button ui-button--outline' : 'ui-button ui-button--primary'}
              data-testid="switch-button"
              onClick={() => {
                setNote(undefined);
                setDialogOpen(true);
              }}
            >
              {data.enabled ? t('ebs.header.disable.action') : t('ebs.header.enable.action')}
            </button>
          </div>
        )}
      </div>
      <ContextBar
        items={[
          { label: t('ebs.context.scope.label'), value: tenant?.name ?? '–' },
          { label: t('ebs.context.connector.label'), value: data?.connector_code ?? CONNECTOR_CODE },
        ]}
        {...(asOf === undefined ? {} : { asOf })}
        stale={stale}
      />
      {note !== undefined && (
        <p className="callout ent2-receipt" role="status" data-testid="switch-receipt">
          {note}
        </p>
      )}
      {data !== undefined && (readOnly ? <ReadonlyNote block="MODE" /> : block === 'RIGHT' && !data.actions.may_import ? <ReadonlyNote block="RIGHT" /> : null)}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="ent2-page">
            <ActionSection connection={data} />
            <StatusCard connection={data} />
            <FreshnessCard connection={data} />
            <ImportFlow connection={data} canPreview={!readOnly && data.actions.may_preview} canApply={!readOnly && data.actions.may_import} />
            <LayoutSection connection={data} />
            <RunsSection connection={data} />
            <PendingSection items={data.pending_external} />
            <HistorySection history={data.history} />
          </div>
        )}
      </StateBoundary>
      {dialogOpen && data !== undefined && (
        <SwitchDialog
          connectorCode={data.connector_code}
          enabled={data.enabled}
          version={data.version}
          mutation={switcher}
          onClose={() => setDialogOpen(false)}
          onDone={(enabled) => {
            setDialogOpen(false);
            setNote(enabled ? t('ebs.switch.done.enabled') : t('ebs.switch.done.disabled'));
          }}
          onReload={() => void query.refetch()}
        />
      )}
      <p className="prototype-note">{t('ebs.connection.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
