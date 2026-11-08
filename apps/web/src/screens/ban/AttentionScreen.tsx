import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { clockText } from '../home/overview-model';
import { DecisionDialog, DirectiveDialog } from './attention-dialogs';
import { EmptyReason, FeedNotice, Guarded, PolicyNotice, ReasonList, useWords } from './components';
import { useAttention } from './hooks';
import { DECISION_WORD, PERMISSION, REASONS, REASON_STYLE, dayText, decisionsFrom, directivePath, may, stateOf } from './model';
import type { Attention, DecisionInput } from './model';

type Dialog = { kind: 'decision'; item: Attention; decision: DecisionInput['decision'] } | { kind: 'directive'; item: Attention };

function DecisionCell({ item }: { item: Attention }) {
  const { t } = useTranslation();
  const decision = item.decision;
  if (decision === null) return <StatusPill tone="neutral" icon="○">{t('ban.att.state.none')}</StatusPill>;
  const label = decision.decision === 'ACKNOWLEDGED' ? t('ban.att.state.acknowledged') : decision.decision === 'DEFERRED' ? t('ban.att.state.deferred') : decision.decision === 'DIRECTED' ? t('ban.att.state.directed') : t('ban.att.state.reopened');
  return (
    <div data-testid={`decision-${item.project_id}`} data-decision={DECISION_WORD[decision.decision]}>
      <StatusPill tone={decision.decision === 'DIRECTED' ? 'info' : decision.decision === 'REOPENED' ? 'warning' : 'success'} icon={decision.decision === 'DEFERRED' ? '◷' : '✓'}>
        {label}
      </StatusPill>
      {decision.defer_until === null ? null : <div className="ban-muted">{t('ban.att.state.until', { day: dayText(decision.defer_until) })}</div>}
      {decision.note === null ? null : <div className="ban-muted">{decision.note}</div>}
      <div className="ban-muted">{t('ban.att.state.by', { name: decision.decided_by_name ?? '–', day: dayText(decision.decided_at) })}</div>
      {decision.directive_id === null ? null : <Link to={directivePath(decision.directive_id)}>{t('ban.att.state.directive')}</Link>}
    </div>
  );
}

/**
 * BAN-02, the projects that need the head: ranked by the impact score, each with its reasons in words and shapes, the plan, what was disbursed against the curve, the amount at risk and the decision of the committee. A row
 * is acknowledged, deferred to a day (with a note), reopened, or becomes a directive of DIR from the row itself. A decision is a new line of an append-only log; the latest one is the state of the row.
 */
export default function AttentionScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Guarded route={route} permission={PERMISSION.read} title={t('ban.att.page.title')} subtitle={t('ban.att.page.subtitle')}>
      <AttentionContent />
    </Guarded>
  );
}

