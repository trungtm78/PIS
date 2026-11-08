import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { IncidentPill, ReasonDialog, SeverityPill, refusalText } from './components';
import { useConnectors, useDecideIncident, useIncidents, useOpenIncident } from './hooks';
import { REASON_MIN, reasonOk, vietnamDateTime, word } from './model';
import type { Incident } from './model';
import './hub.css';

const STATE_FILTERS: ReadonlyArray<Incident['state'] | 'ALL'> = ['ALL', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED'];

/**
 * HUB-03, the log of incidents of the connectors (HUB-1): the hub opens one incident for a failing or stale connector (and one when many are stale at once), closes it by itself when the condition clears, and a person
 * can report one, take it and close it, each step with a reason. Nothing here is deleted: the history of every incident is kept. Each incident shows the alert type behind it (owner, expected action, consequence).
 */
export default function IncidentScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <IncidentContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Step = { incident: Incident; decision: 'ACKNOWLEDGE' | 'RESOLVE' } | 'report';

function IncidentContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const connectorCode = params.get('connector') ?? undefined;
  const requested = params.get('state');
  const stateFilter = STATE_FILTERS.find((one) => one === requested) ?? 'ALL';
  const query = useIncidents({ state: stateFilter === 'ALL' ? undefined : stateFilter, connectorCode });
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data });
  const refreshFailed = query.isError && data !== undefined;
  const [step, setStep] = useState<Step | undefined>(undefined);
  const columns: DataTableColumn<Incident>[] = [
    {
      key: 'incident',
      header: t('hub.inc.col.incident'),
      pinned: true,
      render: (incident) => (
        <>
          <strong data-testid={`incident-${incident.id}`}>{incident.connector_code === null ? t('hub.inc.hubWide') : incident.connector_code}</strong>
          <div>{t(`hub.inc.kind.${word(incident.kind)}`)}</div>
          {incident.summary === null ? null : <div className="hub-muted">{incident.summary}</div>}
        </>
      ),
    },
    { key: 'severity', header: t('hub.inc.col.severity'), render: (incident) => <SeverityPill severity={incident.severity} /> },
    { key: 'state', header: t('hub.inc.col.state'), render: (incident) => <IncidentPill state={incident.state} /> },
    { key: 'opened', header: t('hub.inc.col.opened'), render: (incident) => `${vietnamDateTime(incident.opened_at)} ${incident.opened_by === null ? t('hub.inc.byHub') : ''}` },
    {
      key: 'alert',
      header: t('hub.inc.col.alert'),
      render: (incident) =>
        incident.alert === null ? (
          '–'
        ) : (
          <>
            <div>{incident.alert.expected_action ?? '–'}</div>
            <div className="hub-muted">{incident.alert.consequence ?? ''}</div>
          </>
        ),
    },
    { key: 'closed', header: t('hub.inc.col.resolution'), render: (incident) => (incident.resolved_at === null ? '–' : `${vietnamDateTime(incident.resolved_at)}: ${incident.resolution ?? ''}`) },
    {
      key: 'act',
      header: t('hub.inc.col.action'),
      render: (incident) =>
        incident.state === 'RESOLVED' ? null : (
          <>
            {incident.state === 'OPEN' ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`ack-${incident.id}`} onClick={() => setStep({ incident, decision: 'ACKNOWLEDGE' })}>
                {t('hub.inc.acknowledge')}
              </button>
            ) : null}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`resolve-${incident.id}`} onClick={() => setStep({ incident, decision: 'RESOLVE' })}>
              {t('hub.inc.resolve')}
            </button>
          </>
        ),
    },
  ];
  const choose = (next: string): void => setParams({ ...(connectorCode === undefined ? {} : { connector: connectorCode }), ...(next === 'ALL' ? {} : { state: next }) });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('hub.inc.page.title')}</h1>
          <p>{t('hub.inc.page.subtitle')}</p>
        </div>
        <button type="button" className="ui-button ui-button--outline" data-testid="report-incident" onClick={() => setStep('report')}>
          {t('hub.inc.report')}
        </button>
      </div>
      <ContextBar
        items={[
          { label: t('hub.cat.context.scope'), value: tenant?.name ?? '–' },
          { label: t('hub.inc.context.connector'), value: connectorCode ?? t('hub.inc.context.all') },
        ]}
        {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })}
        stale={refreshFailed}
      />
      <div className="hub-filter" role="group" aria-label={t('hub.inc.filter.label')}>
        {STATE_FILTERS.map((one) => (
          <button key={one} type="button" className={`ui-button ui-button--small ${stateFilter === one ? 'ui-button--primary' : 'ui-button--outline'}`} aria-pressed={stateFilter === one} data-testid={`filter-${one}`} onClick={() => choose(one)}>
            {t(`hub.inc.filter.${word(one)}`)}
          </button>
        ))}
        {connectorCode === undefined ? null : (
          <Link to="/hub/hub-03" data-testid="clear-connector">
            {t('hub.inc.filter.clear')}
          </Link>
        )}
      </div>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && <DataTable caption={t('hub.inc.table.caption')} columns={columns} rows={data.items} rowKey={(incident) => incident.id} />}
      </StateBoundary>
        {query.hasNextPage === true ? (
          <button type="button" className="ui-button ui-button--outline" data-testid="more-incidents" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {t('hub.common.more')}
          </button>
        ) : null}

      {step === undefined ? null : step === 'report' ? <ReportDialog preset={connectorCode} onClose={() => setStep(undefined)} /> : <DecideDialog step={step} onClose={() => setStep(undefined)} />}
      <p className="prototype-note">{t('hub.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function DecideDialog({ step, onClose }: { step: Exclude<Step, 'report'>; onClose: () => void }) {
  const { t } = useTranslation();
  const decide = useDecideIncident();
  const [error, setError] = useState<string | undefined>(undefined);
  const resolving = step.decision === 'RESOLVE';
  return (
    <ReasonDialog
      title={resolving ? t('hub.inc.dlg.resolve.title') : t('hub.inc.dlg.ack.title')}
      context={[
        { label: t('hub.inc.col.incident'), value: step.incident.connector_code ?? t('hub.inc.hubWide') },
        { label: t('hub.inc.col.state'), value: t(`hub.incident.state.${word(step.incident.state)}`) },
      ]}
      confirmLabel={resolving ? t('hub.inc.resolve') : t('hub.inc.acknowledge')}
      pending={decide.isPending}
      error={error}
      onCancel={onClose}
      onConfirm={(reason) => decide.mutate({ id: step.incident.id, version: step.incident.version, decision: step.decision, reason }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) })}
    />
  );
}

