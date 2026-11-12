import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, KpiStrip, KpiTile, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { PLAN_PATH, linkTo as capLink } from '../../cap/forecast/model';
import { RateText } from '../../dis/enterprise/components';
import { DETAIL_PATH } from '../../dis/enterprise/model';
import { money, moneyOf, percent } from '../../dis/funding/model';
import type { Cell, Rate } from '../../dis/funding/model';
import { billionsText } from '../../home/funding-model';
import { kindLabel, statusTone } from '../../pay/payment/labels';
import { LIST_PATH as PAYMENT_LIST_PATH, paymentLink } from '../../pay/payment/model';
import type { PaymentStatus } from '../../pay/payment/model';
import { QuerySection } from './common';
import type { TabProps } from './common';
import { useProjectFigures, useProjectMonths, useProjectPayments } from './dis-hooks';
import type { MonthRow, ProjectFigures, ProjectPayment } from './dis-hooks';

/** The words of a payment request status in the enterprise register (no treasury wording). */
function paymentStatusText(t: ReturnType<typeof useTranslation>['t'], status: PaymentStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('prj.wsTab.dis.status.draft');
    case 'SUBMITTED':
      return t('prj.wsTab.dis.status.submitted');
    case 'VERIFIED':
      return t('prj.wsTab.dis.status.verified');
    case 'SENT_TREASURY':
      return t('prj.wsTab.dis.status.sent');
    case 'SETTLED':
      return t('prj.wsTab.dis.status.settled');
    case 'RETURNED':
      return t('prj.wsTab.dis.status.returned');
    case 'CANCELLED':
      return t('prj.wsTab.dis.status.cancelled');
    case 'REVERSED':
      return t('prj.wsTab.dis.status.reversed');
  }
}

const HOME_PATH = '/home/home-09';
const RATE_CODE = 'RATE_YEAR_IN_FORCE';
const PAYMENT_ROWS = 12;

interface SourceRow {
  key: string;
  label: string;
  plan: string | null;
  ytd: string | null;
  sinceStart: string | null;
  rate: ReactNode;
}

/** The rate of a source over its plan, from the amounts of the snapshot (the formula of RATE_YEAR_IN_FORCE: cumulative of the year over the plan in force), four decimals half up, exact. */
function sourceRate(ytd: string | null, plan: string | null): Rate | undefined {
  if (ytd === null || plan === null || BigInt(plan) === 0n) return undefined;
  const scaled = (BigInt(ytd) * 2_000_000n + BigInt(plan)) / (BigInt(plan) * 2n);
  return { code: RATE_CODE, class_code: null, numerator_vnd: ytd, denominator_vnd: plan, rate_pct: `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, '0')}`, null_reason: null, basis: 'OFFICIAL', numerator_term: 'CUMULATIVE_YTD', denominator_term: 'PLAN_IN_FORCE', as_of: '', pack_code: '' };
}

function SourcesTable({ figures }: { figures: ProjectFigures }) {
  const { t } = useTranslation();
  const row = figures.detail?.projects.find((one) => one.project_id === figures.headline?.id);
  if (row === undefined) return null;
  const labels = new Map((figures.detail?.pack.classes ?? []).map((one) => [one.code, one.label]));
  const cells = ((row as unknown as { cells?: Cell[] }).cells ?? []).filter((cell) => cell.plan_in_force_vnd !== null || cell.cumulative_ytd_vnd !== null);
  const total: SourceRow = {
    key: 'TOTAL',
    label: t('prj.wsTab.dis.row.total'),
    plan: moneyOf(row.money, 'PLAN_IN_FORCE'),
    ytd: moneyOf(row.money, 'CUMULATIVE_YTD'),
    sinceStart: moneyOf(row.money, 'CUMULATIVE_SINCE_START'),
    rate: <RateText rate={row.rates.find((one) => one.code === RATE_CODE && one.class_code === null)} />,
  };
  const rows: SourceRow[] = [
    total,
    ...cells.map((cell) => ({
      key: cell.class_code,
      label: labels.get(cell.class_code) ?? cell.class_code,
      plan: cell.plan_in_force_vnd,
      ytd: cell.cumulative_ytd_vnd,
      sinceStart: cell.cumulative_since_start_vnd,
      rate: <RateText rate={sourceRate(cell.cumulative_ytd_vnd, cell.plan_in_force_vnd)} />,
    })),
  ];
  const columns: DataTableColumn<SourceRow>[] = [
    { key: 'source', header: t('prj.wsTab.dis.col.source'), pinned: true, render: (one) => one.label },
    { key: 'plan', header: t('ent3a.detail.money.planInForce'), align: 'right', render: (one) => money(one.plan) },
    { key: 'ytd', header: t('ent3a.detail.money.cumulativeYtd'), align: 'right', render: (one) => money(one.ytd) },
    { key: 'since', header: t('ent3a.detail.money.cumulativeSinceStart'), align: 'right', render: (one) => money(one.sinceStart) },
    { key: 'rate', header: t('prj.wsTab.dis.col.rate'), align: 'right', render: (one) => one.rate },
  ];
  return <DataTable caption={t('prj.wsTab.dis.sources.caption')} columns={columns} rows={rows} rowKey={(one) => one.key} />;
}

