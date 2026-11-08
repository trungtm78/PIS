import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { LADDER_PAGE, useLadderItem, useLadderKpi, useLadderPolicies, useLadderRuns } from './hooks';
import type { LadderPolicyView, LadderRunView } from './model';
import { Pager, Provenance, RungPill, channelLabel, when } from './parts';

const STATES = ['ACTIVE', 'DONE', 'ESCALATED', 'EXHAUSTED', 'EXPIRED'] as const;

type T = ReturnType<typeof useTranslation>['t'];

function severityLabel(t: T, severity: string): string {
  switch (severity) {
    case 'URGENT':
      return t('gov10.ladder.severity.urgent');
    case 'ACTION':
      return t('gov10.ladder.severity.action');
    default:
      return t('gov10.ladder.severity.watch');
  }
}

function runStateLabel(t: T, state: string): string {
  switch (state) {
    case 'ACTIVE':
      return t('gov10.ladder.run.active');
    case 'DONE':
      return t('gov10.ladder.run.done');
    case 'ESCALATED':
      return t('gov10.ladder.run.escalated');
    case 'EXHAUSTED':
      return t('gov10.ladder.run.exhausted');
    default:
      return t('gov10.ladder.run.expired');
  }
}

function doneByLabel(t: T, doneBy: string | null): string {
  switch (doneBy) {
    case 'RECEIPT':
      return t('gov10.ladder.doneBy.receipt');
    case 'ACTED':
      return t('gov10.ladder.doneBy.acted');
    case 'CLEARED':
      return t('gov10.ladder.doneBy.cleared');
    default:
      return '';
  }
}

/**
 * NOT-30: the channel ladder of the alerts and what became of each message. The ladder in force for each level (the rungs in order, how long each waits for a receipt, what happens at the end) with the "i" of its rule and the
 * label "default, not confirmed"; the delivery KPI of urgent alerts (receipt within the line, median time, escalated, ran out, and for each channel how its rungs ended: a rung with no workflow to carry it is counted apart,
 * because it is a gap in the setup and not a failure of a provider); and the ladders that run and ran, each with the receipt of every rung. A message of the ladder carries no figure of money.
 */