function ReportDialog({ preset, onClose }: { preset: string | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const connectors = useConnectors();
  const open = useOpenIncident();
  const codes = connectors.data?.items.map((item) => item.code) ?? [];
  const [code, setCode] = useState(preset ?? '');
  const [severity, setSeverity] = useState<Incident['severity']>('ACTION');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const chosen = code === '' ? codes[0] ?? '' : code;
  return (
    <ConfirmDialog
      open
      title={t('hub.inc.dlg.report.title')}
      context={[]}
      confirmLabel={t('hub.inc.report')}
      cancelLabel={t('hub.dialog.cancel')}
      pending={open.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        if (chosen === '' || !reasonOk(summary)) {
          setError(t('hub.inc.dlg.report.invalid', { min: REASON_MIN }));
          return;
        }
        open.mutate({ connectorCode: chosen, summary: summary.trim(), severity }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <label className="hub-field">
        {t('hub.inc.dlg.report.connector')}
        <select value={chosen} data-testid="report-connector" onChange={(event) => setCode(event.target.value)}>
          {codes.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </label>
      <label className="hub-field">
        {t('hub.inc.dlg.report.severity')}
        <select value={severity} data-testid="report-severity" onChange={(event) => setSeverity(event.target.value as Incident['severity'])}>
          {(['URGENT', 'ACTION', 'WATCH'] as const).map((one) => (
            <option key={one} value={one}>
              {t(`hub.severity.${word(one)}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="hub-field">
        {t('hub.inc.dlg.report.summary')}
        <textarea rows={4} value={summary} data-testid="report-summary" onChange={(event) => setSummary(event.target.value)} />
      </label>
    </ConfirmDialog>
  );
}
