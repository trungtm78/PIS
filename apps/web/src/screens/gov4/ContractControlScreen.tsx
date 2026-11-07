import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import { useContractAvailability, useProjectEac } from './hooks';
import { asOfText, idFrom, vnd } from './model';
import type { AvcVerdict } from './model';
import './gov4.css';

const verdictTone = (verdict: AvcVerdict | null): 'success' | 'warning' | 'danger' | 'neutral' => (verdict === null ? 'neutral' : verdict.state === 'BLOCK' ? 'danger' : verdict.state === 'WARN' ? 'warning' : 'success');

/**
 * CAP-22: the availability control down to the contract and its changes, and the estimate at completion against the approved total investment (governance deepening G1-6, CAP-17 extended). A contract:
 * the price in force, what is asked for and paid, the advance still owed, what is left to pay, the capital line it commits against and each change order against the line it would be paid from. A
 * project: the estimate at completion against the approved total and the gap in capital. Reads only: the commands that move money keep their own refusals; this is where a person sees why one refuses.
 * Every number says its formula, its source and the time it was read.
 */
export default function ContractControlScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ContractControlContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContractControlContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const [params] = useSearchParams();
  const contractId = idFrom(params.get('contract'));
  const projectId = idFrom(params.get('project'));
  const contract = useContractAvailability(contractId);
  const eac = useProjectEac(projectId);
  const contractState = useScreenState({ isLoading: contract.isLoading, error: contract.error, data: contract.data, isEmpty: () => false });
  const eacState = useScreenState({ isLoading: eac.isLoading, error: eac.error, data: eac.data, isEmpty: () => false });
  const money = (value: string | null | undefined): string => vnd(value, locale);
  const statement = contract.data ?? undefined;
  const estimate = eac.data ?? undefined;
  const asOf = statement?.asOf ?? estimate?.asOf;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govb2.control.title')}</h1>
          <p>{t('govb2.control.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('govb2.ctx.scope'), value: tenant?.name ?? t('govb2.ctx.scope.all') }]} unit={t('govb2.control.unit')} {...(asOf === undefined ? {} : { asOf: asOfText(asOf) })} />
      {contractId === undefined && projectId === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('govb2.control.noTarget')}
        </p>
      ) : null}

      {projectId === undefined ? null : (
        <StateBoundary state={eacState} onRetry={() => void eac.refetch()}>
          {estimate === undefined ? (
            <p className="callout" data-testid="eac-missing">
              {t('govb2.control.eac.missing')}
            </p>
          ) : (
            <SectionCard title={t('govb2.control.eac.title', { code: estimate.projectCode })} unit={t('govb2.control.unit')}>
              <KpiStrip label={t('govb2.control.eac.title', { code: estimate.projectCode })}>
                <KpiTile label={t('govb2.control.eac.eac')} value={money(estimate.eacVnd)} sub={t('govb2.control.eac.method', { method: estimate.method })} />
                <KpiTile label={t('govb2.control.eac.approved')} value={money(estimate.approvedTotalVnd)} />
                <KpiTile label={t('govb2.control.eac.over')} value={money(estimate.overByVnd)} tone={estimate.raisesAlert ? 'danger' : 'default'} sub={estimate.overPct === null ? undefined : `${estimate.overPct}%`} />
                <KpiTile label={t('govb2.control.eac.gap')} value={money(estimate.fundingGapVnd)} tone={BigInt(estimate.fundingGapVnd || '0') > 0n ? 'warning' : 'default'} sub={t('govb2.control.eac.allocated', { amount: money(estimate.allocatedVnd) })} />
              </KpiStrip>
              <p data-testid="eac-verdict">
                <StatusPill tone={estimate.raisesAlert ? 'danger' : estimate.verdict === 'OVER' ? 'warning' : 'success'}>
                  {estimate.raisesAlert ? t('govb2.control.eac.verdict.alert') : estimate.verdict === 'OVER' ? t('govb2.control.eac.verdict.over') : t('govb2.control.eac.verdict.within')}
                </StatusPill>
              </p>
              <p className="muted" data-testid="eac-formula">
                {t('govb2.control.eac.formula', { tolerance: estimate.policy.eacAlertAbovePct, source: estimate.policy.source === 'DEFAULT' ? t('govb2.policy.default') : t('govb2.policy.rule', { version: estimate.policy.version ?? 0 }) })}
              </p>
            </SectionCard>
          )}
        </StateBoundary>
      )}

      {contractId === undefined ? null : (
        <StateBoundary state={contractState} onRetry={() => void contract.refetch()}>
          {statement === undefined ? (
            <p className="callout" data-testid="contract-missing">
              {t('govb2.control.contract.missing')}
            </p>
          ) : (
            <>
              <SectionCard title={t('govb2.control.contract.title', { code: statement.contract.code })} unit={t('govb2.control.unit')} status={<StatusPill tone={statement.money.withinPrice ? 'success' : 'danger'}>{statement.money.withinPrice ? t('govb2.control.within') : t('govb2.control.exceeds')}</StatusPill>}>
                <KpiStrip label={t('govb2.control.contract.title', { code: statement.contract.code })}>
                  <KpiTile label={t('govb2.control.price')} value={money(statement.money.currentPriceVnd)} sub={t('govb2.control.price.sub', { original: money(statement.money.originalPriceVnd), variation: money(statement.money.approvedVariationVnd) })} />
                  <KpiTile label={t('govb2.control.pending')} value={money(statement.money.pendingIncreaseVnd)} sub={t('govb2.control.pending.sub')} tone={BigInt(statement.money.pendingIncreaseVnd || '0') > 0n ? 'info' : 'default'} />
                  <KpiTile label={t('govb2.control.requested')} value={money(statement.money.requestedTotalVnd)} sub={statement.money.requestedPct === null ? undefined : t('govb2.control.requested.sub', { pct: statement.money.requestedPct, paid: money(statement.money.paidTotalVnd) })} />
                  <KpiTile label={t('govb2.control.advance')} value={money(statement.money.advanceOutstandingVnd)} sub={t('govb2.control.advance.sub')} />
                  <KpiTile label={t('govb2.control.remaining')} value={money(statement.money.remainingPayableVnd)} sub={t('govb2.control.remaining.sub', { headroom: money(statement.money.cashHeadroomVnd) })} />
                </KpiStrip>
                <p className="muted" data-testid="contract-formula">
                  {t('govb2.control.contract.formula')}
                </p>
              </SectionCard>

              <SectionCard title={t('govb2.control.line.title')} unit={t('govb2.control.unit')}>
                {statement.line === null ? (
                  <p className="muted" data-testid="no-line">
                    {t('govb2.control.line.none')}
                  </p>
                ) : (
                  <dl className="gov4-facts" data-testid="line">
                    <dt>{t('govb2.control.line.allocated')}</dt>
                    <dd>{money(statement.line.allocatedVnd)}</dd>
                    <dt>{t('govb2.control.line.committed')}</dt>
                    <dd>{money(statement.line.committedVnd)}</dd>
                    <dt>{t('govb2.control.line.contract')}</dt>
                    <dd>
                      {money(statement.line.contractCommittedVnd)}{' '}
                      <StatusPill tone={statement.line.contractCommitsWithinLine ? 'success' : 'danger'}>{statement.line.contractCommitsWithinLine ? t('govb2.control.within') : t('govb2.control.exceeds')}</StatusPill>
                    </dd>
                    <dt>{t('govb2.control.line.verdict')}</dt>
                    <dd>
                      {statement.line.verdict === null ? (
                        t('govb2.control.line.noPolicy')
                      ) : (
                        <StatusPill tone={verdictTone(statement.line.verdict)}>{t('govb2.control.verdict', { state: statement.line.verdict.state, pct: statement.line.verdict.consumptionPct })}</StatusPill>
                      )}
                    </dd>
                  </dl>
                )}
              </SectionCard>

              <SectionCard title={t('govb2.control.changes.title')} unit={t('govb2.control.unit')}>
                <DataTable
                  caption={t('govb2.control.changes.title')}
                  rows={statement.changeOrders}
                  rowKey={(row) => row.id}
                  state={statement.changeOrders.length === 0 ? 'empty' : 'ready'}
                  columns={[
                    { key: 'code', header: t('govb2.control.changes.code'), render: (row) => row.code ?? row.id.slice(0, 8) },
                    { key: 'status', header: t('govb2.control.changes.status'), render: (row) => <StatusPill tone="neutral">{(row.status === 'APPROVED' ? t('govb2.control.changes.status.approved') : t('govb2.control.changes.status.evaluated'))}</StatusPill> },
                    { key: 'delta', header: t('govb2.control.changes.delta'), align: 'right', render: (row) => money(row.deltaVnd) },
                    {
                      key: 'verdict',
                      header: t('govb2.control.changes.verdict'),
                      render: (row) => (row.verdict === null ? t('govb2.control.changes.noVerdict') : <StatusPill tone={verdictTone(row.verdict)}>{t('govb2.control.verdict', { state: row.verdict.state, pct: row.verdict.consumptionPct })}</StatusPill>),
                    },
                  ]}
                />
              </SectionCard>
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('govb2.control.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