function AttentionContent() {
  const { t } = useTranslation();
  const words = useWords();
  const { tenant, permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const reason = REASONS.find((one) => one === params.get('reason')) ?? '';
  const includeDeferred = params.get('deferred') === '1';
  const query = useAttention({ reason, includeDeferred });
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<{ text: string; directive?: string } | undefined>(undefined);
  const mayDecide = may(permissions, PERMISSION.decide);
  const mayDirect = mayDecide && may(permissions, PERMISSION.directive);

  const setFilter = (next: { reason?: string; deferred?: boolean }): void => {
    const target = new URLSearchParams();
    const r = next.reason ?? reason;
    const d = next.deferred ?? includeDeferred;
    if (r !== '') target.set('reason', r);
    if (d) target.set('deferred', '1');
    setParams(target);
  };

  const reasonLabel = (one: (typeof REASONS)[number]): string =>
    one === 'DELAYED' ? t('ban.reason.delayed.label') : one === 'STALLED_PROCEDURE' ? t('ban.reason.stalled.label') : one === 'OVER_BUDGET_RISK' ? t('ban.reason.overBudget.label') : one === 'DISBURSEMENT_FAR_BELOW_PLAN' ? t('ban.reason.farBelow.label') : t('ban.reason.notReporting.label');
  const actionLabel = (decision: DecisionInput['decision']): string => (decision === 'ACKNOWLEDGED' ? t('ban.att.action.acknowledge') : decision === 'DEFERRED' ? t('ban.att.action.defer') : t('ban.att.action.reopen'));

  const columns: DataTableColumn<Attention>[] = [
    { key: 'rank', header: t('ban.att.col.rank'), align: 'right', render: (item) => item.rank },
    {
      key: 'project',
      header: t('ban.att.col.project'),
      pinned: true,
      render: (item) => (
        <div>
          <strong>{item.code}</strong> {item.name}
          <div className="ban-muted">{t('ban.att.project.where', { sector: item.sector_name, district: item.district_name, investor: item.investor_name })}</div>
        </div>
      ),
    },
    { key: 'reasons', header: t('ban.att.col.reasons'), render: (item) => <ReasonList signals={item.signals} /> },
    { key: 'plan', header: t('ban.att.col.plan'), align: 'right', render: (item) => words.vnd(item.plan_vnd) },
    { key: 'disbursed', header: t('ban.att.col.disbursed'), align: 'right', render: (item) => words.vnd(item.disbursed_vnd) },
    { key: 'rate', header: t('ban.att.col.rate'), align: 'right', render: (item) => t('ban.att.rate.text', { rate: words.pct(item.rate_pct), expected: words.pct(item.expected_pct) }) },
    { key: 'exposure', header: t('ban.att.col.exposure'), align: 'right', render: (item) => words.vnd(item.exposure_vnd) },
    { key: 'score', header: t('ban.att.col.score'), align: 'right', render: (item) => words.num(item.score) },
    { key: 'decision', header: t('ban.att.col.decision'), render: (item) => <DecisionCell item={item} /> },
    {
      key: 'actions',
      header: t('ban.att.col.actions'),
      render: (item) => {
        const state = stateOf(item);
        const offered = decisionsFrom(state);
        if (!mayDecide) return <span className="ban-muted">{t('ban.att.actions.noRight')}</span>;
        return (
          <div className="ban-actions">
            {offered.map((decision) =>
              decision === 'DIRECTED' ? (
                mayDirect ? (
                  <button key={decision} type="button" className="ui-button ui-button--primary ui-button--small" data-testid={`direct-${item.project_id}`} onClick={() => setDialog({ kind: 'directive', item })}>
                    {t('ban.att.action.direct')}
                  </button>
                ) : null
              ) : (
                <button key={decision} type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`${decision.toLowerCase()}-${item.project_id}`} onClick={() => setDialog({ kind: 'decision', item, decision })}>
                  {actionLabel(decision)}
                </button>
              ),
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <ContextBar
        items={[
          { label: t('ban.dash.context.scope'), value: tenant?.name ?? '–' },
          { label: t('ban.dash.context.asOf'), value: data === undefined ? '–' : dayText(data.as_of) },
        ]}
        unit={t('ban.dash.unit.vnd')}
        {...(query.dataUpdatedAt > 0 ? { asOf: clockText(query.dataUpdatedAt) } : {})}
        stale={query.isError && data !== undefined}
      />
      {data === undefined ? null : (
        <>
          <PolicyNotice policy={data.policy} />
          <FeedNotice feed={data.feed} />
        </>
      )}
      <div className="ban-audit-filters" role="group" aria-label={t('ban.att.filter.aria')}>
        <label htmlFor="ban-att-reason">
          <span>{t('ban.att.filter.reason')}</span>
          <select id="ban-att-reason" value={reason} onChange={(event) => setFilter({ reason: event.target.value })}>
            <option value="">{t('ban.att.filter.allReasons')}</option>
            {REASONS.map((one) => (
              <option key={one} value={one}>
                {`${REASON_STYLE[one].icon} ${reasonLabel(one)}`}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="ban-att-deferred">
          <input id="ban-att-deferred" type="checkbox" checked={includeDeferred} onChange={(event) => setFilter({ deferred: event.target.checked })} /> {t('ban.att.filter.deferred')}
        </label>
      </div>
      {receipt === undefined ? null : (
        <p className="callout" role="status" data-testid="receipt">
          {receipt.text} {receipt.directive === undefined ? null : <Link to={directivePath(receipt.directive)}>{t('ban.att.receipt.open')}</Link>}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : data.items.length === 0 ? (
          <EmptyReason
            testId="attention-empty"
            text={data.feed.empty ? t('ban.att.empty.noData.text') : reason !== '' || includeDeferred ? t('ban.att.empty.filtered.text') : t('ban.att.empty.none.text')}
            action={
              reason !== '' || includeDeferred ? (
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setParams(new URLSearchParams())}>
                  {t('ban.dash.filter.clear')}
                </button>
              ) : undefined
            }
          />
        ) : (
          <>
            <p className="ban-muted" data-testid="attention-count">
              {t('ban.att.count.text', { shown: data.shown, total: data.total })}
            </p>
            <DataTable caption={t('ban.att.table.caption')} columns={columns} rows={data.items} rowKey={(item) => item.project_id} rowAttrs={(item) => ({ 'data-project': item.project_id })} />
          </>
        )}
      </StateBoundary>
      {dialog?.kind === 'decision' ? (
        <DecisionDialog
          item={dialog.item}
          decision={dialog.decision}
          onClose={() => setDialog(undefined)}
          onDone={(text) => {
            setDialog(undefined);
            setReceipt({ text });
          }}
        />
      ) : null}
      {dialog?.kind === 'directive' ? (
        <DirectiveDialog
          item={dialog.item}
          onClose={() => setDialog(undefined)}
          onDone={(text, result) => {
            setDialog(undefined);
            setReceipt({ text, directive: result.directiveId });
          }}
        />
      ) : null}
    </>
  );
}