function FiguresBody({ figures, projectCode }: { figures: ProjectFigures; projectCode: string }) {
  const { t, locale } = useTranslation();
  const head = figures.headline;
  if (head === undefined) {
    return (
      <p className="callout" role="status" data-testid="dis-no-line">
        {t('prj.wsTab.dis.figures.noLine', { project: projectCode, date: figures.asOfDate })}
      </p>
    );
  }
  return (
    <>
      <KpiStrip label={t('prj.wsTab.dis.kpi.label')}>
        <KpiTile label={t('prj.wsTab.dis.kpi.plan')} value={billionsText(head.plan_vnd, locale)} unit={t('prj.wsTab.dis.kpi.unit')} tone="info" />
        <KpiTile label={t('prj.wsTab.dis.kpi.disbursed')} value={head.disbursed_vnd === null || head.disbursed_vnd === undefined ? '–' : billionsText(head.disbursed_vnd, locale)} unit={t('prj.wsTab.dis.kpi.unit')} />
        <KpiTile label={t('prj.wsTab.dis.kpi.rate')} value={percent(head.rate_pct)} />
      </KpiStrip>
      <p data-testid="dis-asof">{t('prj.wsTab.dis.figures.asOf', { date: figures.asOfDate, revision: figures.revision ?? 0 })}</p>
      {figures.detailMissing ? (
        <p className="callout" role="status" data-testid="dis-no-detail">
          {t('prj.wsTab.dis.figures.noDetail')}
        </p>
      ) : (
        <SourcesTable figures={figures} />
      )}
    </>
  );
}

function MonthsTable({ rows }: { rows: MonthRow[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<MonthRow>[] = [
    { key: 'month', header: t('prj.wsTab.dis.col.month'), pinned: true, render: (one) => t('prj.wsTab.dis.month.label', { month: one.month }) },
    { key: 'forecast', header: t('prj.wsTab.dis.col.estimate'), align: 'right', render: (one) => money(one.forecastVnd) },
    { key: 'registered', header: t('prj.wsTab.dis.col.registered'), align: 'right', render: (one) => money(one.registeredVnd) },
  ];
  return <DataTable caption={t('prj.wsTab.dis.months.caption')} columns={columns} rows={rows} rowKey={(one) => String(one.month)} />;
}

function PaymentsTable({ rows }: { rows: ProjectPayment[] }) {
  const { t } = useTranslation();
  const shown = rows.slice(0, PAYMENT_ROWS);
  const columns: DataTableColumn<ProjectPayment>[] = [
    { key: 'request', header: t('prj.wsTab.dis.col.request'), pinned: true, render: (one) => <Link to={paymentLink(one.id)}>{one.requestNo ?? one.id.slice(0, 8)}</Link> },
    { key: 'contract', header: t('prj.wsTab.dis.col.contract'), render: (one) => one.contract.code },
    { key: 'kind', header: t('prj.wsTab.dis.col.kind'), render: (one) => kindLabel(t, one.requestKind) },
    { key: 'status', header: t('prj.wsTab.dis.col.status'), render: (one) => <StatusPill tone={statusTone(one.status)}>{paymentStatusText(t, one.status)}</StatusPill> },
    { key: 'net', header: t('prj.wsTab.dis.col.net'), align: 'right', render: (one) => money(one.netVnd) },
  ];
  return (
    <>
      <DataTable caption={t('prj.wsTab.dis.payments.caption')} columns={columns} rows={shown} rowKey={(one) => one.id} />
      {rows.length > shown.length ? <p>{t('prj.wsTab.dis.payments.more', { shown: shown.length, total: rows.length })}</p> : null}
    </>
  );
}

/** The Giải ngân tab of the project workspace: plan against disbursed (frozen snapshot), the monthly estimates and the payments of the project. */
export default function DisbursementTab({ project }: TabProps) {
  const { t } = useTranslation();
  const figures = useProjectFigures(project.id);
  const year = figures.data?.planYear ?? new Date().getFullYear();
  const months = useProjectMonths(project.id, year);
  const payments = useProjectPayments(project.id);
  const snapshotId = figures.data?.snapshotId;
  return (
    <div data-testid="tab-disbursement">
      <QuerySection
        testId="dis-figures"
        title={t('prj.wsTab.dis.figures.title')}
        query={figures}
        isEmpty={(data) => data === null}
        emptyText={t('prj.wsTab.dis.figures.empty')}
        linkTo={snapshotId === undefined ? HOME_PATH : `${DETAIL_PATH}?snapshot=${snapshotId}`}
        linkLabel={t(snapshotId === undefined ? 'prj.wsTab.dis.link.home' : 'prj.wsTab.dis.link.snapshot')}
      >
        {(data) => (data === null ? null : <FiguresBody figures={data} projectCode={project.code} />)}
      </QuerySection>
      <QuerySection
        testId="dis-months"
        title={t('prj.wsTab.dis.months.title', { year })}
        query={months}
        isEmpty={(rows) => rows.length === 0}
        emptyText={t('prj.wsTab.dis.months.empty')}
        linkTo={capLink(PLAN_PATH, project.id, String(year))}
        linkLabel={t('prj.wsTab.dis.link.months')}
      >
        {(rows) => <MonthsTable rows={rows} />}
      </QuerySection>
      <QuerySection
        testId="dis-payments"
        title={t('prj.wsTab.dis.payments.title')}
        query={payments}
        isEmpty={(rows) => rows.length === 0}
        emptyText={t('prj.wsTab.dis.payments.empty')}
        linkTo={PAYMENT_LIST_PATH}
        linkLabel={t('prj.wsTab.dis.link.payments')}
      >
        {(rows) => <PaymentsTable rows={rows} />}
      </QuerySection>
    </div>
  );
}