export default function AlertLadderScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <LadderContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LadderContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [state, setState] = useState('');
  const [offset, setOffset] = useState(0);
  const policies = useLadderPolicies();
  const kpi = useLadderKpi();
  const runs = useLadderRuns({ state: state === '' ? undefined : state, offset });
  const screenState = useScreenState({ isLoading: policies.isLoading, error: policies.data === undefined ? policies.error : undefined, data: policies.data, isEmpty: () => false });
  const stale = policies.data !== undefined && (policies.isError || runs.isError || kpi.isError);
  const denied = policies.data?.denied === true;
  const urgent = kpi.data?.urgent;

  const columns: DataTableColumn<LadderRunView>[] = [
    { key: 'item', header: t('gov10.ladder.column.item'), pinned: true, render: (row) => (row.alertType ?? row.source) },
    { key: 'severity', header: t('gov10.ladder.column.severity'), render: (row) => severityLabel(t, row.severity) },
    { key: 'state', header: t('gov10.ladder.column.state'), render: (row) => <>{runStateLabel(t, row.state)} {row.doneBy === null ? null : <span className="dis-code">{doneByLabel(t, row.doneBy)}</span>}</> },
    { key: 'started', header: t('gov10.ladder.column.started'), render: (row) => <time dateTime={row.startedAt}>{when(row.startedAt)}</time> },
    { key: 'next', header: t('gov10.ladder.column.next'), render: (row) => (row.state === 'ACTIVE' ? when(row.nextAt) : '—') },
    {
      key: 'rungs',
      header: t('gov10.ladder.column.rungs'),
      render: (row) => (row.rungs.length === 0 ? t('gov10.ladder.noRungs') : row.rungs.map((rung) => <RungPill key={rung.index} channel={rung.channel} state={rung.state} reason={rung.reason} />)),
    },
    { key: 'policy', header: t('gov10.ladder.column.policy'), render: (row) => (row.policyVersion === 'builtin' ? t('gov10.info.versionDefault') : t('gov10.info.versionRule', { version: row.policyVersion })) },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov10.ladder.title')}</h1>
          <p>{t('gov10.ladder.subtitle')}</p>
        </div>
      </div>
      <div className="gov10-stack">
        <p className="gov10-notice">{t('gov10.ladder.noFigures')}</p>
        {stale ? (
          <p className="gov10-notice gov10-notice--warn" role="status" data-testid="ladder-stale">
            {t('gov10.ladder.stale')}{' '}
            <button type="button" className="mv-alert-link" onClick={() => void Promise.all([policies.refetch(), kpi.refetch(), runs.refetch()])}>
              {t('gov10.state.retry.label')}
            </button>
          </p>
        ) : null}
        <StateBoundary state={screenState} onRetry={() => void policies.refetch()}>
          {denied ? (
            <p className="gov10-notice" role="alert" data-testid="ladder-denied">
              {t('gov10.ladder.denied')}
            </p>
          ) : (
            <>
              <ContextBar items={[{ label: t('gov10.ladder.ctx.runs'), value: String(kpi.data?.runs ?? 0) }, { label: t('gov10.ladder.ctx.period'), value: kpi.data === undefined ? '—' : `${kpi.data.from} / ${kpi.data.to}` }]} {...(kpi.data === undefined || kpi.data.asOf === '' ? {} : { asOf: kpi.data.asOf })} stale={stale} />
              <SectionCard title={t('gov10.ladder.policy.title')}>
                {(policies.data?.ladders ?? []).map((ladder: LadderPolicyView) => (
                  <div key={ladder.severity} data-testid={`ladder-${ladder.severity}`}>
                    <h3>
                      {severityLabel(t, ladder.severity)}{' '}
                      <Provenance
                        name={t('gov10.ladder.policy.name', { severity: severityLabel(t, ladder.severity) })}
                        formula={ladder.formula}
                        source={ladder.source}
                        asOf={ladder.ruleAsOf}
                        version={ladder.version === 'builtin' ? t('gov10.info.versionDefault') : t('gov10.info.versionRule', { version: ladder.version })}
                        unverified={ladder.unverified}
                        owner={t('gov10.ladder.owner')}
                      />
                      {ladder.unverified ? <StatusPill tone="warning">{t('gov10.info.unverified')}</StatusPill> : null}
                    </h3>
                    <ol className="gov10-ladder-path">
                      {ladder.rungs.map((rung, index) => (
                        <li key={rung.index}>
                          {channelLabel(t, rung.channel)}
                          {index < ladder.rungs.length - 1 ? ` (${t('gov10.ladder.policy.wait', { minutes: rung.waitMinutes })})` : ''}
                          {index < ladder.rungs.length - 1 ? ' →' : ''}
                        </li>
                      ))}
                      <li>{ladder.handOff === 'ESCALATE' ? t('gov10.ladder.policy.handOff', { minutes: ladder.handOffAfterMinutes }) : t('gov10.ladder.policy.noHandOff')}</li>
                    </ol>
                    <p>{ladder.stopWhen === 'SEEN' ? t('gov10.ladder.policy.stopSeen') : t('gov10.ladder.policy.stopDelivered')}</p>
                  </div>
                ))}
              </SectionCard>
              <SectionCard
                title={t('gov10.ladder.kpi.title')}
                status={<Provenance name={t('gov10.ladder.kpi.title')} formula={kpi.data?.formula ?? null} source={t('gov10.ladder.kpi.source')} asOf={kpi.data?.asOf ?? null} version={t('gov10.info.versionDefault')} unverified={kpi.data?.unverified ?? true} owner={t('gov10.ladder.owner')} />}
              >
                {kpi.isLoading ? (
                  <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
                ) : kpi.data === undefined ? (
                  <p role="alert" data-testid="kpi-error">
                    {t('gov10.ladder.kpi.failed')}{' '}
                    <button type="button" className="mv-alert-link" onClick={() => void kpi.refetch()}>
                      {t('gov10.state.retry.label')}
                    </button>
                  </p>
                ) : (
                  <>
                    <KpiStrip>
                      <KpiTile label={t('gov10.ladder.kpi.within', { minutes: urgent?.withinMinutes ?? 0 })} value={urgent?.sharePct === null || urgent === undefined ? t('gov10.ladder.kpi.none') : `${urgent.sharePct}%`} sub={t('gov10.ladder.kpi.withinSub', { count: urgent?.receiptedWithin ?? 0, total: urgent?.runs ?? 0 })} />
                      <KpiTile label={t('gov10.ladder.kpi.median')} value={urgent?.medianMinutes === null || urgent === undefined ? t('gov10.ladder.kpi.none') : t('gov10.ladder.kpi.minutes', { minutes: urgent.medianMinutes })} />
                      <KpiTile label={t('gov10.ladder.kpi.escalated')} value={String(urgent?.escalated ?? 0)} tone={(urgent?.escalated ?? 0) > 0 ? 'warning' : 'default'} />
                      <KpiTile label={t('gov10.ladder.kpi.exhausted')} value={String(urgent?.exhausted ?? 0)} tone={(urgent?.exhausted ?? 0) > 0 ? 'danger' : 'default'} />
                    </KpiStrip>
                    <table className="ui-table" data-testid="channel-table">
                      <caption>{t('gov10.ladder.channels.title')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('gov10.ladder.channels.channel')}</th>
                          <th scope="col">{t('gov10.ladder.channels.sent')}</th>
                          <th scope="col">{t('gov10.ladder.channels.delivered')}</th>
                          <th scope="col">{t('gov10.ladder.channels.seen')}</th>
                          <th scope="col">{t('gov10.ladder.channels.failed')}</th>
                          <th scope="col">{t('gov10.ladder.channels.suppressed')}</th>
                          <th scope="col">{t('gov10.ladder.channels.noWorkflow')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpi.data.byChannel.map((entry) => (
                          <tr key={entry.channel}>
                            <th scope="row">{channelLabel(t, entry.channel)}</th>
                            <td>{entry.sent}</td>
                            <td>{entry.delivered}</td>
                            <td>{entry.seen}</td>
                            <td>{entry.failed}</td>
                            <td>{entry.suppressed}</td>
                            <td>{entry.noWorkflow > 0 ? <StatusPill tone="warning">{entry.noWorkflow}</StatusPill> : entry.noWorkflow}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </SectionCard>
              <SectionCard title={t('gov10.ladder.runs.title')}>
                <div className="gov10-filters">
                  <label>
                    <span>{t('gov10.ladder.filter.state')}</span>
                    <select
                      value={state}
                      onChange={(event) => {
                        setState(event.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="">{t('gov10.ladder.filter.all')}</option>
                      {STATES.map((entry) => (
                        <option key={entry} value={entry}>
                          {runStateLabel(t, entry)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Link to="/home/home-02" className="mv-alert-link">
                    {t('gov10.ladder.queueLink')}
                  </Link>
                </div>
                {runs.isLoading ? (
                  <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
                ) : runs.data === undefined ? (
                  <p role="alert" data-testid="runs-error">
                    {t('gov10.ladder.runs.failed')}{' '}
                    <button type="button" className="mv-alert-link" onClick={() => void runs.refetch()}>
                      {t('gov10.state.retry.label')}
                    </button>
                  </p>
                ) : runs.data.items.length === 0 ? (
                  <p className="gov10-notice" role="status" data-testid="runs-empty">
                    {state === '' ? t('gov10.ladder.runs.empty') : t('gov10.ladder.runs.emptyFiltered')}
                  </p>
                ) : (
                  <>
                    <DataTable caption={t('gov10.ladder.runs.title')} columns={columns} rows={runs.data.items} rowKey={(row) => row.id} severity={(row) => (row.state === 'ESCALATED' || row.state === 'EXHAUSTED' ? 'URGENT' : null)} />
                    <Pager offset={offset} size={LADDER_PAGE} hasMore={runs.data.hasMore} onOffset={setOffset} />
                  </>
                )}
              </SectionCard>
              <ItemLookup />
            </>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}

const SOURCE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The ladders and receipts of one alert item, found by its source and its identifier (the two values the alert centre shows on the item). Nothing is read until the person asks, and a lookup that finds nothing says so. */
function ItemLookup() {
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [asked, setAsked] = useState<{ source: string; sourceId: string } | undefined>(undefined);
  const [tried, setTried] = useState(false);
  const found = useLadderItem(asked?.source ?? '', asked?.sourceId ?? '', asked !== undefined);
  const sourceProblem = !SOURCE_CODE.test(source.trim());
  const idProblem = sourceId.trim() === '' || sourceId.trim().length > 200;
  return (
    <SectionCard title={t('gov10.ladder.item.title')}>
      <form
        className="gov10-filters"
        noValidate
        data-testid="item-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (sourceProblem || idProblem) return;
          setAsked({ source: source.trim(), sourceId: sourceId.trim() });
        }}
      >
        <label>
          <span>{t('gov10.ladder.item.source')}</span>
          <input value={source} aria-invalid={tried && sourceProblem} onChange={(event) => setSource(event.target.value.toUpperCase())} />
        </label>
        <label>
          <span>{t('gov10.ladder.item.id')}</span>
          <input value={sourceId} aria-invalid={tried && idProblem} onChange={(event) => setSourceId(event.target.value)} />
        </label>
        <button type="submit" className="mv-alert-button">
          {t('gov10.ladder.item.find')}
        </button>
      </form>
      {tried && (sourceProblem || idProblem) ? (
        <p role="alert" data-testid="item-invalid">
          {t('gov10.ladder.item.invalid')}
        </p>
      ) : null}
      {asked === undefined ? null : found.isLoading ? (
        <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
      ) : found.data === undefined ? (
        <p role="alert" data-testid="item-error">
          {t('gov10.ladder.item.failed')}{' '}
          <button type="button" className="mv-alert-link" onClick={() => void found.refetch()}>
            {t('gov10.state.retry.label')}
          </button>
        </p>
      ) : found.data.items.length === 0 ? (
        <p className="gov10-notice" role="status" data-testid="item-empty">
          {t('gov10.ladder.item.empty')}
        </p>
      ) : (
        <ul data-testid="item-runs">
          {found.data.items.map((run) => (
            <li key={run.id} data-testid={`item-run-${run.id}`}>
              <strong>{run.alertType ?? run.source}</strong> · {severityLabel(t, run.severity)} · {runStateLabel(t, run.state)}{' '}
              {run.doneBy === null ? null : <span className="dis-code">{doneByLabel(t, run.doneBy)}</span>}
              <time dateTime={run.startedAt}> {when(run.startedAt)}</time>{' '}
              {run.rungs.length === 0 ? t('gov10.ladder.noRungs') : run.rungs.map((rung) => <RungPill key={rung.index} channel={rung.channel} state={rung.state} reason={rung.reason} />)}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
