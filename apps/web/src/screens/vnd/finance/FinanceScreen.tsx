import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { failureStatus, isUuid, vietnamStamp } from '../shared/vnd-model';
import { CountInfo, Empty, PartialNotice, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, WithInfo, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { CONTROLS_PATHS, PERMISSION_A, capacitySignalLabel, capacityStatusLabel, financeStatusLabel, financeTestLabel, moneyText, overallLabel, ratioText } from '../controls/controls-model';
import type { CapacityView, FinanceResult, FinanceView, FinancialPeriod } from '../controls/controls-model';
import { useCapacity, useFinance } from '../controls/controls-hooks';
import { RecordPeriodDialog, VerifyPeriodDialog } from './finance-dialogs';

const NONE = '–';

type Dialog = { kind: 'record' } | { kind: 'verify'; period: FinancialPeriod };

/**
 * VND-08, the finance and the load of a contractor. The statements of each year are entered from the audited report and checked against the paper by another person; only checked years count. From them the page shows
 * the current ratio, debt to assets, interest cover and the average revenue, each against the line of the rule (and, when a package is named, against what the package asks), and the load the contractor already carries
 * against its revenue. A figure that cannot be judged says so; too little data is never a pass; and none of it rejects a bid by itself: it is a signal for the panel.
 */
export default function FinanceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const contractor = useIdParam('contractor', 'id');
  const packageId = useIdParam('package');
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  if (contractor === undefined || !isUuid(contractor)) return <ContractorPicker key={scope} route={route} />;
  return <ContractorFinance key={`${scope}:${contractor}:${packageId ?? ''}`} route={route} contractor={contractor} packageId={packageId !== undefined && isUuid(packageId) ? packageId : undefined} />;
}

function ContractorPicker({ route }: ScreenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const valid = isUuid(value);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (valid) navigate(CONTROLS_PATHS.finance(value.trim()));
  };
  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd.finance.page.title')} subtitle={t('vnd.finance.page.subtitle')} />
      <SectionCard title={t('vnd.finance.pick.title')}>
        <form onSubmit={submit} className="vnd-row" data-testid="contractor-picker">
          <label className="vnd-field">
            <span>{t('vnd.finance.pick.label')}</span>
            <input type="text" value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={value !== '' && !valid} />
          </label>
          <button type="submit" className="ui-button ui-button--primary" disabled={!valid}>
            {t('vnd.finance.pick.action')}
          </button>
        </form>
        <Empty text={t('vnd.finance.pick.empty.text')} testId="pick-empty" />
      </SectionCard>
      <ScreenFooter route={route} />
    </Screen>
  );
}

