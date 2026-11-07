import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import { useAdvancePolicy, useAdvanceRecoveryTable, useContractAdvancePosition } from './hooks';
import { asOfText, idFrom, vnd } from './model';
import type { AdvancePosition } from './model';
import './gov4.css';

/**
 * PAY-18: the recovery of an advance, planned against actual, and the advance of a contract against what is left to pay (governance deepening G1-11, PAY-07, PAY-11, PAY-12). For an advance: a row for each
 * payment request that recovered (what the formula says should have been recovered at the gross it reached, what was recovered, what is behind) and the milestones of the threshold that the payments have not
 * reached yet. For a contract: the advance owed against the value left to pay (above it, no payment can take the advance back) and whether the final payment waits for the recovery. The policy of the cap is
 * shown as data with the days it is in force and the confirmation it still waits for: a configuration with a flagged default, never a rule of the system.
 */
export default function RecoveryTableScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <RecoveryTableContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PositionCard({ position, money }: { position: AdvancePosition; money: (value: string) => string }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('govb2.recovery.position.title', { code: position.contractCode })} unit={t('govb2.control.unit')} status={<StatusPill tone={position.exceedsRemaining ? 'danger' : 'success'}>{position.exceedsRemaining ? t('govb2.recovery.position.exceeds') : t('govb2.recovery.position.ok')}</StatusPill>}>
      <KpiStrip label={t('govb2.recovery.position.title', { code: position.contractCode })}>
        <KpiTile label={t('govb2.recovery.position.outstanding')} value={money(position.outstandingVnd)} tone={position.exceedsRemaining ? 'danger' : 'default'} />
        <KpiTile label={t('govb2.recovery.position.remaining')} value={money(position.remainingPayableVnd)} sub={t('govb2.recovery.position.remaining.sub')} />
        {position.exceedsRemaining ? <KpiTile label={t('govb2.recovery.position.unrecoverable')} value={money(position.unrecoverableVnd)} tone="danger" /> : null}
      </KpiStrip>
      <p className="muted" data-testid="final-rule">
        {position.finalPaymentRequiresFullRecovery ? t('govb2.recovery.final.requires', { source: position.policy.source === 'DEFAULT' ? t('govb2.policy.default') : t('govb2.policy.rule', { version: position.policy.version ?? 0 }) }) : t('govb2.recovery.final.free')}
      </p>
    </SectionCard>
  );
}

function RecoveryTableContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const [params] = useSearchParams();
  const advanceId = idFrom(params.get('advance'));
  const contractId = idFrom(params.get('contract'));
  const table = useAdvanceRecoveryTable(advanceId);
  const position = useContractAdvancePosition(advanceId === undefined ? contractId : undefined);
  const policy = useAdvancePolicy();
  const state = useScreenState({ isLoading: table.isLoading || position.isLoading, error: table.error ?? position.error, data: advanceId === undefined ? position.data : table.data, isEmpty: () => false });
  const policyState = useScreenState({ isLoading: policy.isLoading, error: policy.error, data: policy.data, isEmpty: (data) => Array.isArray(data) && data.length === 0 });
  const money = (value: string | null | undefined): string => vnd(value, locale);
  const view = table.data ?? undefined;
  const contractPosition = view?.position ?? position.data ?? undefined;
  const asOf = view?.asOf;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govb2.recovery.title')}</h1>
          <p>{t('govb2.recovery.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('govb2.ctx.scope'), value: tenant?.name ?? t('govb2.ctx.scope.all') }]} unit={t('govb2.control.unit')} {...(asOf === undefined ? {} : { asOf: asOfText(asOf) })} />
      {advanceId === undefined && contractId === undefined ? (
        <p className="callout" data-testid="no-target">
          {t('govb2.recovery.noTarget')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void (advanceId === undefined ? position.refetch() : table.refetch())}>
          {contractPosition === undefined ? (
            <p className="callout" data-testid="missing">
              {t('govb2.recovery.missing')}
            </p>
          ) : (
            <>
              <PositionCard position={contractPosition} money={money} />
              {view === undefined ? null : (
                <SectionCard title={t('govb2.recovery.table.title', { contract: view.advance.contractCode, tranche: view.advance.trancheNo })} unit={t('govb2.control.unit')}>
                  {view.advance.awaitingConfirmation ? (
                    <p className="callout" role="status" data-testid="awaiting">
                      {t('govb2.recovery.awaiting', { cxn: view.advance.cxn ?? '' })}
                    </p>
                  ) : null}
                  <DataTable
                    caption={t('govb2.recovery.table.title', { contract: view.advance.contractCode, tranche: view.advance.trancheNo })}
                    rows={view.rows}
                    rowKey={(row) => `${row.kind}:${row.requestNo ?? row.atPct ?? row.grossCumVnd}`}
                    state={view.rows.length === 0 ? 'empty' : 'ready'}
                    columns={[
                      { key: 'row', header: t('govb2.recovery.table.row'), render: (row) => (row.kind === 'ACTUAL' ? (row.requestNo ?? t('govb2.recovery.table.manual')) : t('govb2.recovery.table.milestone', { pct: row.atPct ?? 0 })) },
                      { key: 'on', header: t('govb2.recovery.table.on'), render: (row) => row.on ?? '' },
                      { key: 'gross', header: t('govb2.recovery.table.gross'), align: 'right', render: (row) => money(row.grossCumVnd) },
                      { key: 'planned', header: t('govb2.recovery.table.planned'), align: 'right', render: (row) => money(row.plannedRecoveredVnd) },
                      { key: 'actual', header: t('govb2.recovery.table.actual'), align: 'right', render: (row) => (row.actualRecoveredVnd === null ? <StatusPill tone="neutral">{t('govb2.recovery.table.notYet')}</StatusPill> : money(row.actualRecoveredVnd)) },
                      { key: 'behind', header: t('govb2.recovery.table.behind'), align: 'right', render: (row) => (row.behindVnd === null ? '' : BigInt(row.behindVnd) > 0n ? <StatusPill tone="warning">{money(row.behindVnd)}</StatusPill> : money(row.behindVnd)) },
                    ]}
                  />
                  <p className="muted" data-testid="formula">
                    {t('govb2.recovery.formula', { pct: view.advance.thresholdPct })}
                  </p>
                </SectionCard>
              )}
            </>
          )}
        </StateBoundary>
      )}

      <SectionCard title={t('govb2.recovery.policy.title')} unit={t('govb2.control.unit')}>
        <StateBoundary state={policyState} onRetry={() => void policy.refetch()}>
          <DataTable
            caption={t('govb2.recovery.policy.title')}
            rows={policy.data ?? []}
            rowKey={(row) => row.versionId}
            columns={[
              { key: 'category', header: t('govb2.recovery.policy.category'), render: (row) => row.advanceCategory },
              { key: 'period', header: t('govb2.recovery.policy.period'), render: (row) => `${row.validFrom} → ${row.validUntil ?? t('govb2.recovery.policy.open')}` },
              { key: 'tiers', header: t('govb2.recovery.policy.tiers'), render: (row) => row.tiers.map((tier) => `${money(tier.minValueVnd)}: ${tier.capPct}%`).join('; ') },
              { key: 'threshold', header: t('govb2.recovery.policy.threshold'), align: 'right', render: (row) => (row.recoveryThresholdPct === null ? '' : `${row.recoveryThresholdPct}%`) },
              { key: 'basis', header: t('govb2.recovery.policy.basis'), render: (row) => row.legalBasis },
              {
                key: 'status',
                header: t('govb2.recovery.policy.status'),
                render: (row) => (
                  <>
                    <StatusPill tone={row.inForce ? 'success' : 'neutral'}>{row.inForce ? t('govb2.recovery.policy.inForce') : t('govb2.recovery.policy.notInForce')}</StatusPill>{' '}
                    {row.awaitingConfirmation ? <StatusPill tone="warning">{t('govb2.recovery.policy.awaiting', { cxn: row.cxn ?? '' })}</StatusPill> : null}
                  </>
                ),
              },
            ]}
          />
        </StateBoundary>
      </SectionCard>
      <p className="prototype-note">{t('govb2.recovery.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
