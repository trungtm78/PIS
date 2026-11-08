import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { AcceptanceBadge, AgentPill, OutcomePill, ReasonDialog, StatusBadge, refusalText } from './components';
import { useAgents, useConnector, useDecideMapping, useDecideReject, useProposeMapping, useRejects, useRuns, useSetState } from './hooks';
import { DETAIL_TABS, MAPPING_VERSION, ageParts, parseMappingFields, stageLine, vietnamDateTime, word } from './model';
import type { Agent, Detail, DetailTab, Mapping, Pipeline, Reject, Run } from './model';
import './hub.css';

/**
 * HUB-02, one connector (HUB-1): the overview with the switch and the alerts it can raise, the runs, the ETL pipelines (stages, schedule, watermark, rejects that can be corrected and reprocessed), the mapping versions
 * (proposed by one person, decided by another), the differences it left, the credentials and collector agents, and the layouts and the freshness policy. Links lead into the screens the connector owns. The secret of a
 * connector is never shown (it is a reference to the vault), and a connector that waits for the other side says so.
 */
export default function ConnectorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ConnectorContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog =
  | { kind: 'state'; enable: boolean }
  | { kind: 'mapping'; mapping: Mapping; decision: 'APPROVE' | 'REJECT' }
  | { kind: 'reject'; reject: Reject; decision: 'REPROCESS' | 'DISCARD' }
  | { kind: 'propose' };

function ConnectorContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const code = params.get('code') ?? undefined;
  const requested = params.get('tab');
  const tab: DetailTab = DETAIL_TABS.find((one) => one === requested) ?? 'overview';
  const query = useConnector(code);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data });
  const refreshFailed = query.isError && data !== undefined;
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const choose = (next: DetailTab): void => setParams({ ...(code === undefined ? {} : { code }), tab: next });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('hub.det.page.title')}</h1>
          <p>{data === undefined ? t('hub.det.page.subtitle') : `${data.summary.code}: ${data.summary.name}`}</p>
        </div>
        <Link to="/hub/hub-01" className="ui-button ui-button--outline">
          {t('hub.det.back')}
        </Link>
      </div>
      <ContextBar items={[{ label: t('hub.cat.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={refreshFailed} />
      <StateBoundary state={code === undefined ? 'empty' : state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <div className="hub-head" data-testid="connector-head">
              <StatusBadge status={data.summary.status} /> <AcceptanceBadge acceptance={data.summary.acceptance} />
              {data.summary.figures_blocked ? <span className="hub-muted">{t('hub.det.figuresBlocked')}</span> : null}
            </div>
            <div role="tablist" aria-label={t('hub.det.tabs.label')} className="hub-tabs">
              {DETAIL_TABS.map((one) => (
                <button key={one} type="button" role="tab" id={`tab-${one}`} aria-selected={tab === one} aria-controls={`panel-${one}`} data-testid={`tab-${one}`} className={`hub-tab${tab === one ? ' hub-tab--on' : ''}`} onClick={() => choose(one)}>
                  {t(`hub.det.tab.${one}`)}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === 'overview' && <Overview data={data} onSwitch={() => setDialog({ kind: 'state', enable: !data.state.enabled })} />}
              {tab === 'runs' && <RunsTab code={data.summary.code} />}
              {tab === 'pipeline' && <PipelineTab data={data} onReject={(reject, decision) => setDialog({ kind: 'reject', reject, decision })} />}
              {tab === 'mapping' && <MappingTab data={data} onDecide={(mapping, decision) => setDialog({ kind: 'mapping', mapping, decision })} onPropose={() => setDialog({ kind: 'propose' })} />}
              {tab === 'differences' && <Differences data={data} />}
              {tab === 'credentials' && <Credentials data={data} />}
              {tab === 'layouts' && <Layouts data={data} />}
            </div>
            {dialog === undefined ? null : <Dialogs dialog={dialog} data={data} onClose={() => setDialog(undefined)} />}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('hub.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="hub-facts">
      {items.map(([label, value]) => (
        <div className="hub-facts__item" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Overview({ data, onSwitch }: { data: Detail; onSwitch: () => void }) {
  const { t } = useTranslation();
  const summary = data.summary;
  const age = ageParts(summary.age_hours);
  return (
    <>
      <SectionCard
        title={t('hub.det.overview.section')}
        actions={
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="switch-state" onClick={onSwitch}>
            {data.state.enabled ? t('hub.det.state.disable') : t('hub.det.state.enable')}
          </button>
        }
      >
        <Facts
          items={[
            [t('hub.det.fact.direction'), t(`hub.direction.${word(summary.direction)}`)],
            [t('hub.det.fact.age'), age === null ? t('hub.age.none') : t(`hub.age.${age.unit}`, { value: age.value })],
            [t('hub.det.fact.lastSuccess'), vietnamDateTime(summary.last_success_at)],
            [t('hub.det.fact.lastRun'), summary.last_run_at === null ? t('hub.run.never') : vietnamDateTime(summary.last_run_at)],
            [t('hub.det.fact.switch'), data.state.enabled ? t('hub.det.state.on') : t('hub.det.state.off', { reason: data.state.reason ?? '' })],
            [t('hub.det.fact.switchOwner'), t(`hub.det.owner.${word(data.state.owner)}`)],
            [t('hub.det.fact.owner'), summary.owner_role],
            [t('hub.det.fact.consumers'), summary.consumers.join(', ')],
            [t('hub.det.fact.openIncidents'), <Link key="i" to={`/hub/hub-03?connector=${encodeURIComponent(summary.code)}`}>{data.open_incidents}</Link>],
          ]}
        />
        <p>
          {summary.screens.length === 0 ? null : <strong>{t('hub.det.screens')}: </strong>}
          {summary.screens.map((screen) => (
            <Link key={screen.code} to={screen.route} className="hub-chip" data-testid={`screen-${screen.code}`}>
              {screen.code}
            </Link>
          ))}
        </p>
      </SectionCard>
      <SectionCard title={t('hub.det.alerts.section')}>
        <table className="hub-table">
          <caption className="hub-sr">{t('hub.det.alerts.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('hub.det.alerts.code')}</th>
              <th scope="col">{t('hub.det.alerts.owner')}</th>
              <th scope="col">{t('hub.det.alerts.action')}</th>
              <th scope="col">{t('hub.det.alerts.consequence')}</th>
            </tr>
          </thead>
          <tbody>
            {data.alert_types.map((alert) => (
              <tr key={alert.code}>
                <td>{alert.code}</td>
                <td>{alert.owner ?? '–'}</td>
                <td>{alert.expected_action ?? '–'}</td>
                <td>{alert.consequence ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
      <SectionCard title={t('hub.det.trend.section')}>
        {data.trend.length === 0 ? (
          <p className="hub-muted" data-testid="trend-empty">
            {t('hub.det.trend.empty')}
          </p>
        ) : (
          <ul className="hub-trend">
            {data.trend.map((point) => (
              <li key={point.at}>
                {vietnamDateTime(point.at)}: {point.status === null ? '–' : t(`hub.status.${word(point.status)}`)}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={t('hub.det.history.section')}>
        {data.state_events.length === 0 ? (
          <p className="hub-muted">{t('hub.det.history.empty')}</p>
        ) : (
          <ul className="hub-trend">
            {data.state_events.map((event) => (
              <li key={event.id}>
                {vietnamDateTime(event.occurred_at)}: {t(`hub.det.history.${word(event.action)}`)} {event.reason}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

function RunsTab({ code }: { code: string }) {
  const { t } = useTranslation();
  const runs = useRuns(code);
  const state = useScreenState({ isLoading: runs.isLoading, error: runs.data === undefined ? runs.error : undefined, data: runs.data });
  const columns: DataTableColumn<Run>[] = [
    { key: 'started', header: t('hub.runs.col.started'), pinned: true, render: (run) => vietnamDateTime(run.started_at) },
    { key: 'origin', header: t('hub.runs.col.origin'), render: (run) => t(`hub.runs.origin.${word(run.origin)}`) + (run.position === null ? '' : ` (${run.position})`) },
    { key: 'outcome', header: t('hub.runs.col.outcome'), render: (run) => <OutcomePill outcome={run.outcome} /> },
    { key: 'rows', header: t('hub.runs.col.rows'), align: 'right', render: (run) => stageLine(run) ?? '–' },
    { key: 'layout', header: t('hub.runs.col.layout'), render: (run) => run.layout_version ?? '–' },
    { key: 'error', header: t('hub.runs.col.error'), render: (run) => run.error_code ?? '–' },
    { key: 'dry', header: t('hub.runs.col.dry'), render: (run) => (run.dry_run ? t('hub.runs.dry') : '') },
  ];
  return (
    <SectionCard title={t('hub.runs.section')}>
      <p className="hub-muted">{t('hub.runs.legend')}</p>
      <StateBoundary state={state} onRetry={() => void runs.refetch()}>
        {runs.data !== undefined && <DataTable caption={t('hub.runs.caption')} columns={columns} rows={runs.data.items} rowKey={(run) => run.id} />}
      </StateBoundary>
    </SectionCard>
  );
}

function PipelineTab({ data, onReject }: { data: Detail; onReject: (reject: Reject, decision: 'REPROCESS' | 'DISCARD') => void }) {
  const { t } = useTranslation();
  const rejects = useRejects(data.summary.code);
  const rejectState = useScreenState({ isLoading: rejects.isLoading, error: rejects.data === undefined ? rejects.error : undefined, data: rejects.data });
  const pipelineColumns: DataTableColumn<Pipeline>[] = [
    { key: 'code', header: t('hub.pipe.col.pipeline'), pinned: true, render: (pipe) => <><strong>{pipe.code}</strong><div>{pipe.name}</div></> },
    { key: 'stages', header: t('hub.pipe.col.stages'), render: (pipe) => pipe.stages.map((stage) => t(`hub.pipe.stage.${word(stage)}`)).join(' → ') },
    { key: 'protocol', header: t('hub.pipe.col.protocol'), render: (pipe) => `${pipe.protocol} · ${t(`hub.pipe.mode.${word(pipe.mode)}`)}` },
    { key: 'schedule', header: t('hub.pipe.col.schedule'), render: (pipe) => (pipe.schedule.kind === 'MANUAL' ? t('hub.pipe.schedule.manual') : pipe.schedule.next_run_at === null ? '–' : t('hub.pipe.schedule.next', { at: vietnamDateTime(pipe.schedule.next_run_at) })) },
    { key: 'mark', header: t('hub.pipe.col.watermark'), render: (pipe) => pipe.watermark ?? t('hub.pipe.watermark.none') },
    { key: 'mapping', header: t('hub.pipe.col.mapping'), render: (pipe) => pipe.approved_mapping_version ?? <span className="hub-muted" data-testid={`unmapped-${pipe.code}`}>{t('hub.pipe.mapping.none')}</span> },
    { key: 'counts', header: t('hub.pipe.col.lastRun'), align: 'right', render: (pipe) => (pipe.last_run === null ? '–' : stageLine(pipe.last_run)) },
    { key: 'rejects', header: t('hub.pipe.col.rejects'), align: 'right', render: (pipe) => pipe.open_rejects },
  ];
  const rejectColumns: DataTableColumn<Reject>[] = [
    { key: 'ref', header: t('hub.rej.col.record'), pinned: true, render: (reject) => <><strong>{reject.record_key}</strong><div className="hub-muted">{reject.source_ref}</div></> },
    { key: 'pipe', header: t('hub.rej.col.pipeline'), render: (reject) => reject.pipeline_code },
    { key: 'stage', header: t('hub.rej.col.stage'), render: (reject) => t(`hub.pipe.stage.${word(reject.stage)}`) },
    { key: 'code', header: t('hub.rej.col.reason'), render: (reject) => reject.reject_code + (reject.field === null ? '' : ` (${reject.field})`) },
    {
      key: 'act',
      header: t('hub.rej.col.action'),
      render: (reject) => (
        <>
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`reprocess-${reject.id}`} onClick={() => onReject(reject, 'REPROCESS')}>
            {t('hub.rej.reprocess')}
          </button>{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`discard-${reject.id}`} onClick={() => onReject(reject, 'DISCARD')}>
            {t('hub.rej.discard')}
          </button>
        </>
      ),
    },
  ];
  return (
    <>
      <SectionCard title={t('hub.pipe.section')}>
        {data.pipelines.length === 0 ? (
          <p className="hub-muted" data-testid="no-pipelines">
            {t('hub.pipe.none')}
          </p>
        ) : (
          <DataTable caption={t('hub.pipe.caption')} columns={pipelineColumns} rows={data.pipelines} rowKey={(pipe) => pipe.code} />
        )}
        <p className="hub-muted">{t('hub.pipe.rule')}</p>
      </SectionCard>
      <SectionCard title={t('hub.rej.section')}>
        <StateBoundary state={rejectState} onRetry={() => void rejects.refetch()}>
          {rejects.data !== undefined && <DataTable caption={t('hub.rej.caption')} columns={rejectColumns} rows={rejects.data.items} rowKey={(reject) => reject.id} />}
        </StateBoundary>
      </SectionCard>
      <SectionCard title={t('hub.pipe.protocols.section')}>
        <table className="hub-table">
          <caption className="hub-sr">{t('hub.pipe.protocols.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('hub.pipe.protocols.code')}</th>
              <th scope="col">{t('hub.pipe.protocols.status')}</th>
              <th scope="col">{t('hub.pipe.protocols.egress')}</th>
              <th scope="col">{t('hub.pipe.protocols.security')}</th>
              <th scope="col">{t('hub.pipe.protocols.failure')}</th>
              <th scope="col">{t('hub.pipe.protocols.implementation')}</th>
            </tr>
          </thead>
          <tbody>
            {data.protocol_details.map((protocol) => (
              <tr key={`${protocol.code}-${protocol.status}`} data-testid={`protocol-${protocol.code}`}>
                <td>{protocol.code}</td>
                <td>{t(`hub.pipe.protocols.status.${word(protocol.status)}`)}</td>
                <td>{t(`hub.pipe.egress.${word(protocol.egress)}`)}</td>
                <td>{`${protocol.auth.join(' / ')}; TLS ${t(`hub.pipe.tls.${word(protocol.tls)}`)}; ${t('hub.pipe.signature', { value: t(`hub.pipe.signature.${word(protocol.signature)}`) })}`}</td>
                <td>{`${protocol.retry}; ${protocol.delivery}`}</td>
                <td>{t(`hub.pipe.impl.${word(protocol.implementation)}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </>
  );
}

function MappingTab({ data, onDecide, onPropose }: { data: Detail; onDecide: (mapping: Mapping, decision: 'APPROVE' | 'REJECT') => void; onPropose: () => void }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Mapping>[] = [
    { key: 'pipe', header: t('hub.map.col.pipeline'), pinned: true, render: (mapping) => mapping.pipeline_code },
    { key: 'version', header: t('hub.map.col.version'), render: (mapping) => mapping.mapping_version },
    { key: 'state', header: t('hub.map.col.state'), render: (mapping) => t(`hub.map.state.${word(mapping.state)}`) },
    { key: 'fields', header: t('hub.map.col.fields'), align: 'right', render: (mapping) => mapping.fields.length },
    { key: 'proposed', header: t('hub.map.col.proposed'), render: (mapping) => vietnamDateTime(mapping.proposed_at) },
    { key: 'decided', header: t('hub.map.col.decided'), render: (mapping) => (mapping.decided_at === null ? '–' : `${vietnamDateTime(mapping.decided_at)} ${mapping.decision_reason ?? ''}`) },
    {
      key: 'act',
      header: t('hub.map.col.action'),
      render: (mapping) =>
        mapping.state === 'PROPOSED' ? (
          <>
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`approve-${mapping.id}`} onClick={() => onDecide(mapping, 'APPROVE')}>
              {t('hub.map.approve')}
            </button>{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`reject-${mapping.id}`} onClick={() => onDecide(mapping, 'REJECT')}>
              {t('hub.map.reject')}
            </button>
          </>
        ) : null,
    },
  ];
  return (
    <SectionCard
      title={t('hub.map.section')}
      actions={
        data.pipelines.length === 0 ? undefined : (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="propose-mapping" onClick={onPropose}>
            {t('hub.map.propose')}
          </button>
        )
      }
    >
      <p className="hub-muted">{t('hub.map.rule')}</p>
      {data.mappings.length === 0 ? (
        <p className="hub-muted" data-testid="no-mappings">
          {t('hub.map.none')}
        </p>
      ) : (
        <DataTable caption={t('hub.map.caption')} columns={columns} rows={data.mappings} rowKey={(mapping) => mapping.id} />
      )}
    </SectionCard>
  );
}

function Differences({ data }: { data: Detail }) {
  const { t } = useTranslation();
  const summary = data.summary;
  return (
    <SectionCard title={t('hub.diff.section')}>
      <Facts
        items={[
          [t('hub.diff.open'), <span key="o" data-testid="diff-open">{summary.discrepancy_backlog}</span>],
          [t('hub.diff.mappings'), <span key="m" data-testid="diff-mappings">{summary.pending_mappings}</span>],
          [t('hub.diff.failed'), <span key="f">{summary.failed_runs_7d}</span>],
        ]}
      />
      <p className="hub-muted">{t('hub.diff.where')}</p>
      <p>
        {summary.screens.map((screen) => (
          <Link key={screen.code} to={screen.route} className="hub-chip">
            {screen.code}
          </Link>
        ))}
      </p>
    </SectionCard>
  );
}

function Credentials({ data }: { data: Detail }) {
  const { t } = useTranslation();
  const agents = useAgents(data.summary.code);
  const agentColumns: DataTableColumn<Agent>[] = [
    { key: 'code', header: t('hub.cred.agent.col.code'), pinned: true, render: (agent) => agent.agent_code },
    { key: 'platform', header: t('hub.cred.agent.col.platform'), render: (agent) => agent.platform },
    { key: 'version', header: t('hub.cred.agent.col.version'), render: (agent) => agent.agent_version },
    { key: 'beat', header: t('hub.cred.agent.col.heartbeat'), render: (agent) => (agent.last_heartbeat_at === null ? t('hub.cred.agent.never') : vietnamDateTime(agent.last_heartbeat_at)) },
    { key: 'spool', header: t('hub.cred.agent.col.spool'), align: 'right', render: (agent) => agent.spool_depth },
    { key: 'health', header: t('hub.cred.agent.col.health'), render: (agent) => <AgentPill health={agent.health} /> },
  ];
  return (
    <>
      <SectionCard title={t('hub.cred.section')}>
        <Facts
          items={[
            [t('hub.cred.kind'), t(`hub.cred.kind.${word(data.credentials.kind)}`)],
            [t('hub.cred.scopes'), data.credentials.scopes.length === 0 ? '–' : data.credentials.scopes.join(', ')],
            [t('hub.cred.store'), t('hub.cred.store.text')],
            [t('hub.cred.egress'), data.egress.policy === 'NONE' ? t('hub.cred.egress.none') : t('hub.cred.egress.declared', { hosts: data.egress.hosts.join(', ') })],
          ]}
        />
        <p className="hub-muted">{t('hub.cred.rule')}</p>
      </SectionCard>
      <SectionCard title={t('hub.cred.agent.section')}>
        {agents.data === undefined ? (
          <p className="hub-muted">{agents.isError ? t('hub.cred.agent.error') : t('hub.cred.agent.loading')}</p>
        ) : agents.data.items.length === 0 ? (
          <p className="hub-muted" data-testid="no-agents">
            {t('hub.cred.agent.none')}
          </p>
        ) : (
          <DataTable caption={t('hub.cred.agent.caption')} columns={agentColumns} rows={agents.data.items} rowKey={(agent) => agent.id} />
        )}
        <p className="hub-muted">{t('hub.cred.agent.stale', { minutes: agents.data?.stale_after_minutes ?? '–' })}</p>
      </SectionCard>
    </>
  );
}

function Layouts({ data }: { data: Detail }) {
  const { t } = useTranslation();
  const rule = data.freshness_rule;
  return (
    <>
      <SectionCard title={t('hub.lay.section')}>
        <table className="hub-table">
          <caption className="hub-sr">{t('hub.lay.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('hub.lay.col.layout')}</th>
              <th scope="col">{t('hub.lay.col.version')}</th>
              <th scope="col">{t('hub.lay.col.acceptance')}</th>
              <th scope="col">{t('hub.lay.col.pending')}</th>
            </tr>
          </thead>
          <tbody>
            {data.layouts.map((layout) => (
              <tr key={`${layout.code}-${layout.version}`}>
                <td>{layout.code}</td>
                <td>{layout.version}</td>
                <td>
                  <AcceptanceBadge acceptance={layout.acceptance} />
                </td>
                <td>{layout.pending.length === 0 ? '–' : layout.pending.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
      <SectionCard title={t('hub.lay.policy.section')}>
        {rule === null ? (
          <p className="hub-muted" data-testid="no-freshness">
            {t('hub.lay.policy.none')}
          </p>
        ) : (
          <>
            <Facts
              items={[
                [t('hub.lay.policy.rule'), `CONNECTOR_FRESHNESS / ${rule.rule_code}`],
                [t('hub.lay.policy.warn'), t('hub.age.hours', { value: rule.warn_after_hours })],
                [t('hub.lay.policy.max'), t('hub.age.hours', { value: rule.max_age_hours })],
                [t('hub.lay.policy.severity'), t(`hub.severity.${word(rule.stale_severity)}`)],
                [t('hub.lay.policy.blocked'), rule.figures_blocked_when_stale ? t('hub.lay.yes') : t('hub.lay.no')],
                [t('hub.lay.policy.origin'), t(`hub.lay.origin.${word(rule.source)}`, { version: rule.version })],
              ]}
            />
            {rule.formula === null ? null : <p>{rule.formula}</p>}
            {rule.source_text === null ? null : <p className="hub-muted">{`${t('hub.info.source')}: ${rule.source_text}`}</p>}
            {rule.unverified ? (
              <p className="callout" role="note" data-testid="unverified">
                {t('hub.info.unverified')}
              </p>
            ) : null}
          </>
        )}
      </SectionCard>
    </>
  );
}

function Dialogs({ dialog, data, onClose }: { dialog: Dialog; data: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const setState = useSetState();
  const decideMapping = useDecideMapping();
  const decideReject = useDecideReject();
  const propose = useProposeMapping();
  const [error, setError] = useState<string | undefined>(undefined);
  const [pipeline, setPipeline] = useState(data.pipelines[0]?.code ?? '');
  const [version, setVersion] = useState('');
  const [fieldsText, setFieldsText] = useState('');
  const fail = (failure: unknown): void => setError(refusalText(t, failure));

  if (dialog.kind === 'state') {
    return (
      <ReasonDialog
        title={dialog.enable ? t('hub.dlg.enable.title', { code: data.summary.code }) : t('hub.dlg.disable.title', { code: data.summary.code })}
        context={[{ label: t('hub.dlg.connector'), value: data.summary.code }]}
        confirmLabel={dialog.enable ? t('hub.dlg.enable.confirm') : t('hub.dlg.disable.confirm')}
        pending={setState.isPending}
        error={error}
        onCancel={onClose}
        onConfirm={(reason) => setState.mutate({ code: data.summary.code, version: data.state.version, enabled: dialog.enable, reason }, { onSuccess: onClose, onError: fail })}
      />
    );
  }
  if (dialog.kind === 'mapping') {
    return (
      <ReasonDialog
        title={dialog.decision === 'APPROVE' ? t('hub.dlg.approve.title', { version: dialog.mapping.mapping_version }) : t('hub.dlg.rejectMap.title', { version: dialog.mapping.mapping_version })}
        context={[{ label: t('hub.dlg.pipeline'), value: dialog.mapping.pipeline_code }]}
        confirmLabel={dialog.decision === 'APPROVE' ? t('hub.map.approve') : t('hub.map.reject')}
        pending={decideMapping.isPending}
        error={error}
        onCancel={onClose}
        onConfirm={(reason) => decideMapping.mutate({ id: dialog.mapping.id, version: dialog.mapping.version, decision: dialog.decision, reason }, { onSuccess: onClose, onError: fail })}
      />
    );
  }
  if (dialog.kind === 'reject') {
    return (
      <ReasonDialog
        title={dialog.decision === 'REPROCESS' ? t('hub.dlg.reprocess.title', { key: dialog.reject.record_key }) : t('hub.dlg.discard.title', { key: dialog.reject.record_key })}
        context={[
          { label: t('hub.dlg.pipeline'), value: dialog.reject.pipeline_code },
          { label: t('hub.rej.col.reason'), value: dialog.reject.reject_code },
        ]}
        confirmLabel={dialog.decision === 'REPROCESS' ? t('hub.rej.reprocess') : t('hub.rej.discard')}
        pending={decideReject.isPending}
        error={error}
        onCancel={onClose}
        onConfirm={(reason) => decideReject.mutate({ id: dialog.reject.id, version: dialog.reject.version, decision: dialog.decision, reason }, { onSuccess: onClose, onError: fail })}
      />
    );
  }
  const fields = parseMappingFields(fieldsText);
  const valid = pipeline !== '' && MAPPING_VERSION.test(version) && fields !== undefined;
  return (
    <ConfirmDialog
      open
      title={t('hub.dlg.propose.title', { code: data.summary.code })}
      context={[{ label: t('hub.dlg.connector'), value: data.summary.code }]}
      confirmLabel={t('hub.map.propose')}
      cancelLabel={t('hub.dialog.cancel')}
      pending={propose.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        if (!valid || fields === undefined) {
          setError(t('hub.dlg.propose.invalid'));
          return;
        }
        propose.mutate({ code: data.summary.code, pipelineCode: pipeline, mappingVersion: version, fields }, { onSuccess: onClose, onError: fail });
      }}
    >
      <label className="hub-field">
        {t('hub.dlg.propose.pipeline')}
        <select value={pipeline} data-testid="propose-pipeline" onChange={(event) => setPipeline(event.target.value)}>
          {data.pipelines.map((one) => (
            <option key={one.code} value={one.code}>
              {one.code}
            </option>
          ))}
        </select>
      </label>
      <label className="hub-field">
        {t('hub.dlg.propose.version')}
        <input value={version} data-testid="propose-version" onChange={(event) => setVersion(event.target.value)} />
      </label>
      <label className="hub-field">
        {t('hub.dlg.propose.fields')}
        <textarea rows={6} value={fieldsText} data-testid="propose-fields" onChange={(event) => setFieldsText(event.target.value)} />
      </label>
    </ConfirmDialog>
  );
}
