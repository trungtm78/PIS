import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, KpiTile, PeriodProgress, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { BOARD_PATH, defaultPeriod } from '../board/model';
import { useBoard } from '../board/hooks';
import { Field } from '../components';
import { useNow, usePeriods } from '../hooks';
import { periodsOf, yearsOf } from '../model';
import '../dis.css';
import { useDeletedDrafts, usePlanOptions, useProjectOptions, useReportPage, PAGE_SIZE } from './hooks';
import { reportStatusLabel } from './labels';
import { DETAIL_PATH } from './decision-model';
import { IMPORT_PATH, canImport } from './import-model';
import { REMOVAL_PATH, canDelete } from './lifecycle-model';
import { CREATE_PATH, EDIT_PATH, NO_FILTER, canCreate, isFiltered } from './model';
import type { FilterState, Kpi, ReportLine } from './model';
import { formatVnd } from './money';
import { QUICK_FILTERS, billionsOf, csvOf, deadlineOf, dueMoment, periodProgressOf, ratioOf, statusTone, totalsOfLines } from './weekly-model';
import { dueText } from './weekly-text';

const NEVER_EMPTY = (): boolean => false;
const CTMTQG_SHARE_DASH = '—';

/**
 * DIS-01: the weekly reports the caller can see, newest first. The page opens on what is due (the progress of the period, its deadline and how many projects have not handed in), then the shortcuts
 * "not sent" and "sent back", the figures, the filters of the source (year, week, annual plan, project) and the table. A filtered table and the whole scope are two totals, and each says what it is the
 * total of, so one is never taken for the other (SRC-01/02). The total row adds up the rows that are shown and says so. The cumulative of a report is a snapshot of its period: the figures of the
 * table add up the reports in it and not the periods in between (ST-DIS-003, DIS 3 F1).
 */
export default function ReportListScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters and the page belong to one tenant: a switch starts the screen over.
  return <ReportListContent key={tenantId ?? 'none'} route={route} />;
}

function ReportListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const now = useNow();
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [size, setSize] = useState(PAGE_SIZE);
  const cursor = cursors[cursors.length - 1];
  const page = useReportPage(filter, cursor, size);
  const periods = usePeriods();
  const projects = useProjectOptions();
  const plans = usePlanOptions();
  const state = useScreenState({ isLoading: page.isLoading, error: page.error, data: page.data, isEmpty: NEVER_EMPTY });
  const allPeriods = periods.data ?? [];
  const years = yearsOf(allPeriods, new Date(now).getFullYear());
  const weeks = periodsOf(allPeriods, filter.year === '' ? 0 : Number(filter.year), '');
  // The period the page is about: the one chosen in the filter, else the latest week that has started.
  const chosen = allPeriods.find((period) => period.id === filter.periodId) ?? defaultPeriod(allPeriods.filter((period) => period.periodType === 'WEEK'), new Date(now).toISOString().slice(0, 10));
  const board = useBoard(chosen?.id);
  const change = (next: Partial<FilterState>): void => {
    setFilter({ ...filter, ...next });
    setCursors([undefined]);
  };
  const data = page.data;
  const allowedToCreate = canCreate(permissions, mode);
  const applied = [filter.year, filter.periodId, filter.planId, filter.projectId, filter.status].filter((value) => value !== '').length;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.reports.page.title')}</h1>
          <p>{t('dis.reports.page.subtitle')}</p>
        </div>
        {canImport(permissions, mode) ? (
          <div className="actions">
            <Link className="ui-button ui-button--outline" to={IMPORT_PATH}>
              {t('dis.reports.import.action')}
            </Link>
          </div>
        ) : null}
      </div>
      <ContextBar
        items={[
          { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
          { label: t('dis.wr.ctx.period'), value: chosen?.code ?? t('dis.wr.ctx.period.none') },
          { label: t('dis.wr.ctx.deadline'), value: chosen === undefined ? t('dis.wr.ctx.period.none') : dueMoment(chosen.deadlineAt) },
        ]}
        unit={t('dis.wr.unit')}
        {...(page.dataUpdatedAt > 0 ? { asOf: dueMoment(new Date(page.dataUpdatedAt).toISOString()) } : {})}
      />
      <div className="dis-wr-top">
        {chosen === undefined || board.data === undefined ? null : <PeriodCard period={chosen} counts={board.data.total} now={now} />}
        <div className="dis-wr-quick" role="group" aria-label={t('dis.wr.quick.label')}>
          <QuickButton active={filter.status === ''} onClick={() => change({ status: '' })}>
            {t('dis.wr.quick.all')}
          </QuickButton>
          {QUICK_FILTERS.map((quick) => (
            <QuickButton key={quick.key} active={filter.status === quick.status} onClick={() => change({ status: filter.status === quick.status ? '' : quick.status })}>
              {quick.key === 'DRAFT' ? t('dis.wr.quick.draft') : t('dis.wr.quick.returned')}
            </QuickButton>
          ))}
        </div>
      </div>
      {data?.summary === undefined ? null : (
        <div data-testid="kpis">
          <Tiles kpi={data.summary.filtered} scope={data.summary.isFiltered ? t('dis.reports.kpi.filtered.title') : t('dis.wr.kpi.scope.all')} />
          {data.summary.isFiltered ? <ScopeLine kpi={data.summary.scope} /> : null}
          <p className="muted" data-testid="kpi-note">
            {t('dis.reports.kpi.note')}
          </p>
        </div>
      )}
      <FilterPanel
        unitLabel={t('dis.wr.unit')}
        applied={applied}
        {...(page.dataUpdatedAt > 0 ? { updatedAt: dueMoment(new Date(page.dataUpdatedAt).toISOString()) } : {})}
        actions={
          <>
            <button type="button" className="ui-button ui-button--outline" onClick={() => exportCsv(t, data?.items ?? [])} disabled={(data?.items.length ?? 0) === 0}>
              {t('dis.wr.export.action')}
            </button>
            {allowedToCreate ? (
              <Link className="ui-button ui-button--primary" to={CREATE_PATH}>
                {t('dis.wr.create.action')}
              </Link>
            ) : null}
          </>
        }
      >
        <div className="dis-filters" role="group" aria-label={t('dis.reports.filter.title')}>
          <Field id="report-year" label={t('dis.reports.filter.year.label')} error={undefined}>
            <select id="report-year" value={filter.year} onChange={(event) => change({ year: event.target.value, periodId: '' })}>
              <option value="">{t('dis.reports.filter.all.option')}</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </Field>
          <Field id="report-period" label={t('dis.reports.filter.period.label')} error={undefined}>
            <select id="report-period" value={filter.periodId} disabled={filter.year === ''} onChange={(event) => change({ periodId: event.target.value })}>
              <option value="">{t('dis.reports.filter.all.option')}</option>
              {weeks.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.code}
                </option>
              ))}
            </select>
          </Field>
          {(plans.data ?? []).length === 0 ? null : (
            <Field id="report-plan" label={t('dis.reports.filter.plan.label')} error={undefined}>
              <select id="report-plan" value={filter.planId} onChange={(event) => change({ planId: event.target.value })}>
                <option value="">{t('dis.reports.filter.all.option')}</option>
                {(plans.data ?? []).map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.code}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field id="report-project" label={t('dis.reports.filter.project.label')} error={undefined}>
            <select id="report-project" value={filter.projectId} onChange={(event) => change({ projectId: event.target.value })}>
              <option value="">{t('dis.reports.filter.all.option')}</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {`${project.code} · ${project.name}`}
                </option>
              ))}
            </select>
          </Field>
          {isFiltered(filter) ? (
            <button type="button" className="ui-button ui-button--outline" onClick={() => change(NO_FILTER)}>
              {t('dis.reports.filter.clear.action')}
            </button>
          ) : null}
        </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void page.refetch()}>
        {data === undefined ? null : (
          <Table
            lines={data.items}
            total={data.summary?.filtered.reports ?? data.items.length}
            filtered={isFiltered(filter)}
            index={cursors.length - 1}
            size={size}
            onPage={(index) => {
              if (index < cursors.length - 1) setCursors(cursors.slice(0, index + 1));
              else if (index === cursors.length && data.nextCursor !== null) setCursors([...cursors, data.nextCursor]);
            }}
            onSize={(next) => {
              setSize(next);
              setCursors([undefined]);
            }}
            onClear={() => change(NO_FILTER)}
          />
        )}
      </StateBoundary>
      <DeletedDrafts allowed={canDelete(permissions, mode, { status: 'DRAFT', deleted: false })} />
      <p className="prototype-note">{t('dis.reports.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function QuickButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`dis-wr-chip${active ? ' dis-wr-chip--on' : ''}`} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

/** The first card of the page: how many of the projects that must report have handed in, the deadline, and how many are still missing. */
function PeriodCard({ period, counts, now }: { period: { id: string; code: string; deadlineAt: string }; counts: { mustReport: number; submitted: number }; now: number }) {
  const { t } = useTranslation();
  const progress = periodProgressOf(counts);
  const view = deadlineOf(period.deadlineAt, now);
  return (
    <div className="dis-wr-period" data-testid="period-progress">
      <PeriodProgress title={t('dis.wr.progress.title', { period: period.code })} percent={progress.percent} sent={progress.sent} total={progress.total} dueLabel={dueText(t, period.deadlineAt, view)} tone={progress.missing === 0 ? 'success' : view?.tone ?? 'default'} />
      <p className="dis-wr-missing" data-testid="period-missing">
        {progress.missing === 0 ? t('dis.wr.missing.none') : t('dis.wr.missing.count', { count: progress.missing })}{' '}
        <Link to={`${BOARD_PATH}?period=${period.id}`}>{t('dis.wr.missing.board')}</Link>
      </p>
    </div>
  );
}

/** The four figures of the table: the reports and the projects they are of, the cumulative and the CTMTQG inside it, each with the scope it counts and the exact amount next to the short form. */
function Tiles({ kpi, scope }: { kpi: Kpi; scope: string }) {
  const { t } = useTranslation();
  const share = ratioOf(kpi.ctmtqgVnd, kpi.cumulativeVnd);
  return (
    <KpiStrip label={t('dis.wr.kpi.label')}>
      <KpiTile label={t('dis.wr.kpi.reports')} value={String(kpi.reports)} sub={scope} />
      <KpiTile label={t('dis.wr.kpi.projects')} value={String(kpi.projects)} sub={scope} />
      <KpiTile label={t('dis.wr.kpi.cumulative')} value={billionsOf(kpi.cumulativeVnd)} unit={t('dis.wr.kpi.unit')} sub={`${t('dis.wr.kpi.exact', { amount: formatVnd(kpi.cumulativeVnd) })} · ${scope}`} tone="info" />
      <KpiTile
        label={t('dis.wr.kpi.ctmtqg')}
        value={billionsOf(kpi.ctmtqgVnd)}
        unit={t('dis.wr.kpi.unit')}
        sub={`${t('dis.wr.kpi.exact', { amount: formatVnd(kpi.ctmtqgVnd) })} · ${share === null ? CTMTQG_SHARE_DASH : t('dis.wr.kpi.share', { percent: share })}`}
        tone="success"
      />
    </KpiStrip>
  );
}

/** The figures of everything the caller can see, apart from the filtered ones, in the words of what they are the total of. */
function ScopeLine({ kpi }: { kpi: Kpi }) {
  const { t } = useTranslation();
  return (
    <div className="dis-wr-scope" data-testid="kpi-scope">
      <strong>{t('dis.reports.kpi.scope.title')}</strong>
      <span data-testid="kpi-scope-counts">{t('dis.reports.kpi.counts', { reports: kpi.reports, projects: kpi.projects })}</span>
      <span data-testid="kpi-scope-money">{t('dis.reports.kpi.money', { amount: formatVnd(kpi.cumulativeVnd), ctmtqg: formatVnd(kpi.ctmtqgVnd) })}</span>
    </div>
  );
}

interface TableProps {
  lines: ReportLine[];
  total: number;
  filtered: boolean;
  index: number;
  size: number;
  onPage: (index: number) => void;
  onSize: (size: number) => void;
  onClear: () => void;
}

function Table({ lines, total, filtered, index, size, onPage, onSize, onClear }: TableProps) {
  const { t } = useTranslation();
  const columns: DataTableColumn<ReportLine>[] = [
    {
      key: 'project',
      header: t('dis.reports.col.project'),
      pinned: true,
      render: (report) => (
        <>
          <strong>{report.project.code}</strong>
          <span className="dis-code">{report.project.name}</span>
          <span className="dis-wr-chips">
            <StatusPill tone={statusTone(report.status)}>{reportStatusLabel(t, report.status)}</StatusPill>
            {report.isLate ? <StatusPill tone="warning">{t('dis.reports.late.text')}</StatusPill> : null}
          </span>
        </>
      ),
    },
    {
      key: 'period',
      header: t('dis.reports.col.period'),
      render: (report) => (
        <>
          {report.period.code}
          <span className="dis-code">{t('dis.reports.revision.text', { revision: report.revision })}</span>
        </>
      ),
    },
    { key: 'cumulative', header: t('dis.wr.col.total'), group: t('dis.reports.col.cumulative'), align: 'right', render: (report) => formatVnd(report.cumulativeVnd) },
    {
      key: 'ctmtqg',
      header: t('dis.reports.col.ctmtqg'),
      group: t('dis.reports.col.cumulative'),
      align: 'right',
      render: (report) => {
        const share = ratioOf(report.ctmtqgVnd, report.cumulativeVnd);
        return (
          <>
            {formatVnd(report.ctmtqgVnd)}
            {share === null ? null : <small className="dis-wr-share">{t('dis.wr.row.share', { percent: share })}</small>}
          </>
        );
      },
    },
    {
      key: 'updated',
      header: t('dis.reports.col.updated'),
      render: (report) => <time dateTime={report.updatedAt}>{report.updatedAt.slice(0, 10)}</time>,
    },
    {
      key: 'actions',
      header: t('dis.reports.col.actions'),
      render: (report) => <Link to={`${report.status === 'DRAFT' ? EDIT_PATH : DETAIL_PATH}?report=${report.id}`}>{t('dis.reports.open.action', { code: report.project.code })}</Link>,
    },
  ];
  const sums = totalsOfLines(lines);
  const from = lines.length === 0 ? 0 : index * size + 1;
  return (
    <DataTable
      caption={t('dis.reports.table.aria')}
      columns={columns}
      rows={lines}
      rowKey={(report) => report.id}
      totalsLabel={t('dis.wr.totals.label')}
      totals={{ cumulative: formatVnd(sums.cumulativeVnd), ctmtqg: formatVnd(sums.ctmtqgVnd) }}
      emptyKind={filtered ? 'filtered' : 'none'}
      onClearFilters={onClear}
      page={{ from, to: from + lines.length - (lines.length === 0 ? 0 : 1), total, size, index, onPage, onSize }}
    />
  );
}

/** The rows that are shown as a file a spreadsheet opens (comma separated, with the byte order mark so the letters are right). */
function exportCsv(t: ReturnType<typeof useTranslation>['t'], lines: readonly ReportLine[]): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const header = [t('dis.reports.col.project'), t('dis.wr.csv.name'), t('dis.reports.col.period'), t('dis.reports.col.status'), t('dis.wr.col.total'), t('dis.reports.col.ctmtqg'), t('dis.reports.col.updated')];
  const rows = lines.map((report) => [report.project.code, report.project.name, report.period.code, reportStatusLabel(t, report.status), report.cumulativeVnd, report.ctmtqgVnd, report.updatedAt.slice(0, 10)]);
  const url = URL.createObjectURL(new Blob([csvOf(header, rows)], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = t('dis.wr.csv.file');
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The drafts that were deleted and can still be restored (30 days), apart from the reports that stand: each leads to DIS-09, which names it before it is restored. */
function DeletedDrafts({ allowed }: { allowed: boolean }) {
  const { t } = useTranslation();
  const deleted = useDeletedDrafts(allowed);
  const lines = deleted.data ?? [];
  if (!allowed || lines.length === 0) return null;
  return (
    <section className="card" aria-labelledby="deleted-title" data-testid="deleted-drafts">
      <h2 id="deleted-title">{t('dis.reports.deleted.title')}</h2>
      <p className="sub">{t('dis.reports.deleted.help')}</p>
      <ul>
        {lines.map((line) => (
          <li key={line.id}>
            {t('dis.reports.deleted.item.text', { project: line.project.code, period: line.period.code, revision: line.revision })}{' '}
            <Link to={`${REMOVAL_PATH}?report=${line.id}`}>{t('dis.reports.deleted.open.action')}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
