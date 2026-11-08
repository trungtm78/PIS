import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { pathOfAlert } from '../../ui/alerts/AlertRow';
import { Banner, FigureInfo, RuleNote, TONE_OF, momentText, personText, problemText } from './components';
import { useAcknowledgeEscalation, useEscalations } from './hooks';
import { escalationStatusText, kindText, severityText, sourceText, triggerText, viaText } from './labels';
import { HEALTH_PERMISSION, SEVERITIES } from './model';
import type { EscalationPolicyView, EscalationRow, EscalationStep } from './model';

type T = Translator['t'];

function stepText(t: T, step: EscalationStep): string {
  const what = step.kind === 'HIERARCHICAL' ? t('alertgov.escalation.step.hierarchical', { levels: step.levelsUp ?? 1 }) : t('alertgov.escalation.step.functional', { role: step.functionRole ?? '' });
  return t('alertgov.escalation.step.after', { what, hours: step.afterWorkingHours });
}

/** The chain in force: the levels of each severity, what starts the climb, the hold after an acknowledgement and the raising of an item to be watched. */
function PolicyView({ policy }: { policy: EscalationPolicyView }) {
  const { t } = useTranslation();
  return (
    <div className="alertgov-stack" data-testid="policy">
      {SEVERITIES.map((severity) => (
        <div key={severity}>
          <strong>{severityText(t, severity)}</strong>
          {policy.steps[severity].length === 0 ? (
            <p className="alertgov-sub">{t('alertgov.escalation.policy.noLevels')}</p>
          ) : (
            <ol className="alertgov-steps" data-testid={`steps-${severity}`}>
              {policy.steps[severity].map((step, index) => (
                <li key={`${severity}:${index}`}>{stepText(t, step)}</li>
              ))}
            </ol>
          )}
          <span className="alertgov-sub">{t('alertgov.escalation.policy.hold', { hours: policy.holdHours[severity] })}</span>
        </div>
      ))}
      <p className="alertgov-sub">{t('alertgov.escalation.policy.triggers', { triggers: policy.triggers.map((one) => triggerText(t, one)).join(', ') })}</p>
      {policy.watchPromotion === null ? null : (
        <p className="alertgov-sub" data-testid="promotion">
          {policy.watchPromotion.enabled ? t('alertgov.escalation.policy.promotion', { days: policy.watchPromotion.afterWorkingDays }) : t('alertgov.escalation.policy.promotionOff')}
        </p>
      )}
    </div>
  );
}

/**
 * NOT-19: the monitor of escalations (G2-3). Each row is a level an item was sent up: which item, which level, whether the level is functional (a unit of expertise) or hierarchical (the line above the owner) or the raising of an item that was only to be
 * watched, what started it, who received it (and whose deputy answered when the receiver was away), when, and where it stands. The recipient of a level takes it up here (the server refuses anyone else); the chain in force is shown with its version, and
 * with the label of a starting value that nobody confirmed.
 */