function ContractorFinance({ route, contractor, packageId }: ScreenProps & { contractor: string; packageId: string | undefined }) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const writer = useWriter();
  const query = useFinance(contractor, packageId);
  const capacity = useCapacity(contractor);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const view = query.data;
  const base = useScreenState({ isLoading: query.isLoading, error: view === undefined ? query.error : undefined, data: view, isEmpty: () => false });
  const state: ScreenState = view === undefined && failureStatus(query.error) === 404 ? 'empty' : base;
  const refreshFailed = query.isError && view !== undefined;
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  const name = contractor.slice(0, 8);
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.finance.page.title')}
        subtitle={t('vnd.finance.page.contractor.text', { name })}
        asOf={view?.as_of}
        stale={refreshFailed}
        actions={
          <>
            <Link className="ui-button ui-button--outline" to={CONTROLS_PATHS.finance()}>
              {t('vnd.finance.pick.another')}
            </Link>
            {packageId !== undefined && (
              <Link className="ui-button ui-button--outline" to={CONTROLS_PATHS.package(packageId)}>
                {t('vnd.finance.package.link')}
              </Link>
            )}
            {writer.can(PERMISSION_A.financeWrite) && (
              <button type="button" className="ui-button ui-button--primary" data-testid="record-period" onClick={() => setDialog({ kind: 'record' })}>
                {t('vnd.finance.record.action')}
              </button>
            )}
          </>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {view !== undefined && (
          <div className="vnd-page">
            <JudgmentCard view={view} locale={locale} />
            <PeriodsCard view={view} locale={locale} me={tenant?.membershipId} canVerify={writer.can(PERMISSION_A.financeVerify)} onVerify={(period) => setDialog({ kind: 'verify', period })} />
            <CapacityCard query={capacity} locale={locale} />
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'record' && <RecordPeriodDialog contractorId={contractor} contractorName={name} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.finance.record.title'))} />}
      {dialog?.kind === 'verify' && <VerifyPeriodDialog period={dialog.period} contractorName={name} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.finance.verify.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

const resultTone = (status: FinanceResult['status']): 'success' | 'danger' | 'neutral' => (status === 'PASS' ? 'success' : status === 'FAIL' ? 'danger' : 'neutral');

/** The ratios of the latest checked year and the average revenue against the rule and the package, one line each with the "i" of its rule. */
function JudgmentCard({ view, locale }: { view: FinanceView; locale: string }) {
  const { t } = useTranslation();
  const money = (test: FinanceResult['test'], value: number | null): string => (test === 'AVERAGE_REVENUE' ? moneyText(value, locale) : ratioText(value, locale));
  return (
    <SectionCard title={t('vnd.finance.judgment.title')} status={view.policy.unverified ? <UnverifiedPill /> : undefined}>
      <p className="vnd-note vnd-row" data-testid="finance-overall">
        <StatusPill tone={view.overall === 'MEETS' ? 'success' : view.overall === 'BELOW' ? 'danger' : 'neutral'} icon={view.overall === 'MEETS' ? '✓' : view.overall === 'BELOW' ? '✕' : '○'}>
          {overallLabel(t, view.overall)}
        </StatusPill>
        <span>{t('vnd.finance.judgment.years.text', { years: view.verified_years })}</span>
        <PolicyInfo name={t('vnd.finance.figure.overall.name')} policy={view.policy} />
      </p>
      {view.requirement !== null && <p className="vnd-note">{t('vnd.finance.judgment.requirement.text', { value: moneyText((view.requirement as { package_value: number }).package_value, locale), months: (view.requirement as { duration_months: number }).duration_months })}</p>}
      <DataTable<FinanceResult>
        caption={t('vnd.finance.judgment.caption')}
        rows={view.results}
        rowKey={(row) => row.test}
        rowAttrs={(row) => ({ 'data-test': row.test })}
        columns={[
          { key: 'test', header: t('vnd.finance.column.test'), pinned: true, render: (row) => <WithInfo info={<PolicyInfo name={financeTestLabel(t, row.test)} policy={view.policy} />}>{financeTestLabel(t, row.test)}</WithInfo> },
          { key: 'value', header: t('vnd.finance.column.value'), render: (row) => money(row.test, row.value) },
          { key: 'threshold', header: t('vnd.finance.column.threshold'), render: (row) => money(row.test, row.threshold) },
          { key: 'year', header: t('vnd.finance.column.year'), render: (row) => (row.year === null ? NONE : String(row.year)) },
          {
            key: 'status',
            header: t('vnd.finance.column.status'),
            render: (row) => (
              <StatusPill tone={resultTone(row.status)} icon={row.status === 'PASS' ? '✓' : row.status === 'FAIL' ? '✕' : '○'}>
                {financeStatusLabel(t, row.status)}
              </StatusPill>
            ),
          },
        ]}
      />
    </SectionCard>
  );
}

function PeriodsCard({ view, locale, me, canVerify, onVerify }: { view: FinanceView; locale: string; me: string | undefined; canVerify: boolean; onVerify: (period: FinancialPeriod) => void }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd.finance.periods.title')}>
      {view.periods.length === 0 ? (
        <Empty text={t('vnd.finance.periods.empty.text')} testId="periods-empty" />
      ) : (
        <DataTable<FinancialPeriod>
          caption={t('vnd.finance.periods.caption')}
          rows={view.periods}
          rowKey={(row) => row.id}
          rowAttrs={(row) => ({ 'data-period-id': row.id })}
          columns={[
            { key: 'year', header: t('vnd.finance.column.year'), pinned: true, render: (row) => String(row.fiscal_year) },
            { key: 'revenue', header: t('vnd.finance.column.revenue'), render: (row) => moneyText(row.revenue, locale) },
            { key: 'current', header: t('vnd.finance.column.currentRatio'), render: (row) => ratioText(row.ratios.current_ratio, locale) },
            { key: 'debt', header: t('vnd.finance.column.debtToAssets'), render: (row) => ratioText(row.ratios.debt_to_assets_pct, locale) },
            { key: 'cover', header: t('vnd.finance.column.interestCover'), render: (row) => ratioText(row.ratios.interest_cover, locale) },
            {
              key: 'verified',
              header: t('vnd.finance.column.verified'),
              render: (row) =>
                row.verified ? (
                  <span className="vnd-stack">
                    <StatusPill tone="success" icon="✓">
                      {t('vnd.finance.verified.yes')}
                    </StatusPill>
                    {row.verified_at !== null && <span className="vnd-days">{vietnamStamp(row.verified_at)}</span>}
                  </span>
                ) : (
                  <StatusPill tone="warning" icon="○">
                    {t('vnd.finance.verified.no')}
                  </StatusPill>
                ),
            },
            {
              key: 'actions',
              header: t('vnd.finance.column.actions'),
              render: (row) =>
                canVerify && !row.verified && row.created_by !== me ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="verify-period" onClick={() => onVerify(row)}>
                    {t('vnd.finance.verify.action')}
                  </button>
                ) : null,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

function CapacityCard({ query, locale }: { query: ReturnType<typeof useCapacity>; locale: string }) {
  const { t } = useTranslation();
  const data: CapacityView | undefined = query.data;
  return (
    <SectionCard title={t('vnd.finance.capacity.title')} status={data?.capacity_policy.unverified === true ? <UnverifiedPill /> : undefined}>
      {query.isError && data === undefined ? (
        <PartialNotice text={t('vnd.finance.capacity.failed.text')} onRetry={() => void query.refetch()} testId="capacity-failed" />
      ) : data === undefined ? (
        <Empty text={t('vnd.finance.capacity.loading.text')} testId="capacity-loading" />
      ) : (
        <>
          <p className="vnd-note vnd-row" data-testid="capacity-status">
            <StatusPill tone={data.status === 'OVER' ? 'danger' : data.status === 'WITHIN' ? 'success' : 'neutral'} icon={data.status === 'OVER' ? '!' : data.status === 'WITHIN' ? '✓' : '○'}>
              {capacityStatusLabel(t, data.status)}
            </StatusPill>
            <span>{t('vnd.finance.capacity.rule.text', { limit: ratioText(data.limit_multiple, locale) })}</span>
            <PolicyInfo name={t('vnd.finance.figure.capacity.name')} policy={data.capacity_policy} />
          </p>
          <dl className="vnd-facts" data-testid="capacity-facts">
            <CapacityFact label={t('vnd.finance.capacity.open')} value={`${moneyText(data.facts.open_contract_value, locale)} (${data.facts.open_contract_count})`} data={data} />
            <CapacityFact label={t('vnd.finance.capacity.late')} value={String(data.facts.late_contract_count)} data={data} />
            <CapacityFact label={t('vnd.finance.capacity.pending')} value={`${moneyText(data.facts.pending_award_value, locale)} (${data.facts.pending_award_count})`} data={data} />
            <CapacityFact label={t('vnd.finance.capacity.revenue')} value={moneyText(data.facts.average_annual_revenue, locale)} data={data} />
            <CapacityFact label={t('vnd.finance.capacity.load')} value={moneyText(data.load, locale)} data={data} />
            <CapacityFact label={t('vnd.finance.capacity.multiple')} value={ratioText(data.load_multiple, locale)} data={data} />
          </dl>
          {data.signals.length > 0 && (
            <ul className="vnd-note" data-testid="capacity-signals">
              {data.signals.map((signal) => (
                <li key={signal}>{capacitySignalLabel(t, signal)}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </SectionCard>
  );
}

function CapacityFact({ label, value, data }: { label: string; value: string; data: CapacityView }) {
  const { t } = useTranslation();
  return (
    <div className="vnd-fact">
      <dt>
        <WithInfo info={<CountInfo name={label} formula={data.capacity_policy.formula} source={t('vnd.finance.capacity.source.text')} asOf={data.as_of} unverified={data.capacity_policy.unverified} />}>{label}</WithInfo>
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