export default function EscalationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <EscalationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EscalationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const mayRead = permissions === undefined || permissions.includes(HEALTH_PERMISSION);
  const escalations = useEscalations(status, mayRead);
  const acknowledge = useAcknowledgeEscalation();
  const queryState = useScreenState({ isLoading: escalations.isLoading, error: escalations.data === undefined ? escalations.error : undefined, data: escalations.data, isEmpty: (data) => (data as { items: unknown[] }).items.length === 0 });
  const state = mayRead ? queryState : 'denied';
  const data = escalations.data;
  const me = tenant?.membershipId;

  const columns: DataTableColumn<EscalationRow>[] = [
    {
      key: 'item',
      header: t('alertgov.escalation.column.item'),
      render: (row) => {
        const path = pathOfAlert({ target: row.target });
        return (
          <>
            {path === undefined ? <strong>{row.itemTitle}</strong> : <Link to={path}>{row.itemTitle}</Link>}
            <span className="alertgov-sub">{[sourceText(t, row.source), row.itemSubtitle].filter((part): part is string => part !== null && part !== '').join(' · ')}</span>
          </>
        );
      },
    },
    { key: 'level', header: t('alertgov.escalation.column.level'), align: 'right', render: (row) => (row.kind === 'PROMOTION' ? '—' : row.level) },
    { key: 'kind', header: t('alertgov.escalation.column.kind'), render: (row) => <StatusPill tone={row.kind === 'FUNCTIONAL' ? 'info' : row.kind === 'PROMOTION' ? 'warning' : 'neutral'}>{kindText(t, row.kind)}</StatusPill> },
    { key: 'trigger', header: t('alertgov.escalation.column.trigger'), render: (row) => triggerText(t, row.trigger) },
    {
      key: 'recipient',
      header: t('alertgov.escalation.column.recipient'),
      render: (row) => (
        <>
          {row.kind === 'PROMOTION' ? t('alertgov.escalation.promoted.text', { from: severityText(t, row.fromSeverity ?? 'WATCH') }) : personText(row.recipient)}
          {row.routedVia === 'PRIMARY' || row.routedVia === 'NONE' ? null : <span className="alertgov-sub">{viaText(t, row.routedVia)}</span>}
        </>
      ),
    },
    { key: 'owner', header: t('alertgov.escalation.column.owner'), render: (row) => personText(row.owner) },
    { key: 'reached', header: t('alertgov.escalation.column.reached'), render: (row) => momentText(row.reachedAt) },
    { key: 'status', header: t('alertgov.escalation.column.status'), render: (row) => <StatusPill tone={TONE_OF[row.status] ?? 'neutral'}>{escalationStatusText(t, row.status)}</StatusPill> },
    {
      key: 'action',
      header: t('alertgov.escalation.column.action'),
      render: (row) =>
        row.status === 'OPEN' && row.kind !== 'PROMOTION' && me !== undefined && row.recipient?.id.toLowerCase() === me.toLowerCase() ? (
          <button type="button" className="ui-button ui-button--primary ui-button--small" disabled={acknowledge.isPending} aria-label={t('alertgov.escalation.ack.label', { title: row.itemTitle })} onClick={() => acknowledge.mutate({ id: row.id })} data-testid={`ack-${row.id}`}>
            {acknowledge.isPending ? t('alertgov.escalation.ack.pending') : t('alertgov.escalation.ack.action')}
          </button>
        ) : null,
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('alertgov.escalation.title')}</h1>
          <p>{t('alertgov.escalation.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('alertgov.ctx.scope'), value: tenant?.name ?? t('alertgov.ctx.scopeAll') }]} {...(data === undefined ? {} : { asOf: momentText(data.asOf) })} />
      <FilterPanel>
        <div className="field">
          <label htmlFor="alertgov-status">{t('alertgov.escalation.filter.status')}</label>
          <select id="alertgov-status" value={status} onChange={(event) => setStatus(event.target.value === 'all' ? 'all' : 'open')} data-testid="status">
            <option value="open">{t('alertgov.escalation.filter.open')}</option>
            <option value="all">{t('alertgov.escalation.filter.all')}</option>
          </select>
        </div>
      </FilterPanel>
      {acknowledge.isError ? (
        <Banner tone="danger" role="alert" testId="ack-error">
          <span>{problemText(t, acknowledge.error)}</span>
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => acknowledge.reset()}>
            {t('alertgov.common.dismiss.action')}
          </button>
        </Banner>
      ) : null}
      {acknowledge.isSuccess ? (
        <Banner tone="info" testId="ack-done">
          <span>{t('alertgov.escalation.ack.done')}</span>
        </Banner>
      ) : null}
      <StateBoundary state={state} onRetry={() => void escalations.refetch()}>
        {data === undefined ? null : (
          <div className="alertgov-stack">
            {escalations.isError ? (
              <Banner tone="warning" testId="stale">
                <span>{t('alertgov.escalation.stale.text')}</span>
              </Banner>
            ) : null}
            <SectionCard title={t('alertgov.escalation.table.title')} unit={t('alertgov.escalation.table.count', { count: data.items.length })}>
              <DataTable<EscalationRow> caption={t('alertgov.escalation.table.caption')} columns={columns} rows={data.items} rowKey={(row) => row.id} severity={(row) => (row.status === 'CLOSED' ? null : row.severity)} />
            </SectionCard>
            <SectionCard title={t('alertgov.escalation.policy.title')} actions={<FigureInfo name={t('alertgov.escalation.policy.title')} formula={data.rule.formula} source={data.rule.source} asOf={data.asOf} rule={data.rule} />}>
              <RuleNote rule={data.rule} />
              {data.policy === null ? <p>{t('alertgov.escalation.policy.unreadable')}</p> : <PolicyView policy={data.policy} />}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
